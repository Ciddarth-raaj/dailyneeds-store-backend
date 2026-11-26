/**
 * PO daily follow-up summary - the maths, the message and the sends.
 *
 *   node --test utils/po_daily_summary.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const S = require("./po_daily_summary");
const factory = require("../usecase/po_daily_summary");

const TODAY = "2026-11-16";
const po = (slug, o = {}) => ({ po_slug: slug, status: "APPROVED", po_date: "2026-11-10", pending_value: 1000, needs_followup: false, ...o });

describe("buildSummary", () => {
  it("chased counts only POs that were due; not chased is the 7 pm flag", () => {
    const orders = [
      po("a"), // chased today, never chased before -> was due
      po("b"), // chased today, chased yesterday -> was not due
      po("c", { po_date: "2026-11-15" }), // chased today, too new -> not due
      po("d", { needs_followup: true, pending_value: 50000 }), // not chased
      po("e", { needs_followup: true, pending_value: 150000, days_past_validity: 4 }), // not chased, expired
      po("f"), // nothing
      po("g", { needs_followup: false, stopped: { stop_reason: "VENDOR_CHANGED" } }), // stopped: not counted
      po("h", { stopped: { stop_reason: "NOT_NEEDED" } }), // chased today, then stopped: not counted
    ];
    const s = S.buildSummary({
      orders,
      chasedToday: ["a", "b", "c", "h", "zzz"],
      previousBySlug: new Map([["b", { created_day: "2026-11-15" }]]),
      today: TODAY,
    });
    assert.equal(s.due, 3);
    assert.deepEqual([s.awaiting.chased, s.awaiting.not_chased, s.awaiting.due, s.awaiting.not_chased_value], [1, 1, 2, 50000]);
    assert.deepEqual([s.expired.chased, s.expired.not_chased, s.expired.due, s.expired.not_chased_value], [0, 1, 1, 150000]);
  });
  it("formats chased / not chased out of the total", () => {
    const text = S.formatMessage({
      today: TODAY,
      due: 19,
      awaiting: { due: 12, chased: 9, not_chased: 3, not_chased_value: 80000 },
      expired: { due: 7, chased: 5, not_chased: 2, not_chased_value: 110000 },
    });
    assert.equal(
      text,
      [
        "📦 PO Follow-up · Mon, 16 Nov",
        "",
        "🕒 Awaiting delivery (12 due)",
        "   ✅ Chased: 9 / 12 (75%)",
        "   ⚠️ Not chased: 3 / 12 (25%) · ₹80k pending",
        "",
        "🔴 Expired (7 due)",
        "   ✅ Chased: 5 / 7 (71%)",
        "   ⚠️ Not chased: 2 / 7 (29%) · ₹1.1 L pending",
      ].join("\n")
    );
    assert.match(S.formatMessage({ today: TODAY, due: 3, awaiting: { due: 3, chased: 3, not_chased: 0 }, expired: { due: 0, chased: 0, not_chased: 0 } }), /🔴 Expired: nothing due/);
    assert.match(S.formatMessage({ today: TODAY, due: 0, chased: 0, not_chased: 0 }), /Nothing was due/);
  });
});

describe("sending", () => {
  const setup = (recipients, sentAlready = []) => {
    const records = [];
    const messages = [];
    const uc = factory({
      poTracker: { list: async () => ({ code: 200, data: { orders: [po("a"), po("d", { needs_followup: true })] } }) },
      followupRepo: { chasedBetween: async () => ["a"], latestBefore: async () => [] },
      summaryRepo: {
        recipients: async () => recipients,
        sentOn: async () => new Set(sentAlready),
        record: async (r) => records.push(r),
        chatOf: async (id) => (id === 1 ? "111" : null),
      },
      telegramService: {
        sendMessage: async (chat, text, opts) => {
          if (chat === "bad") throw new Error("bot was blocked");
          messages.push({ chat, text, opts });
        },
      },
      trackerUrl: "https://example.test/purchase-order/tracker",
      today: () => TODAY,
    });
    return { uc, records, messages };
  };
  it("sends to linked recipients, skips unlinked, records failures, never twice", async () => {
    const { uc, records, messages } = setup(
      [
        { employee_id: 1, private_chat_id: "111" },
        { employee_id: 2, private_chat_id: null },
        { employee_id: 3, private_chat_id: "bad" },
        { employee_id: 4, private_chat_id: "444" },
      ],
      [4]
    );
    const r = await uc.run();
    assert.deepEqual([r.sent, r.skipped, r.failed, r.already], [1, 1, 1, 1]);
    assert.equal(messages.length, 1);
    assert.match(messages[0].text, /Awaiting delivery \(2 due\)\n   ✅ Chased: 1 \/ 2 \(50%\)/);
    assert.equal(messages[0].opts.replyMarkup.inlineKeyboard[0][0].url, "https://example.test/purchase-order/tracker");
    assert.deepEqual(records.map((x) => [x.employee_id, x.status]), [[1, "SENT"], [2, "SKIPPED"], [3, "FAILED"]]);
  });
  it("send-me goes only to the caller and is not recorded", async () => {
    const { uc, records, messages } = setup([]);
    assert.equal((await uc.sendToMe(1)).code, 200);
    assert.equal(messages[0].chat, "111");
    assert.equal(records.length, 0);
    assert.equal((await uc.sendToMe(2)).code, 422);
    assert.equal((await uc.sendToMe(null)).code, 403);
  });
});
