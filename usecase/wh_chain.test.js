const test = require("node:test");
const assert = require("node:assert");
const make = require("./wh_chain");
const SC = require("../utils/wh_stage_chain");

/** An in-memory repository/wh_chain.js. */
function memChain() {
  const days = new Map(); // day -> { status, gen, result, no_links, error, computed_at }
  const open = new Map();
  const boxes = new Map();
  const results = new Map(); // `${day}|${view}` -> JSON text
  return {
    results,
    getView: async (d, v) => results.get(`${d}|${v}`) || null,
    viewsOn: async (d) => [...results.keys()].filter((k) => k.startsWith(`${d}|`)).map((k) => k.slice(11)).sort(),
    days,
    addMissing: async (list) => list.forEach((d) => days.has(d) || days.set(d, { status: "TODO", gen: 0 })),
    markTodo: async (list) => list.forEach((d) => days.set(d, { ...(days.get(d) || { gen: 0 }), status: "TODO", gen: ((days.get(d) || {}).gen || 0) + 1 })),
    nextTodo: async (upTo) => [...days].filter(([d, r]) => r.status === "TODO" && d <= upTo).map(([d]) => d).sort()[0] || null,
    getDay: async (d) => (days.has(d) ? { chain_date: d, ...days.get(d), result: days.get(d).result || null } : null),
    progress: async () => ({ todo: [...days.values()].filter((r) => r.status === "TODO").length, done: [...days.values()].filter((r) => r.status === "DONE").length, failed: 0, first_todo: null }),
    noLinkDays: async () => [],
    version: async () => "v",
    loadOpen: async (d) => (open.get(d) || []).map((x) => ({ ...x, view_key: x.view })),
    loadOpenBoxes: async (d) => (boxes.get(d) || []).map((x) => ({ ...x, view_key: x.view })),
    saveDay: async (d, { open: o, boxes: b, result, views = {}, gen }) => {
      for (const k of [...results.keys()]) if (k.startsWith(`${d}|`)) results.delete(k);
      for (const [v, r] of Object.entries(views)) results.set(`${d}|${v}`, JSON.stringify(r));
      open.set(d, o.map((x) => ({ ...x })));
      boxes.set(d, b.map((x) => ({ ...x })));
      const cur = days.get(d) || { gen: 0 };
      days.set(d, { ...cur, status: cur.gen === gen ? "DONE" : "TODO", result: JSON.stringify(result), computed_at: "now" });
    },
    failDay: async (d, msg) => days.set(d, { ...(days.get(d) || { gen: 0 }), status: "FAILED", error: msg }),
  };
}

const J = (t, d, o = {}) => ({ report_type: t, report_date: d, stage_id: "S1", article_id: 1, article_name: "Atta", from_store: "warehouse", to_store: "ecr", pick_pack: 0, qty: 10, short_qty: 0, nlc: 20, ...o });
/** A reports repository that answers by date, like the real one. */
function reportsRepo(jobs, boxes) {
  const inRange = (from, to) => (r) => r.report_date >= from && r.report_date <= to;
  return {
    stageFlows: async (from, to) => ({ jobs: jobs.filter(inRange(from, to)), boxes: boxes.filter(inRange(from, to)).map((b) => ({ ...b })) }),
    boxSummary: async (type, from, to) => boxes.filter((b) => b.report_type === type && inRange(from, to)(b)).map((b) => ({ ...b, planned_to_store: b.to_store, articles: 1, value: b.qty * 20 })),
    uploads: async () => [],
    boxArticles: async () => [],
  };
}

test("works the days out in order from 10 Oct, each from the day before; the result matches working out everything at once", async () => {
  const jobs = [J("PICKING", "2026-10-10", { job_id: "p1" }), J("PACKING", "2026-10-11", { job_id: "k1", picking_job: "p1", worked_by: "u" }), J("PICKING", "2026-10-11", { job_id: "p2", qty: 5 })];
  const boxes = [{ report_type: "LOADING", report_date: "2026-10-12", stage_id: null, article_id: 1, to_store: "ecr", from_store: "warehouse", qty: 10, nlc: 20, job_id: "L1", box_id: "B1", truck_no: "T", packing_jobs: "k1", picking_job: "p1" }];
  const chainRepo = memChain();
  const uc = make({ chainRepo, repo: reportsRepo(jobs, boxes), today: () => "2026-10-13", pauseMs: 0 });
  await uc.ensure();
  assert.deepStrictEqual([...chainRepo.days].map(([d, r]) => [d, r.status]), [["2026-10-10", "DONE"], ["2026-10-11", "DONE"], ["2026-10-12", "DONE"], ["2026-10-13", "DONE"]]);
  const r = await uc.read("2026-10-12");
  const g = Object.fromEntries(r.result.stage.gaps.map((x) => [x.key, x]));
  const full = SC.buildStageChain({ jobs, boxes, date: "2026-10-12" });
  const f = Object.fromEntries(full.gaps.map((x) => [x.key, x]));
  for (const k of ["to_pack", "to_load"]) assert.deepStrictEqual([g[k].from_earlier, g[k].arrived, g[k].moved_on, g[k].stands], [f[k].from_earlier, f[k].arrived, f[k].moved_on, f[k].stands], k);
  assert.deepStrictEqual([g.to_pack.stands, g.to_load.stands], [5, 0]); // p2 still waiting to be packed; B1 loaded the packed 10
  assert.deepStrictEqual([r.result.box.loaded.boxes, r.result.box.still_open.boxes], [1, 1]);
  const next = await uc.read("2026-10-13");
  assert.deepStrictEqual([next.result.box.opening.boxes, next.result.box.still_open.boxes, next.result.box.still_open.oldest_days], [1, 1, 1]); // carried to the next day
  assert.strictEqual(r.final, true);
});

