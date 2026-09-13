/**
 * Attendance & Staffing - the operational AS-OF classification.
 *
 * PURE FUNCTIONS. No database, no Express, no clock: `now` is always passed
 * in, so every rule here is testable at any instant of any shift.
 *
 * THE QUESTION THIS ANSWERS is different from the one the attendance engine
 * answers, and keeping them apart is the whole design. The engine settles a
 * FINISHED day: worked minutes, shortage, overtime, a payable outcome. This
 * file answers "at this moment, who should be on duty and who is recorded IN"
 * - an operational snapshot that is never payable, never stored, and never
 * fed back into payroll.
 *
 * TWO BOUNDARIES THAT ARE ROUTINELY CONFUSED:
 *
 *   THE DUTY INTERVAL   in_time -> out_time. It decides who is EXPECTED NOW.
 *   THE ATTENDANCE DAY  the shift's cutoff. It decides which punches belong
 *                       to which date.
 *
 * They are not the same and must not be substituted for each other. A 9-9
 * employee stops being expected at 21:00 even though their attendance day
 * stays open until a later cutoff; using the cutoff for expectation would keep
 * them "expected" for hours after they went home.
 *
 * NORMAL HOURS AND BREAKS ARE NOT THE INTERVAL EITHER. A 9-9 shift with a
 * one-hour break is scheduled across twelve hours; the break changes what is
 * payable, not when the person is rostered. Nobody is subtracted from expected
 * headcount because their shift allows lunch, and no lunch time is invented.
 *
 * WHAT "RECORDED IN" DOES NOT MEAN. It means the latest interpretable punch
 * state as of the snapshot is an IN. It does not mean the person is at a
 * counter, working, or not on a break - several Daily Needs employees eat on
 * the premises and punch twice a day. The vocabulary here says "recorded",
 * never "present", for that reason.
 */

const MINUTES_PER_DAY = 1440;

/* --------------------------------------------------------- duty interval */

