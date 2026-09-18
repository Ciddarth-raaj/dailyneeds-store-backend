/**
 * EXTRA BREAK HOURS - the regression matrix.
 *
 * The setting is one number on the Employee Master that is ADDED to the
 * break the day's shift already allows, and it is credited on a day with
 * FOUR OR MORE punches and on no other kind of day. The cases below are the
 * ones the task names, in its order, plus the guardrails: a two-punch day is
 * calculated exactly as it is today, and so is a day where the value is null
 * or zero.
 *
 * Deterministic throughout: fixed punches, fixed shift, no clock, no
 * database.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { CALC_STATUS, PUNCH_SOURCE, calculateAttendanceDay } = require("./attendance_engine");
const { buildShiftSnapshot } = require("./shiftResolution");
const { extraBreakMinutes, parseExtraBreakHours } = require("./employee_extra_break");

const DATE = "2026-09-14"; // a Monday

/** A 12 hour shift with a 1 hour break - the task's own example. */
function shift({ break_minutes = 60 } = {}) {
  return buildShiftSnapshot(
    {
      work_shift_id: 7,
      work_shift_weekly_schedule_id: 71,
      is_working_day: 1,
      in_time: "09:00",
      out_time: "21:00",
      attendance_day_cutoff: "04:00",
      break_minutes,
      ot_rate: 1,
    },
    { work_shift_id: 7, shift_code: "GEN", overtime_allowed: 1 },
    1
  );
}

function punches(...times) {
  return times.map((t, i) => ({
    punch_id: 1000 + i,
    source: PUNCH_SOURCE.BIOMAX,
    io_time: `${DATE} ${t}:00`,
  }));
}

const day = (overrides) =>
  calculateAttendanceDay({
    employee_id: 42,
    attendance_date: DATE,
    shift: shift(),
    punches: [],
    ...overrides,
  });

/* ============================================ reading the stored column === */

describe("the stored hours become whole minutes, once", () => {
  it("half an hour is thirty minutes", () => {
    assert.equal(extraBreakMinutes({ extra_break_hours: 0.5 }), 30);
    // DECIMAL arrives from the driver as a string.
    assert.equal(extraBreakMinutes({ extra_break_hours: "0.50" }), 30);
    assert.equal(extraBreakMinutes({ extra_break_hours: "1.25" }), 75);
  });

  it("null, blank, zero, a missing row and nonsense are all nothing extra", () => {
    assert.equal(extraBreakMinutes({ extra_break_hours: null }), 0);
    assert.equal(extraBreakMinutes({ extra_break_hours: "" }), 0);
    assert.equal(extraBreakMinutes({ extra_break_hours: 0 }), 0);
    assert.equal(extraBreakMinutes({}), 0);
    assert.equal(extraBreakMinutes(null), 0);
    assert.equal(extraBreakMinutes({ extra_break_hours: "not a number" }), 0);
  });

  it("never shortens a break: a corrupt negative credits nothing rather than deducting", () => {
    assert.equal(extraBreakMinutes({ extra_break_hours: -2 }), 0);
  });
});

describe("what may be saved", () => {
  it("blank clears the field, and clearing is not an error", () => {
    assert.deepEqual(parseExtraBreakHours(""), { ok: true, value: null });
    assert.deepEqual(parseExtraBreakHours(null), { ok: true, value: null });
    assert.deepEqual(parseExtraBreakHours(undefined), { ok: true, value: null });
  });

  it("decimals are kept to the column's two places", () => {
    assert.deepEqual(parseExtraBreakHours(0.5), { ok: true, value: 0.5 });
    assert.deepEqual(parseExtraBreakHours("1.256"), { ok: true, value: 1.26 });
    assert.deepEqual(parseExtraBreakHours(0), { ok: true, value: 0 });
  });

  it("a negative, a non-number and more than a day are refused", () => {
    assert.equal(parseExtraBreakHours(-1).ok, false);
    assert.equal(parseExtraBreakHours("half").ok, false);
    assert.equal(parseExtraBreakHours(48).ok, false);
  });
});

/* ====================================================== the calculation === */

