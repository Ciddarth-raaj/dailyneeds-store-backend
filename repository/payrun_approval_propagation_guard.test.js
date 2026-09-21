/**
 * PAYROLL MAY NOT SETTLE A MONTH THAT IS STILL OWED A SHIFT-RULE
 * RECALCULATION.
 *
 *   node --test repository/payrun_approval_propagation_guard.test.js
 *
 * THE RACE THIS CLOSES:
 *
 *   1  a Work Shift rule changes and commits, owing a QUEUED propagation
 *   2  the worker has not reached this employee's month yet
 *   3  Approve & Lock runs against the OLD stored attendance
 *   4  the month becomes APPROVED_LOCKED
 *   5  the worker arrives and is correctly refused by the payroll lock
 *   6  payroll is frozen forever on figures the rule change superseded
 *
 * Step 6 cannot be repaired afterwards - a locked month is settled by design -
 * so the approval has to refuse at step 3. The guard is inside the approval's
 * transaction, on the held row lock, beside the attendance-source
 * revalidation, and it is driven here against the statements `approve()`
 * actually issues, in order.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildRepo = require("./payrun_calculation");

const EMP = 42;
const OTHER_EMP = 43;
const YEAR = 2026;
const MONTH = 9;
const SHIFT = 5;
const OTHER_SHIFT = 6;

const STORED = {
  payrun_calculation_id: 900,
  payrun_employee_id: 500,
  employee_id: EMP,
  status: "CALCULATED",
  calculation_hash: "hash-of-the-figures",
  calculation_version: 1,
  calculation_revision: 3,
  source_hash: "source-hash",
  net_pay: "26000.00",
  attendance_monthly_payroll_id: 77,
  attendance_payroll_version: 2,
  attendance_calculated_at: "2026-09-01 10:00:00.000",
  approved_ot_minutes: 120,
  effective_nrm_minutes: 660,
  effective_nrm_source: "SHIFT",
  ot_groups: JSON.stringify([{ nrm_minutes: 660, nrm_source: "SHIFT", approved_ot_minutes: 120 }]),
};

const ATTENDANCE = {
  attendance_monthly_payroll_id: 77,
  employee_id: EMP,
  payroll_version: 2,
  calculated_at: "2026-09-01 10:00:00.000",
  approved_ot_minutes: 120,
};

const NRM = [
  {
    employee_id: EMP,
    nrm_minutes: 660,
    break_allowance_source: "SHIFT",
    day_count: 26,
    approved_ot_minutes: 120,
  },
];

/**
 * `runs` are the unresolved WORK_SHIFT_SAVE recalculations the database
 * holds; `assignments` and `overrides` are the employee's dated facts, which
 * is what decides whether any of those runs is about THIS employee's month.
 */
function fakePool({
  runs = [],
  assignments = [
    {
      employee_work_shift_assignment_id: 1,
      employee_id: EMP,
      work_shift_id: SHIFT,
      effective_from: "2026-09-01",
    },
  ],
  overrides = [],
  employment = {
    employee_id: EMP,
    attendance_required: 1,
    date_of_joining: "2020-01-01",
    resignation_date: null,
  },
} = {}) {
  const log = [];
  const connection = {
    query(sql, params, cb) {
      const text = String(sql).replace(/\s+/g, " ").trim();
      log.push({ sql: text, params });

      if (/FROM attendance_recalculation_run/i.test(text)) return cb(null, runs);
      if (/FROM new_employee/i.test(text)) return cb(null, employment ? [employment] : []);
      if (/FROM employee_work_shift_assignment/i.test(text)) return cb(null, assignments);
      if (/FROM attendance_date_shift_override/i.test(text)) return cb(null, overrides);
      if (/FROM payrun_employee_calculation/i.test(text)) return cb(null, [{ ...STORED }]);
      if (/FROM attendance_monthly_payroll/i.test(text)) return cb(null, [ATTENDANCE]);
      if (/FROM attendance_day_calculation/i.test(text)) return cb(null, NRM);
      cb(null, { affectedRows: 1, insertId: 1 });
    },
    beginTransaction: (cb) => { log.push({ sql: "BEGIN" }); cb(null); },
    commit: (cb) => { log.push({ sql: "COMMIT" }); cb(null); },
    rollback: (cb) => { log.push({ sql: "ROLLBACK" }); cb(); },
    release: () => { log.push({ sql: "RELEASE" }); },
  };
  return {
    log,
    getConnection: (cb) => cb(null, connection),
    query: (sql, params, cb) => connection.query(sql, params, cb),
  };
}

const approve = (pool) =>
  buildRepo(pool).approve({
    year: YEAR,
    month: MONTH,
    employees: [{ employee_id: EMP, calculation_hash: STORED.calculation_hash }],
    approved_by: 9,
  });

const run = (status, work_shift_id = SHIFT, id = 1) => ({
  attendance_recalculation_run_id: id,
  work_shift_id,
  status,
});

const locked = (log) => log.filter((e) => /^UPDATE payrun_employee_calculation SET status = 'APPROVED_LOCKED'/i.test(e.sql));
const indexOf = (log, needle) => log.findIndex((e) => e.sql.includes(needle));

