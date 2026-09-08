/**
 * Stage 0C / C1c — the employment lifecycle.
 *
 *   node --test usecase/employee_lifecycle.test.js
 *
 * The reconciler is tested two ways. `decide()` is a pure function of the
 * master row and the newest period, so every transition is exercised
 * directly. Above that sits a fake repository that enforces the real C1a
 * constraints - one open period per employee, unique (employee_id, period_no),
 * ended_on >= joined_on, an open period has no end - so the orchestration is
 * tested against the same rules the database applies rather than against a
 * mock that agrees with whatever the code does.
 *
 * The headline case is the full cycle:
 *
 *   join -> resign -> rejoin -> resign -> rejoin
 *
 * run with a repeated sync after EVERY state, because the failure this whole
 * design guards against is a nightly sync quietly adding a second period or a
 * second resignation event.
 */
const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const lifecycle = require("./employee_lifecycle");
const { decide, toDateOnly, credibleRejoinDate, EVENT, REASON } = lifecycle;

/* ------------------------------------------------------------- the fake --
 * An in-memory stand-in for employee_employment_period /
 * employee_lifecycle_event that refuses anything the C1a schema would refuse.
 */
class FakeRepo {
  constructor(employee) {
    this.employee = employee;
    this.periods = [];
    this.events = [];
    this.nextPeriodId = 1;
    this.nextEventId = 1;
    this.failNextEvent = false;
    this.locale = "en_US";
    this.txDepth = 0;
  }

  /**
   * A rollback undoes only what THIS transaction wrote - never a concurrent
   * one's work. An undo log rather than a whole-store snapshot, because a
   * snapshot would wipe the winner's insert when the loser rolls back, which
   * is precisely the bug the concurrency test is meant to detect.
   */
  async withTransaction(fn) {
    this.txDepth += 1;
    const undo = [];
    try {
      const out = await fn({ query: async () => [], _undo: undo });
      return out;
    } catch (err) {
      for (const step of undo.reverse()) step();
      throw err;
    } finally {
      this.txDepth -= 1;
    }
  }

  /** Undo steps belong to the transaction that made them, not to the store. */
  _record(tx, undoFn) {
    if (tx && tx._undo) tx._undo.push(undoFn);
  }

  async assertDateLocale() {
    if (this.locale !== "en_US") throw new Error(`lc_time_names is '${this.locale}', not 'en_US'`);
  }

  async lockAndReadEmployee(_tx, employeeId) {
    return Number(this.employee.employee_id) === Number(employeeId) ? { ...this.employee } : null;
  }

  async getLatestPeriod(_tx, employeeId) {
    const mine = this.periods.filter((p) => p.employee_id === employeeId);
    if (mine.length === 0) return null;
    const latest = mine.reduce((a, b) => (b.period_no > a.period_no ? b : a));
    // The real query carries the previous period's end date alongside; the
    // fill rule for period 2+ needs it.
    const prev = mine
      .filter((p) => p.period_no < latest.period_no)
      .sort((a, b) => b.period_no - a.period_no)[0];
    return { ...latest, prev_ended_on: prev ? prev.ended_on : null };
  }

  /** Applies the four C1a constraints. */
  _check(row) {
    if (row.period_state === "open" && row.ended_on !== null) {
      throw new Error("chk_period_open_has_no_end");
    }
    if (row.ended_on !== null && row.joined_on !== null && row.ended_on < row.joined_on) {
      throw new Error("chk_period_dates_ordered");
    }
    const opens = this.periods.filter(
      (p) => p.employee_id === row.employee_id && p.period_state === "open" && p.period_id !== row.period_id
    );
    if (row.period_state === "open" && opens.length > 0) throw new Error("uq_one_open_period");
    const dup = this.periods.find(
      (p) =>
        p.employee_id === row.employee_id &&
        p.period_no === row.period_no &&
        p.period_id !== row.period_id
    );
    if (dup) throw new Error("uq_period_seq");
  }

  async insertPeriod(tx, period) {
    const row = {
      period_id: this.nextPeriodId,
      employee_id: period.employee_id,
      period_no: period.period_no,
      period_state: period.period_state,
      joined_on: period.joined_on === undefined ? null : period.joined_on,
      ended_on: period.ended_on === undefined ? null : period.ended_on,
      end_reason_type: period.end_reason_type === undefined ? null : period.end_reason_type,
      source: "local",
      needs_review: period.needs_review ? 1 : 0,
    };
    this._check(row);
    this.nextPeriodId += 1;
    this.periods.push(row);
    this._record(tx, () => {
      this.periods = this.periods.filter((p) => p.period_id !== row.period_id);
    });
    return row.period_id;
  }

