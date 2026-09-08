/**
 * Stage 0C / C2 — HR owns the lifecycle.
 *
 *   node --test usecase/employee_master.test.js
 *
 * The four actions are driven against a fake that enforces the real C1a
 * constraints - one open period per employee, unique (employee_id, period_no),
 * ended_on >= joined_on, an open period has no end - and the REAL C1c
 * reconciler is wired underneath. So what is tested is the actual
 * "master change then reconcile, in one transaction" path, not a mock of it.
 *
 * The headline case is the full cycle
 *
 *   Create -> Edit -> Resign -> Rejoin -> Resign -> Rejoin
 *
 * with the invariants checked after every step: one permanent employee_id,
 * periods 1/2/3, exactly one open period, and earlier periods byte-identical.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const lifecycleUsecase = require("./employee_lifecycle");
const masterUsecaseFactory = require("./employee_master");
const { EDITABLE_FIELDS, LIFECYCLE_CONTROLLED_FIELDS, SECURITY_RELEVANT_FIELDS } = require("../repository/employee_master");

/* ------------------------------------------------------------- the world --
 * One in-memory database behind both repositories, so the transaction the
 * master repository opens is the same one the reconciler is handed.
 */
class World {
  constructor() {
    this.employees = new Map();
    this.periods = [];
    this.events = [];
    this.users = new Map();
    this.nextEmployeeId = 1000; // stands in for AUTO_INCREMENT
    this.nextPeriodId = 1;
    this.nextEventId = 1;
    this.nextResignationId = 1;
    this.resignations = [];
    this.failNextEvent = false;
    this.failNextReconcile = false;
  }

  snapshot() {
    return JSON.stringify({
      employees: [...this.employees.entries()],
      periods: this.periods,
      events: this.events,
      users: [...this.users.entries()],
      resignations: this.resignations,
    });
  }

  /** The four C1a constraints. */
  check(row) {
    if (row.period_state === "open" && row.ended_on !== null) throw new Error("chk_period_open_has_no_end");
    if (row.ended_on !== null && row.joined_on !== null && row.ended_on < row.joined_on) {
      throw new Error("chk_period_dates_ordered");
    }
    const otherOpen = this.periods.filter(
      (p) => p.employee_id === row.employee_id && p.period_state === "open" && p.period_id !== row.period_id
    );
    if (row.period_state === "open" && otherOpen.length) throw new Error("uq_one_open_period");
    if (this.periods.some((p) => p.employee_id === row.employee_id && p.period_no === row.period_no && p.period_id !== row.period_id)) {
      throw new Error("uq_period_seq");
    }
  }
}

/** A transaction with a real undo log, so a rollback undoes only its own writes. */
const makeTx = () => ({ query: async () => [], _undo: [] });
const record = (tx, fn) => tx && tx._undo && tx._undo.push(fn);

