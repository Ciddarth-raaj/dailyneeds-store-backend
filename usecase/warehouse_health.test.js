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
};
const reports = { _boxes: async () => [], _staffNames: async () => ({}) };

function setup(recipients, failFor = null) {
  const sent = [];
  const recorded = [];
  const uc = make({
    repo,
    reports,
    today: () => "2026-11-21",
    dashboardUrl: "https://x/d",
    telegramService: {
      sendMessage: async (chat, text, options) => {
        if (chat === failFor) throw new Error("blocked");
        sent.push({ chat, text, options });
      },
    },
    summaryRepo: {
      recipients: async () => recipients,
      sentOn: async () => new Set([3]),
      record: async (r) => recorded.push(r),
      chatOf: async (id) => (id === 1 ? "c1" : null),
    },
  });
  return { uc, sent, recorded };
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
  assert.deepStrictEqual(out, { date: "2026-11-20", sent: 1, failed: 1, skipped: 1, already: 1 });
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
