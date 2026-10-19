/**
 *   node --test utils/retailpilot_grn.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const G = require("./retailpilot_grn");

describe("retailpilot_grn queries", () => {
  it("only the store's purchases, in India-time dates", () => {
    const sql = G.buildHeadersQuery("9rJMC", "2026-10-01", "2026-10-31");
    assert.match(sql, /h\.invoice_type = 'PURCHASE' AND h\.store_id = '9rJMC'/);
    assert.match(sql, /AT TIME ZONE 'Asia\/Kolkata'\)::date\) >= DATE '2026-10-01'/);
    assert.match(sql, /<= DATE '2026-10-31'/);
  });

  it("refuses anything but the expected shapes in a query", () => {
    assert.throws(() => G.buildHeadersQuery("9rJMC' OR 1=1 --", null, null));
    assert.throws(() => G.buildHeadersQuery("9rJMC", "2026-10-01' --", null));
    assert.throws(() => G.buildLinesQuery("9rJMC", "INV-1'; DROP"));
    assert.equal(G.buildSearchQuery("9rJMC", "66' OR '1"), null);
    assert.equal(G.buildHeaderByRefnoQuery("9rJMC", "abc"), null);
    assert.equal(G.buildPreviousLinesQuery("9rJMC", [1, 2], "2026-10-19' --"), null);
  });

  it("search is a GRN No prefix; detail is one GRN No", () => {
    assert.match(G.buildSearchQuery("9rJMC", "661"), /LIKE '661%'/);
    assert.match(G.buildHeaderByRefnoQuery("9rJMC", "6619"), /h\.seq = 6619/);
  });

  it("previous lines: newest earlier line per article", () => {
    const sql = G.buildPreviousLinesQuery("9rJMC", [5, "5", 7, "x"], "2026-10-19T14:44:46.371+05:30");
    assert.match(sql, /d\.article_id IN \(5,7\)/);
    const prev = G.previousByArticle([
      { article_id: 5, basic_cost: 10, landing_cost: 11.8, selling_price: 15 },
      { article_id: 5, basic_cost: 9, landing_cost: 10.6, selling_price: 14 },
    ]);
    assert.deepEqual(prev.get(5), { MMD_PPUR_RATE: 10, MMD_PREV_PUR_PRICE: 11.8, MMD_PMRP: 15 });
  });
});
