const test = require("node:test");
const assert = require("node:assert");
const make = require("./warehouse_health");

const SC = require("../utils/wh_stage_chain");
const BC = require("../utils/wh_box_chain");

/** The stored chain (usecase/wh_chain.js), read for a day: here worked out at once from the stub reports. */
function fullChain(repo) {
  return {
    version: async () => "v",
    sites: async () => ["ecr", "moolakulam", "warehouse"],
    read: async (d, view = "from:warehouse") => {
      const [dir, site] = view.split(":");
      const mine = (r) => (dir === "from" ? (r.from_store || "warehouse") === site : r.to_store === site);
      const mineBox = (b) => (dir === "from" ? (b.from_store || "warehouse") === site : b.planned_to_store === site);
      const all = await repo.stageFlows("2026-10-10", d);
      const [jobs, boxes] = [all.jobs.filter(mine), all.boxes.filter(mine)];
      const box = BC.buildChain({ loads: (await repo.boxSummary("LOADING", "2026-10-10", d)).filter(mineBox), unloads: (await repo.boxSummary("UNLOADING", "2026-10-10", d)).filter(mineBox), date: d });
      const keys = box.lists.still_open.map((b) => ({ report_date: b.loaded_on, box_id: b.box_id, planned_to_store: b.to_store, job_id: b.job_id }));
      const items = await repo.boxArticles("LOADING", keys);
      box.lists.still_open.forEach((b, i) => (b.items = items[i] ? [items[i]] : []));
      box.missing_days = d >= "2026-10-10" ? [{ date: "2026-10-10", reports: ["Loading", "Unloading"] }] : [];
      return { result: { stage: SC.buildStageChain({ jobs, boxes, date: d }), box }, final: true, status: "DONE", computed_at: "2026-11-21T18:12:00.000Z", progress: { todo: 0, done: 42, failed: 0, first_todo: null }, days_without_state: [] };
    },
  };
}

const repo = {
  uploads: async () => [{ report_type: "PICKING", report_date: "2026-11-20" }],
  jobBreakdown: async (f, t, dims) => (dims[0] === "report_type" && dims.length === 1 ? [{ report_type: "PICKING", short_lines: 2, short_qty: 9, short_value: 90 }] : []),
  jobRows: async (f, t, o) => (o && o.only === "short" ? [{ article_id: 5, article_name: "Atta", job_type: "STA", to_store: "ecr", short_qty: 2, nlc: 10, worked_by: "kp1", finished_at: "2026-11-20 10:00" }] : []),
  remarksPending: async () => [],
  shortArticles: async () => [],
  pickerMistakes: async () => [],
  boxSummary: async (type) =>
    type === "LOADING"
      ? [
          { report_date: "2026-11-19", box_id: "R1", planned_to_store: "warehouse", from_store: "ecr", truck_no: "T9", articles: 1, qty: 24, value: 1800 },
          { report_date: "2026-11-20", box_id: "B1", planned_to_store: "ecr", from_store: "warehouse", truck_no: "T1", articles: 2, qty: 10, value: 500 },
          { report_date: "2026-11-20", box_id: "B1", planned_to_store: "moolakulam", from_store: "warehouse", truck_no: "T1", articles: 1, qty: 5, value: 100 },
        ]
      : [
          { report_date: "2026-11-20", box_id: "R1", planned_to_store: "warehouse", unloaded_store: "warehouse", from_store: "ecr", articles: 1, qty: 24 },
          { report_date: "2026-11-20", box_id: "B1", planned_to_store: "ecr", unloaded_store: "ecr", articles: 2, qty: 10 },
        ],
  stageFlows: async () => ({
    jobs: [{ report_type: "PICKING", report_date: "2026-11-17", stage_id: "sta_9", article_id: 5, article_name: "Atta", from_store: "warehouse", to_store: "ecr", pick_pack: 0, qty: 12, short_qty: 0, nlc: 220, no_state: 0 }],
    boxes: [],
  }),
  boxArticles: async (type, keys) => keys.map((k) => ({ ...k, article_id: 7, article_name: "Milk", qty: 5, value: 100 })),
};
const reports = { _boxes: async () => [], _staffNames: async () => ({}) };

