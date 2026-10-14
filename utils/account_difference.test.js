/**
 * Account Sheet - Total Difference (backend copy, used by the Tally cash
 * export). Same cases as the frontend util/accountDifference.test.js.
 *
 *   node --test utils/account_difference.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  toPaise,
  getTotalCashHandover,
  getAccountDifference,
  getDifferenceStatus,
} = require("./account_difference");

// The sheet in the bug report, as GET /accounts returns it: DECIMAL(10,2)
// columns as strings, INT note counts, rows under `sales`.
const savedSheet = () => ({
  total_sales: "316801.98",
  card_sales: "196057.10",
  loyalty: "701.00",
  sales_return: "388.75",
  cash_handover_500: 226,
  cash_handover_200: 1,
  cash_handover_100: 2,
  cash_handover_50: 1,
  cash_handover_20: 1,
  cash_handover_10: 1,
  cash_handover_5: 1,
  cash_handover_2: 0,
  cash_handover_1: 0,
  sales: [
    { payment_type: 1, amount: "1764.00" },
    { payment_type: 1, amount: "4666.00" },
  ],
});

test("the screenshot sheet is -259.87 (the old parseInt gave -260.85)", () => {
  const sheet = savedSheet();
  assert.equal(getTotalCashHandover(sheet), 113485);
  assert.equal(getAccountDifference(sheet), -259.87);
  assert.equal(getDifferenceStatus(-259.87), "EXCESS");
});

test("paise survive: 0.98 of Total Sales is not dropped", () => {
  assert.equal(getAccountDifference({ total_sales: "100.98", card_sales: "100.00" }), 0.98);
  assert.equal(getAccountDifference({ total_sales: "0.30", card_sales: "0.10", loyalty: "0.20" }), 0);
});

test("payments add to what is accounted for, receipts take away", () => {
  const sheet = savedSheet();
  sheet.sales.push({ payment_type: 2, amount: "100.50" });
  assert.equal(getAccountDifference(sheet), -159.37);
  sheet.sales[2].payment_type = 1;
  assert.equal(getAccountDifference(sheet), -360.37);
  sheet.sales.splice(2, 1);
  assert.equal(getAccountDifference(sheet), -259.87);
});

test("a sheet with no rows, or null fields, is a number", () => {
  assert.equal(getAccountDifference({ total_sales: "10.50", sales: null }), 10.5);
  assert.equal(getAccountDifference({ total_sales: null }), 0);
  assert.equal(toPaise("abc"), 0);
});

test("zero, positive and negative", () => {
  const balanced = { ...savedSheet(), total_sales: "317061.85" };
  assert.equal(getAccountDifference(balanced), 0);
  assert.equal(getDifferenceStatus(0), "BALANCED");
  assert.equal(getAccountDifference({ ...balanced, total_sales: "317062.85" }), 1);
  assert.equal(getDifferenceStatus(1), "SHORT");
  assert.equal(getAccountDifference({ ...balanced, total_sales: "317060.85" }), -1);
});

test("the Tally cash export uses this rule, not a truncating copy", () => {
  const tally = fs.readFileSync(path.join(__dirname, "../usecase/tally.js"), "utf8");
  assert.match(tally, /require\("\.\.\/utils\/account_difference"\)/);
  assert.match(tally, /return getAccountDifference\(values\);/);
  assert.ok(!/parseInt\(total_sales\)/.test(tally));
});
