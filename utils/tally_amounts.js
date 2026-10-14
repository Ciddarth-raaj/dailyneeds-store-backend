/**
 * Rupee amounts for the Tally sales and cash vouchers built from Account
 * Sheets, exact to the paisa.
 *
 * These ran through parseInt(), which dropped the paise of each figure
 * separately (Card Sales 196057.10 became 196057, Sales Return 388.75 became
 * 388), so Tally's sales, cash and loyalty ledgers came out a few rupees off
 * the Account Sheet. Amounts are now worked in integer paise and handed back
 * as rupees with at most two decimals.
 */
const { toPaise } = require("./account_difference");

function fromPaise(paise) {
  return paise / 100 + 0;
}

/** a + b in rupees without floating-point drift (0.1 + 0.2 = 0.3). */
function addRupees(a, b) {
  return fromPaise(toPaise(a) + toPaise(b));
}

/**
 * One Account Sheet's Sales journal lines:
 *   Cash  (Dr) = Total Sales - Card Sales - Sales Return
 *                (= cash sales + loyalty - sales return, as before)
 *   Card Sales (Dr) = Card Sales
 *   Sales (Cr) = Cash + Card Sales
 * so the voucher always balances.
 */
function getSalesEntryAmounts(sheet) {
  const card = toPaise(sheet.card_sales);
  const cash =
    toPaise(sheet.total_sales) - card - toPaise(sheet.sales_return);
  return {
    cash: fromPaise(cash),
    card: fromPaise(card),
    sales: fromPaise(cash + card),
  };
}

module.exports = { addRupees, getSalesEntryAmounts };