/** `HH:MM[:SS]` -> minutes past midnight, or null. */
function timeToMinutes(value) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(value || "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

/**
 * The duty interval a shift snapshot describes, on its attendance date's own
 * minute axis (minute 0 = midnight starting that date).
 *
 * `shift_span_minutes` is the engine's own out-minus-in, already correct
 * across midnight, so an overnight shift simply ends at a minute past 1440
 * rather than needing a special case.
 *
 * A NON-WORKING SCHEDULE ROW HAS NO INTERVAL. Nobody is rostered, so nobody is
 * expected - which is an operational statement about this minute and not a
 * leave entitlement, a weekly off, or any change to how the day is paid.
 *
 * @returns {{start:number, end:number}|null}
 */
function dutyInterval(snapshot) {
  if (!snapshot || !snapshot.is_working_day) return null;
  const start = timeToMinutes(snapshot.in_time);
  if (start === null) return null;
  const span = Math.max(0, Math.trunc(Number(snapshot.shift_span_minutes) || 0));
  if (span <= 0) return null;
  return { start, end: start + span };
}

/** Is `nowMinute` inside the interval? Start inclusive, end exclusive. */
function onDutyAt(interval, nowMinute) {
  if (!interval || nowMinute === null || nowMinute === undefined) return false;
  return nowMinute >= interval.start && nowMinute < interval.end;
}

/**
 * Which of an employee's candidate attendance dates is on duty right now.
 *
 * Candidates are offered newest-first and the FIRST whose interval covers the
 * instant wins. The previous calendar date is a genuine candidate, not an edge
 * case: at 01:00 the person on duty is the one whose 22:00-06:00 shift started
 * yesterday, and their duty interval runs to minute 1800 of yesterday.
 *
 * @param {Array<{attendance_date:string, snapshot:object, now_minute:number}>} candidates
 * @returns {object|null} the winning candidate, with its interval attached
 */
function activeDuty(candidates) {
  for (const candidate of candidates || []) {
    const interval = dutyInterval(candidate.snapshot);
    if (onDutyAt(interval, candidate.now_minute)) return { ...candidate, interval };
  }
  return null;
}

/* ------------------------------------------------- recorded state as of */

/**
 * Every state the recorded punch stream can be in AS OF an instant.
 *
 * Derived by the engine's own POSITIONAL pairing - 1st IN, 2nd OUT, 3rd IN -
 * over the effective punches of one attendance session, counting only those at
 * or before the snapshot. The device's own flag is never read: the Biomax
 * schema documents it as "NOT a direction flag" and staff press the wrong side
 * of terminals routinely.
 */
const RECORDED = Object.freeze({
  NONE: "NONE",
  IN: "IN",
  OUT: "OUT",
});

/**
 * The recorded state as of `nowMinute`.
 *
 * An ODD number of punches so far means the last one opened a session: the
 * person is recorded IN. An EVEN number means the last one closed it: recorded
 * OUT. This is exactly the engine's pairing, stopped at the snapshot instead of
 * at the end of the day, which is what makes the two agree about a finished
 * day and differ only about an unfinished one.
 *
 * A SINGLE IN DURING AN ONGOING SHIFT IS NORMAL. It is somebody at work, not a
 * missing-OUT defect, and nothing here labels it one.
 *
 * @param {Array<{minute:number, punch_id, io_time, source}>} punches one
 *   session's effective punches, ascending
 * @param {number} nowMinute
 * @returns {{state:string, last:object|null, since_minute:number|null, count:number}}
 */
function recordedStateAsOf(punches, nowMinute) {
  const upto = (punches || [])
    .filter((p) => p && p.minute !== null && p.minute !== undefined && p.minute <= nowMinute)
    .sort((a, b) => a.minute - b.minute);

  if (upto.length === 0) return { state: RECORDED.NONE, last: null, since_minute: null, count: 0 };
  const last = upto[upto.length - 1];
  return {
    state: upto.length % 2 === 1 ? RECORDED.IN : RECORDED.OUT,
    last,
    since_minute: last.minute,
    count: upto.length,
  };
}

/* ------------------------------------------------------ the gap classes */

/**
 * Why an expected employee is not counted as covering their schedule.
 *
 * MUTUALLY EXCLUSIVE AND EXHAUSTIVE over the expected population, so
 *
 *   expected = recorded IN at the expected location + every gap class
 *
 * holds by construction. `reconcileGap` asserts it rather than trusting it.
 */
const GAP = Object.freeze({
  COVERED: "COVERED",
  NO_CHECK_IN: "NO_CHECK_IN",
  RECORDED_OUT: "RECORDED_OUT",
  IN_ELSEWHERE: "IN_ELSEWHERE",
  INDETERMINATE: "INDETERMINATE",
});

const GAP_LABEL = Object.freeze({
  COVERED: "Recorded IN at the expected location",
  NO_CHECK_IN: "No check-in received",
  RECORDED_OUT: "Recorded OUT during the shift",
  IN_ELSEWHERE: "Recorded IN at another location",
  INDETERMINATE: "Punch state or location cannot be determined",
});

/** The classes that make up the gap. COVERED is not one of them. */
const GAP_CLASSES = Object.freeze([
  GAP.NO_CHECK_IN,
  GAP.RECORDED_OUT,
  GAP.IN_ELSEWHERE,
  GAP.INDETERMINATE,
]);

/**
 * Classify ONE expected employee against their schedule.
 *
 * The order is the rule:
 *
 *   1. An UNRESOLVED punch or an unknown punch location is INDETERMINATE. We
 *      do not know, and guessing either way would put a real person in a
 *      category that reads like a finding about them.
 *   2. No punch at all is NO_CHECK_IN. This is "nothing recorded", not
 *      "absent": the delivery of punches is not verifiable in this system.
 *   3. Recorded OUT is RECORDED_OUT, and nothing more is claimed. It is not
 *      lunch, not an early departure, and not unauthorised - all three are
 *      interpretations this data cannot support.
 *   4. Recorded IN, at a punch location that is not the expected one, is
 *      IN_ELSEWHERE. The person is working somewhere; their schedule is still
 *      uncovered, and the receiving location counts them separately as an
 *      additional arrival rather than as cover.
 *   5. Recorded IN at the expected location - or with no location to compare,
 *      which is the common case when the terminal is unmapped - is COVERED.
 *
 * @param {object} input
 * @param {string} input.recorded_state       one of RECORDED
 * @param {number|null} [input.punch_outlet_id] where the latest punch happened
 * @param {number|null} [input.expected_outlet_id]
 * @param {boolean} [input.location_known]    false when the punch's terminal
 *        has no outlet mapping; the state is trusted, the location is not
 */
function classifyExpected({
  recorded_state,
  punch_outlet_id = null,
  expected_outlet_id = null,
  location_known = true,
}) {
  if (recorded_state === RECORDED.NONE) return GAP.NO_CHECK_IN;
  if (recorded_state === RECORDED.OUT) return GAP.RECORDED_OUT;
  if (recorded_state !== RECORDED.IN) return GAP.INDETERMINATE;

  // Recorded IN. Only a KNOWN and DIFFERENT location makes it elsewhere.
  if (!location_known) return GAP.COVERED;
  if (expected_outlet_id === null || expected_outlet_id === undefined) return GAP.COVERED;
  if (punch_outlet_id === null || punch_outlet_id === undefined) return GAP.COVERED;
  return Number(punch_outlet_id) === Number(expected_outlet_id) ? GAP.COVERED : GAP.IN_ELSEWHERE;
}

/**
 * Tally a classified expected population and CHECK that it adds up.
 *
 * `reconciles` is returned rather than assumed: a breakdown that does not sum
 * to the headcount it claims to explain is worse than no breakdown, because it
 * looks authoritative.
 */
function reconcileGap(rows) {
  const counts = { [GAP.COVERED]: 0 };
  GAP_CLASSES.forEach((c) => {
    counts[c] = 0;
  });
  (rows || []).forEach((r) => {
    if (counts[r.gap_class] === undefined) counts[r.gap_class] = 0;
    counts[r.gap_class] += 1;
  });
  const expected = (rows || []).length;
  const covered = counts[GAP.COVERED];
  const gap = GAP_CLASSES.reduce((a, c) => a + counts[c], 0);
  return {
    expected,
    recorded_in_at_expected: covered,
    gap,
    by_class: GAP_CLASSES.map((c) => ({ key: c, label: GAP_LABEL[c], count: counts[c] })),
    reconciles: covered + gap === expected,
  };
}

/* -------------------------------------------------- the next-hour view */

/**
 * Scheduled starts and finishes in the next `windowMinutes`.
 *
 * A SCHEDULE-BASED OUTLOOK, NOT A PREDICTION. It says who is rostered to begin
 * and end, and how many remain rostered afterwards. It does not forecast who
 * will actually arrive, and it never judges whether the remaining cover is
 * sufficient - that is a staffing requirement, which belongs to the budgeting
 * phase and does not exist yet.
 *
 * @param {Array<{employee_id, interval, ...}>} rostered every employee with a
 *   duty interval on the axis `nowMinute` is measured on
 * @returns {{next_change_minute:number|null, transitions:Array}}
 */
function upcomingTransitions(rostered, nowMinute, windowMinutes = 60) {
  const limit = nowMinute + windowMinutes;
  const events = new Map();

  const add = (minute, kind, row) => {
    if (minute <= nowMinute || minute > limit) return;
    if (!events.has(minute)) events.set(minute, { minute, starting: [], finishing: [] });
    events.get(minute)[kind].push(row);
  };

  (rostered || []).forEach((row) => {
    if (!row || !row.interval) return;
    add(row.interval.start, "starting", row);
    add(row.interval.end, "finishing", row);
  });

  const transitions = [...events.values()]
    .sort((a, b) => a.minute - b.minute)
    .map((event) => ({
      minute: event.minute,
      starting: event.starting,
      finishing: event.finishing,
      // Who is still rostered immediately after this moment.
      remaining: (rostered || []).filter(
        (r) => r.interval && r.interval.start <= event.minute && r.interval.end > event.minute
      ),
    }));

  return {
    next_change_minute: transitions.length ? transitions[0].minute : null,
    transitions,
  };
}

/* ----------------------------------------------------------- formatting */

/** A minute on an attendance date's axis -> `HH:MM`, wrapping past midnight. */
function minuteToClock(minute) {
  if (minute === null || minute === undefined || !Number.isFinite(Number(minute))) return null;
  const m = ((Math.trunc(Number(minute)) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** Elapsed minutes, floored at zero. For follow-up ordering only - never a penalty. */
function elapsedSince(sinceMinute, nowMinute) {
  if (sinceMinute === null || sinceMinute === undefined) return null;
  return Math.max(0, Math.trunc(nowMinute - sinceMinute));
}

module.exports = {
  MINUTES_PER_DAY,
  timeToMinutes,
  dutyInterval,
  onDutyAt,
  activeDuty,
  RECORDED,
  recordedStateAsOf,
  GAP,
  GAP_LABEL,
  GAP_CLASSES,
  classifyExpected,
  reconcileGap,
  upcomingTransitions,
  minuteToClock,
  elapsedSince,
};
