const test = require("node:test");
const assert = require("node:assert");
const H = require("./warehouse_health");

const base = {
  date: "2026-11-19",
  uploads: [{ report_type: "PICKING" }, { report_type: "VERIFICATION" }, { report_type: "LOADING" }],
  summary: [
    { report_type: "PICKING", lines: 1200, done_lines: 956, actual_qty: 9000, actual_value: 412000, short_lines: 115, short_qty: 2750, short_value: 48210, open_lines: 244 },
    { report_type: "VERIFICATION", lines: 400, done_lines: 398, short_lines: 3, short_qty: 7, short_value: 300, open_lines: 2 },
  ],
  byJobType: [
    { report_type: "PICKING", job_type: "STA", short_lines: 85, short_qty: 2000, short_value: 30000 },
    { report_type: "PICKING", job_type: "GRN", short_lines: 30, short_qty: 750, short_value: 18210 },
    { report_type: "VERIFICATION", job_type: "STA", short_lines: 3 },
  ],
  byStore: [
    { report_type: "PICKING", to_store: "kathirkamam", job_type: "STA", short_lines: 40, short_qty: 1000, short_value: 8000, open_lines: 0 },
    { report_type: "PICKING", to_store: "kathirkamam", job_type: "GRN", short_lines: 5, short_qty: 43, short_value: 1000, open_lines: 0 },
    { report_type: "PICKING", to_store: "moolakulam", job_type: "STA", short_lines: 30, short_qty: 1200, short_value: 20000, open_lines: 10 },
  ],
  yetToVerify: [{ to_store: "warehouse", from_store: "muthialpet", article_id: "A1", article_name: "Soan papdi", advised_qty: 5, actual_qty: 0, nlc: 40 }],
  remarks: [{ page: "WRITE_OFF", total: 115, pending: 115, backlog: 0 }],
  boxLines: [
    { report_date: "2026-11-19", box_id: "B1", status: "NOT_ON_TRUCK", truck_no: null, loaded_qty: 4, nlc: 10, planned_to_store: "ecr" },
    { report_date: "2026-11-19", box_id: "B2", status: "OK", truck_no: "TN01", loaded_qty: 4, unloaded_qty: 4, unload_date: "2026-11-19" },
    { report_date: "2026-11-19", box_id: "B3", status: "NOT_UNLOADED", truck_no: "TN01", loaded_qty: 2, nlc: 5, planned_to_store: "ecr" },
    { report_date: "2026-11-19", box_id: "B4", status: "RETURN", truck_no: "TN01", loaded_qty: 3, nlc: 5, planned_to_store: "warehouse" },
  ],
  repeats: [{ article_id: "A9", article_name: "milk", days_short: 3 }, { article_id: "A8", days_short: 1 }],
  trend: [{ report_date: "2026-11-19", report_type: "PICKING", short_lines: 115, short_qty: 2750, short_value: 48210 }],
  trendUploads: [{ report_date: "2026-11-19", report_type: "PICKING" }],
  pickerWork: [
    { worked_by: "u1", done_lines: 500, actual_qty: 4000, actual_value: 200000 },
    { worked_by: "u2", done_lines: 100, actual_qty: 800, actual_value: 30000 },
  ],
  pickerMistakes: [
    { worked_by: "u2", report_date: "2026-11-18", to_store: "ecr", article_id: "A1", short_qty: 2, nlc: 10 },
    { worked_by: "u2", report_date: "2026-11-18", to_store: "ecr", article_id: "A2", short_qty: 1, nlc: 10 },
    { worked_by: "u2", report_date: "2026-11-18", to_store: "ecr", article_id: "A3", short_qty: 1, nlc: 10 },
  ],
  staffNames: { u1: "Ravi" },
};

