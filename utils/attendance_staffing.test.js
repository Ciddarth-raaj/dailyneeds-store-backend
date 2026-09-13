/**
 * The operational as-of classification.
 *
 *   node --test utils/attendance_staffing.test.js
 *
 * These pin the two things this feature can most easily get wrong: confusing
 * the duty interval with the attendance day, and turning an uncertain punch
 * record into a finding about a person.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  GAP,
  GAP_CLASSES,
  IN_WITHOUT_LOCATION_CREDIT,
  RECORDED,
  SESSION,
  activeDuty,
  classifyExpected,
  dutyInterval,
  elapsedSince,
  minuteToClock,
  onDutyAt,
  recordedStateAsOf,
  reconcileGap,
  selectSession,
  sessionOwnershipEnd,
  sessionWindow,
  shiftInterval,
  upcomingTransitions,
} = require("./attendance_staffing");

/** The real shift shapes, by their production names. */
const shift = (inTime, span, over = {}) => ({
  is_working_day: true,
  in_time: inTime,
  shift_span_minutes: span,
  attendance_day_cutoff: "04:00:00",
  ...over,
});
const NINE_TO_NINE = shift("09:00:00", 12 * 60); // 540 -> 1260
const TEN_TO_TEN = shift("10:00:00", 12 * 60); // 600 -> 1320
const TWO_TO_TEN = shift("14:00:00", 8 * 60); // 840 -> 1320
const NIGHT = shift("22:00:00", 8 * 60); // 1320 -> 1800, past midnight

const at = (h, m = 0) => h * 60 + m;

describe("the duty interval comes from the shift, not from hours or breaks", () => {
  it("spans in-time to out-time", () => {
    assert.deepEqual(dutyInterval(NINE_TO_NINE), { start: 540, end: 1260 });
  });

  it("a break does not shorten it", () => {
    // Same shift, an hour of break: twelve hours rostered either way.
    const withBreak = { ...NINE_TO_NINE, break_minutes: 60, normal_work_minutes: 660 };
    assert.deepEqual(dutyInterval(withBreak), dutyInterval(NINE_TO_NINE));
  });

  it("an overnight shift simply ends past midnight", () => {
    assert.deepEqual(dutyInterval(NIGHT), { start: 1320, end: 1800 });
  });

  it("a non-working schedule row rosters nobody", () => {
    assert.equal(dutyInterval({ ...NINE_TO_NINE, is_working_day: false }), null);
  });

  it("an unreadable or absent shift has no interval - never a silent zero", () => {
    assert.equal(dutyInterval(null), null);
    assert.equal(dutyInterval({ is_working_day: true, in_time: null, shift_span_minutes: 60 }), null);
    assert.equal(dutyInterval({ is_working_day: true, in_time: "09:00", shift_span_minutes: 0 }), null);
  });
});

describe("on duty: start inclusive, end exclusive", () => {
  const i = dutyInterval(NINE_TO_NINE);

  it("not before the start", () => assert.equal(onDutyAt(i, at(8, 59)), false));
  it("yes at exactly the start", () => assert.equal(onDutyAt(i, at(9, 0)), true));
  it("yes mid-shift", () => assert.equal(onDutyAt(i, at(15, 0)), true));
  it("no at exactly the finish", () =>
    assert.equal(onDutyAt(i, at(21, 0)), false, "their shift is over at 21:00"));
  it("no after the finish", () => assert.equal(onDutyAt(i, at(21, 15)), false));
});

describe("the worked examples from the approved design", () => {
  const expectedAt = (minute) =>
    [
      ["9-9", NINE_TO_NINE],
      ["10-10", TEN_TO_TEN],
      ["2-10", TWO_TO_TEN],
    ]
      .filter(([, s]) => onDutyAt(dutyInterval(s), minute))
      .map(([name]) => name);

  it("09:30 -> the 9-9 employees", () => assert.deepEqual(expectedAt(at(9, 30)), ["9-9"]));
  it("10:30 -> 9-9 and 10-10", () => assert.deepEqual(expectedAt(at(10, 30)), ["9-9", "10-10"]));
  it("14:30 -> all three", () =>
    assert.deepEqual(expectedAt(at(14, 30)), ["9-9", "10-10", "2-10"]));
  it("21:15 -> the 9-9 shift has finished", () =>
    assert.deepEqual(expectedAt(at(21, 15)), ["10-10", "2-10"]));
});

