const test = require("node:test");
const assert = require("node:assert");
const C = require("./wh_box_chain");

const L = (d, id, to, o = {}) => ({ report_date: d, box_id: id, planned_to_store: to, from_store: "warehouse", truck_no: "T1", articles: 1, qty: 10, value: 100, ...o });
const U = (d, id, to, o = {}) => ({ report_date: d, box_id: id, planned_to_store: to, unloaded_store: to, articles: 1, qty: 10, ...o });
const add = (c) => c.opening.boxes + c.loaded.boxes - c.unloaded.boxes;

test("adds up: open from earlier + loaded - unloaded = still open", () => {
  const c = C.buildChain({
    date: "2026-11-20",
    loads: [L("2026-11-19", "R1", "warehouse", { from_store: "ecr" }), L("2026-11-20", "A", "ecr"), L("2026-11-20", "B", "ecr"), L("2026-11-20", "C", "kathirkamam")],
    unloads: [U("2026-11-20", "R1", "warehouse"), U("2026-11-20", "A", "ecr"), U("2026-11-20", "B", "ecr")],
  });
  assert.deepStrictEqual([c.opening.boxes, c.loaded.boxes, c.unloaded.boxes, c.unloaded.from_earlier, c.still_open.boxes], [1, 3, 3, 1, 1]);
  assert.strictEqual(add(c), c.still_open.boxes);
  assert.deepStrictEqual(c.lists.closed_old.map((b) => [b.box_id, b.loaded_on, b.days_late]), [["R1", "2026-11-19", 1]]);
});

test("the same box id going to two stores is two boxes", () => {
  const c = C.buildChain({ date: "2026-11-20", loads: [L("2026-11-20", "X", "ecr"), L("2026-11-20", "X", "moolakulam")], unloads: [U("2026-11-20", "X", "moolakulam")] });
  assert.deepStrictEqual([c.loaded.boxes, c.unloaded.boxes, c.still_open.boxes, c.lists.still_open[0].to_store], [2, 1, 1, "ecr"]);
});

test("a box open for days keeps showing, its age growing; looking at a past day ignores later unloading", () => {
  const loads = [L("2026-11-15", "OLD", "ecr")];
  const unloads = [U("2026-11-21", "OLD", "ecr")];
  const on20 = C.buildChain({ date: "2026-11-20", loads, unloads });
  assert.deepStrictEqual([on20.opening.boxes, on20.still_open.boxes, on20.still_open.oldest_days, on20.lists.still_open[0].days_open], [1, 1, 5, 5]);
  const on21 = C.buildChain({ date: "2026-11-21", loads, unloads });
  assert.deepStrictEqual([on21.opening.boxes, on21.unloaded.from_earlier, on21.still_open.boxes, on21.lists.closed_old[0].days_late], [1, 1, 0, 6]);
});

test("a box id loaded twice is closed in order: the first unloading closes the first loading", () => {
  const c = C.buildChain({ date: "2026-11-20", loads: [L("2026-11-18", "Y", "ecr"), L("2026-11-20", "Y", "ecr")], unloads: [U("2026-11-20", "Y", "ecr")] });
  assert.deepStrictEqual([c.unloaded.from_earlier, c.unloaded.from_today, c.still_open.boxes, c.lists.still_open[0].loaded_on], [1, 0, 1, "2026-11-20"]);
});

test("unloaded with no open loading, and unloaded at the wrong store", () => {
  const c = C.buildChain({
    date: "2026-11-20",
    loads: [L("2026-11-20", "W", "ecr")],
    unloads: [U("2026-11-20", "W", "ecr", { unloaded_store: "muthialpet" }), U("2026-11-20", "Z", "ecr")],
  });
  assert.deepStrictEqual([c.not_loaded.boxes, c.wrong_store.boxes, c.lists.wrong_store[0].unloaded_store, c.lists.not_loaded[0].box_id], [1, 1, "muthialpet", "Z"]);
  assert.strictEqual(add(c), c.still_open.boxes);
});

test("the same box to the same store twice on one day is two trips, paired by document, else by time", () => {
  const loads = [
    L("2026-11-20", "K", "ecr", { job_id: "j1", stage_id: "sta_1", finished_at: "2026-11-20 09:00:00" }),
    L("2026-11-20", "K", "ecr", { job_id: "j2", stage_id: "sta_2", finished_at: "2026-11-20 15:00:00" }),
  ];
  // only the second trip is unloaded: by document it closes j2, not the earlier j1
  const byDoc = C.buildChain({ date: "2026-11-20", loads, unloads: [U("2026-11-20", "K", "ecr", { job_id: "u2", stage_id: "sta_2", finished_at: "2026-11-20 17:00:00" })] });
  assert.deepStrictEqual([byDoc.loaded.boxes, byDoc.unloaded.boxes, byDoc.still_open.boxes, byDoc.lists.still_open[0].job_id], [2, 1, 1, "j1"]);
  // cartons carry no document: by time, an unloading at 12:00 can only close the 09:00 loading
  const noDoc = loads.map((l) => ({ ...l, stage_id: null }));
  const byTime = C.buildChain({ date: "2026-11-20", loads: noDoc, unloads: [U("2026-11-20", "K", "ecr", { job_id: "u1", finished_at: "2026-11-20 12:00:00" })] });
  assert.deepStrictEqual([byTime.unloaded.boxes, byTime.still_open.boxes, byTime.lists.still_open[0].job_id], [1, 1, "j2"]);
});
