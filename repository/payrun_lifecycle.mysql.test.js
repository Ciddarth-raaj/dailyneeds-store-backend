/**
 * UNLOCK / PUBLISH / UNPUBLISH AND NET PAY ROUNDING, AS REAL SQL.
 *
 *   ATTENDANCE_TEST_MYSQL=mysql://user:pass@localhost/scratch_db \
 *     node --test repository/payrun_lifecycle.mysql.test.js
 *
 * SKIPPED unless `ATTENDANCE_TEST_MYSQL` names a SCRATCH database.
 *
 * Every payrun table is built from the migration files - including the
 * lifecycle migration under test - and the production usecase and
 * repositories do the work: real Calculate, real Approve & Lock (with its
 * lock-time attendance re-reads), real Unlock / Publish / Unpublish. The
 * source tables are fingerprinted before and after and must not move.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const URL = process.env.ATTENDANCE_TEST_MYSQL;
const buildCalculationRepo = require("./payrun_calculation");
const buildPayrunRepo = require("./payrun");
const buildAdjustmentRepo = require("./payrun_adjustment");
const buildAttendanceRepo = require("./attendance_calculation");
const buildCalculation = require("../usecase/payrun_calculation");
const buildPayslipRepo = require("./payrun_payslip");
const buildNotifier = require("../usecase/payslip_notification");
const { dayRowsSql, dayRowsFingerprint } = require("../utils/attendance_month_freshness");
const { SQLS, MIGRATIONS, TABLES, STAND_INS, SOURCES } = require("../test_support/payrun_mysql_fixture");

const YEAR = 2026;
const MONTH = 9;
const SEPT = Array.from({ length: 30 }, (_, i) => `2026-09-${String(i + 1).padStart(2, "0")}`);
const ACTOR = { employeeId: 77, userId: 7 };
const IDS = [1, 2, 3, 4];
const LIFECYCLE_DOWN = "20261111120000-payrun-lifecycle-down.sql";

const q = (pool, sql, params = []) =>
  new Promise((resolve, reject) => pool.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));

describe("payroll lifecycle over real SQL", { skip: !URL && "ATTENDANCE_TEST_MYSQL is not set" }, () => {
  let pool;
  let usecase;
  const calcRow = async (id) =>
    (await q(pool, "SELECT * FROM payrun_employee_calculation WHERE employee_id = ? AND period_month = ?", [id, MONTH]))[0];
  const FIGURES = "net_pay, net_pay_rounding, total_earnings, total_employee_deductions, salary_days, employee_pf, employee_esi, ot_amount, calculation_hash, calculation_revision, calculation_version";
  const figures = async (id) =>
    JSON.stringify(await q(pool, `SELECT ${FIGURES} FROM payrun_employee_calculation WHERE employee_id = ?`, [id]));
  const fingerprints = async () => {
    const out = {};
    for (const t of SOURCES) out[t] = JSON.stringify(await q(pool, `SELECT * FROM \`${t}\` ORDER BY 1, 2`));
    return out;
  };
  const statusOf = async (id) =>
    (await usecase.getMonth({ year: YEAR, month: MONTH })).rows.find((r) => r.employee_id === id).status;
  const act = (action, ids, over = {}) =>
    usecase.lifecycle({
      action, year: YEAR, month: MONTH, employee_ids: ids,
      reason: action === "PUBLISH" ? null : "Correction after review",
      mode: ids.length === 1 ? "INDIVIDUAL" : "BULK", actor: ACTOR, ...over,
    });

  before(async () => {
    pool = require("mysql").createPool(`${URL}?connectionLimit=6&multipleStatements=true`);
    await q(pool, "SET FOREIGN_KEY_CHECKS = 0");
    for (const t of TABLES) await q(pool, `DROP TABLE IF EXISTS \`${t}\``);
    await q(pool, "SET FOREIGN_KEY_CHECKS = 1");
    for (const ddl of STAND_INS) await q(pool, ddl);
    for (const file of MIGRATIONS) await q(pool, fs.readFileSync(path.join(SQLS, file), "utf8"));

    for (const id of IDS) {
      await q(pool, "INSERT INTO new_employee VALUES (?, ?, 1, 1, 1, 0, '1990-06-15', '2018-04-01', NULL, '100200300400', '3100000000', 1, 'State Bank', '123456789012', 'ABCDE1234F', 3)", [id, `E${id}`]);
      // 26,013.37 a month: a gross whose Net Pay is NOT a whole rupee.
      const s = await q(pool, "INSERT INTO employee_salary (employee_id, monthly_gross, daily_salary, basic, conveyance, hra, special_allowance, effective_from, status) VALUES (?, 26013.37, 1000.51, 13006.69, 2500, 5000, 5506.68, '2026-04-01', 'APPROVED')", [id]);
      const pe = await q(pool, `INSERT INTO payrun_employee
        (period_year, period_month, employee_id, employee_name, store_id, store_name, date_of_joining,
         salary_id, salary_effective_from, monthly_gross, daily_salary, basic, conveyance, hra, special_allowance,
         pf_applicable, esi_applicable, uan, esi_number, pay_type, pay_type_source)
        VALUES (?, ?, ?, ?, 1, 'Moolakulam', '2018-04-01', ?, '2026-04-01', 26013.37, 1000.51, 13006.69, 2500, 5000, 5506.68,
                1, 1, '100200300400', '3100000000', 'BANK', 'EMPLOYEE_MASTER')`, [YEAR, MONTH, id, `E${id}`, s.insertId]);
      await q(pool, "INSERT INTO payrun_employee_adjustment_state (payrun_employee_id, period_year, period_month, employee_id, confirmed_no_adjustment, confirmed_by) VALUES (?, ?, ?, ?, 1, 9)", [pe.insertId, YEAR, MONTH, id]);
      for (const [i, d] of SEPT.entries()) {
        await q(pool, `INSERT INTO attendance_day_calculation
            (employee_id, attendance_date, nrm_minutes, break_allowance_source, is_final, approved_ot_minutes,
             status, attendance_day_count, base_nrm_minutes, worked_minutes)
          VALUES (?, ?, 480, 'SHIFT', 1, 0, ?, ?, 480, ?)`, [id, d, i < 26 ? "FINAL" : "ABSENT", i < 26 ? 1 : 0, i < 26 ? 480 : 0]);
      }
      const stored = await q(pool, dayRowsSql(), [id, SEPT[0], SEPT[29]]);
      await q(pool, `INSERT INTO attendance_monthly_payroll
          (employee_id, period_year, period_month, is_final, payroll_version, salary_days, extra_days, base_days,
           monthly_gross, daily_rate, salary_day_earnings, extra_day_earnings, shortage_minutes, missing_minute_deduction,
           approved_ot_minutes, approved_ot_earnings, calculated_at, day_rows_fingerprint)
         VALUES (?, ?, ?, 1, 1, 26, 0, 26, 26013.37, 1000.51, 26013.37, 0, 0, 0, 0, 0, '2026-10-01 02:00:00.000', ?)`,
      [id, YEAR, MONTH, dayRowsFingerprint(stored)]);
    }

    await q(pool, "INSERT INTO department VALUES (3, 'Grocery', 1)");
    usecase = buildCalculation(buildCalculationRepo(pool), buildPayrunRepo(pool), buildAdjustmentRepo(pool));
    usecase.today = () => "2026-10-03";
    const payslipRepo = buildPayslipRepo(pool);
    usecase.setPayslipServices({
      payslipRepo,
      notifier: buildNotifier({
        payslipRepo,
        identityRepo: { getActiveIdentityByEmployee: async () => null },
        telegram: { sendMessage: async () => ({ code: 200, message_id: 1 }) },
      }),
      company: () => ({ name: "Daily Needs" }),
    });
    const calculated = await usecase.calculate({ year: YEAR, month: MONTH, all_eligible: true, actor: ACTOR });
    assert.equal(calculated.calculated_count, IDS.length, JSON.stringify(calculated.results));
    const approved = await usecase.approve({ year: YEAR, month: MONTH, employee_ids: [1, 2, 3], actor: ACTOR });
    assert.equal(approved.approved_count, 3, JSON.stringify(approved.results));
  });

  after(async () => {
    if (!pool) return;
    await q(pool, "SET FOREIGN_KEY_CHECKS = 0");
    for (const t of TABLES) await q(pool, `DROP TABLE IF EXISTS \`${t}\``);
    await q(pool, "SET FOREIGN_KEY_CHECKS = 1");
    pool.end();
  });

  it("NET PAY: stored as a whole rupee with its rounding, and the row adds up (version 2)", async () => {
    const row = await calcRow(1);
    assert.equal(Number(row.net_pay) % 1, 0, `net pay ${row.net_pay}`);
    assert.equal(row.calculation_version, 2);
    assert.ok(row.net_pay_rounding !== null);
    assert.equal(
      Math.round(Number(row.net_pay) * 100),
      Math.round((Number(row.total_earnings) - Number(row.total_employee_deductions) + Number(row.net_pay_rounding)) * 100)
    );
    assert.ok(Math.abs(Number(row.net_pay_rounding)) <= 0.5);
    const view = (await usecase.getMonth({ year: YEAR, month: MONTH })).rows.find((r) => r.employee_id === 1);
    assert.equal(Number(view.net_pay), Number(row.net_pay), "the screen shows the stored figure");
  });

  it("APPROVE & LOCK writes a LOCK lifecycle row, BULK, beside the existing approval audit", async () => {
    const lock = await q(pool, "SELECT * FROM payrun_employee_lifecycle_audit WHERE action = 'LOCK' ORDER BY employee_id");
    assert.deepEqual(lock.map((r) => [r.employee_id, r.previous_status, r.new_status, r.mode, r.acted_by_employee_id, r.acted_by_user_id]), [
      [1, "CALCULATED", "APPROVED_LOCKED", "BULK", 77, 7],
      [2, "CALCULATED", "APPROVED_LOCKED", "BULK", 77, 7],
      [3, "CALCULATED", "APPROVED_LOCKED", "BULK", 77, 7],
    ]);
    const approvals = await q(pool, "SELECT COUNT(*) AS n FROM payrun_employee_calculation_audit WHERE action = 'APPROVE_LOCK'");
    assert.equal(approvals[0].n, 3);
  });

  it("PUBLISH: Approved & Locked publishes; the stored status stays APPROVED_LOCKED so every lock still holds", async () => {
    const out = await act("PUBLISH", [1, 4]);
    assert.deepEqual(out.results.map((r) => r.result), ["PUBLISHED", "SKIPPED"]);
    const row = await calcRow(1);
    assert.equal(row.status, "APPROVED_LOCKED");
    assert.equal(row.published_by, 77);
    assert.ok(row.published_at);
    assert.equal(await statusOf(1), "PUBLISHED");
    // The attendance write guard's own read still sees it as locked.
    const att = buildAttendanceRepo(pool);
    const locked = await att.findPayrollLockedPeriods([{ employee_id: 1, attendance_date: "2026-09-10" }]);
    assert.equal(locked.length, 1, "attendance cannot be changed under a published month");
  });

  it("UNLOCK: direct unlock of a PUBLISHED month is refused; a mixed bulk unlocks only the eligible", async () => {
    const before = await fingerprints();
    const f2 = await figures(2);
    const approvalsBefore = JSON.stringify(await q(pool, "SELECT * FROM payrun_employee_calculation_audit WHERE action = 'APPROVE_LOCK' ORDER BY 1"));
    const out = await act("UNLOCK", [1, 2, 4]);
    assert.deepEqual(out.results.map((r) => r.result), ["SKIPPED", "UNLOCKED", "SKIPPED"]);
    assert.match(out.results[0].message, /already published/);
    assert.match(out.results[2].message, /not approved/);

    const row = await calcRow(2);
    assert.equal(row.status, "CALCULATED");
    assert.equal(row.approved_by, null);
    assert.equal(row.approved_at, null);
    assert.equal(row.locked_by, null);
    assert.equal(row.unlocked_by, 77);
    assert.ok(row.unlocked_at);
    assert.equal(row.unlock_reason, "Correction after review");
    assert.equal(await figures(2), f2, "the calculation and every figure are intact");
    assert.equal((await calcRow(1)).status, "APPROVED_LOCKED");
    assert.deepEqual(await fingerprints(), before, "attendance, salary, OT, requests, master: untouched");
    assert.equal(JSON.stringify(await q(pool, "SELECT * FROM payrun_employee_calculation_audit WHERE action = 'APPROVE_LOCK' ORDER BY 1")), approvalsBefore, "approval history preserved");
    const unlockAudit = await q(pool, "SELECT action FROM payrun_employee_calculation_audit WHERE employee_id = 2 AND action = 'UNLOCK'");
    assert.equal(unlockAudit.length, 1);
    assert.equal(await statusOf(2), "READY_FOR_APPROVAL");
  });

  it("UNPUBLISH then UNLOCK: back to Approved & Locked with the calculation intact, then unlockable", async () => {
    const f1 = await figures(1);
    const out = await act("UNPUBLISH", [1], { remark: "bank file rejected" });
    assert.equal(out.unpublished_count, 1);
    const row = await calcRow(1);
    assert.equal(row.status, "APPROVED_LOCKED");
    assert.equal(row.published_at, null);
    assert.equal(row.published_by, null);
    assert.equal(await figures(1), f1);
    assert.equal((await act("UNLOCK", [1])).unlocked_count, 1);
  });

  it("an unlocked employee recalculates and approves again", async () => {
    const recalc = await usecase.calculate({ year: YEAR, month: MONTH, employee_ids: [1, 2], mode: "RECALCULATE", actor: ACTOR });
    assert.equal(recalc.recalculated_count, 2);
    const again = await usecase.approve({ year: YEAR, month: MONTH, employee_ids: [1], actor: ACTOR });
    assert.equal(again.approved_count, 1);
  });

  it("PUBLISH refuses a month whose salary source moved after approval", async () => {
    await q(pool, "INSERT INTO employee_salary (employee_id, monthly_gross, daily_salary, basic, conveyance, hra, special_allowance, effective_from, status) VALUES (3, 28000, 1076.92, 14000, 2500, 5000, 6500, '2026-09-01', 'APPROVED')");
    const out = await act("PUBLISH", [3]);
    assert.equal(out.blocked_count, 1);
    assert.match(out.results[0].message, /Unlock, recalculate and approve again/);
    assert.equal((await calcRow(3)).published_at, null);
  });

  it("AUDIT: the lifecycle log records each act with status, reason, remark, mode and actor", async () => {
    const rows = await q(pool, "SELECT employee_id, action, previous_status, new_status, reason, remark, mode FROM payrun_employee_lifecycle_audit WHERE action <> 'LOCK' ORDER BY payrun_lifecycle_audit_id");
    assert.deepEqual(rows.map((r) => [r.employee_id, r.action, r.previous_status, r.new_status, r.mode]), [
      [1, "PUBLISH", "APPROVED_LOCKED", "PUBLISHED", "BULK"],
      [2, "UNLOCK", "APPROVED_LOCKED", "CALCULATED", "BULK"],
      [1, "UNPUBLISH", "PUBLISHED", "APPROVED_LOCKED", "INDIVIDUAL"],
      [1, "UNLOCK", "APPROVED_LOCKED", "CALCULATED", "INDIVIDUAL"],
    ]);
    assert.equal(rows[2].remark, "bank file rejected");
    assert.equal(rows[1].reason, "Correction after review");
    assert.equal(rows[0].reason, null, "publish needs no reason");
  });

  it("the migration re-runs cleanly, and its down removes only what it added", async () => {
    const up = MIGRATIONS.find((m) => m === "20261111120000-payrun-lifecycle-up.sql");
    assert.ok(up, "the lifecycle migration is part of the fixture");
    await q(pool, fs.readFileSync(path.join(SQLS, up), "utf8"));
    const keys = await q(pool, "SELECT permission_key FROM all_permissions WHERE permission_key IN ('unlock_payrun','publish_payrun') ORDER BY 1");
    assert.deepEqual(keys.map((k) => k.permission_key), ["publish_payrun", "unlock_payrun"]);
    const calcBefore = await q(pool, "SELECT COUNT(*) AS n FROM payrun_employee_calculation");
    await q(pool, fs.readFileSync(path.join(SQLS, LIFECYCLE_DOWN), "utf8"));
    const cols = await q(pool, "SHOW COLUMNS FROM payrun_employee_calculation WHERE Field IN ('published_at','published_by','net_pay_rounding')");
    assert.equal(cols.length, 0);
    assert.equal((await q(pool, "SHOW TABLES LIKE 'payrun_employee_lifecycle_audit'")).length, 0);
    assert.deepEqual(await q(pool, "SELECT COUNT(*) AS n FROM payrun_employee_calculation"), calcBefore);
  });
});
