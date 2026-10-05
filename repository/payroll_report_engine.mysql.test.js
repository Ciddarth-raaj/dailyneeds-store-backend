/**
 * Payroll Reports against a REAL, ENGINE-CALCULATED, COMPLETED payroll month.
 *
 *   ATTENDANCE_TEST_MYSQL=mysql://user:pass@localhost/scratch_db \
 *     node --test repository/payroll_report_engine.mysql.test.js
 *
 * SKIPPED unless `ATTENDANCE_TEST_MYSQL` names a SCRATCH database.
 *
 * Nothing here writes a payroll figure by hand. The production payrun usecase
 * and repositories CALCULATE and APPROVE & LOCK every employee (real salary
 * engine, real PF / ESI, real attendance reads), and only then is the
 * Payroll Reports service pointed at the same database. Every report total
 * is reconciled to the payrun's stored figures, and the ECR and ESIC files
 * to the same figures - so the report is proved to be a formatter of the
 * finalized payrun and never a second payroll calculation.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");

const URL = process.env.ATTENDANCE_TEST_MYSQL;
const buildCalculation = require("../usecase/payrun_calculation");
const { dayRowsSql, dayRowsFingerprint } = require("../utils/attendance_month_freshness");
const { SQLS, MIGRATIONS, TABLES, STAND_INS } = require("../test_support/payrun_mysql_fixture");

const YEAR = 2026;
const MONTH = 8; // a month wholly before the 2026 ceiling revision
const DAYS = Array.from({ length: 31 }, (_, i) => `2026-08-${String(i + 1).padStart(2, "0")}`);
const ACTOR = { employeeId: 77, userId: 7 };
const ADMIN = { userId: 5, employeeId: 50, isAdmin: true, permissions: [] };

/**
 * A realistic mix: ESI-covered and not, two outlets, different attendance.
 * [id, name, store, gross, basic, conveyance, hra, special, esi_applicable, present_days]
 */
const STAFF = [
  [1, "Asha K", 1, 12000, 6000, 1600, 2400, 2000, 1, 27],
  [2, "Babu R", 1, 15500, 7750, 1600, 3100, 3050, 1, 25],
  [3, "Chitra S", 2, 19800, 9900, 1600, 3960, 4340, 1, 20],
  [4, "Devi M", 2, 26013.37, 13006.69, 2500, 5000, 5506.68, 0, 27],
  [5, "Elango P", 1, 42000, 21000, 1600, 8400, 11000, 0, 26],
];

const EXTRA_DDL = [
  "ALTER TABLE new_employee ADD COLUMN previous_pf_member TINYINT(1) NULL, ADD COLUMN pf_number VARCHAR(45) NULL, ADD COLUMN status TINYINT(1) DEFAULT 1, ADD COLUMN ifsc VARCHAR(20) NULL",
];
const REPORT_MIGRATIONS = [
  "20261120120000-epfo-wage-ceiling-2026-up.sql",
  "20260909160000-reports-foundation-up.sql",
  "20261122120000-payroll-reports-up.sql",
];
const REPORT_TABLES = ["payroll_report_default_template", "payroll_report_layout", "report_export_log", "report_template"];

const q = (pool, sql, params = []) =>
  new Promise((resolve, reject) => pool.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));

