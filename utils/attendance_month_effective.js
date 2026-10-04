/**
 * THE STORED MONTHLY SUMMARY, AS PAYROLL MUST READ IT: dates outside the
 * employment period - before the joining date, or after the last working
 * date - never hold a month.
 *
 * The upper side uses `available_to` exactly as the lower side uses
 * `available_from`: it is stored on the row by `availableDates`, the earlier
 * of the month's last day and `new_employee.resignation_date` (inclusive).
 *
 * WHY THIS EXISTS. `attendance_monthly_payroll.is_final` is derived by
 * `utils/attendance_payroll.js` as "no date was held out" (`held_dates` is
 * empty). Before the joining-date boundary was enforced, Process Attendance
 * calculated the dates BEFORE a mid-month joiner's joining date as
 * NO_SHIFT_FOR_DATE, held them, and stored the summary with `is_final = 0`.
 * Re-processing the month now repairs that row - but payroll must not depend
 * on somebody remembering to re-process. A stored summary is read here with
 * the same boundary the engine applies today.
 *
 * THE BOUNDARY IS THE SUMMARY'S OWN. `available_from` is stored on the row
 * by the same calculation (`availableDates`): the later of the month's first
 * day and the joining date. A held date BEFORE it is a pre-joining date by
 * that row's own account - no second read of the employee, and no second
 * parse of the joining-date text, is needed or made. A whole-month employee
 * has `available_from` = the 1st, so nothing of theirs can ever be dropped.
 *
 * WHAT IT CHANGES, EXACTLY. Only a row stored NON-final whose held dates ALL
 * fall before `available_from` is read as final - `is_final` was derived as
 * "nothing held", and with the pre-joining dates removed nothing is. A row
 * with any held date on or after `available_from` is left non-final, exactly
 * as stored. Every amount, day count and minute on the row is untouched: the
 * pre-joining dates already contributed nothing to them (a held date adds no
 * shortage or OT, and `available_dates` / `base_days` were bounded by the
 * joining date). The row in the database is not modified.
 *
 * PURE. No database, no clock.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseHeldDates(value) {
  if (Array.isArray(value)) return value.map(String);
  if (value === null || value === undefined || value === "") return [];
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.map(String) : null;
  } catch (err) {
    return null;
  }
}

const isFinalFlag = (v) => v === 1 || v === true || v === "1";

/**
 * @param {object|null} row  an `attendance_monthly_payroll` row carrying
 *        `is_final`, `held_dates` and `available_from`
 * @returns {object|null} the same row, with `is_final` corrected where only
 *          pre-joining dates held it, and `pre_joining_held_dates` naming them
 */
function effectiveAttendanceMonth(row) {
  if (!row || isFinalFlag(row.is_final)) return row;
  const bound = (v) => {
    const d = v ? String(v).slice(0, 10) : null;
    return d && DATE_RE.test(d) ? d : null;
  };
  const from = bound(row.available_from);
  const to = bound(row.available_to);
  if (!from && !to) return row;
  const held = parseHeldDates(row.held_dates);
  // Unreadable or empty: nothing can be PROVEN outside employment, so
  // nothing changes.
  if (!held || held.length === 0) return row;

  const preJoining = from ? held.filter((d) => DATE_RE.test(d) && d < from) : [];
  const postExit = to ? held.filter((d) => DATE_RE.test(d) && d > to) : [];
  if (preJoining.length + postExit.length !== held.length) return row;

  return {
    ...row,
    is_final: 1,
    pre_joining_held_dates: preJoining,
    post_exit_held_dates: postExit,
  };
}

module.exports = { effectiveAttendanceMonth, parseHeldDates };
