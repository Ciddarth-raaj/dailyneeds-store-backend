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
  // 2 days is allowed: not stuck yet
  assert.strictEqual(g(S.buildStageChain({ date: "2026-11-20", jobs: [J("PICKING", "2026-11-18")], boxes: [] }), "to_pack").stuck, 0);
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
  // the shortage line by line, for the page
  assert.deepStrictEqual(v.lost.list.map((l) => [l.article_name, l.qty, l.value]), [["Atta 5kg", 1, 200]]);
});

test("days the chain cannot follow by job state are listed", () => {
  const c = S.buildStageChain({ date: "2026-11-20", jobs: [J("PICKING", "2026-11-12", { no_state: 3 })], boxes: [] });
  assert.deepStrictEqual(c.days_without_state, ["2026-11-12"]);
});

test("cartons follow their job: a reused carton barcode, packed one day and loaded the next, to two stores", () => {
  // Fortune 5L, INV-SuLhMeH5daqg: picked 13 Oct, 7 packing jobs at 18:45, 7 loading jobs loaded 14 Oct, all box 2061252838.
  const P = (job, store) => J("PACKING", "2026-10-13", { stage_id: "INV-Su", article_id: 103506, article_name: "fortune sunflower oil 5ltr can", to_store: store, qty: 4, job_id: job, picking_job: "job_50616283" });
  const packs = [P("job_p1", "moolakulam"), P("job_p2", "moolakulam"), P("job_p3", "ecr")];
  // the loading box carries no document and the same carton id; it names its packing job
  const L = (job, store) => Bx("LOADING", "2026-10-14", { stage_id: null, article_id: 103506, to_store: store, qty: 4, packing_jobs: job, job_id: `load_${job}` });
  const c = S.buildStageChain({ date: "2026-10-14", jobs: [J("PICKING", "2026-10-13", { stage_id: "INV-Su", article_id: 103506, to_store: "moolakulam", qty: 8, job_id: "job_50616283" }), J("PICKING", "2026-10-13", { stage_id: "INV-Su", article_id: 103506, to_store: "ecr", qty: 4, job_id: "job_50616283" }), ...packs], boxes: [L("job_p1", "moolakulam"), L("job_p2", "moolakulam"), L("job_p3", "ecr")] });
  assert.deepStrictEqual([g(c, "to_pack").stands, g(c, "to_load").from_earlier, g(c, "to_load").moved_on, g(c, "to_load").stands, g(c, "to_load").jumped.qty], [0, 12, 12, 0, 0]);
});

test("a loading box links to the right packing job, not the oldest of the same article and store", () => {
  const packs = [J("PACKING", "2026-11-10", { stage_id: null, job_id: "old_pack" }), J("PACKING", "2026-11-19", { stage_id: null, job_id: "new_pack" })];
  const c = S.buildStageChain({ date: "2026-11-20", jobs: packs, boxes: [Bx("LOADING", "2026-11-20", { stage_id: null, packing_jobs: "new_pack" })] });
  const l = g(c, "to_load");
  assert.deepStrictEqual(l.list.map((x) => [x.since, x.days]), [["2026-11-10", 10]]);
});

test("a merged crate lists several packing jobs; verification follows its unloading job", () => {
  const jobs = [J("PACKING", "2026-11-12", { job_id: "pa", qty: 6 }), J("PACKING", "2026-11-14", { job_id: "pb", article_id: 2, qty: 4 }), J("VERIFICATION", "2026-11-16", { stage_id: null, qty: 10, unloading_job: "u1" })];
  const boxes = [Bx("LOADING", "2026-11-15", { stage_id: null, article_id: 1, qty: 6, packing_jobs: "pa,pb" }), Bx("LOADING", "2026-11-15", { stage_id: null, article_id: 2, qty: 4, packing_jobs: "pa,pb" }), Bx("UNLOADING", "2026-11-15", { stage_id: null, qty: 10, job_id: "u1" })];
  const c = S.buildStageChain({ date: "2026-11-16", jobs, boxes });
  assert.deepStrictEqual([g(c, "to_load").stands, g(c, "to_verify").moved_on, g(c, "to_verify").stands], [0, 10, 0]);
});

test("loading days pulled before job links were kept are listed to pull again", () => {
  const c = S.buildStageChain({ date: "2026-11-20", jobs: [], boxes: [Bx("LOADING", "2026-10-14", { no_link: 7 })] });
  assert.deepStrictEqual(c.days_without_state, ["2026-10-14"]);
});

