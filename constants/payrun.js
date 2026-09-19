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
 * alone does not say whether somebody chose it for this month or whether it
 * was inherited from the Employee Master.
 *
 * TWO VALUES, AND THERE IS DELIBERATELY NO THIRD. There was a
 * `RESIGNED_DEFAULT` while initialization moved leavers to CASH automatically;
 * the business decided against that, so the value is gone rather than left
 * declared and unreachable. A leaver's month now starts on whatever the
 * Employee Master says, and a person moves it - which records itself as
 * MANUAL, with an audit row, exactly like any other change.
 */
const PAY_TYPE_SOURCE = {
  EMPLOYEE_MASTER: "EMPLOYEE_MASTER",
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
 * THE EMPLOYEE LIFECYCLE FILTER - a SEPARATE question from the payrun status
 * above, and the separation is the whole point of it.
 *
 *   STATUS     what the PAYRUN says about this employee's month: are they
 *              ready, blocked, or already initialized
 *   LIFECYCLE  what the EMPLOYMENT RECORD says: had they left by the end of
 *              this month, or were they still working
 *
 * They are independent, so every combination is a real question somebody asks:
 * "exited and still blocked" is the leaver whose month nobody can close;
 * "exited and initialized" is the list whose pay type may need moving to CASH
 * by hand, which is the reason this filter was asked for.
 *
 * EXITED IS DATED, AND IT IS THE SAME DATED ANSWER THE BADGE USES. It means
 * `exited_in_month` - had they left by the END OF THE SELECTED MONTH - and
 * never the employee master's current `status`. Somebody who resigned last
 * week is ACTIVE in every month before that one, and a filter that read
 * today's status would hide them from their own August payrun. See
 * `utils/payrun_eligibility.js#exitedByMonthEnd`.
 */
const LIFECYCLE_FILTER = {
  ALL: "ALL",
  ACTIVE: "ACTIVE",
  EXITED: "EXITED",
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
 *
 * NEITHER IS ANYTHING ABOUT ATTENDANCE, AND THAT IS THE POINT OF THIS LIST
 * NOW. Attendance not yet final, an outstanding regularization and an
 * outstanding OT approval used to be three of these codes, and they are not
 * any more: initialization is the moment somebody's EMPLOYMENT and SALARY
 * facts are taken for a month, and holding six hundred people out of a payrun
 * because two of them have an OT request open stopped the month starting at
 * all. They are reported as WARNINGS below, and they remain HARD GATES where
 * they decide money - `constants/payrun_calculation.js#READY_BLOCKER` refuses
 * Approve & Lock on all three, unchanged.
 *
 * WHAT IS LEFT HERE IS WHAT INITIALIZATION ITSELF CANNOT PROCEED WITHOUT: a
 * person employed in the month, an approved salary to snapshot, a statutory
 * setup complete enough to file on, and a month that is not already locked.
 */
const BLOCK_REASON = {
  NOT_EMPLOYED_IN_MONTH: "NOT_EMPLOYED_IN_MONTH",
  SALARY_NOT_APPROVED: "SALARY_NOT_APPROVED",
  STATUTORY_SETUP_INCOMPLETE: "STATUTORY_SETUP_INCOMPLETE",
  MONTH_LOCKED: "MONTH_LOCKED",
};

/**
 * THE COMPACT LABEL FOR EACH REASON - what a screen puts on a badge.
 *
 * TWO STRINGS PER REASON, AND THEY ANSWER DIFFERENT QUESTIONS. The LABEL is
 * the business name of the blocker, and it is what somebody scanning a list of
 * forty employees needs: "Salary not approved", not a sentence about an
 * effective-dated resolver. The MESSAGE below explains WHY that blocker exists, and it is what
 * somebody needs once they have stopped on one row and want to know what to go
 * and fix.
 *
 * WHY THE LABEL IS SERVER-SIDE RATHER THAN A LOOKUP IN THE BROWSER. The set of
 * reasons is this module's vocabulary. A screen that mapped codes to its own
 * labels would be a second copy of that vocabulary, and the day a reason is
 * added the screen renders a bare code - or worse, nothing - for a blocker
 * nobody notices is missing. The server already says what is wrong; it now
 * says it in both lengths, and the screen chooses which to show where.
 *
 * KEEP THEM SHORT AND NOUN-LIKE. These are read on a badge on a phone.
 */
const BLOCK_REASON_LABEL = {
  [BLOCK_REASON.NOT_EMPLOYED_IN_MONTH]: "Not employed this month",
  [BLOCK_REASON.SALARY_NOT_APPROVED]: "Salary not approved",
  [BLOCK_REASON.STATUTORY_SETUP_INCOMPLETE]: "Statutory setup incomplete",
  [BLOCK_REASON.MONTH_LOCKED]: "Month locked",
};

const BLOCK_REASON_MESSAGE = {
  [BLOCK_REASON.NOT_EMPLOYED_IN_MONTH]:
    "Not employed during any part of this month",
  [BLOCK_REASON.SALARY_NOT_APPROVED]:
    "Salary not approved - no approved salary is effective for this month",
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
 *
 * THE THREE ATTENDANCE WARNINGS ARE WHERE THE OLD BLOCKERS WENT. Saying
 * nothing at all about an unsettled month would be worse than blocking it: the
 * person working the payrun would initialize, calculate, and only discover at
 * Approve & Lock that attendance was never final. So the fact is still
 * reported on the row, in a list that cannot stop anybody - and the refusal
 * that matters still happens at approval, where the money is committed.
 */
const WARNING = {
  BANK_DETAILS_MISSING: "BANK_DETAILS_MISSING",
  ATTENDANCE_INCOMPLETE: "ATTENDANCE_INCOMPLETE",
  PENDING_ATTENDANCE_REGULARIZATION: "PENDING_ATTENDANCE_REGULARIZATION",
  PENDING_OT_APPROVAL: "PENDING_OT_APPROVAL",
};

const WARNING_MESSAGE = {
  [WARNING.BANK_DETAILS_MISSING]:
    "Bank details are missing. This does not block initialization; it is a payment readiness issue.",
  [WARNING.ATTENDANCE_INCOMPLETE]:
    "Attendance for this month has not been calculated and settled by the attendance engine. The month may still be initialized; Approve & Lock will refuse until it is final.",
  [WARNING.PENDING_ATTENDANCE_REGULARIZATION]:
    "A regularization request for a date in this month is still outstanding. The month may still be initialized; Approve & Lock will refuse until it is decided.",
  [WARNING.PENDING_OT_APPROVAL]:
    "An OT approval for a date in this month is still outstanding. The month may still be initialized; Approve & Lock will refuse until it is decided.",
};

/**
 * ================== IS THIS EMPLOYEE'S ATTENDANCE READY FOR PAYROLL? =======
 *
 * THREE STATES, AND THEY ARE ABOUT PAYROLL READINESS RATHER THAN ABOUT
 * ATTENDANCE'S OWN OPINION OF ITSELF.
 *
 *   READY               the attendance month is final AND nothing about it is
 *                       still outstanding. Approve & Lock will not refuse on
 *                       attendance grounds.
 *   PENDING             something is unsettled - the month is not final, or a
 *                       regularization or an OT approval is still open. The
 *                       employee may still be initialized, adjusted and
 *                       calculated; only Approve & Lock refuses.
 *   CLOSED_FOR_PAYROLL  something was unsettled and a person holding
 *                       `close_payrun_attendance` decided to pay on the
 *                       attendance as it stood. The underlying requests are
 *                       untouched and still open; what changed is that payroll
 *                       accepted the consequence.
 *
 * WHY READY IS NOT SIMPLY `is_final`, WHICH IS THE TRAP HERE.
 * `utils/attendance_engine.js` states that a day's attendance state and its OT
 * claim state are SEPARATE: a complete, valid day is FINAL whether or not its
 * candidate overtime has been approved. So an employee can be `is_final = 1`
 * and still carry a pending OT approval that Approve & Lock refuses on. A
 * READY badge derived from `is_final` alone would therefore promise something
 * the approval gate goes on to deny - which is the whole failure this column
 * exists to prevent. All three signals decide it.
 *
 * CLOSED_FOR_PAYROLL WINS OVER PENDING, and that is the point of it. It does
 * NOT win over READY: an employee whose attendance genuinely settled after
 * being closed reads READY, because that is the stronger and truer statement.
 */
const ATTENDANCE_STATUS = {
  READY: "READY",
  PENDING: "PENDING",
  CLOSED_FOR_PAYROLL: "CLOSED_FOR_PAYROLL",
};

const ATTENDANCE_STATUS_LABEL = {
  [ATTENDANCE_STATUS.READY]: "Ready",
  [ATTENDANCE_STATUS.PENDING]: "Pending",
  [ATTENDANCE_STATUS.CLOSED_FOR_PAYROLL]: "Closed for payroll",
};

/**
 * WHAT IS UNRESOLVED, NAMED RATHER THAN COUNTED INTO ONE NUMBER.
 *
 * "3 unresolved items" sends somebody looking in three places. These four say
 * WHICH place, and the screen turns each into a link to the attendance screen
 * that can actually settle it.
 */
const ATTENDANCE_UNRESOLVED = {
  NO_ATTENDANCE_MONTH: "NO_ATTENDANCE_MONTH",
  ATTENDANCE_NOT_FINAL: "ATTENDANCE_NOT_FINAL",
  PENDING_REGULARIZATION: "PENDING_REGULARIZATION",
  PENDING_OT: "PENDING_OT",
};

const ATTENDANCE_UNRESOLVED_LABEL = {
  [ATTENDANCE_UNRESOLVED.NO_ATTENDANCE_MONTH]: "Attendance not calculated",
  [ATTENDANCE_UNRESOLVED.ATTENDANCE_NOT_FINAL]: "Attendance month not final",
  [ATTENDANCE_UNRESOLVED.PENDING_REGULARIZATION]: "Pending regularization",
  [ATTENDANCE_UNRESOLVED.PENDING_OT]: "Pending OT approval",
};

/** What each unresolved item means, and what settling it would take. */
const ATTENDANCE_UNRESOLVED_MESSAGE = {
  [ATTENDANCE_UNRESOLVED.NO_ATTENDANCE_MONTH]:
    "The attendance engine has not calculated this month for this employee, so there are no attendance figures to pay from yet.",
  [ATTENDANCE_UNRESOLVED.ATTENDANCE_NOT_FINAL]:
    "The attendance engine held dates out of this month because their punch list is incomplete. Their shortage and overtime are not in the payroll figures.",
  [ATTENDANCE_UNRESOLVED.PENDING_REGULARIZATION]:
    "A regularization request for a date in this month has not been decided. Until it is, that date is not settled.",
  [ATTENDANCE_UNRESOLVED.PENDING_OT]:
    "An OT approval for a date in this month has not been decided. Only approved OT is ever paid, so the amount can still change.",
};

/**
 * THE OUTCOME OF ONE EMPLOYEE'S CLOSE, in the same shape every other payrun
 * bulk action reports - so that one employee and forty report identically.
 */
const CLOSE_RESULT = {
  CLOSED: "CLOSED",
  ALREADY_CLOSED: "ALREADY_CLOSED",
  NOTHING_TO_CLOSE: "NOTHING_TO_CLOSE",
  LOCKED: "LOCKED",
  MONTH_LOCKED: "MONTH_LOCKED",
  NOT_IN_SCOPE: "NOT_IN_SCOPE",
  FAILED: "FAILED",
};

const CLOSE_RESULT_MESSAGE = {
  [CLOSE_RESULT.CLOSED]: "Attendance closed for payroll.",
  [CLOSE_RESULT.ALREADY_CLOSED]:
    "Attendance was already closed for payroll for this month. Nothing was changed.",
  [CLOSE_RESULT.NOTHING_TO_CLOSE]:
    "This employee's attendance is already settled, so there is nothing to close.",
  [CLOSE_RESULT.LOCKED]:
    "This employee's payroll month is approved and locked. Nothing about it can be changed.",
  [CLOSE_RESULT.MONTH_LOCKED]: "This payroll month is locked.",
  [CLOSE_RESULT.NOT_IN_SCOPE]:
    "This employee has no initialized payrun for the month, or is outside your branch scope.",
  [CLOSE_RESULT.FAILED]: "This employee's attendance could not be closed.",
};

module.exports = {
  PAY_TYPE,
  PAY_TYPES,
  PAY_TYPE_SOURCE,
  PAYRUN_STATUS,
  PERIOD_STATUS,
  STATUS_GROUP,
  LIFECYCLE_FILTER,
  BLOCK_REASON,
  BLOCK_REASON_LABEL,
  BLOCK_REASON_MESSAGE,
  WARNING,
  WARNING_MESSAGE,
  ATTENDANCE_STATUS,
  ATTENDANCE_STATUS_LABEL,
  ATTENDANCE_UNRESOLVED,
  ATTENDANCE_UNRESOLVED_LABEL,
  ATTENDANCE_UNRESOLVED_MESSAGE,
  CLOSE_RESULT,
  CLOSE_RESULT_MESSAGE,
};