function makeMasterRepo(world) {
  return {
    async withTransaction(fn) {
      const tx = makeTx();
      try {
        return await fn(tx);
      } catch (err) {
        for (const step of tx._undo.reverse()) step();
        throw err;
      }
    },
    async createEmployee(tx, fields) {
      if ("employee_id" in fields) throw new Error("createEmployee must not be given an employee_id");
      const id = world.nextEmployeeId++;
      world.employees.set(id, { employee_id: id, ...fields });
      record(tx, () => world.employees.delete(id));
      return id;
    },
    async lockEmployee(_tx, id) {
      const e = world.employees.get(Number(id));
      return e ? { ...e } : null;
    },
    async updateEmployee(tx, id, fields) {
      for (const c of Object.keys(fields)) {
        if (LIFECYCLE_CONTROLLED_FIELDS.includes(c)) throw new Error(`'${c}' is lifecycle-controlled`);
        if (!EDITABLE_FIELDS.includes(c)) throw new Error(`'${c}' is not editable`);
      }
      const e = world.employees.get(Number(id));
      if (!e) return 0;
      const before = { ...e };
      Object.assign(e, fields);
      record(tx, () => world.employees.set(Number(id), before));
      return 1;
    },
    async markResigned(tx, id, endedOn) {
      const e = world.employees.get(Number(id));
      if (!e || Number(e.status) !== 1) return 0;
      const before = { ...e };
      e.status = 0;
      e.resignation_date = endedOn;
      record(tx, () => world.employees.set(Number(id), before));
      return 1;
    },
    async markRejoined(tx, id, joinedOn) {
      const e = world.employees.get(Number(id));
      if (!e || Number(e.status) === 1) return 0;
      const before = { ...e };
      e.status = 1;
      e.resignation_date = null;
      e.date_of_joining = joinedOn;
      record(tx, () => world.employees.set(Number(id), before));
      return 1;
    },
    async createResignationRecord(tx, row) {
      const r = { resignation_id: world.nextResignationId++, ...row };
      world.resignations.push(r);
      record(tx, () => {
        world.resignations = world.resignations.filter((x) => x.resignation_id !== r.resignation_id);
      });
      return r.resignation_id;
    },
    async bumpTokenValidFrom(tx, id) {
      const before = world.users.get(Number(id));
      world.users.set(Number(id), new Date().toISOString());
      record(tx, () =>
        before === undefined ? world.users.delete(Number(id)) : world.users.set(Number(id), before)
      );
      return 1;
    },
    async getPeriods(id) {
      return world.periods.filter((p) => p.employee_id === Number(id)).sort((a, b) => a.period_no - b.period_no);
    },
    async getEvents(id) {
      return world.events.filter((e) => e.employee_id === Number(id));
    },
    async getEmployeeHeader(id) {
      const e = world.employees.get(Number(id));
      return e ? { ...e, outlet_nickname: "Branch", designation_name: "Cashier", department_name: "Ops" } : null;
    },
    async getReviewList() {
      return world.periods.filter((p) => p.needs_review === 1);
    },
    async countReviewList() {
      return world.periods.filter((p) => p.needs_review === 1).length;
    },
  };
}

function makeLifecycleRepo(world) {
  return {
    async withTransaction(fn) {
      const tx = makeTx();
      try {
        return await fn(tx);
      } catch (err) {
        for (const step of tx._undo.reverse()) step();
        throw err;
      }
    },
    async assertDateLocale() {},
    async lockAndReadEmployee(_tx, id) {
      const e = world.employees.get(Number(id));
      if (!e) return null;
      return {
        employee_id: e.employee_id,
        status: e.status,
        resignation_date: e.resignation_date,
        raw_date_of_joining: e.date_of_joining,
        parsed_joined_on: e.date_of_joining || null,
      };
    },
    async getLatestPeriod(_tx, id) {
      const mine = world.periods.filter((p) => p.employee_id === Number(id));
      if (!mine.length) return null;
      const latest = mine.reduce((a, b) => (b.period_no > a.period_no ? b : a));
      const prev = mine.filter((p) => p.period_no < latest.period_no).sort((a, b) => b.period_no - a.period_no)[0];
      return { ...latest, prev_ended_on: prev ? prev.ended_on : null };
    },
    async insertPeriod(tx, p) {
      if (world.failNextReconcile) {
        world.failNextReconcile = false;
        throw new Error("simulated lifecycle failure");
      }
      const row = {
        period_id: world.nextPeriodId++,
        employee_id: p.employee_id,
        period_no: p.period_no,
        period_state: p.period_state,
        joined_on: p.joined_on ?? null,
        ended_on: p.ended_on ?? null,
        end_reason_type: p.end_reason_type ?? null,
        source: "local",
        needs_review: p.needs_review ? 1 : 0,
      };
      world.check(row);
      world.periods.push(row);
      record(tx, () => {
        world.periods = world.periods.filter((x) => x.period_id !== row.period_id);
      });
      return row.period_id;
    },
    async closePeriod(tx, periodId, patch) {
      if (world.failNextReconcile) {
        world.failNextReconcile = false;
        throw new Error("simulated lifecycle failure");
      }
      const row = world.periods.find((p) => p.period_id === periodId);
      if (!row || row.period_state !== "open") return 0;
      const next = {
        ...row,
        period_state: "closed",
        ended_on: patch.ended_on ?? null,
        end_reason_type: patch.end_reason_type,
        needs_review: patch.needs_review ? 1 : 0,
      };
      world.check(next);
      const before = { ...row };
      Object.assign(row, next);
      record(tx, () => Object.assign(row, before));
      return 1;
    },
    async fillNullDate(tx, periodId, column, value, patch) {
      const row = world.periods.find((p) => p.period_id === periodId);
      if (!row || row[column] !== null) return 0;
      const next = { ...row, [column]: value, needs_review: patch.needs_review ? 1 : 0 };
      world.check(next);
      const before = { ...row };
      Object.assign(row, next);
      record(tx, () => Object.assign(row, before));
      return 1;
    },
    async insertEvent(tx, e) {
      if (world.failNextEvent) {
        world.failNextEvent = false;
        throw new Error("simulated event failure");
      }
      const row = { event_id: world.nextEventId++, ...e };
      world.events.push(row);
      record(tx, () => {
        world.events = world.events.filter((x) => x.event_id !== row.event_id);
      });
      return row.event_id;
    },
    async listEmployeesNeedingReconciliation() {
      return [...world.employees.keys()];
    },
  };
}