  async closePeriod(tx, periodId, patch) {
    const row = this.periods.find((p) => p.period_id === periodId);
    if (!row || row.period_state !== "open") return 0; // the WHERE ... AND period_state='open'
    const next = {
      ...row,
      period_state: "closed",
      ended_on: patch.ended_on === undefined ? null : patch.ended_on,
      end_reason_type: patch.end_reason_type,
      needs_review: patch.needs_review ? 1 : 0,
    };
    this._check(next);
    const before = { ...row };
    Object.assign(row, next);
    this._record(tx, () => Object.assign(row, before));
    return 1;
  }

  async fillNullDate(tx, periodId, column, value, patch) {
    const row = this.periods.find((p) => p.period_id === periodId);
    if (!row || row[column] !== null) return 0; // the WHERE ... AND col IS NULL
    const next = { ...row, [column]: value, needs_review: patch.needs_review ? 1 : 0 };
    this._check(next);
    const before = { ...row };
    Object.assign(row, next);
    this._record(tx, () => Object.assign(row, before));
    return 1;
  }

  async insertEvent(tx, event) {
    if (this.failNextEvent) {
      this.failNextEvent = false;
      throw new Error("insertEvent failed");
    }
    const row = { event_id: this.nextEventId++, ...event };
    this.events.push(row);
    this._record(tx, () => {
      this.events = this.events.filter((e) => e.event_id !== row.event_id);
    });
    return row.event_id;
  }

  async listEmployeesNeedingReconciliation() {
    return [this.employee.employee_id];
  }
}

class FakeUserRepo {
  constructor() {
    this.bumps = [];
  }
  async bumpTokenValidFromByEmployeeId(employeeId) {
    this.bumps.push(employeeId);
  }
}

const EMPLOYEE_ID = 101;

const master = (over = {}) => ({
  employee_id: EMPLOYEE_ID,
  status: 1,
  resignation_date: null,
  raw_date_of_joining: null,
  parsed_joined_on: null,
  ...over,
});

const build = (employee) => {
  const repo = new FakeRepo(employee);
  const users = new FakeUserRepo();
  return { repo, users, uc: lifecycle(repo, users) };
};

const opened = (events) =>
  events.filter((e) => e.event_type === EVENT.OPENED);
const closed = (events) => events.filter((e) => e.event_type === EVENT.CLOSED);

/* ==================================================================== A/B */
describe("Case A - an employee with no period at all", () => {
  it("1. a new ACTIVE employee gets period 1, open", async () => {
    const { repo, uc } = build(master({ parsed_joined_on: "2025-03-01" }));
    assert.equal((await uc.reconcileEmployee(EMPLOYEE_ID)).action, "open_initial");
    assert.equal(repo.periods.length, 1);
    assert.deepEqual(
      (({ period_no, period_state, joined_on, ended_on, needs_review }) => ({
        period_no, period_state, joined_on, ended_on, needs_review,
      }))(repo.periods[0]),
      { period_no: 1, period_state: "open", joined_on: "2025-03-01", ended_on: null, needs_review: 0 }
    );
  });

  it("2. a new INACTIVE employee gets period 1, closed", async () => {
    const { repo, uc } = build(
      master({ status: 0, parsed_joined_on: "2020-01-01", resignation_date: "2024-06-30" })
    );
    await uc.reconcileEmployee(EMPLOYEE_ID);
    assert.equal(repo.periods[0].period_state, "closed");
    assert.equal(repo.periods[0].ended_on, "2024-06-30");
    assert.equal(repo.periods[0].end_reason_type, "resignation");
    assert.equal(repo.periods[0].needs_review, 0);
  });

  it("19. an employee created after C1b receives period 1, not period 2", async () => {
    const { repo, uc } = build(master({ parsed_joined_on: "2026-01-05" }));
    await uc.reconcileEmployee(EMPLOYEE_ID);
    assert.equal(repo.periods[0].period_no, 1);
  });

  it("18. and exactly one event - no manufactured closure it never witnessed", async () => {
    const { repo, uc } = build(master({ status: 0, resignation_date: "2024-06-30" }));
    await uc.reconcileEmployee(EMPLOYEE_ID);
    assert.equal(repo.events.length, 1);
    assert.equal(repo.events[0].event_type, EVENT.OPENED);
    assert.equal(repo.events[0].detail.reason, REASON.INITIAL_JOIN);
    assert.equal(repo.events[0].detail.opened_state, "closed");
  });
});