describe("2 punches: the extra break is ignored entirely", () => {
  it("a 12 hour two-punch day with 0.5h extra is the unchanged 660 worked minutes", () => {
    const withExtra = day({ punches: punches("09:00", "21:00"), extra_break_minutes: 30 });
    const without = day({ punches: punches("09:00", "21:00") });

    assert.equal(withExtra.punch_count, 2);
    assert.equal(withExtra.break_allowance_minutes, 60);
    assert.equal(withExtra.break_allowance_source, "SHIFT");
    assert.equal(withExtra.extra_break_minutes_applied, 0);
    assert.equal(withExtra.nrm_minutes, 660);
    assert.equal(withExtra.break_charged_minutes, 60);
    assert.equal(withExtra.worked_minutes, 660);
    assert.equal(withExtra.shortage_minutes, 0);
    assert.ok(withExtra.notes.some((n) => /extra break hours not applied/i.test(n)));

    // Identical to the day without the setting, field for field.
    for (const k of ["nrm_minutes", "break_charged_minutes", "worked_minutes", "shortage_minutes", "candidate_ot_minutes"]) {
      assert.equal(withExtra[k], without[k], k);
    }
  });

  it("the two-punch phased break rule still phases in over the hour after six", () => {
    const result = day({ punches: punches("09:00", "15:30"), extra_break_minutes: 30 });
    assert.equal(result.break_charged_minutes, 30); // span 390 - 360, not 90
    assert.equal(result.worked_minutes, 360);
  });
});

describe("4 punches with an extra break of 0 or null: identical to today", () => {
  const PUNCHES = punches("09:00", "13:00", "14:00", "21:00");

  it("null, 0 and absent all produce the same row", () => {
    const base = day({ punches: PUNCHES });
    for (const value of [null, 0, undefined, ""]) {
      const result = day({ punches: PUNCHES, extra_break_minutes: value });
      assert.equal(result.break_allowance_minutes, 60);
      assert.equal(result.break_allowance_source, "SHIFT");
      assert.equal(result.extra_break_minutes_applied, 0);
      assert.equal(result.nrm_minutes, base.nrm_minutes);
      assert.equal(result.worked_minutes, base.worked_minutes);
      assert.equal(result.shortage_minutes, base.shortage_minutes);
      assert.equal(result.notes.length, base.notes.length);
    }
  });
});

describe("4 punches: shift break 1h + extra 0.5h = 1.5h permitted", () => {
  it("the permitted break is 90 minutes and the effective NRM is 10.5 hours", () => {
    const result = day({
      punches: punches("09:00", "13:00", "14:30", "21:00"), // a 90 minute gap
      extra_break_minutes: 30,
    });

    assert.equal(result.break_allowance_minutes, 90);
    assert.equal(result.extra_break_minutes_applied, 30);
    assert.equal(result.break_allowance_source, "EMPLOYEE_OVERRIDE");
    assert.equal(result.nrm_minutes, 630); // 720 span - 90 = 10.5 hours
    // The actual OUT -> IN gap is still what is charged.
    assert.equal(result.actual_gap_minutes, 90);
    assert.equal(result.break_charged_minutes, 90);
    assert.equal(result.worked_minutes, 630);
    assert.equal(result.shortage_minutes, 0);
    assert.equal(result.status, CALC_STATUS.FINAL);
  });

  it("the Shift Master's own break is untouched - only this day's allowance moved", () => {
    const snapshot = shift();
    const result = calculateAttendanceDay({
      employee_id: 42,
      attendance_date: DATE,
      shift: snapshot,
      punches: punches("09:00", "13:00", "14:30", "21:00"),
      extra_break_minutes: 30,
    });
    assert.equal(snapshot.break_minutes, 60);
    assert.equal(result.break_allowance_minutes, 90);
  });
});

describe("4 punches: only the EXCESS over the combined allowance is short", () => {
  it("a 2 hour break against a 1.5 hour allowance is short by exactly 30 minutes", () => {
    const result = day({
      punches: punches("09:00", "13:00", "15:00", "21:00"), // a 120 minute gap
      extra_break_minutes: 30,
    });

    assert.equal(result.actual_gap_minutes, 120);
    assert.equal(result.break_charged_minutes, 120);
    assert.equal(result.nrm_minutes, 630);
    assert.equal(result.worked_minutes, 600);
    assert.equal(result.shortage_minutes, 30);
    assert.equal(result.candidate_ot_minutes, 0);
  });

  it("without the extra half hour the same day is short by 60 - the extra covered 30 of it", () => {
    const result = day({ punches: punches("09:00", "13:00", "15:00", "21:00") });
    assert.equal(result.nrm_minutes, 660);
    assert.equal(result.shortage_minutes, 60);
  });
});

