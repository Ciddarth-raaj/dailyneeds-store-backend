const {
  PAY_TYPE,
  PAY_TYPE_SOURCE,
  STATUS_GROUP,
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
} = require("../constants/payrun");
const { PAYMENT_TYPE } = require("./payment_type");

/**
 * Payrun Initialization - WHETHER AN EMPLOYEE'S MONTH MAY BE INITIALIZED, and
 * what their pay type starts as.
 *
 * PURE, AND THAT IS THE POINT. Every function here takes plain values and
 * returns plain values: no database, no Express, no clock, no configuration
 * read at call time. The same reason `utils/attendance_payroll.js` is pure -
 * the rules that decide what payroll may do are the part that has to be
 * provable, and a rule that needs a MySQL connection to be exercised is a rule
 * that gets exercised once, by hand, in a browser.
 *
 * IT CALCULATES NO ATTENDANCE. There is no punch, no shift, no minute and no
 * day count in this file. Payroll CONSUMES what the attendance engine already
 * calculated and stored in `attendance_monthly_payroll` - this file reads
 * whether that row exists and whether it is final, and nothing else about it.
 * Re-deriving any of it here would be a second attendance answer, and the two
 * would disagree the first time a punch was regularized.
 *
 * IT DECIDES NO SALARY EITHER. The approved monthly gross is whatever M2's
 * effective-dated resolver said; this file reads whether one exists for the
 * month and refuses when it does not.
 *
 * THE ORDER THE REASONS COME BACK IN IS FIXED, so a screen listing them and a
 * test asserting them see the same list every time: employment, salary,
 * statutory, lock.
 *
 * ATTENDANCE IS NOT IN THAT LIST, AND HAS NOT BEEN SINCE THE RULE CHANGED.
 * An unsettled attendance month, an open regularization and an open OT
 * approval are reported as warnings here and refused at APPROVE & LOCK, by
 * `utils/payrun_calculation.js`. See `evaluateEmployee` below for why.
 */

/** `YYYY-MM-DD` or null, from a Date, a string, or anything unusable. */
function toDateOnly(value) {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString().slice(0, 10);
  }
  const m = String(value).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

/** Days in a calendar month. Computed, never a lookup table with a leap-year bug. */
function daysInMonth(year, month) {
  return new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
}

/** The first and last date of a payroll month, as `YYYY-MM-DD`. */
function monthWindow(year, month) {
  const pad = (n) => String(n).padStart(2, "0");
  return {
    from: `${year}-${pad(month)}-01`,
    to: `${year}-${pad(month)}-${pad(daysInMonth(year, month))}`,
  };
}

/**
 * WAS THIS PERSON EMPLOYED FOR ANY PART OF THE MONTH?
 *
 * ANY PART, not the whole of it - somebody who joined on the 28th and somebody
 * who left on the 2nd are both owed a payroll month, and a rule that demanded
 * the full month would silently drop every joiner and every leaver.
 *
 * AN UNKNOWN JOINING DATE IS NOT A REFUSAL HERE. `date_of_joining` is a legacy
 * VARCHAR that `utils/joining_date.js` parses and that is genuinely null for
 * some old records; treating null as "never employed" would block six hundred
 * people over a data-entry gap rather than a payroll fact. Null means the
 * window is open at that end.
 *
 * NEITHER BOUND READS `status`, for the reason `exitedByMonthEnd` gives below:
 * whether somebody was employed in August is answered by dates, and the
 * current master row cannot answer it.
 */
function employedInMonth({ year, month, joined_on = null, ended_on = null }) {
  const { from, to } = monthWindow(year, month);
  const joined = toDateOnly(joined_on);
  const ended = toDateOnly(ended_on);
  if (joined && joined > to) return false;
  if (ended && ended < from) return false;
  return true;
}

/**
 * IS THE PF/ESI SETUP COMPLETE ENOUGH TO INITIALIZE?
 *
 * WHAT "COMPLETE" MEANS, AND WHAT IT DELIBERATELY DOES NOT.
 *
 *   applicability must be ANSWERED. `pf_applicable` / `esi_applicable` are
 *   tri-state on purpose (1 yes, 0 no, NULL nobody has said) - see the M2
 *   migration. NULL is not "no": it is an unanswered statutory question, and a
 *   payroll month initialized on an unanswered question is a filing nobody
 *   decided.
 *
 *   an identifier is required only WHERE THE SCHEME APPLIES. PF applicable
 *   needs a UAN or a PF number; ESI applicable needs an ESI number. Somebody
 *   the scheme does not apply to needs neither, and demanding one would block
 *   every exempt employee forever.
 *
 * NOTHING IS CALCULATED HERE. This says whether the SETUP is complete; what is
 * contributed is `utils/salary_engine.js`'s and is not this stage's business.
 */
