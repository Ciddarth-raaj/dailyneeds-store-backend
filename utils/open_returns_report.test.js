/**
 * The 9:15 am Open returns PDF and its sender.
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

describe("report", () => {
  it("one line per supplier per location, oldest first, names escaped, bands counted", () => {
    const { html, summary } = R.buildReport(ROWS, STORES, { nowMs: NOW });
    assert.deepEqual(summary.groups.map((g) => [g.supplier, g.location, g.claims, g.value, g.age_days]), [
      ["B", "Kathirkamam", 1, 900, 40],
      ["A & Sons <Pvt>", "Warehouse", 2, 150, 23],
      ["C", "Kathirkamam", 1, 10, 10],
    ]);
    assert.equal(summary.value, 1060);
    assert.equal(summary.suppliers, 3);
    assert.deepEqual(summary.red, { lines: 2, claims: 3, value: 1050 });
    assert.deepEqual(summary.amber, { lines: 1, claims: 1, value: 10 });
    assert.match(html, /A &amp; Sons &lt;Pvt&gt;/);
    assert.doesNotMatch(html, /<Pvt>/);
    assert.match(html, /<tr class="red">/);
    assert.match(html, /15 Oct 2026/);
  });

  it("says so when there are none", () => {
    const { html, summary } = R.buildReport([], STORES, { nowMs: NOW });
    assert.match(html, /No open returns/);
    assert.equal(summary.claims, 0);
  });
});

describe("sender", () => {
  const dashboard = (open) => ({
    getPurchaseReturns: async ({ from_date }) => {
      assert.equal(from_date, "2026-11-24");
      return { code: 200, data: { stores: STORES, open } };
    },
  });

  const pdf = { withBrowser: async (fn) => fn({ renderPdf: async (html) => Buffer.from(html) }) };
  const s3 = { uploadFile: async (_b, name) => `https://s3/${name}` };

  it("renders, uploads and sends the PDF to the registered group", async () => {
    const sent = [];
    const uc = usecaseFactory({
      dashboard: dashboard({ ok: true, rows: ROWS }),
      pdf,
      s3,
      telegram: { sendDocument: async (...args) => sent.push({ chat: args[0], url: args[1], args }) },
      chatId: "-100fallback",
      registryRepo: { getAll: async () => [{ used_for: "Invoice pipeline EOD", chat_id: "-100purchase", group_name: "Purchase" }] },
      now: () => NOW,
    });
    const r = await uc.run({ trigger: "manual" });
    assert.equal(r.code, 200);
    assert.equal(sent[0].chat, "-100purchase");
    assert.match(sent[0].url, /^https:\/\/s3\/open_returns\/open_returns_2026-11-24_\d+\.pdf$/);
    assert.equal(sent[0].args.length, 2, "no caption");
  });

  it("does not send when RetailPilot could not be read", async () => {
    const sent = [];
    const uc = usecaseFactory({
      dashboard: dashboard({ ok: false, error: "not allowed", rows: [] }),
      pdf,
      s3,
      telegram: { sendDocument: async () => sent.push(1) },
      chatId: "-100fallback",
      now: () => NOW,
    });
    const r = await uc.run();
    assert.equal(r.code, 502);
    assert.equal(sent.length, 0);
  });
});