describe("the duty interval is not the attendance day", () => {
  it("a 9-9 employee stops being expected at 21:00 though their day runs to the 04:00 cutoff", () => {
    // The attendance day is open until minute 1440+240 = 1680. The duty
    // interval ends at 1260. Using the cutoff would keep them expected for
    // seven more hours.
    const i = dutyInterval(NINE_TO_NINE);
    assert.equal(onDutyAt(i, at(22, 0)), false);
    assert.ok(1320 < 1680, "the attendance day is still open at 22:00");
  });

  it("a shift that began yesterday is the one on duty after midnight", () => {
    // 01:00 today is minute 1500 on YESTERDAY's axis, inside a 22:00-06:00.
    const duty = activeDuty([
      { attendance_date: "2026-09-13", snapshot: NIGHT, now_minute: at(1, 0) },
      { attendance_date: "2026-09-12", snapshot: NIGHT, now_minute: at(1, 0) + 1440 },
    ]);
    assert.ok(duty, "somebody is on duty at 01:00");
    assert.equal(duty.attendance_date, "2026-09-12", "it is yesterday's shift, still running");
  });

  it("nobody is on duty when no candidate interval covers the instant", () => {
    assert.equal(
      activeDuty([{ attendance_date: "2026-09-13", snapshot: NINE_TO_NINE, now_minute: at(3, 0) }]),
      null
    );
  });
});

describe("the recorded state is the engine's pairing, stopped at the snapshot", () => {
  const p = (minute, punch_id) => ({ minute, punch_id, io_time: null, source: "BIOMAX" });

  it("nothing punched is NONE", () => {
    assert.equal(recordedStateAsOf([], at(12)).state, RECORDED.NONE);
  });

  it("one punch is IN - a normal ongoing shift, not a missing OUT", () => {
    const r = recordedStateAsOf([p(at(9, 5), 1)], at(12));
    assert.equal(r.state, RECORDED.IN);
    assert.equal(r.since_minute, at(9, 5));
    assert.equal(r.count, 1);
  });

  it("two punches is OUT", () => {
    assert.equal(recordedStateAsOf([p(at(9), 1), p(at(14), 2)], at(15)).state, RECORDED.OUT);
  });

  it("IN -> OUT -> IN is IN again", () => {
    const r = recordedStateAsOf([p(at(9), 1), p(at(13), 2), p(at(14), 3)], at(15));
    assert.equal(r.state, RECORDED.IN);
    assert.equal(r.since_minute, at(14));
  });

  it("four punches is OUT", () => {
    const r = recordedStateAsOf(
      [p(at(9), 1), p(at(13), 2), p(at(14), 3), p(at(21), 4)],
      at(22)
    );
    assert.equal(r.state, RECORDED.OUT);
    assert.equal(r.count, 4);
  });

  it("punches after the snapshot are not counted", () => {
    // The same day seen at 12:00 and at 22:00 gives different answers, which
    // is the entire point of an as-of metric.
    const punches = [p(at(9), 1), p(at(21), 2)];
    assert.equal(recordedStateAsOf(punches, at(12)).state, RECORDED.IN);
    assert.equal(recordedStateAsOf(punches, at(22)).state, RECORDED.OUT);
  });

  it("orders by instant, not by the order rows arrived", () => {
    const r = recordedStateAsOf([p(at(14), 3), p(at(9), 1), p(at(13), 2)], at(15));
    assert.equal(r.state, RECORDED.IN);
    assert.equal(r.since_minute, at(14));
  });
});

