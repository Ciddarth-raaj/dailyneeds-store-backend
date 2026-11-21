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
  let nlcSpectra;
  let nlcRows = [{ article_id: "2", stock_value: "45", stock_qty: "1", avg_nlc: "45" }];
  let uc;
  const q = (sql, p = []) => new Promise((res, rej) => pool.query(sql, p, (e, r) => (e ? rej(e) : res(r))));
  const JOB = ["Job Type", "From Store", "To Store", "Article ID", "Article Name", "Department", "Category", "Recommended Qty", "Planned Qty", "Advised Qty", "Actual Qty", "MRP Split", "Short Qty", "Returned Qty", "Jobs", "Open Jobs"];
  const BOX = ["Job Type", "From Store", "Planned To Store", "Unloaded Store", "Box ID", "Box Kind", "Truck No", "Article ID", "Article Name", "Department", "Category", "MRP Split", "Box Qty", "Box Status", "Finished At"];

  before(async () => {
    // Same options as drivers/mysql.js.
    pool = require("mysql").createPool(`${URL}?multipleStatements=true&supportBigNumbers=true&bigNumberStrings=true`);
    await q(`DROP TABLE IF EXISTS wh_health_summary_sends, wh_rp_staff_map, outlets, designation, wh_report_box_rows, wh_report_job_rows, wh_report_uploads, new_employee, all_permissions, permissions, retailpilot_grn_lines, retailpilot_grn_headers, pick_pack_verifications, product_table, product_images, pick_pack_verification_remarks, pick_pack_write_off, pick_pack_remarks, department, categories`);
    await q(`CREATE TABLE new_employee (employee_id INT PRIMARY KEY, employee_name VARCHAR(80), status INT DEFAULT 1, store_id INT NULL, designation_id INT NULL); CREATE TABLE outlets (outlet_id INT PRIMARY KEY, outlet_name VARCHAR(80)); CREATE TABLE designation (designation_id INT PRIMARY KEY, designation_name VARCHAR(80)); INSERT INTO outlets VALUES (1, 'Warehouse'); INSERT INTO designation VALUES (3, 'Picker');
             CREATE TABLE all_permissions (permission_key VARCHAR(100));
             CREATE TABLE permissions (designation_id INT, permission_key VARCHAR(100));
             CREATE TABLE retailpilot_grn_headers (invoice_slug VARCHAR(64) PRIMARY KEY, entered_at DATETIME);
             CREATE TABLE retailpilot_grn_lines (line_id VARCHAR(64) PRIMARY KEY, invoice_slug VARCHAR(64), product_id INT, mrp DECIMAL(15,2));
             CREATE TABLE product_table (product_id INT PRIMARY KEY, de_name VARCHAR(200), gf_item_name VARCHAR(200), department_id INT, category_id INT);
             CREATE TABLE department (department_id INT PRIMARY KEY, department_name VARCHAR(100));
             CREATE TABLE categories (category_id INT PRIMARY KEY, category_name VARCHAR(100));
             INSERT INTO department VALUES (1, 'Snacks');
             CREATE TABLE product_images (image_id INT PRIMARY KEY, product_id INT, image_url VARCHAR(200), priority INT);
             CREATE TABLE pick_pack_verification_remarks (remark_id INT AUTO_INCREMENT PRIMARY KEY, label VARCHAR(255));
             CREATE TABLE pick_pack_remarks (remark_id INT AUTO_INCREMENT PRIMARY KEY, label VARCHAR(255));
             CREATE TABLE pick_pack_write_off (
               pick_pack_write_off_id INT AUTO_INCREMENT PRIMARY KEY, product_id INT NOT NULL, mismatch_qty INT NOT NULL DEFAULT 0, date DATE NOT NULL,
               remark_id INT NULL, remark_str VARCHAR(500) NULL, reason_employee_id INT NULL, is_verified TINYINT(1) NOT NULL DEFAULT 0,
               created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
               FOREIGN KEY (product_id) REFERENCES product_table(product_id));
             INSERT INTO product_table (product_id) VALUES (1), (2), (3);
             CREATE TABLE pick_pack_verifications (
               pick_pack_verification_id INT AUTO_INCREMENT PRIMARY KEY, product_id INT NOT NULL, mismatch_qty INT NOT NULL DEFAULT 0,
               date DATE NOT NULL, job_type ENUM('GRN','STA') NOT NULL, remark_id INT NULL, remark_str VARCHAR(500) NULL,
               is_verified TINYINT(1) NOT NULL DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
               FOREIGN KEY (product_id) REFERENCES product_table(product_id));
             INSERT INTO new_employee VALUES (7, 'Prashanth', 1, 1, 3), (8, 'Left Already', 0, 1, 3);
             INSERT INTO retailpilot_grn_headers VALUES ('old', '2026-10-01 10:00:00'), ('new', '2026-11-01 10:00:00');
             INSERT INTO retailpilot_grn_lines VALUES ('1', 'old', 2, 40), ('2', 'new', 2, 45);`);
    await q(SQL("up"));
    await q(fs.readFileSync(path.join(__dirname, "../migrations/mysql/migrations/sqls/20261218130000-pick-pack-verification-store-up.sql"), "utf8"));
    await q(fs.readFileSync(path.join(__dirname, "../migrations/mysql/migrations/sqls/20261218140000-pick-pack-write-off-store-up.sql"), "utf8"));
    await q(fs.readFileSync(path.join(__dirname, "../migrations/mysql/migrations/sqls/20261223120000-wh-report-retailpilot-up.sql"), "utf8"));
    await q(fs.readFileSync(path.join(__dirname, "../migrations/mysql/migrations/sqls/20261224120000-wh-report-nlc-up.sql"), "utf8"));
    await q(fs.readFileSync(path.join(__dirname, "../migrations/mysql/migrations/sqls/20261225120000-wh-staff-map-up.sql"), "utf8"));
    await q(fs.readFileSync(path.join(__dirname, "../migrations/mysql/migrations/sqls/20261226120000-warehouse-health-up.sql"), "utf8"));
    await q(fs.readFileSync(path.join(__dirname, "../migrations/mysql/migrations/sqls/20261227120000-wh-box-stage-up.sql"), "utf8"));
    repo = require("./wh_daily_reports")(pool);
    // RetailPilot as far as NLC goes: article 2 has NLC 45; article 1 none.
    nlcSpectra = {
      isConfigured: () => true,
      queryAll: async (sql) => (/inventory_batches/.test(sql) ? nlcRows : []),
    };
    uc = require("../usecase/wh_daily_reports")(repo, () => "2026-11-17", nlcSpectra);
  });
  after(() => pool && pool.end());

  it("migrations add their permissions once", async () => {
    const rows = await q("SELECT permission_key FROM all_permissions ORDER BY permission_key");
    assert.deepEqual(rows.map((r) => r.permission_key), ["manage_wh_staff_map", "receive_warehouse_health_summary", "upload_wh_daily_reports", "view_warehouse_health", "view_wh_daily_reports"]);
  });

  it("saves an upload, values it at NLC from RetailPilot (not the file's MRP), and replaces it on a second upload", async () => {
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
    assert.equal(rows.data.rows[0].nlc_source, "RETAILPILOT");
    assert.equal(rows.data.rows[0].nlc, 45);
  });

  it("puts the Verification write-off on the Verification page per store, keeping remarks on re-upload", async () => {
    const line = (store, id, jt, short) => [jt, "warehouse", store, String(id), "a", "D", "C", "5", "5", "5", "0", "", String(short), String(short), "1", "0"];
    const up = (rows) => uc.upload({ report_type: "VERIFICATION", report_date: "2026-11-16", file_name: "Verification_Report_2026-11-16_ALL.csv", headers: JOB, rows });
    const page = () => q("SELECT product_id, job_type, store, mismatch_qty, remark_str, is_verified FROM pick_pack_verifications ORDER BY product_id, job_type, store");
    const first = await up([line("ecr", 1, "GRN", 2), line("kathirkamam", 1, "GRN", 3), line("ecr", 2, "STA", 4), line("ecr", 3, "GRN", 1), line("ecr", 99, "GRN", 1), line("ecr", 2, "DAMG", 1)]);
    assert.deepEqual(first.data.summary.verification_page, { added: 4, updated: 0, unchanged: 0, kept_verified: 0, unknown_articles: 1, removed: 0, other_job_type_lines: 1 });
    assert.deepEqual((await page()).map((r) => [r.product_id, r.job_type, r.store, r.mismatch_qty]), [
      [1, "GRN", "ecr", 2], [1, "GRN", "kathirkamam", 3], [2, "STA", "ecr", 4], [3, "GRN", "ecr", 1],
    ]);

    // A remark on article 1 at ecr, article 2 verified; then the report is uploaded again.
    await q("UPDATE pick_pack_verifications SET remark_str = 'bin empty' WHERE product_id = 1 AND store = 'ecr'");
    await q("UPDATE pick_pack_verifications SET is_verified = 1 WHERE product_id = 2");
    const again = await up([line("ecr", 1, "GRN", 7), line("kathirkamam", 1, "GRN", 3), line("ecr", 2, "STA", 9), line("ecr", 3, "GRN", 1)]);
    assert.deepEqual(again.data.summary.verification_page, { added: 0, updated: 1, unchanged: 2, kept_verified: 1, unknown_articles: 0, removed: 0, other_job_type_lines: 0 });
    assert.deepEqual((await page()).map((r) => [r.product_id, r.store, r.mismatch_qty, r.remark_str, Number(r.is_verified)]), [
      [1, "ecr", 7, "bin empty", 0], [1, "kathirkamam", 3, null, 0], [2, "ecr", 4, null, 1], [3, "ecr", 1, null, 0],
    ]);
  });

  it("an older combined line becomes the first store's line and keeps its remark; a verified one stands", async () => {
    await q("DELETE FROM pick_pack_verifications");
    await q(`INSERT INTO pick_pack_verifications (product_id, mismatch_qty, date, job_type, store, remark_str, is_verified) VALUES
               (1, 5, '2026-11-15', 'GRN', NULL, 'counted twice', 0), (2, 4, '2026-11-15', 'GRN', NULL, NULL, 1)`);
    const line = (store, id, short) => ["GRN", "warehouse", store, String(id), "a", "D", "C", "5", "5", "5", "0", "", String(short), String(short), "1", "0"];
    const res = await uc.upload({ report_type: "VERIFICATION", report_date: "2026-11-15", file_name: "Verification_Report_2026-11-15_ALL.csv", headers: JOB,
      rows: [line("ecr", 1, 2), line("kathirkamam", 1, 3), line("ecr", 2, 1), line("moolakulam", 2, 3)] });
    assert.deepEqual(res.data.summary.verification_page, { added: 1, updated: 1, unchanged: 0, kept_verified: 2, unknown_articles: 0, removed: 0, other_job_type_lines: 0 });
    const rows = await q("SELECT product_id, store, mismatch_qty, remark_str, is_verified FROM pick_pack_verifications ORDER BY product_id, store");
    assert.deepEqual(rows.map((r) => [r.product_id, r.store, r.mismatch_qty, r.remark_str, Number(r.is_verified)]), [
      [1, "ecr", 2, "counted twice", 0], [1, "kathirkamam", 3, null, 0], [2, null, 4, null, 1],
    ]);

    // The Verification page's list: a line's own store, or for an older combined line the report's stores.
    const list = await require("./pick_pack_verifications")(pool).getAll({ from_date: "2026-11-15", to_date: "2026-11-15" });
    assert.deepEqual(list.map((r) => [r.product_id, r.stores]).sort(), [[1, "ecr"], [1, "kathirkamam"], [2, "ecr (1), moolakulam (3)"]]);
  });

  it("puts the Picking write-off on the Write Off page per store, keeping remarks; older combined lines carry over", async () => {
    const line = (store, id, jt, short) => [jt, "warehouse", store, String(id), "a", "D", "C", "5", "5", "5", "0", "", String(short), "", "1", "0"];
    const up = (date, rows) => uc.upload({ report_type: "PICKING", report_date: date, file_name: `Picking_Report_${date}_ALL.csv`, headers: JOB, rows });
    const page = (date) => q("SELECT product_id, store, mismatch_qty, remark_str, is_verified FROM pick_pack_write_off WHERE date = ? ORDER BY product_id, store", [date]);

    const first = await up("2026-11-10", [line("ecr", 1, "STA", 2), line("ecr", 1, "GRN", 1), line("moolakulam", 1, "STA", 5), line("ecr", 2, "STA", 4), line("ecr", 99, "STA", 1)]);
    assert.deepEqual(first.data.summary.write_off_page, { added: 3, updated: 0, unchanged: 0, kept_verified: 0, unknown_articles: 1, removed: 0 });
    assert.deepEqual((await page("2026-11-10")).map((r) => [r.product_id, r.store, r.mismatch_qty]), [[1, "ecr", 3], [1, "moolakulam", 5], [2, "ecr", 4]]);

    await q("UPDATE pick_pack_write_off SET remark_str = 'shortage' WHERE product_id = 1 AND store = 'moolakulam'");
    await q("UPDATE pick_pack_write_off SET is_verified = 1 WHERE product_id = 2");
    const again = await up("2026-11-10", [line("ecr", 1, "STA", 3), line("moolakulam", 1, "STA", 6), line("ecr", 2, "STA", 9)]);
    assert.deepEqual(again.data.summary.write_off_page, { added: 0, updated: 1, unchanged: 1, kept_verified: 1, unknown_articles: 0, removed: 0 });
    assert.deepEqual((await page("2026-11-10")).map((r) => [r.product_id, r.store, r.mismatch_qty, r.remark_str, Number(r.is_verified)]), [
      [1, "ecr", 3, null, 0], [1, "moolakulam", 6, "shortage", 0], [2, "ecr", 4, null, 1],
    ]);

    // Lines from before (imported by hand, no store): the first store's line keeps the remark.
    await q("INSERT INTO pick_pack_write_off (product_id, mismatch_qty, date, store, remark_str) VALUES (3, 8, '2026-11-11', NULL, 'damaged')");
    const old = await up("2026-11-11", [line("ecr", 3, "STA", 2), line("kathirkamam", 3, "STA", 6)]);
    assert.deepEqual(old.data.summary.write_off_page, { added: 1, updated: 1, unchanged: 0, kept_verified: 0, unknown_articles: 0, removed: 0 });
    assert.deepEqual((await page("2026-11-11")).map((r) => [r.product_id, r.store, r.mismatch_qty, r.remark_str]), [[3, "ecr", 2, "damaged"], [3, "kathirkamam", 6, null]]);

    // The Write Off page's list: each line's store; an older line falls back to the report's stores.
    await q("INSERT INTO pick_pack_write_off (product_id, mismatch_qty, date, store) VALUES (2, 4, '2026-11-11', NULL)");
    await up("2026-11-11", [line("ecr", 3, "STA", 2), line("kathirkamam", 3, "STA", 6), line("ecr", 2, "STA", 1), line("ecr", 2, "GRN", 1), line("moolakulam", 2, "STA", 3)]);
    const list = await require("./pick_pack_write_off")(pool).getAll({ from_date: "2026-11-11", to_date: "2026-11-11" });
    assert.deepEqual(list.map((r) => [r.product_id, r.stores]).sort(), [[2, "ecr"], [2, "moolakulam"], [3, "ecr"], [3, "kathirkamam"]]);
  });

  it("pulls a day from RetailPilot: who did each job is kept, write-off goes to the Write Off page, a later upload is marked as such", async () => {
    await q("UPDATE product_table SET de_name = 'Hide & Seek', department_id = 1 WHERE product_id = 1");
    const spectra = {
      isConfigured: () => true,
      async queryAll(sql) {
        if (/masterhub\.stores/.test(sql)) return [{ slug: "wh", name: "Warehouse" }, { slug: "e", name: "ECR" }];
        if (/'PICKED'/.test(sql)) return [{ job_id: "job_1", job_type: "STA", state: "PICKED", assigned_user: "kp-7", article_id: "1", origin: "wh", destination: "e", advised_qty: "10", actual_qty: "7", meta: null }];
        if (/'LOADED'/.test(sql)) return [{ job_id: "job_5", job_type: "STA", state: "LOADED", assigned_user: "kp-1,kp-2", box_id: "B1", origin: "wh", destination: "e", truck_id: "T1", unloaded_store: null, meta: {}, article_id: "1", qty: "7", updated_at: "2026-11-12T07:00:00Z" }];
        return [];
      },
    };
    const rp = require("../usecase/wh_daily_reports")(repo, () => "2026-11-17", spectra);
    const res = await rp.pull({ from: "2026-11-12", to: "2026-11-12" });
    assert.equal(res.code, 200);
    assert.ok(res.data.days[0].reports.every((r) => r.ok));
    const [row] = await q("SELECT job_id, to_store, article_name, department, short_qty, worked_by FROM wh_report_job_rows WHERE report_date = '2026-11-12'");
    assert.deepEqual([row.job_id, row.to_store, row.article_name, row.department, Number(row.short_qty), row.worked_by], ["job_1", "ecr", "Hide & Seek", "Snacks", 3, "kp-7"]);
    const [box] = await q("SELECT worked_by, DATE_FORMAT(finished_at, '%H:%i') t FROM wh_report_box_rows WHERE report_date = '2026-11-12'");
    assert.deepEqual([box.worked_by, box.t], ["kp-1,kp-2", "12:30"]);
    assert.deepEqual((await q("SELECT store, mismatch_qty FROM pick_pack_write_off WHERE date = '2026-11-12'")).map((r) => [r.store, r.mismatch_qty]), [["ecr", 3]]);
    const status = await rp.status({ from: "2026-11-12", to: "2026-11-12" });
    assert.equal(status.data.uploads.length, 5);
    assert.ok(status.data.uploads.every((u) => u.source === "RETAILPILOT"));
    const a = await rp.analysis({ from: "2026-11-12", to: "2026-11-12" });
    assert.deepEqual(a.data.by_worker.filter((w) => w.report_type === "PICKING").map((w) => [w.worked_by, w.short_qty]), [["kp-7", 3]]);
  });

  it("a re-pull takes away lines the report no longer has, unless the team touched them", async () => {
    const line = (store, id, short) => ["STA", "warehouse", store, String(id), "a", "D", "C", "5", "5", "5", "0", "", String(short), "", "1", "0"];
    const up = (rows) => uc.upload({ report_type: "PICKING", report_date: "2026-11-13", file_name: "Picking_Report_2026-11-13_ALL.csv", headers: JOB, rows });
    await up([line("ecr", 1, 2), line("ecr", 2, 3), line("ecr", 3, 4), line("moolakulam", 3, 1)]);
    await q("UPDATE pick_pack_write_off SET remark_str = 'checked' WHERE date = '2026-11-13' AND product_id = 2");
    await q("UPDATE pick_pack_write_off SET is_verified = 1 WHERE date = '2026-11-13' AND product_id = 3 AND store = 'moolakulam'");
    const again = await up([line("ecr", 1, 2)]);
    assert.equal(again.data.summary.write_off_page.removed, 1);
    const left = await q("SELECT product_id, store FROM pick_pack_write_off WHERE date = '2026-11-13' ORDER BY product_id, store");
    assert.deepEqual(left.map((r) => [r.product_id, r.store]), [[1, "ecr"], [2, "ecr"], [3, "moolakulam"]]);
  });

  it("staff mapping: every RetailPilot user with where they worked; mapped names reach the analysis", async () => {
    // The RetailPilot pull test above left kp-7 picking at the warehouse and kp-1,kp-2 loading on 2026-11-12.
    const before = await uc.staff();
    const ids = before.data.staff.map((s) => s.rp_user_id);
    assert.ok(["kp-7", "kp-1", "kp-2"].every((id) => ids.includes(id)));
    const kp7 = before.data.staff.find((s) => s.rp_user_id === "kp-7");
    assert.deepEqual([kp7.stages.PICKING, kp7.main_store, kp7.last_date, kp7.employee_id], [1, "warehouse", "2026-11-12", null]);
    assert.deepEqual(before.data.employees.map((e) => [e.employee_id, e.store, e.designation]), [[7, "Warehouse", "Picker"]]);
    assert.equal((await uc.mapStaff({ rp_user_id: "kp-7", employee_id: 7, updated_by: 7 })).code, 200);
    assert.equal((await uc.mapStaff({ rp_user_id: "kp-7", employee_id: "x" })).code, 422);
    const after = await uc.staff();
    const mapped = after.data.staff.find((s) => s.rp_user_id === "kp-7");
    assert.deepEqual([mapped.employee_name, mapped.updated_by_name], ["Prashanth", "Prashanth"]);
    assert.equal(after.data.staff[after.data.staff.length - 1].rp_user_id, "kp-7");
    const a = await uc.analysis({ from: "2026-11-12", to: "2026-11-12" });
    assert.equal(a.data.staff_names["kp-7"], "Prashanth");
    await uc.mapStaff({ rp_user_id: "kp-7", employee_id: null });
    assert.equal((await uc.analysis({ from: "2026-11-12", to: "2026-11-12" })).data.staff_names["kp-7"], undefined);
  });

  it("fills NLC from RetailPilot on rows that have none, in both report shapes", async () => {
    await q("UPDATE wh_report_job_rows SET nlc = NULL, nlc_source = NULL WHERE report_date = '2026-11-16'");
    await q("UPDATE wh_report_box_rows SET nlc = NULL WHERE report_date = '2026-11-16'");
    nlcRows = ["1", "2", "3", "99"].map((id, i) => ({ article_id: id, stock_value: String(2 * (id === "1" ? 12 : 40 + i)), stock_qty: "2", avg_nlc: "1" }));
    const res = await uc.fillNlc({ from: "2026-11-16", to: "2026-11-16" });
    assert.equal(res.code, 200);
    assert.ok(res.data.rows_updated > 0);
    assert.equal(res.data.still_unpriced, 0);
    const [{ n }] = await q("SELECT COUNT(*) AS n FROM wh_report_job_rows WHERE report_date = '2026-11-16' AND nlc IS NULL");
    assert.equal(Number(n), 0);
    const priced = await q("SELECT nlc FROM wh_report_box_rows WHERE report_date = '2026-11-16' AND article_id = 1");
    assert.ok(priced.length > 0 && priced.every((b) => Number(b.nlc) === 12));
    nlcRows = [{ article_id: "2", stock_value: "45", stock_qty: "1", avg_nlc: "45" }];
  });

  it("deletes an upload with its rows, and the down migration removes everything", async () => {
    const [u] = await q("SELECT upload_id FROM wh_report_uploads WHERE report_type = 'LOADING' AND report_date = '2026-11-16'");
    assert.equal((await uc.deleteUpload({ upload_id: u.upload_id })).code, 200);
    const [{ c }] = await q("SELECT COUNT(*) AS c FROM wh_report_box_rows WHERE upload_id = ?", [u.upload_id]);
    assert.equal(Number(c), 0);
    await q(fs.readFileSync(path.join(__dirname, "../migrations/mysql/migrations/sqls/20261227120000-wh-box-stage-down.sql"), "utf8"));
    await q(fs.readFileSync(path.join(__dirname, "../migrations/mysql/migrations/sqls/20261226120000-warehouse-health-down.sql"), "utf8"));
    await q(fs.readFileSync(path.join(__dirname, "../migrations/mysql/migrations/sqls/20261225120000-wh-staff-map-down.sql"), "utf8"));
    assert.equal((await q("SHOW TABLES LIKE 'wh_rp_staff_map'")).length, 0);
    await q(fs.readFileSync(path.join(__dirname, "../migrations/mysql/migrations/sqls/20261224120000-wh-report-nlc-down.sql"), "utf8"));
    assert.equal((await q("SHOW COLUMNS FROM wh_report_job_rows LIKE 'mrp'")).length, 1);
    await q(fs.readFileSync(path.join(__dirname, "../migrations/mysql/migrations/sqls/20261223120000-wh-report-retailpilot-down.sql"), "utf8"));
    assert.equal((await q("SHOW COLUMNS FROM wh_report_job_rows LIKE 'worked_by'")).length, 0);
    await q(SQL("down"));
    assert.equal((await q("SHOW TABLES LIKE 'wh_report%'")).length, 0);
    assert.equal((await q("SELECT * FROM all_permissions")).length, 0);
    await q(SQL("up"));
  });
});