function setup(recipients, failFor = null, extra = {}) {
  const sent = [];
  const docs = [];
  const recorded = [];
  const uc = make({
    chain: fullChain(repo),
    ...extra,
    repo,
    reports,
    today: () => "2026-11-21",
    dashboardUrl: "https://x/d",
    telegramService: {
      sendMessage: async (chat, text, options) => {
        if (chat === failFor) throw new Error("blocked");
        sent.push({ chat, text, options });
      },
      sendDocument: async (chat, url, caption) => docs.push({ chat, url, caption }),
    },
    summaryRepo: {
      recipients: async () => recipients,
      sentOn: async () => new Set([3]),
      record: async (r) => recorded.push(r),
      chatOf: async (id) => (id === 1 ? "c1" : null),
    },
  });
  return { uc, sent, docs, recorded };
}

test("health defaults to yesterday and refuses the future", async () => {
  const { uc } = setup([]);
  const r = await uc.health();
  assert.strictEqual(r.data.date, "2026-11-20");
  assert.strictEqual(r.data.tiles.writeoff.lines, 2);
  assert.strictEqual((await uc.health({ date: "2026-11-22" })).code, 422);
  assert.strictEqual((await uc.health({ date: "nope" })).code, 422);
});

test("run sends yesterday once per person, skips unlinked, records failures", async () => {
  const { uc, sent, recorded } = setup(
    [{ employee_id: 1, private_chat_id: "c1" }, { employee_id: 2, private_chat_id: null }, { employee_id: 3, private_chat_id: "c3" }, { employee_id: 4, private_chat_id: "c4" }],
    "c4"
  );
  const out = await uc.run();
  assert.deepStrictEqual(out, { date: "2026-11-20", pdf: false, sent: 1, failed: 1, skipped: 1, already: 1 });
  assert.strictEqual(sent[0].chat, "c1");
  assert.match(sent[0].text, /Picking write-off 2 lines/);
  assert.strictEqual(sent[0].options.replyMarkup.inlineKeyboard[0][0].url, "https://x/d");
  assert.deepStrictEqual(recorded.map((r) => r.status), ["SENT", "SKIPPED", "FAILED"]);
});

test("send me", async () => {
  const { uc, sent } = setup([]);
  assert.strictEqual((await uc.sendToMe(1)).code, 200);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual((await uc.sendToMe(2)).code, 422);
  assert.strictEqual((await uc.sendToMe(null)).code, 403);
});

test("the PDF is made once, uploaded once and sent after the message to each person", async () => {
  let renders = 0;
  let uploads = 0;
  let html = "";
  const pdf = { withBrowser: async (fn) => fn({ renderPdf: async (h) => ((html = h), renders++, Buffer.from("pdf")) }) };
  const s3 = { uploadFile: async (_, name) => (uploads++, `https://s3/${name}`) };
  const { uc, sent, docs } = setup([{ employee_id: 1, private_chat_id: "c1" }, { employee_id: 5, private_chat_id: "c5" }], null, { pdf, s3, now: () => 1 });
  const out = await uc.run();
  assert.strictEqual(out.pdf, true);
  assert.deepStrictEqual([renders, uploads, sent.length], [1, 1, 2]);
  assert.deepStrictEqual(docs.map((d) => [d.chat, d.url, d.caption]), [["c1", "https://s3/warehouse_health/2026-11-20_1.pdf", "Warehouse Health - 2026-11-20 (PDF)"], ["c5", "https://s3/warehouse_health/2026-11-20_1.pdf", "Warehouse Health - 2026-11-20 (PDF)"]]);
  assert.match(html, /Warehouse Health/);
  assert.match(html, /2 lines/);
});

test("a PDF that fails still sends the message", async () => {
  const pdf = { withBrowser: async () => { throw new Error("no chrome"); } };
  const { uc, sent, docs } = setup([{ employee_id: 1, private_chat_id: "c1" }], null, { pdf, s3: { uploadFile: async () => "x" } });
  const out = await uc.run();
  assert.deepStrictEqual([out.sent, out.pdf, sent.length, docs.length], [1, false, 1, 0]);
});

