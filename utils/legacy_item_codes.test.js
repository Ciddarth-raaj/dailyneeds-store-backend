/**
 *   node --test utils/legacy_item_codes.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const L = require("./legacy_item_codes");

// product_table rows: { product_id, legacy_code }
const PRODUCTS = [
  { product_id: 100001, legacy_code: 2 },
  { product_id: 100007, legacy_code: 7 },
  { product_id: 9, legacy_code: 9 },
  { product_id: 127784, legacy_code: null },
];

const fakeDb = {
  query(sql, params, cb) {
    const [, from, to] = sql.match(/SELECT (\w+) AS f, (\w+) AS t/);
    const rows = PRODUCTS.filter((p) => params.includes(p[from])).map((p) => ({ f: p[from], t: p[to] }));
    cb(null, rows);
  },
};

describe("legacy_item_codes", () => {
  it("old code -> product id, and back; a product with no old code has none", async () => {
    assert.deepEqual([...(await L.legacyToProductIds(fakeDb, [2, "7", 4444]))], [[2, 100001], [7, 100007]]);
    assert.deepEqual([...(await L.productIdsToLegacy(fakeDb, [100001, 127784]))], [[100001, 2]]);
  });

  it("rewrites old codes in rows in place, leaving unknown codes as they are", async () => {
    const rows = [{ c: "2" }, { c: 9 }, { c: 4444 }, { c: null }];
    await L.rewriteLegacyCodes(fakeDb, rows, "c");
    assert.deepEqual(rows.map((r) => r.c), [100001, 9, 4444, null]);
  });
});