describe("Case B - open period, employee still active", () => {
  it("3. a repeated sync changes nothing at all", async () => {
    const { repo, uc } = build(master({ parsed_joined_on: "2025-03-01" }));
    await uc.reconcileEmployee(EMPLOYEE_ID);
    const before = JSON.stringify(repo.periods);
    for (let i = 0; i < 5; i++) {
      assert.equal((await uc.reconcileEmployee(EMPLOYEE_ID)).action, "none");
    }
    assert.equal(JSON.stringify(repo.periods), before);
    assert.equal(repo.events.length, 1);
  });

  it("13/15. a joining date unknown at open time stays NULL, then fills when it is learned", async () => {
    const emp = master();
    const { repo, uc } = build(emp);
    await uc.reconcileEmployee(EMPLOYEE_ID);
    assert.equal(repo.periods[0].joined_on, null);
    assert.equal(repo.periods[0].needs_review, 1, "an unknown joining date is flagged for review");

    emp.parsed_joined_on = "2022-08-15";
    assert.equal((await uc.reconcileEmployee(EMPLOYEE_ID)).action, "fill");
    assert.equal(repo.periods[0].joined_on, "2022-08-15");
    assert.equal(repo.periods[0].needs_review, 0, "review clears once nothing is unknown");
    assert.equal(repo.events.length, 2);
    assert.equal(repo.events[1].event_type, EVENT.CORRECTED);

    assert.equal((await uc.reconcileEmployee(EMPLOYEE_ID)).action, "none", "and only once");
  });

  it("16. a known joining date is never silently replaced", async () => {
    const emp = master({ parsed_joined_on: "2022-08-15" });
    const { repo, uc } = build(emp);
    await uc.reconcileEmployee(EMPLOYEE_ID);
    emp.parsed_joined_on = "2019-01-01"; // Digisme now says something else
    assert.equal((await uc.reconcileEmployee(EMPLOYEE_ID)).action, "none");
    assert.equal(repo.periods[0].joined_on, "2022-08-15");
  });
});

/* ==================================================================== C/D */
describe("Case C - the employee leaves", () => {
  it("4. the SAME period closes; no second period is created", async () => {
    const emp = master({ parsed_joined_on: "2022-01-10" });
    const { repo, uc } = build(emp);
    await uc.reconcileEmployee(EMPLOYEE_ID);
    const periodId = repo.periods[0].period_id;

    emp.status = 0;
    emp.resignation_date = "2024-09-30";
    assert.equal((await uc.reconcileEmployee(EMPLOYEE_ID)).action, "close");

    assert.equal(repo.periods.length, 1, "closing must not add a period");
    assert.equal(repo.periods[0].period_id, periodId);
    assert.equal(repo.periods[0].period_state, "closed");
    assert.equal(repo.periods[0].ended_on, "2024-09-30");
    assert.equal(repo.periods[0].joined_on, "2022-01-10", "joined_on is preserved");
  });

  it("14. a resignation with no date closes with ended_on NULL, flagged", async () => {
    const emp = master({ parsed_joined_on: "2022-01-10" });
    const { repo, uc } = build(emp);
    await uc.reconcileEmployee(EMPLOYEE_ID);
    emp.status = 0;
    await uc.reconcileEmployee(EMPLOYEE_ID);
    assert.equal(repo.periods[0].period_state, "closed");
    assert.equal(repo.periods[0].ended_on, null);
    assert.equal(repo.periods[0].end_reason_type, "unknown");
    assert.equal(repo.periods[0].needs_review, 1);
  });

  it("a resignation date earlier than the joining date is refused, not written", async () => {
    const emp = master({ parsed_joined_on: "2022-01-10" });
    const { repo, uc } = build(emp);
    await uc.reconcileEmployee(EMPLOYEE_ID);
    emp.status = 0;
    emp.resignation_date = "2021-05-05"; // would violate chk_period_dates_ordered
    await uc.reconcileEmployee(EMPLOYEE_ID);
    assert.equal(repo.periods[0].ended_on, null);
    assert.equal(repo.periods[0].needs_review, 1);
    assert.equal(closed(repo.events)[0].detail.rejected_end_date, "2021-05-05");
  });
});

