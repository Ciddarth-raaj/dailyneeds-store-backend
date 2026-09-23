/**
 * ONLY A CLOSED ATTENDANCE DATE IS PERSISTED BY A GENERAL RECALCULATION.
 *
 * ================================================================ WHY ======
 *
 * A stored `attendance_day_calculation` row is what every read returns for a
 * date once that date has CLOSED (`utils/attendance_stored_read.js`). A row
 * written while the date was still OPEN is a snapshot of a half-finished day,
 * and nothing replaced it when the rest of the day's punches arrived: the
 * direct Biomax receiver stores raw punches and deliberately recalculates
 * nothing. So the moment the date closed, the half-day snapshot became
 * "history". That is exactly how an employee with four LIVE punches read back
 * as a three-punch REVIEW_REQUIRED day: a manual month-wide run stored the date
 * at 12:41, the fourth punch arrived at 18:32, and the stored row won.
 *
 * ============================================================== THE RULE ===
 *
 * A general or manual recalculation may still be ASKED to cover an open or a
 * future date - a month-to-date range is the natural request - but it
 * persists only the dates that have closed, and it SAYS which dates it did not
 * persist. Open dates stay readable as LIVE_PREVIEW from the raw punches as
 * they stand, so nothing is hidden; it is only not frozen early.
 *
 * "Closed" is `isDayClosed` from `utils/attendance_dashboard.js`, evaluated
 * against the date's OWN resolved shift snapshot - the same predicate the
 * read path and the dashboard use - so there is one definition of an open day.
 * It is NOT `date < today`: a shift with an attendance-day cutoff owns punches
 * into the following morning, so YESTERDAY can still be open, and a date
 * whose shift cannot be resolved closes at its next midnight.
 *
 * PURE FUNCTIONS. No database and no clock of their own: the caller supplies
 * `now`, which is what lets every boundary be tested as arithmetic.
 */

const { addDays } = require("./attendance_engine");
const { isDayClosed, dayCloseMinute, IST_OFFSET_MINUTES } = require("./attendance_dashboard");
const { istDateOf } = require("./istDate");
const { toDateOnly } = require("./shiftResolution");

/** Why a date was not persisted. Reported, never silent. */
const SKIP_REASON = Object.freeze({
  // The attendance date has not even begun (IST).
  FUTURE_DATE: "FUTURE_DATE",
  // The date has begun (or is yesterday under an overnight cutoff) but its
  // attendance day has not reached its close.
  DAY_OPEN: "DAY_OPEN",
});

/**
 * The instant, as `YYYY-MM-DD HH:MM` IST, at which a date's attendance day
 * closes under this snapshot. Informational only - `isDayClosed` is the rule.
 */
function closesAt(attendanceDate, snapshot) {
  const date = toDateOnly(attendanceDate);
  if (date === null) return null;
  const minute = dayCloseMinute(snapshot || null);
  const dayOffset = Math.floor(minute / 1440);
  const rest = minute - dayOffset * 1440;
  const hh = String(Math.floor(rest / 60)).padStart(2, "0");
  const mm = String(rest % 60).padStart(2, "0");
  return `${addDays(date, dayOffset)} ${hh}:${mm}`;
}

/**
 * Split calculated days into the ones that may be persisted and the ones that
 * may not.
 *
 * Each day must carry `attendance_date` and the `shift_snapshot` it was
 * calculated under (every day `calculateRange` returns does). The closed ones
 * come back untouched and in order; every other date is reported with its
 * reason and the moment it will close.
 *
 * @param {object[]} days
 * @param {number|Date} now
 * @returns {{closed: object[], skipped: {attendance_date, reason, closes_at}[]}}
 */
function partitionClosedDays({ days = [], now = Date.now() } = {}) {
  const today = istDateOf(now instanceof Date ? now : Number(now));
  const closed = [];
  const skipped = [];
  (days || []).forEach((day) => {
    const date = toDateOnly(day && day.attendance_date);
    const snapshot = day ? day.shift_snapshot || null : null;
    if (date !== null && isDayClosed({ attendance_date: date, snapshot, now })) {
      closed.push(day);
      return;
    }
    skipped.push({
      attendance_date: date,
      reason: date !== null && today !== null && date > today ? SKIP_REASON.FUTURE_DATE : SKIP_REASON.DAY_OPEN,
      closes_at: closesAt(date, snapshot),
    });
  });
  return { closed, skipped };
}

/**
 * The latest attendance date that COULD have closed by some instant on
 * `today`: yesterday.
 *
 * Today can never be closed - a date closes at its following midnight at the
 * earliest (`dayCloseMinute` is never below 1440) - so no scope that feeds a
 * persisting recalculation needs to reach it. This is a BOUND on the
 * candidate dates, not the rule: whether yesterday itself has closed depends
 * on that employee's cutoff, and `partitionClosedDays` decides it per date.
 */
function latestClosableDate(today) {
  const date = toDateOnly(today);
  return date === null ? null : addDays(date, -1);
}

/**
 * An instant for a caller that pinned only a business DATE: the last minute
 * of that IST day. Every date before it whose cutoff has passed is closed,
 * and the date itself is still open - which is what "today" means.
 */
function endOfIstDay(date) {
  const d = toDateOnly(date);
  if (d === null) return null;
  return Date.parse(`${d}T23:59:59.999Z`) - IST_OFFSET_MINUTES * 60 * 1000;
}

module.exports = {
  SKIP_REASON,
  closesAt,
  partitionClosedDays,
  latestClosableDate,
  endOfIstDay,
};
