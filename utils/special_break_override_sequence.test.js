/**
 * THE SPECIAL BREAK DURATION OVERRIDE now needs a COMPLETE punched sequence.
 *
 *   node --test utils/special_break_override_sequence.test.js
 *
 * The override asked only for `length >= 4`, so a five- or seven-punch day -
 * a day the engine itself reports as MISSING_PUNCH, whose every figure is
 * provisional until the missing punch is supplied - was charged the employee's
 * personal break anyway. Extra Break Hours already required four or more AND
 * an even count; the two conditions are now one predicate, and this file is
 * the matrix for it.
 *
 * Deterministic: fixed punches, a fixed 12-hour shift with a 1-hour break, no
 * clock and no database.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { CALC_STATUS, PUNCH_SOURCE, calculateAttendanceDay } = require("./attendance_engine");
const { buildShiftSnapshot } = require("./shiftResolution");

const DATE = "2026-09-14"; // a Monday
const OVERRIDE = 90; // the employee's own break, replacing the shift's 60
const EXTRA = 30; // half an hour of Extra Break Hours, added on top

const shift = () =>
  buildShiftSnapshot(
    {
      work_shift_id: 7,
      work_shift_weekly_schedule_id: 71,
      is_working_day: 1,
      in_time: "09:00",
      out_time: "21:00",
      attendance_day_cutoff: "04:00",
      break_minutes: 60,
      ot_rate: 1,
    },
    { work_shift_id: 7, shift_code: "GEN", overtime_allowed: 1 },
    1
  );

const punches = (...times) =>
  times.map((t, i) => ({
    punch_id: 1000 + i,
    source: PUNCH_SOURCE.BIOMAX,
    io_time: `${DATE} ${t}:00`,
  }));

const day = (overrides) =>
  calculateAttendanceDay({
    employee_id: 42,
    attendance_date: DATE,
    shift: shift(),
    punches: [],
    ...overrides,
  });

/**
 * n punches inside the shift, alternating OUT/IN in the middle - a stream a
 * device could really produce, not a contrivance.
 */
const sequence = (n) => {
  if (n === 0) return [];
  const middles = ["11:00", "11:15", "14:00", "14:15", "17:00", "17:15"];
  const times = ["09:00", ...middles.slice(0, Math.max(0, n - 2)), "21:00"];
  return punches(...times.slice(0, n));
};

/** What an incomplete day must look like, whatever is configured on it. */
const assertUnextended = (result, label) => {
  assert.equal(result.break_allowance_minutes, 60, `${label}: the shift's own break`);
  assert.equal(result.break_allowance_source, "SHIFT", `${label}: source`);
  assert.equal(result.break_override_minutes_applied, null, `${label}: no override applied`);
  assert.equal(result.extra_break_minutes_applied, 0, `${label}: nothing extra applied`);
  assert.equal(result.nrm_minutes, 660, `${label}: NRM from the shift's break`);
  assert.equal(result.is_final, false, `${label}: not final`);
  assert.equal(result.status, CALC_STATUS.REVIEW_REQUIRED, `${label}: status`);
  assert.deepEqual(result.review_reasons, ["MISSING_PUNCH"], `${label}: reason`);
};

/* ========================================== the override on its own ======= */