function build() {
  const world = new World();
  const lifecycleRepo = makeLifecycleRepo(world);
  const lifecycle = lifecycleUsecase(lifecycleRepo, null);
  const uc = masterUsecaseFactory(makeMasterRepo(world), lifecycle, lifecycleRepo);
  return { world, uc };
}

const VALID = {
  employee_name: "Rehearsal Person",
  date_of_joining: "2022-03-01",
  store_id: 2,
  designation_id: 3,
  department_id: 4,
};

const shapeOf = (world, id) =>
  world.periods
    .filter((p) => p.employee_id === id)
    .sort((a, b) => a.period_no - b.period_no)
    .map((p) => [p.period_no, p.period_state, p.joined_on, p.ended_on]);

const openedEvents = (world, id) =>
  world.events.filter((e) => e.employee_id === id && e.event_type === "period_opened");
const closedEvents = (world, id) =>
  world.events.filter((e) => e.employee_id === id && e.event_type === "period_closed");

/* ======================================================== create ======== */
describe("Create Employee", () => {
  it("1/2/3. allocates a permanent id, opens period 1, writes exactly one event", async () => {
    const { world, uc } = build();
    const res = await uc.createEmployee({ ...VALID });
    assert.equal(res.code, 200);
    assert.ok(Number.isInteger(res.employee_id) && res.employee_id > 0);
    assert.equal(res.lifecycle_action, "open_initial");
    assert.deepEqual(shapeOf(world, res.employee_id), [[1, "open", "2022-03-01", null]]);
    assert.equal(world.events.length, 1);
    assert.equal(world.events[0].event_type, "period_opened");
    assert.equal(world.events[0].detail.reason, "initial_join");
    assert.equal(world.employees.get(res.employee_id).status, 1);
    assert.equal(world.employees.get(res.employee_id).resignation_date, null);
  });

  it("1. two creates never receive the same id", async () => {
    const { uc } = build();
    const ids = [];
    for (let i = 0; i < 25; i++) ids.push((await uc.createEmployee({ ...VALID })).employee_id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it("4. concurrent creates cannot collide, because the database allocates", async () => {
    const { world, uc } = build();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => uc.createEmployee({ ...VALID }))
    );
    const ids = results.map((r) => r.employee_id);
    assert.equal(new Set(ids).size, 10, "every create got its own id");
    assert.equal(world.periods.filter((p) => p.period_no === 1).length, 10);
    // The repository refuses a caller-supplied id, which is what removes the race.
    const src = fs.readFileSync(path.join(__dirname, "..", "repository/employee_master.js"), "utf8");
    assert.match(src, /createEmployee must not be given an employee_id/);
    assert.ok(!/INSERT INTO new_employee[^;]*employee_id/.test(src), "the insert must not name employee_id");
  });

  it("5. a joining date is required, and must be an exact calendar date", async () => {
    const { uc } = build();
    await assert.rejects(() => uc.createEmployee({ ...VALID, date_of_joining: "" }), /required/);
    await assert.rejects(() => uc.createEmployee({ ...VALID, date_of_joining: undefined }), /required/);
    await assert.rejects(() => uc.createEmployee({ ...VALID, date_of_joining: "01 March 2022" }), /YYYY-MM-DD/);
    await assert.rejects(() => uc.createEmployee({ ...VALID, date_of_joining: "2022-02-30" }), /not a real calendar date/);
  });

  it("a future joining date is refused rather than silently applied", async () => {
    const { uc } = build();
    const future = new Date(Date.now() + 86400000 * 30).toISOString().slice(0, 10);
    await assert.rejects(() => uc.createEmployee({ ...VALID, date_of_joining: future }), /no scheduler/);
  });

  it("an employee_id offered by the caller is ignored, never honoured", async () => {
    const { world, uc } = build();
    const res = await uc.createEmployee({ ...VALID, employee_id: 999999 });
    assert.notEqual(res.employee_id, 999999);
    assert.ok(!world.employees.has(999999));
  });

  it("creates no login and no password", async () => {
    const src = fs.readFileSync(path.join(__dirname, "employee_master.js"), "utf8");
    for (const forbidden of ["createLogin", "passwordService", "password"]) {
      assert.ok(!new RegExp(`\\b${forbidden}\\b`).test(src), `C2 must not touch ${forbidden}`);
    }
  });
});

/* ========================================================== edit ======== */
describe("Edit Employee", () => {
  it("7. an ordinary profile edit works", async () => {
    const { world, uc } = build();
    const { employee_id } = await uc.createEmployee({ ...VALID });
    const res = await uc.editEmployee(employee_id, { employee_name: "New Name", blood_group: "O+" });
    assert.equal(res.code, 200);
    assert.equal(world.employees.get(employee_id).employee_name, "New Name");
    assert.equal(res.sessions_revoked, false);
  });

  it("5/6. employee_id, status and the lifecycle dates are refused by name", async () => {
    const { uc } = build();
    const { employee_id } = await uc.createEmployee({ ...VALID });
    for (const field of LIFECYCLE_CONTROLLED_FIELDS) {
      await assert.rejects(
        () => uc.editEmployee(employee_id, { [field]: 1 }),
        /cannot be changed here/,
        `${field} must be refused`
      );
    }
  });

  it("an edit never changes a period or writes an event", async () => {
    const { world, uc } = build();
    const { employee_id } = await uc.createEmployee({ ...VALID });
    const before = JSON.stringify({ p: world.periods, e: world.events });
    await uc.editEmployee(employee_id, { employee_name: "Renamed" });
    assert.equal(JSON.stringify({ p: world.periods, e: world.events }), before);
  });

  it("30. a designation or store change revokes the employee's sessions", async () => {
    const { world, uc } = build();
    const { employee_id } = await uc.createEmployee({ ...VALID });
    assert.equal(world.users.has(employee_id), false);

    const res = await uc.editEmployee(employee_id, { designation_id: 9 });
    assert.equal(res.sessions_revoked, true);
    assert.deepEqual(res.security_relevant, ["designation_id"]);
    assert.ok(world.users.has(employee_id), "token_valid_from was bumped");

    world.users.delete(employee_id);
    const res2 = await uc.editEmployee(employee_id, { store_id: 11 });
    assert.equal(res2.sessions_revoked, true);
    assert.ok(world.users.has(employee_id));
  });

  it("30. but an unchanged designation does not log anybody out", async () => {
    const { world, uc } = build();
    const { employee_id } = await uc.createEmployee({ ...VALID });
    const res = await uc.editEmployee(employee_id, { designation_id: VALID.designation_id });
    assert.equal(res.sessions_revoked, false);
    assert.equal(world.users.has(employee_id), false);
  });

  it("the security-relevant list is exactly what the auth layer reads", () => {
    assert.deepEqual(SECURITY_RELEVANT_FIELDS.sort(), ["designation_id", "store_id"]);
  });
});

/* ======================================================== resign ======== */
describe("Resign", () => {
  const resigned = async () => {
    const { world, uc } = build();
    const { employee_id } = await uc.createEmployee({ ...VALID });
    const res = await uc.resignEmployee(employee_id, {
      resignation_date: "2024-05-31",
      reason_type: "personal",
      reason: "moving away",
    });
    return { world, uc, employee_id, res };
  };

  it("12/13. closes the same period and writes exactly one closure event", async () => {
    const { world, employee_id, res } = await resigned();
    assert.equal(res.lifecycle_action, "close");
    assert.deepEqual(shapeOf(world, employee_id), [[1, "closed", "2022-03-01", "2024-05-31"]]);
    assert.equal(world.periods.filter((p) => p.employee_id === employee_id).length, 1, "no new period");
    assert.equal(closedEvents(world, employee_id).length, 1);
    assert.equal(world.employees.get(employee_id).status, 0);
  });

  it("14. revokes the employee's existing sessions", async () => {
    const { world, employee_id, res } = await resigned();
    assert.equal(res.sessions_revoked, true);
    assert.ok(world.users.has(employee_id));
  });

  it("persists a resignation record linked to employee AND period", async () => {
    const { world, employee_id } = await resigned();
    assert.equal(world.resignations.length, 1);
    const r = world.resignations[0];
    assert.equal(r.employee_id, employee_id);
    assert.ok(r.period_id, "linked to the period it closed");
    assert.equal(r.resignation_date, "2024-05-31");
  });

  it("15. a repeated resignation cannot duplicate the period or the event", async () => {
    const { world, uc, employee_id } = await resigned();
    for (let i = 0; i < 3; i++) {
      await assert.rejects(
        () => uc.resignEmployee(employee_id, { resignation_date: "2024-06-30" }),
        /not currently active/
      );
    }
    assert.equal(world.periods.filter((p) => p.employee_id === employee_id).length, 1);
    assert.equal(closedEvents(world, employee_id).length, 1);
    assert.equal(world.resignations.length, 1);
  });

  it("10. requires an explicit date and never invents today", async () => {
    const { uc } = build();
    const { employee_id } = await uc.createEmployee({ ...VALID });
    await assert.rejects(() => uc.resignEmployee(employee_id, {}), /required/);
    const src = fs.readFileSync(path.join(__dirname, "employee_master.js"), "utf8");
    const body = src.slice(src.indexOf("async resignEmployee"), src.indexOf("async rejoinEmployee"));
    assert.ok(!/todayUtc\(\)/.test(body), "resign must not read the clock for a date");
  });

  it("26. a resignation date before the period's joining date is refused", async () => {
    const { world, uc } = build();
    const { employee_id } = await uc.createEmployee({ ...VALID });
    const before = JSON.stringify(world.periods);
    await assert.rejects(
      () => uc.resignEmployee(employee_id, { resignation_date: "2021-01-01" }),
      /precedes the current period's joining date/
    );
    assert.equal(JSON.stringify(world.periods), before, "nothing was written");
    assert.equal(world.employees.get(employee_id).status, 1, "still employed");
  });

  it("a future resignation date is refused, not applied now", async () => {
    const { uc } = build();
    const { employee_id } = await uc.createEmployee({ ...VALID });
    const future = new Date(Date.now() + 86400000 * 10).toISOString().slice(0, 10);
    await assert.rejects(() => uc.resignEmployee(employee_id, { resignation_date: future }), /no scheduler/);
  });
});

/* ======================================================== rejoin ======== */
describe("Rejoin", () => {
  const rejoined = async () => {
    const { world, uc } = build();
    const { employee_id } = await uc.createEmployee({ ...VALID });
    await uc.resignEmployee(employee_id, { resignation_date: "2024-05-31" });
    const res = await uc.rejoinEmployee(employee_id, { date_of_joining: "2025-02-01" });
    return { world, uc, employee_id, res };
  };

  it("16/17/18. creates period 2, keeps the id, leaves period 1 alone", async () => {
    const { world, uc } = build();
    const { employee_id } = await uc.createEmployee({ ...VALID });
    await uc.resignEmployee(employee_id, { resignation_date: "2024-05-31" });
    const period1 = JSON.stringify(world.periods.find((p) => p.period_no === 1));

    const res = await uc.rejoinEmployee(employee_id, { date_of_joining: "2025-02-01" });
    assert.equal(res.lifecycle_action, "open_rejoin");
    assert.equal(res.employee_id, employee_id, "same permanent employee_id");
    assert.equal(res.new_period_no, 2);
    assert.equal(JSON.stringify(world.periods.find((p) => p.period_no === 1)), period1, "period 1 untouched");
    assert.deepEqual(shapeOf(world, employee_id), [
      [1, "closed", "2022-03-01", "2024-05-31"],
      [2, "open", "2025-02-01", null],
    ]);
    assert.equal(openedEvents(world, employee_id).slice(-1)[0].detail.reason, "rejoin");
  });

  it("20/21. revokes the old session, so a fresh login is required", async () => {
    const { world, employee_id, res } = await rejoined();
    assert.equal(res.sessions_revoked, true);
    assert.ok(world.users.has(employee_id), "token_valid_from moved on rejoin");
  });

  it("19. requires an explicit rejoin date", async () => {
    const { uc } = build();
    const { employee_id } = await uc.createEmployee({ ...VALID });
    await uc.resignEmployee(employee_id, { resignation_date: "2024-05-31" });
    await assert.rejects(() => uc.rejoinEmployee(employee_id, {}), /required/);
    await assert.rejects(() => uc.rejoinEmployee(employee_id, { date_of_joining: "yesterday" }), /YYYY-MM-DD/);
  });

  it("27. a rejoin date on or before the previous end is refused", async () => {
    const { world, uc } = build();
    const { employee_id } = await uc.createEmployee({ ...VALID });
    await uc.resignEmployee(employee_id, { resignation_date: "2024-05-31" });
    const before = JSON.stringify(world.periods);
    for (const bad of ["2024-05-31", "2024-01-01", "2022-03-01"]) {
      await assert.rejects(
        () => uc.rejoinEmployee(employee_id, { date_of_joining: bad }),
        /must be after the previous period ended/
      );
    }
    assert.equal(JSON.stringify(world.periods), before);
    assert.equal(world.employees.get(employee_id).status, 0, "still inactive");
  });

  it("an active employee cannot be rejoined", async () => {
    const { uc } = build();
    const { employee_id } = await uc.createEmployee({ ...VALID });
    await assert.rejects(() => uc.rejoinEmployee(employee_id, { date_of_joining: "2025-01-01" }), /already active/);
  });

  it("refuses rather than guesses when the previous period has no end date", async () => {
    // 93 historical periods look like this. Opening period 2 with joined_on
    // NULL would silently discard the date HR just supplied, so the action
    // asks for the missing one instead.
    const { world, uc } = build();
    const { employee_id } = await uc.createEmployee({ ...VALID });
    await uc.resignEmployee(employee_id, { resignation_date: "2024-05-31" });
    world.periods.find((p) => p.period_no === 1).ended_on = null; // as C1b left them

    await assert.rejects(
      () => uc.rejoinEmployee(employee_id, { date_of_joining: "2025-02-01" }),
      /has no recorded end date/
    );

    const res = await uc.rejoinEmployee(employee_id, {
      date_of_joining: "2025-02-01",
      previous_ended_on: "2024-05-31",
    });
    assert.equal(res.new_period_no, 2);
    assert.equal(res.filled_previous_ended_on, "2024-05-31");
    assert.equal(world.periods.find((p) => p.period_no === 1).ended_on, "2024-05-31");
  });

  it("a supplied previous end date can only fill a NULL, never overwrite", async () => {
    const { world, uc } = build();
    const { employee_id } = await uc.createEmployee({ ...VALID });
    await uc.resignEmployee(employee_id, { resignation_date: "2024-05-31" });
    const res = await uc.rejoinEmployee(employee_id, {
      date_of_joining: "2025-02-01",
      previous_ended_on: "2023-01-01", // ignored: the real one is known
    });
    assert.equal(res.filled_previous_ended_on, null);
    assert.equal(world.periods.find((p) => p.period_no === 1).ended_on, "2024-05-31");
  });
});

/* ============================================== the whole cycle ========= */
describe("Create -> Edit -> Resign -> Rejoin -> Resign -> Rejoin", () => {
  it("22/23/24/25. periods 1/2/3 under one employee_id, history intact", async () => {
    const { world, uc } = build();

    const { employee_id } = await uc.createEmployee({ ...VALID });
    await uc.editEmployee(employee_id, { employee_name: "Edited Name", blood_group: "B+" });
    assert.deepEqual(shapeOf(world, employee_id), [[1, "open", "2022-03-01", null]]);

    await uc.resignEmployee(employee_id, { resignation_date: "2024-05-31" });
    const p1 = JSON.stringify(world.periods.find((p) => p.period_no === 1));

    await uc.rejoinEmployee(employee_id, { date_of_joining: "2025-02-01" });
    await uc.resignEmployee(employee_id, { resignation_date: "2026-01-31" });
    const p2 = JSON.stringify(world.periods.find((p) => p.period_no === 2));

    const last = await uc.rejoinEmployee(employee_id, { date_of_joining: "2026-06-01" });
    assert.equal(last.new_period_no, 3);

    assert.deepEqual(shapeOf(world, employee_id), [
      [1, "closed", "2022-03-01", "2024-05-31"],
      [2, "closed", "2025-02-01", "2026-01-31"],
      [3, "open", "2026-06-01", null],
    ]);
    // 24. the sequence
    assert.deepEqual(
      world.periods.filter((p) => p.employee_id === employee_id).map((p) => p.period_no),
      [1, 2, 3]
    );
    // 17. one permanent identity
    assert.deepEqual([...new Set(world.periods.map((p) => p.employee_id))], [employee_id]);
    // 25. earlier periods never rewritten
    assert.equal(JSON.stringify(world.periods.find((p) => p.period_no === 1)), p1);
    assert.equal(JSON.stringify(world.periods.find((p) => p.period_no === 2)), p2);
    // exactly one open period, always
    assert.equal(world.periods.filter((p) => p.period_state === "open").length, 1);
    // five transitions, five events - the edit contributed none
    assert.deepEqual(world.events.map((e) => e.event_type), [
      "period_opened", "period_closed", "period_opened", "period_closed", "period_opened",
    ]);
    assert.deepEqual(openedEvents(world, employee_id).map((e) => e.detail.reason), [
      "initial_join", "rejoin", "rejoin",
    ]);
  });
});

/* ==================================================== atomicity ========= */
describe("atomicity", () => {
  it("28. a failed reconciliation rolls the master change back", async () => {
    const { world, uc } = build();
    const { employee_id } = await uc.createEmployee({ ...VALID });
    const before = world.snapshot();

    world.failNextReconcile = true;
    await assert.rejects(
      () => uc.resignEmployee(employee_id, { resignation_date: "2024-05-31", reason_type: "personal" }),
      /simulated lifecycle failure/
    );

    assert.equal(world.snapshot(), before, "employee, period, event, resignation and cutoff all rolled back");
    assert.equal(world.employees.get(employee_id).status, 1, "still employed");
    assert.equal(world.periods.find((p) => p.period_no === 1).period_state, "open");
  });

  it("29. a failed event write rolls the whole transaction back", async () => {
    const { world, uc } = build();
    const { employee_id } = await uc.createEmployee({ ...VALID });
    const before = world.snapshot();

    world.failNextEvent = true;
    await assert.rejects(() => uc.resignEmployee(employee_id, { resignation_date: "2024-05-31" }), /simulated event failure/);
    assert.equal(world.snapshot(), before);
  });

  it("28. a create whose lifecycle fails leaves no orphan employee", async () => {
    const { world, uc } = build();
    world.failNextReconcile = true;
    await assert.rejects(() => uc.createEmployee({ ...VALID }), /simulated lifecycle failure/);
    assert.equal(world.employees.size, 0, "the employee row was rolled back too");
    assert.equal(world.periods.length, 0);
  });

  it("the session cutoff is rolled back with everything else", async () => {
    const { world, uc } = build();
    const { employee_id } = await uc.createEmployee({ ...VALID });
    world.failNextEvent = true;
    await assert.rejects(() => uc.resignEmployee(employee_id, { resignation_date: "2024-05-31" }));
    assert.equal(world.users.has(employee_id), false, "nobody was logged out of a job they still have");
  });

  it("the reconciler runs on the CALLER's transaction, not its own", () => {
    const src = fs.readFileSync(path.join(__dirname, "employee_master.js"), "utf8");
    assert.match(src, /reconcileEmployee\(employeeId, \{ tx, actorEmployeeId \}\)/);
    const lc = fs.readFileSync(path.join(__dirname, "employee_lifecycle.js"), "utf8");
    assert.match(lc, /options\.tx \? fn\(options\.tx\) : this\.lifecycleRepo\.withTransaction\(fn\)/);
  });
});

/* ============================================ C1c is the only engine ==== */
describe("C1c remains the sole lifecycle engine", () => {
  const src = fs.readFileSync(path.join(__dirname, "employee_master.js"), "utf8");

  it("C2 never writes a period or an event itself", () => {
    for (const forbidden of ["insertPeriod", "closePeriod", "insertEvent", "employee_employment_period", "employee_lifecycle_event"]) {
      assert.ok(!new RegExp(forbidden).test(src), `C2 must not touch ${forbidden} directly`);
    }
  });

  it("and restates none of C1c's period rules", () => {
    // Reading a period_no the reconciler produced, and quoting it back in an
    // error message, is fine. COMPUTING one is not - that is the rule C1c
    // owns, and a copy of it here is exactly what would drift.
    assert.ok(!/period_no\s*[+-]|MAX\(\s*period_no|period_no\s*\+\s*1/i.test(src), "C2 must not compute a period_no");
    assert.ok(
      !/\bperiod_no\s*[:=]\s*[^,)\s]/.test(src.replace(/\w+\.period_no/g, "")),
      "C2 must not assign a period_no"
    );
    for (const rule of ["credibleRejoinDate", "joinableInto", "reviewNeeded", "period_state ="]) {
      assert.ok(!new RegExp(rule.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).test(src), `C2 must not restate ${rule}`);
    }
  });

  it("every action asserts the reconciler did what the action meant", () => {
    assert.match(src, /lifecycle reconciliation did not perform the expected/);
    assert.match(src, /create: \["open_initial"\]/);
    assert.match(src, /resign: \["close"\]/);
    assert.match(src, /rejoin: \["open_rejoin"\]/);
  });
});

/* ===================================================== reads ============ */
describe("lifecycle history and the review list", () => {
  it("37. the history exposes no B3-sensitive field", async () => {
    const { uc } = build();
    const { employee_id } = await uc.createEmployee({ ...VALID });
    const history = await uc.getLifecycleHistory(employee_id);
    const text = JSON.stringify(history);
    for (const field of [
      "salary", "payment_type", "bank_name", "ifsc", "account_no", "pan_no",
      "aadhaar_card_no", "aadhaar_card_name", "aadhaar_card_image", "uan",
      "pf", "pf_number", "esi", "esi_number",
    ]) {
      assert.ok(!new RegExp(`"${field}"`, "i").test(text), `${field} must not appear`);
    }
    // and the repository query names its columns rather than SELECT *
    const repo = fs.readFileSync(path.join(__dirname, "..", "repository/employee_master.js"), "utf8");
    assert.ok(!/SELECT \*/.test(repo), "no SELECT * anywhere in the C2 repository");
  });

  it("returns the periods in order with everything HR needs", async () => {
    const { uc } = build();
    const { employee_id } = await uc.createEmployee({ ...VALID });
    await uc.resignEmployee(employee_id, { resignation_date: "2024-05-31" });
    await uc.rejoinEmployee(employee_id, { date_of_joining: "2025-02-01" });

    const h = await uc.getLifecycleHistory(employee_id);
    assert.equal(h.employee_id, employee_id);
    assert.equal(h.is_active, true);
    assert.deepEqual(h.periods.map((p) => p.period_no), [1, 2]);
    assert.deepEqual(h.periods.map((p) => p.period_state), ["closed", "open"]);
    assert.equal(h.events.length, 3);
    assert.ok("needs_review" in h.periods[0]);
    assert.ok(h.current.designation_name);
  });

  it("38. the review list reports and never repairs", async () => {
    const { world, uc } = build();
    const { employee_id } = await uc.createEmployee({ ...VALID });
    world.periods.find((p) => p.employee_id === employee_id).needs_review = 1;
    const before = JSON.stringify(world.periods);

    const list = await uc.getReviewList({ limit: 10, offset: 0 });
    assert.equal(list.total, 1);
    assert.equal(JSON.stringify(world.periods), before, "reading the queue changes nothing");

    const repo = fs.readFileSync(path.join(__dirname, "..", "repository/employee_master.js"), "utf8");
    const block = repo.slice(repo.indexOf("getReviewList"), repo.indexOf("countReviewList"));
    for (const verb of ["UPDATE", "INSERT", "DELETE"]) {
      assert.ok(!new RegExp(`\\b${verb}\\b`).test(block), `the review query must not ${verb}`);
    }
  });
});
