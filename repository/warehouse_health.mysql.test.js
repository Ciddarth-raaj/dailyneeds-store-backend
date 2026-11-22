/**
 * Warehouse Health queries against a real MySQL (scratch database only).
 *
 *   WH_TEST_MYSQL=mysql://user:pass@localhost/scratch_db node --test repository/warehouse_health.mysql.test.js
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const URL = process.env.WH_TEST_MYSQL;
const MIG = (name) => fs.readFileSync(path.join(__dirname, `../migrations/mysql/migrations/sqls/${name}.sql`), "utf8");

describe("warehouse health repository", { skip: !URL && "WH_TEST_MYSQL not set" }, () => {
  let pool;
  let repo;
  let summary;
  const q = (sql, p = []) => new Promise((res, rej) => pool.query(sql, p, (e, r) => (e ? rej(e) : res(r))));

  before(async () => {
    pool = require("mysql").createPool(`${URL}?multipleStatements=true&supportBigNumbers=true&bigNumberStrings=true`);
    await q(`DROP TABLE IF EXISTS wh_chain_results, wh_chain_open_boxes, wh_chain_open, wh_chain_days, outlets, wh_health_summary_sends, wh_rp_staff_map, wh_report_box_rows, wh_report_job_rows, wh_report_uploads, new_employee, employee_telegram_identity, all_permissions, permissions, pick_pack_write_off, pick_pack_verifications, retailpilot_grn_lines, retailpilot_grn_headers`);
    await q(`CREATE TABLE new_employee (employee_id INT PRIMARY KEY, employee_name VARCHAR(80), status INT DEFAULT 1, store_id INT NULL, designation_id INT NULL, resignation_date DATE NULL);
             CREATE TABLE outlets (outlet_id INT PRIMARY KEY, outlet_name VARCHAR(80));
             CREATE TABLE employee_telegram_identity (employee_id INT, private_chat_id BIGINT NULL, disconnected_at DATETIME NULL);
             CREATE TABLE all_permissions (permission_key VARCHAR(100));
             CREATE TABLE permissions (designation_id INT, permission_key VARCHAR(100), is_active TINYINT DEFAULT 1);
             CREATE TABLE retailpilot_grn_headers (invoice_slug VARCHAR(64) PRIMARY KEY, entered_at DATETIME);
             CREATE TABLE retailpilot_grn_lines (line_id VARCHAR(64) PRIMARY KEY, invoice_slug VARCHAR(64), product_id INT, mrp DECIMAL(15,2));
             CREATE TABLE pick_pack_write_off (id INT AUTO_INCREMENT PRIMARY KEY, product_id INT, mismatch_qty INT, date DATE, store VARCHAR(100), remark_id INT NULL, remark_str VARCHAR(500) NULL, reason_employee_id INT NULL, is_verified TINYINT(1) NOT NULL DEFAULT 0);
             CREATE TABLE pick_pack_verifications (id INT AUTO_INCREMENT PRIMARY KEY, product_id INT, mismatch_qty INT, date DATE, store VARCHAR(100), remark_id INT NULL, remark_str VARCHAR(500) NULL, is_verified TINYINT(1) NOT NULL DEFAULT 0);`);
    for (const m of ["20261217120000-warehouse-daily-reports-up", "20261223120000-wh-report-retailpilot-up", "20261224120000-wh-report-nlc-up", "20261225120000-wh-staff-map-up", "20261226120000-warehouse-health-up", "20261227120000-wh-box-stage-up", "20261228120000-wh-job-state-up", "20261229120000-wh-job-finished-at-up", "20261230120000-wh-job-links-up", "20261231120000-wh-chain-store-up", "20270101120000-wh-chain-views-up"]) {
      // eslint-disable-next-line no-await-in-loop
      await q(MIG(m));
    }
    repo = require("./wh_daily_reports")(pool);
    summary = require("./warehouse_health_summary")(pool);
  });

  after(async () => {
    if (pool) await new Promise((r) => pool.end(r));
  });

  it("the migration adds the columns, the sends table and both permissions", async () => {
    assert.equal((await q("SHOW COLUMNS FROM wh_report_job_rows LIKE 'picking_job'")).length, 1);
    assert.equal((await q("SHOW COLUMNS FROM wh_report_job_rows LIKE 'stage_id'")).length, 1);
    const keys = (await q("SELECT permission_key FROM all_permissions WHERE permission_key LIKE '%warehouse_health%' ORDER BY 1")).map((r) => r.permission_key);
    assert.deepEqual(keys, ["receive_warehouse_health_summary", "view_warehouse_health"]);
  });

  it("stores stage_id / picking_job, traces store shortages to the picker", async () => {
    const day = "2026-11-19";
    const row = (o) => ({ job_type: "STA", from_store: "warehouse", to_store: "ecr", article_id: 1, article_name: "Milk", advised_qty: 10, actual_qty: 10, short_qty: 0, jobs: 1, open_jobs: 0, nlc: 20, nlc_source: "RETAILPILOT", ...o });
    await repo.replaceUpload({ report_type: "PICKING", report_date: day, source: "RETAILPILOT", shape: "JOB", file_name: "rp", uploaded_by: null, rows: [
      row({ report_type: "PICKING", job_id: "PJ1", stage_id: "S1", worked_by: "kp-1" }),
      row({ report_type: "PICKING", job_id: "PJ2", stage_id: "S2", article_id: 2, worked_by: "kp-2", short_qty: 3, actual_qty: 7 }),
    ] });
    await repo.replaceUpload({ report_type: "VERIFICATION", report_date: day, source: "RETAILPILOT", shape: "JOB", file_name: "rp", uploaded_by: null, rows: [
      row({ report_type: "VERIFICATION", job_id: "VJ1", stage_id: "S1", picking_job: "PJ1", short_qty: 2, actual_qty: 8 }),
      row({ report_type: "VERIFICATION", job_id: "VJ2", stage_id: "S2", article_id: 2, picking_job: null, short_qty: 1, actual_qty: 6 }),
      row({ report_type: "VERIFICATION", job_id: "VJ3", stage_id: "S9", article_id: 3, picking_job: null, short_qty: 1, actual_qty: 6 }),
    ] });
    const m = await repo.pickerMistakes(day, day);
    assert.deepEqual(m.map((x) => [x.worked_by, x.article_id, x.short_qty]).sort(), [["kp-1", 1, 2], ["kp-2", 2, 1]]);
    // only pickers working at the site (the picking's from-store), with the kind of job
    assert.equal((await repo.pickerMistakes(day, day, { site: "ecr" })).length, 0);
    const own = await repo.pickerMistakes(day, day, { site: (await q("SELECT from_store FROM wh_report_job_rows WHERE job_id = 'PJ1'"))[0].from_store });
    assert.equal(own.length, 2);
    assert.ok(own.every((x) => x.job_type));
    assert.equal((await repo.jobBreakdown(day, day, ["worked_by"], { report_type: "PICKING", from_store: "nowhere" })).length, 0);
    const work = await repo.jobBreakdown(day, day, ["worked_by"], { report_type: "PICKING" });
    const k2 = work.find((w) => w.worked_by === "kp-2");
    assert.equal(k2.actual_value, 140);
    assert.equal(k2.done_lines, 1);
  });

  it("remarks pending: the day and a 30-day backlog", async () => {
    await q(`INSERT INTO pick_pack_write_off (product_id, mismatch_qty, date, remark_str, is_verified) VALUES
             (1, 2, '2026-11-19', NULL, 0), (2, 2, '2026-11-19', 'damaged', 0), (3, 1, '2026-11-19', NULL, 1), (4, 1, '2026-11-10', NULL, 0), (5, 1, '2026-09-01', NULL, 0)`);
    await q("INSERT INTO pick_pack_verifications (product_id, mismatch_qty, date) VALUES (1, 1, '2026-11-19')");
    const r = Object.fromEntries((await repo.remarksPending("2026-11-19")).map((x) => [x.page, [x.total, x.pending, x.backlog]]));
    assert.deepEqual(r, { WRITE_OFF: [3, 1, 1], VERIFICATION: [1, 1, 0] });
  });

  it("summary recipients: only designations holding the right, not resigned; one record per day", async () => {
    await q(`INSERT INTO new_employee (employee_id, employee_name, designation_id, resignation_date) VALUES (1, 'Manager', 5, NULL), (2, 'Admin', 1, NULL), (3, 'Gone', 5, '2026-10-01');
             INSERT INTO permissions VALUES (5, 'receive_warehouse_health_summary', 1);
             INSERT INTO employee_telegram_identity VALUES (1, 998877665544, NULL);`);
    const rec = await summary.recipients("2026-11-21");
    assert.deepEqual(rec.map((r) => [Number(r.employee_id), String(r.private_chat_id)]), [[1, "998877665544"]]);
    await summary.record({ day: "2026-11-20", employee_id: 1, status: "FAILED", reason: "x", chat_id: 998877665544 });
    assert.equal((await summary.sentOn("2026-11-20")).size, 0);
    await summary.record({ day: "2026-11-20", employee_id: 1, status: "SENT", chat_id: 998877665544 });
    assert.deepEqual([...(await summary.sentOn("2026-11-20"))], [1]);
    assert.equal(String(await summary.chatOf(1)), "998877665544");
  });

  it("store managers: the right, their store's name, not those who get the warehouse summary; the site is recorded", async () => {
    await q(`INSERT INTO outlets VALUES (3, 'Vallalar Salai'), (4, 'ECR');
             INSERT INTO new_employee (employee_id, employee_name, designation_id, store_id) VALUES (20, 'SM Vallalar', 7, 3), (21, 'SM ECR', 7, 4), (22, 'Both', 8, 4);
             INSERT INTO permissions VALUES (7, 'receive_store_health_summary', 1), (8, 'receive_store_health_summary', 1), (8, 'receive_warehouse_health_summary', 1);
             INSERT INTO employee_telegram_identity VALUES (21, 11223344, NULL);`);
    const rec = await summary.storeRecipients("2026-11-21");
    assert.deepEqual(rec.map((r) => [Number(r.employee_id), r.outlet_name, r.private_chat_id == null ? null : String(r.private_chat_id)]), [[20, "Vallalar Salai", null], [21, "ECR", "11223344"]]);
    assert.equal(await summary.storeOf(20), "Vallalar Salai");
    await summary.record({ day: "2026-11-20", employee_id: 21, site: "ecr", status: "SENT", chat_id: 11223344 });
    assert.equal((await q("SELECT site FROM wh_health_summary_sends WHERE employee_id = 21"))[0].site, "ecr");
    assert.equal((await q("SELECT COUNT(*) AS c FROM all_permissions WHERE permission_key = 'receive_store_health_summary'"))[0].c, "1");
  });

  it("box trips: one row per loading / unloading job, with the document; articles of chosen trips", async () => {
    const day = "2026-11-20";
    const B = (o) => ({ report_type: "LOADING", job_type: "STA", from_store: "warehouse", planned_to_store: "ecr", box_id: "K1", truck_no: "T1", article_id: 1, article_name: "Milk", nlc: 20, box_qty: 5, box_status: "Loaded", finished_at: "2026-11-20 09:00:00", ...o });
    await repo.replaceUpload({ report_type: "LOADING", report_date: day, source: "RETAILPILOT", shape: "BOX", file_name: "rp", uploaded_by: null, rows: [
      B({ job_id: "j1", stage_id: "sta_1" }),
      B({ job_id: "j1", stage_id: "sta_1", article_id: 2, article_name: "Curd", box_qty: 3 }),
      B({ job_id: "j2", stage_id: "sta_2", finished_at: "2026-11-20 15:00:00" }),
    ] });
    const trips = await repo.boxSummary("LOADING", day, day);
    assert.deepEqual(trips.map((t) => [t.job_id, t.stage_id, t.articles, t.qty, t.value]).sort(), [["j1", "sta_1", 2, 8, 160], ["j2", "sta_2", 1, 5, 100]]);
    const items = await repo.boxArticles("LOADING", [{ report_date: day, box_id: "K1", planned_to_store: "ecr", job_id: "j1" }]);
    assert.deepEqual(items.map((i) => [i.job_id, i.article_name, i.qty]), [["j1", "Milk", 5], ["j1", "Curd", 3]]);
  });

  it("stage flows: done work per day, document, article and lane; pick-pack marked; open jobs left out", async () => {
    const day = "2026-11-21";
    const row = (o) => ({ report_type: "PICKING", job_type: "STA", from_store: "warehouse", to_store: "ecr", article_id: 1, article_name: "Milk", advised_qty: 10, actual_qty: 10, short_qty: 0, jobs: 1, open_jobs: 0, nlc: 20, nlc_source: "RETAILPILOT", stage_id: "sta_1", job_state: "PICKED", ...o });
    await repo.replaceUpload({ report_type: "PICKING", report_date: day, source: "RETAILPILOT", shape: "JOB", file_name: "rp", uploaded_by: null, rows: [
      row({ job_id: "p1", finished_at: "2026-11-21 11:05:00", short_qty: 1, actual_qty: 9 }),
      row({ job_id: "p2", actual_qty: 5 }),
      row({ job_id: "p3", stage_id: "inv_1", job_state: "PICKED_PACKED", actual_qty: 7 }),
      row({ job_id: "p4", job_state: "PICKING", open_jobs: 1, actual_qty: 3 }),
    ] });
    const { jobs } = await repo.stageFlows(day, day);
    const by = {};
    for (const j of jobs) by[`${j.stage_id}|${j.pick_pack}`] = (by[`${j.stage_id}|${j.pick_pack}`] || 0) + j.qty;
    // one row per job now: each line keeps the job it was done in
    assert.deepEqual(jobs.map((j) => j.job_id).sort(), ["p1", "p2", "p3"]);
    assert.deepEqual(by, { "sta_1|0": 14, "inv_1|1": 7 });
    const [w] = await repo.jobRows(day, day, { only: "short", report_type: "PICKING" });
    assert.deepEqual([w.job_id, w.stage_id, w.finished_at, w.short_qty], ["p1", "sta_1", "2026-11-21 11:05", 1]);
  });

  it("job links are kept and come back with the stage flows", async () => {
    const day = "2026-11-22";
    await repo.replaceUpload({ report_type: "LOADING", report_date: day, source: "RETAILPILOT", shape: "BOX", file_name: "rp", uploaded_by: null, rows: [
      { report_type: "LOADING", job_type: "GRN", from_store: "warehouse", planned_to_store: "moolakulam", box_id: "2061252838", truck_no: "T1", article_id: 103506, box_qty: 4, box_status: "Loaded", job_id: "job_58254998", packing_job: "job_84969325", packing_jobs: "job_84969325", picking_job: "job_50616283" },
    ] });
    const { boxes } = await repo.stageFlows(day, day);
    assert.deepEqual(boxes.map((b) => [b.job_id, b.packing_jobs, b.picking_job, b.no_link]), [["job_58254998", "job_84969325", "job_50616283", 0]]);
  });

  it("trace: the article's lines and boxes for that store, narrowed to the document", async () => {
    const t = await repo.trace({ article_id: 103506, to_store: "moolakulam", stage_id: null, from: "2026-10-10" });
    assert.deepEqual(t.boxes.map((b) => [b.report_type, b.box_id, b.job_id, b.qty, b.packing_jobs]), [["LOADING", "2061252838", "job_58254998", 4, "job_84969325"]]);
    const j = await repo.trace({ article_id: 1, to_store: "ecr", stage_id: "sta_1", from: "2026-10-10" });
    assert.ok(j.jobs.length > 0 && j.jobs.every((x) => x.stage_id === "sta_1"));
  });

  it("data version changes when a report is pulled again", async () => {
    const v1 = await repo.dataVersion();
    await repo.replaceUpload({ report_type: "PICKING", report_date: "2026-11-21", source: "RETAILPILOT", shape: "JOB", file_name: "rp", uploaded_by: null, rows: [] });
    assert.notEqual(await repo.dataVersion(), v1);
  });

  it("down migration", async () => {
    await q(MIG("20261230120000-wh-job-links-down"));
    assert.equal((await q("SHOW COLUMNS FROM wh_report_box_rows LIKE 'packing_jobs'")).length, 0);
    await q(MIG("20261229120000-wh-job-finished-at-down"));
    assert.equal((await q("SHOW COLUMNS FROM wh_report_job_rows LIKE 'finished_at'")).length, 0);
    await q(MIG("20261228120000-wh-job-state-down"));
    assert.equal((await q("SHOW COLUMNS FROM wh_report_job_rows LIKE 'job_state'")).length, 0);
    await q(MIG("20261227120000-wh-box-stage-down"));
    assert.equal((await q("SHOW COLUMNS FROM wh_report_box_rows LIKE 'stage_id'")).length, 0);
    await q(MIG("20261226120000-warehouse-health-down"));
    assert.equal((await q("SHOW TABLES LIKE 'wh_health_summary_sends'")).length, 0);
    assert.equal((await q("SHOW COLUMNS FROM wh_report_job_rows LIKE 'picking_job'")).length, 0);
  });
});
