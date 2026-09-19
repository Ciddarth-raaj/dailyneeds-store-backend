/**
 * MISSING ATTENDANCE - THE ONE RULE, in one place.
 *
 * A record is Missing Attendance when, and only when, ALL FOUR hold:
 *
 *   1. the employee/date is ELIGIBLE for attendance at all
 *      (`utils/attendance_eligibility.js#eligibleOn` - attendance_required,
 *      joining date, resignation date). This file does NOT restate those
 *      three exclusions; it calls the module that owns them.
 *   2. the attendance date is a COMPLETED PAST attendance date: strictly
 *      before today's IST business date. Today and every future date are out.
 *   3. `punch_count > 0`          zero punches is ABSENCE, a different thing
 *                                 with a different remedy, and it is not
 *                                 reported here.
 *   4. `punch_count` is ODD       an odd count means exactly one punch of a
 *                                 pair never arrived. This is the SAME
 *                                 arithmetic `utils/attendance_engine.js`
 *                                 already applies when it returns
 *                                 REVIEW_REASON.MISSING_PUNCH; the engine
 *                                 owns what the day is WORTH, this owns who
 *                                 gets REPORTED and CHASED.
 *
 * WHY A MODULE AND NOT A `WHERE` CLAUSE IN A REPORT. Two consumers exist from
 * day one - the Missing Attendance Report a human opens, and the 06:00
 * Telegram job that messages the employee - and the whole point of the
 * feature is that they name the SAME people. A rule written twice is a rule
 * that disagrees with itself the first time either copy is edited, and the
 * failure would be silent and personal: somebody chased for a day the report
 * does not show, or a day on the report that nobody is ever asked to correct.
 * `usecase/attendance_missing.js` is the only place the population is built,
 * and it builds it from the predicates below; the Telegram candidate query is
 * that same usecase with `from = to = yesterday`.
 *
 * NO HARD-CODED 1/3/5. `isOddPunchCount` is `n % 2 === 1`, so 7, 9 and 101
 * behave like 1 without anybody adding them to a list.
 *
 * PURE. No database, no clock, no I/O. `today` is passed in, because the
 * business date is IST (`utils/istDate.js`) and a module that read the
 * process clock could not be tested and would silently use the server's zone.
 * Dates are `YYYY-MM-DD`.
 */

const { toDateOnly } = require("./shiftResolution");
const { addDays } = require("./attendance_engine");
const eligibility = require("./attendance_eligibility");

/** What the Status column says. One string, so the screen and the export agree. */
const MISSING_ATTENDANCE_STATUS = "Missing Attendance";

/** Why a candidate/date was rejected. Null when it IS missing attendance. */
const EXCLUSION = Object.freeze({
  NOT_ELIGIBLE: "NOT_ELIGIBLE",
  DATE_NOT_COMPLETED: "DATE_NOT_COMPLETED",
  NO_PUNCHES: "NO_PUNCHES",
  EVEN_PUNCH_COUNT: "EVEN_PUNCH_COUNT",
});

/**
 * Condition 4 alone: an odd number of punches.
 *
 * Deliberately strict about what a count is. `Number(null)` and `Number("")`
 * are both 0 and `Number("3x")` is NaN; none of those is a punch count, and
 * treating an unreadable value as 0 would quietly say "absent" about a day
 * nobody measured. An unreadable count is NOT odd and NOT positive, so such a
 * day is excluded by both tests rather than reported either way.
 */
function punchCountOf(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const truncated = Math.trunc(n);
  return truncated < 0 ? null : truncated;
}

function isOddPunchCount(value) {
  const n = punchCountOf(value);
  return n !== null && n % 2 === 1;
}

/** Conditions 3 and 4 together - the arithmetic half of the rule. */
function isMissingPunchCount(value) {
  const n = punchCountOf(value);
  return n !== null && n > 0 && n % 2 === 1;
}

