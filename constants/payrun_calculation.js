/**
 * Payrun Calculation & Review - the vocabulary the stage is written in.
 *
 * ONE PLACE FOR THE STRINGS THAT CROSS THE WIRE, exactly as
 * `constants/payrun.js` and `constants/payrun_adjustments.js` are. A status is
 * decided by a pure rule, stored on a row, counted in a summary, sent to a
 * browser and rendered on a badge; a blocker is read by the same rule and
 * rendered beside it. Both are the sort of value that gets spelled three
 * slightly different ways in three files, and then one of the three stops
 * matching.
 *
 * NOTHING HERE DECIDES ANYTHING. The rules are in
 * `utils/payrun_calculation.js` and they are pure; this file only names what
 * those rules may answer.
 */

/**
 * THE CALCULATION VERSION - bumped whenever a stored calculation would come
 * out differently from the same inputs.
 *
 * IT IS STORED ON EVERY ROW, for the reason `utils/attendance_payroll.js`
 * keeps its own: a month calculated by an older engine must be recognisable as
 * such, and "recalculate everything the day we change a formula" needs
 * something to compare against. It is deliberately NOT part of the source
 * hash - a formula change is not a source change, and conflating the two would
 * make every employee in every open month read as RECALCULATION_REQUIRED the
 * moment this number moves, including the ones already approved and locked.
 */
/*
 * 2: Net Pay is rounded to the whole rupee (half away from zero), with the
 * difference stored as `net_pay_rounding`. Rows calculated under version 1
 * keep their figures until somebody recalculates them.
 *
 * 3: PF is charged on the EFFECTIVE-DATED wage ceiling (15,000 up to
 * 16-09-2026, 25,000 from 17-09-2026), with September 2026 split into two
 * periods; EPS membership is tested on the uncapped Basic; EPS / EDLI wages,
 * EDLI, admin, NCP days and the ceiling version are stored. Rows calculated
 * under version 2 keep their figures until somebody recalculates them.
 */
const CALCULATION_VERSION = 3;

/**
 * THE STATE OF ONE EMPLOYEE'S CALCULATION, and the five values are exclusive
 * and ordered. `utils/payrun_calculation.js#deriveStatus` is the only thing
 * that may produce one.
 *
 *   NOT_CALCULATED           initialized, and nothing has been computed yet
 *   ATTENDANCE_PENDING       computed, but the attendance month it was computed
 *                            FROM is missing or not final, so the salary, OT
 *                            and statutory figures are provisional rather than
 *                            results. See below: this status exists so that a
 *                            provisional zero is never shown as a calculated
 *                            one.
 *   CALCULATED               computed, and something still stands between this
 *                            employee and approval - a pending adjustment
 *                            confirmation, a pending OT approval, a
 *                            regularization somebody has not decided
 *   RECALCULATION_REQUIRED   computed, but a SOURCE has moved since. The stored
 *                            figures are what they always were; what has
 *                            changed is that they no longer describe the
 *                            current salary, attendance, approved OT or NRM.
 *                            This employee cannot be approved until somebody
 *                            explicitly recalculates them.
 *   READY_FOR_APPROVAL       computed from current sources, with nothing
 *                            outstanding. See `READY_BLOCKER` for the full list
 *                            of what "nothing outstanding" means.
 *   APPROVED_LOCKED          approved. The employee's month is frozen: no
 *                            recalculation, no adjustment edit, no pay type
 *                            change, no salary refresh, no second approval.
 *
 * WHY `ATTENDANCE_PENDING` IS A STATUS AND NOT ONLY A BLOCKER.
 *
 * It was only a blocker, and the screen read CALCULATED, Salary Days 0, Net
 * Pay 0.00 for an employee whose attendance had never been settled. Every one
 * of those figures is arithmetic on an attendance month that does not exist
 * yet, so each zero was the engine's answer to a question nobody has asked -
 * and on a payroll review screen a zero is a statement that somebody earned
 * nothing. "Not known yet" and "nothing" are different facts about a person's
 * pay, and the screen has to say which one it means.
 *
 * IT REPLACES `CALCULATED` AND NOTHING ELSE. NOT_CALCULATED still wins (there
 * are no figures to qualify), RECALCULATION_REQUIRED still wins (the stored
 * figures are stale, which is the more urgent thing to say, and it is what an
 * attendance month turning final produces), and APPROVED_LOCKED cannot occur
 * with attendance outstanding because the approval gate refuses it.
 *
 * THE UNDERLYING CALCULATION IS UNTOUCHED. Nothing is deleted, no figure is
 * recomputed and no arithmetic changes: the row is stored exactly as the
 * engine produced it, and what changes is what the screen is willing to
 * present as a RESULT. The `attendance_pending` flag beside this status is
 * what the presentation layer suppresses figures from.
 *
 * THERE IS NO `PAID`, NO `PUBLISHED` AND NO `PAYSLIP_GENERATED`. Those are
 * later stages and are not built here; declaring their values now would put
 * states in the enum that nothing can reach and nothing can leave.
 */
