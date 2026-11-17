/**
 * Warehouse Daily Reports against a real MySQL.
 *
 *   WH_TEST_MYSQL=mysql://user:pass@localhost/scratch_db node --test repository/wh_daily_reports.mysql.test.js
 *
 * SKIPPED unless WH_TEST_MYSQL names a SCRATCH database: the suite drops and
 * recreates the wh_report_* tables, new_employee and the GRN copy there.
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
    await q(`DROP TABLE IF EXISTS wh_report_box_rows, wh_report_job_rows, wh_report_uploads, new_employee, all_permissions, permissions, retailpilot_grn_lines, retailpilot_grn_headers`);
    await q(`CREATE TABLE new_employee (employee_id INT PRIMARY KEY, employee_name VARCHAR(80));
             CREATE TABLE all_permissions (permission_key VARCHAR(100));
             CREATE TABLE permissions (designation_id INT, permission_key VARCHAR(100));
             CREATE TABLE retailpilot_grn_headers (invoice_slug VARCHAR(64) PRIMARY KEY, entered_at DATETIME);
             CREATE TABLE retailpilot_grn_lines (line_id VARCHAR(64) PRIMARY KEY, invoice_slug VARCHAR(64), product_id INT, mrp DECIMAL(15,2));
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
