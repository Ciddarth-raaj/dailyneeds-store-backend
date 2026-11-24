/**
 * The 9:15 am Open returns Telegram message and its sender.
 *
 *   node --test utils/open_returns_report.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const R = require("./open_returns_report");
const usecaseFactory = require("../usecase/open_returns_report");

const STORES = [
  { key: "outlet:9", name: "Warehouse" },
  { key: "outlet:3", name: "Kathirkamam" },
];
const ROWS = [
  { supplier_id: "1", supplier_name: "A & Sons <Pvt>", store: "outlet:9", amount: 100, raised_on: "2026-11-01", age_days: 23 },
  { supplier_id: "1", supplier_name: "A & Sons <Pvt>", store: "outlet:9", amount: 50, raised_on: "2026-11-10", age_days: 14 },
  { supplier_id: "2", supplier_name: "B", store: "outlet:3", amount: 900, raised_on: "2026-10-15", age_days: 40 },
  { supplier_id: "3", supplier_name: "C", store: "outlet:3", amount: 10, raised_on: "2026-11-14", age_days: 10 },
];
const NOW = Date.parse("2026-11-24T03:45:00Z"); // 9:15 am India

describe("message", () => {
  it("one line per supplier per location, oldest first, names escaped, bands counted", () => {
    const { text, summary } = R.buildMessage(ROWS, STORES, NOW);
    assert.match(text, /Open returns — 24 Nov 2026, 09:15/);
    assert.match(text, /₹1,060<\/b> · 4 claims · 3 suppliers · oldest 40d/);
    assert.match(text, /Over 15 days: 2 \(₹1,050\) · 🟠 8–15 days: 1 \(₹10\)/);
    const lines = text.split("\n").filter((l) => /^(🔴|🟠|🟢) <b>/.test(l));
    assert.equal(lines.length, 3);
    assert.match(lines[0], /^🔴 <b>40d<\/b> · ₹900 · B · Kathirkamam$/);
    assert.match(lines[1], /A &amp; Sons &lt;Pvt&gt; · Warehouse \(2 claims\)/);
    assert.equal(summary.lines, 3);
  });

  it("says so when there are none", () => {
    assert.match(R.buildMessage([], STORES, NOW).text, /No open returns/);
  });

  it("stays under Telegram's limit and says how many more", () => {
    const many = Array.from({ length: 400 }, (_, i) => ({ supplier_id: String(i), supplier_name: `Supplier number ${i}`, store: "outlet:9", amount: 10, raised_on: "2026-11-01", age_days: 23 }));
    const { text } = R.buildMessage(many, STORES, NOW);
    assert.ok(text.length <= R.MAX_CHARS, String(text.length));
    assert.match(text, /\+\d+ more on the Business Dashboard$/);
  });
});

describe("sender", () => {
  const dashboard = (open) => ({
    getPurchaseReturns: async ({ from_date }) => {
      assert.equal(from_date, "2026-11-24");
      return { code: 200, data: { stores: STORES, open } };
    },
  });

  it("sends HTML to the registered group, preferring one for Open returns", async () => {
    const sent = [];
    const uc = usecaseFactory({
      dashboard: dashboard({ ok: true, rows: ROWS }),
      telegram: { sendMessage: async (chat, text, opts) => sent.push({ chat, text, opts }) },
      chatId: "-100fallback",
      registryRepo: { getAll: async () => [{ used_for: "Invoice pipeline EOD", chat_id: "-100purchase", group_name: "Purchase" }] },
      now: () => NOW,
    });
    const r = await uc.run({ trigger: "manual" });
    assert.equal(r.code, 200);
    assert.equal(sent[0].chat, "-100purchase");
    assert.equal(sent[0].opts.parseMode, "HTML");
  });

  it("does not send when RetailPilot could not be read", async () => {
    const sent = [];
    const uc = usecaseFactory({
      dashboard: dashboard({ ok: false, error: "not allowed", rows: [] }),
      telegram: { sendMessage: async () => sent.push(1) },
      chatId: "-100fallback",
      now: () => NOW,
    });
    const r = await uc.run();
    assert.equal(r.code, 502);
    assert.equal(sent.length, 0);
  });
});