describe("4 punches: a break shorter than the combined allowance keeps today's OT rule", () => {
  it("a 30 minute break against a 1.5 hour allowance is 60 surplus minutes, priced as ordinary OT", () => {
    const result = day({
      punches: punches("09:00", "13:00", "13:30", "21:00"), // a 30 minute gap
      extra_break_minutes: 30,
    });

    assert.equal(result.break_charged_minutes, 30);
    assert.equal(result.nrm_minutes, 630);
    assert.equal(result.worked_minutes, 690);
    assert.equal(result.shortage_minutes, 0);
    // The SAME rule as today: surplus over NRM is candidate OT, and no new
    // kind of overtime was invented for the unused extra break.
    const withoutExtra = day({ punches: punches("09:00", "13:00", "13:30", "21:00") });
    assert.equal(withoutExtra.candidate_ot_minutes + 30, result.candidate_ot_minutes);
  });
});

describe("more than four punches", () => {
  it("every OUT -> IN gap is summed and the extra break is credited once", () => {
    const result = day({
      punches: punches("09:00", "11:00", "11:15", "14:00", "14:15", "18:00", "18:15", "21:00"),
      extra_break_minutes: 30,
    });

    assert.equal(result.punch_count, 8);
    assert.equal(result.actual_gap_minutes, 45);
    assert.equal(result.break_allowance_minutes, 90);
    assert.equal(result.extra_break_minutes_applied, 30);
    assert.equal(result.nrm_minutes, 630);
    assert.equal(result.worked_minutes, 675);
    assert.equal(result.shortage_minutes, 0);
  });
});

describe("the days that are not four-punch days", () => {
  it("an absent day and an odd-punch day never carry the extra break", () => {
    assert.equal(day({ punches: [], extra_break_minutes: 30 }).break_allowance_source, "SHIFT");
    assert.equal(day({ punches: [], extra_break_minutes: 30 }).extra_break_minutes_applied, 0);

    const odd = day({ punches: punches("09:00", "13:00", "14:00"), extra_break_minutes: 30 });
    assert.equal(odd.break_allowance_source, "SHIFT");
    assert.equal(odd.extra_break_minutes_applied, 0);
    assert.equal(odd.nrm_minutes, 660);
    assert.equal(odd.is_final, false);
  });
});

describe("the extra break rides ON TOP of the special break override", () => {
  it("a 90 minute override plus 0.5h extra permits 120 minutes and makes NRM 600", () => {
    const result = day({
      punches: punches("09:00", "13:00", "15:00", "21:00"),
      break_override_minutes: 90,
      extra_break_minutes: 30,
    });
    assert.equal(result.break_allowance_minutes, 120);
    assert.equal(result.nrm_minutes, 600);
    assert.equal(result.shortage_minutes, 0);
  });
});

/* ============================ the sequence must be COMPLETE, not merely 4+ */

