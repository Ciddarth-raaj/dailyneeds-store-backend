/**
 * PRIOR-MONTH OT CARRY-FORWARD, AS REAL SQL - the production payroll usecase
 * and repositories over a locked September, an open October and a November.
 *
 *   ATTENDANCE_TEST_MYSQL=mysql://user:pass@localhost/scratch_db \
 *     node --test repository/prior_month_ot_carry_forward.mysql.test.js
 *
 * SKIPPED unless `ATTENDANCE_TEST_MYSQL` names a SCRATCH database.
 *
 * The payrun tables are built from their MIGRATION FILES (the shared payroll
 * fixture's list, the EPFO-2026 columns and the carry-forward migration).
 * The settlement row is written exactly as a late OT approval writes it
 * (`decideStage`, proven in usecase/attendance_ot_late_approval.test.js) and
 * priced with the production `priceLateOt`.
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
const buildPayslipRepo = require("./payrun_payslip");
const buildNotifier = require("../usecase/payslip_notification");
const { priceLateOt } = require("../utils/payrun_calculation");
const { dayRowsSql, dayRowsFingerprint } = require("../utils/attendance_month_freshness");
const { SQLS, MIGRATIONS, TABLES, STAND_INS } = require("../test_support/payrun_mysql_fixture");

const ACTOR = { employeeId: 77, userId: 7 };
const LATE = 1; // gets the prior-month OT
const CONTROL = 2; // identical in every way, without it
const REQUEST = 501;
const REQUEST_LATER = 503; // late-approved while October is locked but not yet published
const EPFO = "20261120120000-epfo-wage-ceiling-2026-up.sql";
const CARRY = "20261126120000-attendance-ot-late-settlement-up.sql";

const q = (pool, sql, params = []) =>
  new Promise((resolve, reject) => pool.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));
const daysOf = (year, month) => {
  const n = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return Array.from({ length: n }, (_, i) => `${year}-${String(month).padStart(2, "0")}-${String(i + 1).padStart(2, "0")}`);
};

/* The fixture's employee stand-in predates the EPFO columns; this one is complete. */
const EMPLOYEE_DDL = `CREATE TABLE new_employee (
  employee_id INT PRIMARY KEY, employee_name VARCHAR(100), store_id INT,
  pf_applicable TINYINT(1), esi_applicable TINYINT(1), previous_eps_member TINYINT(1), previous_pf_member TINYINT(1),
  dob DATE, date_of_joining VARCHAR(40), resignation_date DATE NULL,
  uan VARCHAR(45), esi_number VARCHAR(45), pf_number VARCHAR(45), attendance_required TINYINT(1) DEFAULT 1,
  bank_name VARCHAR(100) NULL, account_no VARCHAR(45) NULL, pan_no VARCHAR(20) NULL,
  department_id INT NULL
) ENGINE=InnoDB`;