describe("classifying an expected employee", () => {
  const base = { expected_outlet_id: 1, location_known: true, punch_outlet_id: 1 };

  it("recorded IN at the expected location is covered", () => {
    assert.equal(classifyExpected({ ...base, recorded_state: RECORDED.IN }), GAP.COVERED);
  });

  it("no punch is NO_CHECK_IN, which is not absence", () => {
    assert.equal(classifyExpected({ ...base, recorded_state: RECORDED.NONE }), GAP.NO_CHECK_IN);
  });

  it("recorded OUT is just that - not lunch, not an early exit", () => {
    assert.equal(classifyExpected({ ...base, recorded_state: RECORDED.OUT }), GAP.RECORDED_OUT);
  });

  it("recorded IN at another location does not cover this schedule", () => {
    assert.equal(
      classifyExpected({ ...base, recorded_state: RECORDED.IN, punch_outlet_id: 2 }),
      GAP.IN_ELSEWHERE
    );
  });

  it("an unmapped terminal does not manufacture a cross-location finding EITHER WAY", () => {
    // It is NOT IN_ELSEWHERE - unknown is not "somewhere else", and inventing a
    // cross-location finding out of unmapped hardware would be a fabrication.
    // It is NOT COVERED either, which is what this used to return: an unknown
    // place cannot reduce a known outlet's gap. It is its own class.
    const verdict = classifyExpected({
      ...base,
      recorded_state: RECORDED.IN,
      punch_outlet_id: null,
      location_known: false,
    });
    assert.equal(verdict, GAP.IN_LOCATION_UNKNOWN);
    assert.notEqual(verdict, GAP.COVERED, "an unknown place is not coverage of a known outlet");
    assert.notEqual(verdict, GAP.IN_ELSEWHERE, "nor is it a location finding");
  });

  it("a location lookup that FAILED gives no expected-location credit", () => {
    // Failure arrives as location_known:false with no outlet id, which is the
    // same shape as an unmapped terminal and must get the same answer. The
    // defect this replaces turned every IN into coverage when the query threw.
    assert.equal(
      classifyExpected({
        expected_outlet_id: 4,
        recorded_state: RECORDED.IN,
        punch_outlet_id: null,
        location_known: false,
      }),
      GAP.IN_LOCATION_UNKNOWN
    );
  });

  it("a known punch location with location_known false is still not credited", () => {
    // Belt and braces: if the flag says the place is not established, an outlet
    // id that happens to be present cannot override it.
    assert.equal(
      classifyExpected({ ...base, recorded_state: RECORDED.IN, location_known: false }),
      GAP.IN_LOCATION_UNKNOWN
    );
  });

  it("an ambiguous session is INDETERMINATE even when the punches read as IN", () => {
    assert.equal(
      classifyExpected({ ...base, recorded_state: RECORDED.IN, ambiguous_session: true }),
      GAP.INDETERMINATE
    );
  });

  it("an uninterpretable state is INDETERMINATE rather than guessed", () => {
    assert.equal(classifyExpected({ ...base, recorded_state: "SOMETHING_ELSE" }), GAP.INDETERMINATE);
  });

  it("an employee with no expected outlet is not counted as elsewhere - NOR as covered", () => {
    // There is nothing to compare against, so no location is matched. Calling
    // it COVERED, as this used to, let a missing employee outlet look like
    // verified cover of a location nobody had named.
    const verdict = classifyExpected({
      recorded_state: RECORDED.IN,
      expected_outlet_id: null,
      punch_outlet_id: 7,
      location_known: true,
    });
    assert.equal(verdict, GAP.EXPECTED_LOCATION_UNKNOWN);
    assert.notEqual(verdict, GAP.COVERED);
    assert.notEqual(verdict, GAP.IN_ELSEWHERE);
  });

  it("expected-outlet-unknown wins over punch-location-unknown, and both are gaps", () => {
    // The precedence only decides which fault is NAMED first; neither is ever
    // coverage. The employee record is the more fundamental fault, and the one a
    // manager can fix, so it is the one reported.
    assert.equal(
      classifyExpected({
        recorded_state: RECORDED.IN,
        expected_outlet_id: null,
        punch_outlet_id: null,
        location_known: false,
      }),
      GAP.EXPECTED_LOCATION_UNKNOWN
    );
  });

  it("ONLY a known, matching location is coverage", () => {
    // The whole rule in one assertion: of every combination of certainty, one
    // produces COVERED.
    const matrix = [
      [{ expected_outlet_id: 1, punch_outlet_id: 1, location_known: true }, GAP.COVERED],
      [{ expected_outlet_id: 1, punch_outlet_id: 2, location_known: true }, GAP.IN_ELSEWHERE],
      [{ expected_outlet_id: 1, punch_outlet_id: null, location_known: false }, GAP.IN_LOCATION_UNKNOWN],
      [{ expected_outlet_id: null, punch_outlet_id: 1, location_known: true }, GAP.EXPECTED_LOCATION_UNKNOWN],
      [{ expected_outlet_id: null, punch_outlet_id: null, location_known: false }, GAP.EXPECTED_LOCATION_UNKNOWN],
    ];
    matrix.forEach(([input, want]) => {
      assert.equal(
        classifyExpected({ ...input, recorded_state: RECORDED.IN }),
        want,
        JSON.stringify(input)
      );
    });
    assert.equal(
      matrix.filter(([, want]) => want === GAP.COVERED).length,
      1,
      "exactly one combination is coverage"
    );
  });
});