describe("Case D - closed period, employee stays inactive", () => {
  it("5. a repeated sync creates no second resignation event", async () => {
    const emp = master({ parsed_joined_on: "2022-01-10" });
    const { repo, uc } = build(emp);
    await uc.reconcileEmployee(EMPLOYEE_ID);
    emp.status = 0;
    emp.resignation_date = "2024-09-30";
    await uc.reconcileEmployee(EMPLOYEE_ID);
    assert.equal(closed(repo.events).length, 1);

    for (let i = 0; i < 5; i++) {
      assert.equal((await uc.reconcileEmployee(EMPLOYEE_ID)).action, "none");
    }
    assert.equal(closed(repo.events).length, 1, "still exactly one closure event");
    assert.equal(repo.periods.length, 1);
  });

  it("15. an end date learned later fills the NULL, once", async () => {
    const emp = master({ parsed_joined_on: "2022-01-10" });
    const { repo, uc } = build(emp);
    await uc.reconcileEmployee(EMPLOYEE_ID);
    emp.status = 0;
    await uc.reconcileEmployee(EMPLOYEE_ID);
    assert.equal(repo.periods[0].ended_on, null);

    emp.resignation_date = "2024-09-30";
    assert.equal((await uc.reconcileEmployee(EMPLOYEE_ID)).action, "fill");
    assert.equal(repo.periods[0].ended_on, "2024-09-30");
    assert.equal(repo.periods[0].needs_review, 0);
    assert.equal((await uc.reconcileEmployee(EMPLOYEE_ID)).action, "none");
  });

  it("16. a known end date is never silently replaced", async () => {
    const emp = master({ status: 0, parsed_joined_on: "2020-01-01", resignation_date: "2024-06-30" });
    const { repo, uc } = build(emp);
    await uc.reconcileEmployee(EMPLOYEE_ID);
    emp.resignation_date = "2023-01-01";
    assert.equal((await uc.reconcileEmployee(EMPLOYEE_ID)).action, "none");
    assert.equal(repo.periods[0].ended_on, "2024-06-30");
  });
});