test("the box chain: open from earlier + loaded - unloaded = still open, a box being its id and store", async () => {
  const { uc } = setup([]);
  const r = await uc.health({ date: "2026-11-20" });
  const u = r.data.tiles.unloading;
  // the warehouse's own boxes only
  assert.deepStrictEqual([u.chain.opening.boxes, u.chain.loaded.boxes, u.chain.unloaded.boxes, u.chain.unloaded.from_earlier, u.chain.still_open.boxes], [0, 2, 1, 0, 1]);
  assert.deepStrictEqual(u.still_open.map((b) => [b.box_id, b.to_store, b.items[0].article_name]), [["B1", "moolakulam", "Milk"]]);
  // ECR's return to the warehouse is under "Received at the warehouse"
  assert.strictEqual(r.data.second.title, "Received at the warehouse");
  assert.deepStrictEqual(r.data.second.unloading.closed_old.map((b) => [b.box_id, b.days_late]), [["R1", 1]]);
  assert.ok(r.data.need_you.some((i) => /1 box loaded and not unloaded/.test(i.text)));
  // days since 10 Oct with no Loading / Unloading report are listed
  assert.strictEqual(u.chain.missing_days[0].date, "2026-10-10");
});

test("the stage chain heads the page: picked, not yet packed, stuck 3 days, flagged", async () => {
  const { uc } = setup([]);
  const r = await uc.health({ date: "2026-11-20" });
  const g = r.data.stage_chain.gaps.find((x) => x.key === "to_pack");
  assert.deepStrictEqual([g.stands, g.oldest_days, g.list[0].article_name], [12, 3, "Atta"]);
  assert.match(r.data.need_you[0].text, /Picked, not yet packed: 1 line waiting more than 2 days/);
  // Loading counts the same box trips as the chain
  assert.strictEqual(r.data.tiles.loading.boxes, r.data.tiles.unloading.chain.loaded.boxes);
});

test("stuck cartons are not shown on their own (they are in the chain): no live RetailPilot call", async () => {
  const { uc } = setup([]);
  let called = 0;
  uc.reports = { ...reports, stuckCartons: async () => ((called += 1), { ok: true, cartons: [] }) };
  const r = await uc.health({ date: "2026-11-20" });
  assert.deepStrictEqual([called, r.data.stuck_cartons, r.data.need_you.some((i) => i.key === "stuck_cartons")], [0, undefined, false]);
});

test("the write-off lines come with the health of the day", async () => {
  const { uc } = setup([]);
  const r = await uc.health({ date: "2026-11-20" });
  assert.deepStrictEqual(r.data.tiles.writeoff.list.map((l) => [l.article_name, l.value, l.finished_at]), [["Atta", 20, "2026-11-20 10:00"]]);
});