describe("the gap reconciles to the expected headcount", () => {
  it("covered plus every gap class equals expected", () => {
    const rows = [
      { gap_class: GAP.COVERED },
      { gap_class: GAP.COVERED },
      { gap_class: GAP.NO_CHECK_IN },
      { gap_class: GAP.RECORDED_OUT },
      { gap_class: GAP.IN_ELSEWHERE },
      { gap_class: GAP.INDETERMINATE },
    ];
    const r = reconcileGap(rows);
    assert.equal(r.expected, 6);
    assert.equal(r.recorded_in_at_expected, 2);
    assert.equal(r.gap, 4);
    assert.equal(r.reconciles, true);
    assert.equal(r.by_class.reduce((a, c) => a + c.count, 0), 4);
  });

  it("an employee lands in exactly one class, so nobody is double-counted", () => {
    const combos = [];
    [RECORDED.NONE, RECORDED.IN, RECORDED.OUT, "GARBAGE"].forEach((recorded_state) =>
      [null, 1, 2].forEach((punch_outlet_id) =>
        [true, false].forEach((location_known) =>
          combos.push({ recorded_state, punch_outlet_id, location_known, expected_outlet_id: 1 })
        )
      )
    );
    const classes = combos.map((c) => classifyExpected(c));
    classes.forEach((c) =>
      assert.ok([GAP.COVERED, ...GAP_CLASSES].includes(c), `undeclared class ${c}`)
    );
    const r = reconcileGap(classes.map((gap_class) => ({ gap_class })));
    assert.equal(r.reconciles, true);
    assert.equal(r.expected, combos.length);
  });

  it("an empty population reconciles trivially", () => {
    const r = reconcileGap([]);
    assert.equal(r.expected, 0);
    assert.equal(r.gap, 0);
    assert.equal(r.reconciles, true);
  });
});