/* ====================================================================== E */
describe("Case E - rejoin", () => {
  it("6. inactive -> active creates period 2, leaving period 1 untouched", async () => {
    const emp = master({ parsed_joined_on: "2022-01-10" });
    const { repo, uc } = build(emp);
    await uc.reconcileEmployee(EMPLOYEE_ID);
    emp.status = 0;
    emp.resignation_date = "2024-09-30";
    await uc.reconcileEmployee(EMPLOYEE_ID);
    const period1 = JSON.stringify(repo.periods[0]);

    emp.status = 1;
    emp.parsed_joined_on = "2025-04-01";
    assert.equal((await uc.reconcileEmployee(EMPLOYEE_ID)).action, "open_rejoin");

    assert.equal(repo.periods.length, 2);
    assert.equal(JSON.stringify(repo.periods[0]), period1, "period 1 is byte-identical");
    assert.deepEqual(
      (({ period_no, period_state, joined_on, ended_on }) => ({ period_no, period_state, joined_on, ended_on }))(
        repo.periods[1]
      ),
      { period_no: 2, period_state: "open", joined_on: "2025-04-01", ended_on: null }
    );
    const ev = opened(repo.events).slice(-1)[0];
    assert.equal(ev.detail.reason, REASON.REJOIN);
  });

  it("a stale date_of_joining is NOT used as the rejoin date", async () => {
    // The master still holds the ORIGINAL joining date - Digisme does not
    // update it on rejoin - so period 2 must not claim to start in 2022.
    const emp = master({ parsed_joined_on: "2022-01-10" });
    const { repo, uc } = build(emp);
    await uc.reconcileEmployee(EMPLOYEE_ID);
    emp.status = 0;
    emp.resignation_date = "2024-09-30";
    await uc.reconcileEmployee(EMPLOYEE_ID);
    emp.status = 1; // parsed_joined_on unchanged: still 2022-01-10

    await uc.reconcileEmployee(EMPLOYEE_ID);
    assert.equal(repo.periods[1].joined_on, null, "stale date rejected, not written");
    assert.equal(repo.periods[1].needs_review, 1);
    const ev = opened(repo.events).slice(-1)[0];
    assert.equal(ev.detail.rejoin_date_unknown, true);
  });

  it("never invents a rejoin date from today, created_at or the resignation date", async () => {
    const emp = master({ parsed_joined_on: null });
    const { repo, uc } = build(emp);
    await uc.reconcileEmployee(EMPLOYEE_ID);
    emp.status = 0;
    emp.resignation_date = "2024-09-30";
    await uc.reconcileEmployee(EMPLOYEE_ID);
    emp.status = 1;
    await uc.reconcileEmployee(EMPLOYEE_ID);

    assert.equal(repo.periods[1].joined_on, null);
    const today = toDateOnly(new Date());
    assert.notEqual(repo.periods[1].joined_on, today);
    assert.notEqual(repo.periods[1].joined_on, "2024-09-30");
  });

  it("the next sync does NOT fill the rejected stale date into period 2", async () => {
    // Found by the rehearsal against real MySQL, not by this suite. The
    // rejoin correctly opened with joined_on NULL, and then the fill path -
    // which only asked "is joined_on NULL and does a date parse?" - wrote the
    // stale 2022 date in one reconcile later, defeating the guard by a day.
    const latest = {
      period_id: 2, period_no: 2, period_state: "open",
      joined_on: null, ended_on: null, prev_ended_on: "2024-09-30",
    };
    const emp = master({ parsed_joined_on: "2022-01-10" }); // the ORIGINAL date
    assert.equal(decide(emp, latest).action, "none", "a pre-rejoin date must not be filled in");

    // A date that really does postdate the previous spell is accepted.
    emp.parsed_joined_on = "2025-04-01";
    const plan = decide(emp, latest);
    assert.equal(plan.action, "fill");
    assert.deepEqual(plan.fills, [{ column: "joined_on", value: "2025-04-01" }]);

    // With no previous end date there is nothing to judge against.
    const noPrev = { ...latest, prev_ended_on: null };
    assert.equal(decide(emp, noPrev).action, "none");

    // Period 1 has no earlier spell, so it fills freely.
    assert.equal(
      decide(emp, { ...latest, period_no: 1, prev_ended_on: null }).action,
      "fill"
    );
  });

  it("13. a rejoin with no usable date stays NULL and is flagged", async () => {
    const { repo, uc } = build(master({ status: 0, resignation_date: "2024-01-01" }));
    await uc.reconcileEmployee(EMPLOYEE_ID);
    repo.employee.status = 1;
    await uc.reconcileEmployee(EMPLOYEE_ID);
    assert.equal(repo.periods[1].joined_on, null);
    assert.equal(repo.periods[1].needs_review, 1);
  });
});

