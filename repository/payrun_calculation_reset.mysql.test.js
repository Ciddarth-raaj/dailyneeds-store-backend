/**
 * RESET CALCULATION, END TO END, AS REAL SQL.
 *
 *   ATTENDANCE_TEST_MYSQL=mysql://user:pass@localhost/scratch_db \
 *     node --test repository/payrun_calculation_reset.mysql.test.js
 *
 * SKIPPED unless `ATTENDANCE_TEST_MYSQL` names a SCRATCH database: the suite
 * creates its tables, fills them and drops them again, and reads no table it
 * did not create.
 *
 * WHAT IS REAL. Every payrun table - the period, the snapshot, the adjustments,
 * the calculation, its audit log and the new reset audit - is built by running
 * the MIGRATION FILES THEMSELVES, foreign keys and CHECK constraints included.
 * The usecase and all three repositories are the production modules over a
 * production-shaped (no `dateStrings`) pool: Calculate, Reset and Recalculate
 * below are the same code the HTTP routes call.
 *
 * WHAT IS A STAND-IN. The source tables a calculation reads - the employee
 * master, the Salary Master, attendance, punches, requests, permissions, bank
 * verification - carry the production names and the columns those reads use.
 * They exist here to be FINGERPRINTED: every one is hashed before a reset and
 * after it, and must be byte-for-byte identical.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const URL = process.env.ATTENDANCE_TEST_MYSQL;
const buildCalculationRepo = require("./payrun_calculation");
const buildPayrunRepo = require("./payrun");
const buildAdjustmentRepo = require("./payrun_adjustment");
const buildCalculation = require("../usecase/payrun_calculation");
const { dayRowsSql, dayRowsFingerprint } = require("../utils/attendance_month_freshness");

const {
  SQLS, MIGRATIONS, RESET_DOWN, TABLES, SOURCES, PAYRUN_INPUTS, STAND_INS,
} = require("../test_support/payrun_mysql_fixture");

const YEAR = 2026;
const MONTH = 8;
const STORE = 1;
const OTHER_STORE = 2;
const ACTOR = { employeeId: 77 };
const A = 11;   // reset individually, then recalculated
const B = 12;   // reset in bulk
const LOCKED = 13;
const RACE = 14;
const ELSEWHERE = 21; // another outlet
const ALL = [A, B, LOCKED, RACE, ELSEWHERE];

const q = (pool, sql, params = []) =>
  new Promise((resolve, reject) =>
    pool.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)))
  );

/** A table's whole content, ordered, as one string: equal means untouched. */
async function fingerprint(pool, table) {
  const rows = await q(pool, `SELECT * FROM \`${table}\``);
  return JSON.stringify(
    rows
      .map((r) => JSON.stringify(r))
      .sort()
  );
}
async function fingerprints(pool, tables) {
  const out = {};
  for (const t of tables) out[t] = await fingerprint(pool, t);
  return out;
}
const calcRow = async (pool, employeeId) =>
  (await q(
    pool,
    "SELECT * FROM payrun_employee_calculation WHERE period_year = ? AND period_month = ? AND employee_id = ?",
    [YEAR, MONTH, employeeId]
  ))[0] || null;