describe("the next-hour outlook is a schedule, not a forecast", () => {
  const rostered = [
    { employee_id: 1, interval: dutyInterval(NINE_TO_NINE) },
    { employee_id: 2, interval: dutyInterval(NINE_TO_NINE) },
    { employee_id: 3, interval: dutyInterval(TEN_TO_TEN) },
    { employee_id: 4, interval: dutyInterval(TWO_TO_TEN) },
  ];

  it("names the next change and who finishes", () => {
    const out = upcomingTransitions(rostered, at(20, 30), 60);
    assert.equal(out.next_change_minute, 1260, "21:00");
    const t = out.transitions[0];
    assert.equal(t.finishing.length, 2, "both 9-9 employees finish");
    assert.equal(t.starting.length, 0);
    assert.equal(t.remaining.length, 2, "the 10-10 and 2-10 are still rostered");
  });

  it("names who starts", () => {
    const out = upcomingTransitions(rostered, at(13, 30), 60);
    assert.equal(out.next_change_minute, 840, "14:00");
    assert.equal(out.transitions[0].starting.length, 1);
  });

  it("ignores changes outside the window", () => {
    const out = upcomingTransitions(rostered, at(12, 0), 60);
    assert.equal(out.next_change_minute, null);
    assert.deepEqual(out.transitions, []);
  });

  it("a change exactly at the window edge is included; at 'now' it is already past", () => {
    // 20:00 + 60 reaches 21:00 exactly, so the 9-9 finish is in.
    assert.equal(upcomingTransitions(rostered, at(20, 0), 60).next_change_minute, 1260);

    // At 21:00 that transition has HAPPENED, so it is skipped - and the next
    // one is 22:00, when the 10-10 and 2-10 shifts finish.
    const atNine = upcomingTransitions(rostered, at(21, 0), 60);
    assert.equal(atNine.next_change_minute, 1320, "21:00 is past; 22:00 is next");
    assert.equal(atNine.transitions[0].finishing.length, 2);
    assert.equal(atNine.transitions[0].remaining.length, 0, "nobody is rostered past 22:00");
  });

  it("a window with no transition at all reports none", () => {
    const quiet = upcomingTransitions(rostered, at(22, 30), 60);
    assert.equal(quiet.next_change_minute, null);
    assert.deepEqual(quiet.transitions, []);
  });

  it("employees with no interval take no part", () => {
    const out = upcomingTransitions([...rostered, { employee_id: 5, interval: null }], at(20, 30), 60);
    assert.equal(out.transitions[0].finishing.length, 2);
  });
});

describe("formatting", () => {
  it("wraps a past-midnight minute onto the clock", () => {
    assert.equal(minuteToClock(540), "09:00");
    assert.equal(minuteToClock(1260), "21:00");
    assert.equal(minuteToClock(1500), "01:00", "an overnight shift's 25th hour");
    assert.equal(minuteToClock(null), null);
  });

  it("elapsed time is floored at zero and null when unknown", () => {
    assert.equal(elapsedSince(at(9), at(9, 35)), 35);
    assert.equal(elapsedSince(at(10), at(9)), 0);
    assert.equal(elapsedSince(null, at(9)), null);
  });
});

/* ==================================================================== */
/* WHICH SESSION DESCRIBES "NOW" - the cross-midnight selection.        */
/*                                                                      */
/* The defect: candidates were offered [today, yesterday] and whichever  */
/* was processed LAST with punches won, so yesterday overrode today.     */
/* ==================================================================== */

describe("an attendance session's ownership window", () => {
  it("runs to the cutoff of the FOLLOWING morning, on this date's own axis", () => {
    // A 04:00 cutoff means date D owns punches up to minute 1440 + 240.
    assert.equal(sessionOwnershipEnd(NINE_TO_NINE), 1680);
  });

  it("a rest day claims no part of the following morning", () => {
    assert.equal(sessionOwnershipEnd({ ...NINE_TO_NINE, is_working_day: false }), 1440);
  });

  it("no cutoff on record stops at midnight rather than running for ever", () => {
    assert.equal(sessionOwnershipEnd({ ...NINE_TO_NINE, attendance_day_cutoff: null }), 1440);
  });

  it("NO SNAPSHOT AT ALL is unknown, not closed", () => {
    // The opposite direction to `dayCloseMinute`, on purpose: calling an
    // unresolvable session closed would silently discard real punches, so the
    // caller is told it cannot tell and reports Indeterminate.
    assert.equal(sessionOwnershipEnd(null), null);
  });

  it("classifies a candidate as OPEN, CLOSED or UNKNOWN from that window", () => {
    const c = (nowMinute, snapshot = NINE_TO_NINE) => ({ snapshot, now_minute: nowMinute });
    assert.equal(sessionWindow(c(1500)), SESSION.OPEN, "01:00 the next morning, cutoff 04:00");
    assert.equal(sessionWindow(c(1700)), SESSION.CLOSED, "05:20, past the cutoff");
    assert.equal(sessionWindow(c(1500, null)), SESSION.UNKNOWN);
  });
});

