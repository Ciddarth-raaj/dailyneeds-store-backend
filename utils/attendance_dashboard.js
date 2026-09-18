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
 * AND CLOSED IS NOT THE SAME AS COMPLETE. The cutoff passing proves the
 * window is OVER; it proves nothing about whether every punch inside it has
 * REACHED US - and, as `DELIVERY` below sets out, this system has no
 * acknowledgement that could prove it. So the dashboard never claims a
 * CONFIRMED ABSENCE at all: a finished day with no punches is reported as
 * "No punches recorded", qualified by the delivery state of its location.
 *
 * A MISSING PUNCH IS DELIBERATELY TREATED DIFFERENTLY, and the asymmetry is
 * the point. "Absent" is a VERDICT ABOUT A PERSON, and getting it wrong when
 * the real cause is an undelivered punch is unfair to them. "Missing punch" is
 * a PROMPT TO LOOK: the day genuinely is not settled, and it needs a human
 * whether it resolves by a late punch arriving or by a regularization.
 * Suppressing it would hide real work from the people whose job is to clear
 * it.
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
      // A permitted break as long as the shift is a configuration fault, and
      // it is reported in the same bucket as the other two rather than under
      // a sixth issue key: the reason on the row names the exact cause, and
      // the screens already know how to route a setup problem.
      if (reasons.includes("BREAK_EXCEEDS_SHIFT")) return ISSUE_KEY.SHIFT_SETUP;
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
 *   ABSENT         is withheld while the day is open. It is never presented as
 *                  a confirmed absence anywhere on this dashboard - the label
 *                  staff see is "No punches recorded" - and it is not a Need
 *                  Action item: it is a fact to look into, not a task to
 *                  clear.
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
 * PUNCH DELIVERY ASSURANCE for one location on one attendance date.
 *
 * WHAT THE PREVIOUS VERSION CLAIMED, AND WHY IT WAS WRONG. It reported
 * COMPLETE - "punch delivery confirmed" - when every terminal mapped to an
 * outlet had contacted the receiver at or after the attendance day closed.
 * Reading the actual receiver settles it: `touchDevice` in `biomax/store.js`
 * writes `last_seen_at` on EVERY request, including the `receive_cmd` polls a
 * device makes when it has nothing to say. A heartbeat therefore proves the
 * device is reachable and proves nothing whatever about whether the punches it
 * buffered were parsed, matched and persisted.
 *
 * NOR IS THERE ANYTHING ELSE TO USE. `biomax/store.js` states in its own
 * header that `biomax_historical_pull.COMPLETED` "is set by nothing yet (its
 * protocol semantics are unproven)", and a search confirms it: only FAILED is
 * ever written. The realtime protocol is a one-way `realtime_glog` push with
 * no end-of-logs marker, no high-water mark and no sequence number, and the
 * device's `cmd_return_code` vocabulary has not been captured. There is no
 * acknowledgement in this system whose meaning supports a completeness claim.
 *
 * SO COMPLETE DOES NOT EXIST HERE, and this enum no longer has a value for it.
 * Inventing a timeout or a "probably fine by now" flag would be exactly the
 * assumption that was wrong the first time, in a new costume.
 *
 *   UNVERIFIED   the normal state. Punches received are real and are used;
 *                whether MORE are still to come cannot be established.
 *   IN_PROGRESS  a historical pull covering the date is open. Positive
 *                evidence that punches for it are still being retrieved.
 *   PULL_FAILED  a historical pull covering the date FAILED. A pull that
 *                stopped is not a pull that succeeded, and treating "no
 *                longer running" as delivered is the same error again.
 *
 * WHAT FOLLOWS FROM IT. This dashboard never asserts a CONFIRMED absence, and
 * says "no punches recorded" where it used to say "absent". That is a real
 * loss of certainty, and stating it is the point: the alternative is a screen
 * that calls somebody absent on the strength of a device heartbeat.
 */
const DELIVERY = Object.freeze({
  UNVERIFIED: "UNVERIFIED",
  IN_PROGRESS: "IN_PROGRESS",
  PULL_FAILED: "PULL_FAILED",
});

const DELIVERY_LABEL = Object.freeze({
  UNVERIFIED: "Delivery not verified",
  IN_PROGRESS: "Punches still being retrieved",
  PULL_FAILED: "A punch retrieval failed",
});

const DELIVERY_DETAIL = Object.freeze({
  UNVERIFIED:
    "Punches received are shown. The terminals give no end-of-transfer acknowledgement, so whether more are still to arrive cannot be established.",
  IN_PROGRESS:
    "A historical pull covering this date is still running, so punches for it are still being retrieved.",
  PULL_FAILED:
    "A historical pull covering this date failed, so punches it was retrieving may be missing.",
});

/**
 * Delivery assurance for ONE location on ONE date.
 *
 * Device contact is deliberately NOT an input: it cannot raise the answer
 * above UNVERIFIED, so taking it would only suggest that it could.
 *
 * @param {object} input
 * @param {boolean} [input.open_pull]   a pull covering the date is running
 * @param {boolean} [input.failed_pull] a pull covering the date failed
 */
