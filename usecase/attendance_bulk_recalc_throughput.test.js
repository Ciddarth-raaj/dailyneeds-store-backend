/**
 * BULK RECALCULATION THROUGHPUT - what the batching and the bounded worker
 * may change (how many times the punch re-derive runs, how many employees are
 * in flight) and what they must not (what is stored, what is reported, the
 * payroll lock, the order of the run's errors).
 *
 * The real `usecase/attendance_calculation.js` and engine over an in-memory
 * repository. The write is slowed a little so workers genuinely overlap.
 */
const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const buildCalculation = require("./attendance_calculation");
const { scheduleFor, configFor, workedDay } = require("./work_shift_rule_propagation.harness");
const { payrollLockedError } = require("../utils/attendance_payroll_lock");
const recalcTiming = require("../utils/attendance_recalc_timing");
const logger = require("../utils/logger");

const SHIFT = 5;
const FROM = "2026-08-01";
const TO = "2026-08-05";
// Well after every date above has closed.
const NOW = Date.parse("2026-09-25T12:00:00+05:30");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} o
 * @param {number[]} o.employees            ids, all on SHIFT, joined 2020
 * @param {object}   o.employment           id -> overrides of the employment row
 * @param {object}   o.candidates           id -> overrides of the CANDIDATE row only
 * @param {function} o.onWrite              (employeeId, attempt) -> throws to fail
 * @param {object}   o.writeDelay           id -> ms (default 5)
 */
function fakeWorld({ employees, employment = {}, candidates = {}, onWrite = null, writeDelay = {}, redriveFails = false, redriveScanned = 0 } = {}) {
  const state = {
    stored: new Map(), // `${id}|${date}` -> row
    redriveCalls: [],
    writeAttempts: new Map(),
    inFlight: 0,
    maxInFlight: 0,
    inFlightByEmployee: new Map(),
    overlapSameEmployee: false,
    runs: [],
  };
  const employmentRow = (id) => ({
    employee_id: id,
    employee_name: `E${id}`,
    status: 1,
    attendance_required: 1,
    date_of_joining: "2020-01-01",
    resignation_date: null,
    ...(employment[id] || {}),
  });
  const punchesFor = (id, from, to) => {
    const rows = [];
    for (let d = Date.parse(`${from}T00:00:00Z`); d <= Date.parse(`${to}T00:00:00Z`); d += 86400000) {
      const date = new Date(d).toISOString().slice(0, 10);
      rows.push(...workedDay(id * 1000 + rows.length, id, date));
    }
    return rows;
  };

  const repo = {
    getEmploymentWindow: async (id) => (employees.includes(Number(id)) ? employmentRow(Number(id)) : null),
    outletExists: async () => true,
    designationExists: async () => true,
    listEmployeesForRecalculation: async () =>
      employees.map((id) => ({ ...employmentRow(id), store_id: 1, ...(candidates[id] || {}) })),
    getShiftAssignmentHistory: async (id) => [
      { employee_work_shift_assignment_id: id, employee_id: id, work_shift_id: SHIFT, effective_from: "2020-01-01", source: "TEST" },
    ],
    getRawPunchesByCalendarWindow: async (id, from, to) => punchesFor(Number(id), from, to),
    getApprovedRegularizedPunches: async () => [],
    getBreakOverride: async (id) => ({ employee_id: id, special_break_override_minutes: null, attendance_required: 1 }),
    getApprovalStateByDate: async () => [],
    getDateShiftOverrides: async () => [],
    getWorkShiftWithSchedule: async (id) => ({ config: configFor(id), schedule: scheduleFor(id) }),
    getWorkShiftConfigVersions: async () => [],
    findPayrollLockedPeriods: async () => [],
    saveCalculationsWithReconciliation: async ({ employee_id, rows, ineligible_dates }) => {
      const id = Number(employee_id);
      const attempt = (state.writeAttempts.get(id) || 0) + 1;
      state.writeAttempts.set(id, attempt);
      state.inFlight += 1;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      if ((state.inFlightByEmployee.get(id) || 0) > 0) state.overlapSameEmployee = true;
      state.inFlightByEmployee.set(id, (state.inFlightByEmployee.get(id) || 0) + 1);
      try {
        await sleep(writeDelay[id] === undefined ? 5 : writeDelay[id]);
        if (onWrite) onWrite(id, attempt);
        rows.forEach((row) => state.stored.set(`${id}|${row.attendance_date}`, row));
        ineligible_dates.forEach((date) => state.stored.delete(`${id}|${date}`));
        return { written: rows.length, stale_removed: 0 };
      } finally {
        state.inFlight -= 1;
        state.inFlightByEmployee.set(id, state.inFlightByEmployee.get(id) - 1);
      }
    },
    insertRecalculationRun: async (run) => {
      state.runs.push(run);
      return state.runs.length;
    },
    finishRecalculationRun: async () => {},
  };
  const redrive = {
    redriveUndated: async (filter) => {
      state.redriveCalls.push({ ids: [...filter.employeeIds], from: filter.from, to: filter.to });
      if (redriveFails) throw new Error("redrive down");
      // Only the batch (more than one employee) comes back full.
      return { scanned: filter.employeeIds.length > 1 ? redriveScanned : 0, redrived: 0 };
    },
  };
  return { state, repo, redrive };
}