describe("the override applies to a complete sequence and to nothing else", () => {
  it("4 punches: applies", () => {
    const result = day({ punches: sequence(4), break_override_minutes: OVERRIDE });
    assert.equal(result.punch_count, 4);
    assert.equal(result.break_allowance_minutes, 90);
    assert.equal(result.break_allowance_source, "EMPLOYEE_OVERRIDE");
    assert.equal(result.break_override_minutes_applied, 90);
    assert.equal(result.nrm_minutes, 630, "720 span - the employee's 90");
    assert.equal(result.status, CALC_STATUS.FINAL);
  });

  it("5 punches: does NOT apply, and the day is still a missing-punch review", () => {
    const result = day({ punches: sequence(5), break_override_minutes: OVERRIDE });
    assert.equal(result.punch_count, 5);
    assertUnextended(result, "5 punches");
  });

  it("6 punches: applies", () => {
    const result = day({ punches: sequence(6), break_override_minutes: OVERRIDE });
    assert.equal(result.punch_count, 6);
    assert.equal(result.break_allowance_minutes, 90);
    assert.equal(result.break_override_minutes_applied, 90);
    assert.equal(result.nrm_minutes, 630);
    assert.equal(result.status, CALC_STATUS.FINAL);
  });

  it("7 punches: does NOT apply, and the day is still a missing-punch review", () => {
    const result = day({ punches: sequence(7), break_override_minutes: OVERRIDE });
    assert.equal(result.punch_count, 7);
    assertUnextended(result, "7 punches");
  });

  it("8 punches: applies", () => {
    const result = day({ punches: sequence(8), break_override_minutes: OVERRIDE });
    assert.equal(result.punch_count, 8);
    assert.equal(result.break_allowance_minutes, 90);
    assert.equal(result.break_override_minutes_applied, 90);
    assert.equal(result.nrm_minutes, 630);
    assert.equal(result.status, CALC_STATUS.FINAL);
  });

  it("an odd day's figures are identical with the override and without it", () => {
    for (const n of [5, 7]) {
      const withOverride = day({ punches: sequence(n), break_override_minutes: OVERRIDE });
      const without = day({ punches: sequence(n) });
      for (const k of [
        "nrm_minutes",
        "break_allowance_minutes",
        "break_allowance_source",
        "span_minutes",
        "status",
        "is_final",
      ]) {
        assert.equal(withOverride[k], without[k], `${n} punches: ${k}`);
      }
    }
  });

  it("the missing-punch workflow is untouched: same status, reason and note", () => {
    const result = day({ punches: sequence(5), break_override_minutes: OVERRIDE });
    assert.equal(result.status, CALC_STATUS.REVIEW_REQUIRED);
    assert.deepEqual(result.review_reasons, ["MISSING_PUNCH"]);
    assert.ok(result.notes.some((n) => /one punch is missing/.test(n)));
    // AND THE NOTES ARE THE MISSING-PUNCH BRANCH'S OWN, unchanged: that
    // branch replaces the notes rather than adding to them, and this fix does
    // not touch it. So an odd day says what it has always said - one punch is
    // missing - and does not also explain a break rule nobody applied.
    assert.deepEqual(result.notes, ["Odd punch count: one punch is missing and the day is not final"]);
  });

  it("0, 1, 2 and 3 punches are unchanged - the override was never credited there", () => {
    for (const n of [0, 1, 2, 3]) {
      const result = day({ punches: sequence(n), break_override_minutes: OVERRIDE });
      assert.equal(result.break_allowance_source, "SHIFT", `${n} punches`);
      assert.equal(result.break_override_minutes_applied, null, `${n} punches`);
    }
  });
});

/* ================================= the override together with Extra Break = */

describe("override + Extra Break Hours obey the one predicate together", () => {
  it("4 punches: both apply, and the allowance is override + extra", () => {
    const result = day({
      punches: sequence(4),
      break_override_minutes: OVERRIDE,
      extra_break_minutes: EXTRA,
    });
    assert.equal(result.break_allowance_minutes, 120, "90 + 30, additive as before");
    assert.equal(result.break_override_minutes_applied, 90);
    assert.equal(result.extra_break_minutes_applied, 30);
    assert.equal(result.break_allowance_source, "EMPLOYEE_OVERRIDE");
    assert.equal(result.nrm_minutes, 600);
    assert.equal(result.status, CALC_STATUS.FINAL);
  });

  it("5 punches: NEITHER applies - the shift's break, and still MISSING_PUNCH", () => {
    const result = day({
      punches: sequence(5),
      break_override_minutes: OVERRIDE,
      extra_break_minutes: EXTRA,
    });
    assertUnextended(result, "5 punches, both configured");
  });

  it("6 punches: both apply", () => {
    const result = day({
      punches: sequence(6),
      break_override_minutes: OVERRIDE,
      extra_break_minutes: EXTRA,
    });
    assert.equal(result.break_allowance_minutes, 120);
    assert.equal(result.break_override_minutes_applied, 90);
    assert.equal(result.extra_break_minutes_applied, 30);
    assert.equal(result.nrm_minutes, 600);
  });

  it("7 punches: neither applies, and the day is still MISSING_PUNCH", () => {
    const result = day({
      punches: sequence(7),
      break_override_minutes: OVERRIDE,
      extra_break_minutes: EXTRA,
    });
    assertUnextended(result, "7 punches, both configured");
  });
});