function statutorySetupComplete(employee = {}) {
  const answered = (v) => v === 0 || v === 1 || v === "0" || v === "1";
  const truthy = (v) => v === 1 || v === "1" || v === true;
  const present = (v) => v !== null && v !== undefined && String(v).trim() !== "";

  if (!answered(employee.pf_applicable)) return false;
  if (!answered(employee.esi_applicable)) return false;
  if (truthy(employee.pf_applicable) && !present(employee.uan) && !present(employee.pf_number)) {
    return false;
  }
  if (truthy(employee.esi_applicable) && !present(employee.esi_number)) return false;
  return true;
}

/**
 * THE PAY TYPE A NEWLY INITIALIZED ROW STARTS ON.
 *
 * THE EMPLOYEE MASTER DECIDES, AND NOTHING ELSE DOES.
 *
 *   master says BANK (1)   BANK
 *   master says CASH (2)   CASH
 *   master says nothing    CASH, the same default `utils/payment_type.js`
 *                          already applies at employee creation, so the two
 *                          places cannot disagree about what silence means.
 *
 * NO EMPLOYMENT FACT IS READ HERE - not the resignation date, not `status`,
 * not any lifecycle state - AND THE FUNCTION TAKES NO ARGUMENT THAT COULD
 * CARRY ONE. That is deliberate and structural rather than a matter of
 * discipline: this used to default a leaver to CASH automatically, and the
 * business decided against it. Somebody who has left is moved to CASH by a
 * person, for the month it applies to, when it actually applies - a final
 * settlement paid by bank transfer is perfectly ordinary, and a rule that
 * decided otherwise was quietly making a payment decision on HR's behalf.
 *
 * With the parameter gone there is no longer a shape for an employment fact
 * to arrive in, so this cannot regress by somebody passing one.
 *
 * IT IS A DEFAULT AND NEVER A VERDICT. Somebody may change it for the month
 * afterwards - see the monthly override in `usecase/payrun.js` - and changing
 * it changes that month and nothing else.
 */
function defaultPayType(employee = {}) {
  const n = Number(employee.payment_type);
  if (n === PAYMENT_TYPE.BANK) {
    return { pay_type: PAY_TYPE.BANK, pay_type_source: PAY_TYPE_SOURCE.EMPLOYEE_MASTER };
  }
  return { pay_type: PAY_TYPE.CASH, pay_type_source: PAY_TYPE_SOURCE.EMPLOYEE_MASTER };
}

/**
 * HAD THIS EMPLOYEE LEFT BY THE END OF THE MONTH BEING RUN?
 *
 * FOR DISPLAY, AND FOR DISPLAY ONLY. Nothing in the payrun's behaviour turns
 * on this answer: it does not decide the pay type (see `defaultPayType`, which
 * cannot even receive it), it does not block a month, and it is not stored.
 * The screen shows it as a badge so that whoever is working the month can see
 * at a glance who has left - which is exactly the person they may need to move
 * to CASH BY HAND, now that nothing does it for them. Removing the badge would
 * have made that manual step harder at the moment it became the only step.
 *
 * IT IS DATED, AND THAT MATTERS EVEN FOR A BADGE. A payrun is an
 * effective-dated monthly record, so the question is "had they left by the end
 * of THIS month", never "are they gone today". Reading the current `status`
 * here would put a Resigned badge on every past month of somebody who left
 * last week, which is the same class of error - the Employee Master rewriting
 * history - that the dated rule below exists to prevent.
 *
 *   exit date on or before the month end   had left by then
 *   exit date after the month end          had not - they were working
 *   no exit date at all                    had not. An undated exit cannot be
 *                                          placed in a month, and guessing
 *                                          would badge every earlier month
 *
 * WHICH EXIT DATE. `new_employee.resignation_date` - the same column the
 * attendance engine, the dashboard and `repository/payrun.js#listPopulation`
 * all read. `employee_employment_period` is the richer lifecycle record and
 * will be the right source eventually, but it is NOT consulted here for the
 * reason `repository/attendance_calculation.js#listEmployeesForRecalculation`
 * and `repository/attendance_dashboard.js#listApplicableEmployees` both state:
 * its C1b backfill still carries rows flagged `needs_review`. Moving off it is
 * a decision for all of payroll and attendance at once.
 */
function exitedByMonthEnd({ year, month, ended_on = null }) {
  const { to } = monthWindow(year, month);
  const ended = toDateOnly(ended_on);
  return Boolean(ended && ended <= to);
}

