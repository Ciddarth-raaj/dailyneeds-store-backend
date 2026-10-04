/**
 * Payrun Initialization - THE 3-DAY ABSENT REVIEW: who was absent on the last
 * three applicable attendance days of the payroll month.
 *
 * A WARNING FOR HR AND NOTHING ELSE. It marks nobody exited, blocks nobody,
 * moves no pay type and writes nothing. Somebody absent on the last three
 * working days may simply be absent, may be on an exception nobody has keyed
 * yet, or may have left without HR recording it - and only a person can tell
 * which. The list exists so that person looks before payroll is run.
 *
 * PURE, AND IT CALCULATES NO ATTENDANCE. Every day it reads is a row the
 * attendance engine already stored in `attendance_day_calculation`; the
 * verdict on each date (ABSENT, present, rest day, no shift...) is the
 * engine's. This file only walks those stored verdicts backwards from the end
 * of the month. Re-deriving presence from punches here would be a second
 * attendance answer.
 *
 * NOT THE LAST THREE CALENDAR DATES. A date counts only when the employee was
 * EXPECTED to attend it, according to what the engine stored:
 *
 *   rest day      the shift's weekly schedule says `is_working_day = 0` for
 *                 that date (the engine's REST_DAY). This is the system's only
 *                 weekly-off concept - there is no holiday or leave table.
 *   not required  ATTENDANCE_NOT_REQUIRED - exempt from biometric attendance
 *   no shift      NO_SHIFT_FOR_DATE / NO_SCHEDULE_ROW - nobody can say what
 *                 they were rostered for, so it is not evidence of absence
 *   not joined    NOT_JOINED (never stored, but skipped if it ever is)
 *   no row        the engine has not calculated that date
 *
 * Those dates are SKIPPED - they neither count as an absence nor break the run.
 *
 * WHAT BREAKS THE RUN. Any applicable date that is not a settled ABSENT: a day
 * with attendance (including a rest day that was worked), a pending
 * regularization, or anything the engine still has under review. An absence
 * that somebody has claimed is not yet an absence.
 */

const REVIEW_DAYS = 3;

/** Statuses the engine stores for a date nobody was expected to attend. */
const NOT_EXPECTED = new Set([
  "ATTENDANCE_NOT_REQUIRED",
  "NO_SHIFT_FOR_DATE",
  "NO_SCHEDULE_ROW",
  "NOT_JOINED",
]);

/** `true` / `false` / `null` from whatever the JSON column handed back. */
function workingFlag(value) {
  if (value === null || value === undefined || value === "" || value === "null") return null;
  if (value === true || value === 1 || value === "1" || value === "true") return true;
  if (value === false || value === 0 || value === "0" || value === "false") return false;
  return null;
}

function present(day) {
  return Number(day.attendance_day_count) > 0 || Number(day.punch_count) > 0;
}

/**
 * Was the employee expected to attend this stored date at all?
 *
 * A Present/Absent Only date has no shift and so no roster: the engine treats
 * every such date as one to attend (it stores ABSENT on a date with no punch),
 * and so does this.
 */
function applicable(day) {
  if (NOT_EXPECTED.has(day.status)) return false;
  if (day.attendance_calculation_mode === "PRESENT_ABSENT_ONLY") return true;
  return workingFlag(day.is_working_day) === true;
}

/**
 * One employee's stored month, read backwards from its last date.
 *
 * @param {object[]} days  stored day rows: attendance_date (YYYY-MM-DD),
 *                         status, punch_count, attendance_day_count,
 *                         attendance_calculation_mode, is_working_day
 * @returns {{three_day_absent: boolean, absent_dates: string[],
 *            last_present_date: string|null}}
 *          `absent_dates` are the applicable absent dates found at the end of
 *          the month, oldest first; `last_present_date` is the latest date in
 *          these rows with any attendance.
 */
function absenceReview(days = [], { required = REVIEW_DAYS } = {}) {
  const ordered = (days || [])
    .filter((d) => d && d.attendance_date)
    .slice()
    .sort((a, b) => (a.attendance_date < b.attendance_date ? 1 : -1));

  const lastPresent = ordered.find(present);
  const absent = [];

  for (const day of ordered) {
    if (absent.length >= required) break;
    if (present(day)) break;
    if (!applicable(day)) continue;
    if (day.status !== "ABSENT") break;
    absent.push(day.attendance_date);
  }

  return {
    three_day_absent: absent.length >= required,
    absent_dates: absent.slice().reverse(),
    last_present_date: lastPresent ? lastPresent.attendance_date : null,
  };
}

module.exports = {
  REVIEW_DAYS,
  absenceReview,
  applicable,
  workingFlag,
};