describe("Reset Calculation over real SQL", { skip: !URL && "ATTENDANCE_TEST_MYSQL is not set" }, () => {
  let pool;
  let usecase;
  let repo;
  const statusOf = async (employeeId) =>
    (await usecase.getMonth({ year: YEAR, month: MONTH })).rows.find(
      (r) => r.employee_id === employeeId
    ).status;

  before(async () => {
    pool = require("mysql").createPool(`${URL}?connectionLimit=6&multipleStatements=true`);
    await q(pool, "SET FOREIGN_KEY_CHECKS = 0");
    for (const t of TABLES) await q(pool, `DROP TABLE IF EXISTS \`${t}\``);
    await q(pool, "SET FOREIGN_KEY_CHECKS = 1");
    for (const ddl of STAND_INS) await q(pool, ddl);
    for (const file of MIGRATIONS) await q(pool, fs.readFileSync(path.join(SQLS, file), "utf8"));

    for (const id of ALL) {
      const store = id === ELSEWHERE ? OTHER_STORE : STORE;
      await q(pool, "INSERT INTO new_employee VALUES (?, ?, ?, 1, 1, 0, '1990-06-15', '2018-04-01', NULL, '100200300400', '3100000000', 1, NULL, NULL, NULL, NULL)", [
        id, `Employee ${id}`, store,
      ]);
      // Salary Master: the approved record in force, plus history and a pending revision.
      await q(pool, "INSERT INTO employee_salary (employee_id, monthly_gross, daily_salary, basic, conveyance, hra, special_allowance, effective_from, status) VALUES (?, 20000, 769.23, 10000, 2500, 4000, 3500, '2025-04-01', 'APPROVED')", [id]);
      const [{ insertId: salaryId }] = [await q(pool, "INSERT INTO employee_salary (employee_id, monthly_gross, daily_salary, basic, conveyance, hra, special_allowance, effective_from, status) VALUES (?, 26000, 1000, 13000, 2500, 5000, 5500, '2026-04-01', 'APPROVED')", [id])];
      await q(pool, "INSERT INTO employee_salary (employee_id, monthly_gross, daily_salary, basic, conveyance, hra, special_allowance, effective_from, status) VALUES (?, 30000, 1153.85, 15000, 2500, 6000, 6500, '2026-10-01', 'PENDING')", [id]);

      await q(pool, `INSERT INTO attendance_monthly_payroll
        (employee_id, period_year, period_month, is_final, payroll_version, salary_days, extra_days, base_days,
         monthly_gross, daily_rate, salary_day_earnings, extra_day_earnings, shortage_minutes, missing_minute_deduction,
         approved_ot_minutes, approved_ot_earnings, calculated_at)
        VALUES (?, ?, ?, 1, 1, 26, 0, 26, 26000, 1000, 26000, 0, 0, 0, 120, 250, '2026-09-01 02:00:00.000')`, [id, YEAR, MONTH]);
      // Every date of August stored and settled: 26 worked, 5 absent.
      for (let d = 1; d <= 31; d += 1) {
        await q(pool, `INSERT INTO attendance_day_calculation
            (employee_id, attendance_date, nrm_minutes, break_allowance_source, is_final, approved_ot_minutes,
             status, attendance_day_count, base_nrm_minutes, worked_minutes)
          VALUES (?, ?, 480, 'SHIFT', 1, ?, ?, ?, 480, ?)`, [
          id, `2026-08-${String(d).padStart(2, "0")}`, d === 5 ? 120 : 0,
          d <= 26 ? "FINAL" : "ABSENT", d <= 26 ? 1 : 0, d <= 26 ? 480 : 0,
        ]);
      }
      // The summary's fingerprint, taken the way the month persist takes it.
      const stored = await q(pool, dayRowsSql(), [id, "2026-08-01", "2026-08-31"]);
      await q(pool, "UPDATE attendance_monthly_payroll SET day_rows_fingerprint = ? WHERE employee_id = ?", [
        dayRowsFingerprint(stored), id,
      ]);
      // Decided OT and regularisation requests - not pending, so they do not block.
      await q(pool, "INSERT INTO attendance_approval_request (request_type, requested_for_employee_id, attendance_date, status, approved_ot_minutes) VALUES ('OT', ?, '2026-08-05', 'APPROVED', 120), ('REGULARIZATION', ?, '2026-08-07', 'APPROVED', NULL), ('OT', ?, '2026-08-09', 'REJECTED', NULL)", [id, id, id]);
      await q(pool, "INSERT INTO attendance_permission (employee_id, attendance_date, minutes, status) VALUES (?, '2026-08-11', 60, 'APPROVED')", [id]);
      await q(pool, "INSERT INTO biomax_punch (employee_id, punch_time) VALUES (?, '2026-08-05 09:00:00'), (?, '2026-08-05 20:00:00')", [id, id]);
      await q(pool, "INSERT INTO employee_bank_verification (employee_id, account_last4, status) VALUES (?, '4321', 'VERIFIED')", [id]);

      // The initialized snapshot, as initialization writes it.
      await q(pool, `INSERT INTO payrun_employee
        (period_year, period_month, employee_id, employee_name, store_id, store_name, date_of_joining,
         salary_id, salary_effective_from, monthly_gross, daily_salary, basic, conveyance, hra, special_allowance,
         pf_applicable, esi_applicable, uan, esi_number, pay_type, pay_type_source)
        VALUES (?, ?, ?, ?, ?, ?, '2018-04-01', ?, '2026-04-01', 26000, 1000, 13000, 2500, 5000, 5500,
                1, 1, '100200300400', '3100000000', 'BANK', 'EMPLOYEE_MASTER')`,
        [YEAR, MONTH, id, `Employee ${id}`, store, store === STORE ? "Moolakulam" : "ECR", salaryId.insertId]);
    }
    const peIds = await q(pool, "SELECT employee_id, payrun_employee_id FROM payrun_employee");
    for (const { employee_id: id, payrun_employee_id: pe } of peIds) {
      if (id === A) {
        // A has an incentive; the reset must keep it.
        await q(pool, "INSERT INTO payrun_employee_adjustment (payrun_employee_id, period_year, period_month, employee_id, component, amount, created_by) VALUES (?, ?, ?, ?, 'INCENTIVE', 500, 9)", [pe, YEAR, MONTH, id]);
        await q(pool, "INSERT INTO payrun_employee_adjustment_audit (payrun_employee_id, period_year, period_month, employee_id, action, component, new_amount, changed_by) VALUES (?, ?, ?, ?, 'SET_AMOUNT', 'INCENTIVE', 500, 9)", [pe, YEAR, MONTH, id]);
      } else {
        await q(pool, "INSERT INTO payrun_employee_adjustment_state (payrun_employee_id, period_year, period_month, employee_id, confirmed_no_adjustment, confirmed_by) VALUES (?, ?, ?, ?, 1, 9)", [pe, YEAR, MONTH, id]);
      }
    }

    repo = buildCalculationRepo(pool);
    usecase = buildCalculation(repo, buildPayrunRepo(pool), buildAdjustmentRepo(pool));

    const first = await usecase.calculate({ year: YEAR, month: MONTH, all_eligible: true, actor: ACTOR });
    assert.equal(first.calculated_count, ALL.length, JSON.stringify(first.results));
    // Approve & Lock LOCKED exactly as `repository/payrun_calculation.js#approve` writes it.
    await q(pool, "UPDATE payrun_employee_calculation SET status = 'APPROVED_LOCKED', approved_by = 5, approved_at = NOW(), locked_by = 5, locked_at = NOW() WHERE employee_id = ?", [LOCKED]);
  });

  after(async () => {
    if (!pool) return;
    await q(pool, "SET FOREIGN_KEY_CHECKS = 0");
    for (const t of TABLES) await q(pool, `DROP TABLE IF EXISTS \`${t}\``);
    await q(pool, "SET FOREIGN_KEY_CHECKS = 1");
    pool.end();
  });

  it("the starting point: everybody calculated, LOCKED approved", async () => {
    assert.equal(await statusOf(A), "READY_FOR_APPROVAL");
    assert.equal(await statusOf(B), "READY_FOR_APPROVAL");
    assert.equal(await statusOf(LOCKED), "APPROVED_LOCKED");
  });

  it("an individual reset removes ONLY that employee's calculation and changes no source, input or other payroll", async () => {
    const sources = await fingerprints(pool, SOURCES);
    const inputs = await fingerprints(pool, PAYRUN_INPUTS);
    const others = {};
    for (const id of ALL.filter((x) => x !== A)) others[id] = JSON.stringify(await calcRow(pool, id));
    const removed = await calcRow(pool, A);
    assert.ok(removed);

    const result = await usecase.reset({
      year: YEAR, month: MONTH, employee_ids: [A],
      reason: "ATTENDANCE_CORRECTED", mode: "INDIVIDUAL", actor: ACTOR,
    });
    assert.equal(result.reset_count, 1, JSON.stringify(result));

    // Returned to Not Calculated: there is no row, and the screen says so.
    assert.equal(await calcRow(pool, A), null);
    assert.equal(await statusOf(A), "NOT_CALCULATED");

    // Attendance, punches, OT/regularisation, permissions, Salary Master,
    // Employee Master (statutory flags) and bank data: identical.
    assert.deepEqual(await fingerprints(pool, SOURCES), sources);
    // The snapshot, pay type, adjustments, confirmation, period and the
    // calculation history: identical.
    assert.deepEqual(await fingerprints(pool, PAYRUN_INPUTS), inputs);
    // Every other employee's payroll, byte for byte.
    for (const id of Object.keys(others)) {
      assert.equal(JSON.stringify(await calcRow(pool, Number(id))), others[id], `employee ${id} moved`);
    }

    // And the audit row says exactly what happened.
    const [audit] = await q(pool, "SELECT * FROM payrun_employee_calculation_reset_audit");
    assert.equal(audit.employee_id, A);
    assert.equal(audit.period_year, YEAR);
    assert.equal(audit.period_month, MONTH);
    assert.equal(Number(audit.payrun_employee_id), Number(removed.payrun_employee_id));
    assert.equal(Number(audit.payrun_calculation_id), Number(removed.payrun_calculation_id));
    assert.equal(audit.previous_status, "READY_FOR_APPROVAL");
    assert.equal(audit.previous_stored_status, "CALCULATED");
    assert.equal(audit.reset_reason, "ATTENDANCE_CORRECTED");
    assert.equal(audit.reset_remark, null);
    assert.equal(audit.reset_mode, "INDIVIDUAL");
    assert.equal(audit.reset_by, ACTOR.employeeId);
    assert.ok(audit.reset_at instanceof Date && !Number.isNaN(audit.reset_at.getTime()));
    assert.equal(audit.net_pay, removed.net_pay);
    assert.equal(audit.calculation_hash, removed.calculation_hash);
    const snapshot = typeof audit.calculation_snapshot === "string"
      ? JSON.parse(audit.calculation_snapshot)
      : audit.calculation_snapshot;
    assert.equal(snapshot.net_pay, removed.net_pay);
    assert.equal(snapshot.salary_effective_from, "2026-04-01", "dates are kept as the screen shows them");
    assert.equal(Number(snapshot.incentive), 500);
  });

  it("an Approved & Locked employee cannot be reset - by the usecase or by the repository directly", async () => {
    const before = JSON.stringify(await calcRow(pool, LOCKED));
    const result = await usecase.reset({
      year: YEAR, month: MONTH, employee_ids: [LOCKED],
      reason: "WRONG_OT", mode: "INDIVIDUAL", actor: ACTOR,
    });
    assert.equal(result.locked_count, 1);
    assert.match(result.results[0].message, /Approved & Locked/);

    // Skipping every usecase check: the row lock and the CALCULATED-only
    // predicate still refuse it.
    const direct = await repo.resetCalculation({
      year: YEAR, month: MONTH, employee_id: LOCKED, previous_status: "READY_FOR_APPROVAL",
      reason: "WRONG_OT", mode: "INDIVIDUAL", reset_by: 77,
    });
    assert.equal(direct.outcome, "LOCKED");
    assert.equal(JSON.stringify(await calcRow(pool, LOCKED)), before);
    const audits = await q(pool, "SELECT COUNT(*) AS n FROM payrun_employee_calculation_reset_audit WHERE employee_id = ?", [LOCKED]);
    assert.equal(audits[0].n, 0);
  });

  it("bulk, mixed: resets the eligible, skips locked / not-calculated / other-outlet, in the caller's scope", async () => {
    const elsewhere = JSON.stringify(await calcRow(pool, ELSEWHERE));
    const sources = await fingerprints(pool, SOURCES);

    const result = await usecase.reset({
      year: YEAR, month: MONTH, employee_ids: [B, LOCKED, A, ELSEWHERE],
      reason: "OTHER", remark: "Shift master corrected", mode: "BULK",
      store_ids: [STORE], actor: ACTOR,
    });
    assert.deepEqual(
      result.results.map((r) => [r.employee_id, r.result]),
      [[B, "RESET"], [LOCKED, "LOCKED"], [A, "SKIPPED"], [ELSEWHERE, "NOT_IN_SCOPE"]]
    );
    assert.equal(result.reset_count, 1);
    assert.equal(await calcRow(pool, B), null);
    assert.ok(await calcRow(pool, LOCKED));
    assert.equal(JSON.stringify(await calcRow(pool, ELSEWHERE)), elsewhere, "another outlet's payroll moved");
    assert.deepEqual(await fingerprints(pool, SOURCES), sources);

    const [audit] = await q(pool, "SELECT * FROM payrun_employee_calculation_reset_audit WHERE employee_id = ?", [B]);
    assert.equal(audit.reset_mode, "BULK");
    assert.equal(audit.reset_reason, "OTHER");
    assert.equal(audit.reset_remark, "Shift master corrected");
  });

  it("a reset in another month touches nothing in this one", async () => {
    const before = JSON.stringify(await calcRow(pool, RACE));
    const result = await usecase.reset({
      year: YEAR, month: 9, employee_ids: [RACE],
      reason: "WRONG_OT", mode: "INDIVIDUAL", actor: ACTOR,
    });
    assert.equal(result.not_in_scope_count, 1, "nobody is initialized for September");
    assert.equal(JSON.stringify(await calcRow(pool, RACE)), before);

    // And the repository, called for the wrong month directly, finds nothing.
    const direct = await repo.resetCalculation({
      year: YEAR, month: 9, employee_id: RACE, previous_status: "CALCULATED",
      reason: "WRONG_OT", mode: "INDIVIDUAL", reset_by: 77,
    });
    assert.equal(direct.outcome, "NOT_CALCULATED");
    assert.equal(JSON.stringify(await calcRow(pool, RACE)), before);
  });

  it("is atomic per employee: a failure mid-transaction leaves the row and writes no audit", async () => {
    const before = JSON.stringify(await calcRow(pool, RACE));
    const count = async () =>
      (await q(pool, "SELECT COUNT(*) AS n FROM payrun_employee_calculation_reset_audit"))[0].n;
    const audits = await count();
    // A reason the audit's ENUM refuses makes the INSERT fail after the row lock.
    await assert.rejects(() =>
      repo.resetCalculation({
        year: YEAR, month: MONTH, employee_id: RACE, previous_status: "READY_FOR_APPROVAL",
        reason: "NOT_A_REASON", mode: "INDIVIDUAL", reset_by: 77,
      })
    );
    assert.equal(JSON.stringify(await calcRow(pool, RACE)), before);
    assert.equal(await count(), audits);
  });

  it("the audit table itself refuses OTHER without a remark", async () => {
    const pe = (await q(pool, "SELECT payrun_employee_id FROM payrun_employee WHERE employee_id = ?", [RACE]))[0].payrun_employee_id;
    await assert.rejects(
      () => q(pool, `INSERT INTO payrun_employee_calculation_reset_audit
        (payrun_employee_id, period_year, period_month, employee_id, payrun_calculation_id,
         previous_status, previous_stored_status, reset_reason, reset_remark, reset_mode, calculation_snapshot)
        VALUES (?, 2026, 8, ?, 1, 'CALCULATED', 'CALCULATED', 'OTHER', '  ', 'INDIVIDUAL', '{}')`, [pe, RACE]),
      /chk_payrun_calc_reset_other_remark/
    );
  });

  it("an approval that holds the row lock wins the race, and the reset waits then refuses", async () => {
    const conn = await new Promise((r, j) => pool.getConnection((e, c) => (e ? j(e) : r(c))));
    await q(conn, "START TRANSACTION");
    await q(conn, "SELECT payrun_calculation_id FROM payrun_employee_calculation WHERE period_year = ? AND period_month = ? AND employee_id = ? FOR UPDATE", [YEAR, MONTH, RACE]);
    await q(conn, "UPDATE payrun_employee_calculation SET status = 'APPROVED_LOCKED', approved_by = 5, approved_at = NOW(), locked_by = 5, locked_at = NOW() WHERE employee_id = ? AND status = 'CALCULATED'", [RACE]);

    let settled = false;
    const pending = usecase
      .reset({ year: YEAR, month: MONTH, employee_ids: [RACE], reason: "WRONG_OT", mode: "INDIVIDUAL", actor: ACTOR })
      .finally(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(settled, false, "the reset must wait on the approval's row lock");

    await q(conn, "COMMIT");
    conn.release();
    const result = await pending;
    assert.equal(result.results[0].result, "LOCKED");
    assert.equal((await calcRow(pool, RACE)).status, "APPROVED_LOCKED");
  });

  it("a finalized (locked) payroll month refuses every reset", async () => {
    await q(pool, "INSERT INTO payrun_period (period_year, period_month, status, locked_by, locked_at) VALUES (?, ?, 'LOCKED', 5, NOW())", [YEAR, MONTH]);
    try {
      const result = await usecase.reset({
        year: YEAR, month: MONTH, employee_ids: [ELSEWHERE],
        reason: "WRONG_OT", mode: "INDIVIDUAL", actor: ACTOR,
      });
      assert.equal(result.locked_count, 1);
      assert.match(result.results[0].message, /month 2026-08 is locked/);
      // And the repository re-reads the month lock inside its transaction.
      const direct = await repo.resetCalculation({
        year: YEAR, month: MONTH, employee_id: ELSEWHERE, previous_status: "READY_FOR_APPROVAL",
        reason: "WRONG_OT", mode: "INDIVIDUAL", reset_by: 77,
      });
      assert.equal(direct.outcome, "MONTH_LOCKED");
      assert.ok(await calcRow(pool, ELSEWHERE));
    } finally {
      await q(pool, "DELETE FROM payrun_period WHERE period_year = ? AND period_month = ?", [YEAR, MONTH]);
    }
  });

  it("recalculating after a reset produces a FRESH calculation from the current sources", async () => {
    // Attendance is corrected after the reset - one fewer salary day - which
    // is the whole reason somebody resets.
    await q(pool, "UPDATE attendance_monthly_payroll SET salary_days = 25, salary_day_earnings = 25000, payroll_version = 2, calculated_at = '2026-09-03 02:00:00.000' WHERE employee_id = ?", [B]);
    const historyBefore = await q(pool, "SELECT * FROM payrun_employee_calculation_audit WHERE employee_id = ? ORDER BY payrun_calculation_audit_id", [A]);

    const result = await usecase.calculate({ year: YEAR, month: MONTH, employee_ids: [A, B], actor: ACTOR });
    assert.equal(result.calculated_count, 2, JSON.stringify(result.results));

    const a = await calcRow(pool, A);
    const b = await calcRow(pool, B);
    assert.equal(a.calculation_revision, 1, "a fresh calculation, not a recalculation of the old one");
    assert.equal(Number(a.incentive), 500, "the incentive entered before the reset is applied again");
    assert.equal(b.salary_days, 25, "the corrected attendance is what was priced");
    assert.equal(b.attendance_payroll_version, 2);
    assert.equal(await statusOf(A), "READY_FOR_APPROVAL");
    assert.equal(await statusOf(B), "READY_FOR_APPROVAL");

    // The earlier history is still there, with a new CALCULATE after it.
    const historyAfter = await q(pool, "SELECT * FROM payrun_employee_calculation_audit WHERE employee_id = ? ORDER BY payrun_calculation_audit_id", [A]);
    assert.deepEqual(historyAfter.slice(0, historyBefore.length), historyBefore);
    assert.equal(historyAfter[historyAfter.length - 1].action, "CALCULATE");
  });

  it("the migration re-runs cleanly, and its down drops only its own table", async () => {
    await q(pool, fs.readFileSync(path.join(SQLS, "20261110120000-payrun-calculation-reset-up.sql"), "utf8"));
    const inputs = await fingerprints(pool, [...PAYRUN_INPUTS, "payrun_employee_calculation"]);
    await q(pool, fs.readFileSync(path.join(SQLS, RESET_DOWN), "utf8"));
    const left = await q(pool, "SHOW TABLES LIKE 'payrun_employee_calculation_reset_audit'");
    assert.equal(left.length, 0);
    assert.deepEqual(await fingerprints(pool, [...PAYRUN_INPUTS, "payrun_employee_calculation"]), inputs);
  });
});
