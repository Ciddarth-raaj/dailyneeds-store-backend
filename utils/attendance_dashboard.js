/**
 * Attendance Dashboard - the PURE part.
 *
 * NO DATABASE, NO EXPRESS, NO CLOCK READ HERE. Every function takes what it
 * needs, including `now`, so the whole of the dashboard's classification is
 * arithmetic that can be tested without MySQL and without waiting for a
 * particular time of day.
 *
 * THIS FILE CALCULATES NOTHING ABOUT ATTENDANCE. `utils/attendance_engine.js`
 * remains the calculation source of truth: worked minutes, shortage, OT and
 * the day's `status` are its answers, and this file only ever READS a day the
 * engine has already produced and decides which bucket it is displayed in.
 * There is no second engine here and no rule that could make the dashboard
 * disagree with the Employee Attendance screen about the same date.
 *
 * WHY AN OPEN DAY NEEDS ITS OWN VOCABULARY. The engine answers a settled
 * question - "what happened on this attendance date" - and it answers it the
 * same way whether the date is last March or this afternoon. A management
 * dashboard for TODAY is asking a different question, and three of its
 * answers do not exist in the engine's vocabulary at all:
 *
 *   - somebody whose shift has not started yet is not absent, and the engine
 *     would say ABSENT because nobody has punched;
 *   - somebody whose shift started an hour ago and has not punched is not
 *     confirmed absent either - the day is still open and they may walk in;
 *   - somebody who punched IN and has not punched OUT has an ODD punch count,
 *     which the engine reports as MISSING_PUNCH, and on an ongoing shift that
 *     is simply a person who is still at work.
 *
 * So every bucket below is decided from the engine's status TOGETHER WITH the
 * shift's own clock: when the shift started, and when the attendance day
 * closes. `ABSENT` and `MISSING_PUNCH` are only ever reported once the
 * relevant attendance day has CLOSED. Before that they are reported as the
 * open-day states they actually are.
 *
 * THE ATTENDANCE DAY BOUNDARY IS THE SHIFT'S, NOT MIDNIGHT. A 14:00-22:00
 * shift with a 04:00 cutoff owns punches up to 04:00 the following calendar
 * morning (`attendanceDateForPunch` in the engine), so its attendance date is
 * not closed at midnight and a dashboard that assumed midnight would call a
 * working night shift absent. `dayCloseMinute` restates that same cutoff rule
 * from the same snapshot the engine used, per employee and per date, because
 * two employees on the same date can be on shifts that close at different
 * times.
 */

const { clockMinutes, datePart, dayDelta, MINUTES_PER_DAY } = require("./attendance_engine");

/** IST, like every other business date in this system. See utils/istDate.js. */
const IST_OFFSET_MINUTES = 5 * 60 + 30;

/**
 * "Now", in IST, as a business date plus minutes past ITS midnight.
 *
 * The offset is applied to the epoch and the fields read back in UTC, so no
 * local `Date` is built and the answer does not depend on the server's zone -
 * exactly the reasoning in `utils/istDate.js`, which this deliberately
 * mirrors rather than re-deciding.
 *
 * @param {number|Date} [now] epoch millis or a Date; defaults to the clock
 * @returns {{date: string, minutes: number}}
 */
function istNowParts(now = Date.now()) {
  const ms = now instanceof Date ? now.getTime() : Number(now);
  const ist = new Date((Number.isFinite(ms) ? ms : Date.now()) + IST_OFFSET_MINUTES * 60 * 1000);
  return {
    date: `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, "0")}-${String(
      ist.getUTCDate()
    ).padStart(2, "0")}`,
    minutes: ist.getUTCHours() * 60 + ist.getUTCMinutes(),
  };
}

/**
 * `now` expressed on ONE attendance date's own minute axis.
 *
 * The same axis `utils/attendance_engine.js` puts punches on: minute 0 is
 * midnight at the START of `attendanceDate`, so 02:00 the next calendar
 * morning is minute 1560 and comparing it with a 22:00 out-time (1320) is
 * ordinary subtraction. Returns null when either date is unreadable.
 */
