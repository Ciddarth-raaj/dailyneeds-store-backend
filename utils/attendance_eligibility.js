/**
 * THE ONE RULE for "does this employee take part in attendance on this date".
 *
 * Three exclusions, and they are all here because they were previously three
 * half-rules in three files:
 *
 *   1. `attendance_required = 0`   the employee is exempt from biometric
 *                                  attendance entirely - active and paid, but
 *                                  never expected to punch;
 *   2. the date is AFTER their resignation date;
 *   3. the date is BEFORE their joining date.
 *
 * Any one of them excludes the employee/date. Nothing else does: `status` is
 * NOT consulted anywhere in this file, for the reason
 * `repository/attendance_calculation.js` records at length - it is maintained
 * by hand and has been left at 1 for most leavers, so reading it would let
 * people who left years ago back into the population. Only the dated facts
 * decide.
 *
 * WHY A SHARED MODULE. The recalculation had the joining bound in the bulk
 * usecase, the resignation bound in the repository's SQL and the
 * attendance_required check only inside the engine call - so the single-employee
 * endpoint and the bulk run disagreed about who was eligible, and neither
 * agreed with the dashboard, which had a fourth copy (`applicableOn`). One
 * rule, called from every path, is what keeps "recalculated", "shown on the
 * dashboard" and "stored" describing the same set.
 *
 * PURE. No database, no clock, no I/O. Dates are `YYYY-MM-DD` strings, or
 * anything `toDateOnly` can read; an ABSENT or UNREADABLE bound is treated as
 * unbounded on that side, which is deliberate - 425 of the production rows
 * carry no readable joining date and excluding them would empty attendance
 * rather than correct it.
 */

const { toDateOnly } = require("./shiftResolution");

/**
 * Whether biometric attendance is expected of this employee.
 *
 * ABSENT OR NULL IS TRUE. The column is NOT NULL with DEFAULT 1, so the only
 * way to arrive here without a value is a caller that did not select it, and
 * "not asked" must never silently exempt somebody from attendance.
 */
function attendanceRequired(row) {
  if (!row) return true;
  const v = row.attendance_required;
  if (v === undefined || v === null) return true;
  return Number(v) === 1 || v === true;
}

/**
 * The employment bounds on a row, whichever shape it arrived in.
 *
 * `joined_on` is what the dashboard's query names the PARSED joining date;
 * `date_of_joining` is the master column. Either is accepted so one rule can
 * read both queries' rows without either of them re-shaping first.
 */
function joiningDateOf(employee) {
  if (!employee) return null;
  const parsed = toDateOnly(employee.joined_on);
  return parsed !== null ? parsed : toDateOnly(employee.date_of_joining);
}

function resignationDateOf(employee) {
  if (!employee) return null;
  const parsed = toDateOnly(employee.resignation_date);
  return parsed !== null ? parsed : toDateOnly(employee.ended_on);
}

/**
 * Exclusions 2 and 3 alone: was this person employed here on this date.
 *
 * KNOWN LIMITATION, carried over rather than invented here: `new_employee`
 * holds ONE joining date and ONE resignation date, so a resign-then-rejoin
 * GAP is not modelled. `employee_employment_period` is the right source
 * eventually; its backfill still carries rows flagged needs_review, so this
 * reads the columns payroll reads.
 */
function employedOn(employee, date) {
  const on = toDateOnly(date);
  if (on === null) return false;
  const joined = joiningDateOf(employee);
  if (joined !== null && on < joined) return false;
  const resigned = resignationDateOf(employee);
  if (resigned !== null && on > resigned) return false;
  return true;
}

/** All three exclusions. True means this employee/date participates. */
function eligibleOn(employee, date) {
  if (!attendanceRequired(employee)) return false;
  return employedOn(employee, date);
}

/**
 * Whether the employee can participate on ANY date of a range - the cheap
 * test a bulk run uses to skip somebody before loading their punches.
 */
function eligibleInRange(employee, fromDate, toDate) {
  const from = toDateOnly(fromDate);
  const to = toDateOnly(toDate);
  if (from === null || to === null || from > to) return false;
  if (!attendanceRequired(employee)) return false;
  const joined = joiningDateOf(employee);
  if (joined !== null && joined > to) return false;
  const resigned = resignationDateOf(employee);
  if (resigned !== null && resigned < from) return false;
  return true;
}

/**
 * The part of `[from, to]` this employee is eligible for, clamped to their
 * employment, or `null` when no date of the range qualifies.
 *
 * This is what a recalculation runs over. Clamping rather than filtering
 * matters: a date before somebody joined is not a day they were absent, it is
 * a day they did not work here, and calculating it stored a NO_SHIFT_FOR_DATE
 * row that looks like attendance and is not.
 */
function eligibleWindow(employee, fromDate, toDate) {
  const from = toDateOnly(fromDate);
  const to = toDateOnly(toDate);
  if (from === null || to === null || from > to) return null;
  if (!attendanceRequired(employee)) return null;

  const joined = joiningDateOf(employee);
  const resigned = resignationDateOf(employee);
  const start = joined !== null && joined > from ? joined : from;
  const end = resigned !== null && resigned < to ? resigned : to;
  if (start > end) return null;
  return { from: start, to: end };
}

/** Why an employee/date was excluded, for the audit line. Null when eligible. */
function exclusionReason(employee, date) {
  if (!attendanceRequired(employee)) return "ATTENDANCE_NOT_REQUIRED";
  const on = toDateOnly(date);
  if (on === null) return "INVALID_DATE";
  const joined = joiningDateOf(employee);
  if (joined !== null && on < joined) return "BEFORE_JOINING_DATE";
  const resigned = resignationDateOf(employee);
  if (resigned !== null && on > resigned) return "AFTER_RESIGNATION_DATE";
  return null;
}

module.exports = {
  attendanceRequired,
  joiningDateOf,
  resignationDateOf,
  employedOn,
  eligibleOn,
  eligibleInRange,
  eligibleWindow,
  exclusionReason,
};