function locationDelivery({ open_pull = false, failed_pull = false } = {}) {
  if (open_pull) return DELIVERY.IN_PROGRESS;
  if (failed_pull) return DELIVERY.PULL_FAILED;
  return DELIVERY.UNVERIFIED;
}

/** Nothing this system can observe verifies delivery. Stated once, here. */
function deliveryVerified() {
  return false;
}

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
  NO_RECORD: "NO_RECORD",
  UNRESOLVED: "UNRESOLVED",
});

const PRESENCE_SLICE_LABEL = Object.freeze({
  CHECKED_IN: "Checked In",
  NOT_YET_CHECKED_IN: "Not Yet Checked In",
  SHIFT_NOT_STARTED: "Shift Not Started",
  // NOT "Absent". No punches reached us for a finished day, and this system
  // cannot tell that apart from punches that never arrived - see DELIVERY.
  NO_RECORD: "No punches recorded",
  UNRESOLVED: "Unresolved / Data Pending",
});

/** The order the chart and the legend read in. */
const PRESENCE_SLICE_ORDER = Object.freeze([
  PRESENCE_SLICE.CHECKED_IN,
  PRESENCE_SLICE.NOT_YET_CHECKED_IN,
  PRESENCE_SLICE.SHIFT_NOT_STARTED,
  PRESENCE_SLICE.NO_RECORD,
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
 *      a correction, which is counted on the Need Action card instead. A
 *      received punch is positive evidence and stays positive even when the
 *      feed's completeness is in doubt: doubt about what is MISSING says
 *      nothing about what ARRIVED.
 *   2. NO RESOLVABLE SHIFT is Unresolved, never Absent. "We do not know what
 *      this person was rostered for" is not evidence that they failed to turn
 *      up, and calling it absence would invent a fact.
 *   3. AN OPEN DAY splits on whether the shift has started yet. Before its
 *      in-time nobody is late; after it, and still with no punch, the honest
 *      answer is Not Yet Checked In - not Absent, because the day can still
 *      be worked.
 *   4. A CLOSED DAY WITH NO PUNCHES IS "NO RECORD", NOT "ABSENT". The cutoff
 *      passing proves the window is over; nothing in this system proves the
 *      punches inside it arrived (see `DELIVERY`). The slice carries the
 *      engine's answer without the word that would overclaim it, and the
 *      location's delivery state travels beside it.
 *   5. Anything else on a closed day - a missing punch, a pending
 *      regularization - is Unresolved here and counted on Need Action.
 *
 * A ROSTERED REST DAY IS NOT SPECIAL-CASED. An earlier version of this file
 * diverted `REST_DAY` with no punch into Unresolved on the grounds that v2 has
 * no weekly-off concept. That was itself a weekly-off policy - a
 * dashboard-only one, invisible to the engine and to every other screen, which
 * made this screen disagree with the employee's own attendance for the same
 * date. The engine's answer is used, subject to exactly the same open-day and
 * completeness safeguards as any other date.
 */
function presenceSlice({
  day,
  resolution_status = null,
  day_closed = false,
  shift_started = false,
}) {
  const punchCount = Number(day && day.punch_count) || 0;
  if (punchCount > 0) return PRESENCE_SLICE.CHECKED_IN;

  if (resolution_status === "NO_SHIFT_FOR_DATE" || resolution_status === "NO_SCHEDULE_ROW") {
    return PRESENCE_SLICE.UNRESOLVED;
  }

  if (!day_closed) {
    return shift_started ? PRESENCE_SLICE.NOT_YET_CHECKED_IN : PRESENCE_SLICE.SHIFT_NOT_STARTED;
  }

  return day && day.status === "ABSENT" ? PRESENCE_SLICE.NO_RECORD : PRESENCE_SLICE.UNRESOLVED;
}

/**
 * Why a no-punch day on a closed day is still unresolved, for the drilldown
 * and the tooltip. Null when the slice is not Unresolved for a coverage
 * reason. Never a silent blank.
 */
function unresolvedReason({ day, resolution_status = null, day_closed = false, delivery = null }) {
  const punchCount = Number(day && day.punch_count) || 0;
  if (punchCount > 0) return null;
  if (resolution_status === "NO_SHIFT_FOR_DATE") return "No shift assigned for this date";
  if (resolution_status === "NO_SCHEDULE_ROW") return "The shift has no schedule row for this weekday";
  if (!day_closed) return null;
  if (delivery === DELIVERY.IN_PROGRESS) return DELIVERY_DETAIL.IN_PROGRESS;
  if (delivery === DELIVERY.PULL_FAILED) return DELIVERY_DETAIL.PULL_FAILED;
  if (day && day.status !== "ABSENT") return "The day needs a correction before it is settled";
  return null;
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
  DELIVERY,
  DELIVERY_LABEL,
  DELIVERY_DETAIL,
  locationDelivery,
  deliveryVerified,
  PRESENCE_SLICE,
  PRESENCE_SLICE_LABEL,
  PRESENCE_SLICE_ORDER,
  presenceSlice,
  unresolvedReason,
  rate,
  CHECK_IN_RATE_DEFINITION,
  tallyBy,
};