function nowOnDateAxis(attendanceDate, now = Date.now()) {
  const parts = istNowParts(now);
  const delta = dayDelta(attendanceDate, parts.date);
  if (delta === null) return null;
  return delta * MINUTES_PER_DAY + parts.minutes;
}

/** `HH:MM[:SS]` -> minutes, tolerating a full datetime. Null when unreadable. */
function timeMinutes(value) {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value).trim();
  const m = /^(\d{1,2}):(\d{2})/.exec(text);
  if (m) {
    const h = Number(m[1]);
    const mi = Number(m[2]);
    if (h > 23 || mi > 59) return null;
    return h * 60 + mi;
  }
  return clockMinutes(text);
}

/**
 * The minute, on the attendance date's axis, at which the date STOPS
 * accepting punches.
 *
 * The cutoff on a date's own schedule row is the time on the FOLLOWING
 * calendar morning before which a punch still belongs to this date - that is
 * precisely how `attendanceDateForPunch` reads it. So the date closes at
 * `1440 + cutoff`. With no cutoff configured it closes at the next midnight,
 * which is the same boundary the ingest derivation falls back to.
 *
 * A REST DAY never claims the following morning (again, the engine's own
 * rule), so a rest day closes at midnight whatever its cutoff says.
 */
function dayCloseMinute(snapshot) {
  if (!snapshot) return MINUTES_PER_DAY;
  if (!snapshot.is_working_day) return MINUTES_PER_DAY;
  const cutoff = timeMinutes(snapshot.attendance_day_cutoff);
  return cutoff === null ? MINUTES_PER_DAY : MINUTES_PER_DAY + cutoff;
}

/**
 * Has this employee's attendance date finished?
 *
 * The ONE gate in front of every confirmed-absence and confirmed-missing-punch
 * count on this dashboard. A date with no resolvable shift has no cutoff to
 * read, so it is treated as closed at midnight rather than staying open for
 * ever - it is reported as a setup issue regardless, never as absence.
 */
function isDayClosed({ attendance_date, snapshot = null, now = Date.now() }) {
  const nowMinute = nowOnDateAxis(attendance_date, now);
  if (nowMinute === null) return false;
  return nowMinute >= dayCloseMinute(snapshot);
}

/**
 * Has the shift this employee was rostered on for this date STARTED?
 *
 * Unknown is not "yes": with no snapshot, or no in-time on it, this returns
 * false, so a person whose roster cannot be read is never counted as somebody
 * who failed to turn up. A rest day has no start.
 */
function hasShiftStarted({ attendance_date, snapshot = null, now = Date.now() }) {
  if (!snapshot || !snapshot.is_working_day) return false;
  const start = timeMinutes(snapshot.in_time);
  if (start === null) return false;
  const nowMinute = nowOnDateAxis(attendance_date, now);
  if (nowMinute === null) return false;
  return nowMinute >= start;
}

/* ------------------------------------------------- the canonical issues */

/**
 * The four attendance issue types, and the keys they are reported under.
 *
 * THIS MIRRORS `util/attendanceV2.js` IN THE FRONTEND, function `dayIssue`,
 * key for key, and the labels below are the same strings. That file is the
 * mapping the Employee Attendance screen has always rendered; the dashboard
 * needs the same answer on the SERVER because it aggregates thousands of days
 * into a count, and a count cannot be built out of a mapping that only exists
 * in the browser.
 *
 * IT IS A DELIBERATE DUPLICATE, AND THE TWO REPOSITORIES CANNOT IMPORT EACH
 * OTHER, so no test can read both files. What guards the pair instead is an
 * EXPLICIT MAPPING TABLE asserted on each side - `the shared status -> issue
 * table` in `utils/attendance_dashboard.test.js` here and in
 * `util/attendanceDashboard.test.js` in the frontend. Both tests spell the
 * same table out literally, so changing the mapping on one side fails that
 * side's own suite until the table is changed too, and the table is the thing
 * a reviewer compares. Keep the two in step.
 */
