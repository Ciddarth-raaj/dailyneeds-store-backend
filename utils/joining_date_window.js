const { istToday } = require("./istDate");

/**
 * THE JOINING-DATE ENTRY WINDOW - a joining date that is being RECORDED must
 * fall within 30 calendar days either side of today's business date.
 *
 *   today 2026-10-04   earliest 2026-09-04   latest 2026-11-03
 *
 * WHY. A joining date is typed by a person, and the costly typo is the year:
 * employee 2298 joined on 03/10/2026 and was entered as 03/10/2006, which is
 * a perfectly valid date and so passed every check - and put him into
 * payroll months he never worked. A hire is recorded around the day they
 * start, so a date more than a month away in either direction is far more
 * likely to be a typo than a fact.
 *
 * IT JUDGES A DATE BEING WRITTEN, NEVER A DATE ALREADY STORED. Employees who
 * joined years ago are legitimate, and opening one of them, or saving an
 * unrelated field on them, must not fail because their stored date is old.
 * Every caller applies this only when creating an employee or when the
 * joining date itself is CHANGING - `joiningDateChanged` below is the one
 * definition of "changing".
 *
 * CALENDAR DATES IN IST, NEVER TIMESTAMPS. "Today" is `utils/istDate.js`'s
 * business date, and the window is computed by whole-day arithmetic on
 * `YYYY-MM-DD` strings in UTC - so neither the server's zone nor the hour of
 * the request can move a bound by a day. Comparing ISO dates as text is exact
 * because they are fixed-width and zero-padded.
 */

const JOINING_DATE_WINDOW_DAYS = 30;

const JOINING_DATE_ERROR = Object.freeze({
  TOO_EARLY: "Joining date cannot be more than 30 days before today.",
  TOO_LATE: "Joining date cannot be more than 30 days after today.",
  INVALID: "Joining date must be a real calendar date as YYYY-MM-DD.",
  REASON_REQUIRED:
    "A correction reason of at least 10 characters is required for a historical joining-date correction.",
});

/**
 * THE ONE EXCEPTION, AND ONLY TO THE PAST. A joining date older than the
 * window may be recorded by the dedicated joining-date correction (singly,
 * or through bulk update) when the caller holds
 * `employee_joining_date_historical_correction` AND states a reason - for a
 * genuine old date, or for filling in one of the legacy employees who have
 * none. Create and rejoin have no exception. A date beyond today + 30 has no
 * exception anywhere: a historical correction corrects history.
 */
const CORRECTION_REASON_MIN = 10;
const CORRECTION_REASON_MAX = 500;

/** The trimmed reason if it is a usable one, else null. */
function correctionReason(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (text.length < CORRECTION_REASON_MIN || text.length > CORRECTION_REASON_MAX) return null;
  return text;
}

/** `YYYY-MM-DD` if `text` is exactly a real calendar date, else null. */
function strictIsoDate(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const [y, m, d] = text.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return text;
}

/** A stored joining date (DATE, Date object or text) as `YYYY-MM-DD`, or null. */
function storedIsoDate(value) {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    // A DATE column read without `dateStrings` arrives as LOCAL midnight, so
    // the local parts are the stored calendar date.
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(
      value.getDate()
    ).padStart(2, "0")}`;
  }
  const m = String(value).trim().match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

/** Whole-day arithmetic on a `YYYY-MM-DD`, in UTC so no zone can shift it. */
function addDays(iso, days) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

/** The inclusive bounds for a business date (default: today in IST). */
function joiningDateWindow(today = istToday()) {
  const base = strictIsoDate(today);
  if (!base) throw new Error(`joiningDateWindow needs a YYYY-MM-DD business date, not '${today}'`);
  return {
    earliest: addDays(base, -JOINING_DATE_WINDOW_DAYS),
    latest: addDays(base, JOINING_DATE_WINDOW_DAYS),
  };
}

/**
 * Null when `value` may be recorded as a joining date today, else the refusal
 * `{ code, message }`. Both bounds are INCLUSIVE.
 */
function checkJoiningDateWindow(value, today = istToday()) {
  const date = strictIsoDate(value);
  if (!date) return { code: "INVALID", message: JOINING_DATE_ERROR.INVALID };
  const { earliest, latest } = joiningDateWindow(today);
  if (date < earliest) return { code: "TOO_EARLY", message: JOINING_DATE_ERROR.TOO_EARLY };
  if (date > latest) return { code: "TOO_LATE", message: JOINING_DATE_ERROR.TOO_LATE };
  return null;
}

/**
 * IS THE JOINING DATE ACTUALLY CHANGING? The one definition every edit path
 * uses, so an unchanged historical date resent with an unrelated edit is
 * never judged. Blank and NULL are the same "no date"; a stored date in any
 * shape is compared as its calendar date.
 */
function joiningDateChanged(submitted, stored) {
  const blank = (v) => v === null || v === undefined || String(v).trim() === "";
  if (blank(submitted) && blank(stored)) return false;
  if (blank(submitted) || blank(stored)) return true;
  const a = strictIsoDate(submitted) || String(submitted).trim();
  return a !== storedIsoDate(stored);
}

module.exports = {
  JOINING_DATE_WINDOW_DAYS,
  JOINING_DATE_ERROR,
  CORRECTION_REASON_MIN,
  CORRECTION_REASON_MAX,
  correctionReason,
  strictIsoDate,
  storedIsoDate,
  joiningDateWindow,
  checkJoiningDateWindow,
  joiningDateChanged,
};