/**
 * A reason, in the three lengths the screens need.
 *
 *   code     what a test asserts and a filter could group on
 *   label    the compact business name, for a badge: "Attendance incomplete"
 *   message  the sentence that explains WHY, for somebody who has stopped on
 *            this row and wants to know what to go and fix
 *
 * BOTH STRINGS COME FROM `constants/payrun.js` AND NEITHER IS BUILT HERE. A
 * screen renders whichever length fits; it never composes its own.
 */
function reasonOf(code) {
  return {
    code,
    label: BLOCK_REASON_LABEL[code] || code,
    message: BLOCK_REASON_MESSAGE[code] || code,
  };
}

/**
 * THE WHOLE ELIGIBILITY DECISION FOR ONE EMPLOYEE'S MONTH.
 *
 * @param {object} input
 * @param {number} input.year, input.month      the payroll month
 * @param {object} input.employee               the master row - the dated
 *                                              employment facts, the statutory
 *                                              flags and `payment_type`. Its
 *                                              `status` is deliberately not
 *                                              read: see `exitedByMonthEnd`.
 * @param {object|null} input.salary            the APPROVED salary effective
 *                                              for the month, or null
 * @param {object|null} input.attendance        the stored
 *                                              `attendance_monthly_payroll`
 *                                              row, or null when the month has
 *                                              not been calculated. It does
 *                                              not block; it only decides a
 *                                              warning.
 * @param {number} input.pending_regularizations  count, for dates in the month
 * @param {number} input.pending_ot               count, for dates in the month
 * @param {boolean} input.month_locked
 * @param {object|null} input.existing            the payrun row if one exists
 *
 * @returns {{status: string, blocking_reasons: object[], warnings: object[],
 *            pay_type: string, pay_type_source: string, initialized: boolean}}
 */
function evaluateEmployee(input = {}) {
  const {
    year,
    month,
    employee = {},
    salary = null,
    attendance = null,
    pending_regularizations = 0,
    pending_ot = 0,
    month_locked = false,
    existing = null,
  } = input;

  /*
   * FOR THE BADGE ON THE SCREEN, AND FOR NOTHING ELSE. It is deliberately not
   * passed to `defaultPayType`, which takes no such argument: an employment
   * fact must not move a pay type. See `exitedByMonthEnd`.
   */
  const exitedInMonth = exitedByMonthEnd({
    year,
    month,
    ended_on: employee.resignation_date,
  });

  const reasons = [];

  if (!employedInMonth({
    year,
    month,
    joined_on: employee.date_of_joining,
    ended_on: employee.resignation_date,
  })) {
    reasons.push(reasonOf(BLOCK_REASON.NOT_EMPLOYED_IN_MONTH));
  }

  if (!salary || salary.monthly_gross === null || salary.monthly_gross === undefined) {
    reasons.push(reasonOf(BLOCK_REASON.SALARY_NOT_APPROVED));
  }

  /*
   * ATTENDANCE DOES NOT BLOCK INITIALIZATION. NOT A MISSING MONTH, NOT A
   * NON-FINAL ONE, NOT AN OPEN REGULARIZATION AND NOT AN OPEN OT APPROVAL.
   *
   * All four used to refuse here, and the refusal was in the wrong place.
   * Initializing takes the EMPLOYMENT and SALARY facts for a month; attendance
   * is not snapshotted as a figure at all, only as a REFERENCE to whatever the
   * engine had, and a later Recalculate is what takes a newer one. So a month
   * initialized while a regularization is open is not a wrong month - it is a
   * month that has not been calculated yet. Meanwhile the old rule meant a
   * single outstanding OT request kept an employee out of the payrun
   * altogether: nobody could start their month, adjust it, or see it.
   *
   * THE CHECK IS NOT GONE FROM THE LIFECYCLE - it moved to where it decides
   * money. `utils/payrun_calculation.js#evaluateApprovalReadiness` refuses
   * APPROVE & LOCK on all three, unchanged, and that is the gate that matters:
   * approval is the point at which a month stops being provisional. Between
   * the two, Calculation & Review runs on whatever finalized attendance exists
   * and reports the rest as pending or stale.
   *
   * THEY ARE STILL REPORTED, as WARNINGS. Silence would leave somebody to
   * discover at approval that the month was never settled.
   */
  const attendanceWarnings = [];
  if (!attendance || !(attendance.is_final === 1 || attendance.is_final === true)) {
    attendanceWarnings.push(WARNING.ATTENDANCE_INCOMPLETE);
  }
  if (Number(pending_regularizations) > 0) {
    attendanceWarnings.push(WARNING.PENDING_ATTENDANCE_REGULARIZATION);
  }
  if (Number(pending_ot) > 0) {
    attendanceWarnings.push(WARNING.PENDING_OT_APPROVAL);
  }

  if (!statutorySetupComplete(employee)) {
    reasons.push(reasonOf(BLOCK_REASON.STATUTORY_SETUP_INCOMPLETE));
  }

  if (month_locked) {
    reasons.push(reasonOf(BLOCK_REASON.MONTH_LOCKED));
  }

  const warnings = [];
  const bankMissing =
    !employee.account_no ||
    String(employee.account_no).trim() === "" ||
    !employee.ifsc ||
    String(employee.ifsc).trim() === "";
  if (bankMissing) {
    warnings.push({
      code: WARNING.BANK_DETAILS_MISSING,
      message: WARNING_MESSAGE[WARNING.BANK_DETAILS_MISSING],
    });
  }
  attendanceWarnings.forEach((code) => {
    warnings.push({ code, message: WARNING_MESSAGE[code] });
  });

  /*
   * AN INITIALIZED EMPLOYEE IS INITIALIZED. The snapshot has been taken; a
   * salary approved afterwards, or a regularization raised afterwards, does
   * not retrospectively un-initialize the month. The blocking reasons are
   * still reported, because they are what a Recalculate would have to deal
   * with, but they no longer decide the group.
   */
  if (existing) {
    return {
      status: STATUS_GROUP.INITIALIZED,
      blocking_reasons: reasons,
      warnings,
      pay_type: existing.pay_type,
      pay_type_source: existing.pay_type_source,
      initialized: true,
      exited_in_month: exitedInMonth,
    };
  }

  const { pay_type, pay_type_source } = defaultPayType(employee);
  return {
    status: reasons.length === 0 ? STATUS_GROUP.READY : STATUS_GROUP.BLOCKED,
    blocking_reasons: reasons,
    warnings,
    pay_type,
    pay_type_source,
    initialized: false,
    exited_in_month: exitedInMonth,
  };
}