const ISSUE_KEY = Object.freeze({
  MISSING_PUNCH: "MISSING_PUNCH",
  REGULARIZATION_PENDING: "REGULARIZATION_PENDING",
  ABSENT: "ABSENT",
  NO_SHIFT: "NO_SHIFT",
  SHIFT_SETUP: "SHIFT_SETUP",
});

/** The exact words staff already see for each. Same strings as the frontend. */
const ISSUE_LABEL = Object.freeze({
  MISSING_PUNCH: "Missing Punch",
  REGULARIZATION_PENDING: "Regularization Pending",
  ABSENT: "Absent",
  NO_SHIFT: "No Shift Assigned",
  SHIFT_SETUP: "Shift Setup Issue",
});

/** The four that mean somebody has to act. ABSENT is a fact, not a task. */
const NEED_ACTION_ISSUE_KEYS = Object.freeze([
  ISSUE_KEY.MISSING_PUNCH,
  ISSUE_KEY.REGULARIZATION_PENDING,
  ISSUE_KEY.NO_SHIFT,
  ISSUE_KEY.SHIFT_SETUP,
]);

/**
 * The one issue a calculated day shows, or null for a normal day.
 *
 * A transcription of the frontend's `dayIssue`, including the detail that
 * OT_PENDING is NOT an attendance issue: a stored legacy OT_PENDING row is a
 * normal day, and the OT claim is reported separately and never moves a day
 * into Need Action.
 */
function dayIssueKey(day) {
  if (!day) return null;
  const reasons = Array.isArray(day.review_reasons) ? day.review_reasons : [];
  const punchCount = Number(day.punch_count) || 0;

  switch (day.status) {
    case "REGULARIZATION_PENDING":
      return ISSUE_KEY.REGULARIZATION_PENDING;
    case "OT_PENDING":
      return null;
    case "ABSENT":
      return ISSUE_KEY.ABSENT;
    case "NO_SHIFT_FOR_DATE":
      return ISSUE_KEY.NO_SHIFT;
    case "NO_SCHEDULE_ROW":
      return ISSUE_KEY.SHIFT_SETUP;
    case "REVIEW_REQUIRED":
      if (reasons.includes("MISSING_PUNCH") || punchCount % 2 === 1) return ISSUE_KEY.MISSING_PUNCH;
      if (reasons.includes("NO_SCHEDULE_ROW")) return ISSUE_KEY.SHIFT_SETUP;
      if (reasons.includes("NO_SHIFT_FOR_DATE")) return ISSUE_KEY.NO_SHIFT;
      return null;
    default:
      return null;
  }
}

/**
 * The issue this day is reported under ON THE DASHBOARD, which is the same
 * mapping with the OPEN-DAY gate in front of the two settled verdicts.
 *
 *   MISSING_PUNCH  is withheld while the attendance day is open. An odd punch
 *                  count during an ongoing shift is somebody still at work,
 *                  not a confirmed missing OUT, and reporting it as one would
 *                  send a manager chasing a correction that does not exist.
 *   ABSENT         is withheld while the day is open, and is not a Need
 *                  Action item in any case.
 *
 * A REGULARIZATION_PENDING day is reported whether the day is open or closed:
 * a request genuinely is waiting for somebody either way. NO_SHIFT and
 * SHIFT_SETUP are configuration faults that are true the moment the date is
 * looked at, so they are reported immediately - that is the whole point of
 * surfacing them.
 */
function dashboardIssueKey(day, { day_closed = false } = {}) {
  const key = dayIssueKey(day);
  if (key === null) return null;
  if (!day_closed && (key === ISSUE_KEY.MISSING_PUNCH || key === ISSUE_KEY.ABSENT)) return null;
  return key;
}

