/**
 * Account Sheet - Total Difference.
 *
 * The one definition of the outlet Account Sheet reconciliation. The same
 * file lives in the frontend at util/accountDifference.js (Account Sheet
 * form) - keep the two identical.
 *
 *   Total Difference = Total Sales
 *                      - ( Cash Handover + Card Sales + Loyalty + Sales Return
 *                          + Payments - Receipts )
 *
 * Positive: less was accounted for than was sold - cash Short.
 * Negative: more was accounted for than was sold - cash Excess.
 *
 * Everything is summed in whole paise so no rupee value is truncated and no
 * floating-point error creeps in. A blank or non-numeric field counts as 0,
 * so the figure is always a number while the form is being filled in.
 */

const DENOMINATIONS = [500, 200, 100, 50, 20, 10, 5, 2, 1];

const PAYMENT_TYPE_PAYMENT = 1;

/** Rupees (number or string, e.g. a DECIMAL from MySQL) to integer paise. */
function toPaise(value) {
  if (value === null || value === undefined || value === "") return 0;
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  // toPrecision(15) drops binary noise (1.005 * 100 = 100.49999999999999)
  // before rounding half away from zero.
  const scaled = Number((Math.abs(n) * 100).toPrecision(15));
  return Math.sign(n) * Math.round(scaled) + 0;
}

/** A note count; a blank or non-numeric count is 0. */
function toCount(value) {
  if (value === null || value === undefined || value === "") return 0;
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.trunc(n);
}

function getTotalCashHandoverPaise(values) {
  if (!values) return 0;
  return DENOMINATIONS.reduce(
    (sum, denom) => sum + toCount(values[`cash_handover_${denom}`]) * denom * 100,
    0
  );
}

/** Payments add to what is accounted for, receipts take away from it. */
function getTransactionsPaise(rows) {
  if (!Array.isArray(rows)) return 0;
  return rows.reduce((sum, item) => {
    if (!item) return sum;
    const amount = toPaise(item.amount);
    return item.payment_type == PAYMENT_TYPE_PAYMENT ? sum + amount : sum - amount;
  }, 0);
}

function getAccountDifferencePaise(values) {
  if (!values) return 0;
  const { total_sales, card_sales, loyalty, sales_return, accounts, sales } =
    values;

  const accounted =
    getTotalCashHandoverPaise(values) +
    toPaise(card_sales) +
    toPaise(loyalty) +
    toPaise(sales_return) +
    getTransactionsPaise(accounts ?? sales);

  return toPaise(total_sales) - accounted;
}

function fromPaise(paise) {
  // `+ 0` turns a -0 into 0 so a balanced sheet never shows "-0.00".
  return paise / 100 + 0;
}

/** Total Difference in rupees, exact to the paisa. */
function getAccountDifference(values) {
  return fromPaise(getAccountDifferencePaise(values));
}

function getTotalCashHandover(values) {
  return fromPaise(getTotalCashHandoverPaise(values));
}

/** "SHORT" when positive, "EXCESS" when negative, "BALANCED" at zero. */
function getDifferenceStatus(difference) {
  const paise = toPaise(difference);
  if (paise > 0) return "SHORT";
  if (paise < 0) return "EXCESS";
  return "BALANCED";
}

module.exports = {
  DENOMINATIONS,
  toPaise,
  getTotalCashHandoverPaise,
  getTotalCashHandover,
  getAccountDifferencePaise,
  getAccountDifference,
  getDifferenceStatus,
};