/** The four counts the screen's summary cards show. */
function summarize(rows = []) {
  const summary = {
    total_eligible: 0,
    ready: 0,
    blocked: 0,
    initialized: 0,
    /*
     * ============ TWO DIMENSIONS, AND THE SUMMARY SAYS SO ==================
     *
     * `ready`, `blocked` and `initialized` are MUTUALLY EXCLUSIVE workflow
     * states: every eligible employee is in exactly one, and they add up to
     * `total_eligible`.
     *
     * THE TWO BELOW ARE NOT PART OF THAT SUM AND MUST NOT BE READ AS IF THEY
     * WERE. Attendance readiness is a different question from where somebody
     * has got to in the payrun, and the two genuinely overlap: an INITIALIZED
     * employee can be attendance-pending, which is the ordinary case at month
     * end and the whole reason Close for Payroll exists. Forcing them into one
     * exclusive list would mean either losing the workflow state or losing the
     * attendance fact, and a screen that added all five together would report
     * more employees than the month contains.
     *
     * So they are counted independently, named for the dimension they belong
     * to, and the screen labels them as such.
     */
    attendance_pending: 0,
    attendance_closed_for_payroll: 0,
  };
  rows.forEach((row) => {
    summary.total_eligible += 1;
    if (row.status === STATUS_GROUP.READY) summary.ready += 1;
    else if (row.status === STATUS_GROUP.BLOCKED) summary.blocked += 1;
    else if (row.status === STATUS_GROUP.INITIALIZED) summary.initialized += 1;

    if (row.attendance_status === ATTENDANCE_STATUS.PENDING) summary.attendance_pending += 1;
    else if (row.attendance_status === ATTENDANCE_STATUS.CLOSED_FOR_PAYROLL) {
      summary.attendance_closed_for_payroll += 1;
    }
  });
  return summary;
}

/* ============================ attendance readiness, for payroll's purposes */

/**
 * IS THE ATTENDANCE MONTH SETTLED - the one question, answered once.
 *
 * `attendance_monthly_payroll.is_final` is DERIVED by
 * `utils/attendance_payroll.js` as "no dates were held out", and a missing row
 * is not final either: there is nothing to pay from. Both are the same fact to
 * payroll and are answered together here so that no caller has to remember the
 * missing-row case.
 */
function attendanceIsFinal(attendance) {
  return Boolean(
    attendance && (attendance.is_final === 1 || attendance.is_final === true)
  );
}

