const {
  PAY_TYPE,
  PAY_TYPE_SOURCE,
  STATUS_GROUP,
  BLOCK_REASON,
  BLOCK_REASON_MESSAGE,
  WARNING,
  WARNING_MESSAGE,
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
 * attendance, regularization, OT, statutory, lock.
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
 * window is open at that end, and the employee's `status` still applies.
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
 *   resigned / exited      CASH, whatever the master says. A closed bank
 *                          account is the ordinary case for somebody who has
 *                          left, and a transfer that bounces is a person
 *                          chasing their final pay.
 *   otherwise              whatever the EMPLOYEE MASTER says - 1 Bank, 2 Cash.
 *   master says nothing    CASH, the same default `utils/payment_type.js`
 *                          already applies at employee creation, so the two
 *                          places cannot disagree about what silence means.
 *
 * IT IS A DEFAULT AND NEVER A VERDICT. Somebody may change it for the month
 * afterwards, and changing it changes this month and nothing else.
 */
function defaultPayType(employee = {}, { resigned = false } = {}) {
  if (resigned) {
    return { pay_type: PAY_TYPE.CASH, pay_type_source: PAY_TYPE_SOURCE.RESIGNED_DEFAULT };
  }
  const n = Number(employee.payment_type);
  if (n === PAYMENT_TYPE.BANK) {
    return { pay_type: PAY_TYPE.BANK, pay_type_source: PAY_TYPE_SOURCE.EMPLOYEE_MASTER };
  }
  return { pay_type: PAY_TYPE.CASH, pay_type_source: PAY_TYPE_SOURCE.EMPLOYEE_MASTER };
}

/** Has this employee left on or before the end of the month being run? */
function resignedForMonth({ year, month, ended_on = null, status = null }) {
  const { to } = monthWindow(year, month);
  const ended = toDateOnly(ended_on);
  if (ended && ended <= to) return true;
  // `status` 1 is employed; anything else is not - the same reading
  // `repository/employee.js` records for that column.
  return status !== null && status !== undefined && Number(status) !== 1;
}

/** A reason code paired with the sentence a person reads. */
function reasonOf(code) {
  return { code, message: BLOCK_REASON_MESSAGE[code] || code };
}

/**
 * THE WHOLE ELIGIBILITY DECISION FOR ONE EMPLOYEE'S MONTH.
 *
 * @param {object} input
 * @param {number} input.year, input.month      the payroll month
 * @param {object} input.employee               the master row (status, dates,
 *                                              statutory flags, payment_type)
 * @param {object|null} input.salary            the APPROVED salary effective
 *                                              for the month, or null
 * @param {object|null} input.attendance        the stored
 *                                              `attendance_monthly_payroll`
 *                                              row, or null when the month has
 *                                              not been calculated
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

  const resigned = resignedForMonth({
    year,
    month,
    ended_on: employee.resignation_date,
    status: employee.status,
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
   * ATTENDANCE IS CONSUMED, NEVER RECOMPUTED. The month must have been
   * calculated AND stored by the attendance engine, and the stored row must be
   * FINAL - `is_final` is false exactly when the engine held dates out because
   * their punch list is known to be incomplete (see `utils/attendance_payroll.js`).
   * An employee exempt from biometric attendance still gets a stored row, and
   * that row is final, so the exemption needs no special case here.
   */
  if (!attendance) {
    reasons.push(reasonOf(BLOCK_REASON.ATTENDANCE_INCOMPLETE));
  } else if (!(attendance.is_final === 1 || attendance.is_final === true)) {
    reasons.push(reasonOf(BLOCK_REASON.ATTENDANCE_INCOMPLETE));
  }

  if (Number(pending_regularizations) > 0) {
    reasons.push(reasonOf(BLOCK_REASON.PENDING_ATTENDANCE_REGULARIZATION));
  }

  /*
   * ONLY APPROVED OT EVER ENTERS PAYROLL, which is already true of the stored
   * month - the engine holds unsettled OT out of it. This refusal is the other
   * half of that rule: a month is not initialized while somebody's OT decision
   * is still outstanding, because taking the snapshot now would freeze a month
   * that is about to change.
   */
  if (Number(pending_ot) > 0) {
    reasons.push(reasonOf(BLOCK_REASON.PENDING_OT_APPROVAL));
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
      resigned,
    };
  }

  const { pay_type, pay_type_source } = defaultPayType(employee, { resigned });
  return {
    status: reasons.length === 0 ? STATUS_GROUP.READY : STATUS_GROUP.BLOCKED,
    blocking_reasons: reasons,
    warnings,
    pay_type,
    pay_type_source,
    initialized: false,
    resigned,
  };
}

/** The four counts the screen's summary cards show. */
function summarize(rows = []) {
  const summary = { total_eligible: 0, ready: 0, blocked: 0, initialized: 0 };
  rows.forEach((row) => {
    summary.total_eligible += 1;
    if (row.status === STATUS_GROUP.READY) summary.ready += 1;
    else if (row.status === STATUS_GROUP.BLOCKED) summary.blocked += 1;
    else if (row.status === STATUS_GROUP.INITIALIZED) summary.initialized += 1;
  });
  return summary;
}

module.exports = {
  toDateOnly,
  daysInMonth,
  monthWindow,
  employedInMonth,
  statutorySetupComplete,
  defaultPayType,
  resignedForMonth,
  evaluateEmployee,
  summarize,
};
