const test = require("node:test");
const assert = require("node:assert");
const S = require("./wh_stage_chain");

const J = (t, d, o = {}) => ({ report_type: t, report_date: d, stage_id: "sta_1", article_id: 1, article_name: "Atta 5kg", from_store: "warehouse", to_store: "ecr", pick_pack: 0, qty: 10, short_qty: 0, nlc: 200, no_state: 0, ...o });
const Bx = (t, d, o = {}) => ({ report_type: t, report_date: d, stage_id: "sta_1", article_id: 1, article_name: "Atta 5kg", from_store: "warehouse", to_store: "ecr", qty: 10, nlc: 200, ...o });
const g = (c, k) => c.gaps.find((x) => x.key === k);
const adds = (x) => Math.round((x.from_earlier + x.arrived - x.moved_on) * 1000) / 1000 === x.stands;

test("picked today, not packed: waiting to be packed tonight, 0 days", () => {
  const c = S.buildStageChain({ date: "2026-11-20", jobs: [J("PICKING", "2026-11-20")], boxes: [] });
  const p = g(c, "to_pack");
  assert.deepStrictEqual([p.from_earlier, p.arrived, p.moved_on, p.stands, p.lines, p.value, p.list[0].days], [0, 10, 0, 10, 1, 2000, 0]);
});

test("picked earlier, packed and loaded later, with a packing shortage as lost; every gap adds up", () => {
  const jobs = [J("PICKING", "2026-11-18"), J("PACKING", "2026-11-20", { qty: 8, short_qty: 2 })];
  const boxes = [Bx("LOADING", "2026-11-20", { qty: 5 })];
  const c = S.buildStageChain({ date: "2026-11-20", jobs, boxes });
  const p = g(c, "to_pack");
  assert.deepStrictEqual([p.from_earlier, p.arrived, p.moved_on, p.stands, p.lost.qty], [10, 0, 10, 0, 2]);
  const l = g(c, "to_load");
  assert.deepStrictEqual([l.from_earlier, l.arrived, l.moved_on, l.stands], [0, 8, 5, 3]);
  for (const x of c.gaps) assert.ok(adds(x), x.key);
});

test("a line stuck for days keeps its age", () => {
  const c = S.buildStageChain({ date: "2026-11-20", jobs: [J("PICKING", "2026-11-17")], boxes: [] });
  const p = g(c, "to_pack");
  assert.deepStrictEqual([p.stands, p.oldest_days, p.stuck, p.list[0].since], [10, 3, 1, "2026-11-17"]);
});

test("pick-pack goes straight to waiting to be loaded; a carton with no document is matched by article and store", () => {
  const c = S.buildStageChain({ date: "2026-11-20", jobs: [J("PICKING", "2026-11-19", { pick_pack: 1, stage_id: "inv_9", qty: 50 })], boxes: [Bx("LOADING", "2026-11-20", { stage_id: null, qty: 50 })] });
  assert.strictEqual(g(c, "to_pack").stands, 0);
  const l = g(c, "to_load");
  assert.deepStrictEqual([l.from_earlier, l.moved_on, l.stands, l.jumped.qty], [50, 50, 0, 0]);
});

test("loaded with nothing packed for it jumped a stage; goods that stay put are left out", () => {
  const c = S.buildStageChain({
    date: "2026-11-20",
    jobs: [J("PICKING", "2026-11-20", { to_store: "warehouse", qty: 99 })],
    boxes: [Bx("LOADING", "2026-11-20", { article_id: 7, article_name: "Oil 1L", qty: 4 })],
  });
  assert.strictEqual(g(c, "to_pack").stands, 0);
  const l = g(c, "to_load");
  assert.deepStrictEqual([l.jumped.qty, l.jumped.list[0].article_name], [4, "Oil 1L"]);
});

test("the next stage takes the same document first, then the oldest of the same article and store", () => {
  const jobs = [J("PACKING", "2026-11-18", { stage_id: "a" }), J("PACKING", "2026-11-19", { stage_id: "b" })];
  const c = S.buildStageChain({ date: "2026-11-20", jobs, boxes: [Bx("LOADING", "2026-11-20", { stage_id: "b" })] });
  const l = g(c, "to_load");
  assert.deepStrictEqual(l.list.map((x) => [x.stage_id, x.days]), [["a", 2]]);
});

test("unloaded, not yet verified; verified short is lost", () => {
  const c = S.buildStageChain({ date: "2026-11-20", jobs: [J("VERIFICATION", "2026-11-20", { qty: 6, short_qty: 1 })], boxes: [Bx("UNLOADING", "2026-11-20", { qty: 24 })] });
  const v = g(c, "to_verify");
  assert.deepStrictEqual([v.arrived, v.moved_on, v.stands, v.lost.qty], [24, 7, 17, 1]);
});

test("days the chain cannot follow by job state are listed", () => {
  const c = S.buildStageChain({ date: "2026-11-20", jobs: [J("PICKING", "2026-11-12", { no_state: 3 })], boxes: [] });
  assert.deepStrictEqual(c.days_without_state, ["2026-11-12"]);
});
