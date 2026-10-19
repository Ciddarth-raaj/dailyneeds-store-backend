/**
 *   node --test usecase/retailpilot_grn_sync.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const makeSync = require("./retailpilot_grn_sync");

const H = (slug, seq) => ({
  invoice_slug: slug, refno: String(seq), fy: 2026, store_id: "9rJMC", grn_date: "2026-10-19",
  entered_at: "2026-10-19T10:00:00+05:30", supplier_id: "1", supplier_name: "s", amount: 10,
});
const L = (inv, slug, article) => ({ invoice_slug: inv, mmd_mrc_sl_no: slug, mmd_item_code: article, mmd_recd_qty: "2" });

function fakes({ localLines = 0, headers, windowHeaders, lines }) {
  const queries = [];
  const spectra = {
    isConfigured: () => true,
    queryAll: async (sql) => {
      queries.push(sql);
      if (/FROM public\.invoice_details/.test(sql)) return lines;
      return /CURRENT_DATE - 3/.test(sql) ? windowHeaders : headers;
    },
  };
  const calls = {};
  const repo = {
    countLines: async () => localLines,
    replaceHeaders: async (store, hs) => ((calls.headers = { store, hs }), { upserted: hs.length, removed: 0 }),
    replaceLines: async (slugs, ls) => ((calls.lines = { slugs, ls }), ls.length),
  };
  return { spectra, repo, calls, queries };
}

describe("RetailPilot GRN sync", () => {
  it("first run copies every GRN's lines", async () => {
    const f = fakes({ headers: [H("INV-a", 1), H("INV-b", 2)], lines: [L("INV-a", "ID-1", 5), L("INV-a", "ID-2", 6), L("INV-b", "ID-3", 5)] });
    const r = await makeSync(f.spectra, f.repo, async () => "9rJMC").run();
    assert.equal(r.code, 200);
    assert.equal(r.full, true);
    assert.ok(f.queries.every((q) => !/CURRENT_DATE/.test(q)), "no window on the first run");
    assert.deepEqual(f.calls.lines.slugs, ["INV-a", "INV-b"]);
    assert.deepEqual(f.calls.lines.ls.map((l) => [l.line_id, l.line_no, l.product_id, l.recd_qty]), [
      ["ID-1", 1, 5, 2], ["ID-2", 2, 6, 2], ["ID-3", 1, 5, 2],
    ]);
  });

  it("later runs replace only GRNs changed in the last 3 days, all headers kept", async () => {
    const f = fakes({
      localLines: 10,
      headers: [H("INV-a", 1), H("INV-b", 2)],
      windowHeaders: [{ invoice_slug: "INV-b" }],
      lines: [L("INV-b", "ID-3", 5), L("INV-x", "ID-9", 5)],
    });
    const r = await makeSync(f.spectra, f.repo, async () => "9rJMC").run();
    assert.equal(r.full, false);
    assert.equal(f.calls.headers.hs.length, 2);
    assert.deepEqual(f.calls.lines.slugs, ["INV-b"]);
    // A line of a GRN without a stored header is left for the next run.
    assert.deepEqual(f.calls.lines.ls.map((l) => l.line_id), ["ID-3"]);
  });

  it("one run at a time; no store id means nothing is changed", async () => {
    const f = fakes({ headers: [], lines: [] });
    const sync = makeSync(f.spectra, f.repo, async () => "9rJMC");
    const codes = (await Promise.all([sync.run(), sync.run()])).map((r) => r.code);
    assert.deepEqual(codes, [200, 409]);
    const g = fakes({ headers: [H("INV-a", 1)], lines: [] });
    assert.equal((await makeSync(g.spectra, g.repo, async () => null).run()).code, 400);
    assert.equal(g.calls.headers, undefined);
  });
});