/* ============================================== the full cycle, end to end */
describe("join -> resign -> rejoin -> resign -> rejoin, syncing repeatedly at every state", () => {
  it("7/8/9/10/11. periods 1,2,3 under one employee_id, history intact", async () => {
    const emp = master({ parsed_joined_on: "2022-03-01" });
    const { repo, users, uc } = build(emp);
    const resync = async (n = 3) => {
      for (let i = 0; i < n; i++) await uc.reconcileEmployee(EMPLOYEE_ID);
    };

    // --- join
    assert.equal((await uc.reconcileEmployee(EMPLOYEE_ID)).action, "open_initial");
    await resync();
    assert.equal(repo.periods.length, 1);

    // --- resign
    emp.status = 0;
    emp.resignation_date = "2024-05-31";
    assert.equal((await uc.reconcileEmployee(EMPLOYEE_ID)).action, "close");
    await resync();
    const p1 = JSON.stringify(repo.periods[0]);

    // --- rejoin
    emp.status = 1;
    emp.resignation_date = null;
    emp.parsed_joined_on = "2025-02-01";
    assert.equal((await uc.reconcileEmployee(EMPLOYEE_ID)).action, "open_rejoin");
    await resync();
    assert.equal(repo.periods.length, 2);

    // --- resign again (period 2 closes; NO period 3 yet)
    emp.status = 0;
    emp.resignation_date = "2026-01-31";
    assert.equal((await uc.reconcileEmployee(EMPLOYEE_ID)).action, "close");
    await resync();
    assert.equal(repo.periods.length, 2, "period 2 closed, nothing created");
    assert.equal(repo.periods[1].ended_on, "2026-01-31");
    const p2 = JSON.stringify(repo.periods[1]);

    // --- rejoin again
    emp.status = 1;
    emp.resignation_date = null;
    emp.parsed_joined_on = "2026-06-01";
    assert.equal((await uc.reconcileEmployee(EMPLOYEE_ID)).action, "open_rejoin");
    await resync();

    // --- the shape of the whole history
    assert.equal(repo.periods.length, 3);
    assert.deepEqual(repo.periods.map((p) => p.period_no), [1, 2, 3]);
    assert.deepEqual(repo.periods.map((p) => p.period_state), ["closed", "closed", "open"]);
    assert.deepEqual(
      repo.periods.map((p) => [p.joined_on, p.ended_on]),
      [["2022-03-01", "2024-05-31"], ["2025-02-01", "2026-01-31"], ["2026-06-01", null]]
    );

    // 9. one permanent employee_id throughout
    assert.deepEqual([...new Set(repo.periods.map((p) => p.employee_id))], [EMPLOYEE_ID]);
    // 10. the earlier periods were never rewritten
    assert.equal(JSON.stringify(repo.periods[0]), p1);
    assert.equal(JSON.stringify(repo.periods[1]), p2);
    // exactly one open period, ever
    assert.equal(repo.periods.filter((p) => p.period_state === "open").length, 1);

    // 17. five real transitions, five events - not one per sync
    assert.equal(repo.events.length, 5);
    assert.deepEqual(repo.events.map((e) => e.event_type), [
      EVENT.OPENED, EVENT.CLOSED, EVENT.OPENED, EVENT.CLOSED, EVENT.OPENED,
    ]);
    assert.deepEqual(opened(repo.events).map((e) => e.detail.reason), [
      REASON.INITIAL_JOIN, REASON.REJOIN, REASON.REJOIN,
    ]);

    // 22. both rejoins revoked the old sessions
    assert.equal(users.bumps.filter((b) => b === EMPLOYEE_ID).length, 4, "2 closures + 2 rejoins");
  });

  it("11. running the reconciler 20 more times changes nothing", async () => {
    const emp = master({ status: 0, parsed_joined_on: "2020-01-01", resignation_date: "2022-02-02" });
    const { repo, uc } = build(emp);
    await uc.reconcileEmployee(EMPLOYEE_ID);
    emp.status = 1;
    emp.resignation_date = null;
    emp.parsed_joined_on = "2023-03-03";
    await uc.reconcileEmployee(EMPLOYEE_ID);

    const snapshot = JSON.stringify({ p: repo.periods, e: repo.events });
    for (let i = 0; i < 20; i++) await uc.reconcileEmployee(EMPLOYEE_ID);
    assert.equal(JSON.stringify({ p: repo.periods, e: repo.events }), snapshot);
  });
});

