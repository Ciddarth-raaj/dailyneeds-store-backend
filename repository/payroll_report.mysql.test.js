/**
 * Payroll Reports over REAL SQL.
 *
 *   ATTENDANCE_TEST_MYSQL=mysql://user:pass@localhost/scratch_db \
 *     node --test repository/payroll_report.mysql.test.js
 *
 * SKIPPED unless `ATTENDANCE_TEST_MYSQL` names a SCRATCH database: it drops
 * and recreates the tables it uses.
 *
 * The payrun tables, `report_template` / `report_export_log` and this
 * feature's own tables are built from the MIGRATION FILES THEMSELVES; the
 * masters and attendance tables are stand-ins with the production names and
 * the columns the catalogue reads. What it proves:
 *
 *   every catalogue field - all of them at once - is valid SQL
 *   only APPROVED_LOCKED rows of the asked month are reported
 *   attendance figures blank out once attendance is recalculated after payroll
 *   the month list, layouts, defaults and the statutory reads run as written
 *   the built-in templates are seeded and the new export formats are accepted
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const URL = process.env.ATTENDANCE_TEST_MYSQL;
const SQLS = path.join(__dirname, "..", "migrations/mysql/migrations/sqls");
const MIGRATIONS = [
  "20260909160000-reports-foundation-up.sql",
  "20261021120000-payrun-initialization-up.sql",
  "20261023120000-payrun-calculation-up.sql",
  "20261024120000-payrun-calculation-column-drift-up.sql",
  "20261111120000-payrun-lifecycle-up.sql",
  "20261120120000-epfo-wage-ceiling-2026-up.sql",
  "20261123120000-payroll-reports-up.sql",
];
const TABLES = [
  "payroll_report_default_template", "payroll_report_layout", "report_export_log", "report_template",
  "payrun_employee_lifecycle_audit", "payrun_employee_calculation_audit", "payrun_employee_calculation",
  "payrun_employee_pay_type_audit", "payrun_employee", "payrun_period", "all_permissions",
  "attendance_day_calculation", "attendance_monthly_payroll", "employee_attendance_calculation_mode",
  "employee_aadhaar_identity", "employee_bank_verification", "work_shift", "shift_master", "designation",
  "department", "outlets", "new_employee",
];
const STAND_INS = [
  `CREATE TABLE new_employee (
     employee_id INT PRIMARY KEY, employee_name VARCHAR(100), store_id INT, department_id INT, designation_id INT,
     shift_id INT, default_work_shift_id INT, uan VARCHAR(45), esi_number VARCHAR(45), pf_number VARCHAR(45),
     bank_name VARCHAR(100), account_no VARCHAR(45), ifsc VARCHAR(20), father_name VARCHAR(100), gender VARCHAR(10),
     dob DATE, marital_status VARCHAR(20), spouse_name VARCHAR(100), marriage_date VARCHAR(45), blood_group VARCHAR(10),
     status TINYINT(1) DEFAULT 1, employment_type VARCHAR(30), grade VARCHAR(5), extra_break_hours DECIMAL(4,2),
     attendance_required TINYINT(1) DEFAULT 1, works_all_locations TINYINT(1) DEFAULT 0,
     primary_contact_number VARCHAR(20), alternate_contact_number VARCHAR(20), email_id VARCHAR(100),
     permanent_address TEXT, residential_address TEXT, qualification VARCHAR(100), additional_course VARCHAR(100),
     previous_experience VARCHAR(100), pan_no VARCHAR(20), previous_pf_member TINYINT(1), previous_eps_member TINYINT(1),
     pf_applicable TINYINT(1), esi_applicable TINYINT(1), payment_type VARCHAR(5),
     date_of_joining DATE, resignation_date DATE
   ) ENGINE=InnoDB`,
  "CREATE TABLE outlets (outlet_id INT PRIMARY KEY, outlet_name VARCHAR(100), is_active TINYINT(1) DEFAULT 1) ENGINE=InnoDB",
  "CREATE TABLE department (department_id INT PRIMARY KEY, department_name VARCHAR(100), status TINYINT(1) DEFAULT 1) ENGINE=InnoDB",
  "CREATE TABLE designation (designation_id INT PRIMARY KEY, designation_name VARCHAR(100), status TINYINT(1) DEFAULT 1) ENGINE=InnoDB",
  "CREATE TABLE shift_master (shift_id INT PRIMARY KEY, shift_name VARCHAR(100)) ENGINE=InnoDB",
  "CREATE TABLE work_shift (work_shift_id INT PRIMARY KEY, shift_name VARCHAR(100)) ENGINE=InnoDB",
  "CREATE TABLE employee_aadhaar_identity (employee_id INT PRIMARY KEY, aadhaar_last4 CHAR(4), name_as_per_aadhaar VARCHAR(100)) ENGINE=InnoDB",
  "CREATE TABLE employee_bank_verification (employee_id INT PRIMARY KEY, status VARCHAR(20)) ENGINE=InnoDB",
  `CREATE TABLE employee_attendance_calculation_mode (
     employee_attendance_calculation_mode_id INT AUTO_INCREMENT PRIMARY KEY, employee_id INT, effective_from DATE,
     calculation_mode VARCHAR(30)) ENGINE=InnoDB`,
  `CREATE TABLE attendance_monthly_payroll (
     attendance_monthly_payroll_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, employee_id INT, period_year SMALLINT,
     period_month TINYINT, available_dates INT, notional_offs INT, base_days INT, attendance_days INT,
     calculated_at TIMESTAMP(3) NOT NULL) ENGINE=InnoDB`,
  `CREATE TABLE attendance_day_calculation (
     employee_id INT, attendance_date DATE, status VARCHAR(32), late_minutes INT NULL, early_exit_minutes INT NULL,
     PRIMARY KEY (employee_id, attendance_date)) ENGINE=InnoDB`,
  "CREATE TABLE all_permissions (permission_key VARCHAR(100)) ENGINE=InnoDB",
];

const ADMIN = { userId: 5, employeeId: 50, isAdmin: true, permissions: [] };

describe("payroll reports over real SQL", { skip: !URL && "ATTENDANCE_TEST_MYSQL is not set" }, () => {
  let pool;
  let repo;
  let service;
  const q = (sql, params = []) => new Promise((res, rej) => pool.query(sql, params, (e, r) => (e ? rej(e) : res(r))));

  before(async () => {
    pool = require("mysql").createPool(`${URL}?connectionLimit=4&multipleStatements=true`);
    await q("SET FOREIGN_KEY_CHECKS = 0");
    for (const t of TABLES) await q(`DROP TABLE IF EXISTS \`${t}\``);
    await q("SET FOREIGN_KEY_CHECKS = 1");
    for (const sql of STAND_INS) await q(sql);
    for (const file of MIGRATIONS) await q(fs.readFileSync(path.join(SQLS, file), "utf8"));
    // The migration is guarded: running it twice changes nothing.
    await q(fs.readFileSync(path.join(SQLS, "20261123120000-payroll-reports-up.sql"), "utf8"));

    await q("INSERT INTO outlets VALUES (1,'Outlet A',1),(2,'Outlet B',1)");
    await q("INSERT INTO department VALUES (3,'Billing',1)");
    await q(`INSERT INTO new_employee (employee_id, employee_name, store_id, department_id, uan, esi_number, bank_name, account_no, ifsc,
              primary_contact_number, pan_no, date_of_joining) VALUES
              (1,'Asha',1,3,'100200300400','1234567890','SBI','000111222333','SBIN0000001','9876543210','ABCDE1234F','2025-01-10'),
              (2,'Babu',2,3,NULL,NULL,'HDFC','999888777666','HDFC0000001','9876500000',NULL,'2025-02-10'),
              (3,'Chitra',1,3,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'2025-03-10')`);
    const pe = (id, y, m, store, extra = "") =>
      q(`INSERT INTO payrun_employee (period_year, period_month, employee_id, employee_name, store_id, store_name, department_id,
           date_of_joining, basic, hra, conveyance, special_allowance, pf_applicable, esi_applicable, uan, esi_number, pay_type, pay_type_source ${extra ? ", resignation_date" : ""})
         VALUES (?,?,?,?,?,?,3,'2025-01-10',10000,5000,0,5000,1,1,?,?,'BANK','EMPLOYEE_MASTER' ${extra ? ", ?" : ""})`,
        [y, m, id, ["", "Asha", "Babu (then)", "Chitra"][id], store, store === 1 ? "Outlet A" : "Outlet B", id === 1 ? "100200300400" : null, id === 1 ? "1234567890" : null, ...(extra ? [extra] : [])]);
    await pe(1, 2026, 9, 1);
    await pe(2, 2026, 9, 2);
    await pe(3, 2026, 9, 1);
    await pe(1, 2026, 10, 1);
    await q("INSERT INTO attendance_monthly_payroll VALUES (1,1,2026,9,30,4,26,25,'2026-10-01 10:00:00.123'),(2,2,2026,9,30,4,26,26,'2026-10-02 10:00:00.000')");
    await q("INSERT INTO attendance_day_calculation VALUES (1,'2026-09-02','ABSENT',NULL,NULL),(1,'2026-09-03','FINAL',12,0),(1,'2026-10-01','ABSENT',NULL,NULL)");
    const calc = (id, y, m, status, net, amp, ampAt) =>
      q(`INSERT INTO payrun_employee_calculation (payrun_employee_id, period_year, period_month, employee_id, source_hash, inputs_hash,
           salary_days, salary_earnings, total_earnings, total_employee_deductions, net_pay, pay_type, is_complete, calculation_version,
           calculation_hash, status, pf_status, pf_wage, eps_wage, edli_wage, employee_pf, employer_eps, employer_epf, ncp_days,
           esi_status, esi_wage, employee_esi, employer_esi, attendance_monthly_payroll_id, attendance_calculated_at, approved_ot_minutes)
         SELECT payrun_employee_id, ?, ?, ?, 'h', 'h', 25, 19230.77, 20000, 1913, ?, 'BANK', 1, 1, 'h', ?, 'APPLIED', 15000, 15000, 15000,
                1800, 1250, 550, 1, 'APPLIED', 15000, 113, 488, ?, ?, 90
           FROM payrun_employee WHERE period_year = ? AND period_month = ? AND employee_id = ?`,
        [y, m, id, net, status, amp, ampAt, y, m, id]);
    await calc(1, 2026, 9, "APPROVED_LOCKED", 18087, 1, "2026-10-01 10:00:00.123");
    // Attendance for employee 2 was recalculated AFTER the payrun read it.
    await calc(2, 2026, 9, "APPROVED_LOCKED", 18000, 2, "2026-09-30 09:00:00.000");
    await calc(3, 2026, 9, "CALCULATED", 17000, null, null);
    await calc(1, 2026, 10, "APPROVED_LOCKED", 18500, null, null);

    repo = require("./payroll_report")(pool);
    service = require("../usecase/payroll_report_service")(repo, require("./report_template")(pool), {
      withBrowser: (fn) => fn({ renderPdf: async () => Buffer.from("%PDF") }),
    });
  });

  after(() => new Promise((res) => (pool ? pool.end(res) : res())));

  it("every catalogue field, selected together, is valid SQL; every payrun employee of the month is reported", async () => {
    const catalogue = require("../constants/payroll_report_catalogue");
    const keys = catalogue.FIELDS.map((f) => f.key);
    const chunks = [];
    for (let i = 0; i < keys.length; i += 60) chunks.push(keys.slice(i, i + 60));
    for (const field_keys of chunks) {
      const preview = await service.preview(ADMIN, { report_type: "PAYROLL_REGISTER", year: 2026, month: 9, field_keys }, null);
      assert.equal(preview.matching_count, 3);
      assert.equal(preview.rows.length, 3);
      assert.equal(preview.not_finalized_count, 1);
      assert.equal(preview.reconciliation.reconciled, true);
    }
  });

  it("stored values come through unchanged, from the payrun snapshot where it has one", async () => {
    const p = await service.preview(ADMIN, { report_type: "PAYROLL_REGISTER", year: 2026, month: 9, field_keys: ["employee_id", "employee_name", "net_pay", "uan", "em_mobile", "department"] }, null);
    assert.deepEqual(p.rows[0], { employee_id: 1, employee_name: "Asha", net_pay: 18087, uan: "100200300400", em_mobile: "9876543210", department: "Billing" });
    assert.equal(p.rows[1].employee_name, "Babu (then)", "the name as at payrun, not today's");
    assert.equal(p.totals.net_pay, 36087);
  });

  it("attendance figures show only while the attendance month is the one the payrun read", async () => {
    const p = await service.preview(ADMIN, { report_type: "ATTENDANCE", year: 2026, month: 9, field_keys: ["employee_id", "present_days", "absent_days", "late_days", "attendance_snapshot_status", "paid_days", "lop_days", "payable_days"] }, null);
    assert.deepEqual(p.rows[0], { employee_id: 1, present_days: 25, absent_days: 1, late_days: 1, attendance_snapshot_status: "As read by the payrun", paid_days: 25, lop_days: 1, payable_days: 26 });
    assert.deepEqual(p.rows[1], { employee_id: 2, present_days: null, absent_days: null, late_days: null, attendance_snapshot_status: "Changed after payrun - not shown", paid_days: 25, lop_days: 1, payable_days: 26 });
  });

  it("scope, months and report populations run as written", async () => {
    const scoped = await service.preview(ADMIN, { report_type: "PAYROLL_REGISTER", year: 2026, month: 9, field_keys: ["employee_id"] }, [2]);
    assert.deepEqual(scoped.rows.map((r) => r.employee_id), [2]);
    const months = await service.listMonths(ADMIN, null);
    assert.deepEqual(months.map((m) => [m.year, m.month, m.finalized, m.payrun_employees]), [[2026, 10, 1, 1], [2026, 9, 2, 3]]);
    assert.deepEqual((await service.listMonths(ADMIN, [])).length, 0);
    const ot = await service.preview(ADMIN, { report_type: "OT", year: 2026, month: 9 }, null);
    assert.equal(ot.matching_count, 3, "the unapproved row with OT is listed, figures blank");
  });

  it("layouts, copy-previous and defaults persist; the built-in templates are seeded once", async () => {
    await service.saveLayout(ADMIN, { report_type: "BANK", year: 2026, month: 9, field_keys: ["employee_id", "bank_account_number", "net_pay"] });
    await service.saveLayout(ADMIN, { report_type: "BANK", year: 2026, month: 9, field_keys: ["employee_id", "net_pay"] });
    const copied = await service.copyPreviousMonth(ADMIN, { report_type: "BANK", year: 2026, month: 10 });
    assert.deepEqual(copied.field_keys, ["employee_id", "net_pay"]);
    const templates = await service.listTemplates(ADMIN, "PAYROLL_REGISTER");
    assert.deepEqual(templates.map((t) => t.template_name).sort(), ["Audit Payroll", "Management Payroll Summary", "Outlet-wise Payroll", "Standard Payroll Register"]);
    const outletWise = templates.find((t) => t.template_name === "Outlet-wise Payroll");
    assert.equal(outletWise.display.sort_by, "outlet");
    await service.setDefaultTemplate(ADMIN, { report_type: "PAYROLL_REGISTER", template_id: outletWise.template_id });
    const layout = await service.getLayout(ADMIN, { report_type: "PAYROLL_REGISTER", year: 2026, month: 10 });
    assert.equal(layout.source, "DEFAULT_TEMPLATE");
    const mine = await service.duplicateTemplate(ADMIN, outletWise.template_id, "Mine");
    await service.renameTemplate(ADMIN, mine.template_id, "Mine v2");
    await service.deleteTemplate(ADMIN, mine.template_id);
  });

  it("statutory files are all-or-nothing against the real tables, and the new export formats are accepted", async () => {
    const epf = await service.epfValidation(ADMIN, { year: 2026, month: 9 }, null);
    assert.deepEqual(epf.summary, { considered: 3, ready: 1, blocked: 2 });
    await assert.rejects(service.ecrFile(ADMIN, { year: 2026, month: 9 }, null), (e) => e.code === "BLOCKED_EMPLOYEES");
    await assert.rejects(service.esicFile(ADMIN, { year: 2026, month: 9 }, null), (e) => e.code === "BLOCKED_EMPLOYEES");
    // Scoped to the one complete employee's outlet... employee 3 (not approved) is
    // in outlet 1 too, so the outlet-1 file is still refused - nobody is left out.
    await assert.rejects(service.ecrFile(ADMIN, { year: 2026, month: 9 }, [1]), (e) => e.detail.blocked.map((b) => b.employee_id).join() === "3");
    // October: one approved member with a UAN - the file is generated.
    const ecr = await service.ecrFile(ADMIN, { year: 2026, month: 10 }, null);
    assert.equal(ecr.buffer.toString(), "100200300400#~#ASHA#~#20000#~#15000#~#15000#~#15000#~#1800#~#1250#~#550#~#1#~#0");
    const esi = await service.esicFile(ADMIN, { year: 2026, month: 10 }, null);
    assert.equal(esi.buffer.slice(0, 8).toString("hex"), "d0cf11e0a1b11ae1");
    await service.exportPdf(ADMIN, { report_type: "PAYROLL_REGISTER", year: 2026, month: 9 }, null);
    const formats = (await q("SELECT format FROM report_export_log ORDER BY export_id")).map((r) => r.format);
    assert.deepEqual(formats, ["ecr", "esic", "pdf"]);
  });

  /* ------------------------------------------------- reconciliation, real SQL */

  const REGISTER = { report_type: "PAYROLL_REGISTER", year: 2026, month: 9, field_keys: ["employee_id", "gross_salary", "total_deductions", "net_pay", "payrun_status"] };
  const payrunFromTables = async (storeClause = "") => {
    const [r] = await q(`SELECT COUNT(*) n, SUM(c.status = 'APPROVED_LOCKED') fin,
        SUM(IF(c.status = 'APPROVED_LOCKED', c.total_earnings, 0)) g, SUM(IF(c.status = 'APPROVED_LOCKED', c.total_employee_deductions, 0)) d,
        SUM(IF(c.status = 'APPROVED_LOCKED', c.net_pay, 0)) np
        FROM payrun_employee pe LEFT JOIN payrun_employee_calculation c ON c.payrun_employee_id = pe.payrun_employee_id
       WHERE pe.period_year = 2026 AND pe.period_month = 9 ${storeClause}`);
    return { n: Number(r.n), fin: Number(r.fin), g: Number(r.g), d: Number(r.d), np: Number(r.np) };
  };

  it("RECONCILIATION: Payroll Report employee count == finalized payrun employee count; gross, deductions and net pay match", async () => {
    const t = await payrunFromTables();
    const p = await service.preview(ADMIN, REGISTER, null);
    assert.equal(p.matching_count, t.n);
    assert.equal(p.matching_count - p.not_finalized_count, t.fin);
    assert.equal(p.totals.gross_salary, t.g);
    assert.equal(p.totals.total_deductions, t.d);
    assert.equal(p.totals.net_pay, t.np);
    assert.equal(p.reconciliation.reconciled, true);
    const scoped = await service.preview(ADMIN, REGISTER, [1]);
    const ts = await payrunFromTables("AND pe.store_id = 1");
    assert.equal(scoped.matching_count, ts.n);
    assert.equal(scoped.totals.net_pay, ts.np);
    assert.equal(scoped.reconciliation.reconciled, true);
  });

  it("a later employee-status change, transfer or resignation does not remove a payrun employee", async () => {
    await q("UPDATE new_employee SET status = 0, resignation_date = '2026-10-15', store_id = 2, employee_name = 'Asha Renamed' WHERE employee_id = 1");
    const p = await service.preview(ADMIN, { ...REGISTER, field_keys: ["employee_id", "employee_name", "outlet", "net_pay"] }, null);
    assert.deepEqual(p.rows.map((r) => r.employee_id), [1, 2, 3]);
    assert.deepEqual(p.rows[0], { employee_id: 1, employee_name: "Asha", outlet: "Outlet A", net_pay: 18087 });
    assert.equal(p.reconciliation.reconciled, true);
    // ...and the outlet scope is the payrun's outlet, not today's.
    const scoped = await service.preview(ADMIN, REGISTER, [1]);
    assert.ok(scoped.rows.some((r) => r.employee_id === 1));
  });

  it("an unapproved / later-unlocked employee stays in the report with blank figures and a status", async () => {
    const p = await service.preview(ADMIN, REGISTER, null);
    assert.deepEqual(p.rows[2], { employee_id: 3, gross_salary: null, total_deductions: null, net_pay: null, payrun_status: "Not Finalized - Pending Approval" });
    assert.equal(p.row_status[2].status, "PENDING_APPROVAL");
  });

  it("a later attendance recalculation does not mutate a frozen payroll figure", async () => {
    const fields = ["employee_id", "paid_days", "lop_days", "gross_salary", "net_pay", "present_days", "attendance_snapshot_status"];
    const before = await service.preview(ADMIN, { ...REGISTER, field_keys: fields }, null);
    assert.equal(before.rows[0].present_days, 25);
    // Attendance for employee 1 is recalculated after payroll.
    await q("UPDATE attendance_monthly_payroll SET attendance_days = 10, base_days = 20, calculated_at = '2026-11-01 09:00:00.000' WHERE attendance_monthly_payroll_id = 1");
    await q("INSERT INTO attendance_day_calculation VALUES (1,'2026-09-04','ABSENT',NULL,NULL)");
    const after = await service.preview(ADMIN, { ...REGISTER, field_keys: fields }, null);
    for (const k of ["paid_days", "lop_days", "gross_salary", "net_pay"]) assert.equal(after.rows[0][k], before.rows[0][k], k);
    assert.equal(after.rows[0].present_days, null, "the changed attendance is not shown as September's");
    assert.equal(after.rows[0].attendance_snapshot_status, "Changed after payrun - not shown");
    assert.equal(after.reconciliation.reconciled, true);
  });

  it("department, designation (payrun snapshot) and employment type (current master) filters run as written", async () => {
    await q("UPDATE payrun_employee SET designation_id = 7 WHERE employee_id = 2 AND period_month = 9");
    await q("UPDATE new_employee SET employment_type = IF(employee_id = 2, 'Contract', 'Permanent')");
    const run = (filters) => service.preview(ADMIN, { report_type: "PAYROLL_REGISTER", year: 2026, month: 9, field_keys: ["employee_id"], filters }, null);
    assert.deepEqual((await run({ department_ids: [3] })).rows.map((r) => r.employee_id), [1, 2, 3]);
    assert.deepEqual((await run({ department_ids: [99] })).rows.length, 0);
    assert.deepEqual((await run({ designation_ids: [7] })).rows.map((r) => r.employee_id), [2]);
    const contract = await run({ employment_types: ["Contract"] });
    assert.deepEqual(contract.rows.map((r) => r.employee_id), [2]);
    assert.equal(contract.matching_count, 1, "count and rows agree");
    assert.deepEqual((await run({ employment_types: ["Permanent"], designation_ids: [7] })).rows.length, 0, "filters combine with AND");
    // Reconciliation stays on the full scope, not the filtered view.
    assert.equal(contract.reconciliation.reconciled, true);
  });

  it("Cash Payment Excel: CASH by the payrun's pay type rule, all-or-nothing on finalization, reconciled", async () => {
    const NOV = { year: 2026, month: 11 };
    for (const [id, store, payType] of [[1, 1, "CASH"], [2, 2, "BANK"], [3, 1, "CASH"]]) {
      await q(
        `INSERT INTO payrun_employee (period_year, period_month, employee_id, employee_name, store_id, store_name, pay_type, pay_type_source)
         VALUES (2026, 11, ?, ?, ?, ?, ?, 'EMPLOYEE_MASTER')`,
        [id, `Emp ${id}`, store, store === 1 ? "Outlet A" : "Outlet B", payType]
      );
    }
    const calc = (id, status, net, payType) =>
      q(`INSERT INTO payrun_employee_calculation (payrun_employee_id, period_year, period_month, employee_id, source_hash, inputs_hash,
           total_earnings, total_employee_deductions, net_pay, pay_type, is_complete, calculation_version, calculation_hash, status)
         SELECT payrun_employee_id, 2026, 11, ?, 'h', 'h', ?, 0, ?, ?, 1, 1, 'h', ?
           FROM payrun_employee WHERE period_year = 2026 AND period_month = 11 AND employee_id = ?`,
        [id, net, net, payType, status, id]);
    await calc(1, "APPROVED_LOCKED", 18760, "CASH");
    await calc(2, "APPROVED_LOCKED", 21000, "BANK");
    await calc(3, "CALCULATED", 500, "CASH");

    const rows = await repo.listCashPayRows({ ...NOV, store_ids: null });
    assert.deepEqual(rows.map((r) => [r.employee_id, r.status, r.pay_type]), [[1, "APPROVED_LOCKED", "CASH"], [3, "CALCULATED", "CASH"]]);
    await assert.rejects(service.cashPaymentFile(ADMIN, NOV, null), (e) => e.code === "PAYROLL_NOT_FINALIZED");

    // Employee 3 approved with nothing to pay: left out, the file is produced.
    await q("UPDATE payrun_employee_calculation SET status = 'APPROVED_LOCKED', net_pay = 0, total_earnings = 0 WHERE period_month = 11 AND employee_id = 3");
    assert.deepEqual(await repo.cashPayrunTotals({ ...NOV, store_ids: null }), { employees: 1, net_pay: 18760 });
    const file = await service.cashPaymentFile(ADMIN, NOV, null);
    assert.equal(file.filename, "Cash Payment - Nov 2026.xlsx");
    assert.deepEqual(file.summary, { employees: 1, total_net_pay: 18760, excluded: 1, contract: 0 });

    // A Contract employee (current Employee Master) is paid by the contractor:
    // out of the cash and of the reconciliation read alike.
    await q("UPDATE payrun_employee_calculation SET net_pay = 700, total_earnings = 700 WHERE period_month = 11 AND employee_id = 3");
    await q("UPDATE new_employee SET employment_type = 'Contract' WHERE employee_id = 3");
    assert.equal(rows.length, 2);
    assert.equal((await repo.listCashPayRows({ ...NOV, store_ids: null })).find((r) => r.employee_id === 3).employment_type, "Contract");
    assert.deepEqual(await repo.cashPayrunTotals({ ...NOV, store_ids: null }), { employees: 1, net_pay: 18760 });
    assert.deepEqual((await service.cashPaymentFile(ADMIN, NOV, null)).summary, { employees: 1, total_net_pay: 18760, excluded: 0, contract: 1 });
    await q("UPDATE new_employee SET employment_type = NULL WHERE employee_id = 3");

    // Out of scope: nobody to pay.
    await assert.rejects(service.cashPaymentFile(ADMIN, NOV, [2]), (e) => e.code === "NO_CASH_EMPLOYEES");
  });
});