describe("selecting the session that describes an employee now", () => {
  /** A candidate for `date`, with punches given as minutes on its own axis. */
  const candidate = (date, nowMinute, minutes, snapshot = NINE_TO_NINE) => ({
    attendance_date: date,
    snapshot,
    now_minute: nowMinute,
    punches: minutes.map((m, i) => ({ punch_id: `${date}-${i}`, minute: m })),
  });

  const TODAY = "2026-09-13";
  const YESTERDAY = "2026-09-12";

  it("on duty: that duty's session, and no other", () => {
    const active = candidate(YESTERDAY, 1500, [1320]); // night shift, IN at 22:00
    const chosen = selectSession([candidate(TODAY, 60, []), active], { active });
    assert.equal(chosen.candidate, active);
    assert.equal(chosen.reason, "ACTIVE_DUTY");
    assert.equal(chosen.ambiguous, false);
  });

  it("yesterday complete and nothing today: no session, which is not IN", () => {
    // 14:00 today. Yesterday's window closed at 05:20 this morning.
    const chosen = selectSession([
      candidate(TODAY, 840, []),
      candidate(YESTERDAY, 840 + 1440, [540, 1260]),
    ]);
    assert.equal(chosen.candidate, null);
    assert.equal(chosen.reason, "NO_OPEN_SESSION");
  });

  it("YESTERDAY'S UNMATCHED IN IS NOT CARRIED once its session has closed", () => {
    // The single IN is real, and yesterday's attendance day is over. At 14:00
    // today the employee is not "recorded IN" - that claim belonged to a day
    // that has finished, and repeating it today is the defect.
    const chosen = selectSession([
      candidate(TODAY, 840, []),
      candidate(YESTERDAY, 840 + 1440, [540]),
    ]);
    assert.equal(chosen.candidate, null, "a closed session describes nothing about now");
  });

  it("today's NEWER OUT beats an unrelated yesterday IN", () => {
    // This is the ordering defect stated as a test. Yesterday is offered second
    // and has punches; it must not win.
    const today = candidate(TODAY, 840, [540, 780]); // IN 09:00, OUT 13:00 -> OUT
    const chosen = selectSession([today, candidate(YESTERDAY, 840 + 1440, [540])]);
    assert.equal(chosen.candidate, today);
    assert.equal(recordedStateAsOf(chosen.candidate.punches, chosen.candidate.now_minute).state, RECORDED.OUT);
  });

  it("an early arrival before today's shift start uses TODAY'S session", () => {
    // 08:30, punched IN at 08:20. Yesterday is closed; today is open and has
    // the punch.
    const today = candidate(TODAY, 510, [500]);
    const chosen = selectSession([today, candidate(YESTERDAY, 510 + 1440, [540, 1260])]);
    assert.equal(chosen.candidate, today);
    assert.equal(recordedStateAsOf(today.punches, today.now_minute).state, RECORDED.IN);
  });

  it("an overnight shift still running after midnight reads its own session", () => {
    // 01:30. The night shift started 22:00 yesterday and runs to 06:00, so the
    // active-duty path selects yesterday - correctly, and by duty rather than
    // by recency.
    const active = { ...candidate(YESTERDAY, 1530, [1320], NIGHT), interval: { start: 1320, end: 1800 } };
    const chosen = selectSession([candidate(TODAY, 90, []), active], { active });
    assert.equal(chosen.candidate.attendance_date, YESTERDAY);
    assert.equal(recordedStateAsOf(chosen.candidate.punches, chosen.candidate.now_minute).state, RECORDED.IN);
  });

  it("punches split across midnight stay in the session that owns them", () => {
    // 02:00. The engine dated the 00:30 punch to YESTERDAY (before the 04:00
    // cutoff), so it is minute 1470 of yesterday's axis and pairs with the
    // 22:00 IN. One session, two punches, state OUT.
    const yesterday = candidate(YESTERDAY, 1560, [1320, 1470], NIGHT);
    const chosen = selectSession([candidate(TODAY, 120, []), yesterday]);
    assert.equal(chosen.candidate, yesterday, "yesterday's window is open until 04:00");
    assert.equal(recordedStateAsOf(yesterday.punches, 1560).state, RECORDED.OUT);
  });

  it("a delayed punch inside the open window is attributed to that session", () => {
    // 03:00. A punch arriving at 02:50 belongs to yesterday by the cutoff rule,
    // and yesterday is still the session that owns it.
    const yesterday = candidate(YESTERDAY, 1620, [1320, 1610], NIGHT);
    const chosen = selectSession([candidate(TODAY, 180, []), yesterday]);
    assert.equal(chosen.candidate.attendance_date, YESTERDAY);
    assert.equal(chosen.reason, "OPEN_SESSION");
  });

  it("an unresolvable session with punches is AMBIGUOUS, never IN", () => {
    // No snapshot means no cutoff means we cannot say whether this session still
    // owns its punches. The honest answer is "cannot tell".
    const chosen = selectSession([
      candidate(TODAY, 840, []),
      { attendance_date: YESTERDAY, snapshot: null, now_minute: 2280, punches: [{ punch_id: "x", minute: 540 }] },
    ]);
    assert.equal(chosen.ambiguous, true);
    assert.equal(chosen.reason, "SESSION_OWNERSHIP_UNKNOWN");
    assert.equal(
      classifyExpected({
        recorded_state: RECORDED.IN,
        expected_outlet_id: 1,
        punch_outlet_id: 1,
        ambiguous_session: chosen.ambiguous,
      }),
      GAP.INDETERMINATE
    );
  });

  it("a definite open session today outranks an ambiguous one yesterday", () => {
    const today = candidate(TODAY, 840, [540]);
    const chosen = selectSession([
      today,
      { attendance_date: YESTERDAY, snapshot: null, now_minute: 2280, punches: [{ punch_id: "x", minute: 540 }] },
    ]);
    assert.equal(chosen.candidate, today);
    assert.equal(chosen.ambiguous, false);
  });

  it("punches after the snapshot minute do not make a session current", () => {
    // A punch recorded at 15:00 cannot be counted at 14:00, so this session has
    // nothing "so far" and is not selected.
    const chosen = selectSession([candidate(TODAY, 840, [900])]);
    assert.equal(chosen.candidate, null);
  });
});