test("trace: one line through every stage, boxes linked by packing job, which reports were pulled", async () => {
  const { uc } = setup([]);
  uc.repo = {
    ...repo,
    trace: async () => ({
      jobs: [
        { report_type: "PICKING", report_date: "2026-10-13", job_id: "job_50616283", stage_id: "INV-Su", to_store: "moolakulam", actual_qty: 8, worked_by: "tux" },
        { report_type: "PACKING", report_date: "2026-10-13", job_id: "job_84969325", stage_id: "INV-Su", to_store: "moolakulam", actual_qty: 4, picking_job: "job_50616283" },
      ],
      boxes: [
        { report_type: "LOADING", report_date: "2026-10-14", job_id: "job_58254998", box_id: "2061252838", planned_to_store: "moolakulam", qty: 4, packing_jobs: "job_84969325" },
        { report_type: "LOADING", report_date: "2026-11-05", job_id: "job_x", box_id: "2061252838", planned_to_store: "moolakulam", qty: 4, packing_jobs: "job_other" },
        { report_type: "UNLOADING", report_date: "2026-10-14", job_id: "job_u1", box_id: "2061252838", planned_to_store: "moolakulam", qty: 4, packing_jobs: "job_84969325" },
      ],
      verifs: [
        { report_type: "VERIFICATION", report_date: "2026-10-14", job_id: "job_v1", stage_id: null, unloading_job: "job_u1", actual_qty: 4 },
        { report_type: "VERIFICATION", report_date: "2026-11-05", job_id: "job_v2", stage_id: null, unloading_job: "job_u_other", actual_qty: 4 },
      ],
    }),
    uploads: async () => [{ report_type: "PICKING", report_date: "2026-10-13" }, { report_type: "PACKING", report_date: "2026-10-13" }],
  };
  const r = await uc.trace({ stage_id: "INV-Su", article_id: "103506", to_store: "moolakulam" });
  assert.strictEqual(r.code, 200);
  assert.deepStrictEqual(r.data.stages.LOADING.map((b) => [b.job_id, b.linked]), [["job_58254998", true]]); // the 5 Nov reuse of the carton is not this line
  assert.deepStrictEqual(r.data.pulled, { "2026-10-13": ["PICKING", "PACKING"], "2026-10-14": [] }); // 14 Oct: nothing pulled - the gap shows
  // verification found through the line's unloading job, not another delivery's
  assert.deepStrictEqual(r.data.stages.VERIFICATION.map((v) => v.job_id), ["job_v1"]);
  assert.strictEqual((await uc.trace({ article_id: "x", to_store: "ecr" })).code, 422);
});

test("a built day is shared and reused until a report is pulled, uploaded or removed", async () => {
  const { uc } = setup([]);
  let builds = 0;
  let version = "v1";
  uc.repo = { ...repo, dataVersion: async () => version, uploads: async (...a) => ((builds += 1), repo.uploads(...a)) };
  const [a, b] = await Promise.all([uc.health({ date: "2026-11-20" }), uc.health({ date: "2026-11-20" })]);
  await uc.health({ date: "2026-11-20" });
  assert.strictEqual(a.data.date, b.data.date);
  const once = builds;
  version = "v2"; // a pull
  await uc.health({ date: "2026-11-20" });
  assert.ok(builds > once, "rebuilt after new data");
  await uc.health({ date: "2026-11-20" });
  assert.strictEqual(builds, once * 2);
});

test("WAREHOUSE_HEALTH_CHAINS=off hides the chains: the page still loads without them", async () => {
  process.env.WAREHOUSE_HEALTH_CHAINS = "off";
  const { uc } = setup([]);
  const r = await uc.health({ date: "2026-11-21" });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.data.stage_chain, undefined);
  assert.strictEqual(r.data.tiles.unloading.chain, undefined);
  process.env.WAREHOUSE_HEALTH_CHAINS = "";
});

test("the chains are read as stored, with when they were worked out and how far a redo is", async () => {
  const { uc } = setup([]);
  const r = await uc.health({ date: "2026-11-20" });
  assert.deepStrictEqual([r.data.chain_status.final, r.data.chain_status.computed_at], [true, "2026-11-21T18:12:00.000Z"]);
  uc.chain = { version: async () => "x", read: async () => ({ result: null, final: false, status: "TODO", computed_at: null, progress: { todo: 12, done: 30, failed: 0, first_todo: "2026-10-14" }, days_without_state: [] }) };
  uc.built = null;
  const p = await uc.health({ date: "2026-11-20" });
  assert.deepStrictEqual([p.data.stage_chain, p.data.chain_status.progress.todo], [undefined, 12]);
});

