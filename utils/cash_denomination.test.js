/**
 * Cash denominations.
 *
 *   node --test utils/cash_denomination.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { DENOMINATIONS, breakdown, totals, valueOf } = require("./cash_denomination");

const only = (nonZero) => Object.fromEntries(DENOMINATIONS.map((d) => [d, nonZero[d] || 0]));

describe("breakdown - largest denomination first, reconciling exactly", () => {
  const cases = [
    [500, { 500: 1 }],
    [700, { 500: 1, 200: 1 }],
    [18760, { 500: 37, 200: 1, 50: 1, 10: 1 }],
    [12345, { 500: 24, 200: 1, 100: 1, 20: 2, 5: 1 }],
    [999, { 500: 1, 200: 2, 50: 1, 20: 2, 5: 1, 2: 2 }],
    [1, { 1: 1 }],
    [0, {}],
  ];
  for (const [amount, expected] of cases) {
    it(`₹${amount}`, () => {
      const counts = breakdown(amount);
      assert.deepEqual(counts, only(expected));
      assert.equal(valueOf(counts), amount);
    });
  }

  it("reconciles for every amount from 0 to 5,000 and for large amounts", () => {
    for (let a = 0; a <= 5000; a += 1) assert.equal(valueOf(breakdown(a)), a);
    for (const a of [99999, 123456, 1000000, 9876543]) assert.equal(valueOf(breakdown(a)), a);
  });

  it("never needs more than the minimum of the small denominations", () => {
    for (let a = 0; a <= 2000; a += 1) {
      const c = breakdown(a);
      assert.ok(c[200] <= 2 && c[100] <= 1 && c[50] <= 1 && c[20] <= 2 && c[10] <= 1 && c[5] <= 1 && c[2] <= 2 && c[1] <= 1, `₹${a}`);
    }
  });

  it("refuses paise, negatives and non-numbers rather than rounding them", () => {
    for (const bad of [10.5, 0.01, -1, NaN, Infinity, "500", null, undefined]) {
      assert.throws(() => breakdown(bad), (e) => e.name === "DenominationError", String(bad));
    }
  });
});

describe("totals", () => {
  it("adds the count of each denomination and its amount", () => {
    const t = totals([breakdown(18760), breakdown(700), breakdown(1)]);
    assert.deepEqual(
      t.map((x) => [x.denomination, x.count, x.amount]),
      [
        [500, 38, 19000],
        [200, 2, 400],
        [100, 0, 0],
        [50, 1, 50],
        [20, 0, 0],
        [10, 1, 10],
        [5, 0, 0],
        [2, 0, 0],
        [1, 1, 1],
      ]
    );
    assert.equal(t.reduce((s, x) => s + x.amount, 0), 18760 + 700 + 1);
  });
});
