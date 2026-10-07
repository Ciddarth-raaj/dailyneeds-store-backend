/**
 * PAYROLL ELIGIBLE over real SQL - the population query, the insert guard and
 * the migration, against a MySQL-compatible engine.
 *
 *   ATTENDANCE_TEST_MYSQL=mysql://user:pass@localhost/scratch_db \
 *     node --test repository/payroll_eligible.mysql.test.js
 *
 * SKIPPED unless `ATTENDANCE_TEST_MYSQL` names a SCRATCH database: it drops
 * and recreates the tables it uses. `payrun_employee` and `payrun_period` come
 * from the real initialization migration and the column from the real
 * `20261124120000-employee-payroll-eligible` migration; `new_employee`,
 * `outlets`, `designation` and `all_permissions` are minimal stand-ins with the columns the
 * population query reads.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const URL = process.env.ATTENDANCE_TEST_MYSQL;
const SQLS = path.join(__dirname, "..", "migrations/mysql/migrations/sqls");
const readSql = (f) => fs.readFileSync(path.join(SQLS, f), "utf8");
const UP = "20261124120000-employee-payroll-eligible-up.sql";
const DOWN = "20261124120000-employee-payroll-eligible-down.sql";

const q = (pool, sql, params = []) =>
  new Promise((resolve, reject) => pool.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));

const YEAR = 2026;
const MONTH = 10;

const snapshot = (employee_id, over = {}) => ({
  period_year: YEAR,
  period_month: MONTH,
  employee_id,
  employee_name: `E${employee_id}`,
  pay_type: "CASH",
  pay_type_source: "EMPLOYEE_MASTER",
  status: "INITIALIZED",
  initialized_by: 7,
  ...over,
});

describe("payroll eligible over real SQL", { skip: !URL && "ATTENDANCE_TEST_MYSQL is not set" }, () => {
  let pool;
  let repo;

  before(async () => {
    pool = require("mysql").createPool(`${URL}?connectionLimit=4&multipleStatements=true`);
    for (const t of ["employee_payroll_eligible_audit", "payrun_employee_pay_type_audit", "payrun_employee", "payrun_period", "new_employee", "outlets", "designation", "all_permissions"]) {
      await q(pool, `DROP TABLE IF EXISTS \`${t}\``);
    }
    await q(pool, `CREATE TABLE new_employee (
        employee_id INT PRIMARY KEY, employee_name VARCHAR(100), store_id INT, designation_id INT,
        department_id INT, payment_type VARCHAR(45), pf_applicable TINYINT(1), esi_applicable TINYINT(1),
        uan VARCHAR(45), pf_number VARCHAR(45), esi_number VARCHAR(45), account_no VARCHAR(45),
        ifsc VARCHAR(45), date_of_joining VARCHAR(45), resignation_date DATE NULL,
        attendance_required TINYINT(1) NOT NULL DEFAULT 1, status TINYINT DEFAULT 1
      ) ENGINE=InnoDB`);
    await q(pool, "CREATE TABLE all_permissions (permission_key VARCHAR(100) PRIMARY KEY) ENGINE=InnoDB");
    await q(pool, "CREATE TABLE outlets (outlet_id INT PRIMARY KEY, outlet_name VARCHAR(100)) ENGINE=InnoDB");
    await q(pool, "CREATE TABLE designation (designation_id INT PRIMARY KEY, designation_name VARCHAR(100)) ENGINE=InnoDB");
    await q(pool, readSql("20261021120000-payrun-initialization-up.sql"));
    repo = require("./payrun")(pool);
  });

  after(async () => {
    // The audit table's foreign key would stop other suites sharing this
    // scratch database from dropping `new_employee`.
    if (pool) await q(pool, "DROP TABLE IF EXISTS `employee_payroll_eligible_audit`").catch(() => {});
    if (pool) await new Promise((r) => pool.end(r));
  });

  it("the migration adds payroll_eligible NOT NULL DEFAULT 1 and the audit table, and a re-run is a no-op", async () => {
    await q(pool, "INSERT INTO new_employee (employee_id, employee_name, store_id, date_of_joining) VALUES (500, 'Existing', 3, '2019-01-01')");
    await q(pool, readSql(UP));
    await q(pool, readSql(UP)); // idempotent
    const [col] = await q(pool, "SHOW COLUMNS FROM new_employee LIKE 'payroll_eligible'");
    assert.equal(col.Null, "NO");
    assert.equal(String(col.Default), "1");
    const [existing] = await q(pool, "SELECT payroll_eligible FROM new_employee WHERE employee_id = 500");
    assert.equal(Number(existing.payroll_eligible), 1, "every employee who already exists stays payroll eligible");
    const audit = await q(pool, "SELECT COUNT(*) AS n FROM employee_payroll_eligible_audit");
    assert.equal(Number(audit[0].n), 0, "the migration writes no audit row and changes nobody");
    await q(pool, "DELETE FROM new_employee WHERE employee_id = 500");
  });

  it("the population excludes Salary Not Applicable, keeps a month already initialized, and leaves other months alone", async () => {
    await q(pool, `INSERT INTO new_employee (employee_id, employee_name, store_id, payment_type, date_of_joining, payroll_eligible) VALUES
        (42, 'Paid', 3, '1', '2019-06-01', 1),
        (1, 'Vinodh Kumar', 3, '2', '2015-01-01', 0),
        (43, 'Marked after initializing', 3, '2', '2018-01-01', 0),
        (44, 'Initialized last month only', 3, '2', '2018-01-01', 0)`);
    await q(pool, "INSERT INTO payrun_employee (period_year, period_month, employee_id, pay_type, pay_type_source) VALUES (?, ?, 43, 'CASH', 'EMPLOYEE_MASTER'), (?, ?, 44, 'CASH', 'EMPLOYEE_MASTER')", [YEAR, MONTH, YEAR, MONTH - 1]);

    const population = await repo.listPopulation({ year: YEAR, month: MONTH });
    assert.deepEqual(population.map((r) => r.employee_id), [42, 43]);
    assert.equal(Number(population.find((r) => r.employee_id === 42).payroll_eligible), 1);

    const lastMonth = await repo.listPopulation({ year: YEAR, month: MONTH - 1 });
    assert.deepEqual(lastMonth.map((r) => r.employee_id), [42, 44], "44's own month is kept; 43 is not in it");
  });

  it("insertSnapshots refuses a Salary Not Applicable employee inside the transaction and writes nothing", async () => {
    await assert.rejects(() => repo.insertSnapshots([snapshot(42), snapshot(1)]), /Not payroll eligible \(Salary Not Applicable\): employee 1\. Nothing was initialized\./);
    const rows = await q(pool, "SELECT employee_id FROM payrun_employee WHERE period_year = ? AND period_month = ? ORDER BY employee_id", [YEAR, MONTH]);
    assert.deepEqual(rows.map((r) => r.employee_id), [43], "the whole batch rolled back - not even 42 was written");
  });

  it("insertSnapshots still initializes a payroll-eligible employee normally", async () => {
    const written = await repo.insertSnapshots([snapshot(42)]);
    assert.ok(written.some((r) => r.employee_id === 42));
  });

  it("the audit table records a change through the real Employee Master repository, in one transaction", async () => {
    const mod = require("./employee_master");
    const EmpRepo = mod.EmployeeMasterRepository || null;
    const em = typeof mod === "function" && !EmpRepo ? mod(pool) : new EmpRepo(pool);
    await em.withTransaction(async (tx) => {
      const before = await em.readPayrollEligibleForUpdate(tx, 42);
      assert.equal(before, true);
      await em.setPayrollEligible(tx, 42, false);
      await em.insertPayrollEligibleAudit(tx, { employeeId: 42, oldValue: before, newValue: false, changedBy: 1, changedByUserId: 9 });
    });
    const [row] = await q(pool, "SELECT payroll_eligible FROM new_employee WHERE employee_id = 42");
    assert.equal(Number(row.payroll_eligible), 0);
    const history = await em.listPayrollEligibleAudit(42);
    assert.equal(history.length, 1);
    assert.deepEqual(
      { old: history[0].old_value, now: history[0].new_value, by: history[0].changed_by, user: history[0].changed_by_user_id, name: history[0].changed_by_name },
      { old: true, now: false, by: 1, user: 9, name: "Vinodh Kumar" }
    );
    assert.ok(history[0].changed_at, "changed_at is stamped by the database");
    const months = await em.listInitializedPayrollMonths(42);
    assert.deepEqual(months, [{ year: YEAR, month: MONTH }], "42 was initialized above");

    // A rolled-back change leaves neither the value nor an audit row.
    await assert.rejects(() =>
      em.withTransaction(async (tx) => {
        await em.setPayrollEligible(tx, 42, true);
        await em.insertPayrollEligibleAudit(tx, { employeeId: 42, oldValue: false, newValue: true, changedBy: 1, changedByUserId: 9 });
        throw new Error("boom");
      })
    );
    const [still] = await q(pool, "SELECT payroll_eligible FROM new_employee WHERE employee_id = 42");
    assert.equal(Number(still.payroll_eligible), 0);
    assert.equal((await em.listPayrollEligibleAudit(42)).length, 1);
    await q(pool, "UPDATE new_employee SET payroll_eligible = 1 WHERE employee_id = 42");
  });

  it("the down-migration drops only the column; everybody returns to the population", async () => {
    await q(pool, readSql(DOWN));
    const cols = await q(pool, "SHOW COLUMNS FROM new_employee LIKE 'payroll_eligible'");
    assert.equal(cols.length, 0);
    const tables = await q(pool, "SHOW TABLES LIKE 'employee_payroll_eligible_audit'");
    assert.equal(tables.length, 0, "the audit table goes with it");
    await q(pool, readSql(UP)); // leave the table as the code expects
    const population = await repo.listPopulation({ year: YEAR, month: MONTH });
    assert.deepEqual(population.map((r) => r.employee_id).sort((a, b) => a - b), [1, 42, 43, 44]);
  });
});
