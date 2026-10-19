/**
 *   node --test utils/retailpilot_stock.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { mapStockRows } = require("./retailpilot_stock");

const STORE_MAP = { "store-a": 2, "store-b": 3 };

const row = (over = {}) => ({
  store_id: "store-a",
  store_name: "warehouse",
  stock_location: "main",
  article_id: 109996,
  item_code: "33097",
  article_name: "candy 220g",
  batch_id: "B-1",
  quantity: 10,
  mrp: 135,
  landing_cost: 80,
  net_landing_cost: 82,
  default_selling_price: 120,
  ...over,
});

describe("mapStockRows", () => {
  it("maps one batch to a price, a stock and a price checker row", () => {
    const r = mapStockRows([row()], [], STORE_MAP);
    assert.deepEqual(r.priceRows, [
      { item_code: 109996, outlet: "2", batch_no: "B-1", mrp: 135, selling_price: 120, landing_cost: 80 },
    ]);
    assert.deepEqual(r.stockRows, [{ item_code: 109996, outlet: "2", batch_no: "B-1", stock_qty: 10 }]);
    assert.equal(r.priceCheckerRows[0].purchase_price, 80);
    assert.equal(r.priceCheckerRows[0].landing_cost, 82);
    assert.equal(r.priceCheckerRows[0].old_selling_price, 120);
  });

  it("counts only main-location stock, but prices a batch held elsewhere", () => {
    const r = mapStockRows(
      [row({ quantity: 4 }), row({ stock_location: "damg", quantity: 6 }), row({ batch_id: "B-2", stock_location: "damg" })],
      [],
      STORE_MAP
    );
    assert.deepEqual(r.stockRows.map((s) => [s.batch_no, s.stock_qty]), [["B-1", 4]]);
    assert.deepEqual(r.priceRows.map((p) => p.batch_no), ["B-1", "B-2"]);
  });

  it("selling price: in-store for the store, then in-store for all, then default", () => {
    const instore = [
      { batch_id: "B-1", store_id: "store-a", selling_price: 100 },
      { batch_id: "B-1", store_id: null, selling_price: 110 },
    ];
    const r = mapStockRows([row(), row({ store_id: "store-b" }), row({ batch_id: "B-2" })], instore, STORE_MAP);
    const price = (outlet, batch) => r.priceRows.find((p) => p.outlet === outlet && p.batch_no === batch).selling_price;
    assert.equal(price("2", "B-1"), 100);
    assert.equal(price("3", "B-1"), 110);
    assert.equal(price("2", "B-2"), 120);
  });

  it("item code: the article sync's product id, else the article id (never the old code)", () => {
    const r = mapStockRows(
      [row(), row({ batch_id: "B-2", item_code: null, article_id: 127784 }), row({ batch_id: "B-3", article_id: 555 })],
      [],
      STORE_MAP,
      new Map([[555, 40001]])
    );
    assert.deepEqual(r.priceRows.map((p) => [p.batch_no, p.item_code]), [["B-1", 109996], ["B-2", 127784], ["B-3", 40001]]);
  });

  it("skips rows with no price, and unmapped stores", () => {
    const r = mapStockRows(
      [row({ default_selling_price: null }), row({ store_id: "store-x" })],
      [],
      STORE_MAP
    );
    assert.equal(r.priceRows.length, 0);
    assert.equal(r.skipped.length, 1);
    assert.deepEqual(r.unmappedStores, ["store-x"]);
    // A batch with no price still reports its stock.
    assert.deepEqual(r.stockRows.map((s) => s.batch_no), ["B-1"]);
  });
});