function usecaseOver(w, options = {}) {
  const usecase = buildCalculation(w.repo, { now: NOW, ...options });
  usecase.setPunchRedriveService(w.redrive);
  return usecase;
}

const bulk = (usecase) => usecase.recalculateBulk({ from_date: FROM, to_date: TO, store_id: 1, now: NOW, actor_employee_id: 9 });

// What a run reports, without the parts that are allowed to differ.
const comparable = (result) => ({ ...result, run_id: null });

afterEach(() => {
  delete process.env.ATTENDANCE_BULK_CONCURRENCY;
});

describe("bulk recalculation: the punch re-derive is batched", () => {
  it("runs ONCE for every eligible employee of the run, not once per employee, and over the same window", async () => {
    const w = fakeWorld({ employees: [3, 1, 2], employment: { 2: { attendance_required: 0 } } });
    const result = await bulk(usecaseOver(w, { bulk_concurrency: 1 }));

    assert.equal(result.status, "COMPLETED");
    // One call. The window is one day wider at each end, exactly as the
    // per-employee re-derive always was. Employee 2 is exempt: never re-derived.
    assert.deepEqual(w.state.redriveCalls, [{ ids: [1, 3], from: "2026-07-31", to: "2026-08-06" }]);
  });

  it("groups employees by their own eligible window: somebody who joined mid-range is re-derived over their window only", async () => {
    const joined = { date_of_joining: "2026-08-03" };
    const w = fakeWorld({ employees: [1, 2], employment: { 2: joined } });
    await bulk(usecaseOver(w, { bulk_concurrency: 1 }));

    const calls = [...w.state.redriveCalls].sort((a, b) => a.from.localeCompare(b.from));
    assert.deepEqual(calls, [
      { ids: [1], from: "2026-07-31", to: "2026-08-06" },
      { ids: [2], from: "2026-08-02", to: "2026-08-06" },
    ]);
  });

  it("falls back to the per-employee re-derive when the employment facts changed after the run read them", async () => {
    // The run's candidate row says 2020; by the time the employee is
    // recalculated the employment row says 3 August. The batch covered the
    // wrong window, so recalculateRange re-derives its own - as it always did.
    const w = fakeWorld({ employees: [1], employment: { 1: { date_of_joining: "2026-08-03" } }, candidates: { 1: { date_of_joining: "2020-01-01" } } });
    await bulk(usecaseOver(w, { bulk_concurrency: 1 }));

    assert.deepEqual(w.state.redriveCalls, [
      { ids: [1], from: "2026-07-31", to: "2026-08-06" },
      { ids: [1], from: "2026-08-02", to: "2026-08-06" },
    ]);
  });

  it("a batch re-derive that FAILS is retried per employee, and never fails the recalculation", async () => {
    const w = fakeWorld({ employees: [1, 2], redriveFails: true });
    const result = await bulk(usecaseOver(w, { bulk_concurrency: 1 }));

    assert.equal(result.status, "COMPLETED");
    assert.equal(result.employees_completed, 2);
    assert.equal(w.state.redriveCalls.length, 3, "one batch attempt, then one per employee");
  });

  it("a batch that hit the re-derive's row cap is not trusted: its employees re-derive individually", async () => {
    const w = fakeWorld({ employees: [1, 2], redriveScanned: 50000 });
    const result = await bulk(usecaseOver(w, { bulk_concurrency: 1 }));

    assert.equal(result.status, "COMPLETED");
    assert.deepEqual(
      w.state.redriveCalls.map((c) => c.ids),
      [[1, 2], [1], [2]]
    );
  });

  it("the single-employee Recalculate still re-derives its own punches", async () => {
    const w = fakeWorld({ employees: [7] });
    await usecaseOver(w).recalculateRange({ employee_id: 7, from_date: FROM, to_date: TO, now: NOW });
    assert.deepEqual(w.state.redriveCalls, [{ ids: [7], from: "2026-07-31", to: "2026-08-06" }]);
  });
});