/* ============================================================ concurrency */
describe("concurrent and repeated reconciliation", () => {
  it("12. two simultaneous reconciliations cannot create two open periods", async () => {
    const emp = master({ status: 0, parsed_joined_on: "2020-01-01", resignation_date: "2022-02-02" });
    const { repo, uc } = build(emp);
    await uc.reconcileEmployee(EMPLOYEE_ID);
    emp.status = 1;
    emp.parsed_joined_on = "2023-03-03";
    emp.resignation_date = null;

    // The fake serialises nothing - it stands in for the DB's own uniqueness
    // rules with the row lock removed - so this is the worst case: both
    // decide "rejoin", and only the constraint stops the second.
    const results = await Promise.allSettled([
      uc.reconcileEmployee(EMPLOYEE_ID),
      uc.reconcileEmployee(EMPLOYEE_ID),
    ]);

    assert.equal(repo.periods.filter((p) => p.period_state === "open").length, 1);
    assert.equal(repo.periods.length, 2, "period 1 plus exactly one rejoin");
    assert.equal(opened(repo.events).filter((e) => e.detail.reason === REASON.REJOIN).length, 1);
    assert.ok(results.some((r) => r.status === "rejected"), "the loser fails rather than duplicating");
  });

  it("a period and its event are written together or not at all", async () => {
    // If the event insert fails the period must not survive it: a period with
    // no event would be a transition with no audit trail, and the next run
    // would see it as already done.
    const emp = master({ status: 0, parsed_joined_on: "2020-01-01", resignation_date: "2022-02-02" });
    const { repo, uc } = build(emp);
    await uc.reconcileEmployee(EMPLOYEE_ID);
    assert.equal(repo.periods.length, 1);
    assert.equal(repo.events.length, 1);

    emp.status = 1;
    emp.resignation_date = null;
    emp.parsed_joined_on = "2023-03-03";
    repo.failNextEvent = true;
    await assert.rejects(() => uc.reconcileEmployee(EMPLOYEE_ID), /insertEvent failed/);

    assert.equal(repo.periods.length, 1, "the rejoin period was rolled back with its event");
    assert.equal(repo.events.length, 1);

    // And because this is reconciliation, simply running it again repairs it.
    assert.equal((await uc.reconcileEmployee(EMPLOYEE_ID)).action, "open_rejoin");
    assert.equal(repo.periods.length, 2);
    assert.equal(repo.events.length, 2);
  });

  it("a second closure of an already-closed period writes no second event", async () => {
    const emp = master({ parsed_joined_on: "2022-01-01" });
    const { repo, uc } = build(emp);
    await uc.reconcileEmployee(EMPLOYEE_ID);
    emp.status = 0;
    emp.resignation_date = "2024-01-01";
    const results = await Promise.allSettled([
      uc.reconcileEmployee(EMPLOYEE_ID),
      uc.reconcileEmployee(EMPLOYEE_ID),
    ]);
    assert.ok(results.every((r) => r.status === "fulfilled"));
    assert.equal(closed(repo.events).length, 1);
  });
});

/* ================================================================ C1b rows */
describe("the 630 C1b backfill rows", () => {
  it("18. get no manufactured historical events, and are not rewritten", async () => {
    // A backfilled row, exactly as C1b leaves it: source 'backfill', an
    // unknown joining date, no event.
    const emp = master({ status: 0, resignation_date: null });
    const { repo, uc } = build(emp);
    repo.periods.push({
      period_id: 1, employee_id: EMPLOYEE_ID, period_no: 1, period_state: "closed",
      joined_on: null, ended_on: null, end_reason_type: null, source: "backfill", needs_review: 1,
    });
    const before = JSON.stringify(repo.periods);

    for (let i = 0; i < 5; i++) {
      assert.equal((await uc.reconcileEmployee(EMPLOYEE_ID)).action, "none");
    }
    assert.equal(repo.events.length, 0, "no event is invented for history C1c did not witness");
    assert.equal(JSON.stringify(repo.periods), before);
  });

  it("a backfilled period still closes correctly when that employee later rejoins", async () => {
    const emp = master({ status: 1 });
    const { repo, uc } = build(emp);
    repo.periods.push({
      period_id: 1, employee_id: EMPLOYEE_ID, period_no: 1, period_state: "closed",
      joined_on: "2019-01-01", ended_on: "2023-01-01", end_reason_type: "resignation",
      source: "backfill", needs_review: 0,
    });
    emp.parsed_joined_on = "2025-05-05";
    await uc.reconcileEmployee(EMPLOYEE_ID);
    assert.equal(repo.periods[1].period_no, 2);
    assert.equal(repo.periods[1].joined_on, "2025-05-05");
    assert.equal(repo.periods[0].source, "backfill", "the backfilled row keeps its provenance");
  });
});