/** True when this day is one of the four somebody has to act on. */
function isNeedAction(day, context = {}) {
  const key = dashboardIssueKey(day, context);
  return key !== null && NEED_ACTION_ISSUE_KEYS.includes(key);
}

/* --------------------------------------------- the headcount breakdown */

/**
 * The Attendance Overview slices. MUTUALLY EXCLUSIVE AND EXHAUSTIVE: every
 * applicable employee lands in exactly one, so the slices always add up to
 * the filtered population and a worker can never be counted twice.
 *
 * Deliberately NOT slices: Need Action, Late/Early and OT. Each of those can
 * be true of somebody who is also Checked In, so putting them on the same
 * chart would double-count attended employees and the total would stop
 * meaning anything. They are counted separately, on their own cards.
 */
const PRESENCE_SLICE = Object.freeze({
  CHECKED_IN: "CHECKED_IN",
  NOT_YET_CHECKED_IN: "NOT_YET_CHECKED_IN",
  SHIFT_NOT_STARTED: "SHIFT_NOT_STARTED",
  ABSENT: "ABSENT",
  UNRESOLVED: "UNRESOLVED",
});

const PRESENCE_SLICE_LABEL = Object.freeze({
  CHECKED_IN: "Checked In",
  NOT_YET_CHECKED_IN: "Not Yet Checked In",
  SHIFT_NOT_STARTED: "Shift Not Started",
  ABSENT: "Absent (day closed)",
  UNRESOLVED: "Unresolved / Data Pending",
});

/** The order the chart and the legend read in. */
const PRESENCE_SLICE_ORDER = Object.freeze([
  PRESENCE_SLICE.CHECKED_IN,
  PRESENCE_SLICE.NOT_YET_CHECKED_IN,
  PRESENCE_SLICE.SHIFT_NOT_STARTED,
  PRESENCE_SLICE.ABSENT,
  PRESENCE_SLICE.UNRESOLVED,
]);

/**
 * Which ONE slice an employee's date falls in.
 *
 * The order of these tests is the rule, and it is written so that no branch
 * can assert something the data does not support:
 *
 *   1. A VALID PUNCH beats everything. Somebody who punched is Checked In
 *      whatever else is true of their day - including a day that still needs
 *      a correction, which is counted on the Need Action card instead.
 *   2. NO RESOLVABLE SHIFT is Unresolved, never Absent. "We do not know what
 *      this person was rostered for" is not evidence that they failed to turn
 *      up, and calling it absence would invent a fact.
 *   3. A REST DAY with no punch is Unresolved rather than Absent. The engine
 *      reports ABSENT for it because v2 has no weekly-off concept at all, and
 *      this dashboard is explicitly not the place to introduce one - so a
 *      rostered rest day is shown as coverage this screen cannot settle, and
 *      `rest_day_no_punch` beside the slices says how much of Unresolved it
 *      is. This is a PRESENTATION choice and changes no stored calculation.
 *   4. AN OPEN DAY splits on whether the shift has started yet. Before its
 *      in-time nobody is late; after it, and still with no punch, the honest
 *      answer is Not Yet Checked In - not Absent, because the day can still
 *      be worked.
 *   5. ONLY A CLOSED DAY can be Absent, and only when the engine says so.
 *      Anything else on a closed day - a missing punch, a pending
 *      regularization - is Unresolved here and is counted on Need Action.
 */
function presenceSlice({ day, resolution_status = null, day_closed = false, shift_started = false }) {
  const punchCount = Number(day && day.punch_count) || 0;
  if (punchCount > 0) return PRESENCE_SLICE.CHECKED_IN;

  if (resolution_status === "NO_SHIFT_FOR_DATE" || resolution_status === "NO_SCHEDULE_ROW") {
    return PRESENCE_SLICE.UNRESOLVED;
  }
  if (resolution_status === "REST_DAY") return PRESENCE_SLICE.UNRESOLVED;

  if (!day_closed) {
    return shift_started ? PRESENCE_SLICE.NOT_YET_CHECKED_IN : PRESENCE_SLICE.SHIFT_NOT_STARTED;
  }
  return day && day.status === "ABSENT" ? PRESENCE_SLICE.ABSENT : PRESENCE_SLICE.UNRESOLVED;
}