describe("only a COMPLETE punched sequence is credited", () => {
  const EXTRA = 30;

  /** n punches, alternating IN/OUT, inside a 09:00-21:00 shift. */
  const sequence = (n) => {
    const times = ["09:00"];
    // Each extra pair adds a short break and a return, so every count below
    // is a real stream a device could produce rather than a contrivance.
    const middles = ["11:00", "11:15", "14:00", "14:15", "17:00", "17:15"];
    for (let i = 0; i < n - 2; i += 1) times.push(middles[i]);
    times.push("21:00");
    return punches(...times);
  };

  it("4 punches: applied", () => {
    const result = day({ punches: sequence(4), extra_break_minutes: EXTRA });
    assert.equal(result.punch_count, 4);
    assert.equal(result.extra_break_minutes_applied, 30);
    assert.equal(result.break_allowance_minutes, 90);
    assert.equal(result.break_allowance_source, "EMPLOYEE_OVERRIDE");
    assert.equal(result.nrm_minutes, 630);
    assert.equal(result.status, CALC_STATUS.FINAL);
  });

  it("5 punches: NOT applied, and the day is still a missing-punch review", () => {
    const result = day({ punches: sequence(5), extra_break_minutes: EXTRA });
    assert.equal(result.punch_count, 5);
    assert.equal(result.extra_break_minutes_applied, 0);
    assert.equal(result.break_allowance_minutes, 60, "the shift's own break, unextended");
    assert.equal(result.break_allowance_source, "SHIFT");
    assert.equal(result.nrm_minutes, 660);
    assert.equal(result.status, CALC_STATUS.REVIEW_REQUIRED);
    assert.deepEqual(result.review_reasons, ["MISSING_PUNCH"]);
    assert.equal(result.is_final, false);
  });

  it("6 punches: applied", () => {
    const result = day({ punches: sequence(6), extra_break_minutes: EXTRA });
    assert.equal(result.punch_count, 6);
    assert.equal(result.extra_break_minutes_applied, 30);
    assert.equal(result.break_allowance_minutes, 90);
    assert.equal(result.nrm_minutes, 630);
    assert.equal(result.status, CALC_STATUS.FINAL);
  });

  it("7 punches: NOT applied, and the day is still a missing-punch review", () => {
    const result = day({ punches: sequence(7), extra_break_minutes: EXTRA });
    assert.equal(result.punch_count, 7);
    assert.equal(result.extra_break_minutes_applied, 0);
    assert.equal(result.break_allowance_minutes, 60);
    assert.equal(result.break_allowance_source, "SHIFT");
    assert.equal(result.nrm_minutes, 660);
    assert.equal(result.status, CALC_STATUS.REVIEW_REQUIRED);
    assert.deepEqual(result.review_reasons, ["MISSING_PUNCH"]);
  });

  it("8 punches: applied", () => {
    const result = day({ punches: sequence(8), extra_break_minutes: EXTRA });
    assert.equal(result.punch_count, 8);
    assert.equal(result.extra_break_minutes_applied, 30);
    assert.equal(result.nrm_minutes, 630);
    assert.equal(result.status, CALC_STATUS.FINAL);
  });

  it("0, 1, 2 and 3 punches are never credited either", () => {
    for (const n of [0, 1, 2, 3]) {
      const list = n === 0 ? [] : sequence(Math.max(n, 2)).slice(0, n);
      const result = day({ punches: list, extra_break_minutes: EXTRA });
      assert.equal(result.extra_break_minutes_applied, 0, `${n} punches`);
      assert.equal(result.break_allowance_source, "SHIFT", `${n} punches`);
    }
  });

  it("an odd day's figures are identical with and without the setting", () => {
    const withExtra = day({ punches: sequence(5), extra_break_minutes: EXTRA });
    const without = day({ punches: sequence(5) });
    for (const k of ["nrm_minutes", "break_allowance_minutes", "span_minutes", "status", "is_final"]) {
      assert.equal(withExtra[k], without[k], k);
    }
  });
});

/* ================= an impossible value can never make a payable zero-NRM = */

describe("the permitted break may never swallow the shift", () => {
  // A 12 hour shift with a 1 hour break. An extra 11 hours takes the
  // permitted break to the whole span; 12 takes it past.
  const FOUR = () => punches("09:00", "13:00", "14:00", "21:00");

  it("an extra break that would leave NRM at zero is a review, not a calculation", () => {
    const result = day({ punches: FOUR(), extra_break_minutes: 11 * 60 });

    assert.equal(result.status, CALC_STATUS.REVIEW_REQUIRED);
    assert.deepEqual(result.review_reasons, ["BREAK_EXCEEDS_SHIFT"]);
    assert.equal(result.is_final, false);
    // NOT capped, and not applied: the row carries the day's own unextended
    // allowance, so nobody reads a permitted break the shift cannot give.
    assert.equal(result.extra_break_minutes_applied, 0);
    assert.equal(result.break_allowance_minutes, 60);
    assert.equal(result.break_allowance_source, "SHIFT");
    assert.ok(result.notes.some((n) => /leaving no working minutes/.test(n)));
  });

  it("an extra break longer than the shift is the same review", () => {
    const result = day({ punches: FOUR(), extra_break_minutes: 12 * 60 });
    assert.equal(result.status, CALC_STATUS.REVIEW_REQUIRED);
    assert.deepEqual(result.review_reasons, ["BREAK_EXCEEDS_SHIFT"]);
    assert.equal(result.is_final, false);
  });

  it("NO OT and NO settled minutes can come out of it", () => {
    const result = day({ punches: FOUR(), extra_break_minutes: 11 * 60 });
    assert.equal(result.candidate_ot_minutes, 0);
    assert.equal(result.approved_ot_minutes, 0);
    assert.equal(result.worked_minutes, 0);
    assert.equal(result.shortage_minutes, 0);
    assert.notEqual(result.status, CALC_STATUS.FINAL);
  });

  it("a day that is not final is held out of payroll, so nothing is priced", () => {
    const result = day({ punches: FOUR(), extra_break_minutes: 11 * 60 });
    // The rule `utils/attendance_payroll.js` applies: is_final !== true means
    // the date is HELD - its shortage and OT never reach the month.
    assert.equal(result.is_final, false);
  });

  it("the override alone can still leave NRM at zero: this guard is the extra break's", () => {
    // A 12 hour override on a 12 hour shift is existing behaviour and is NOT
    // changed here - reported to the reviewer rather than silently widened.
    const result = day({ punches: FOUR(), break_override_minutes: 12 * 60 });
    assert.equal(result.nrm_minutes, 0);
    assert.equal(result.status, CALC_STATUS.FINAL);
  });

  it("the invariant is checked against the DAY's span, so a later shift change catches it", () => {
    // The same 1.5h total allowance is fine on a 12 hour shift and impossible
    // on a 90 minute one - the engine decides per date, not per saved value.
    const ok = day({ punches: FOUR(), extra_break_minutes: 30 });
    assert.equal(ok.status, CALC_STATUS.FINAL);

    const shortShift = calculateAttendanceDay({
      employee_id: 42,
      attendance_date: DATE,
      shift: buildShiftSnapshot(
        {
          work_shift_id: 7,
          work_shift_weekly_schedule_id: 71,
          is_working_day: 1,
          in_time: "09:00",
          out_time: "10:30",
          attendance_day_cutoff: "04:00",
          break_minutes: 60,
          ot_rate: 1,
        },
        { work_shift_id: 7, shift_code: "GEN", overtime_allowed: 1 },
        1
      ),
      punches: punches("09:00", "09:20", "09:30", "10:30"),
      extra_break_minutes: 30,
    });
    assert.equal(shortShift.status, CALC_STATUS.REVIEW_REQUIRED);
    assert.deepEqual(shortShift.review_reasons, ["BREAK_EXCEEDS_SHIFT"]);
  });

  it("an impossible value on a day that never credits it changes nothing", () => {
    // Two punches: the extra break is ignored entirely, so there is no
    // configuration fault to raise and the settled two-punch day stands.
    const two = day({ punches: punches("09:00", "21:00"), extra_break_minutes: 12 * 60 });
    assert.equal(two.status, CALC_STATUS.FINAL);
    assert.equal(two.nrm_minutes, 660);
    assert.equal(two.break_allowance_minutes, 60);

    const odd = day({ punches: punches("09:00", "13:00", "14:00"), extra_break_minutes: 12 * 60 });
    assert.deepEqual(odd.review_reasons, ["MISSING_PUNCH"]);
  });
});