const CALC_STATUS = {
  NOT_CALCULATED: "NOT_CALCULATED",
  ATTENDANCE_PENDING: "ATTENDANCE_PENDING",
  CALCULATED: "CALCULATED",
  RECALCULATION_REQUIRED: "RECALCULATION_REQUIRED",
  READY_FOR_APPROVAL: "READY_FOR_APPROVAL",
  APPROVED_LOCKED: "APPROVED_LOCKED",
  /*
   * PUBLISHED: approved, locked AND released for payslip / bank / downstream
   * use. NOT a stored status - it is APPROVED_LOCKED with `published_at` set,
   * so every lock that reads the stored status holds it exactly as firmly.
   */
  PUBLISHED: "PUBLISHED",
};

/** The two derived statuses that are locked. Use this, never one of them alone. */
const LOCKED_STATUSES = [CALC_STATUS.APPROVED_LOCKED, CALC_STATUS.PUBLISHED];
const isLockedStatus = (status) => LOCKED_STATUSES.includes(status);

/**
 * WHAT IS STORED IN THE DATABASE, which is a SMALLER SET than the statuses
 * above and deliberately so.
 *
 * ONLY TWO OF THE FIVE ARE FACTS ABOUT THE ROW. `CALCULATED` means a
 * calculation exists; `APPROVED_LOCKED` means somebody approved it. The other
 * three - not calculated, recalculation required, ready for approval - are
 * answers to "how does this row compare with the world RIGHT NOW", and the
 * world moves without anybody touching the row.
 *
 * STORING THEM WOULD MEAN A NIGHTLY JOB. A salary approved at 11pm has to turn
 * somebody into RECALCULATION_REQUIRED; a regularization decided this morning
 * has to turn somebody into READY_FOR_APPROVAL. Either the database is updated
 * by a sweep that runs on a timer - and is wrong in between - or the status is
 * computed when it is asked for, from the sources as they are at that instant.
 * The second is what this stage does, and it is why a stored status column
 * carries only the two values that cannot go stale.
 */
const STORED_STATUS = {
  CALCULATED: CALC_STATUS.CALCULATED,
  APPROVED_LOCKED: CALC_STATUS.APPROVED_LOCKED,
};

/** The compact badge label for each status. Read on a phone; keep them short. */
const CALC_STATUS_LABEL = {
  [CALC_STATUS.NOT_CALCULATED]: "Not calculated",
  /* Same words as Payrun Initialization's card. The rule is unchanged. */
  [CALC_STATUS.ATTENDANCE_PENDING]: "Attendance needs action",
  /*
   * CALCULATED IS "CALCULATED, NOT READY": a current calculation on accepted
   * attendance with at least one approval blocker still standing (see
   * `deriveStatus`). An employee with none is READY_FOR_APPROVAL instead, so
   * a bare "Calculated" read as if it were the stage before Ready - which is
   * why the screen's 223 and 220 looked unexplained.
   */
  [CALC_STATUS.CALCULATED]: "Calculated, not ready",
  [CALC_STATUS.RECALCULATION_REQUIRED]: "Recalculation required",
  [CALC_STATUS.READY_FOR_APPROVAL]: "Ready for approval",
  [CALC_STATUS.APPROVED_LOCKED]: "Approved & Locked",
  [CALC_STATUS.PUBLISHED]: "Payslip Published",
};