test("picking write-off is headed by lines, value and qty after", () => {
  const h = H.buildHealth(base);
  assert.deepStrictEqual([h.tiles.writeoff.lines, h.tiles.writeoff.qty, h.tiles.writeoff.value], [115, 2750, 48210]);
  assert.match(h.need_you[0].text, /^Picking write-off 115 lines · ₹48,210 \(2,750 qty\) - STA 85, GRN 30$/);
  assert.deepStrictEqual(h.tiles.writeoff.by_job_type.map((t) => [t.job_type, t.lines, t.value]), [["STA", 85, 30000], ["GRN", 30, 18210]]);
  assert.deepStrictEqual(h.stores[0].picking_by_type, { STA: { lines: 40, value: 8000 }, GRN: { lines: 5, value: 1000 } });
  assert.strictEqual(h.stores[0].store, "kathirkamam"); // most lines first, not most qty
  assert.strictEqual(h.trend[6].short_lines, 115);
  assert.strictEqual(h.trend.length, 7);
});

test("a box on a truck and not unloaded is a problem, even before the next day's unloading is pulled", () => {
  const h = H.buildHealth({ ...base, boxLines: [{ report_date: "2026-11-19", box_id: "B7", status: "OPEN", truck_no: "TN01", loaded_qty: 5, nlc: 2, planned_to_store: "ecr" }] });
  assert.strictEqual(h.tiles.unloading.problems, 1);
  assert.strictEqual(h.tiles.unloading.list[0].status, "NOT_UNLOADED");
  assert.strictEqual(h.tiles.unloading.waiting.length, 0);
  assert.ok(h.need_you.some((i) => i.key === "unloading"));
});

test("unloading is by box: an unloaded box missing an article, or with a quantity difference, is for verification, not unloading", () => {
  const L = (o) => ({ report_date: "2026-11-19", truck_no: "TN01", loaded_qty: 5, nlc: 2, planned_to_store: "ecr", ...o });
  const h = H.buildHealth({
    ...base,
    boxLines: [
      L({ box_id: "A", article_id: 1, status: "OK", unloaded_qty: 5, unload_date: "2026-11-19" }),
      L({ box_id: "A", article_id: 2, status: "NOT_UNLOADED" }),
      L({ box_id: "C", article_id: 1, status: "QTY_DIFF", unloaded_qty: 4, unload_date: "2026-11-19" }),
      L({ box_id: "B", article_id: 1, status: "OPEN" }),
    ],
  });
  const u = h.tiles.unloading;
  assert.deepStrictEqual([u.loaded_boxes, u.unloaded_boxes, u.not_unloaded, u.problems], [3, 2, 1, 1]);
  // The numbers add up: on trucks - unloaded = not unloaded.
  assert.strictEqual(u.loaded_boxes - u.unloaded_boxes, u.not_unloaded);
  assert.deepStrictEqual(u.list.map((x) => [x.box_id, x.status]), [["B", "NOT_UNLOADED"]]);
  // What was in the box, article by article.
  assert.deepStrictEqual(u.list[0].items, [{ article_id: 1, article_name: null, qty: 5, value: 10 }]);
});

test("a box unloaded under another day's key or with other article ids still counts as unloaded once", () => {
  const L = (o) => ({ report_date: "2026-11-19", truck_no: "TN01", loaded_qty: 5, nlc: 2, planned_to_store: "ecr", ...o });
  const h = H.buildHealth({
    ...base,
    boxLines: [
      L({ box_id: "X", article_id: 1, status: "NOT_UNLOADED" }),
      { report_date: "2026-11-19", box_id: "X", article_id: 9, status: "NOT_LOADED", unloaded_qty: 5, unload_date: "2026-11-20", unloaded_store: "ecr" },
      L({ box_id: "Y", article_id: 1, status: "OK", unloaded_qty: 5, unload_date: "2026-11-19" }),
      L({ box_id: "Z", article_id: 1, status: "OPEN" }),
    ],
  });
  const u = h.tiles.unloading;
  assert.deepStrictEqual([u.loaded_boxes, u.unloaded_boxes, u.not_unloaded, u.not_loaded, u.problems], [3, 2, 1, 0, 1]);
  assert.deepStrictEqual(u.list.map((x) => x.box_id), ["Z"]);
  assert.deepStrictEqual(h.flow.not_unloaded.map((x) => x.box_id), ["Z"]);
  assert.strictEqual(h.flow.unloaded_boxes, 2);
});

