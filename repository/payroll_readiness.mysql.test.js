/**
 * PAYROLL READINESS, BEFORE AND AFTER, AS REAL SQL.
 *
 *   ATTENDANCE_TEST_MYSQL=mysql://user:pass@localhost/scratch_db \
 *     node --test repository/payroll_readiness.mysql.test.js
 *
 * SKIPPED unless `ATTENDANCE_TEST_MYSQL` names a SCRATCH database.
 *
 * A September month with one employee per root cause found in production
 * (223 initialized / 149 Attendance Pending / "Calculate All Eligible (74)"
 * that then failed), run through the production usecase and repositories
 * twice: once as the code was before payroll readiness, once as it is now.
 *
 *   E1-E4   settled, current attendance                          (ready)
 *   E5      OT approved after the month was processed: days 84, summary 0
 *   E6      approved OT on a day with NRM 0
 *   E7      a regularization approved after the month was processed
 *   E8      a day still awaiting a regularization decision
 *   E9      the month processed mid-month: days 16-30 never stored
 *   E10     calculated under the previous rule on a non-final summary,
 *           whose pending day was settled afterwards  (the "149" case)
 *   E11     days stored, but the month never processed
 *
 * PROCESS ATTENDANCE IS EMULATED here by the month persist's STORAGE
 * contract (the summary recomputed from the stored days, missing closed days
 * filled, the fingerprint taken with the real `dayRowsSql`). The real engine
 * needs the punch, shift and approval schema, which is exercised by the
 * attendance suites; what this file proves is payroll's side.
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
const { SQLS, MIGRATIONS, TABLES, STAND_INS } = require("../test_support/payrun_mysql_fixture");

const YEAR = 2026;
const MONTH = 9;
const SEPT = Array.from({ length: 30 }, (_, i) => `2026-09-${String(i + 1).padStart(2, "0")}`);
const ACTOR = { employeeId: 77 };
const CLEAN = [1, 2, 3, 4];
const ALL = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

const q = (pool, sql, params = []) =>
  new Promise((resolve, reject) =>
    pool.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)))
  );

describe("payroll readiness before and after, over real SQL", { skip: !URL && "ATTENDANCE_TEST_MYSQL is not set" }, () => {
  let pool;
  let current;   // the code as it is now
  let previous;  // the code as it was: no day-row read, so no readiness
  const counts = {};

  const day = (id, date, over = {}) => ({
    status: "FINAL", is_final: 1, attendance_day_count: 1, nrm_minutes: 480, base_nrm_minutes: 480,
    worked_minutes: 480, approved_ot_minutes: 0, ...over, employee_id: id, attendance_date: date,
  });
  const storeDays = async (rows) => {
    for (const r of rows) {
      await q(pool, `INSERT INTO attendance_day_calculation
          (employee_id, attendance_date, nrm_minutes, break_allowance_source, is_final, approved_ot_minutes,
           status, attendance_day_count, base_nrm_minutes, worked_minutes)
        VALUES (?, ?, ?, 'SHIFT', ?, ?, ?, ?, ?, ?)`,
      [r.employee_id, r.attendance_date, r.nrm_minutes, r.is_final, r.approved_ot_minutes, r.status,
        r.attendance_day_count, r.base_nrm_minutes, r.worked_minutes]);
    }
  };
  /** A normal month: 26 worked days, 4 absences, all settled. */
  const normalMonth = (id, over = {}) =>
    SEPT.map((d, i) => day(id, d, i < 26 ? over[d] || {} : { status: "ABSENT", attendance_day_count: 0, worked_minutes: 0, ...(over[d] || {}) }));

  /**
   * THE MONTH PERSIST'S STORAGE CONTRACT: the summary recomputed from what is
   * stored, and the fingerprint taken by the real `dayRowsSql`. `fill` stores
   * the closed days that were never stored, as the engine would.
   */
  const persistMonth = async (id, { is_final = null, fill = false } = {}) => {
    if (fill) {
      const have = new Set((await q(pool, "SELECT DATE_FORMAT(attendance_date, '%Y-%m-%d') AS d FROM attendance_day_calculation WHERE employee_id = ?", [id])).map((r) => r.d));
      await storeDays(SEPT.filter((d) => !have.has(d)).map((d) => day(id, d, { status: "ABSENT", attendance_day_count: 0, worked_minutes: 0 })));
    }
    const stored = await q(pool, dayRowsSql(), [id, SEPT[0], SEPT[29]]);
    const final = stored.filter((d) => Number(d.is_final) === 1);
    const worked = final.filter((d) => Number(d.attendance_day_count) === 1).length;
    const ot = final.reduce((t, d) => t + Number(d.approved_ot_minutes || 0), 0);
    const finalFlag = is_final === null ? (final.length === stored.length ? 1 : 0) : is_final;
    await q(pool, `INSERT INTO attendance_monthly_payroll
        (employee_id, period_year, period_month, is_final, payroll_version, salary_days, extra_days, base_days,
         monthly_gross, daily_rate, salary_day_earnings, extra_day_earnings, shortage_minutes, missing_minute_deduction,
         approved_ot_minutes, approved_ot_earnings, calculated_at, day_rows_fingerprint)
       VALUES (?, ?, ?, ?, 1, ?, 0, 26, 26000, 1000, ?, 0, 0, 0, ?, 0, NOW(3), ?)
       ON DUPLICATE KEY UPDATE is_final = VALUES(is_final), payroll_version = payroll_version + 1,
         salary_days = VALUES(salary_days), salary_day_earnings = VALUES(salary_day_earnings),
         approved_ot_minutes = VALUES(approved_ot_minutes), calculated_at = NOW(3),
         day_rows_fingerprint = VALUES(day_rows_fingerprint)`,
    [id, YEAR, MONTH, finalFlag, Math.min(worked, 26), Math.min(worked, 26) * 1000, ot, dayRowsFingerprint(stored)]);
  };
  const processor = {
    calls: [],
    async calculateMonth({ employee_id, persist }) {
      assert.equal(persist, true);
      this.calls.push(employee_id);
      await persistMonth(employee_id, { fill: true });
    },
  };
  const monthView = (usecase) => usecase.getMonth({ year: YEAR, month: MONTH });
  const rowOf = async (usecase, id) => (await monthView(usecase)).rows.find((r) => r.employee_id === id);

  before(async () => {
    pool = require("mysql").createPool(`${URL}?connectionLimit=6&multipleStatements=true`);
    await q(pool, "SET FOREIGN_KEY_CHECKS = 0");
    for (const t of TABLES) await q(pool, `DROP TABLE IF EXISTS \`${t}\``);
    await q(pool, "SET FOREIGN_KEY_CHECKS = 1");
    for (const ddl of STAND_INS) await q(pool, ddl);
    await q(pool, "ALTER TABLE attendance_monthly_payroll ADD UNIQUE KEY uq_month (employee_id, period_year, period_month)");
    for (const file of MIGRATIONS) await q(pool, fs.readFileSync(path.join(SQLS, file), "utf8"));

    for (const id of ALL) {
      await q(pool, "INSERT INTO new_employee VALUES (?, ?, 1, 1, 1, 0, '1990-06-15', '2018-04-01', NULL, '100200300400', '3100000000', 1)", [id, `E${id}`]);
      const s = await q(pool, "INSERT INTO employee_salary (employee_id, monthly_gross, daily_salary, basic, conveyance, hra, special_allowance, effective_from, status) VALUES (?, 26000, 1000, 13000, 2500, 5000, 5500, '2026-04-01', 'APPROVED')", [id]);
      const pe = await q(pool, `INSERT INTO payrun_employee
        (period_year, period_month, employee_id, employee_name, store_id, store_name, date_of_joining,
         salary_id, salary_effective_from, monthly_gross, daily_salary, basic, conveyance, hra, special_allowance,
         pf_applicable, esi_applicable, uan, esi_number, pay_type, pay_type_source)
        VALUES (?, ?, ?, ?, 1, 'Moolakulam', '2018-04-01', ?, '2026-04-01', 26000, 1000, 13000, 2500, 5000, 5500,
                1, 1, '100200300400', '3100000000', 'BANK', 'EMPLOYEE_MASTER')`, [YEAR, MONTH, id, `E${id}`, s.insertId]);
      await q(pool, "INSERT INTO payrun_employee_adjustment_state (payrun_employee_id, period_year, period_month, employee_id, confirmed_no_adjustment, confirmed_by) VALUES (?, ?, ?, ?, 1, 9)", [pe.insertId, YEAR, MONTH, id]);
    }

    for (const id of CLEAN) {
      await storeDays(normalMonth(id));
      await persistMonth(id);
    }
    // E5: the month processed, THEN an OT approval rewrites 5 Sep.
    await storeDays(normalMonth(5));
    await persistMonth(5);
    await q(pool, "UPDATE attendance_day_calculation SET approved_ot_minutes = 84 WHERE employee_id = 5 AND attendance_date = '2026-09-05'");
    await q(pool, "INSERT INTO attendance_approval_request (request_type, requested_for_employee_id, attendance_date, status, approved_ot_minutes) VALUES ('OT', 5, '2026-09-05', 'APPROVED', 84)");
    // E6: OT approved on 27 Sep, a day whose NRM is 0.
    await storeDays(normalMonth(6, { "2026-09-27": { status: "FINAL", nrm_minutes: 0, base_nrm_minutes: 0, approved_ot_minutes: 60 } }));
    await persistMonth(6);
    // E7: processed while 7 Sep awaited a regularization; approved afterwards.
    await storeDays(normalMonth(7, { "2026-09-07": { status: "REGULARIZATION_PENDING", is_final: 0, attendance_day_count: 0 } }));
    await persistMonth(7);
    await q(pool, "UPDATE attendance_day_calculation SET status = 'FINAL', is_final = 1, attendance_day_count = 1 WHERE employee_id = 7 AND attendance_date = '2026-09-07'");
    await q(pool, "INSERT INTO attendance_approval_request (request_type, requested_for_employee_id, attendance_date, status) VALUES ('REGULARIZATION', 7, '2026-09-07', 'APPROVED')");
    // E8: 7 Sep is genuinely still waiting for a decision.
    await storeDays(normalMonth(8, { "2026-09-07": { status: "REGULARIZATION_PENDING", is_final: 0, attendance_day_count: 0 } }));
    await persistMonth(8);
    await q(pool, "INSERT INTO attendance_approval_request (request_type, requested_for_employee_id, attendance_date, status) VALUES ('REGULARIZATION', 8, '2026-09-07', 'PENDING')");
    // E9: processed on 16 Sep - only the first fifteen days were ever stored.
    await storeDays(normalMonth(9).slice(0, 15));
    await persistMonth(9, { is_final: 1 });
    // E10: like E7, but payroll calculated it before the day was settled.
    await storeDays(normalMonth(10, { "2026-09-07": { status: "REGULARIZATION_PENDING", is_final: 0, attendance_day_count: 0 } }));
    await persistMonth(10);
    // E11: days stored by the daily recalculation, month never processed.
    await storeDays(normalMonth(11));

    const repo = buildCalculationRepo(pool);
    current = buildCalculation(repo, buildPayrunRepo(pool), buildAdjustmentRepo(pool));
    current.today = () => "2026-10-03";
    current.setAttendanceProcessor(processor);
    const legacyRepo = Object.create(repo);
    legacyRepo.listAttendanceDayRows = undefined;
    previous = buildCalculation(legacyRepo, buildPayrunRepo(pool), buildAdjustmentRepo(pool));

    // E10 was calculated under the previous rule, on the non-final summary...
    const e10 = await previous.calculate({ year: YEAR, month: MONTH, employee_ids: [10], actor: ACTOR });
    assert.equal(e10.calculated_count, 1);
    // ...and its pending day was approved afterwards (summary not refreshed).
    await q(pool, "UPDATE attendance_day_calculation SET status = 'FINAL', is_final = 1, attendance_day_count = 1 WHERE employee_id = 10 AND attendance_date = '2026-09-07'");
  });

  after(async () => {
    if (pool) {
      await q(pool, "SET FOREIGN_KEY_CHECKS = 0");
      for (const t of TABLES) await q(pool, `DROP TABLE IF EXISTS \`${t}\``);
      await q(pool, "SET FOREIGN_KEY_CHECKS = 1");
      pool.end();
    }
    // The before/after table for the report.
    console.log(`READINESS-COUNTS ${JSON.stringify(counts)}`);
  });

  it("BEFORE: the previous rule counted 10 eligible, and 2 of them fail inside Calculate", async () => {
    const view = await monthView(previous);
    counts.before = { initialized: view.summary.initialized, eligible_shown: view.summary.not_calculated, attendance_pending: view.summary.attendance_pending };
    assert.equal(view.summary.not_calculated, 10);
    assert.equal(view.summary.attendance_pending, 1);
    assert.deepEqual(view.rows.find((r) => r.employee_id === 10).blockers.map((b) => b.code), ["ATTENDANCE_INCOMPLETE"]);

    // A dry run of what Calculate All Eligible did, without writing: the
    // calculation's own verdict per employee.
    const failing = [];
    const context = await previous._assemble({ year: YEAR, month: MONTH });
    context.population.forEach((e) => {
      const p = previous._present(context, e);
      if (p.row.status !== "NOT_CALCULATED") return;
      const built = previous._buildRow(context, p, ACTOR);
      if (built.fatal) failing.push({ employee_id: Number(e.employee_id), error: built.errors[0] });
    });
    counts.before.would_fail_in_calculate = failing.map((f) => f.employee_id);
    assert.deepEqual(failing.map((f) => f.employee_id), [5, 6]);
    assert.match(failing[0].error, /reports 0 minutes and its day rows report 84/);
    assert.match(failing[1].error, /Approved OT cannot be priced: no effective NRM was resolved/);
  });

  it("AFTER: eligible is exactly the 4 Calculate accepts, and every blocked employee says why", async () => {
    const view = await monthView(current);
    const reasonsOf = (id) => view.rows.find((r) => r.employee_id === id).blockers.map((b) => b.code);
    counts.after = {
      initialized: view.summary.initialized,
      eligible_shown: view.summary.eligible_to_calculate,
      not_calculated_blocked: view.summary.not_calculated_blocked,
      attendance_pending: view.summary.attendance_pending,
      attendance_processable: view.summary.attendance_processable,
      reasons: Object.fromEntries(ALL.filter((id) => !CLEAN.includes(id)).map((id) => [`E${id}`, reasonsOf(id).filter((c) => c !== "NOT_CALCULATED")])),
    };
    assert.equal(view.summary.not_calculated, 10);
    assert.equal(view.summary.eligible_to_calculate, 4);
    assert.equal(view.summary.not_calculated_blocked, 6);

    assert.deepEqual(reasonsOf(5).sort(), ["APPROVED_OT_MISMATCH", "ATTENDANCE_STALE", "NOT_CALCULATED"]);
    assert.deepEqual(reasonsOf(6).sort(), ["NOT_CALCULATED", "NRM_MISMATCH"]);
    assert.deepEqual(reasonsOf(7).sort(), ["ATTENDANCE_STALE", "ATTENDANCE_SUMMARY_NOT_FINAL", "NOT_CALCULATED"]);
    assert.deepEqual(reasonsOf(8).sort(), ["ATTENDANCE_DAY_ROWS_INCOMPLETE", "NOT_CALCULATED", "PENDING_ATTENDANCE_REGULARIZATION"]);
    assert.deepEqual(reasonsOf(9).sort(), ["ATTENDANCE_DAY_ROWS_INCOMPLETE", "NOT_CALCULATED"]);
    assert.deepEqual(reasonsOf(11).sort(), ["ATTENDANCE_MONTH_NOT_CALCULATED", "NOT_CALCULATED"]);
    // The already-calculated "149" case: the real reason, not "Attendance incomplete".
    const e10 = view.rows.find((r) => r.employee_id === 10);
    assert.equal(e10.status, "ATTENDANCE_PENDING");
    assert.deepEqual(reasonsOf(10).sort(), ["ATTENDANCE_STALE", "ATTENDANCE_SUMMARY_NOT_FINAL"]);
    assert.equal(e10.attendance_processable, true);
  });

  it("AFTER: Calculate All Eligible calculates exactly the counted 4 with no failures; each counted employee calculates individually", async () => {
    const result = await current.calculate({ year: YEAR, month: MONTH, all_eligible: true, actor: ACTOR });
    counts.after.calculate_all = { calculated: result.calculated_count, failed: result.failed_count };
    assert.equal(result.calculated_count, 4);
    assert.equal(result.failed_count, 0);
    assert.deepEqual(result.results.map((r) => r.employee_id).sort(), CLEAN);

    for (const id of [5, 6, 7, 8, 9, 11]) {
      const one = await current.calculate({ year: YEAR, month: MONTH, employee_ids: [id], actor: ACTOR });
      assert.equal(one.blocked_count, 1, `E${id} must be refused by name`);
      assert.equal(one.failed_count, 0);
    }
  });

  it("Process Attendance clears exactly the processable, skips what needs Attendance, and touches no request or salary", async () => {
    const requests = JSON.stringify(await q(pool, "SELECT * FROM attendance_approval_request ORDER BY 1"));
    const salaries = JSON.stringify(await q(pool, "SELECT * FROM employee_salary ORDER BY 1"));
    const e10Calc = JSON.stringify(await q(pool, "SELECT net_pay, calculation_hash FROM payrun_employee_calculation WHERE employee_id = 10"));

    const result = await current.processAttendance({ year: YEAR, month: MONTH, employee_ids: [5, 6, 7, 8, 9, 10, 11] });
    counts.after.process_attendance = {
      processed: result.processed_count, cleared: result.cleared_count, skipped: result.skipped_count,
      skipped_ids: result.results.filter((r) => r.result === "SKIPPED").map((r) => r.employee_id),
    };
    assert.deepEqual(processor.calls.sort((a, b) => a - b), [5, 7, 9, 10, 11]);
    assert.equal(result.processed_count, 5);
    assert.equal(result.cleared_count, 5);
    assert.deepEqual(result.results.filter((r) => r.result === "SKIPPED").map((r) => r.employee_id), [6, 8]);

    assert.equal(JSON.stringify(await q(pool, "SELECT * FROM attendance_approval_request ORDER BY 1")), requests, "no approval changed");
    assert.equal(JSON.stringify(await q(pool, "SELECT * FROM employee_salary ORDER BY 1")), salaries, "no salary changed");
    assert.equal(JSON.stringify(await q(pool, "SELECT net_pay, calculation_hash FROM payrun_employee_calculation WHERE employee_id = 10")), e10Calc, "no payroll figure changed");
    const [ot] = await q(pool, "SELECT approved_ot_minutes FROM attendance_day_calculation WHERE employee_id = 5 AND attendance_date = '2026-09-05'");
    assert.equal(Number(ot.approved_ot_minutes), 84, "approved OT is never altered");
  });

  it("AFTER PROCESSING: the newly clear employees are eligible and calculate; E10 recalculates out of Attendance Pending", async () => {
    const view = await monthView(current);
    counts.after.after_processing = {
      eligible_shown: view.summary.eligible_to_calculate,
      not_calculated_blocked: view.summary.not_calculated_blocked,
      attendance_pending: view.summary.attendance_pending,
      recalculation_required: view.summary.recalculation_required,
    };
    assert.equal(view.summary.eligible_to_calculate, 4);
    assert.equal(view.summary.not_calculated_blocked, 2);
    assert.equal(view.summary.attendance_pending, 0);
    assert.equal(view.rows.find((r) => r.employee_id === 10).status, "RECALCULATION_REQUIRED");

    const all = await current.calculate({ year: YEAR, month: MONTH, all_eligible: true, actor: ACTOR });
    assert.deepEqual(all.results.map((r) => r.employee_id).sort((a, b) => a - b), [5, 7, 9, 11]);
    assert.equal(all.failed_count, 0);
    const [e5] = await q(pool, "SELECT approved_ot_minutes FROM payrun_employee_calculation WHERE employee_id = 5");
    assert.equal(Number(e5.approved_ot_minutes), 84, "the approved OT is now priced");

    const recalc = await current.calculate({ year: YEAR, month: MONTH, employee_ids: [10], mode: "RECALCULATE", actor: ACTOR });
    assert.equal(recalc.recalculated_count, 1);
    assert.equal(await rowOf(current, 10).then((r) => r.status), "READY_FOR_APPROVAL");
  });

  it("an Approved & Locked employee is never reprocessed or recalculated", async () => {
    await q(pool, "UPDATE payrun_employee_calculation SET status = 'APPROVED_LOCKED' WHERE employee_id = 1");
    const before = JSON.stringify(await q(pool, "SELECT * FROM attendance_monthly_payroll WHERE employee_id = 1"));
    const calc = JSON.stringify(await q(pool, "SELECT * FROM payrun_employee_calculation WHERE employee_id = 1"));
    processor.calls.length = 0;
    const result = await current.processAttendance({ year: YEAR, month: MONTH, employee_ids: [1] });
    assert.equal(result.locked_count, 1);
    assert.equal(processor.calls.length, 0);
    const recalc = await current.calculate({ year: YEAR, month: MONTH, employee_ids: [1], mode: "RECALCULATE", actor: ACTOR });
    assert.equal(recalc.locked_count, 1);
    assert.equal(JSON.stringify(await q(pool, "SELECT * FROM attendance_monthly_payroll WHERE employee_id = 1")), before);
    assert.equal(JSON.stringify(await q(pool, "SELECT * FROM payrun_employee_calculation WHERE employee_id = 1")), calc);
  });
});
