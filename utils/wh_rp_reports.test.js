/**
 * Warehouse Daily Reports from RetailPilot - queries and row mapping.
 *
 *   node --test utils/wh_rp_reports.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const R = require("./wh_rp_reports");
const usecaseFactory = require("../usecase/wh_daily_reports");

const STORES = R.storeNames([{ slug: "wh1", name: "Warehouse" }, { slug: "st1", name: "Vallalar Salai" }, { slug: "st2", name: "ECR" }]);

describe("queries", () => {
  it("picking: finished that day, or still open from it; no sales orders", () => {
    const q = R.buildJobLinesQuery("PICKING", "2026-11-16");
    assert.match(q, /j\.state IN \('PICKED', 'PICKED_PACKED'\) AND \(\(j\.updated_at AT TIME ZONE 'Asia\/Kolkata'\)::date\) = DATE '2026-11-16'/);
    assert.match(q, /j\.state IN \('PICKING', 'PICK_PACK'\) AND \(\(j\.created_at AT TIME ZONE 'Asia\/Kolkata'\)::date\) = DATE '2026-11-16'/);
    assert.match(q, /j\.job_type <> 'SO'/);
    assert.match(R.buildJobLinesQuery("VERIFICATION", "2026-11-16"), /'VERIFIED'/);
    assert.match(R.buildBoxLinesQuery("UNLOADING", "2026-11-16"), /j\.state = 'UNLOADED'/);
  });
  it("refuses anything but a real day", () => {
    assert.throws(() => R.buildJobLinesQuery("PICKING", "2026-11-16'; DROP"));
    assert.throws(() => R.buildBoxLinesQuery("LOADING", "2026-02-30"));
    assert.throws(() => R.buildJobLinesQuery("LOADING", "2026-11-16"));
  });
});

describe("mapping", () => {
  const line = (o) => ({ job_id: "job_1", job_type: "sta", state: "PICKED", assigned_user: "u7", article_id: "100073", origin: "wh1", destination: "st1", advised_qty: "72", actual_qty: "70", ...o });
  it("job lines: short = advised - actual on finished jobs; open jobs are not write-off; store names", () => {
    const { rows, skipped } = R.mapJobLines("PICKING", [
      line(),
      line({ job_id: "job_2", state: "PICKING", actual_qty: "0" }),
      line({ article_id: "abc" }),
      line({ actual_qty: "80" }),
      line({ destination: "unknown-slug" }),
    ], STORES);
    assert.equal(skipped, 1);
    assert.deepEqual(rows.map((r) => [r.job_id, r.to_store, r.short_qty, r.open_jobs, r.worked_by]), [
      ["job_1", "vallalar salai", 2, 0, "u7"],
      ["job_2", "vallalar salai", 0, 1, "u7"],
      ["job_1", "vallalar salai", 0, 0, "u7"],
      ["job_1", "unknown-slug", 2, 0, "u7"],
    ]);
    assert.equal(rows[0].job_type, "STA");
    assert.equal(rows[0].from_store, "warehouse");
    assert.equal(rows[0].returned_qty, null);
    assert.equal(R.mapJobLines("VERIFICATION", [line({ state: "VERIFIED" })], STORES).rows[0].returned_qty, 2);
  });
  it("goods that stay at the store they are at (GRN kept at the warehouse, auto-picked) are not write-off", () => {
    const { rows } = R.mapJobLines("PICKING", [line({ job_type: "GRN", state: "PICKED_PACKED", destination: "wh1", advised_qty: "10000", actual_qty: "0" })], STORES);
    assert.deepEqual([rows[0].to_store, rows[0].short_qty], ["warehouse", 0]);
  });
  it("box lines: unloading keeps the box's original store as planned and skips boxes still on the truck", () => {
    const box = (o) => ({ job_id: "job_9", job_type: "STA", state: "UNLOADED", assigned_user: "u1,u2", box_id: "0380903545", origin: "wh1", destination: "st2", truck_id: "py-01-da-8159", unloaded_store: "st2", meta: '{"original_destination":"st1"}', article_id: "101742", qty: "50", updated_at: "2026-11-16T05:56:00Z", ...o });
    const { rows } = R.mapBoxLines("UNLOADING", [box(), box({ unloaded_store: null })], STORES);
    assert.equal(rows.length, 1);
    assert.deepEqual(
      [rows[0].planned_to_store, rows[0].unloaded_store, rows[0].truck_no, rows[0].box_qty, rows[0].finished_at, rows[0].worked_by, rows[0].box_status],
      ["vallalar salai", "ecr", "PY-01-DA-8159", 50, "2026-11-16 11:26:00", "u1,u2", "Unloaded"]
    );
    const loading = R.mapBoxLines("LOADING", [box({ state: "LOADED", meta: {}, unloaded_store: null })], STORES).rows[0];
    assert.deepEqual([loading.planned_to_store, loading.unloaded_store, loading.box_status], ["ecr", null, "Loaded"]);
  });
});

describe("usecase pull", () => {
  const spectra = (byQuery, fail = null) => ({
    isConfigured: () => true,
    queries: [],
    async queryAll(q) {
      this.queries.push(q);
      if (fail && fail(q)) throw new Error("SPECTRA error: whitelist_violation");
      if (/masterhub\.stores/.test(q)) return [{ slug: "wh1", name: "Warehouse" }, { slug: "st1", name: "Vallalar Salai" }];
      return byQuery(q);
    },
  });
  const repo = () => {
    const saved = [];
    return {
      saved,
      latestMrp: async () => new Map([[100073, 30]]),
      productInfo: async () => new Map([[100073, { article_name: "parle hide & seek 120g", department: "Snacks", category: "Biscuits" }]]),
      uploads: async () => [],
      replaceUpload: async (u) => (saved.push(u), { upload_id: saved.length, page: u.pageLines ? { added: u.pageLines.rows.length } : null }),
    };
  };
  const PICKED = { job_id: "job_1", job_type: "STA", state: "PICKED", assigned_user: "u7", article_id: "100073", origin: "wh1", destination: "st1", advised_qty: 72, actual_qty: 70 };

  it("saves each report for each day as RetailPilot, names from the product master, write-off to its page", async () => {
    const rp = repo();
    const s = spectra((q) => (/PICKED/.test(q) ? [PICKED] : []));
    const res = await usecaseFactory(rp, () => "2026-11-17", s).pull({ from: "2026-11-15", to: "2026-11-16" });
    assert.equal(res.code, 200);
    assert.equal(res.data.days.length, 2);
    assert.equal(rp.saved.length, 10);
    const pick = rp.saved.find((u) => u.report_type === "PICKING" && u.report_date === "2026-11-16");
    assert.equal(pick.source, "RETAILPILOT");
    assert.equal(pick.rows[0].article_name, "parle hide & seek 120g");
    assert.equal(pick.rows[0].mrp, 30);
    assert.deepEqual(pick.pageLines, { page: "WRITE_OFF", rows: [{ product_id: 100073, store: "vallalar salai", mismatch_qty: 2 }] });
    const day = res.data.days.find((d) => d.date === "2026-11-16");
    assert.equal(day.reports.find((r) => r.type === "PICKING").summary.write_off_page.added, 1);
    assert.equal(rp.saved.find((u) => u.report_type === "LOADING").rows.length, 0);
  });
  it("a report RetailPilot refuses is reported and leaves that day's report as it was", async () => {
    const rp = repo();
    const res = await usecaseFactory(rp, () => "2026-11-17", spectra(() => [], (q) => /box_dimension_joblets/.test(q))).pull({ from: "2026-11-16", to: "2026-11-16" });
    const failed = res.data.days[0].reports.filter((r) => !r.ok).map((r) => r.type);
    assert.deepEqual(failed, ["LOADING", "UNLOADING"]);
    assert.equal(rp.saved.length, 3);
  });
  it("refuses the future, long ranges, and no RetailPilot", async () => {
    const uc = usecaseFactory(repo(), () => "2026-11-17", spectra(() => []));
    assert.equal((await uc.pull({ from: "2026-11-18", to: "2026-11-18" })).code, 422);
    assert.equal((await uc.pull({ from: "2026-10-01", to: "2026-11-10" })).code, 422);
    assert.equal((await usecaseFactory(repo(), () => "2026-11-17").pull({ from: "2026-11-16", to: "2026-11-16" })).code, 502);
  });
});