describe("bulk recalculation: bounded concurrency", () => {
  const EMPLOYEES = [1, 2, 3, 4, 5, 6, 7, 8];

  it("stores exactly the same rows and reports exactly the same summary at every width", async () => {
    const outcomes = [];
    for (const width of [1, 2, 3]) {
      const w = fakeWorld({ employees: EMPLOYEES });
      // eslint-disable-next-line no-await-in-loop
      const result = await bulk(usecaseOver(w, { bulk_concurrency: width }));
      outcomes.push({ width, result: comparable(result), stored: [...w.state.stored.entries()].sort() });
    }
    assert.equal(outcomes[0].stored.length, EMPLOYEES.length * 5);
    for (const o of outcomes.slice(1)) {
      assert.deepEqual(o.stored, outcomes[0].stored, `width ${o.width} stored different rows`);
      assert.deepEqual(o.result, outcomes[0].result, `width ${o.width} reported a different summary`);
    }
  });

  it("never has more employees in flight than the configured width", async () => {
    for (const width of [1, 2, 3]) {
      const w = fakeWorld({ employees: EMPLOYEES });
      // eslint-disable-next-line no-await-in-loop
      await bulk(usecaseOver(w, { bulk_concurrency: width }));
      assert.equal(w.state.maxInFlight, width, `width ${width}`);
    }
  });

  it("is clamped to 3 whatever the environment asks for, and to 1 at the bottom", async () => {
    process.env.ATTENDANCE_BULK_CONCURRENCY = "10";
    const wide = fakeWorld({ employees: EMPLOYEES });
    await bulk(usecaseOver(wide));
    assert.equal(wide.state.maxInFlight, 3);

    process.env.ATTENDANCE_BULK_CONCURRENCY = "0";
    const narrow = fakeWorld({ employees: EMPLOYEES });
    await bulk(usecaseOver(narrow));
    assert.equal(narrow.state.maxInFlight, 1);
  });

  it("defaults to ONE employee at a time - sequential, as before - when nothing is configured", async () => {
    const w = fakeWorld({ employees: EMPLOYEES });
    await bulk(usecaseOver(w));
    assert.equal(w.state.maxInFlight, 1);
  });

  it("lists failures in candidate order even when a later employee fails first", async () => {
    const w = fakeWorld({
      employees: [1, 2, 3],
      writeDelay: { 1: 30, 2: 1, 3: 1 },
      onWrite: (id) => {
        if (id !== 2) throw new Error(`boom ${id}`);
      },
    });
    const result = await bulk(usecaseOver(w, { bulk_concurrency: 3 }));

    assert.equal(result.status, "COMPLETED_WITH_ERRORS");
    assert.deepEqual(result.errors.map((e) => e.employee_id), [1, 3]);
    assert.equal(result.employees_completed, 1);
  });
});

describe("bulk recalculation: locking is untouched", () => {
  it("a deadlock victim is retried once, for that employee alone, and then succeeds", async () => {
    const w = fakeWorld({
      employees: [1, 2],
      onWrite: (id, attempt) => {
        if (id === 1 && attempt === 1) {
          const err = new Error("ER_LOCK_DEADLOCK: Deadlock found when trying to get lock");
          err.code = "ER_LOCK_DEADLOCK";
          err.errno = 1213;
          throw err;
        }
      },
    });
    const result = await bulk(usecaseOver(w, { bulk_concurrency: 2 }));

    assert.equal(result.status, "COMPLETED");
    assert.equal(w.state.writeAttempts.get(1), 2);
    assert.equal(w.state.writeAttempts.get(2), 1);
  });

  it("a second deadlock is reported, not retried again", async () => {
    const w = fakeWorld({
      employees: [1],
      onWrite: () => {
        const err = new Error("deadlock");
        err.code = "ER_LOCK_DEADLOCK";
        throw err;
      },
    });
    const result = await bulk(usecaseOver(w, { bulk_concurrency: 2 }));

    assert.equal(result.status, "FAILED");
    assert.equal(w.state.writeAttempts.get(1), 2);
    assert.equal(result.errors[0].code, "ER_LOCK_DEADLOCK");
  });

  it("a PAYROLL-LOCKED refusal is never retried and is reported with its code, as before", async () => {
    const w = fakeWorld({
      employees: [1, 2],
      onWrite: (id) => {
        if (id === 1) throw payrollLockedError([{ employee_id: 1, year: 2026, month: 8 }]);
      },
    });
    const result = await bulk(usecaseOver(w, { bulk_concurrency: 3 }));

    assert.equal(w.state.writeAttempts.get(1), 1);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].employee_id, 1);
    assert.equal(result.errors[0].code, "PAYROLL_MONTH_LOCKED");
    assert.equal(w.state.stored.has("1|2026-08-01"), false, "nothing written for the locked employee");
    assert.equal(w.state.stored.has("2|2026-08-01"), true);
  });
});

