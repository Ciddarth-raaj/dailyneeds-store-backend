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
  RECORDED,
  activeDuty,
  classifyExpected,
  dutyInterval,
  elapsedSince,
  minuteToClock,
  onDutyAt,
  recordedStateAsOf,
  reconcileGap,
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

  it("an unmapped terminal does not manufacture a cross-location finding", () => {
    assert.equal(
      classifyExpected({
        ...base,
        recorded_state: RECORDED.IN,
        punch_outlet_id: null,
        location_known: false,
      }),
      GAP.COVERED,
      "the STATE is known even when the terminal's location is not"
    );
  });

  it("an uninterpretable state is INDETERMINATE rather than guessed", () => {
    assert.equal(classifyExpected({ ...base, recorded_state: "SOMETHING_ELSE" }), GAP.INDETERMINATE);
  });

  it("an employee with no expected outlet is not counted as elsewhere", () => {
    assert.equal(
      classifyExpected({
        recorded_state: RECORDED.IN,
        expected_outlet_id: null,
        punch_outlet_id: 7,
        location_known: true,
      }),
      GAP.COVERED
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
