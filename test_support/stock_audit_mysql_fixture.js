/**
 * Scratch MySQL for the Stock Audit integration tests. Drops and creates the
 * tables it uses - point SA_TEST_MYSQL at a SCRATCH database only, e.g.
 *   SA_TEST_MYSQL=mysql://dnds:dnds@127.0.0.1:3307/sa_scratch
 * Loads the module's two real migration files, so the tests run against the
 * exact schema the migrations create.
 */
const fs = require("fs");
const path = require("path");
const mysql = require("mysql");

const MIG = path.join(__dirname, "..", "migrations", "mysql", "migrations", "sqls");
const UPS = ["20270108120000-stock-audit-foundation-up.sql", "20270108120100-stock-audit-allotment-sapl-up.sql", "20270108120200-stock-audit-participation-roles-up.sql"];
const DOWNS = ["20270108120200-stock-audit-participation-roles-down.sql", "20270108120100-stock-audit-allotment-sapl-down.sql", "20270108120000-stock-audit-foundation-down.sql"];

const STORES = [
  [2, "Warehouse", "9rJMC"], [3, "Kathirkamam", "huABy"], [4, "Vallalar Salai", "FuUGY"],
  [5, "Moolakulam", "sooWy"], [6, "Muthialpet", "rnMT1"], [7, "ECR", "kKFom"],
];

async function setup(url) {
  const u = new URL(url);
  const pool = mysql.createPool({
    host: u.hostname, port: Number(u.port || 3306), user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database: u.pathname.slice(1),
    multipleStatements: true, connectionLimit: 10, supportBigNumbers: true, bigNumberStrings: true,
  });
  const q = (sql, params = []) => new Promise((res, rej) => pool.query(sql, params, (e, r) => (e ? rej(e) : res(r))));
  await q(`CREATE TABLE IF NOT EXISTS permissions (permission_key VARCHAR(100) NOT NULL, designation_id INT NOT NULL, is_active BOOLEAN NOT NULL DEFAULT TRUE)`);
  await q(`CREATE TABLE IF NOT EXISTS all_permissions (permission_id INT AUTO_INCREMENT PRIMARY KEY, permission_key VARCHAR(45) NOT NULL)`);
  for (const f of DOWNS) await q(fs.readFileSync(path.join(MIG, f), "utf8"));
  await q(`DROP TABLE IF EXISTS outlets, new_employee, designation, wh_rp_staff_map, all_permissions, permissions`);
  await q(`CREATE TABLE permissions (permission_key VARCHAR(100) NOT NULL, designation_id INT NOT NULL, is_active BOOLEAN NOT NULL DEFAULT TRUE)`);
  await q(`CREATE TABLE outlets (outlet_id INT PRIMARY KEY, outlet_name VARCHAR(100), retailpilot_id VARCHAR(32) NULL)`);
  await q(`CREATE TABLE designation (designation_id INT PRIMARY KEY, designation_name VARCHAR(100))`);
  await q(`CREATE TABLE new_employee (employee_id INT PRIMARY KEY, employee_name VARCHAR(100), store_id INT, designation_id INT, status TINYINT DEFAULT 1)`);
  await q(`CREATE TABLE wh_rp_staff_map (rp_user_id VARCHAR(100) PRIMARY KEY, employee_id INT NULL, note VARCHAR(255) NULL, updated_by INT NULL,
           updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`);
  await q(`CREATE TABLE all_permissions (permission_id INT AUTO_INCREMENT PRIMARY KEY, permission_key VARCHAR(45) NOT NULL)`);
  await q(`INSERT INTO outlets VALUES ?`, [STORES]);
  // the production designation ids (read 27 Nov 2026)
  await q(`INSERT INTO designation VALUES (1, 'Customer Service Executive'), (2, 'Customer Service Associate'), (3, 'Store Manager'), (4, 'Cashier'), (9, 'Supervisor'), (27, 'Operations Manager')`);
  for (const f of UPS) await q(fs.readFileSync(path.join(MIG, f), "utf8"));
  return { pool, q, end: () => new Promise((r) => pool.end(r)) };
}

module.exports = { setup, STORES };