test("a store's page: what it received first, what it sent below; its own pickers and write-off", async () => {
  const calls = [];
  const { uc } = setup([]);
  uc.repo = { ...repo, jobBreakdown: async (...a) => (calls.push(["jb", a[3]]), repo.jobBreakdown(...a)), jobRows: async (...a) => (calls.push(["rows", a[2]]), repo.jobRows(...a)), pickerMistakes: async (...a) => (calls.push(["pm", a[2]]), []) };
  const r = await uc.health({ date: "2026-11-20", site: "ECR" });
  assert.deepStrictEqual([r.data.site, r.data.site_name, r.data.main_title], ["ecr", "ECR", "Received at ECR"]);
  // received: B1 loaded for ECR and unloaded there; the Atta picked for ECR is waiting to be packed
  assert.deepStrictEqual([r.data.tiles.unloading.chain.loaded.boxes, r.data.tiles.unloading.chain.unloaded.boxes], [1, 1]);
  assert.strictEqual(r.data.stage_chain.gaps.find((g) => g.key === "to_pack").stands, 12);
  // sent: the return R1, below
  assert.strictEqual(r.data.second.title, "Sent from ECR");
  assert.strictEqual(r.data.second.unloading.chain.unloaded.boxes, 1);
  // picking (write-off, pickers) is ECR's own; verification is what ECR found
  assert.ok(calls.some(([k, o]) => k === "pm" && o.site === "ecr"));
  assert.ok(calls.some(([k, o]) => k === "rows" && o.only === "short" && o.from_store === "ecr"));
  assert.ok(calls.some(([k, o]) => k === "rows" && o.report_type === "VERIFICATION" && o.to_store === "ecr"));
  assert.deepStrictEqual(r.data.sites.map((x) => x.site), ["warehouse", "ecr", "moolakulam"]);
  assert.strictEqual((await uc.health({ date: "2026-11-20", site: "<script>" })).code, 422);
});

test("store managers get their own store's summary, found by their store's name; others are skipped with the reason", async () => {
  const { uc, sent, docs, recorded } = setup([{ employee_id: 1, private_chat_id: "c1" }]);
  uc.summaryRepo.storeRecipients = async () => [
    { employee_id: 10, outlet_name: "ECR", private_chat_id: "s10" },
    { employee_id: 11, outlet_name: "Moola Kulam", private_chat_id: "s11" },
    { employee_id: 12, outlet_name: "Lawspet", private_chat_id: "s12" },
    { employee_id: 13, outlet_name: "ECR", private_chat_id: null },
  ];
  const out = await uc.run();
  assert.deepStrictEqual([out.sent, out.skipped, out.stores], [3, 2, { ecr: 1, moolakulam: 1 }]);
  const to = (chat) => sent.find((m) => m.chat === chat);
  assert.match(to("c1").text, /^Warehouse Health - /);
  assert.match(to("s10").text, /^ECR Store Health - /);
  assert.match(to("s11").text, /^Moolakulam Store Health - /);
  assert.strictEqual(to("s10").options.replyMarkup.inlineKeyboard[0][0].url, "https://x/d?site=ecr");
  assert.deepStrictEqual(recorded.filter((r) => r.status !== "SENT").map((r) => [r.employee_id, r.reason]), [[12, 'Store "Lawspet" not found in the reports'], [13, "Telegram not linked"]]);
  assert.deepStrictEqual(recorded.filter((r) => r.status === "SENT").map((r) => [r.employee_id, r.site]), [[1, "warehouse"], [10, "ecr"], [11, "moolakulam"]]);
  assert.strictEqual(docs.length, 0);
});

test("site helpers: an outlet's name to the reports' site; the dashboard link on a site", () => {
  const sites = ["ecr", "moolakulam", "vallalar salai", "warehouse"];
  assert.deepStrictEqual(["Vallalar Salai", "VALLALAR-SALAI", "Moolakulam Store", "ecr", "", "Lawspet"].map((o) => make.siteForOutlet(o, sites)), ["vallalar salai", "vallalar salai", "moolakulam", "ecr", null, null]);
  assert.strictEqual(make.siteUrl("https://d/p#warehouse-health", "vallalar salai"), "https://d/p?site=vallalar%20salai#warehouse-health");
  assert.strictEqual(make.siteUrl("https://d/p", "warehouse"), "https://d/p");
});

test("send me: the site I am looking at", async () => {
  const { uc, sent } = setup([]);
  const r = await uc.sendToMe(1, "ecr");
  assert.strictEqual(r.code, 200);
  assert.match(sent[0].text, /^ECR Store Health - /);
});