test("boxes: not on a truck is separate from not delivered", () => {
  const h = H.buildHealth(base);
  assert.strictEqual(h.tiles.boxes.not_on_truck, 1);
  assert.deepStrictEqual([h.tiles.loading.boxes, h.tiles.loading.on_truck, h.tiles.loading.not_on_truck, h.tiles.loading.list[0].box_id], [4, 3, 1, "B1"]);
  // B4 is a damage return: apart from the boxes expected at stores.
  assert.deepStrictEqual([h.tiles.unloading.loaded_boxes, h.tiles.unloading.unloaded_boxes, h.tiles.unloading.problems, h.tiles.unloading.list[0].box_id], [2, 1, 1, "B3"]);
  assert.deepStrictEqual(h.tiles.unloading.waiting.map((x) => [x.box_id, x.status]), [["B4", "RETURN"]]);
  assert.deepStrictEqual(h.need_you.filter((i) => ["loading", "unloading"].includes(i.key)).map((i) => i.key), ["loading", "unloading"]);
  assert.strictEqual(h.tiles.boxes.not_unloaded, 1);
  assert.strictEqual(h.flow.loading_list_boxes, 4);
  assert.strictEqual(h.flow.on_truck_boxes, 3);
  assert.strictEqual(h.flow.unloaded_boxes, 1);
  // The difference between boxes on trucks and unloaded, box by box, with why - a return is not a problem but is listed.
  assert.deepStrictEqual(h.flow.not_unloaded.map((b) => [b.box_id, b.status]).sort(), [["B3", "NOT_UNLOADED"], ["B4", "RETURN"]]);
  assert.strictEqual(h.flow.not_unloaded_boxes, 2);
  assert.strictEqual(h.flow.trucks, 1);
});

test("yet to verify, returns labelled; remarks; missing reports; repeats", () => {
  const h = H.buildHealth(base);
  assert.strictEqual(h.tiles.verification.yet_to_verify_qty, 5);
  assert.strictEqual(h.tiles.verification.yet_to_verify[0].is_return, true);
  assert.strictEqual(h.tiles.remarks.write_off.pending, 115);
  assert.deepStrictEqual(h.missing_reports, ["Packing", "Unloading"]);
  assert.deepStrictEqual(h.repeats.map((r) => r.article_id), ["A9"]);
});

test("pickers: lines and value, mistakes traced, accuracy below 98% flagged", () => {
  const [p1, p2] = H.buildHealth(base).pickers;
  assert.strictEqual(p1.name, "Ravi");
  assert.strictEqual(p1.mapped, true);
  assert.strictEqual(p1.accuracy, 1);
  assert.strictEqual(p2.name, "u2");
  assert.strictEqual(p2.mistake_lines, 3);
  assert.strictEqual(p2.mistake_value, 40);
  assert.strictEqual(p2.accuracy, 0.97);
  assert.strictEqual(p2.below_target, true);
});

test("telegram text", () => {
  const t = H.formatTelegram(H.buildHealth(base));
  assert.match(t, /Picking write-off 115 lines/);
  assert.match(t, /Yet to verify at: Warehouse \(returns\) 5/);
  assert.match(t, /Pickers below 98% this month - Others \(Alloc, GRN, DAMG\): u2 97.0%/);
  assert.match(t, /Not pulled yet: Packing, Unloading/);
  assert.strictEqual(H.formatTelegram(H.buildHealth({ date: "2026-11-19" })), "Warehouse Health - Thu, 19 Nov\nNo reports for this day yet.");
});