/* =============================================================== the rules */
describe("the pure decision function", () => {
  it("refuses a stale rejoin date, accepts one that postdates the previous period", () => {
    const prev = { joined_on: "2022-01-01", ended_on: "2024-01-01" };
    assert.equal(credibleRejoinDate("2025-01-01", prev), true);
    assert.equal(credibleRejoinDate("2024-01-01", prev), false, "same day as the end is not a rejoin");
    assert.equal(credibleRejoinDate("2022-01-01", prev), false);
    assert.equal(credibleRejoinDate(null, prev), false);
    // No previous dates at all: nothing distinguishes stale from fresh.
    assert.equal(credibleRejoinDate("2025-01-01", { joined_on: null, ended_on: null }), false);
    // End unknown, join known: still must postdate the join.
    assert.equal(credibleRejoinDate("2025-01-01", { joined_on: "2022-01-01", ended_on: null }), true);
  });

  it("reads Date objects and ISO strings identically", () => {
    assert.equal(toDateOnly(new Date(2024, 0, 31)), "2024-01-31");
    assert.equal(toDateOnly("2024-01-31"), "2024-01-31");
    assert.equal(toDateOnly("2024-01-31T00:00:00.000Z"), "2024-01-31");
    assert.equal(toDateOnly(null), null);
    assert.equal(toDateOnly(""), null);
    assert.equal(toDateOnly("not a date"), null);
  });

  it("treats every status other than 1 as not employed", () => {
    for (const status of [0, 2, "0", null]) {
      const plan = decide(master({ status }), null);
      assert.equal(plan.period.period_state, "closed", `status ${status}`);
    }
    assert.equal(decide(master({ status: "1" }), null).period.period_state, "open");
  });

  it("takes no decision from the clock", () => {
    const src = fs.readFileSync(path.join(__dirname, "employee_lifecycle.js"), "utf8");
    const rule = src.slice(src.indexOf("function decide"), src.indexOf("class EmployeeLifecycleUsecase"));
    for (const forbidden of ["Date.now", "new Date(", "NOW()", "CURRENT_DATE", "created_at", "updated_at"]) {
      assert.ok(!rule.includes(forbidden), `decide() must not consult ${forbidden}`);
    }
  });
});

/* =========================================================== reconcileAll */
describe("reconcileAll", () => {
  it("reports what it did and survives one employee failing", async () => {
    const emp = master({ parsed_joined_on: "2025-01-01" });
    const { repo, uc } = build(emp);
    let summary = await uc.reconcileAll();
    assert.equal(summary.open_initial, 1);
    assert.equal(summary.failed, 0);

    summary = await uc.reconcileAll();
    assert.equal(summary.none, 1, "a second pass finds nothing to do");

    repo.locale = "en_GB"; // the long-form date rule would silently return NULL
    summary = await uc.reconcileAll();
    assert.equal(summary.failed, 1);
    assert.match(summary.failures[0].error, /lc_time_names/);
  });
});

/* ============================================ the shared date-parsing rule */
describe("the dry-run reporter", () => {
  const src = () => fs.readFileSync(path.join(__dirname, "..", "scripts/auth/c1c-dry-run.js"), "utf8");

  it("issues no statement that could write, and opens no transaction", () => {
    // Comments and log strings are stripped first, so the check is about SQL
    // the script could actually run - not about the word "UPDATE" appearing
    // in a line it prints.
    const code = src()
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/`[^`]*`/g, "``")
      .replace(/"[^"]*"/g, '""')
      .replace(/'[^']*'/g, "''");
    for (const verb of [
      "INSERT", "UPDATE", "DELETE", "ALTER", "DROP", "TRUNCATE", "REPLACE",
      "beginTransaction", "START TRANSACTION",
    ]) {
      assert.ok(!new RegExp(`\\b${verb}\\b`, "i").test(code), `dry run must not contain ${verb}`);
    }
  });

  it("reuses the real decide(), so it cannot drift from the reconciler", () => {
    assert.match(src(), /require\(path\.join\(ROOT, "usecase\/employee_lifecycle"\)\)/);
    assert.match(src(), /\bdecide\(employee, latest\)/);
    // and the same date rule the backfill used
    assert.match(src(), /require\(path\.join\(ROOT, "utils\/joining_date"\)\)/);
  });

  it("prints no employee name", () => {
    assert.ok(!/employee_name/.test(src()), "the report is by id and date only");
  });
});

describe("the joining-date rule is the same one C1b ran against production", () => {
  it("utils/joining_date.js and scripts/auth/c1b-backfill.js agree character for character", () => {
    const util = require("../utils/joining_date");
    const backfill = require("../scripts/auth/c1b-backfill");
    assert.equal(util.JOINED_ON("ne"), backfill.JOINED_ON("ne"));
    assert.equal(util.UNPARSEABLE("ne"), backfill.UNPARSEABLE("ne"));
    assert.equal(util.JOINED_ON("x"), backfill.JOINED_ON("x"));
  });

  it("still uses %M, which parses 'September', and not %b, which does not", () => {
    const { JOINED_ON } = require("../utils/joining_date");
    assert.match(JOINED_ON(), /%d %M %Y/);
    assert.ok(!/%d %b %Y/.test(JOINED_ON()));
  });
});
