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
 *   - It never RESCUES an explicitly supplied invalid one. Missing means
 *     "use our default"; `3`, `0`, `"bank"` or an object means somebody's
 *     code or input is wrong, and quietly storing Cash for it would hide
 *     the bug and record a payment route nobody chose. Those are refused,
 *     422, through the ValidationError shape both employee routes already
 *     map - no new response style.
 *   - It never touches an UPDATE. An existing employee whose payment type
 *     is NULL keeps it until a human records one; opening or editing their
 *     profile must not silently decide a payment route on their behalf.
 *     That is why this is exported for creates only.
 */
const { PAYMENT_TYPE } = require("../constants/employee_master_sections");

/**
 * The refusal, in the shape this codebase already refuses things in.
 *
 * `usecase/employee_master.js`, `usecase/employee_bank.js` and
 * `usecase/employee_aadhaar.js` each declare this same local class, and BOTH
 * employee routes turn `err.name === "ValidationError"` into
 * `{ code: 422, msg }` - the very same branch that renders a Joi failure. So
 * a refusal from here reaches the client identically to every other
 * validation refusal, and nothing new had to be wired to carry it.
 */
class ValidationError extends Error {
  constructor(message, code = 422) {
    super(message);
    this.name = "ValidationError";
    this.httpCode = code;
  }
}

/** The only two values the column has ever meant anything by. */
const VALID_PAYMENT_TYPES = [PAYMENT_TYPE.BANK, PAYMENT_TYPE.CASH];

/** The default for a create that does not say. */
const DEFAULT_PAYMENT_TYPE_ON_CREATE = PAYMENT_TYPE.CASH;

/**
 * Did the caller SAY anything about the payment route?
 *
 * `undefined`, `null` and a blank string are all "no" - they are the shapes
 * an unanswered form control, a stripped Joi key and a direct caller that
 * left the field out arrive in. Everything else is an answer, and is then
 * judged on whether it is a VALID one.
 */
function isPaymentTypeSupplied(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "string" && value.trim() === "") return false;
  return true;
}

/**
 * True when `value` is one of the two payment routes the backend recognises.
 *
 * Numeric strings count - the legacy screens post form values - but nothing
 * else does: not `0`, not `3`, not `1.5`, not `"bank"`, not an object or an
 * array. The column has only ever meant Bank or Cash.
 */
function isValidPaymentType(value) {
  if (!isPaymentTypeSupplied(value)) return false;
  if (typeof value !== "number" && typeof value !== "string") return false;
  const n = Number(value);
  return Number.isInteger(n) && VALID_PAYMENT_TYPES.includes(n);
}

/**
 * The payment type a create should store, given whatever it was handed.
 *
 *   not supplied      Cash. This is our default, and it is not an error.
 *   1 or 2            preserved, as a number.
 *   anything else     REFUSED, 422. An explicitly supplied value we do not
 *                     recognise is a bug or a bad input, never a licence to
 *                     substitute a route of our own choosing.
 */
function paymentTypeForCreate(value) {
  if (!isPaymentTypeSupplied(value)) return DEFAULT_PAYMENT_TYPE_ON_CREATE;
  if (!isValidPaymentType(value)) {
    throw new ValidationError(
      `payment_type must be ${PAYMENT_TYPE.BANK} (Bank) or ${PAYMENT_TYPE.CASH} (Cash); ` +
        `received ${JSON.stringify(value === undefined ? null : value)}`
    );
  }
  return Number(value);
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
  ValidationError,
  VALID_PAYMENT_TYPES,
  DEFAULT_PAYMENT_TYPE_ON_CREATE,
  isPaymentTypeSupplied,
  isValidPaymentType,
  paymentTypeForCreate,
  applyDefaultPaymentType,
};