describe("an unresolved propagation blocks Approve & Lock", () => {
  for (const status of ["QUEUED", "RUNNING", "FAILED", "COMPLETED_WITH_ERRORS"]) {
    it(`${status} blocks, and nothing is locked`, async () => {
      const pool = fakePool({ runs: [run(status)] });
      const [result] = await approve(pool);

      assert.equal(result.outcome, "RECALCULATION_PENDING");
      assert.deepEqual(result.pending_recalculations, [
        { run_id: 1, work_shift_id: SHIFT, status },
      ]);
      assert.equal(locked(pool.log).length, 0, "the month is not settled");
      assert.equal(
        indexOf(pool.log, "INSERT INTO payrun_employee_calculation_audit"),
        -1,
        "and no approval is recorded"
      );
    });
  }

  it("COMPLETED is clear: the recalculation reached this month", async () => {
    const pool = fakePool({ runs: [] }); // COMPLETED runs are not selected at all
    const [result] = await approve(pool);
    assert.equal(result.outcome, "APPROVED");
    assert.equal(locked(pool.log).length, 1);
  });

  it("an unresolved propagation for ANOTHER shift does not block this employee", async () => {
    const pool = fakePool({ runs: [run("QUEUED", OTHER_SHIFT)] });
    const [result] = await approve(pool);
    assert.equal(result.outcome, "APPROVED", "this employee was never on that shift");
  });

  it("COMPLETED_WITH_ERRORS on this employee's shift blocks; on another shift it does not", async () => {
    const mine = await approve(fakePool({ runs: [run("COMPLETED_WITH_ERRORS", SHIFT)] }));
    assert.equal(mine[0].outcome, "RECALCULATION_PENDING");

    const theirs = await approve(fakePool({ runs: [run("COMPLETED_WITH_ERRORS", OTHER_SHIFT)] }));
    assert.equal(theirs[0].outcome, "APPROVED");
  });

  it("a one-day override onto the edited shift is enough to block the month", async () => {
    const pool = fakePool({
      runs: [run("QUEUED", OTHER_SHIFT)],
      // Never assigned to shift 6, but one September date was moved onto it.
      overrides: [{ work_shift_id: OTHER_SHIFT, attendance_date: "2026-09-15" }],
    });
    const [result] = await approve(pool);
    assert.equal(result.outcome, "RECALCULATION_PENDING");
  });

  it("somebody who left before the month is not held up by it", async () => {
    const pool = fakePool({
      runs: [run("QUEUED")],
      employment: {
        employee_id: EMP,
        attendance_required: 1,
        date_of_joining: "2020-01-01",
        resignation_date: "2026-08-15",
      },
    });
    const [result] = await approve(pool);
    assert.equal(result.outcome, "APPROVED");
  });

  it("an employee exempt from attendance is not held up either", async () => {
    const pool = fakePool({
      runs: [run("QUEUED")],
      employment: {
        employee_id: EMP,
        attendance_required: 0,
        date_of_joining: "2020-01-01",
        resignation_date: null,
      },
    });
    const [result] = await approve(pool);
    assert.equal(result.outcome, "APPROVED");
  });
});

describe("where the guard sits, and what it costs", () => {
  it("runs INSIDE the transaction, after the row lock, before the status changes", async () => {
    const pool = fakePool({ runs: [run("QUEUED")] });
    await approve(pool);

    const begin = indexOf(pool.log, "BEGIN");
    const rowLock = indexOf(pool.log, "FOR UPDATE");
    const guard = indexOf(pool.log, "FROM attendance_recalculation_run");

    assert.ok(begin >= 0 && rowLock > begin, "the payrun row is locked inside the transaction");
    assert.ok(guard > rowLock, "and the guard asks afterwards, on that held lock");
    assert.equal(locked(pool.log).length, 0);
  });

  it("takes the unresolved runs FOR UPDATE, so a save committing now cannot slip past", async () => {
    const pool = fakePool({ runs: [] });
    await approve(pool);
    const guard = pool.log.find((e) => e.sql.includes("FROM attendance_recalculation_run"));
    assert.match(guard.sql, /FOR UPDATE/, "the scanned range is held until this transaction ends");
    assert.match(guard.sql, /trigger_source = 'WORK_SHIFT_SAVE'/);
    assert.match(guard.sql, /status IN \('QUEUED', 'RUNNING', 'FAILED', 'COMPLETED_WITH_ERRORS'\)/);
  });

  it("costs ONE read when nothing is unresolved - the normal case", async () => {
    const pool = fakePool({ runs: [] });
    await approve(pool);

    assert.equal(indexOf(pool.log, "FROM employee_work_shift_assignment"), -1);
    assert.equal(indexOf(pool.log, "FROM attendance_date_shift_override"), -1);
    assert.equal(
      pool.log.filter((e) => e.sql.includes("FROM attendance_recalculation_run")).length,
      1
    );
  });

  it("the existing attendance-source revalidation still runs and still refuses", async () => {
    // The guard is added BESIDE that check, never in place of it.
    const pool = fakePool({ runs: [] });
    await approve(pool);
    assert.ok(indexOf(pool.log, "FROM attendance_monthly_payroll") > indexOf(pool.log, "FOR UPDATE"));
    assert.ok(indexOf(pool.log, "FROM attendance_day_calculation") > indexOf(pool.log, "FOR UPDATE"));
  });
});