/* ----------------------------------------------------- the percentages */

/**
 * A displayed rate, with its own numerator and denominator attached.
 *
 * EVERY percentage this dashboard shows comes from here, so every one of them
 * can be read back to the counts it was built from - the chart, the tooltip
 * and the drilldown all quote the same pair. A ZERO DENOMINATOR IS NOT ZERO
 * PERCENT: it is `available: false`, and the screen renders an unavailable
 * state rather than a 0% that looks like total failure. Nothing here invents a
 * target, a grade or a health score.
 *
 * @returns {{numerator:number, denominator:number, percent:number|null,
 *   available:boolean}} `percent` is rounded to one decimal for display only;
 *   the counts are the truth.
 */
function rate(numerator, denominator) {
  const n = Math.max(0, Math.trunc(Number(numerator) || 0));
  const d = Math.max(0, Math.trunc(Number(denominator) || 0));
  if (d === 0) return { numerator: n, denominator: 0, percent: null, available: false };
  return {
    numerator: n,
    denominator: d,
    percent: Math.round((n / d) * 1000) / 10,
    available: true,
  };
}

/**
 * The check-in rate's ONE definition, named once so no caller can quietly use
 * another:
 *
 *   numerator   distinct employees with at least one valid effective punch
 *               dated to the attendance date
 *   denominator distinct APPLICABLE employees for that same date and the same
 *               filters - employed on the date, and inside the caller's scope
 *
 * Employees whose shift cannot be resolved stay in the denominator: they are
 * applicable, and dropping them would flatter the rate by hiding exactly the
 * setup faults this screen exists to surface. They are reported under
 * Unresolved so the gap is visible.
 */
const CHECK_IN_RATE_DEFINITION =
  "Checked In ÷ applicable employees for the selected attendance date and filters. " +
  "Applicable = employed on that date (joined on or before it, not resigned before it). " +
  "Employees with an unresolved shift remain in the denominator and are reported as Unresolved.";

/* ------------------------------------------------------------ grouping */

/**
 * Tally rows into `{key -> {...zeroed counters}}` without losing a key that
 * has no rows: `keys` seeds the result, so an outlet with nobody checked in
 * appears with a zero rather than vanishing from the chart.
 */
function tallyBy(rows, keyOf, keys = []) {
  const out = new Map();
  const blank = () => {
    const counters = { total: 0 };
    PRESENCE_SLICE_ORDER.forEach((slice) => {
      counters[slice] = 0;
    });
    counters.need_action = 0;
    return counters;
  };
  keys.forEach((k) => out.set(String(k), blank()));
  (rows || []).forEach((row) => {
    const key = String(keyOf(row));
    if (!out.has(key)) out.set(key, blank());
    const bucket = out.get(key);
    bucket.total += 1;
    bucket[row.slice] += 1;
    if (row.need_action) bucket.need_action += 1;
  });
  return out;
}

module.exports = {
  IST_OFFSET_MINUTES,
  istNowParts,
  nowOnDateAxis,
  timeMinutes,
  dayCloseMinute,
  isDayClosed,
  hasShiftStarted,
  ISSUE_KEY,
  ISSUE_LABEL,
  NEED_ACTION_ISSUE_KEYS,
  dayIssueKey,
  dashboardIssueKey,
  isNeedAction,
  PRESENCE_SLICE,
  PRESENCE_SLICE_LABEL,
  PRESENCE_SLICE_ORDER,
  presenceSlice,
  rate,
  CHECK_IN_RATE_DEFINITION,
  tallyBy,
};