describe("Prior-Month OT carry-forward over real SQL", { skip: !URL && "ATTENDANCE_TEST_MYSQL is not set" }, () => {
  let pool;
  let usecase;
  let calcRepo;
  let price;
  const row = async (id, month) =>
    (await q(pool, "SELECT * FROM payrun_employee_calculation WHERE employee_id = ? AND period_year = 2026 AND period_month = ?", [id, month]))[0];
  const settlement = async () => (await q(pool, "SELECT * FROM attendance_ot_late_settlement WHERE attendance_approval_request_id = ?", [REQUEST]))[0];
  const log = async () =>
    (await q(pool, "SELECT from_status, to_status, settlement_month FROM attendance_ot_late_settlement_log WHERE attendance_approval_request_id = ? ORDER BY late_settlement_log_id", [REQUEST])).map(
      (l) => `${l.from_status || "-"}>${l.to_status}@${l.settlement_month || "-"}`
    );
  const at = (today) => {
    usecase.today = () => today;
  };

  const seedMonth = async (year, month) => {
    const days = daysOf(year, month);
    for (const id of [LATE, CONTROL]) {
      const [salary] = await q(pool, "SELECT salary_id FROM employee_salary WHERE employee_id = ?", [id]);
      const pe = await q(pool, `INSERT INTO payrun_employee
        (period_year, period_month, employee_id, employee_name, store_id, store_name, date_of_joining,
         salary_id, salary_effective_from, monthly_gross, daily_salary, basic, conveyance, hra, special_allowance,
         pf_applicable, esi_applicable, uan, esi_number, pay_type, pay_type_source)
        VALUES (?, ?, ?, ?, 1, 'Moolakulam', '2018-04-01', ?, '2026-04-01', 20800, 800, 10400, 2000, 4000, 4400,
                1, 1, '100200300400', '3100000000', 'BANK', 'EMPLOYEE_MASTER')`, [year, month, id, `E${id}`, salary.salary_id]);
      await q(pool, "INSERT INTO payrun_employee_adjustment_state (payrun_employee_id, period_year, period_month, employee_id, confirmed_no_adjustment, confirmed_by) VALUES (?, ?, ?, ?, 1, 9)", [pe.insertId, year, month, id]);
      for (const [i, d] of days.entries()) {
        const worked = i < 26;
        await q(pool, `INSERT INTO attendance_day_calculation
            (employee_id, attendance_date, nrm_minutes, break_allowance_source, is_final, approved_ot_minutes,
             status, attendance_day_count, base_nrm_minutes, worked_minutes)
          VALUES (?, ?, 480, 'SHIFT', 1, 0, ?, ?, 480, ?)`, [id, d, worked ? "FINAL" : "ABSENT", worked ? 1 : 0, worked ? 480 : 0]);
      }
      const stored = await q(pool, dayRowsSql(), [id, days[0], days[days.length - 1]]);
      await q(pool, `INSERT INTO attendance_monthly_payroll
          (employee_id, period_year, period_month, is_final, payroll_version, salary_days, extra_days, base_days,
           monthly_gross, daily_rate, salary_day_earnings, extra_day_earnings, shortage_minutes, missing_minute_deduction,
           approved_ot_minutes, approved_ot_earnings, calculated_at, day_rows_fingerprint)
         VALUES (?, ?, ?, 1, 1, 26, 0, 26, 20800, 800, 20800, 0, 0, 0, 0, 0, '2026-10-01 02:00:00.000', ?)`,
      [id, year, month, dayRowsFingerprint(stored)]);
    }
  };

  before(async () => {
    pool = require("mysql").createPool(`${URL}?connectionLimit=6&multipleStatements=true`);
    await q(pool, "SET FOREIGN_KEY_CHECKS = 0");
    for (const t of TABLES) await q(pool, `DROP TABLE IF EXISTS \`${t}\``);
    await q(pool, "SET FOREIGN_KEY_CHECKS = 1");
    for (const ddl of STAND_INS.filter((d) => !/CREATE TABLE new_employee/.test(d))) await q(pool, ddl);
    await q(pool, EMPLOYEE_DDL);
    // The salary stand-in predates the statutory columns the payslip read selects.
    await q(pool, `ALTER TABLE employee_salary
      ADD COLUMN pf_status VARCHAR(32) NULL, ADD COLUMN employee_pf DECIMAL(12,2) NULL,
      ADD COLUMN employer_pf_total DECIMAL(12,2) NULL, ADD COLUMN edli DECIMAL(12,2) NULL,
      ADD COLUMN pf_admin_charge DECIMAL(12,2) NULL, ADD COLUMN esi_status VARCHAR(32) NULL,
      ADD COLUMN esi_wage DECIMAL(12,2) NULL, ADD COLUMN employee_esi DECIMAL(12,2) NULL,
      ADD COLUMN employer_esi DECIMAL(12,2) NULL, ADD COLUMN monthly_ctc DECIMAL(12,2) NULL,
      ADD COLUMN ctc_status VARCHAR(32) NULL, ADD COLUMN unresolved_notes TEXT NULL,
      ADD COLUMN statutory_snapshot JSON NULL`);
    const files = [...MIGRATIONS.filter((f) => f !== CARRY), EPFO, CARRY];
    for (const file of files) await q(pool, fs.readFileSync(path.join(SQLS, file), "utf8"));

    for (const id of [LATE, CONTROL]) {
      await q(pool, `INSERT INTO new_employee (employee_id, employee_name, store_id, pf_applicable, esi_applicable,
          previous_eps_member, previous_pf_member, dob, date_of_joining, uan, esi_number, pf_number, attendance_required,
          bank_name, account_no, pan_no, department_id)
        VALUES (?, ?, 1, 1, 1, 0, 0, '1990-06-15', '2018-04-01', '100200300400', '3100000000', 'TN/MAS/1/1', 1, 'State Bank', '123456789012', 'ABCDE1234F', 3)`, [id, `E${id}`]);
      await q(pool, "INSERT INTO employee_salary (employee_id, monthly_gross, daily_salary, basic, conveyance, hra, special_allowance, effective_from, status) VALUES (?, 20800, 800, 10400, 2000, 4000, 4400, '2026-04-01', 'APPROVED')", [id]);
    }
    await q(pool, "INSERT INTO department VALUES (3, 'Grocery', 1)");
    await q(pool, `INSERT INTO company_details (company_name, reg_address, contact_number, gst_number, pan_number, esi_number, tan_number, pf_number)
                   VALUES ('Daily Needs Departmental Store', '188/1 Iyyanar Koil Street', '-', '-', '-', '51000123450001001', '-', 'TN/MAS/0012345')`);
    await seedMonth(2026, 9);
    await seedMonth(2026, 10);
    await seedMonth(2026, 11);

    calcRepo = buildCalculationRepo(pool);
    usecase = buildCalculation(calcRepo, buildPayrunRepo(pool), buildAdjustmentRepo(pool));
    const payslipRepo = buildPayslipRepo(pool);
    usecase.setPayslipServices({
      payslipRepo,
      notifier: buildNotifier({
        payslipRepo,
        identityRepo: { getActiveIdentityByEmployee: async () => null },
        telegram: { sendMessage: async () => ({ code: 200, message_id: 1 }) },
        intervalMs: 0,
      }),
      companyEnv: () => ({}),
    });

    // SEPTEMBER: calculated, approved and LOCKED - before the OT is decided.
    at("2026-10-03");
    const sep = await usecase.calculate({ year: 2026, month: 9, all_eligible: true, actor: ACTOR });
    assert.equal(sep.calculated_count, 2, JSON.stringify(sep.results));
    const lock = await usecase.approve({ year: 2026, month: 9, employee_ids: [LATE, CONTROL], actor: ACTOR });
    assert.equal(lock.approved_count, 2, JSON.stringify(lock.results));

    // THE LATE APPROVAL (10 Oct): 120 min of OT on 10 Sep, priced on
    // SEPTEMBER's locked basis, written as `decideStage` writes it.
    const sepRow = await row(LATE, 9);
    price = priceLateOt({ approved_ot_minutes: 120, daily_rate: sepRow.daily_rate, nrm_minutes: 480 });
    assert.equal(price.error, null);
    // The OT requests the settlements belong to (fk_aols_request): approved
    // after September locked.
    await q(pool, `INSERT INTO attendance_approval_request
        (attendance_approval_request_id, request_type, requested_for_employee_id, attendance_date, status, approved_ot_minutes)
      VALUES (?, 'OT', ?, '2026-09-10', 'APPROVED', 120), (502, 'OT', ?, '2026-09-11', 'APPROVED', 60), (?, 'OT', ?, '2026-09-12', 'APPROVED', 60)`,
    [REQUEST, LATE, LATE, REQUEST_LATER, LATE]);
    await q(pool, `INSERT INTO attendance_ot_late_settlement
        (attendance_approval_request_id, employee_id, attendance_date, source_year, source_month,
         eligible_ot_minutes, approved_ot_minutes, source_payrun_calculation_id, source_daily_rate,
         nrm_minutes, ot_hourly_rate, amount, settlement_status, approved_by)
       VALUES (?, ?, '2026-09-10', 2026, 9, 120, 120, ?, ?, 480, ?, ?, 'PENDING_SETTLEMENT', 7)`,
    [REQUEST, LATE, sepRow.payrun_calculation_id, price.daily_rate, price.ot_hourly_rate, price.amount]);
  });

  after(async () => {
    if (!pool) return;
    await q(pool, "SET FOREIGN_KEY_CHECKS = 0");
    for (const t of TABLES) await q(pool, `DROP TABLE IF EXISTS \`${t}\``);
    await q(pool, "SET FOREIGN_KEY_CHECKS = 1");
    pool.end();
  });

  it("9. priced on the ORIGINAL month: September's daily rate / NRM hours x hours", async () => {
    const sepRow = await row(LATE, 9);
    assert.equal(Number(sepRow.daily_rate), 800);
    // 800 / 8 h = 100.00 an hour; 2 h = 200.00
    assert.equal(price.ot_hourly_rate, 100);
    assert.equal(price.amount, 200);
  });

  it("4/10. October picks it up: Prior-Month OT in earnings and net pay, NOT in the PF or ESI wage - exactly like OT", async () => {
    at("2026-11-03");
    const before = JSON.stringify(await row(LATE, 9));
    const oct = await usecase.calculate({ year: 2026, month: 10, all_eligible: true, actor: ACTOR });
    assert.equal(oct.calculated_count, 2, JSON.stringify(oct.results));
    const late = await row(LATE, 10);
    const control = await row(CONTROL, 10);
    assert.equal(Number(late.prior_month_ot_amount), 200);
    assert.equal(late.prior_month_ot ? JSON.parse(late.prior_month_ot)[0].attendance_approval_request_id : null, REQUEST);
    assert.equal(Number(late.ot_amount), Number(control.ot_amount), "this month's own OT is untouched");
    assert.equal(Number(late.arrears), 0, "never Arrears");
    assert.equal(Number(late.total_earnings) - Number(control.total_earnings), 200);
    for (const k of ["pf_wage", "eps_wage", "edli_wage", "employee_pf", "employer_epf", "employer_eps", "employer_pf_total", "edli",
      "esi_wage", "employee_esi", "employer_esi"]) {
      assert.equal(String(late[k]), String(control[k]), `${k}: Prior-Month OT reaches no ESI or PF/EPS/EDLI wage`);
    }
    assert.equal(late.esi_status, "APPLIED", "an ESI-covered employee: the equality above is a real check");
    assert.equal(control.prior_month_ot_amount, null, "an ordinary month is stored exactly as before");
    const s = await settlement();
    assert.deepEqual([s.settlement_status, s.settlement_year, s.settlement_month], ["INCLUDED", 2026, 10]);
    assert.equal(JSON.stringify(await row(LATE, 9)), before, "2. the locked September row is byte-identical");
  });

  it("5. recalculating October does not duplicate it", async () => {
    const recalc = await usecase.calculate({ year: 2026, month: 10, employee_ids: [LATE], mode: "RECALCULATE", actor: ACTOR });
    assert.ok(["RECALCULATED", "SKIPPED"].includes(recalc.results[0].result), JSON.stringify(recalc.results));
    const late = await row(LATE, 10);
    assert.equal(Number(late.prior_month_ot_amount), 200);
    assert.equal(JSON.parse(late.prior_month_ot).length, 1);
    assert.equal((await q(pool, "SELECT COUNT(*) AS n FROM attendance_ot_late_settlement"))[0].n, 1);
  });

  it("a Reset of October releases it; the next calculation takes it again", async () => {
    const reset = await usecase.reset({ year: 2026, month: 10, employee_ids: [LATE], reason: "WRONG_OT", mode: "INDIVIDUAL", actor: ACTOR });
    assert.equal(reset.reset_count === undefined ? 1 : reset.reset_count, 1, JSON.stringify(reset));
    assert.equal((await settlement()).settlement_status, "PENDING_SETTLEMENT");
    await usecase.calculate({ year: 2026, month: 10, employee_ids: [LATE], actor: ACTOR });
    const s = await settlement();
    assert.deepEqual([s.settlement_status, s.settlement_month], ["INCLUDED", 10]);
  });

  it("Approve & Lock of October SETTLES it; an Unlock un-settles it; a re-lock settles it again", async () => {
    let approved = await usecase.approve({ year: 2026, month: 10, employee_ids: [LATE, CONTROL], actor: ACTOR });
    assert.equal(approved.approved_count, 2, JSON.stringify(approved.results));
    let s = await settlement();
    assert.equal(s.settlement_status, "SETTLED");
    assert.equal(Number(s.settlement_payrun_calculation_id), Number((await row(LATE, 10)).payrun_calculation_id));

    await usecase.lifecycle({ action: "UNLOCK", year: 2026, month: 10, employee_ids: [LATE], reason: "Correction after review", mode: "INDIVIDUAL", actor: ACTOR });
    assert.equal((await settlement()).settlement_status, "INCLUDED");
    approved = await usecase.approve({ year: 2026, month: 10, employee_ids: [LATE], actor: ACTOR });
    assert.equal(approved.approved_count, 1, JSON.stringify(approved.results));
    s = await settlement();
    assert.equal(s.settlement_status, "SETTLED");
  });

  it("a late approval arriving while October is LOCKED but not yet published does not block its Publish; it waits for the next open month", async () => {
    const octBefore = JSON.stringify(await row(LATE, 10));
    await q(pool, `INSERT INTO attendance_ot_late_settlement
        (attendance_approval_request_id, employee_id, attendance_date, source_year, source_month,
         eligible_ot_minutes, approved_ot_minutes, source_daily_rate, nrm_minutes, ot_hourly_rate, amount, settlement_status)
      VALUES (?, ?, '2026-09-12', 2026, 9, 60, 60, 800, 480, 100, 100, 'PENDING_SETTLEMENT')`, [REQUEST_LATER, LATE]);
    // October's locked figures, and the items it reads, are exactly what it was locked with.
    const items = await calcRepo.listLateOtForSettlement([LATE], 2026, 10);
    assert.deepEqual(items.map((i) => Number(i.attendance_approval_request_id)), [REQUEST], "a locked month reads only its own items");
    assert.equal(JSON.stringify(await row(LATE, 10)), octBefore);
    // ...and November, still open, sees the new one.
    const nov = await calcRepo.listLateOtForSettlement([LATE], 2026, 11);
    assert.deepEqual(nov.map((i) => Number(i.attendance_approval_request_id)), [REQUEST_LATER]);
  });

  it("11. the published payslip shows 'Prior-Month OT — Sep 2026: 120 min' as its own line", async () => {
    const published = await usecase.lifecycle({ action: "PUBLISH", year: 2026, month: 10, employee_ids: [LATE], mode: "INDIVIDUAL", actor: ACTOR });
    assert.ok(JSON.stringify(published).includes("PUBLISH"), JSON.stringify(published));
    const slip = await usecase.getPayslip({ year: 2026, month: 10, employee_id: LATE });
    assert.ok(slip.payslip, JSON.stringify(slip));
    const snapshot = slip.payslip.snapshot;
    const lines = snapshot.earnings.lines;
    const prior = lines.find((l) => /^Prior-Month OT — Sep 2026: 120 min$/.test(l.label));
    assert.ok(prior, JSON.stringify(lines.map((l) => l.label)));
    assert.equal(Number(prior.amount), 200);
    assert.ok(!lines.some((l) => l.key === "arrears" && Number(l.amount) > 0));
    assert.equal(snapshot.attendance.prior_month_ot[0].attendance_date, "2026-09-10");
  });

  it("6. November does not pay it again - it pays only the OT approved after October locked", async () => {
    at("2026-12-03");
    const nov = await usecase.calculate({ year: 2026, month: 11, all_eligible: true, actor: ACTOR });
    assert.equal(nov.calculated_count, 2, JSON.stringify(nov.results));
    const late = await row(LATE, 11);
    assert.deepEqual(JSON.parse(late.prior_month_ot).map((i) => i.attendance_approval_request_id), [REQUEST_LATER], "never 501 again");
    assert.equal(Number(late.prior_month_ot_amount), 100);
    assert.equal(Number(late.total_earnings), Number((await row(CONTROL, 11)).total_earnings) + 100);
    for (const k of ["esi_wage", "employee_esi", "employer_esi", "pf_wage", "eps_wage", "edli_wage"]) {
      assert.equal(String(late[k]), String((await row(CONTROL, 11))[k]), k);
    }
    assert.equal((await q(pool, "SELECT COUNT(*) AS n FROM attendance_ot_late_settlement WHERE settlement_status = 'SETTLED'"))[0].n, 1,
      "11. paid once: one settlement, settled in October only");
  });

  it("8. the whole journey is on record: request, original date/month/minutes, price, settlement month", async () => {
    const s = await settlement();
    assert.equal(s.attendance_date instanceof Date ? s.attendance_date.toISOString().slice(0, 10) : String(s.attendance_date).slice(0, 10), "2026-09-10");
    assert.deepEqual([s.source_year, s.source_month, s.eligible_ot_minutes, s.approved_ot_minutes, Number(s.amount), s.settlement_month], [2026, 9, 120, 120, 200, 10]);
    assert.deepEqual(await log(), [
      "PENDING_SETTLEMENT>INCLUDED@10",
      "INCLUDED>PENDING_SETTLEMENT@10",
      "PENDING_SETTLEMENT>INCLUDED@10",
      "INCLUDED>SETTLED@10",
      "SETTLED>INCLUDED@10",
      "INCLUDED>SETTLED@10",
    ]);
  });

  it("it is impossible to settle the same OT twice: the database refuses a second settlement row", async () => {
    await assert.rejects(
      q(pool, `INSERT INTO attendance_ot_late_settlement
          (attendance_approval_request_id, employee_id, attendance_date, source_year, source_month,
           eligible_ot_minutes, approved_ot_minutes, source_daily_rate, nrm_minutes, ot_hourly_rate, amount)
        VALUES (?, ?, '2026-09-10', 2026, 9, 120, 120, 800, 480, 100, 200)`, [REQUEST, LATE]),
      (err) => err.code === "ER_DUP_ENTRY"
    );
    // ...and is tied to a real OT request, which cannot be deleted from under it.
    await assert.rejects(
      q(pool, `INSERT INTO attendance_ot_late_settlement
          (attendance_approval_request_id, employee_id, attendance_date, source_year, source_month,
           eligible_ot_minutes, approved_ot_minutes, source_daily_rate, nrm_minutes, ot_hourly_rate, amount)
        VALUES (999999, ?, '2026-09-10', 2026, 9, 120, 120, 800, 480, 100, 200)`, [LATE]),
      (err) => err.code === "ER_NO_REFERENCED_ROW_2"
    );
    await assert.rejects(
      q(pool, "DELETE FROM attendance_approval_request WHERE attendance_approval_request_id = ?", [REQUEST]),
      (err) => err.code === "ER_ROW_IS_REFERENCED_2"
    );
  });

  it("a claim that moved under a calculation rolls the whole save back", async () => {
    // A second late OT, already taken by DECEMBER, cannot also be claimed by
    // November: the save of November's row is refused and nothing moves.
    await q(pool, `INSERT INTO attendance_ot_late_settlement
        (attendance_approval_request_id, employee_id, attendance_date, source_year, source_month,
         eligible_ot_minutes, approved_ot_minutes, source_daily_rate, nrm_minutes, ot_hourly_rate, amount,
         settlement_status, settlement_year, settlement_month)
      VALUES (502, ?, '2026-09-11', 2026, 9, 60, 60, 800, 480, 100, 100, 'INCLUDED', 2026, 12)`, [LATE]);
    const [taken] = await q(pool, "SELECT late_settlement_id FROM attendance_ot_late_settlement WHERE attendance_approval_request_id = 502");
    const nov = await row(LATE, 11);
    const { PayrunCalculationRepository } = require("./payrun_calculation");
    const crafted = Object.fromEntries(PayrunCalculationRepository.COLUMNS.map((c) => [c, nov[c] === undefined ? null : nov[c]]));
    crafted.net_pay = Number(nov.net_pay) + 100; // what a claim would have changed
    crafted.late_ot_settlement_ids = [taken.late_settlement_id];
    const before = JSON.stringify(nov);
    await assert.rejects(calcRepo.saveCalculations([crafted]), (err) => err.code === "PRIOR_MONTH_OT_MOVED");
    assert.equal(JSON.stringify(await row(LATE, 11)), before, "November's row was not written");
    const s502 = (await q(pool, "SELECT settlement_status, settlement_month FROM attendance_ot_late_settlement WHERE attendance_approval_request_id = 502"))[0];
    assert.deepEqual([s502.settlement_status, s502.settlement_month], ["INCLUDED", 12]);
  });

  it("Approve & Lock refuses, under its lock, a calculation whose Prior-Month OT was revoked after it was calculated", async () => {
    // November pays 503 (INCLUDED). A revoke CANCELS it between the reviewer's
    // read and the lock - the race, so the repository is called as the usecase would.
    const nov = await row(LATE, 11);
    assert.deepEqual(JSON.parse(nov.prior_month_ot).map((i) => i.attendance_approval_request_id), [REQUEST_LATER]);
    await q(pool, "UPDATE attendance_ot_late_settlement SET settlement_status = 'CANCELLED' WHERE attendance_approval_request_id = ?", [REQUEST_LATER]);
    const [out] = await calcRepo.approve({
      year: 2026, month: 11, employees: [{ employee_id: LATE, calculation_hash: nov.calculation_hash }], approved_by: 77,
    });
    assert.equal(out.outcome, "PRIOR_MONTH_OT_MOVED");
    assert.equal((await row(LATE, 11)).status, nov.status, "not locked");
    const s503 = (await q(pool, "SELECT settlement_status FROM attendance_ot_late_settlement WHERE attendance_approval_request_id = ?", [REQUEST_LATER]))[0];
    assert.equal(s503.settlement_status, "CANCELLED", "a cancelled item is never settled");
    // Recalculated, November no longer pays it, and approves.
    await usecase.calculate({ year: 2026, month: 11, employee_ids: [LATE], mode: "RECALCULATE", actor: ACTOR });
    assert.equal((await row(LATE, 11)).prior_month_ot_amount, null);
    const approved = await usecase.approve({ year: 2026, month: 11, employee_ids: [LATE], actor: ACTOR });
    assert.equal(approved.approved_count, 1, JSON.stringify(approved.results));
  });
});