/**
 * WHY A RECALCULATION IS REQUIRED - which source moved, named rather than
 * counted.
 *
 * NAMED, BECAUSE "SOMETHING CHANGED" IS NOT ACTIONABLE. Somebody looking at
 * forty employees who have all gone stale needs to know whether a salary
 * revision landed, whether attendance was re-run, or whether an OT approval
 * came through overnight - those are three different conversations with three
 * different people.
 */
/**
 * THE CALCULATION & REVIEW SUMMARY CARDS - each one a filter, and each one's
 * membership decided by ONE function (`utils/payrun_calculation.js#inCard`)
 * that both the counts and the filter use, so a card's number and the rows it
 * opens cannot disagree.
 *
 *   ALL                      every initialized employee in scope
 *   ATTENDANCE_NEEDS_ACTION  not locked, and the attendance the month is (or
 *                            would be) priced from is neither settled nor
 *                            closed for payroll - `attendance_needs_action`.
 *                            OVERLAPS the payroll status: a Recalculation
 *                            Required or Not Calculated employee can be here
 *   CALCULATED               a CURRENT calculation on accepted attendance, not
 *                            yet approved: CALCULATED + READY_FOR_APPROVAL
 *   CALCULATED_NOT_READY     status CALCULATED: in Calculated, NOT approvable,
 *                            and every row carries its blockers
 *   RECALCULATION_REQUIRED / READY_FOR_APPROVAL / APPROVED_LOCKED / PUBLISHED
 *                            exactly that status
 */
const CALC_CARD = {
  ALL: "ALL",
  ATTENDANCE_NEEDS_ACTION: "ATTENDANCE_NEEDS_ACTION",
  CALCULATED: "CALCULATED",
  CALCULATED_NOT_READY: "CALCULATED_NOT_READY",
  RECALCULATION_REQUIRED: "RECALCULATION_REQUIRED",
  READY_FOR_APPROVAL: "READY_FOR_APPROVAL",
  APPROVED_LOCKED: "APPROVED_LOCKED",
  PUBLISHED: "PUBLISHED",
};

const RECALC_REASON = {
  SALARY_CHANGED: "SALARY_CHANGED",
  ATTENDANCE_CHANGED: "ATTENDANCE_CHANGED",
  APPROVED_OT_CHANGED: "APPROVED_OT_CHANGED",
  EFFECTIVE_NRM_CHANGED: "EFFECTIVE_NRM_CHANGED",
  STATUTORY_CONTEXT_CHANGED: "STATUTORY_CONTEXT_CHANGED",
  /**
   * THE ESI CONTRIBUTION-PERIOD BASIS MOVED, and it is its own code rather
   * than part of SALARY_CHANGED above. Coverage is decided from the approved
   * salary in force when the contribution period BEGAN - often a much older
   * record than the one pricing this month - so "a salary changed" would send
   * somebody to look in the wrong place.
   */
  ESI_COVERAGE_CHANGED: "ESI_COVERAGE_CHANGED",
  /*
   * THE PAYRUN'S OWN INPUTS, AND THEY ARE A SEPARATE CODE FROM THE FOUR ABOVE.
   * An adjustment or a pay type change is not a source mutating under a frozen
   * month - it is somebody deliberately editing this payrun - but the stored
   * net pay is stale either way, and approving a figure that no longer matches
   * the adjustments beside it is exactly the failure this stage exists to
   * prevent. So it requires a recalculation, and it says plainly that it was
   * the payrun and not the sources that moved.
   */
  ADJUSTMENTS_CHANGED: "ADJUSTMENTS_CHANGED",
  PAY_TYPE_CHANGED: "PAY_TYPE_CHANGED",
  CALCULATION_FAILED: "CALCULATION_FAILED",
};