/**
 * EVERYTHING ABOUT THIS EMPLOYEE'S ATTENDANCE THAT PAYROLL IS STILL WAITING
 * ON, named, counted, and with the dates where the engine named them.
 *
 * IT DERIVES NOTHING ABOUT ATTENDANCE and recomputes nothing. Every value
 * below is read from what the attendance engine already stored - `is_final`,
 * `held_dates` - or from the pending-request counts the payrun already reads
 * for its own warnings. There is no punch, no shift and no minute in this
 * function, because `usecase/attendance_calculation.js` owns those and a
 * second opinion here would be a second answer.
 *
 * THE DATES ARE CARRIED, NOT JUST THE COUNT. The engine stores WHICH dates it
 * held out, so the screen can link straight to each one rather than telling
 * somebody that two unnamed dates are wrong.
 */
function attendanceUnresolved({
  attendance = null,
  pending_regularizations = 0,
  pending_ot = 0,
} = {}) {
  const items = [];
  const heldDates = Array.isArray(attendance && attendance.held_dates)
    ? attendance.held_dates
    : [];

  const add = (code, count, dates = []) => {
    items.push({
      code,
      label: ATTENDANCE_UNRESOLVED_LABEL[code],
      message: ATTENDANCE_UNRESOLVED_MESSAGE[code],
      count,
      dates,
    });
  };

  if (!attendance) {
    add(ATTENDANCE_UNRESOLVED.NO_ATTENDANCE_MONTH, 1);
  } else if (!attendanceIsFinal(attendance)) {
    /*
     * THE HELD DATES ARE THE COUNT WHERE THERE ARE ANY. A month can be
     * non-final with an empty `held_dates` only if the stored row predates the
     * column; one unnamed item is the honest count there rather than zero,
     * which would read as "nothing is wrong".
     */
    add(
      ATTENDANCE_UNRESOLVED.ATTENDANCE_NOT_FINAL,
      heldDates.length > 0 ? heldDates.length : 1,
      heldDates
    );
  }

  const regularizations = Math.max(0, Math.trunc(Number(pending_regularizations) || 0));
  if (regularizations > 0) add(ATTENDANCE_UNRESOLVED.PENDING_REGULARIZATION, regularizations);

  const ot = Math.max(0, Math.trunc(Number(pending_ot) || 0));
  if (ot > 0) add(ATTENDANCE_UNRESOLVED.PENDING_OT, ot);

  return items;
}

/**
 * READY, PENDING, OR CLOSED FOR PAYROLL.
 *
 * THE ORDER OF THE THREE ANSWERS IS THE RULE. Settled attendance reads READY
 * whether or not anybody closed it, because that is the stronger statement and
 * the close has become irrelevant to it. Otherwise an explicit close reads
 * CLOSED_FOR_PAYROLL. Otherwise PENDING.
 *
 * A CLOSE IS NEVER INFERRED. Nothing here turns PENDING into CLOSED because a
 * month looks old, because a screen filtered for it, or because the unresolved
 * items are few: `closed_for_payroll` is a stored decision a person made, and
 * this function only reads it.
 */
function attendanceStatusOf({
  attendance = null,
  pending_regularizations = 0,
  pending_ot = 0,
  closed_for_payroll = false,
} = {}) {
  const unresolved = attendanceUnresolved({
    attendance,
    pending_regularizations,
    pending_ot,
  });

  const status =
    unresolved.length === 0
      ? ATTENDANCE_STATUS.READY
      : closed_for_payroll === true
      ? ATTENDANCE_STATUS.CLOSED_FOR_PAYROLL
      : ATTENDANCE_STATUS.PENDING;

  return {
    status,
    status_label: ATTENDANCE_STATUS_LABEL[status],
    unresolved,
    /*
     * THE COUNT THE CONFIRMATION DIALOG SHOWS. "32 employees selected, 41
     * unresolved attendance items" is built by summing this across a
     * selection, so it is computed once, here, rather than in a browser.
     */
    unresolved_count: unresolved.reduce((total, item) => total + item.count, 0),
    /*
     * WHETHER A CLOSE WOULD DO ANYTHING. False for a settled employee, which
     * is what makes bulk close skip them rather than writing an audit row
     * recording that nothing was accepted.
     */
    closeable: unresolved.length > 0 && closed_for_payroll !== true,
  };
}

module.exports = {
  toDateOnly,
  daysInMonth,
  monthWindow,
  employedInMonth,
  statutorySetupComplete,
  defaultPayType,
  exitedByMonthEnd,
  evaluateEmployee,
  summarize,
  attendanceIsFinal,
  attendanceUnresolved,
  attendanceStatusOf,
};