test("a pick-pack followed by packing jobs is not packed twice (GRN cartons: Fortune 5L, 13 Oct)", () => {
  // picked-packed 8 for Moolakulam in job_50616283, then two packing jobs of 4, both loaded 14 Oct
  const jobs = [
    J("PICKING", "2026-10-13", { stage_id: "INV-Su", article_id: 103506, to_store: "moolakulam", qty: 8, pick_pack: 1, job_id: "job_50616283" }),
    J("PACKING", "2026-10-13", { stage_id: "INV-Su", article_id: 103506, to_store: "moolakulam", qty: 4, job_id: "job_74080794", picking_job: "job_50616283" }),
    J("PACKING", "2026-10-13", { stage_id: "INV-Su", article_id: 103506, to_store: "moolakulam", qty: 4, job_id: "job_99894856", picking_job: "job_50616283" }),
  ];
  const boxes = [
    Bx("LOADING", "2026-10-14", { stage_id: null, article_id: 103506, to_store: "moolakulam", qty: 4, packing_jobs: "job_74080794", picking_job: "job_50616283" }),
    Bx("LOADING", "2026-10-14", { stage_id: null, article_id: 103506, to_store: "moolakulam", qty: 4, packing_jobs: "job_99894856", picking_job: "job_50616283" }),
  ];
  const c = S.buildStageChain({ date: "2026-10-14", jobs, boxes });
  assert.deepStrictEqual([g(c, "to_pack").stands, g(c, "to_pack").jumped.qty, g(c, "to_load").stands, g(c, "to_load").jumped.qty], [0, 0, 0, 0]);
  // same on a day pulled before job links: matched by document, article and store
  const old = S.buildStageChain({ date: "2026-10-14", jobs: jobs.map((j) => ({ ...j, picking_job: null })), boxes: boxes.map((b) => ({ ...b, packing_jobs: null, picking_job: null })) });
  assert.deepStrictEqual([g(old, "to_pack").stands, g(old, "to_load").stands], [0, 0]);
});

test("a pick-pack with no packing job after it still goes straight to waiting to be loaded", () => {
  const c = S.buildStageChain({ date: "2026-11-20", jobs: [J("PICKING", "2026-11-20", { pick_pack: 1, job_id: "pp1", qty: 9 })], boxes: [] });
  assert.deepStrictEqual([g(c, "to_pack").stands, g(c, "to_load").stands], [0, 9]);
});

test("a pick-pack partly split into cartons by packing jobs: all of it packed once, cartons and crate loaded (healthy grocer, 14 Oct)", () => {
  const T = (o) => ({ stage_id: "INV-Qq", article_id: 121280, to_store: "moolakulam", ...o });
  const jobs = [
    J("PICKING", "2026-10-14", T({ qty: 373, pick_pack: 1, job_id: "job_38623566" })),
    // the same pick-pack also serves another store: its links must not cross stores
    J("PICKING", "2026-10-14", T({ to_store: "ecr", qty: 50, pick_pack: 1, job_id: "job_38623566" })),
    ...["job_25639555", "job_43651249", "job_89551815"].map((id) => J("PACKING", "2026-10-14", T({ qty: 120, job_id: id, picking_job: "job_38623566" }))),
  ];
  const boxes = [
    ...["job_25639555", "job_43651249", "job_89551815"].map((id) => Bx("LOADING", "2026-10-15", T({ qty: 120, packing_jobs: id, picking_job: "job_38623566" }))),
    Bx("LOADING", "2026-10-15", T({ qty: 13, packing_jobs: null, picking_job: "job_38623566" })), // crate RP031173
    Bx("LOADING", "2026-10-15", T({ to_store: "ecr", qty: 50, packing_jobs: null, picking_job: "job_38623566" })),
  ];
  const c = S.buildStageChain({ date: "2026-10-15", jobs, boxes });
  assert.deepStrictEqual([g(c, "to_pack").stands, g(c, "to_load").stands, g(c, "to_load").jumped.qty], [0, 0, 0]);
  const day1 = S.buildStageChain({ date: "2026-10-14", jobs, boxes });
  assert.deepStrictEqual([g(day1, "to_pack").stands, g(day1, "to_load").stands], [0, 423]); // packed on the 14th, loaded on the 15th
});

test("system packing jobs that split already-packed goods into cartons are not packed again (leaf broom, 29 Oct)", () => {
  const T = (o) => ({ stage_id: "H4Pu", article_id: 105540, to_store: "kathirkamam", ...o });
  const splits = ["job_55906958", "job_65123727", "job_71352978", "job_95801560"];
  const jobs = [
    J("PICKING", "2026-10-29", T({ qty: 20, job_id: "job_10506470", worked_by: "vignesh" })),
    J("PACKING", "2026-10-29", T({ qty: 20, job_id: "job_31683379", picking_job: "job_10506470", worked_by: "ravisankar" })),
    ...splits.map((id) => J("PACKING", "2026-10-29", T({ qty: 5, job_id: id, picking_job: "job_10506470", worked_by: null }))),
  ];
  const boxes = splits.map((id) => Bx("LOADING", "2026-10-29", T({ stage_id: null, qty: 5, packing_jobs: id, picking_job: "job_10506470" })));
  const c = S.buildStageChain({ date: "2026-10-29", jobs, boxes });
  assert.deepStrictEqual([g(c, "to_pack").stands, g(c, "to_pack").jumped.qty, g(c, "to_load").arrived, g(c, "to_load").stands, g(c, "to_load").jumped.qty], [0, 0, 20, 0, 0]);
});

