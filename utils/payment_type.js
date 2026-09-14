/**
 * THE PAYMENT ROUTE A NEW EMPLOYEE STARTS ON.
 *
 * At Daily Needs an employee is created BEFORE HR has collected bank
 * details, so the honest answer on day one is not "unknown", it is "cash":
 * the first salary is handed over in cash and the bank account is set up
 * afterwards. The lifecycle the business actually runs is
 *
 *   New employee -> Cash -> (HR collects bank details) -> Bank -> verified
 *
 * and `payment_type IS NULL` was never a step in it. NULL is what the code
 * produced because no creation path had an opinion, and it has a real cost
 * on the HR Onboarding dashboard: `usecase/employee_status_summary.js`
 * reads an unrecorded payment type as UNKNOWN, which is correct and must
 * stay correct - so a newly created employee appeared under neither Bank
 * Pending nor Cash -> Bank Pending, and the work of moving them onto a bank
 * account was invisible.
 *
 * THE FIX IS AT THE WRITE, NOT ON THE DASHBOARD. This module is the one
 * definition of the default, applied by the repository layer immediately
 * before the INSERT, so no screen, script or route can diverge from it and
 * a frontend that forgets to send a value still gets the right row.
 *
 * WHAT IT NEVER DOES:
 *   - It never overwrites an explicitly supplied, valid payment type. A
 *     flow authorised to create a Bank employee still creates one.
 *   - It never touches an UPDATE. An existing employee whose payment type
 *     is NULL keeps it until a human records one; opening or editing their
 *     profile must not silently decide a payment route on their behalf.
 *     That is why this is exported for creates only.
 */
const { PAYMENT_TYPE } = require("../constants/employee_master_sections");

/** The only two values the column has ever meant anything by. */
const VALID_PAYMENT_TYPES = [PAYMENT_TYPE.BANK, PAYMENT_TYPE.CASH];

/** The default for a create that does not say. */
const DEFAULT_PAYMENT_TYPE_ON_CREATE = PAYMENT_TYPE.CASH;

/**
 * True when `value` is one of the payment routes the backend recognises.
 *
 * Numeric strings count - the legacy screens post form values - but `null`,
 * `undefined`, `""` and anything outside the pair do not. Deliberately
 * strict: an unrecognised number is not a payment route we can act on, and
 * treating it as "explicitly supplied" would preserve a value the dashboard
 * cannot classify.
 */
function isValidPaymentType(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "string" && value.trim() === "") return false;
  const n = Number(value);
  return Number.isInteger(n) && VALID_PAYMENT_TYPES.includes(n);
}

/**
 * The payment type a create should store, given whatever it was handed.
 * A valid explicit value is preserved (as a number); anything else -
 * absent, null, empty, unrecognised - becomes Cash.
 */
function paymentTypeForCreate(value) {
  return isValidPaymentType(value) ? Number(value) : DEFAULT_PAYMENT_TYPE_ON_CREATE;
}

/**
 * Returns a COPY of an employee-create field set with `payment_type`
 * resolved. A copy, not a mutation, so a caller's own object - a request
 * body, a rehearsal fixture - is never rewritten underneath it.
 */
function applyDefaultPaymentType(fields) {
  const next = { ...(fields || {}) };
  next.payment_type = paymentTypeForCreate(next.payment_type);
  return next;
}

module.exports = {
  PAYMENT_TYPE,
  VALID_PAYMENT_TYPES,
  DEFAULT_PAYMENT_TYPE_ON_CREATE,
  isValidPaymentType,
  paymentTypeForCreate,
  applyDefaultPaymentType,
};