/* ==================================================================== */
/* ONE SHARED AXIS, and the window edges of the next-hour view.          */
/* ==================================================================== */

describe("putting intervals from different dates on one axis", () => {
  it("shifts an interval by whole days without touching its length", () => {
    const night = dutyInterval(NIGHT); // 1320 -> 1800 on yesterday's axis
    const onToday = shiftInterval(night, -1440);
    assert.deepEqual(onToday, { start: -120, end: 360 }, "22:00 yesterday is minute -120 today");
    assert.equal(onToday.end - onToday.start, night.end - night.start);
  });

  it("leaves a missing interval missing", () => {
    assert.equal(shiftInterval(null, -1440), null);
  });
});

describe("the next-hour window edges", () => {
  const row = (id, start, end, over = {}) => ({
    employee_id: id,
    interval: { start, end },
    designation_name: "Cashier",
    outlet_name: "Moolakulam",
    ...over,
  });

  it("INCLUDES a change exactly at the +60 minute boundary", () => {
    // The window is "the next 60 minutes", so 60 minutes away is inside it.
    const out = upcomingTransitions([row(1, 600, 1320)], 540, 60);
    assert.equal(out.next_change_minute, 600);
    assert.equal(out.transitions[0].starting.length, 1);
  });

  it("EXCLUDES a change one minute past it", () => {
    assert.equal(upcomingTransitions([row(1, 601, 1320)], 540, 60).next_change_minute, null);
  });

  it("excludes a change at this very minute - it has happened", () => {
    assert.equal(upcomingTransitions([row(1, 540, 1320)], 540, 60).next_change_minute, null);
  });

  it("a start and a finish at the SAME minute are one transition with both", () => {
    const out = upcomingTransitions([row(1, 600, 1320), row(2, 300, 600)], 540, 60);
    assert.equal(out.transitions.length, 1);
    assert.equal(out.transitions[0].minute, 600);
    assert.equal(out.transitions[0].starting.length, 1);
    assert.equal(out.transitions[0].finishing.length, 1);
    // Remaining counts the starter and not the finisher: start is inclusive,
    // end is exclusive, at the same instant.
    assert.equal(out.transitions[0].remaining.length, 1);
    assert.equal(out.transitions[0].remaining[0].employee_id, 1);
  });

  it("a shift STARTING soon appears even though it is not yet active", () => {
    // 09:30. The 10-10 shift has not begun, so it is not in Expected Now - and
    // it is exactly what this view is for. The defect fed only Expected Now.
    const out = upcomingTransitions([row(2, 600, 1320)], 570, 60);
    assert.equal(out.next_change_minute, 600, "10:00");
    assert.equal(out.transitions[0].starting.length, 1);
  });

  it("counts an overnight interval that ends after midnight on the shared axis", () => {
    // The night shift sits at -120 -> 360 once converted onto today's axis, so
    // its 06:00 finish is minute 360 and is found from 05:30.
    const night = row(3, -120, 360);
    const out = upcomingTransitions([night], 330, 60);
    assert.equal(out.next_change_minute, 360);
    assert.equal(out.transitions[0].finishing.length, 1);
    assert.equal(out.transitions[0].remaining.length, 0);
  });
});

