/**
 * Payrun Initialization - the vocabulary the whole feature is written in.
 *
 * ONE PLACE FOR THE STRINGS THAT CROSS THE WIRE. A blocking reason is read by
 * the eligibility rules, stored nowhere, sent to the browser and rendered on a
 * screen; a pay type is read from the Employee Master, defaulted, stored and
 * audited. Both are the sort of value that gets spelled three slightly
 * different ways in three files, and then one of the three stops matching.
 *
 * NOTHING HERE DECIDES ANYTHING. The rules are in `utils/payrun_eligibility.js`
 * and they are pure; this file only names what those rules may answer.
 */

/**
 * THE MONTHLY PAY TYPE, AND WHY IT IS A WORD RATHER THAN A NUMBER.
 *
 * `new_employee.payment_type` is 1 (Bank) / 2 (Cash) - a legacy encoding that
 * `utils/payment_type.js` owns and that this feature does not get to
 * reinterpret. The payrun record stores BANK / CASH as words because the
 * payrun row is read by people looking at a payroll month, and a column that
 * says `2` needs a lookup table in somebody's head.
 *
 * THERE IS NO `HOLD`. Holding somebody's pay is a payroll STATUS - a decision
 * not to pay this month - and not a route the money travels by. Putting it in
 * this enum would mean a held employee has no recorded payment route at all,
 * and the day the hold is lifted nobody would know whether to pay them by bank
 * or in cash. Hold belongs to a later stage and gets its own column.
 */
const PAY_TYPE = {
  BANK: "BANK",
  CASH: "CASH",
};

const PAY_TYPES = [PAY_TYPE.BANK, PAY_TYPE.CASH];

/**
 * WHERE A PAYRUN ROW'S PAY TYPE CAME FROM. Stored on the row, because "Cash"
 * alone does not say whether somebody chose it, whether it was inherited from
 * the Employee Master, or whether it is the resigned-employee default.
 */
const PAY_TYPE_SOURCE = {
  EMPLOYEE_MASTER: "EMPLOYEE_MASTER",
  RESIGNED_DEFAULT: "RESIGNED_DEFAULT",
  MANUAL: "MANUAL",
};

/** The payrun row's own status. Only one value exists at this stage. */
const PAYRUN_STATUS = {
  INITIALIZED: "INITIALIZED",
};

/** The month's status. A month with no `payrun_period` row is OPEN. */
const PERIOD_STATUS = {
  OPEN: "OPEN",
  LOCKED: "LOCKED",
};

/**
 * THE THREE GROUPS A MONTH'S EMPLOYEES FALL INTO, and they are exclusive in
 * this order: an INITIALIZED employee is initialized whatever else is true of
 * them today, because the snapshot has already been taken; of the rest, one
 * with any blocking reason is BLOCKED and one with none is READY.
 */
const STATUS_GROUP = {
  READY: "READY",
  BLOCKED: "BLOCKED",
  INITIALIZED: "INITIALIZED",
};

/**
 * EVERY REASON AN EMPLOYEE MAY NOT BE INITIALIZED, as a code and the sentence
 * that goes with it.
 *
 * A CODE **AND** A MESSAGE, because they answer to different readers. The code
 * is what a screen may group, count or filter on and what a test asserts; the
 * message is what the person looking at the row has to be able to act on. A
 * screen that had to build the sentence itself would be a second place for the
 * rules to live, and the two would drift.
 *
 * MISSING BANK DETAILS IS DELIBERATELY NOT HERE. Somebody with no bank account
 * is paid in cash, which is exactly what the pay type on the row is for; it is
 * a payment-readiness question for a later stage, and blocking initialization
 * on it would stop a month being calculated over a fact that does not change
 * a single figure in it.
 */
const BLOCK_REASON = {
  NOT_EMPLOYED_IN_MONTH: "NOT_EMPLOYED_IN_MONTH",
  SALARY_NOT_APPROVED: "SALARY_NOT_APPROVED",
  ATTENDANCE_INCOMPLETE: "ATTENDANCE_INCOMPLETE",
  PENDING_ATTENDANCE_REGULARIZATION: "PENDING_ATTENDANCE_REGULARIZATION",
  PENDING_OT_APPROVAL: "PENDING_OT_APPROVAL",
  STATUTORY_SETUP_INCOMPLETE: "STATUTORY_SETUP_INCOMPLETE",
  MONTH_LOCKED: "MONTH_LOCKED",
};

const BLOCK_REASON_MESSAGE = {
  [BLOCK_REASON.NOT_EMPLOYED_IN_MONTH]:
    "Not employed during any part of this month",
  [BLOCK_REASON.SALARY_NOT_APPROVED]:
    "Salary not approved - no approved salary is effective for this month",
  [BLOCK_REASON.ATTENDANCE_INCOMPLETE]:
    "Attendance incomplete - this month has not been calculated by the attendance engine",
  [BLOCK_REASON.PENDING_ATTENDANCE_REGULARIZATION]:
    "Pending attendance regularization for a date in this month",
  [BLOCK_REASON.PENDING_OT_APPROVAL]:
    "Pending OT approval for a date in this month",
  [BLOCK_REASON.STATUTORY_SETUP_INCOMPLETE]:
    "Statutory setup incomplete - PF/ESI applicability or identifiers are missing",
  [BLOCK_REASON.MONTH_LOCKED]:
    "Month locked - this payroll month has been locked and cannot be initialized",
};

/**
 * WARNINGS. Reported on the row, never blocking, and this is the whole of the
 * difference between the two lists: a blocking reason stops the month being
 * initialized, a warning is something somebody will have to deal with before
 * the money moves.
 */
const WARNING = {
  BANK_DETAILS_MISSING: "BANK_DETAILS_MISSING",
};

const WARNING_MESSAGE = {
  [WARNING.BANK_DETAILS_MISSING]:
    "Bank details are missing. This does not block initialization; it is a payment readiness issue.",
};

module.exports = {
  PAY_TYPE,
  PAY_TYPES,
  PAY_TYPE_SOURCE,
  PAYRUN_STATUS,
  PERIOD_STATUS,
  STATUS_GROUP,
  BLOCK_REASON,
  BLOCK_REASON_MESSAGE,
  WARNING,
  WARNING_MESSAGE,
};