test("unassigned packing jobs that do not over-count what was picked are real packing", () => {
  const jobs = [J("PICKING", "2026-11-20", { qty: 10, job_id: "pk" }), J("PACKING", "2026-11-20", { qty: 10, job_id: "sys", picking_job: "pk", worked_by: null })];
  const c = S.buildStageChain({ date: "2026-11-20", jobs, boxes: [] });
  assert.deepStrictEqual([g(c, "to_pack").stands, g(c, "to_load").stands], [0, 10]);
});

test("worked out day by day from the stored end of the day before = worked out from every report at once", () => {
  const days = ["2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15"];
  const jobs = [];
  const boxes = [];
  let k = 0;
  days.forEach((d, di) => {
    for (let i = 0; i < 30; i += 1) {
      k += 1;
      const o = { stage_id: `S${i % 4}`, article_id: 1 + (i % 7), to_store: ["ecr", "moolakulam"][i % 2], nlc: 10 };
      const pp = i % 5 === 0;
      jobs.push(J("PICKING", d, { ...o, qty: 10, job_id: `pk${k}`, pick_pack: pp ? 1 : 0 }));
      // packing the next day for some, loading two days later, some never
      const pd = days[Math.min(di + (i % 2), days.length - 1)];
      if (!pp && i % 7 !== 3) jobs.push(J("PACKING", pd, { ...o, qty: i % 6 === 0 ? 8 : 10, short_qty: i % 6 === 0 ? 2 : 0, job_id: `pa${k}`, picking_job: `pk${k}`, worked_by: "u" }));
      const ld = days[Math.min(di + 2, days.length - 1)];
      if (i % 9 !== 4) boxes.push(Bx("LOADING", ld, { ...o, qty: pp ? 10 : i % 6 === 0 ? 8 : 10, packing_jobs: pp ? null : `pa${k}`, picking_job: `pk${k}`, job_id: `l${k}` }));
      if (i % 11 !== 2) boxes.push(Bx("UNLOADING", ld, { ...o, qty: 10, job_id: `u${k}` }));
      if (i % 3 === 0) jobs.push(J("VERIFICATION", ld, { ...o, qty: 9, short_qty: 1, unloading_job: `u${k}` }));
    }
  });
  const last = days[days.length - 1];
  const full = S.buildStageChain({ jobs, boxes, date: last });
  let carried = null;
  let step;
  days.forEach((d, di) => {
    const from = days[Math.max(0, di - 7)];
    const inWindow = (r) => r.report_date >= from && r.report_date <= d;
    step = S.buildStageChain({ jobs: jobs.filter(inWindow), boxes: boxes.filter(inWindow), date: d, carried: carried || {} });
    carried = Object.fromEntries(step.gaps.map((x) => [x.key, x.open]));
  });
  const pick = (c) => c.gaps.map((x) => [x.key, x.from_earlier, x.arrived, x.moved_on, x.stands, x.lines, x.oldest_days, x.lost.qty, x.jumped.qty]);
  assert.deepStrictEqual(pick(step), pick(full));
  assert.deepStrictEqual(step.stages, full.stages);
});

test("system packing jobs with no person's packing behind them are the packing (gold winner 1L, 6 Nov)", () => {
  const T = (o) => ({ stage_id: "zsEd", article_id: 103479, to_store: "moolakulam", ...o });
  const packs = Array.from({ length: 13 }, (_, i) => `pa${i}`);
  const jobs = [J("PICKING", "2026-11-06", T({ qty: 120, job_id: "job_88633506", worked_by: "shubham" })), ...packs.map((id) => J("PACKING", "2026-11-06", T({ qty: 10, job_id: id, picking_job: "job_88633506", worked_by: null })))];
  const boxes = packs.map((id) => Bx("LOADING", "2026-11-06", T({ stage_id: null, qty: 10, packing_jobs: id, picking_job: "job_88633506" })));
  const c = S.buildStageChain({ date: "2026-11-06", jobs, boxes });
  // all 120 picked are packed; 10 more were packed than picked (shows as packed with no picking record); all loaded
  assert.deepStrictEqual([g(c, "to_pack").stands, g(c, "to_pack").jumped.qty, g(c, "to_load").stands], [0, 10, 0]);
});