const RECALC_REASON_LABEL = {
  [RECALC_REASON.SALARY_CHANGED]: "Salary changed",
  [RECALC_REASON.ATTENDANCE_CHANGED]: "Attendance recalculated",
  [RECALC_REASON.APPROVED_OT_CHANGED]: "Approved OT changed",
  [RECALC_REASON.EFFECTIVE_NRM_CHANGED]: "Effective NRM changed",
  [RECALC_REASON.STATUTORY_CONTEXT_CHANGED]: "Statutory setup changed",
  [RECALC_REASON.ESI_COVERAGE_CHANGED]: "ESI contribution period changed",
  [RECALC_REASON.ADJUSTMENTS_CHANGED]: "Adjustments changed",
  [RECALC_REASON.PAY_TYPE_CHANGED]: "Pay type changed",
  [RECALC_REASON.CALCULATION_FAILED]: "Calculation did not complete",
};

const RECALC_REASON_MESSAGE = {
  [RECALC_REASON.SALARY_CHANGED]:
    "The approved salary effective for this month is not the one this calculation used. Recalculate to take the current one.",
  [RECALC_REASON.ATTENDANCE_CHANGED]:
    "The attendance engine has re-run this month since this calculation. Recalculate to take the current attendance result.",
  [RECALC_REASON.APPROVED_OT_CHANGED]:
    "The approved OT for this month is not what this calculation used. Recalculate to take the current approved OT.",
  [RECALC_REASON.EFFECTIVE_NRM_CHANGED]:
    "The effective NRM attendance resolved for this employee has changed. Recalculate to price OT on the current one.",
  [RECALC_REASON.STATUTORY_CONTEXT_CHANGED]:
    "This employee's statutory setup (PF / ESI applicability, UAN, Previous PF / EPS Member, DOB, DOJ, PF coverage start or contribution basis) has changed since this calculation. Recalculate to apply the current setup; a change to PF / ESI applicability also needs the employee reset and re-initialised, because the month's snapshot holds it.",
  [RECALC_REASON.ESI_COVERAGE_CHANGED]:
    "The approved salary in force when this ESI contribution period began is not the one this calculation resolved coverage from. Recalculate to decide coverage on the current history.",
  [RECALC_REASON.ADJUSTMENTS_CHANGED]:
    "This employee's adjustments have been edited since this calculation. Recalculate so the net pay matches them.",
  [RECALC_REASON.PAY_TYPE_CHANGED]:
    "This month's pay type has been changed since this calculation. Recalculate to record it on the calculation.",
  [RECALC_REASON.CALCULATION_FAILED]:
    "The last calculation could not complete. Its reasons are on the employee's detail.",
};

/**
 * EVERYTHING THAT CAN STAND BETWEEN A CALCULATED EMPLOYEE AND APPROVAL.
 *
 * A CODE **AND** A MESSAGE, for the reason `constants/payrun.js` gives about
 * blocking reasons: the code is what a screen groups and a test asserts, the
 * message is what the person stopped on that row has to be able to act on.
 *
 * THE INITIALIZATION BLOCKERS ARE NOT RESTATED HERE. An employee who is not
 * initialized is not in this stage's population at all - they are not a state
 * of it - which is the same rule the adjustments stage keeps.
 */
const READY_BLOCKER = {
  NOT_CALCULATED: "NOT_CALCULATED",
  RECALCULATION_REQUIRED: "RECALCULATION_REQUIRED",
  ATTENDANCE_INCOMPLETE: "ATTENDANCE_INCOMPLETE",
  PENDING_ATTENDANCE_REGULARIZATION: "PENDING_ATTENDANCE_REGULARIZATION",
  PENDING_OT_APPROVAL: "PENDING_OT_APPROVAL",
  ADJUSTMENT_PENDING_CONFIRMATION: "ADJUSTMENT_PENDING_CONFIRMATION",
  STATUTORY_SETUP_INCOMPLETE: "STATUTORY_SETUP_INCOMPLETE",
  CALCULATION_INCOMPLETE: "CALCULATION_INCOMPLETE",
  ALREADY_LOCKED: "ALREADY_LOCKED",
};

