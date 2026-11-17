/**
 * Warehouse Daily Reports - file parsing, box matching and the usecase.
 *
 *   node --test utils/wh_daily_reports.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const W = require("./wh_daily_reports");
const usecaseFactory = require("../usecase/wh_daily_reports");

const JOB_HEADERS = ["Job Type", "From Store", "To Store", "Article ID", "Article Name", "Department", "Category", "Recommended Qty", "Planned Qty", "Advised Qty", "Actual Qty", "MRP Split", "Short Qty", "Returned Qty", "Jobs", "Open Jobs"];
const job = (o = {}) => {
  const r = { "Job Type": "STA", "From Store": "warehouse", "To Store": "Vallalar Salai", "Article ID": "100073", "Article Name": "parle hide & seek 120g", Department: "Snacks", Category: "Biscuits", "Recommended Qty": "72", "Planned Qty": "72", "Advised Qty": "72", "Actual Qty": "72", "MRP Split": '[{"mrp":30,"qty":72}]', "Short Qty": "0", "Returned Qty": "", Jobs: "1", "Open Jobs": "0", ...o };
  return JOB_HEADERS.map((h) => r[h]);
};
const LOAD_HEADERS = ["Job Type", "From Store", "Planned To Store", "Box ID", "Box Kind", "Truck No", "Article ID", "Article Name", "Department", "Category", "MRP Split", "Box Qty", "Box Status", "Finished At"];
const UNLOAD_HEADERS = ["Job Type", "From Store", "Planned To Store", "Unloaded Store", "Box ID", "Box Kind", "Truck No", "Article ID", "Article Name", "Department", "Category", "MRP Split", "Box Qty", "Box Status", "Finished At"];

describe("file names", () => {
  it("reads the date and the report", () => {
    assert.equal(W.dateFromFileName("Picking_Report_2026-11-16_ALL_1.csv"), "2026-11-16");
    assert.equal(W.dateFromFileName("report.csv"), null);
    assert.equal(W.typeFromFileName("Unloading_Report_2026-11-16_ALL.csv"), "UNLOADING");
    assert.equal(W.typeFromFileName("Loading_Report_2026-11-16_ALL.csv"), "LOADING");
    assert.equal(W.typeFromFileName("Verification_Report_2026-11-16_ALL_1.csv"), "VERIFICATION");
    assert.equal(W.typeFromFileName("today.xlsx"), null);
  });
});

describe("cells", () => {
  it("MRP from the split: single, weighted, empty", () => {
    assert.equal(W.mrpFromSplit('[{"mrp":30,"qty":72}]'), 30);
    assert.equal(W.mrpFromSplit('[{"mrp":10,"qty":1},{"mrp":20,"qty":3}]'), 17.5);
    assert.equal(W.mrpFromSplit(""), null);
    assert.equal(W.mrpFromSplit("[]"), null);
    assert.equal(W.mrpFromSplit("not json"), null);
  });
  it("Finished At, 12-hour IST", () => {
    assert.equal(W.parseFinishedAt("16 Nov 2026 11:26 AM"), "2026-11-16 11:26:00");
    assert.equal(W.parseFinishedAt("16 Nov 2026 01:05 PM"), "2026-11-16 13:05:00");
    assert.equal(W.parseFinishedAt("16 Nov 2026 12:14 PM"), "2026-11-16 12:14:00");
    assert.equal(W.parseFinishedAt("16 Nov 2026 12:14 AM"), "2026-11-16 00:14:00");
    assert.equal(W.parseFinishedAt("2026-11-16 09:00"), "2026-11-16 09:00:00");
    assert.equal(W.parseFinishedAt("yesterday"), null);
  });
});

describe("parseRows", () => {
  it("reads a picking file: stores lower-cased, blanks null, short defaults to 0", () => {
    const { rows, errors } = W.parseRows("PICKING", JOB_HEADERS, [
      job(),
      job({ "Article ID": "102654", "Actual Qty": "0", "MRP Split": "", "Short Qty": "72" }),
      ["", "", ""],
      job({ "Job Type": "ALLOC", "Planned Qty": "", "Short Qty": "" }),
    ]);
    assert.deepEqual(errors, []);
    assert.equal(rows.length, 3);
    assert.equal(rows[0].to_store, "vallalar salai");
    assert.equal(rows[0].mrp, 30);
    assert.equal(rows[0].returned_qty, null);
    assert.equal(rows[1].short_qty, 72);
    assert.equal(rows[1].mrp, null);
    assert.equal(rows[2].planned_qty, null);
    assert.equal(rows[2].short_qty, 0);
  });
  it("finds columns by name in any order", () => {
    const headers = [...JOB_HEADERS].reverse();
    const { rows } = W.parseRows("PACKING", headers, [job().reverse()]);
    assert.equal(rows[0].article_id, 100073);
  });
  it("rejects the wrong file and says what it looks like", () => {
    const { errors } = W.parseRows("PICKING", UNLOAD_HEADERS, [[]]);
    assert.match(errors[0], /not the Picking report/);
    assert.match(errors[0], /looks like the Unloading report/);
    assert.match(W.parseRows("UNLOADING", LOAD_HEADERS, [[]]).errors[0], /missing Unloaded Store/);
  });
  it("names bad lines", () => {
    const { errors } = W.parseRows("PICKING", JOB_HEADERS, [job(), job({ "Article ID": "abc" }), job({ "Short Qty": "x" })]);
    assert.deepEqual(errors, ['Line 3: Article ID "abc" is not a number', 'Line 4: Short Qty "x" is not a number']);
  });
  it("reads loading and unloading boxes", () => {
    const row = ["STA", "warehouse", "vallalar salai", "vallalar salai", "0380903545", "Carton", "py-01-da-8159", "101742", "channa", "Foodgrains", "Dals", '[{"mrp":100,"qty":50}]', "50", "Unloaded", "16 Nov 2026 11:26 AM"];
    const { rows, errors } = W.parseRows("UNLOADING", UNLOAD_HEADERS, [row]);
    assert.deepEqual(errors, []);
    assert.equal(rows[0].box_id, "0380903545");
    assert.equal(rows[0].truck_no, "PY-01-DA-8159");
    assert.equal(rows[0].unloaded_store, "vallalar salai");
    assert.equal(rows[0].finished_at, "2026-11-16 11:26:00");
    assert.equal(rows[0].mrp, 100);
  });
});

describe("reconcileBoxes", () => {
  const L = (o) => ({ report_date: "2026-11-16", box_id: "B1", article_id: 1, job_type: "STA", from_store: "warehouse", planned_to_store: "ecr", truck_no: "T1", box_qty: 10, mrp: 5, finished_at: "2026-11-16 10:00:00", ...o });
  const U = (o) => ({ ...L(o), unloaded_store: "ecr", finished_at: "2026-11-16 12:00:00", ...o });
  it("gives each loaded line a status", () => {
    const lines = W.reconcileBoxes(
      [L(), L({ box_id: "B2" }), L({ box_id: "B3" }), L({ box_id: "B4" }), L({ box_id: "B5", job_type: "DAMG", planned_to_store: "warehouse" }), L({ box_id: "B6", report_date: "2026-11-15" })],
      [U(), U({ box_id: "B2", box_qty: 8 }), U({ box_id: "B3", unloaded_store: "ecr2" }), U({ box_id: "B6" }), U({ box_id: "B9" })],
      { lastUnloadDate: "2026-11-17" }
    );
    const st = Object.fromEntries(lines.map((l) => [l.box_id, l.status]));
    assert.deepEqual(st, { B1: "OK", B2: "QTY_DIFF", B3: "WRONG_STORE", B4: "NOT_UNLOADED", B5: "RETURN", B6: "OK", B9: "NOT_LOADED" });
  });
  it("a box loaded on the last day there is unloading for is open, not missing", () => {
    const [l] = W.reconcileBoxes([L()], [], { lastUnloadDate: "2026-11-16" });
    assert.equal(l.status, "OPEN");
  });
  it("does not match an unloading two days later", () => {
    const lines = W.reconcileBoxes([L({ report_date: "2026-11-14" })], [U()], { lastUnloadDate: "2026-11-16" });
    assert.deepEqual(lines.map((l) => l.status).sort(), ["NOT_LOADED", "NOT_UNLOADED"]);
  });
});

describe("usecase upload", () => {
  const fakeRepo = (over = {}) => {
    const saved = [];
    return {
      saved,
      latestMrp: async (ids) => new Map(ids.filter((id) => id === 102654).map((id) => [id, 45])),
      uploads: async () => [],
      replaceUpload: async (u) => (saved.push(u), 7),
      ...over,
    };
  };
  const uc = (repo) => usecaseFactory(repo, () => "2026-11-17");
  const body = (o = {}) => ({ report_type: "PICKING", report_date: "2026-11-16", file_name: "Picking_Report_2026-11-16_ALL.csv", headers: JOB_HEADERS, rows: [job(), job({ "Article ID": "102654", "Actual Qty": "0", "MRP Split": "", "Short Qty": "72" })], employee_id: 3, ...o });

  it("prices short rows from GRN and sums the write-off", async () => {
    const repo = fakeRepo();
    const res = await uc(repo).upload(body());
    assert.equal(res.code, 200);
    assert.deepEqual(res.data.summary, { rows: 2, short_lines: 1, short_qty: 72, short_value: 3240, short_unpriced_lines: 0, open_lines: 0 });
    assert.equal(repo.saved[0].rows[0].mrp_source, "FILE");
    assert.equal(repo.saved[0].rows[1].mrp_source, "GRN");
    assert.equal(repo.saved[0].uploaded_by, 3);
  });
  it("refuses a file named for another report or day, and future days", async () => {
    assert.equal((await uc(fakeRepo()).upload(body({ report_type: "PACKING" }))).code, 422);
    assert.equal((await uc(fakeRepo()).upload(body({ report_date: "2026-11-15" }))).code, 409);
    assert.equal((await uc(fakeRepo()).upload(body({ report_date: "2026-11-15", allow_date_mismatch: true }))).code, 200);
    assert.equal((await uc(fakeRepo()).upload(body({ report_date: "2026-11-18", file_name: "x.csv" }))).code, 422);
  });
  it("says when it replaced an earlier upload", async () => {
    const res = await uc(fakeRepo({ uploads: async () => [{ report_type: "PICKING" }] })).upload(body());
    assert.equal(res.data.replaced, true);
  });
  it("limits the analysis range", async () => {
    assert.equal((await uc(fakeRepo()).analysis({ from: "2026-01-01", to: "2026-11-16" })).code, 422);
    assert.equal((await uc(fakeRepo()).analysis({ from: "2026-11-16", to: "2026-11-01" })).code, 422);
  });
});