describe("payroll reports on an engine-calculated, completed month", { skip: !URL && "ATTENDANCE_TEST_MYSQL is not set" }, () => {
  let pool;
  let service;

  before(async () => {
    pool = require("mysql").createPool(`${URL}?connectionLimit=6&multipleStatements=true`);
    await q(pool, "SET FOREIGN_KEY_CHECKS = 0");
    for (const t of [...REPORT_TABLES, ...TABLES]) await q(pool, `DROP TABLE IF EXISTS \`${t}\``);
    await q(pool, "SET FOREIGN_KEY_CHECKS = 1");
    for (const ddl of STAND_INS) await q(pool, ddl);
    for (const ddl of EXTRA_DDL) await q(pool, ddl);
    for (const file of MIGRATIONS) await q(pool, fs.readFileSync(path.join(SQLS, file), "utf8"));
    for (const file of REPORT_MIGRATIONS) await q(pool, fs.readFileSync(path.join(SQLS, file), "utf8"));
    await q(pool, "INSERT INTO department VALUES (3, 'Grocery', 1)");

    for (const [id, name, store, gross, basic, conv, hra, special, esi, present] of STAFF) {
      const uan = `1002003004${String(id).padStart(2, "0")}`;
      const ip = `31000000${String(id).padStart(2, "0")}`;
      await q(pool, `INSERT INTO new_employee
          (employee_id, employee_name, store_id, pf_applicable, esi_applicable, previous_eps_member, previous_pf_member,
           dob, date_of_joining, uan, pf_number, esi_number, attendance_required, bank_name, account_no, ifsc, pan_no, department_id, status)
        VALUES (?, ?, ?, 1, ?, 0, 0, '1990-06-15', '2018-04-01', ?, ?, ?, 1, 'State Bank', '123456789012', 'SBIN0000001', 'ABCDE1234F', 3, 1)`,
      [id, name, store, esi, uan, `TN/MAS/1/${id}`, esi ? ip : null]);
      const s = await q(pool, `INSERT INTO employee_salary (employee_id, monthly_gross, daily_salary, basic, conveyance, hra, special_allowance, effective_from, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, '2026-04-01', 'APPROVED')`, [id, gross, Math.round((gross / 26) * 100) / 100, basic, conv, hra, special]);
      const pe = await q(pool, `INSERT INTO payrun_employee
          (period_year, period_month, employee_id, employee_name, store_id, store_name, department_id, date_of_joining,
           salary_id, salary_effective_from, monthly_gross, daily_salary, basic, conveyance, hra, special_allowance,
           pf_applicable, esi_applicable, uan, pf_number, esi_number, pay_type, pay_type_source)
        VALUES (?, ?, ?, ?, ?, ?, 3, '2018-04-01', ?, '2026-04-01', ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 'BANK', 'EMPLOYEE_MASTER')`,
      [YEAR, MONTH, id, name, store, store === 1 ? "Moolakulam" : "Town", s.insertId, gross, Math.round((gross / 26) * 100) / 100,
        basic, conv, hra, special, esi, uan, `TN/MAS/1/${id}`, esi ? ip : null]);
      await q(pool, `INSERT INTO payrun_employee_adjustment_state
          (payrun_employee_id, period_year, period_month, employee_id, confirmed_no_adjustment, confirmed_by) VALUES (?, ?, ?, ?, 1, 9)`,
      [pe.insertId, YEAR, MONTH, id]);
      for (const [i, d] of DAYS.entries()) {
        const here = i < present;
        await q(pool, `INSERT INTO attendance_day_calculation
            (employee_id, attendance_date, nrm_minutes, break_allowance_source, is_final, approved_ot_minutes,
             status, attendance_day_count, base_nrm_minutes, worked_minutes)
          VALUES (?, ?, 480, 'SHIFT', 1, 0, ?, ?, 480, ?)`, [id, d, here ? "FINAL" : "ABSENT", here ? 1 : 0, here ? 480 : 0]);
      }
      const stored = await q(pool, dayRowsSql(), [id, DAYS[0], DAYS[30]]);
      const base = 27; // 31 days less floor(31 / 7) notional offs
      const salaryDays = Math.min(present, base);
      const daily = Math.round((gross / 26) * 100) / 100;
      await q(pool, `INSERT INTO attendance_monthly_payroll
          (employee_id, period_year, period_month, is_final, payroll_version, salary_days, extra_days, base_days,
           monthly_gross, daily_rate, salary_day_earnings, extra_day_earnings, shortage_minutes, missing_minute_deduction,
           approved_ot_minutes, approved_ot_earnings, calculated_at, day_rows_fingerprint)
         VALUES (?, ?, ?, 1, 1, ?, 0, ?, ?, ?, ?, 0, 0, 0, 0, 0, '2026-09-01 02:00:00.000', ?)`,
      [id, YEAR, MONTH, salaryDays, base, gross, daily, Math.round(daily * salaryDays * 100) / 100, dayRowsFingerprint(stored)]);
    }

    // THE PAYROLL ENGINE does the month: calculate, then approve & lock all.
    const usecase = buildCalculation(
      require("./payrun_calculation")(pool),
      require("./payrun")(pool),
      require("./payrun_adjustment")(pool)
    );
    usecase.today = () => "2026-09-03";
    const calculated = await usecase.calculate({ year: YEAR, month: MONTH, all_eligible: true, actor: ACTOR });
    assert.equal(calculated.calculated_count, STAFF.length, JSON.stringify(calculated.results));
    const approved = await usecase.approve({ year: YEAR, month: MONTH, employee_ids: STAFF.map((s) => s[0]), actor: ACTOR });
    assert.equal(approved.approved_count, STAFF.length, JSON.stringify(approved.results));

    service = require("../usecase/payroll_report_service")(require("./payroll_report")(pool), require("./report_template")(pool), {
      withBrowser: (fn) => fn({ renderPdf: async () => Buffer.from("%PDF") }),
    });
  });

  after(async () => {
    if (!pool) return;
    await q(pool, "SET FOREIGN_KEY_CHECKS = 0");
    for (const t of [...REPORT_TABLES, ...TABLES]) await q(pool, `DROP TABLE IF EXISTS \`${t}\``);
    await q(pool, "SET FOREIGN_KEY_CHECKS = 1");
    pool.end();
  });

  /** The payrun's stored figures, summed straight from the payrun tables. */
  const payrun = async () => {
    const [r] = await q(pool, `SELECT COUNT(*) AS employees,
        SUM(c.status = 'APPROVED_LOCKED') AS finalized,
        SUM(c.total_earnings) AS gross, SUM(c.total_employee_deductions) AS deductions, SUM(c.net_pay) AS net_pay,
        SUM(c.employee_pf) AS employee_pf, SUM(c.employer_pf_total) AS employer_pf_total,
        SUM(c.employer_eps) AS employer_eps, SUM(c.employer_epf) AS employer_epf,
        SUM(c.employee_esi) AS employee_esi, SUM(c.employer_esi) AS employer_esi,
        SUM(c.pf_wage) AS epf_wages, SUM(c.esi_wage) AS esi_wages
      FROM payrun_employee pe JOIN payrun_employee_calculation c ON c.payrun_employee_id = pe.payrun_employee_id
      WHERE pe.period_year = ? AND pe.period_month = ?`, [YEAR, MONTH]);
    const out = {};
    for (const [k, v] of Object.entries(r)) out[k] = Math.round(Number(v || 0) * 100) / 100;
    return out;
  };
  const report = (report_type, field_keys, store_ids = null) =>
    service.preview(ADMIN, { report_type, year: YEAR, month: MONTH, field_keys, page_size: 200 }, store_ids);

  let totals = null;

  it("the month is COMPLETE: every payrun employee is approved & locked by the engine", async () => {
    totals = await payrun();
    assert.equal(totals.employees, STAFF.length);
    assert.equal(totals.finalized, STAFF.length);
    assert.ok(totals.net_pay > 0 && totals.employee_pf > 0 && totals.employee_esi > 0, JSON.stringify(totals));
  });

  it("PAYROLL REGISTER == FINALIZED PAYRUN: employee count, gross, deductions, net pay", async () => {
    const p = await report("PAYROLL_REGISTER", ["employee_id", "gross_salary", "total_deductions", "net_pay"]);
    assert.equal(p.matching_count, totals.employees);
    assert.equal(p.not_finalized_count, 0);
    assert.equal(p.totals.gross_salary, totals.gross);
    assert.equal(p.totals.total_deductions, totals.deductions);
    assert.equal(p.totals.net_pay, totals.net_pay);
    assert.equal(p.reconciliation.reconciled, true);
    // And the rows add up to the totals.
    const sum = (k) => Math.round(p.rows.reduce((a, r) => a + r[k], 0) * 100) / 100;
    assert.deepEqual([sum("gross_salary"), sum("total_deductions"), sum("net_pay")], [totals.gross, totals.deductions, totals.net_pay]);
    console.log(`# RECONCILED register: employees=${p.matching_count} gross=${p.totals.gross_salary} deductions=${p.totals.total_deductions} net=${p.totals.net_pay}`);
  });

  it("EPF: employee, employer, EPS and EPF-difference totals equal the payrun's - and the ECR's", async () => {
    const p = await report("EPF", ["employee_id", "epf_wages", "employee_pf", "employer_pf_total", "employer_eps", "employer_epf"]);
    assert.equal(p.matching_count, STAFF.length);
    assert.equal(p.totals.epf_wages, totals.epf_wages);
    assert.equal(p.totals.employee_pf, totals.employee_pf);
    assert.equal(p.totals.employer_pf_total, totals.employer_pf_total);
    assert.equal(p.totals.employer_eps, totals.employer_eps);
    assert.equal(p.totals.employer_epf, totals.employer_epf);
    assert.equal(Math.round((p.totals.employer_eps + p.totals.employer_epf) * 100) / 100, totals.employer_pf_total);

    const ecr = await service.ecrFile(ADMIN, { year: YEAR, month: MONTH }, null);
    const lines = ecr.buffer.toString().split("\n").map((l) => l.split("#~#").map((v, i) => (i < 2 ? v : Number(v))));
    assert.equal(lines.length, STAFF.length, "every PF member, nobody left out");
    const col = (i) => lines.reduce((a, l) => a + l[i], 0);
    // The engine stores whole-rupee contributions, so the file equals them exactly.
    assert.equal(col(6), totals.employee_pf);
    assert.equal(col(7), totals.employer_eps);
    assert.equal(col(8), totals.employer_epf);
    console.log(`# RECONCILED EPF: ee=${totals.employee_pf} er_total=${totals.employer_pf_total} eps=${totals.employer_eps} epf_diff=${totals.employer_epf} epf_wages=${totals.epf_wages}`);
  });

  it("ESI: employee and employer contribution totals equal the payrun's; the ESIC file carries the same wages", async () => {
    const p = await report("ESI", ["employee_id", "esi_wages", "employee_esi", "employer_esi"]);
    const covered = await q(pool, "SELECT COUNT(*) n FROM payrun_employee_calculation WHERE esi_status <> 'NOT_APPLICABLE' AND period_month = ?", [MONTH]);
    assert.equal(p.matching_count, Number(covered[0].n));
    assert.equal(p.totals.employee_esi, totals.employee_esi);
    assert.equal(p.totals.employer_esi, totals.employer_esi);
    assert.equal(p.totals.esi_wages, totals.esi_wages);

    const file = await service.esicFile(ADMIN, { year: YEAR, month: MONTH }, null);
    const rows = XLSX.utils.sheet_to_json(XLSX.read(file.buffer, { type: "buffer" }).Sheets.Sheet1, { header: 1, raw: true, defval: null });
    assert.equal(rows.length - 1, p.matching_count, "every ESI-covered employee, nobody left out");
    assert.equal(Math.round(rows.slice(1).reduce((a, r) => a + r[3], 0) * 100) / 100, totals.esi_wages);
    console.log(`# RECONCILED ESI: covered=${p.matching_count} ee=${totals.employee_esi} er=${totals.employer_esi} wages=${totals.esi_wages}`);
  });

  it("per outlet, the register still reconciles to the payrun", async () => {
    const p = await report("PAYROLL_REGISTER", ["employee_id", "net_pay"], [2]);
    const [r] = await q(pool, `SELECT COUNT(*) n, SUM(c.net_pay) np FROM payrun_employee pe JOIN payrun_employee_calculation c
      ON c.payrun_employee_id = pe.payrun_employee_id WHERE pe.store_id = 2 AND pe.period_month = ?`, [MONTH]);
    assert.equal(p.matching_count, Number(r.n));
    assert.equal(p.totals.net_pay, Number(r.np));
    assert.equal(p.reconciliation.reconciled, true);
  });

  it("opening reports and generating files changed NO payrun figure", async () => {
    assert.deepEqual(await payrun(), totals);
  });
});
