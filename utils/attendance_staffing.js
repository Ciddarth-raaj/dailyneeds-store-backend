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
 * THREE BOUNDARIES THAT ARE ROUTINELY CONFUSED:
 *
 *   THE DUTY INTERVAL   in_time -> out_time. It decides who is EXPECTED NOW.
 *   THE ATTENDANCE DAY  the shift's cutoff. It decides which punches belong
 *                       to which date, and therefore WHICH SESSION describes
 *                       an employee right now.
 *   THE CALENDAR DAY    midnight. It decides nothing here at all.
 *
 * They are not the same and must not be substituted for each other. A 9-9
 * employee stops being expected at 21:00 even though their attendance day
 * stays open until a later cutoff; using the cutoff for expectation would keep
 * them "expected" for hours after they went home. Equally, using the duty
 * interval to decide punch ownership would drop the 00:30 finish of a shift
 * that started yesterday.
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
 *
 * AND RECORDED STATE IS NOT RECORDED PLACE. Knowing that somebody's latest
 * punch opened a session is a different fact from knowing WHERE it happened,
 * and this file never lets the first stand in for the second - see GAP below.
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

/** The same interval, shifted onto a shared axis by `offsetMinutes`. */
function shiftInterval(interval, offsetMinutes) {
  if (!interval) return null;
  const offset = Math.trunc(Number(offsetMinutes) || 0);
  return { start: interval.start + offset, end: interval.end + offset };
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

/* ------------------------------------------ which session describes "now" */

/**
 * How long an attendance date keeps claiming punches, on its own minute axis.
 *
 * THIS IS THE ENGINE'S RULE, NOT A NEW ONE. `attendanceDateForPunch` gives a
 * punch to the PREVIOUS date when its clock time is before that date's
 * `attendance_day_cutoff`, so date D owns punches up to - and not including -
 * minute 1440 + cutoff. A rest day never claims the following morning, and
 * neither does a date with no cutoff on record, so both stop at midnight.
 *
 * DELIBERATELY DIFFERENT FROM `dayCloseMinute` IN ONE CASE, and the difference
 * is the safe direction for each question. With no snapshot at all, that helper
 * returns midnight - because for absence it is safer to call an unresolvable
 * day CLOSED and report it as a setup fault than to leave it open for ever.
 * Here the safe direction is the opposite: calling it closed would silently
 * discard real punches, so it returns null and the caller reports
 * Indeterminate. Same rule, two different failure directions, on purpose.
 *
 * @returns {number|null} null when the snapshot is missing, i.e. when the
 *   window cannot be established at all
 */
function sessionOwnershipEnd(snapshot) {
  if (!snapshot) return null;
  if (!snapshot.is_working_day) return MINUTES_PER_DAY;
  const cutoff = timeToMinutes(snapshot.attendance_day_cutoff);
  if (cutoff === null) return MINUTES_PER_DAY;
  return MINUTES_PER_DAY + cutoff;
}

const SESSION = Object.freeze({
  OPEN: "OPEN",
  CLOSED: "CLOSED",
  UNKNOWN: "UNKNOWN",
});

/** Is this candidate's attendance session still able to own punches now? */
function sessionWindow(candidate) {
  if (!candidate) return SESSION.UNKNOWN;
  const end = sessionOwnershipEnd(candidate.snapshot);
  if (end === null) return SESSION.UNKNOWN;
  return candidate.now_minute < end ? SESSION.OPEN : SESSION.CLOSED;
}

/** The candidate's punches at or before its own `now_minute`. */
function punchesSoFar(candidate) {
  if (!candidate) return [];
  return (candidate.punches || []).filter(
    (p) => p && p.minute !== null && p.minute !== undefined && p.minute <= candidate.now_minute
  );
}

/**
 * WHICH attendance session describes this employee's recorded state right now.
 *
 * THE DEFECT THIS REPLACES took whichever candidate happened to be processed
 * last and had punches. With candidates offered as [today, yesterday] that
 * meant YESTERDAY WON: a completed yesterday could override today's newer OUT,
 * and an unmatched IN from a session that closed hours ago could still be
 * reported as "recorded IN" today.
 *
 * THE RULE, in order:
 *
 *   1. ON DUTY -> that duty's session, and only that one. The question "is the
 *      person covering the shift they are on" is a question about that shift's
 *      own session; no other session can answer it.
 *   2. OTHERWISE, the NEWEST session that both still owns punches (its
 *      attendance day has not closed) and has at least one punch so far. Newest
 *      wins on purpose: at 14:00 today, today's OUT is the current state and
 *      yesterday's punches are history.
 *   3. A session whose ownership window CANNOT be established - the shift for
 *      that date did not resolve - but which has punches, is AMBIGUOUS. We
 *      cannot say whether it still owns them, so the caller reports
 *      Indeterminate rather than guessing IN.
 *   4. Nothing else: no session. That is "nothing recorded", which is not the
 *      same claim as "absent".
 *
 * NO GRACE PERIOD IS INVENTED anywhere in here. The only boundary used is the
 * shift's own cutoff, which the engine already applies at ingest.
 *
 * @param {Array<{attendance_date:string, snapshot:object, now_minute:number, punches:Array}>} candidates
 * @param {object} [options]
 * @param {object} [options.active] the active-duty candidate, when one exists
 * @returns {{candidate:object|null, ambiguous:boolean, reason:string}}
 */
function selectSession(candidates, { active = null } = {}) {
  if (active) return { candidate: active, ambiguous: false, reason: "ACTIVE_DUTY" };

  const newestFirst = (candidates || [])
    .filter(Boolean)
    .slice()
    .sort((a, b) => (String(a.attendance_date) < String(b.attendance_date) ? 1 : -1));

  const open = newestFirst.find(
    (c) => sessionWindow(c) === SESSION.OPEN && punchesSoFar(c).length > 0
  );
  if (open) return { candidate: open, ambiguous: false, reason: "OPEN_SESSION" };

  const unresolved = newestFirst.find(
    (c) => sessionWindow(c) === SESSION.UNKNOWN && punchesSoFar(c).length > 0
  );
  if (unresolved) {
    return { candidate: unresolved, ambiguous: true, reason: "SESSION_OWNERSHIP_UNKNOWN" };
  }

  return { candidate: null, ambiguous: false, reason: "NO_OPEN_SESSION" };
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
  INDETERMINATE: "INDETERMINATE",
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
 *
 * "RECORDED IN" AND "RECORDED IN HERE" ARE TWO FACTS, and the defect these
 * classes replace collapsed them. An employee expected at Moolakulam whose
 * latest punch opened a session at an UNMAPPED terminal used to count as
 * COVERED - so an unknown place silently reduced a known outlet's gap. It
 * cannot: the state is evidence, the place is not, and the scheduled location
 * stays unverified until something says where the punch happened.
 */
const GAP = Object.freeze({
  COVERED: "COVERED",
  NO_CHECK_IN: "NO_CHECK_IN",
  RECORDED_OUT: "RECORDED_OUT",
  IN_ELSEWHERE: "IN_ELSEWHERE",
  IN_LOCATION_UNKNOWN: "IN_LOCATION_UNKNOWN",
  EXPECTED_LOCATION_UNKNOWN: "EXPECTED_LOCATION_UNKNOWN",
  INDETERMINATE: "INDETERMINATE",
});

const GAP_LABEL = Object.freeze({
  COVERED: "Recorded IN at the expected location",
  NO_CHECK_IN: "No check-in received",
  RECORDED_OUT: "Recorded OUT during the shift",
  IN_ELSEWHERE: "Recorded IN at another location",
  IN_LOCATION_UNKNOWN: "Recorded IN, punch location not established",
  EXPECTED_LOCATION_UNKNOWN: "Expected location not on record",
  INDETERMINATE: "Punch state cannot be determined",
});

/** The classes that make up the gap. COVERED is not one of them. */
const GAP_CLASSES = Object.freeze([
  GAP.NO_CHECK_IN,
  GAP.RECORDED_OUT,
  GAP.IN_ELSEWHERE,
  GAP.IN_LOCATION_UNKNOWN,
  GAP.EXPECTED_LOCATION_UNKNOWN,
  GAP.INDETERMINATE,
]);

/**
 * HOW a recorded punch's location is known at all - which is not the same
 * question as WHETHER it is known.
 *
 *   DEVICE                   a terminal reported it, and the terminal's outlet
 *                            mapping either resolves or it does not.
 *   APPROVED_REGULARIZATION  there was no terminal: an approver accepted this
 *                            employee's attendance time and state for this
 *                            date. It says nothing about the place, and it is
 *                            never treated as if it did.
 *   UNKNOWN                  nothing establishes it.
 */
const LOCATION_BASIS = Object.freeze({
  DEVICE: "DEVICE",
  APPROVED_REGULARIZATION: "APPROVED_REGULARIZATION",
  UNKNOWN: "UNKNOWN",
});

/**
 * The bases that ESTABLISH a place. Only a device whose terminal resolves to an
 * outlet does; APPROVED_REGULARIZATION is recorded for display and establishes
 * nothing, because no approved duty location exists in the data to read.
 */
const LOCATION_ESTABLISHING_BASES = Object.freeze([LOCATION_BASIS.DEVICE]);

/**
 * The classes where the employee IS recorded IN somewhere, but the punch
 * cannot be credited to the location they were scheduled at.
 *
 * A company-wide screen may total these as "Recorded IN, location unverified".
 * It must NOT add them to any outlet's recorded cover - that is the whole
 * point of separating them.
 */
const IN_WITHOUT_LOCATION_CREDIT = Object.freeze([
  GAP.IN_ELSEWHERE,
  GAP.IN_LOCATION_UNKNOWN,
  GAP.EXPECTED_LOCATION_UNKNOWN,
]);

/** The classes that ask somebody to check the DATA rather than the cover. */
const VERIFICATION_CLASSES = Object.freeze([
  GAP.IN_ELSEWHERE,
  GAP.IN_LOCATION_UNKNOWN,
  GAP.EXPECTED_LOCATION_UNKNOWN,
  GAP.INDETERMINATE,
]);

/**
 * Classify ONE expected employee against their schedule.
 *
 * The order is the rule:
 *
 *   1. An AMBIGUOUS session, or any state that is not one of the three
 *      interpretable ones, is INDETERMINATE. We do not know, and guessing
 *      either way would put a real person in a category that reads like a
 *      finding about them.
 *   2. No punch at all is NO_CHECK_IN. This is "nothing recorded", not
 *      "absent": the delivery of punches is not verifiable in this system.
 *   3. Recorded OUT is RECORDED_OUT, and nothing more is claimed. It is not
 *      lunch, not an early departure, and not unauthorised - all three are
 *      interpretations this data cannot support.
 *   4. Recorded IN, but the employee's OWN expected outlet is not on record,
 *      is EXPECTED_LOCATION_UNKNOWN. There is nothing to compare against, so
 *      no location is called matched; it is a setup fault to fix.
 *   5. Recorded IN, but where the punch happened cannot be established - an
 *      unmapped terminal, or a location lookup that failed - is
 *      IN_LOCATION_UNKNOWN. The person is recorded IN somewhere; this outlet's
 *      cover is unverified.
 *   6. Recorded IN at a KNOWN and DIFFERENT location is IN_ELSEWHERE. The
 *      person is working somewhere; their schedule is still uncovered, and the
 *      receiving location counts them separately as an additional arrival
 *      rather than as cover.
 *   7. Recorded IN at the known, matching location is COVERED. Nothing else is.
 *
 * WHY EXPECTED-OUTLET IS CHECKED BEFORE PUNCH-OUTLET. Both are "verification
 * needed", so the precedence only decides which fault gets named first. An
 * employee with no outlet on record cannot be allocated to any location at
 * all, which is the more fundamental fault and the one a manager can actually
 * fix from the employee master - so it wins.
 *
 * @param {object} input
 * @param {string} input.recorded_state       one of RECORDED
 * @param {number|null} [input.punch_outlet_id] where the latest punch happened
 * @param {number|null} [input.expected_outlet_id]
 * AN APPROVED REGULARIZATION DOES NOT PROVE A PLACE, and the previous version's
 * shortcut - crediting one to the scheduled outlet - claimed more than the
 * approval does. What an approver accepted is an attendance TIME and STATE for
 * an employee-date. Nothing in that decision is a statement about which outlet
 * the person physically stood in, and the data bears this out: reading the
 * schema, `attendance_regularized_punch` has no location column of any kind,
 * and the only outlet on `attendance_approval_request` is documented in its own
 * DDL as "the employee home outlet, for the Store Manager stage" - approval
 * ROUTING derived from the default store, not an approved duty location.
 *
 * So a regularization with no authoritative location is IN_LOCATION_UNKNOWN,
 * exactly like an unmapped terminal: the state is evidence, the place is not.
 * The row still carries `location_basis: APPROVED_REGULARIZATION`, because HOW
 * a state arose is worth showing even when it settles nothing about where. If a
 * field that genuinely records an APPROVED duty location is ever added, this is
 * where it would be read - from that field, and never inferred from the
 * employee's default store, the scheduled store, the approver, the designation
 * or anything the browser sent.
 *
 * @param {boolean} [input.location_known]    false when the punch's terminal
 *        has no outlet mapping, or the lookup did not succeed; the state is
 *        trusted, the location is not
 * @param {string} [input.location_basis]     how the place is known at all -
 *        one of LOCATION_BASIS
 * @param {boolean} [input.ambiguous_session] the session that produced the
 *        state could not be established as the relevant one
 */
function classifyExpected({
  recorded_state,
  punch_outlet_id = null,
  expected_outlet_id = null,
  location_known = true,
  location_basis = LOCATION_BASIS.DEVICE,
  ambiguous_session = false,
}) {
  if (ambiguous_session) return GAP.INDETERMINATE;
  if (recorded_state === RECORDED.NONE) return GAP.NO_CHECK_IN;
  if (recorded_state === RECORDED.OUT) return GAP.RECORDED_OUT;
  if (recorded_state !== RECORDED.IN) return GAP.INDETERMINATE;

  // Recorded IN. Location certainty is a separate question from state, and
  // NOTHING short of an established location answers it - a regularization
  // included. `location_basis` is carried for display; it grants no credit.
  if (expected_outlet_id === null || expected_outlet_id === undefined) {
    return GAP.EXPECTED_LOCATION_UNKNOWN;
  }
  if (!location_known || punch_outlet_id === null || punch_outlet_id === undefined) {
    return GAP.IN_LOCATION_UNKNOWN;
  }
  return Number(punch_outlet_id) === Number(expected_outlet_id) ? GAP.COVERED : GAP.IN_ELSEWHERE;
}

/**
 * The same verdict for somebody whose duty is NOT TIED TO ONE OUTLET.
 *
 * WHY IT IS A SEPARATE FUNCTION AND NOT A FLAG ON THE ONE ABOVE. Every
 * location branch in `classifyExpected` asks the same question - "is this
 * person where their schedule says they should be" - and for a roaming
 * employee that question has no subject. There IS no expected outlet, so
 * EXPECTED_LOCATION_UNKNOWN would be a fault report about a value that is
 * absent ON PURPOSE, IN_ELSEWHERE would flag every ordinary visit to a branch
 * as needing verification, and IN_LOCATION_UNKNOWN would demand a terminal
 * mapping that settles nothing. Reusing the fixed-location classifier with a
 * null expectation is exactly how a deliberate absence becomes a permanent
 * alarm.
 *
 * SO ONLY THE STATE DECIDES. Recorded IN anywhere at all is covered: for this
 * employee, anywhere IS the expected location. NONE, OUT and an
 * unestablishable session keep the same three meanings they have everywhere
 * else, so a roaming employee who has not punched is still visible as one -
 * being untied to a branch is not an exemption from turning up.
 *
 * NOTHING HERE IS ALLOCATED TO AN OUTLET. These rows are counted in their own
 * total and never in any location's Expected or Gap; that separation is the
 * caller's, and `usecase/attendance_staffing.js` keeps the two populations in
 * two lists rather than one list with a flag, so no aggregation can include
 * them by forgetting to filter.
 */
function classifyRoaming({ recorded_state, ambiguous_session = false }) {
  if (ambiguous_session) return GAP.INDETERMINATE;
  if (recorded_state === RECORDED.NONE) return GAP.NO_CHECK_IN;
  if (recorded_state === RECORDED.OUT) return GAP.RECORDED_OUT;
  if (recorded_state !== RECORDED.IN) return GAP.INDETERMINATE;
  return GAP.COVERED;
}

/**
 * Tally a classified expected population and CHECK that it adds up.
 *
 * `reconciles` is returned rather than assumed: a breakdown that does not sum
 * to the headcount it claims to explain is worse than no breakdown, because it
 * looks authoritative.
 *
 * `recorded_in_somewhere` is reported beside it as a SEPARATE total - recorded
 * cover here, plus everyone recorded IN whose place cannot be credited to this
 * location. It is never added into `recorded_in_at_expected`.
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
  const inWithoutCredit = IN_WITHOUT_LOCATION_CREDIT.reduce((a, c) => a + counts[c], 0);
  return {
    expected,
    recorded_in_at_expected: covered,
    recorded_in_location_unverified: inWithoutCredit,
    recorded_in_somewhere: covered + inWithoutCredit,
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
 * EVERY ROW MUST ALREADY BE ON ONE SHARED AXIS. The defect this replaces fed
 * it only the currently-expected population, measured on whichever date the
 * first of them happened to sit on - so an employee whose shift STARTS in
 * twenty minutes was invisible (not yet expected), and a shift that began
 * yesterday was compared on the wrong axis. The caller now converts every
 * candidate interval onto a single as-of timeline and passes the whole
 * relevant schedule, including rows that are not active yet.
 *
 * @param {Array<{employee_id, interval:{start,end}, ...}>} scheduled every
 *   relevant employee-shift, its interval already on the shared axis
 * @returns {{next_change_minute:number|null, transitions:Array}}
 */
function upcomingTransitions(scheduled, nowMinute, windowMinutes = 60) {
  const limit = nowMinute + windowMinutes;
  const events = new Map();

  const add = (minute, kind, row) => {
    // Strictly after now, and up to and including the window edge: a change
    // exactly 60 minutes away is the last thing this view is for.
    if (minute <= nowMinute || minute > limit) return;
    if (!events.has(minute)) events.set(minute, { minute, starting: [], finishing: [] });
    events.get(minute)[kind].push(row);
  };

  (scheduled || []).forEach((row) => {
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
      // Who is still rostered immediately after this moment: everyone whose
      // interval has begun and has not ended. Somebody finishing AT this
      // minute is out; somebody starting AT it is in.
      remaining: (scheduled || []).filter(
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
  shiftInterval,
  activeDuty,
  SESSION,
  sessionOwnershipEnd,
  sessionWindow,
  selectSession,
  RECORDED,
  recordedStateAsOf,
  GAP,
  GAP_LABEL,
  GAP_CLASSES,
  LOCATION_BASIS,
  LOCATION_ESTABLISHING_BASES,
  IN_WITHOUT_LOCATION_CREDIT,
  VERIFICATION_CLASSES,
  classifyExpected,
  classifyRoaming,
  reconcileGap,
  upcomingTransitions,
  minuteToClock,
  elapsedSince,
};