describe("shift-rule propagation (the queue worker): batched and bounded", () => {
  const facts = (ids) =>
    ids.map((id) => ({
      employee_id: id,
      employee: { employee_id: id, attendance_required: 1, date_of_joining: "2020-01-01", resignation_date: null },
      assignments: [{ employee_work_shift_assignment_id: id, work_shift_id: SHIFT, effective_from: "2026-09-01", source: "TEST" }],
      override_dates: [],
      locked_months: [],
      locked_at: {},
    }));

  it("keeps one employee's months strictly in order while employees run side by side, and re-derives once per month window", async () => {
    const w = fakeWorld({ employees: [1, 2, 3], writeDelay: { 1: 8, 2: 8, 3: 8 } });
    w.repo.listShiftPropagationFacts = async () => facts([1, 2, 3]);
    const usecase = usecaseOver(w, { bulk_concurrency: 3 });

    const result = await usecase.recalculateForShiftConfigChange({
      work_shift_id: SHIFT,
      // Past the v2 cutover (1 September): September whole, October so far.
      today: "2026-10-04",
      now: Date.parse("2026-10-04T12:00:00+05:30"),
    });

    assert.equal(result.status, "COMPLETED");
    assert.equal(result.employee_months_recalculated, 6, "three employees x September and October");
    assert.equal(w.state.overlapSameEmployee, false, "two months of one employee were written at the same time");
    assert.ok(w.state.maxInFlight > 1, "employees did run side by side");
    // One re-derive per distinct month window, each naming all three employees.
    assert.equal(w.state.redriveCalls.length, 2);
    w.state.redriveCalls.forEach((call) => assert.deepEqual(call.ids, [1, 2, 3]));
  });
});

describe("bulk recalculation timing", () => {
  it("passes the recalculation's result and error through untouched, and logs one line per employee", async () => {
    const lines = [];
    const original = logger.Log;
    const previous = process.env.ATTENDANCE_RECALC_TIMING_LOG;
    logger.Log = (entry) => lines.push(entry);
    process.env.ATTENDANCE_RECALC_TIMING_LOG = "1";
    try {
      const value = await recalcTiming.timeEmployee(
        { run_id: 4, source: "MANUAL", employee_id: 12, from: FROM, to: TO, queued_at: "q", claimed_at: "c" },
        async () => ({ written: 31 })
      );
      assert.deepEqual(value, { written: 31 });

      const boom = Object.assign(new Error("locked"), { code: "PAYROLL_MONTH_LOCKED" });
      await assert.rejects(
        recalcTiming.timeEmployee({ run_id: 4, source: "MANUAL", employee_id: 13, from: FROM, to: TO }, async () => {
          throw boom;
        }),
        (err) => err === boom
      );
    } finally {
      logger.Log = original;
      if (previous === undefined) delete process.env.ATTENDANCE_RECALC_TIMING_LOG;
      else process.env.ATTENDANCE_RECALC_TIMING_LOG = previous;
    }

    assert.equal(lines.length, 2);
    const [ok, failed] = lines.map((l) => l.ref);
    for (const key of [
      "queued_at", "claimed_at", "started_at", "data_load_ms", "calculation_ms",
      "write_ms", "total_ms", "pool_wait_ms", "query_count",
    ]) {
      assert.ok(key in ok, `missing ${key}`);
    }
    assert.equal(ok.employee_id, 12);
    assert.equal(ok.days_written, 31);
    assert.equal(ok.outcome, "ok");
    assert.equal(failed.outcome, "PAYROLL_MONTH_LOCKED");
    assert.match(lines[0].description, /^run=4 src=MANUAL emp=12 /);
  });
});
