/**
 * The stored stage chain against a real MySQL (scratch database only):
 *   WH_TEST_MYSQL=mysql://user:pass@localhost/scratch_db node --test repository/wh_chain.mysql.test.js
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const URL = process.env.WH_TEST_MYSQL;
const MIG = (name) => fs.readFileSync(path.join(__dirname, `../migrations/mysql/migrations/sqls/${name}.sql`), "utf8");

describe("stored stage chain", { skip: !URL && "WH_TEST_MYSQL not set" }, () => {
  let pool;
  let repo;
  let chainRepo;
  const q = (sql, p = []) => new Promise((res, rej) => pool.query(sql, p, (e, r) => (e ? rej(e) : res(r))));

  before(async () => {
    pool = require("mysql").createPool(`${URL}?multipleStatements=true&supportBigNumbers=true&bigNumberStrings=true`);
    await q(`DROP TABLE IF EXISTS wh_chain_results, wh_chain_open_boxes, wh_chain_open, wh_chain_days, wh_health_summary_sends, wh_rp_staff_map, wh_report_box_rows, wh_report_job_rows, wh_report_uploads, new_employee, all_permissions, permissions, pick_pack_write_off, pick_pack_verifications, retailpilot_grn_lines, retailpilot_grn_headers`);
    await q(`CREATE TABLE new_employee (employee_id INT PRIMARY KEY, employee_name VARCHAR(80), status INT DEFAULT 1, store_id INT NULL, designation_id INT NULL, resignation_date DATE NULL);
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
    chainRepo = require("./wh_chain")(pool);
  });

  after(async () => {
    if (pool) await new Promise((r) => pool.end(r));
  });

  it("works out the days from 10 Oct, carries what waits, reads it back; a re-pull redoes from its day", async () => {
    const J = (type, day, o) => repo.replaceUpload({ report_type: type, report_date: day, source: "RETAILPILOT", shape: "JOB", file_name: "rp", uploaded_by: null, rows: [{ report_type: type, job_type: "GRN", from_store: "warehouse", to_store: "moolakulam", article_id: 103506, article_name: "fortune 5l", advised_qty: 8, actual_qty: 8, short_qty: 0, jobs: 1, open_jobs: 0, nlc: 860, nlc_source: "RETAILPILOT", stage_id: "INV-Su", ...o }] });
    await J("PICKING", "2026-10-10", { job_id: "job_50616283", job_state: "PICKED_PACKED" });
    await J("PACKING", "2026-10-10", { job_id: "job_74080794", picking_job: "job_50616283", actual_qty: 4, advised_qty: 4, job_state: "PACKED" });
    const uc = require("../usecase/wh_chain")({ chainRepo, repo, today: () => "2026-10-12", pauseMs: 0 });
    await uc.ensure();
    const days = await q("SELECT DATE_FORMAT(chain_date, '%Y-%m-%d') AS d, status FROM wh_chain_days ORDER BY chain_date");
    assert.deepEqual(days.map((r) => [r.d, r.status]), [["2026-10-10", "DONE"], ["2026-10-11", "DONE"], ["2026-10-12", "DONE"]]);
    let r = await uc.read("2026-10-12");
    let g = Object.fromEntries(r.result.stage.gaps.map((x) => [x.key, x]));
    assert.deepEqual([g.to_load.from_earlier, g.to_load.stands, g.to_load.oldest_days], [8, 8, 2]); // pick-packed 8 on 10 Oct, not loaded
    // waiting both ways: sent by the warehouse, and on its way to Moolakulam
    assert.deepEqual((await q("SELECT view_key FROM wh_chain_open WHERE chain_date = '2026-10-12' ORDER BY view_key")).map((x) => x.view_key), ["from:warehouse", "to:moolakulam"]);
    assert.deepEqual(await uc.sites("2026-10-12"), ["moolakulam", "warehouse"]);
    const to = await uc.read("2026-10-12", "to:moolakulam");
    assert.equal(to.result.stage.gaps.find((x) => x.key === "to_load").stands, 8);

    // 11 Oct pulled again, now with the loading: 11 and 12 Oct are redone
    await repo.replaceUpload({ report_type: "LOADING", report_date: "2026-10-11", source: "RETAILPILOT", shape: "BOX", file_name: "rp", uploaded_by: null, rows: [
      { report_type: "LOADING", job_type: "GRN", from_store: "warehouse", planned_to_store: "moolakulam", box_id: "2061252838", truck_no: "T1", article_id: 103506, box_qty: 8, box_status: "Loaded", job_id: "job_60816557", picking_job: "job_50616283", packing_jobs: "job_74080794", finished_at: "2026-10-11 13:06:00" },
    ] });
    await uc.markFrom("2026-10-11");
    await uc.running;
    r = await uc.read("2026-10-12");
    g = Object.fromEntries(r.result.stage.gaps.map((x) => [x.key, x]));
    assert.deepEqual([g.to_load.stands, r.final], [0, true]);
    assert.deepEqual([r.result.box.loaded.boxes, r.result.box.still_open.boxes, r.result.box.still_open.oldest_days], [0, 1, 1]);
    assert.equal(r.result.box.lists.still_open[0].box_id, "2061252838");
    const p = await chainRepo.progress("2026-10-12");
    assert.deepEqual([p.todo, p.done], [0, 3]);
  });

  it("down migration", async () => {
    await q(MIG("20270101120000-wh-chain-views-down"));
    assert.equal((await q("SHOW TABLES LIKE 'wh_chain_results'")).length, 0);
    await q(MIG("20261231120000-wh-chain-store-down"));
    assert.equal((await q("SHOW TABLES LIKE 'wh_chain%'")).length, 0);
  });
});
