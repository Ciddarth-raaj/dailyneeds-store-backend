const test = require("node:test");
const assert = require("node:assert");
const make = require("./warehouse_health");

const repo = {
  uploads: async () => [{ report_type: "PICKING", report_date: "2026-11-20" }],
  jobBreakdown: async (f, t, dims) => (dims[0] === "report_type" && dims.length === 1 ? [{ report_type: "PICKING", short_lines: 2, short_qty: 9, short_value: 90 }] : []),
  jobRows: async () => [],
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
          { report_date: "2026-11-20", box_id: "R1", planned_to_store: "warehouse", unloaded_store: "warehouse", articles: 1, qty: 24 },
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
  assert.deepStrictEqual([u.chain.opening.boxes, u.chain.loaded.boxes, u.chain.unloaded.boxes, u.chain.unloaded.from_earlier, u.chain.still_open.boxes], [1, 2, 2, 1, 1]);
  assert.deepStrictEqual(u.still_open.map((b) => [b.box_id, b.to_store, b.items[0].article_name]), [["B1", "moolakulam", "Milk"]]);
  assert.deepStrictEqual(u.closed_old.map((b) => [b.box_id, b.days_late]), [["R1", 1]]);
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

test("stuck cartons head 'things need you'; a RetailPilot refusal shows as a note", async () => {
  const { uc } = setup([]);
  uc.reports = { ...reports, stuckCartons: async () => ({ ok: true, at: "x", stuck_days: 2, cartons: [{ carton: "7186914543", days: 36, units: 20, value: 1100, items: [] }] }) };
  const r = await uc.health({ date: "2026-11-20" });
  assert.deepStrictEqual([r.data.stuck_cartons.count, r.data.stuck_cartons.units], [1, 20]);
  assert.match(r.data.need_you[0].text, /^Stuck cartons: 1 packed, loading job open more than 2 days \(20 units · ₹1,100 · oldest 36 days\)/);
  uc.reports = { ...reports, stuckCartons: async () => ({ ok: false, msg: "RetailPilot: whitelist_violation" }) };
  assert.deepStrictEqual((await uc.health({ date: "2026-11-20" })).data.stuck_cartons, { ok: false, msg: "RetailPilot: whitelist_violation" });
});