/* ==================================================================== */
/* Reconciliation with the two new location classes in play.             */
/* ==================================================================== */

describe("reconciliation with location certainty separated out", () => {
  const rows = [
    { gap_class: GAP.COVERED },
    { gap_class: GAP.COVERED },
    { gap_class: GAP.NO_CHECK_IN },
    { gap_class: GAP.RECORDED_OUT },
    { gap_class: GAP.IN_ELSEWHERE },
    { gap_class: GAP.IN_LOCATION_UNKNOWN },
    { gap_class: GAP.EXPECTED_LOCATION_UNKNOWN },
    { gap_class: GAP.INDETERMINATE },
  ];

  it("still adds up: covered plus every gap class equals expected", () => {
    const t = reconcileGap(rows);
    assert.equal(t.expected, 8);
    assert.equal(t.recorded_in_at_expected, 2);
    assert.equal(t.gap, 6);
    assert.equal(t.reconciles, true);
  });

  it("reports IN-without-location-credit separately and never inside coverage", () => {
    const t = reconcileGap(rows);
    assert.equal(t.recorded_in_location_unverified, 3, "elsewhere + location unknown + no outlet");
    assert.equal(t.recorded_in_somewhere, 5);
    assert.equal(t.recorded_in_at_expected, 2, "the location figure did not leak into cover");
  });

  it("the three uncredited classes are exactly the ones named", () => {
    assert.deepEqual([...IN_WITHOUT_LOCATION_CREDIT].sort(), [
      GAP.EXPECTED_LOCATION_UNKNOWN,
      GAP.IN_ELSEWHERE,
      GAP.IN_LOCATION_UNKNOWN,
    ].sort());
    assert.ok(!IN_WITHOUT_LOCATION_CREDIT.includes(GAP.COVERED));
  });

  it("every gap class is in the breakdown, so none can be lost", () => {
    const t = reconcileGap(rows);
    assert.deepEqual(t.by_class.map((c) => c.key), [...GAP_CLASSES]);
    assert.equal(t.by_class.reduce((a, c) => a + c.count, 0), t.gap);
  });
});