/* ======================================= how the fault reaches the screens */

describe("the configuration fault is routed like the other configuration faults", () => {
  const { dayIssueKey, ISSUE_KEY } = require("./attendance_dashboard");

  it("reads as a Shift Setup issue rather than a sixth issue key", () => {
    const result = day({
      punches: punches("09:00", "13:00", "14:00", "21:00"),
      extra_break_minutes: 11 * 60,
    });
    assert.equal(dayIssueKey(result), ISSUE_KEY.SHIFT_SETUP);
  });

  it("a five-punch day is still a Missing Punch, not a setup issue", () => {
    const result = day({
      punches: punches("09:00", "13:00", "14:00", "17:00", "21:00"),
      extra_break_minutes: 30,
    });
    assert.equal(dayIssueKey(result), ISSUE_KEY.MISSING_PUNCH);
  });
});

/* ============================================ the version history is audit */

describe("the calculation version history is not rewritten", () => {
  const fs = require("fs");
  const path = require("path");
  const source = fs.readFileSync(path.join(__dirname, "attendance_engine.js"), "utf8");
  const history = source.slice(source.indexOf(" *   1  Attendance v2 as approved."), source.indexOf("const CALCULATION_VERSION"));

  it("version 4 describes only what version 4 introduced", () => {
    const four = history.slice(history.indexOf(" *   4 "), history.indexOf(" *   5 "));
    assert.match(four, /employee break override applies only on a day with four or more/);
    assert.ok(!/Extra Break/i.test(four), "a later rule must never be backdated into an earlier version");
  });

  it("Extra Break Hours is described under version 7, and version 7 is still about it", () => {
    const seven = history.slice(history.indexOf(" *   7 "), history.indexOf(" *   8 "));
    assert.match(seven, /Extra Break Hours/);
    assert.ok(!/override/i.test(seven), "version 8's correction is not backdated into version 7");
  });

  it("version 8 is the override's complete-sequence correction, and the version is 8", () => {
    const eight = history.slice(history.indexOf(" *   8 "));
    assert.match(eight, /override/i);
    assert.match(eight, /even number/i);
    assert.match(eight, /MISSING_PUNCH/);
    assert.match(source, /const CALCULATION_VERSION = 8;/);
  });
});