const READY_BLOCKER_LABEL = {
  [READY_BLOCKER.NOT_CALCULATED]: "Not calculated",
  [READY_BLOCKER.RECALCULATION_REQUIRED]: "Recalculation required",
  [READY_BLOCKER.ATTENDANCE_INCOMPLETE]: "Attendance incomplete",
  [READY_BLOCKER.PENDING_ATTENDANCE_REGULARIZATION]: "Pending attendance request",
  [READY_BLOCKER.PENDING_OT_APPROVAL]: "Pending OT approval",
  [READY_BLOCKER.ADJUSTMENT_PENDING_CONFIRMATION]: "Adjustment not confirmed",
  [READY_BLOCKER.STATUTORY_SETUP_INCOMPLETE]: "Statutory setup incomplete",
  [READY_BLOCKER.CALCULATION_INCOMPLETE]: "Calculation incomplete",
  [READY_BLOCKER.ALREADY_LOCKED]: "Already approved",
};

const READY_BLOCKER_MESSAGE = {
  [READY_BLOCKER.NOT_CALCULATED]:
    "This employee's month has not been calculated yet.",
  [READY_BLOCKER.RECALCULATION_REQUIRED]:
    "A source has changed since this calculation. Recalculate this employee before approving them.",
  /*
   * IT COVERS BOTH CASES, AND IT USED TO NAME ONLY ONE. An attendance month
   * that was never calculated and one the engine held dates out of are the
   * same fact to this stage - the figures priced from it are provisional -
   * and the message said only the second, which read as wrong to anybody
   * looking at an employee whose attendance had simply never been run.
   */
  [READY_BLOCKER.ATTENDANCE_INCOMPLETE]:
    "Attendance for this month is not settled - it has either not been calculated yet, or the attendance engine has held dates out of it. The salary, overtime and statutory figures stay provisional until it is.",
  [READY_BLOCKER.PENDING_ATTENDANCE_REGULARIZATION]:
    "Pending attendance regularization for a date in this month.",
  [READY_BLOCKER.PENDING_OT_APPROVAL]:
    "Pending OT approval for a date in this month.",
  [READY_BLOCKER.ADJUSTMENT_PENDING_CONFIRMATION]:
    "The Adjustments stage is not complete for this employee - they are neither recorded as having an adjustment nor confirmed as having none.",
  [READY_BLOCKER.STATUTORY_SETUP_INCOMPLETE]:
    "Statutory setup incomplete - PF/ESI applicability or identifiers are missing.",
  [READY_BLOCKER.CALCULATION_INCOMPLETE]:
    "The calculation left a statutory figure unresolved. It is on the employee's detail and must be settled before approval.",
  [READY_BLOCKER.ALREADY_LOCKED]:
    "This employee's month is already approved and locked.",
};

/**
 * THE EFFECTIVE NRM'S PROVENANCE - the same two words
 * `attendance_day_calculation.break_allowance_source` uses, and deliberately
 * the same two, because this IS that column rolled up to a month.
 *
 * WHY IT TRAVELS WITH THE NUMBER. Two employees on the same shift with
 * different OT rates is a support call unless the row says why, and the only
 * legitimate reason is an employee-specific lunch/break override. The payrun
 * never reads the shift master to answer this: attendance already resolved the
 * employee-specific value and this stage consumes it.
 */
const NRM_SOURCE = {
  SHIFT: "SHIFT",
  EMPLOYEE_OVERRIDE: "EMPLOYEE_OVERRIDE",
};

/** Row-level outcome codes for the bulk actions. The screen keys off them. */
const ROW_RESULT = {
  CALCULATED: "CALCULATED",
  RECALCULATED: "RECALCULATED",
  APPROVED: "APPROVED",
  SKIPPED: "SKIPPED",
  BLOCKED: "BLOCKED",
  LOCKED: "LOCKED",
  NOT_IN_SCOPE: "NOT_IN_SCOPE",
  FAILED: "FAILED",
  RESET: "RESET",
  PROCESSED: "PROCESSED",
  UNLOCKED: "UNLOCKED",
  PUBLISHED: "PUBLISHED",
  UNPUBLISHED: "UNPUBLISHED",
  // Retry Notification: one more "payslip available" attempt queued for the worker.
  QUEUED: "QUEUED",
};