test("picking write-off: every line with what, where, who and when, most value first", () => {
  const h = H.buildHealth({
    ...base,
    writeoffLines: [
      { article_id: 5, article_name: "Atta 5kg", job_type: "sta", from_store: "warehouse", to_store: "ecr", advised_qty: 10, actual_qty: 7, short_qty: 3, nlc: 200, worked_by: "u1", finished_at: "2026-11-19 11:05", job_id: "job_1", stage_id: "sta_9" },
      { article_id: 6, article_name: "Salt", job_type: "DAMG", from_store: "ecr", to_store: "warehouse", advised_qty: 4, actual_qty: 0, short_qty: 4, nlc: 20, worked_by: "zz", finished_at: null, job_id: "job_2", stage_id: null },
    ],
  });
  const [a, b] = h.tiles.writeoff.list;
  assert.deepStrictEqual([a.article_name, a.job_type, a.to_store, a.short_qty, a.value, a.picker_name, a.picker_mapped, a.finished_at, a.job_id], ["Atta 5kg", "STA", "ecr", 3, 600, "Ravi", true, "2026-11-19 11:05", "job_1"]);
  assert.deepStrictEqual([b.picker_name, b.picker_mapped, b.value], ["zz", false, 80]);
});

test("remarks (written next day) and open jobs (every night) are not things that need you, nor cards in the PDF", () => {
  const h = H.buildHealth(base);
  assert.deepStrictEqual(h.need_you.filter((i) => ["remarks", "jobs"].includes(i.key)), []);
  const html = require("./warehouse_health_pdf").buildHtml(h, { nowMs: 0 });
  for (const t of ["Remarks pending", "Jobs not finished", "Open lines", "Flow of goods", "Picking write-off, last 7 days", "<h2>Stores</h2>", '<div class="cl">Loading', '<div class="cl">Unloading', '<div class="cl">Verification']) assert.ok(!html.includes(t), t);
  assert.ok(html.includes('<div class="cl">Picking write-off'));
});

test("pickers split into STA and the rest (Alloc with them), each with its own accuracy", () => {
  const work = [
    { worked_by: "u1", job_type: "STA", done_lines: 90, actual_qty: 900, actual_value: 9000 },
    { worked_by: "u1", job_type: "ALLOC", done_lines: 10, actual_qty: 10, actual_value: 100 },
    { worked_by: "u1", job_type: "GRN", done_lines: 50, actual_qty: 500, actual_value: 5000 },
    { worked_by: "u2", job_type: "DAMG", done_lines: 20, actual_qty: 20, actual_value: 200 },
  ];
  const mistakes = [
    { worked_by: "u1", job_type: "STA", short_qty: 1, nlc: 10, report_date: "2026-11-19", to_store: "ecr", article_id: "A" },
    { worked_by: "u1", job_type: "STA", short_qty: 1, nlc: 10, report_date: "2026-11-19", to_store: "ecr", article_id: "B" },
    { worked_by: "u1", job_type: "STA", short_qty: 1, nlc: 10, report_date: "2026-11-19", to_store: "ecr", article_id: "C" },
  ];
  const h = H.buildHealth({ ...base, pickerWork: work, pickerMistakes: mistakes, staffNames: { u1: "Ravi" } });
  const [sta, other] = h.picker_groups;
  assert.deepStrictEqual([sta.label, other.label], ["STA", "Others (Alloc, GRN, DAMG)"]);
  assert.deepStrictEqual(sta.rows.map((p) => [p.id, p.lines, p.mistake_lines, p.below_target]), [["u1", 90, 3, true]]); // 96.7%
  assert.deepStrictEqual(other.rows.map((p) => [p.id, p.lines, p.mistake_lines]), [["u1", 60, 0], ["u2", 20, 0]]); // Alloc 10 + GRN 50
  assert.strictEqual(h.pickers.find((p) => p.id === "u1").lines, 150); // all together still adds up
  assert.match(H.formatTelegram(h), /Pickers below 98% this month - STA: Ravi 96\.6%/);
  const html = require("./warehouse_health_pdf").buildHtml(h, { nowMs: 0 });
  assert.ok(html.includes("<h3>STA</h3>") && html.includes("<h3>Others (Alloc, GRN, DAMG)</h3>"));
});
