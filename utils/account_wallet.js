/**
 * Account Sheet - Wallet Transactions (wallet_receipt / wallet_payment).
 *
 * Two optional amounts per sheet: money received into and paid out of the
 * store's digital wallet. They are recorded only; they take no part in
 * Total Sales, Cash Sales, Cash Handover or the Total Difference.
 *
 *   Net Wallet Movement = Wallet Receipt - Wallet Payment
 */
const { toPaise } = require("./account_difference");

// DECIMAL(12,2)
const WALLET_MAX = 9999999999.99;

const WALLET_FIELDS = ["wallet_receipt", "wallet_payment"];

/**
 * The value to store for one wallet field:
 *   - omitted (undefined / null) -> null, meaning "leave as it is" on an
 *     update and 0 on a create;
 *   - "" -> 0 (the field was cleared);
 *   - otherwise a non-negative amount with at most two decimals.
 * Throws a ValidationError for anything else.
 */
function walletAmountOrNull(value, field) {
  if (value === undefined || value === null) return null;
  if (value === "") return 0;

  const n = Number(value);
  const fail = (why) => {
    const err = new Error(`"${field}" ${why}`);
    err.name = "ValidationError";
    throw err;
  };

  if (typeof value === "boolean" || !Number.isFinite(n)) fail("must be a number");
  if (n < 0) fail("must not be negative");
  if (n > WALLET_MAX) fail(`must not exceed ${WALLET_MAX}`);
  if (toPaise(n) !== Math.round(n * 1e6) / 1e4) fail("must have at most two decimal places");

  return toPaise(n) / 100;
}

/** Both wallet fields of a request body, normalised as above. */
function walletValues(body) {
  const out = {};
  for (const field of WALLET_FIELDS) {
    out[field] = walletAmountOrNull(body ? body[field] : undefined, field);
  }
  return out;
}

/** Net Wallet Movement in rupees, exact to the paisa. */
function getNetWalletMovement(sheet) {
  if (!sheet) return 0;
  return (toPaise(sheet.wallet_receipt) - toPaise(sheet.wallet_payment)) / 100 + 0;
}

module.exports = {
  WALLET_FIELDS,
  WALLET_MAX,
  walletAmountOrNull,
  walletValues,
  getNetWalletMovement,
};
