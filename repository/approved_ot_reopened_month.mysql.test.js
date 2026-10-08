/**
 * APPROVED OT OF A MONTH THAT WAS LOCKED WHEN IT WAS APPROVED, AND THEN
 * UNLOCKED AGAIN - as real SQL, through the production payroll usecase and
 * repositories.
 *
 *   ATTENDANCE_TEST_MYSQL=mysql://user:pass@localhost/scratch_db \
 *     node --test repository/approved_ot_reopened_month.mysql.test.js
 *
 * SKIPPED unless `ATTENDANCE_TEST_MYSQL` names a SCRATCH database.
 *
 * THE INCIDENT (Pavadai N, September 2026). September was calculated and
 * Approved & Locked. 28 minutes of OT on 30 September were then approved:
 * the month was locked, so the approval parked them as Prior-Month OT
 * (`attendance_ot_late_settlement`, PENDING_SETTLEMENT) and the day row pays
 * 0 so they can never be paid twice. September was then UNLOCKED. Attendance
 * said "OT Approved: 00:28", but the parked minutes only ever looked for a
 * LATER month, so September's payroll read Approved OT 0, OT Amount 0.00 and
 * READY_FOR_APPROVAL - the minutes had silently left the reopened month.
 *
 * The figures are the incident's: Monthly Gross 30,000 (Daily Rate 1,153.85),
 * Effective NRM 570 min, 28 approved minutes -> 121.46 an hour, 56.68.
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
const OT = 1; // Pavadai's case: 28 approved minutes on 30 September
const CONTROL = 2; // identical, no OT at all (zero OT)
const WITHDRAWN = 3; // identical, OT approved after lock and then revoked
const REQUEST = 601;
const REQUEST_WITHDRAWN = 602;
const OT_DATE = "2026-09-30";
const EPFO = "20261120120000-epfo-wage-ceiling-2026-up.sql";
const CARRY = "20261126120000-attendance-ot-late-settlement-up.sql";

const q = (pool, sql, params = []) =>
  new Promise((resolve, reject) => pool.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));
const daysOf = (year, month) => {
  const n = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return Array.from({ length: n }, (_, i) => `${year}-${String(month).padStart(2, "0")}-${String(i + 1).padStart(2, "0")}`);
};

const EMPLOYEE_DDL = `CREATE TABLE new_employee (
  employee_id INT PRIMARY KEY, employee_name VARCHAR(100), store_id INT,
  pf_applicable TINYINT(1), esi_applicable TINYINT(1), previous_eps_member TINYINT(1), previous_pf_member TINYINT(1),
  dob DATE, date_of_joining VARCHAR(40), resignation_date DATE NULL,
  uan VARCHAR(45), esi_number VARCHAR(45), pf_number VARCHAR(45), attendance_required TINYINT(1) DEFAULT 1,
  bank_name VARCHAR(100) NULL, account_no VARCHAR(45) NULL, pan_no VARCHAR(20) NULL,
  department_id INT NULL
) ENGINE=InnoDB`;

describe("Approved OT of a reopened month over real SQL", { skip: !URL && "ATTENDANCE_TEST_MYSQL is not set" }, () => {
  let pool;
  let usecase;
  let calcRepo;
  let price;
  const row = async (id, month) =>
    (await q(pool, "SELECT * FROM payrun_employee_calculation WHERE employee_id = ? AND period_year = 2026 AND period_month = ?", [id, month]))[0];
  const settlement = async (request = REQUEST) =>
    (await q(pool, "SELECT * FROM attendance_ot_late_settlement WHERE attendance_approval_request_id = ?", [request]))[0];
  const at = (today) => {
    usecase.today = () => today;
  };

  const seedMonth = async (year, month) => {
    const days = daysOf(year, month);
    for (const id of [OT, CONTROL, WITHDRAWN]) {
      const [salary] = await q(pool, "SELECT salary_id FROM employee_salary WHERE employee_id = ?", [id]);
      const pe = await q(pool, `INSERT INTO payrun_employee
        (period_year, period_month, employee_id, employee_name, store_id, store_name, date_of_joining,
         salary_id, salary_effective_from, monthly_gross, daily_salary, basic, conveyance, hra, special_allowance,
         pf_applicable, esi_applicable, uan, esi_number, pay_type, pay_type_source)
        VALUES (?, ?, ?, ?, 1, 'Moolakulam', '2018-04-01', ?, '2026-04-01', 30000, 1153.85, 15000, 2000, 6000, 7000,
                1, 0, '100200300400', NULL, 'BANK', 'EMPLOYEE_MASTER')`, [year, month, id, `E${id}`, salary.salary_id]);
      await q(pool, "INSERT INTO payrun_employee_adjustment_state (payrun_employee_id, period_year, period_month, employee_id, confirmed_no_adjustment, confirmed_by) VALUES (?, ?, ?, ?, 1, 9)", [pe.insertId, year, month, id]);
      for (const [i, d] of days.entries()) {
        const worked = i < 26 || d === OT_DATE;
        // The OT date's day row pays 0: OT approved while its month is locked
        // is settled through `attendance_ot_late_settlement`, never the day.
        await q(pool, `INSERT INTO attendance_day_calculation
            (employee_id, attendance_date, nrm_minutes, break_allowance_source, is_final, approved_ot_minutes,
             status, attendance_day_count, base_nrm_minutes, worked_minutes)
          VALUES (?, ?, 570, 'SHIFT', 1, 0, ?, ?, 570, ?)`, [id, d, worked ? "FINAL" : "ABSENT", worked ? 1 : 0, worked ? 570 : 0]);
      }
      const stored = await q(pool, dayRowsSql(), [id, days[0], days[days.length - 1]]);
      await q(pool, `INSERT INTO attendance_monthly_payroll
          (employee_id, period_year, period_month, is_final, payroll_version, salary_days, extra_days, base_days,
           monthly_gross, daily_rate, salary_day_earnings, extra_day_earnings, shortage_minutes, missing_minute_deduction,
           approved_ot_minutes, approved_ot_earnings, calculated_at, day_rows_fingerprint)
         VALUES (?, ?, ?, 1, 1, 26, 0, 26, 30000, 1153.85, 30000, 0, 0, 0, 0, 0, '2026-10-01 02:00:00.000', ?)`,
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

    for (const id of [OT, CONTROL, WITHDRAWN]) {
      await q(pool, `INSERT INTO new_employee (employee_id, employee_name, store_id, pf_applicable, esi_applicable,
          previous_eps_member, previous_pf_member, dob, date_of_joining, uan, esi_number, pf_number, attendance_required,
          bank_name, account_no, pan_no, department_id)
        VALUES (?, ?, 1, 1, 0, 0, 0, '1990-06-15', '2018-04-01', '100200300400', NULL, 'TN/MAS/1/1', 1, 'State Bank', '123456789012', 'ABCDE1234F', 3)`, [id, `E${id}`]);
      await q(pool, "INSERT INTO employee_salary (employee_id, monthly_gross, daily_salary, basic, conveyance, hra, special_allowance, effective_from, status) VALUES (?, 30000, 1153.85, 15000, 2000, 6000, 7000, '2026-04-01', 'APPROVED')", [id]);
    }
    await q(pool, "INSERT INTO department VALUES (3, 'Grocery', 1)");
    await q(pool, `INSERT INTO company_details (company_name, reg_address, contact_number, gst_number, pan_number, esi_number, tan_number, pf_number)
                   VALUES ('Daily Needs Departmental Store', '188/1 Iyyanar Koil Street', '-', '-', '-', '51000123450001001', '-', 'TN/MAS/0012345')`);
    await seedMonth(2026, 9);
    await seedMonth(2026, 10);

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

    // SEPTEMBER: calculated, Approved & LOCKED before the OT is decided.
    at("2026-10-03");
    const sep = await usecase.calculate({ year: 2026, month: 9, all_eligible: true, actor: ACTOR });
    assert.equal(sep.calculated_count, 3, JSON.stringify(sep.results));
    const lock = await usecase.approve({ year: 2026, month: 9, employee_ids: [OT, CONTROL, WITHDRAWN], actor: ACTOR });
    assert.equal(lock.approved_count, 3, JSON.stringify(lock.results));

    // THE APPROVAL WHILE LOCKED: 28 minutes on 30 September, priced on
    // September's locked basis exactly as `decideStage` prices it.
    const sepRow = await row(OT, 9);
    price = priceLateOt({ approved_ot_minutes: 28, daily_rate: sepRow.daily_rate, nrm_minutes: 570 });
    assert.equal(price.error, null);
    await q(pool, `INSERT INTO attendance_approval_request
        (attendance_approval_request_id, request_type, requested_for_employee_id, attendance_date, status, finalization_state, approved_ot_minutes)
      VALUES (?, 'OT', ?, ?, 'APPROVED', 'SETTLED', 28), (?, 'OT', ?, ?, 'APPROVED', 'SETTLED', 28)`,
    [REQUEST, OT, OT_DATE, REQUEST_WITHDRAWN, WITHDRAWN, OT_DATE]);
    for (const [request, id] of [[REQUEST, OT], [REQUEST_WITHDRAWN, WITHDRAWN]]) {
      await q(pool, `INSERT INTO attendance_ot_late_settlement
          (attendance_approval_request_id, employee_id, attendance_date, source_year, source_month,
           eligible_ot_minutes, approved_ot_minutes, source_payrun_calculation_id, source_daily_rate,
           nrm_minutes, ot_hourly_rate, amount, settlement_status, approved_by)
         VALUES (?, ?, ?, 2026, 9, 28, 28, ?, ?, 570, ?, ?, 'PENDING_SETTLEMENT', 7)`,
      [request, id, OT_DATE, sepRow.payrun_calculation_id, price.daily_rate, price.ot_hourly_rate, price.amount]);
    }
    // ...and the second one is revoked before any payroll took it.
    await q(pool, "UPDATE attendance_ot_late_settlement SET settlement_status = 'CANCELLED', cancelled_at = CURRENT_TIMESTAMP(3) WHERE attendance_approval_request_id = ?", [REQUEST_WITHDRAWN]);
  });

  after(async () => {
    if (!pool) return;
    await q(pool, "SET FOREIGN_KEY_CHECKS = 0");
    for (const t of TABLES) await q(pool, `DROP TABLE IF EXISTS \`${t}\``);
    await q(pool, "SET FOREIGN_KEY_CHECKS = 1");
    pool.end();
  });

  it("the price is the engine's own: 1,153.85 / 9.5 h = 121.46 an hour; 28 min = 56.68", () => {
    assert.equal(price.daily_rate, 1153.85);
    assert.equal(price.ot_hourly_rate, 121.46);
    assert.equal(price.amount, 56.68);
  });

  it("LOCKED PERIOD: while September is locked it takes nothing new, and its row is never touched", async () => {
    const before = JSON.stringify(await row(OT, 9));
    assert.deepEqual(await calcRepo.listLateOtForSettlement([OT], 2026, 9), []);
    await usecase.calculate({ year: 2026, month: 9, employee_ids: [OT], mode: "RECALCULATE", actor: ACTOR }).catch(() => null);
    assert.equal(JSON.stringify(await row(OT, 9)), before, "the locked September row is byte-identical");
    assert.equal((await settlement()).settlement_status, "PENDING_SETTLEMENT");
  });

  it("UNLOCKED: September is open again and its own approved OT makes the calculation stale - Approved OT changed, not Ready", async () => {
    for (const id of [OT, CONTROL, WITHDRAWN]) {
      await usecase.lifecycle({ action: "UNLOCK", year: 2026, month: 9, employee_ids: [id], reason: "OT approved after lock", mode: "INDIVIDUAL", actor: ACTOR });
    }
    assert.deepEqual(
      (await calcRepo.listLateOtForSettlement([OT, WITHDRAWN], 2026, 9)).map((i) => Number(i.attendance_approval_request_id)),
      [REQUEST],
      "the reopened month sees its own parked OT; a withdrawn one is never offered"
    );
    const detail = await usecase.getEmployee({ year: 2026, month: 9, employee_id: OT });
    assert.equal(detail.status, "RECALCULATION_REQUIRED", JSON.stringify(detail.status));
    assert.ok(
      (detail.recalculation_reasons || []).some((r) => r.code === "APPROVED_OT_CHANGED"),
      JSON.stringify(detail.recalculation_reasons)
    );
    // Zero OT and withdrawn OT: nothing moved under them, they stay ready.
    for (const id of [CONTROL, WITHDRAWN]) {
      const other = await usecase.getEmployee({ year: 2026, month: 9, employee_id: id });
      assert.notEqual(other.status, "RECALCULATION_REQUIRED", `${id}: ${JSON.stringify(other.recalculation_reasons)}`);
    }
  });

  it("RECALCULATION AFTER APPROVAL pays the 28 minutes in September: 56.68 in earnings and net pay, not in the PF wage", async () => {
    const recalc = await usecase.calculate({ year: 2026, month: 9, employee_ids: [OT, CONTROL, WITHDRAWN], mode: "RECALCULATE", actor: ACTOR });
    assert.ok(recalc.results.every((r) => ["RECALCULATED", "SKIPPED", "CALCULATED"].includes(r.result)), JSON.stringify(recalc.results));
    const ot = await row(OT, 9);
    const control = await row(CONTROL, 9);
    assert.equal(Number(ot.prior_month_ot_amount), 56.68);
    assert.deepEqual(JSON.parse(ot.prior_month_ot).map((i) => i.attendance_approval_request_id), [REQUEST]);
    assert.equal(Number(ot.approved_ot_minutes), 0, "the attendance month's own figure is not restated");
    assert.equal(Math.round((Number(ot.total_earnings) - Number(control.total_earnings)) * 100), 5668);
    for (const k of ["pf_wage", "eps_wage", "edli_wage", "employee_pf", "employer_epf", "employer_eps"]) {
      assert.equal(String(ot[k]), String(control[k]), `${k}: OT reaches no PF wage`);
    }
    const s = await settlement();
    assert.deepEqual([s.settlement_status, s.settlement_year, s.settlement_month], ["INCLUDED", 2026, 9]);
  });

  it("THE SCREEN shows the approved OT minutes, hours and amount as September's own OT", async () => {
    const detail = await usecase.getEmployee({ year: 2026, month: 9, employee_id: OT });
    assert.equal(detail.status, "READY_FOR_APPROVAL", JSON.stringify(detail.blockers));
    assert.equal(detail.approved_ot_hours, 0.4667, "the list's Approved OT column");
    const o = detail.breakup.ot;
    assert.equal(o.total_approved_ot_minutes, 28);
    assert.equal(o.total_approved_ot_hours, 0.4667);
    assert.equal(o.late_approved_ot_minutes, 28);
    assert.equal(Number(o.late_approved_ot_amount), 56.68);
    assert.equal(o.late_approved_ot[0].attendance_date, OT_DATE);
    assert.deepEqual(o.earlier_month_ot, [], "it is not prior-month OT");
    assert.equal(o.earlier_month_ot_amount, null);
  });

  it("ZERO OT and WITHDRAWN OT: nothing is paid, nothing is shown", async () => {
    for (const id of [CONTROL, WITHDRAWN]) {
      const r = await row(id, 9);
      assert.equal(r.prior_month_ot_amount, null, `${id}`);
      assert.equal(Number(r.ot_amount), 0, `${id}`);
      const o = (await usecase.getEmployee({ year: 2026, month: 9, employee_id: id })).breakup.ot;
      assert.equal(o.total_approved_ot_minutes, 0, `${id}`);
      assert.equal((await usecase.getEmployee({ year: 2026, month: 9, employee_id: id })).approved_ot_hours, 0, `${id}`);
      assert.equal(o.late_approved_ot_amount, null, `${id}`);
    }
    assert.equal((await settlement(REQUEST_WITHDRAWN)).settlement_status, "CANCELLED");
  });

  it("NO DOUBLE COUNT: recalculating September again keeps one item; October never pays it", async () => {
    await usecase.calculate({ year: 2026, month: 9, employee_ids: [OT], mode: "RECALCULATE", actor: ACTOR });
    assert.equal(JSON.parse((await row(OT, 9)).prior_month_ot).length, 1);
    at("2026-11-03");
    const oct = await usecase.calculate({ year: 2026, month: 10, all_eligible: true, actor: ACTOR });
    assert.equal(oct.calculated_count, 3, JSON.stringify(oct.results));
    assert.equal((await row(OT, 10)).prior_month_ot_amount, null, "October does not pay September's OT again");
    assert.equal(Number((await settlement()).settlement_month), 9);
  });

  it("Approve & Lock of September SETTLES it in September, and the payslip names it as this month's OT", async () => {
    const approved = await usecase.approve({ year: 2026, month: 9, employee_ids: [OT], actor: ACTOR });
    assert.equal(approved.approved_count, 1, JSON.stringify(approved.results));
    const s = await settlement();
    assert.deepEqual([s.settlement_status, s.settlement_month], ["SETTLED", 9]);
    await usecase.lifecycle({ action: "PUBLISH", year: 2026, month: 9, employee_ids: [OT], mode: "INDIVIDUAL", actor: ACTOR });
    const slip = await usecase.getPayslip({ year: 2026, month: 9, employee_id: OT });
    const lines = slip.payslip.snapshot.earnings.lines;
    const line = lines.find((l) => /^OT Approved After Lock — Sep 2026: 28 min$/.test(l.label));
    assert.ok(line, JSON.stringify(lines.map((l) => l.label)));
    assert.equal(Number(line.amount), 56.68);
    assert.ok(!lines.some((l) => /^Prior-Month OT/.test(l.label)));
  });
});
