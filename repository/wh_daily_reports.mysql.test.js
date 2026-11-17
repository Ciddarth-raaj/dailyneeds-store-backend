/**
 * Warehouse Daily Reports against a real MySQL.
 *
 *   WH_TEST_MYSQL=mysql://user:pass@localhost/scratch_db node --test repository/wh_daily_reports.mysql.test.js
 *
 * SKIPPED unless WH_TEST_MYSQL names a SCRATCH database: the suite drops and
 * recreates the wh_report_* tables, new_employee, the GRN copy, product_table
 * and pick_pack_verifications there.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const URL = process.env.WH_TEST_MYSQL;
const SQL = (name) => fs.readFileSync(path.join(__dirname, `../migrations/mysql/migrations/sqls/20261217120000-warehouse-daily-reports-${name}.sql`), "utf8");

describe("wh_daily_reports repository", { skip: !URL && "WH_TEST_MYSQL not set" }, () => {
  let pool;
  let repo;
  let uc;
  const q = (sql, p = []) => new Promise((res, rej) => pool.query(sql, p, (e, r) => (e ? rej(e) : res(r))));
  const JOB = ["Job Type", "From Store", "To Store", "Article ID", "Article Name", "Department", "Category", "Recommended Qty", "Planned Qty", "Advised Qty", "Actual Qty", "MRP Split", "Short Qty", "Returned Qty", "Jobs", "Open Jobs"];
  const BOX = ["Job Type", "From Store", "Planned To Store", "Unloaded Store", "Box ID", "Box Kind", "Truck No", "Article ID", "Article Name", "Department", "Category", "MRP Split", "Box Qty", "Box Status", "Finished At"];

  before(async () => {
    // Same options as drivers/mysql.js.
    pool = require("mysql").createPool(`${URL}?multipleStatements=true&supportBigNumbers=true&bigNumberStrings=true`);
    await q(`DROP TABLE IF EXISTS wh_report_box_rows, wh_report_job_rows, wh_report_uploads, new_employee, all_permissions, permissions, retailpilot_grn_lines, retailpilot_grn_headers, pick_pack_verifications, product_table`);
    await q(`CREATE TABLE new_employee (employee_id INT PRIMARY KEY, employee_name VARCHAR(80));
             CREATE TABLE all_permissions (permission_key VARCHAR(100));
             CREATE TABLE permissions (designation_id INT, permission_key VARCHAR(100));
             CREATE TABLE retailpilot_grn_headers (invoice_slug VARCHAR(64) PRIMARY KEY, entered_at DATETIME);
             CREATE TABLE retailpilot_grn_lines (line_id VARCHAR(64) PRIMARY KEY, invoice_slug VARCHAR(64), product_id INT, mrp DECIMAL(15,2));
             CREATE TABLE product_table (product_id INT PRIMARY KEY);
             INSERT INTO product_table VALUES (1), (2), (3);
             CREATE TABLE pick_pack_verifications (
               pick_pack_verification_id INT AUTO_INCREMENT PRIMARY KEY, product_id INT NOT NULL, mismatch_qty INT NOT NULL DEFAULT 0,
               date DATE NOT NULL, job_type ENUM('GRN','STA') NOT NULL, remark_id INT NULL, remark_str VARCHAR(500) NULL,
               is_verified TINYINT(1) NOT NULL DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
               FOREIGN KEY (product_id) REFERENCES product_table(product_id));
             INSERT INTO new_employee VALUES (7, 'Prashanth');
             INSERT INTO retailpilot_grn_headers VALUES ('old', '2026-10-01 10:00:00'), ('new', '2026-11-01 10:00:00');
             INSERT INTO retailpilot_grn_lines VALUES ('1', 'old', 2, 40), ('2', 'new', 2, 45);`);
    await q(SQL("up"));
    repo = require("./wh_daily_reports")(pool);
    uc = require("../usecase/wh_daily_reports")(repo, () => "2026-11-17");
  });
  after(() => pool && pool.end());

  it("migration adds both permissions once", async () => {
    const rows = await q("SELECT permission_key FROM all_permissions ORDER BY permission_key");
    assert.deepEqual(rows.map((r) => r.permission_key), ["upload_wh_daily_reports", "view_wh_daily_reports"]);
  });

  it("saves an upload, prices from the latest GRN, and replaces it on a second upload", async () => {
    const rows = [
      ["STA", "warehouse", "ecr", "1", "a", "Snacks", "Biscuits", "10", "10", "10", "10", '[{"mrp":30,"qty":10}]', "0", "", "1", "0"],
      ["STA", "warehouse", "ecr", "2", "b", "Snacks", "Biscuits", "5", "5", "5", "0", "", "5", "", "1", "1"],
    ];
    const first = await uc.upload({ report_type: "PICKING", report_date: "2026-11-16", file_name: "Picking_Report_2026-11-16_ALL.csv", headers: JOB, rows, employee_id: 7 });
    assert.equal(first.code, 200);
    assert.equal(first.data.summary.short_value, 225);
    const again = await uc.upload({ report_type: "PICKING", report_date: "2026-11-16", file_name: "Picking_Report_2026-11-16_ALL.csv", headers: JOB, rows: rows.slice(1), employee_id: 7 });
    assert.equal(again.data.replaced, true);
    const [{ c }] = await q("SELECT COUNT(*) AS c FROM wh_report_job_rows");
    assert.equal(Number(c), 1);
    const status = await uc.status({ from: "2026-11-16", to: "2026-11-16" });
    assert.equal(status.data.uploads.length, 1);
    assert.equal(status.data.uploads[0].uploaded_by_name, "Prashanth");
    assert.equal(status.data.uploads[0].row_count, 1);
  });

  it("analyses write-offs and boxes", async () => {
    const box = (store, id, qty, at) => ["STA", "warehouse", "ecr", store, id, "Box", "T1", "1", "a", "Snacks", "Biscuits", '[{"mrp":30,"qty":1}]', String(qty), "Done", at];
    await uc.upload({ report_type: "LOADING", report_date: "2026-11-16", file_name: "Loading_Report_2026-11-16_ALL.csv", headers: BOX.filter((h) => h !== "Unloaded Store"), rows: [box("ecr", "B1", 4, "16 Nov 2026 10:00 AM"), box("ecr", "B2", 4, "16 Nov 2026 10:05 AM")].map((r) => r.filter((_, i) => i !== 3)) });
    await uc.upload({ report_type: "UNLOADING", report_date: "2026-11-16", file_name: "Unloading_Report_2026-11-16_ALL.csv", headers: BOX, rows: [box("ecr", "B1", 3, "16 Nov 2026 01:00 PM")] });
    const a = await uc.analysis({ from: "2026-11-16", to: "2026-11-16" });
    assert.equal(a.code, 200);
    const picking = a.data.summary.find((s) => s.report_type === "PICKING");
    assert.equal(picking.short_qty, 5);
    assert.equal(picking.short_value, 225);
    assert.equal(picking.open_lines, 1);
    assert.equal(a.data.short_articles[0].article_id, 2);
    assert.deepEqual(a.data.stores, ["ecr"]);
    const st = Object.fromEntries(a.data.boxes.by_status.map((s) => [s.status, s.lines]));
    assert.deepEqual(st, { QTY_DIFF: 1, OPEN: 1 });
    assert.equal(a.data.boxes.trucks[0].first_loaded_at, "2026-11-16 10:00:00");
    assert.equal(a.data.boxes.trucks[0].last_unloaded_at, "2026-11-16 13:00:00");
    const ecr = a.data.funnel.find((f) => f.store === "ecr");
    assert.equal(ecr.loaded, 8);
    assert.equal(ecr.unloaded, 3);
    const rows = await uc.rows({ from: "2026-11-16", to: "2026-11-16", only: "short" });
    assert.equal(rows.data.rows.length, 1);
    assert.equal(rows.data.rows[0].mrp_source, "GRN");
  });

  it("puts the Verification write-off on the Verification page, keeping remarks on re-upload", async () => {
    const line = (store, id, jt, short) => [jt, "warehouse", store, String(id), "a", "D", "C", "5", "5", "5", "0", "", String(short), String(short), "1", "0"];
    const up = (rows) => uc.upload({ report_type: "VERIFICATION", report_date: "2026-11-16", file_name: "Verification_Report_2026-11-16_ALL.csv", headers: JOB, rows });
    const first = await up([line("ecr", 1, "GRN", 2), line("kathirkamam", 1, "GRN", 3), line("ecr", 2, "STA", 4), line("ecr", 3, "GRN", 1), line("ecr", 99, "GRN", 1), line("ecr", 2, "DAMG", 1)]);
    assert.deepEqual(first.data.summary.verification_page, { added: 3, updated: 0, unchanged: 0, kept_verified: 0, unknown_articles: 1, other_job_type_lines: 1 });
    const page = async () => q("SELECT product_id, job_type, mismatch_qty, remark_str, is_verified, DATE_FORMAT(date, '%Y-%m-%d') AS d FROM pick_pack_verifications ORDER BY product_id, job_type");
    assert.deepEqual((await page()).map((r) => [r.product_id, r.job_type, r.mismatch_qty, r.d]), [[1, "GRN", 5, "2026-11-16"], [2, "STA", 4, "2026-11-16"], [3, "GRN", 1, "2026-11-16"]]);

    // The team adds a remark to article 1 and verifies article 2; then the report is uploaded again with new numbers.
    await q("UPDATE pick_pack_verifications SET remark_str = 'bin empty' WHERE product_id = 1");
    await q("UPDATE pick_pack_verifications SET is_verified = 1 WHERE product_id = 2");
    const again = await up([line("ecr", 1, "GRN", 7), line("ecr", 2, "STA", 9), line("ecr", 3, "GRN", 1)]);
    assert.deepEqual(again.data.summary.verification_page, { added: 0, updated: 1, unchanged: 1, kept_verified: 1, unknown_articles: 0, other_job_type_lines: 0 });
    const after = await page();
    assert.deepEqual(after.map((r) => [r.product_id, r.mismatch_qty, r.remark_str, Number(r.is_verified)]), [[1, 7, "bin empty", 0], [2, 4, null, 1], [3, 1, null, 0]]);
  });

  it("deletes an upload with its rows, and the down migration removes everything", async () => {
    const [u] = await q("SELECT upload_id FROM wh_report_uploads WHERE report_type = 'LOADING'");
    assert.equal((await uc.deleteUpload({ upload_id: u.upload_id })).code, 200);
    const [{ c }] = await q("SELECT COUNT(*) AS c FROM wh_report_box_rows WHERE report_type = 'LOADING'");
    assert.equal(Number(c), 0);
    await q(SQL("down"));
    assert.equal((await q("SHOW TABLES LIKE 'wh_report%'")).length, 0);
    assert.equal((await q("SELECT * FROM all_permissions")).length, 0);
    await q(SQL("up"));
  });
});