/**
 * THE LATEST ATTENDANCE DATE THIS FEATURE MAY EVER REPORT: yesterday.
 *
 * TODAY IS NEVER INCLUDED, and this is not a nicety. An attendance day that
 * has not closed is still being punched into: somebody who has clocked IN and
 * not yet OUT has exactly one punch, which is an odd count, and reporting it
 * would tell a working employee that their attendance is broken while they
 * are standing at the counter. The same day is correct by the evening. So the
 * window ends at the last COMPLETED date, and a caller cannot widen it.
 *
 * `today` is the IST business date (`utils/istDate.js#istToday`), never a UTC
 * one: at 01:00 IST the UTC date is still yesterday's, and a UTC boundary
 * would let today's half-finished day onto the report for five and a half
 * hours every night.
 */
function latestReportableDate(today) {
  const on = toDateOnly(today);
  return on === null ? null : addDays(on, -1);
}

/** The date this feature means by "yesterday" - the 06:00 job's whole window. */
const yesterdayOf = latestReportableDate;

/** Condition 2 alone: has this attendance date completed? */
function isCompletedAttendanceDate(date, today) {
  const on = toDateOnly(date);
  const latest = latestReportableDate(today);
  if (on === null || latest === null) return false;
  return on <= latest;
}

/**
 * The requested range, CLAMPED to what may be reported, or null when nothing
 * of it may be.
 *
 * Clamping rather than refusing: "From 1 Sep To 19 Sep" on the 19th is an
 * ordinary thing to type and means "everything up to now", so it yields the
 * 1st to the 18th rather than an error. A range that lies WHOLLY in the
 * future or wholly on today yields null - there is genuinely nothing to show,
 * and the caller says so rather than showing an empty table that looks like
 * "nobody missed a punch".
 */
function clampToReportable({ from, to, today }) {
  const start = toDateOnly(from);
  const requestedEnd = toDateOnly(to);
  const latest = latestReportableDate(today);
  if (start === null || requestedEnd === null || latest === null) return null;
  const end = requestedEnd > latest ? latest : requestedEnd;
  if (start > end) return null;
  return { from: start, to: end, clamped: end !== requestedEnd, latest_reportable_date: latest };
}

/**
 * THE WHOLE RULE, for one employee on one date with one computed day.
 *
 * `employee` is a row carrying `attendance_required` and the two dated
 * employment facts - whatever shape the query produced, because
 * `attendance_eligibility` already reads both shapes.
 *
 * `day.punch_count` is the EFFECTIVE punch count: what the calculation
 * engine counted after voided punches were removed and duplicates ignored,
 * and after approved regularized punches joined. It is never a raw count of
 * device frames - a double-tap at the same minute is one punch, and counting
 * it twice would flip an odd day to even and hide a real missing punch.
 *
 * Returns the exclusion reason, or null when the day IS Missing Attendance.
 */
function exclusionReason({ employee, date, day, today }) {
  if (!eligibility.eligibleOn(employee, date)) return EXCLUSION.NOT_ELIGIBLE;
  if (!isCompletedAttendanceDate(date, today)) return EXCLUSION.DATE_NOT_COMPLETED;
  const count = punchCountOf(day ? day.punch_count : null);
  if (count === null || count === 0) return EXCLUSION.NO_PUNCHES;
  if (count % 2 === 0) return EXCLUSION.EVEN_PUNCH_COUNT;
  return null;
}

/** The predicate form of `exclusionReason`. This is what both consumers call. */
function isMissingAttendance({ employee, date, day, today }) {
  return exclusionReason({ employee, date, day, today }) === null;
}

module.exports = {
  MISSING_ATTENDANCE_STATUS,
  EXCLUSION,
  punchCountOf,
  isOddPunchCount,
  isMissingPunchCount,
  latestReportableDate,
  yesterdayOf,
  isCompletedAttendanceDate,
  clampToReportable,
  exclusionReason,
  isMissingAttendance,
};