/* ============================================== the two-punch day stands == */

describe("a two-punch day is unchanged, with both settings configured", () => {
  const TWO = () => punches("09:00", "21:00");

  it("comes out identical to the same day with neither setting", () => {
    const withBoth = day({
      punches: TWO(),
      break_override_minutes: OVERRIDE,
      extra_break_minutes: EXTRA,
    });
    const without = day({ punches: TWO() });

    for (const k of [
      "nrm_minutes",
      "span_minutes",
      "break_allowance_minutes",
      "break_allowance_source",
      "break_charged_minutes",
      "worked_minutes",
      "shortage_minutes",
      "candidate_ot_minutes",
      "status",
      "is_final",
    ]) {
      assert.equal(withBoth[k], without[k], k);
    }
    assert.equal(withBoth.break_override_minutes_applied, null);
    assert.equal(withBoth.extra_break_minutes_applied, 0);
  });

  it("the phased break rule remains authoritative on a short two-punch day", () => {
    const result = day({
      punches: punches("09:00", "15:30"),
      break_override_minutes: OVERRIDE,
      extra_break_minutes: EXTRA,
    });
    // span 390, so 30 charged under the phased rule - not 90 and not 120.
    assert.equal(result.break_charged_minutes, 30);
    assert.equal(result.worked_minutes, 360);
  });
});

/* ================================================== a configured zero ===== */

describe("a configured override of 0 is a real override, not an absent one", () => {
  it("4 punches: it applies, and the whole span is owed", () => {
    const result = day({ punches: sequence(4), break_override_minutes: 0 });
    assert.equal(result.break_override_minutes_applied, 0, "0, never null");
    assert.equal(result.break_allowance_minutes, 0);
    assert.equal(result.break_allowance_source, "EMPLOYEE_OVERRIDE");
    assert.equal(result.nrm_minutes, 720, "the whole span: no break is charged against it");
  });

  it("4 punches with Extra Break Hours on top of a zero override", () => {
    const result = day({ punches: sequence(4), break_override_minutes: 0, extra_break_minutes: EXTRA });
    assert.equal(result.break_override_minutes_applied, 0);
    assert.equal(result.extra_break_minutes_applied, 30);
    assert.equal(result.break_allowance_minutes, 30);
    assert.equal(result.nrm_minutes, 690);
  });

  it("5 punches: it does NOT apply, because the sequence is incomplete", () => {
    const result = day({ punches: sequence(5), break_override_minutes: 0 });
    assertUnextended(result, "zero override, 5 punches");
  });
});

/* ====================================== one predicate, not two conditions = */

describe("both settings ask the same question, in one place", () => {
  const source = require("fs").readFileSync(
    require("path").join(__dirname, "attendance_engine.js"),
    "utf8"
  );

  it("there is exactly one complete-sequence predicate", () => {
    assert.equal((source.match(/const completeSequence =/g) || []).length, 1);
    assert.match(source, /const completeSequence = effectivePunches\.length >= 4 && effectivePunches\.length % 2 === 0;/);
  });

  it("neither setting keeps a bare `>= 4` of its own", () => {
    assert.match(source, /const overrideGiven = overrideConfigured && completeSequence;/);
    assert.ok(
      !/overrideConfigured && effectivePunches\.length >= 4/.test(source),
      "the old override condition is gone, not merely shadowed"
    );
  });
});
