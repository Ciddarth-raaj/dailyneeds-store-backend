/**
 * Tally sales / cash voucher amounts from Account Sheets.
 *
 *   node --test utils/tally_amounts.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { addRupees, getSalesEntryAmounts } = require("./tally_amounts");

// The 11/10/2026 sheet as GET /accounts returns it (DECIMAL as strings).
const sheet = {
  total_sales: "316801.98",
  card_sales: "196057.10",
  loyalty: "701.00",
  sales_return: "388.75",
};

test("the Sales journal keeps every paisa and balances", () => {
  const a = getSalesEntryAmounts(sheet);
  assert.equal(a.card, 196057.1);
  assert.equal(a.cash, 120356.13); // 316801.98 - 196057.10 - 388.75
  assert.equal(a.sales, 316413.23); // = Total Sales - Sales Return
  assert.equal(addRupees(a.cash, a.card), a.sales);
});

test("the old parseInt figures were 0.23 short on this sheet", () => {
  const cashSales = 316801.98 - 196057.1 - 701;
  const oldCash = parseInt(cashSales) + parseInt("701.00") - parseInt("388.75");
  const oldCard = parseInt("196057.10");
  const oldSales = parseInt(oldCard + (cashSales + 701 - 388));
  assert.deepEqual([oldCash, oldCard, oldSales], [120356, 196057, 316413]);
  assert.equal(
    addRupees(getSalesEntryAmounts(sheet).sales, -oldSales),
    0.23
  );
});

test("same as the old rule when there are no paise", () => {
  const a = getSalesEntryAmounts({
    total_sales: "1000.00",
    card_sales: "400.00",
    loyalty: "50.00",
    sales_return: "20.00",
  });
  // old: cash_sales (1000-400-50) + loyalty 50 - return 20 = 580
  assert.deepEqual(a, { cash: 580, card: 400, sales: 980 });
});

test("several sheets on one day add up without float drift", () => {
  let total = 0;
  for (const v of ["0.10", "0.20", "0.30", "120356.13", "0.01"]) {
    total = addRupees(total, v);
  }
  assert.equal(total, 120356.74);
  assert.equal(addRupees(0.1, 0.2), 0.3);
});

test("null fields are 0, not NaN", () => {
  assert.deepEqual(getSalesEntryAmounts({ total_sales: "10.50" }), {
    cash: 10.5,
    card: 0,
    sales: 10.5,
  });
});

test("tally.js no longer truncates any Account Sheet amount", () => {
  const tally = fs.readFileSync(path.join(__dirname, "../usecase/tally.js"), "utf8");
  assert.ok(!/parseInt\(/.test(tally));
  assert.match(tally, /getSalesEntryAmounts\(item\)/);
});