/** The lifecycle log's verbs (`payrun_employee_lifecycle_audit.action`). */
const LIFECYCLE_ACTION = {
  LOCK: "LOCK",
  UNLOCK: "UNLOCK",
  PUBLISH: "PUBLISH",
  UNPUBLISH: "UNPUBLISH",
};

/** The shortest reason Unlock and Unpublish accept. */
const LIFECYCLE_REASON_MIN = 5;

/** The calculation audit log's verbs. See the migration for why UNLOCK is here. */
const AUDIT_ACTION = {
  CALCULATE: "CALCULATE",
  RECALCULATE: "RECALCULATE",
  APPROVE_LOCK: "APPROVE_LOCK",
  UNLOCK: "UNLOCK",
};

/**
 * RESET CALCULATION - why somebody discarded an employee's calculated month.
 *
 * A CLOSED LIST, because a reset is a correction and the audit has to say what
 * was being corrected. OTHER is allowed only with a remark - enforced by the
 * route, the usecase AND a CHECK constraint on the audit table.
 */
const RESET_REASON = {
  ATTENDANCE_CORRECTED: "ATTENDANCE_CORRECTED",
  SALARY_MASTER_CORRECTED: "SALARY_MASTER_CORRECTED",
  WRONG_OT: "WRONG_OT",
  WRONG_ADDITION_DEDUCTION: "WRONG_ADDITION_DEDUCTION",
  OTHER: "OTHER",
};

const RESET_REASON_LABEL = {
  [RESET_REASON.ATTENDANCE_CORRECTED]: "Attendance corrected",
  [RESET_REASON.SALARY_MASTER_CORRECTED]: "Salary Master corrected",
  [RESET_REASON.WRONG_OT]: "Wrong OT",
  [RESET_REASON.WRONG_ADDITION_DEDUCTION]: "Wrong addition/deduction",
  [RESET_REASON.OTHER]: "Other",
};

/** Whether one row's action or a selection's. Recorded on every audit row. */
const RESET_MODE = {
  INDIVIDUAL: "INDIVIDUAL",
  BULK: "BULK",
};

/**
 * THE STATUSES A RESET MAY START FROM: every state in which a calculation
 * exists and nobody has approved it. NOT_CALCULATED has nothing to reset and
 * APPROVED_LOCKED is final - the repository refuses it again on the held row
 * lock, by allowing only the stored CALCULATED status.
 */
const RESETTABLE_STATUSES = [
  CALC_STATUS.ATTENDANCE_PENDING,
  CALC_STATUS.CALCULATED,
  CALC_STATUS.RECALCULATION_REQUIRED,
  CALC_STATUS.READY_FOR_APPROVAL,
];

/** The longest remark a reset may carry - the audit column's width. */
const RESET_REMARK_MAX = 500;

/** The most employees one calculate / recalculate / approve call may carry. */
const MAX_BULK_EMPLOYEES = 1000;

module.exports = {
  CALCULATION_VERSION,
  CALC_STATUS,
  STORED_STATUS,
  CALC_STATUS_LABEL,
  CALC_CARD,
  RECALC_REASON,
  RECALC_REASON_LABEL,
  RECALC_REASON_MESSAGE,
  READY_BLOCKER,
  READY_BLOCKER_LABEL,
  READY_BLOCKER_MESSAGE,
  NRM_SOURCE,
  ROW_RESULT,
  AUDIT_ACTION,
  MAX_BULK_EMPLOYEES,
  RESET_REASON,
  RESET_REASON_LABEL,
  RESET_MODE,
  RESETTABLE_STATUSES,
  RESET_REMARK_MAX,
  LOCKED_STATUSES,
  isLockedStatus,
  LIFECYCLE_ACTION,
  LIFECYCLE_REASON_MIN,
};