test("a re-pulled day redoes it and every day after it; a day marked to redo while it was worked out is not final", async () => {
  const jobs = [J("PICKING", "2026-10-10", { job_id: "p1" })];
  const chainRepo = memChain();
  const uc = make({ chainRepo, repo: reportsRepo(jobs, []), today: () => "2026-10-12", pauseMs: 0 });
  await uc.ensure();
  jobs.push(J("PACKING", "2026-10-11", { job_id: "k1", picking_job: "p1", worked_by: "u" }));
  await uc.markFrom("2026-10-11");
  await uc.running;
  const r = await uc.read("2026-10-12");
  assert.strictEqual(r.result.stage.gaps.find((x) => x.key === "to_pack").stands, 0);
  assert.strictEqual(r.result.stage.gaps.find((x) => x.key === "to_load").stands, 10);
  // marked to redo while working: saved, but stays TODO for the next run
  const day = "2026-10-12";
  const orig = chainRepo.saveDay;
  chainRepo.saveDay = async (d, x) => {
    if (d === day) await chainRepo.markTodo([day]);
    return orig(d, x);
  };
  await uc.computeDay(day);
  assert.strictEqual(chainRepo.days.get(day).status, "TODO");
});

test("a day that fails stops the days after it until it is redone", async () => {
  const chainRepo = memChain();
  const repo = reportsRepo([], []);
  repo.stageFlows = async (from, to) => {
    if (to === "2026-10-11") throw new Error("db down");
    return { jobs: [], boxes: [] };
  };
  const uc = make({ chainRepo, repo, today: () => "2026-10-12", pauseMs: 0 });
  await uc.ensure();
  assert.deepStrictEqual([...chainRepo.days].map(([d, r]) => r.status), ["DONE", "FAILED", "TODO"]);
});

test("days stored under older matching rules are all redone on the next start", async () => {
  const chainRepo = memChain();
  const uc = make({ chainRepo, repo: reportsRepo([J("PICKING", "2026-10-10", { job_id: "p1" })], []), today: () => "2026-10-11", pauseMs: 0 });
  await uc.ensure();
  const r = JSON.parse(chainRepo.days.get("2026-10-10").result);
  assert.strictEqual(r.logic, make.LOGIC);
  chainRepo.days.set("2026-10-10", { ...chainRepo.days.get("2026-10-10"), result: JSON.stringify({ ...r, logic: 1 }) });
  let computed = 0;
  const orig = chainRepo.saveDay;
  chainRepo.saveDay = async (...a) => ((computed += 1), orig(...a));
  await uc.ensure();
  assert.strictEqual(computed, 2); // both days redone
  await uc.ensure();
  assert.strictEqual(computed, 2); // and not again
});

test("each site is worked out both ways: what it sent and what was sent to it", async () => {
  const jobs = [
    J("PICKING", "2026-10-10", { job_id: "p1" }), // warehouse -> ecr, 10
    J("PICKING", "2026-10-10", { job_id: "p2", from_store: "ecr", to_store: "warehouse", qty: 3 }), // a return
    J("PICKING", "2026-10-10", { job_id: "p3", to_store: "moolakulam", qty: 4 }),
  ];
  const chainRepo = memChain();
  const uc = make({ chainRepo, repo: reportsRepo(jobs, []), today: () => "2026-10-11", pauseMs: 0 });
  await uc.ensure();
  const stands = async (day, view) => (await uc.read(day, view)).result.stage.gaps.find((x) => x.key === "to_pack").stands;
  assert.deepStrictEqual(await uc.sites("2026-10-11"), ["ecr", "moolakulam", "warehouse"]);
  assert.strictEqual(await stands("2026-10-11", "from:warehouse"), 14); // ecr 10 + moolakulam 4, not the return
  assert.strictEqual(await stands("2026-10-11", "to:ecr"), 10);
  assert.strictEqual(await stands("2026-10-11", "from:ecr"), 3);
  assert.strictEqual(await stands("2026-10-11", "to:warehouse"), 3);
  assert.strictEqual((await uc.read("2026-10-11", "to:nowhere")).result, null);
});
