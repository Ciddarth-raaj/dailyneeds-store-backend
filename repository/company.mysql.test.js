/**
 * MASTER → COMPANY DETAILS, AS REAL SQL.
 *
 *   ATTENDANCE_TEST_MYSQL=mysql://user:pass@localhost/scratch_db \
 *     node --test repository/company.mysql.test.js
 *
 * SKIPPED unless `ATTENDANCE_TEST_MYSQL` names a SCRATCH database.
 *
 * `company_details` is built from ITS OWN 2021 MIGRATIONS (no stand-in), the
 * real `repository/company.js` writes it, and the real
 * `repository/payrun_payslip.js#listCompanies` + `utils/payslip_company.js`
 * read it back the way Publish does.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const URL = process.env.ATTENDANCE_TEST_MYSQL;
const buildCompanyRepo = require("./company");
const buildPayslipRepo = require("./payrun_payslip");
const { validateCompanyDetails } = require("../utils/company_details");
const { resolvePayslipCompany, payslipCompanyStatus } = require("../utils/payslip_company");
const { buildPayslipSnapshot, freezeSnapshot } = require("../utils/payslip_snapshot");

const SQLS = path.join(__dirname, "..", "migrations/mysql/migrations/sqls");
const q = (pool, sql, params = []) =>
  new Promise((resolve, reject) => pool.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));

describe("Company Details over real SQL", { skip: !URL && "ATTENDANCE_TEST_MYSQL is not set" }, () => {
  let pool;
  let repo;
  let payslipRepo;
  const issuer = async () => resolvePayslipCompany(await payslipRepo.listCompanies(), {});
  const status = async () => payslipCompanyStatus(await payslipRepo.listCompanies(), {});
  const form = (over = {}) =>
    validateCompanyDetails({
      company_name: "Daily Needs Departmental Store",
      reg_address: "188/1 Iyyanar Koil Street",
      pf_number: "TN/MAS/0012345",
      esi_number: "51000123450001001",
      ...over,
    }).values;

  before(async () => {
    pool = require("mysql").createPool(`${URL}?connectionLimit=2&multipleStatements=true`);
    await q(pool, "DROP TABLE IF EXISTS company_details");
    await q(pool, "DROP TABLE IF EXISTS company_payslip_frozen");
    await q(pool, fs.readFileSync(path.join(SQLS, "20210929103343-added-company-details-up.sql"), "utf8"));
    await q(pool, fs.readFileSync(path.join(SQLS, "20211004184520-adds-logo-up.sql"), "utf8"));
    // A stand-in for the payslip row: the frozen snapshot TEXT, as Publish stores it.
    await q(pool, "CREATE TABLE company_payslip_frozen (id INT PRIMARY KEY, snapshot_json LONGTEXT NOT NULL)");
    repo = buildCompanyRepo(pool);
    payslipRepo = buildPayslipRepo(pool);
  });

  after(async () => {
    if (!pool) return;
    await q(pool, "DROP TABLE IF EXISTS company_details");
    await q(pool, "DROP TABLE IF EXISTS company_payslip_frozen");
    pool.end();
  });

  it("no company: Publish's resolver refuses", async () => {
    assert.equal((await status()).configured, false);
    await assert.rejects(issuer(), (e) => e.code === "PAYSLIP_COMPANY_NOT_CONFIGURED" && e.reason === "NONE");
  });

  it("create: an inactive company stays inactive (the column default of 1 is not relied on)", async () => {
    const id = await repo.create(form({ company_name: "Draft Ltd" }), { payslip_active: false });
    const [row] = await repo.get(id);
    assert.equal(row.status, 0);
    assert.equal(row.contact_number, "", "optional NOT NULL columns store ''");
    assert.equal((await status()).configured, false);
  });

  it("create Active for Payslip: Publish resolves it", async () => {
    const id = await repo.create(form(), { payslip_active: true });
    const c = await issuer();
    assert.deepEqual([c.name, c.pf_establishment_code, c.source], ["Daily Needs Departmental Store", "TN/MAS/0012345", `company_details:${id}`]);
  });

  it("only one active: activating another clears every other row", async () => {
    const third = await repo.create(form({ company_name: "Third Ltd" }), { payslip_active: true });
    const rows = await q(pool, "SELECT company_id, status FROM company_details ORDER BY company_id");
    assert.deepEqual(rows.map((r) => r.status), [0, 0, 1]);
    assert.equal((await issuer()).source, `company_details:${third}`);
    assert.equal(await repo.setPayslipCompany(2), true);
    assert.deepEqual((await q(pool, "SELECT status FROM company_details ORDER BY company_id")).map((r) => r.status), [0, 1, 0]);
    assert.equal(await repo.setPayslipCompany(999), false);
  });

  it("legacy data with several active is refused until one is chosen", async () => {
    await q(pool, "UPDATE company_details SET status = 1");
    assert.equal((await status()).reason, "MULTIPLE");
    await assert.rejects(issuer(), (e) => e.reason === "MULTIPLE");
    await repo.setPayslipCompany(2);
    assert.equal((await status()).configured, true);
  });

  it("edit: the record changes; a payslip frozen before the edit does not", async () => {
    const before = await issuer();
    const frozen = freezeSnapshot(
      buildPayslipSnapshot({
        period: { year: 2026, month: 9 },
        calculation: {
          payrun_calculation_id: 1, payrun_employee_id: 1, employee_id: 1, salary_earnings: "1000.00",
          total_earnings: "1000.00", total_employee_deductions: "0.00", net_pay: "1000.00", net_pay_rounding: "0.00",
          pf_applicable: 1, esi_applicable: 1, calculation_hash: "a".repeat(32),
        },
        employee: { employee_id: 1, employee_name: "Kavi" },
        company: before,
      })
    );
    await q(pool, "INSERT INTO company_payslip_frozen VALUES (1, ?)", [frozen.text]);

    assert.equal(await repo.update(2, form({ company_name: "Renamed Ltd", reg_address: "New Address" }), { payslip_active: true }), true);
    assert.deepEqual([(await issuer()).name, (await issuer()).address], ["Renamed Ltd", "New Address"]);
    const [{ snapshot_json }] = await q(pool, "SELECT snapshot_json FROM company_payslip_frozen WHERE id = 1");
    assert.equal(snapshot_json, frozen.text, "byte-for-byte unchanged");
    assert.equal(JSON.parse(snapshot_json).company.name, "Daily Needs Departmental Store");
    assert.equal(await repo.update(999, form(), { payslip_active: false }), false);
  });

  it("edit to inactive: Publish is blocked again", async () => {
    await repo.update(2, form(), { payslip_active: false });
    assert.equal((await status()).configured, false);
  });
});
