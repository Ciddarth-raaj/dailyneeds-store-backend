/**
 * Attendance v2 review fix #5 - EVERY Shift Management OT rule, exercised.
 *
 * The first implementation consumed only part of the Work Shift's overtime
 * configuration: post-shift OT, its minimum, its rounding and the per-day cap.
 * Pre-shift OT and the two offset switches were on the table, finalized, and
 * silently unread - which meant a shift configured to pay for early starts
 * paid nothing, and a shift configured to offset lateness against overtime
 * offset nothing.
 *
 * Each rule below has its own test, and each one is also checked in its OFF
 * position, because a flag that changes the answer when set and also when
 * unset is not a flag anybody can reason about.
 *
 * WHAT IS NOT HERE, deliberately. There is no test for a monetary late or
 * early-exit deduction, because v2 has none: `late_deduct_minutes` and
 * `early_exit_deduct_minutes` are legacy configuration for a deduction engine
 * that does not exist, and the offset switches subtract from OVERTIME only.
 * The old Full/Half/Quarter Day payroll rules are not revived either.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  PUNCH_SOURCE,
  calculateAttendanceDay,
  applyPreShiftOvertimeRules,
  resolveOvertime,
} = require("../utils/attendance_engine");
const { buildShiftSnapshot } = require("../utils/shiftResolution");

const DATE = "2026-09-14"; // a Monday

/** A 09:00-21:00 shift with a one hour break, plus whatever config is given. */
function shift(config = {}, schedule = {}) {
  return buildShiftSnapshot(
    {
      work_shift_id: 7,
      work_shift_weekly_schedule_id: 71,
      is_working_day: 1,
      in_time: "09:00",
      out_time: "21:00",
      attendance_day_cutoff: "04:00",
      break_minutes: 60,
      ot_rate: 1,
      ...schedule,
    },
    { work_shift_id: 7, shift_code: "GEN", overtime_allowed: 1, ...config },
    1
  );
}

const punches = (...times) =>
  times.map((t, i) => ({
    punch_id: 1000 + i,
    source: PUNCH_SOURCE.BIOMAX,
    io_time: `${DATE} ${t}:00`,
  }));

const day = (config, times, schedule) =>
  calculateAttendanceDay({
    employee_id: 42,
    attendance_date: DATE,
    shift: shift(config, schedule),
    punches: punches(...times),
  });

/* ===================================================== the snapshot itself */

describe("the shift snapshot carries every OT rule the master holds", () => {
  it("reads all thirteen configuration fields, not just the post-shift ones", () => {
    const snapshot = shift({
      overtime_allowed: 1,
      overtime_minimum_minutes: 30,
      overtime_rounding_method: "down",
      overtime_rounding_interval_minutes: 15,
      overtime_minimum_threshold_only: 1,
      maximum_ot_minutes_per_day: 120,
      pre_shift_overtime_allowed: 1,
      pre_shift_overtime_minimum_minutes: 20,
      pre_shift_overtime_rounding_method: "up",
      pre_shift_overtime_rounding_interval_minutes: 10,
      late_offset_against_overtime: 1,
      early_exit_offset_against_overtime: 1,
    });

    assert.equal(snapshot.overtime_allowed, true);
    assert.equal(snapshot.overtime_minimum_minutes, 30);
    assert.equal(snapshot.overtime_rounding_method, "DOWN");
    assert.equal(snapshot.overtime_rounding_interval_minutes, 15);
    assert.equal(snapshot.overtime_minimum_threshold_only, true);
    assert.equal(snapshot.maximum_ot_minutes_per_day, 120);
    assert.equal(snapshot.pre_shift_overtime_allowed, true);
    assert.equal(snapshot.pre_shift_overtime_minimum_minutes, 20);
    assert.equal(snapshot.pre_shift_overtime_rounding_method, "UP");
    assert.equal(snapshot.pre_shift_overtime_rounding_interval_minutes, 10);
    assert.equal(snapshot.late_offset_against_overtime, true);
    assert.equal(snapshot.early_exit_offset_against_overtime, true);
    assert.equal(snapshot.ot_rate, 1);
  });

  it("changing any one of them changes the snapshot hash, so drift is visible", () => {
    const base = shift().snapshot_hash;
    [
      { pre_shift_overtime_allowed: 1 },
      { pre_shift_overtime_minimum_minutes: 15 },
      { pre_shift_overtime_rounding_method: "UP" },
      { pre_shift_overtime_rounding_interval_minutes: 30 },
      { late_offset_against_overtime: 1 },
      { early_exit_offset_against_overtime: 1 },
    ].forEach((config) => {
      const changed = shift({ ...config, pre_shift_overtime_rounding_interval_minutes:
        config.pre_shift_overtime_rounding_interval_minutes || 0 });
      assert.notEqual(changed.snapshot_hash, base, `unhashed: ${Object.keys(config)[0]}`);
    });
  });
});

/* ======================================================= post-shift OT === */

describe("post-shift overtime", () => {
  it("pays nothing at all when the shift does not allow overtime", () => {
    const result = day({ overtime_allowed: 0 }, ["09:00", "13:00", "13:30", "22:30"]);
    assert.ok(result.raw_ot_minutes > 0, "the surplus is real");
    assert.equal(result.candidate_ot_minutes, 0, "but the shift pays none of it");
  });

  it("a MINIMUM acts as a floor by default: work more than it and you get at least it", () => {
    // 21:00 -> 21:40 with a 30 minute break taken: 40 surplus minutes.
    const result = day(
      { overtime_minimum_minutes: 60, overtime_minimum_threshold_only: 0 },
      ["09:00", "13:00", "13:30", "21:40"]
    );
    assert.equal(result.raw_ot_minutes, 70);
    assert.equal(result.candidate_ot_minutes, 70, "already above the floor");

    const short = day(
      { overtime_minimum_minutes: 120, overtime_minimum_threshold_only: 0 },
      ["09:00", "13:00", "13:30", "21:40"]
    );
    assert.equal(short.candidate_ot_minutes, 0, "below the minimum qualifies for nothing");
  });

  it("a THRESHOLD-ONLY minimum qualifies the day and then pays the exact minutes", () => {
    const result = day(
      { overtime_minimum_minutes: 30, overtime_minimum_threshold_only: 1 },
      ["09:00", "13:00", "13:30", "21:40"]
    );
    assert.equal(result.candidate_ot_minutes, 70, "exact minutes, not inflated to a floor");
  });

  it("rounds UP, DOWN and to the NEAREST interval, and not at all when NONE", () => {
    const times = ["09:00", "13:00", "13:30", "21:40"]; // 70 raw OT minutes
    assert.equal(day({}, times).candidate_ot_minutes, 70);
    assert.equal(
      day({ overtime_rounding_method: "UP", overtime_rounding_interval_minutes: 30 }, times)
        .candidate_ot_minutes,
      90
    );
    assert.equal(
      day({ overtime_rounding_method: "DOWN", overtime_rounding_interval_minutes: 30 }, times)
        .candidate_ot_minutes,
      60
    );
    assert.equal(
      day({ overtime_rounding_method: "NEAREST", overtime_rounding_interval_minutes: 30 }, times)
        .candidate_ot_minutes,
      60
    );
    assert.equal(
      day({ overtime_rounding_method: "UP", overtime_rounding_interval_minutes: 0 }, times)
        .candidate_ot_minutes,
      70,
      "an interval of zero is not a rounding rule"
    );
  });

  it("caps the day at maximum_ot_minutes_per_day", () => {
    const result = day({ maximum_ot_minutes_per_day: 45 }, ["09:00", "13:00", "13:30", "23:00"]);
    assert.equal(result.candidate_ot_minutes, 45);
  });
});

/* ======================================================== pre-shift OT === */

describe("pre-shift overtime", () => {
  // In 90 minutes early, out on time, and the WHOLE hour of break taken - so
  // the only surplus on the day is the early start and nothing else can be
  // confused for it.
  const early = ["07:30", "13:00", "14:00", "21:00"];

  it("is NOT overtime when the shift does not allow it", () => {
    const result = day({ pre_shift_overtime_allowed: 0 }, early);
    assert.equal(result.pre_shift_minutes, 90, "the early time is reported");
    assert.equal(result.pre_shift_ot_minutes, 0);
    assert.equal(
      result.candidate_ot_minutes,
      result.post_shift_ot_minutes,
      "turning up early is not an instruction to work"
    );
  });

  it("does not leak into the post-shift figure when it is disallowed", () => {
    // Nothing after 21:00, so with pre-shift OT off there is no OT at all -
    // even though the surplus over NRM is 90 minutes.
    const result = day({ pre_shift_overtime_allowed: 0 }, early);
    assert.ok(result.raw_ot_minutes >= 90, "the surplus exists");
    assert.equal(result.candidate_ot_minutes, 0);
  });

  it("is paid when the shift allows it", () => {
    const result = day({ pre_shift_overtime_allowed: 1 }, early);
    assert.equal(result.pre_shift_ot_minutes, 90);
    assert.equal(result.candidate_ot_minutes, 90);
  });

  it("qualifies against its OWN minimum, which is a threshold and never a floor", () => {
    const barely = ["08:50", "13:00", "14:00", "21:00"]; // 10 minutes early
    assert.equal(
      day({ pre_shift_overtime_allowed: 1, pre_shift_overtime_minimum_minutes: 30 }, barely)
        .pre_shift_ot_minutes,
      0,
      "below the minimum qualifies for nothing"
    );
    assert.equal(
      day({ pre_shift_overtime_allowed: 1, pre_shift_overtime_minimum_minutes: 30 }, early)
        .pre_shift_ot_minutes,
      90,
      "above it, the exact minutes - never inflated to the minimum"
    );
    assert.equal(
      applyPreShiftOvertimeRules(45, {
        pre_shift_overtime_allowed: true,
        pre_shift_overtime_minimum_minutes: 120,
      }),
      0
    );
  });

  it("rounds by its own method and interval, not by the post-shift one", () => {
    const result = day(
      {
        pre_shift_overtime_allowed: 1,
        pre_shift_overtime_rounding_method: "DOWN",
        pre_shift_overtime_rounding_interval_minutes: 60,
        overtime_rounding_method: "UP",
        overtime_rounding_interval_minutes: 60,
      },
      early
    );
    assert.equal(result.pre_shift_ot_minutes, 60, "90 rounded DOWN to the hour");
  });

  it("adds to post-shift OT, and the per-day cap applies to the TOTAL", () => {
    const both = ["07:30", "13:00", "14:00", "22:00"]; // 90 early + 60 late
    const uncapped = day({ pre_shift_overtime_allowed: 1 }, both);
    assert.equal(uncapped.pre_shift_ot_minutes, 90);
    assert.equal(uncapped.post_shift_ot_minutes, 60);
    assert.equal(uncapped.candidate_ot_minutes, 150);

    const capped = day(
      { pre_shift_overtime_allowed: 1, maximum_ot_minutes_per_day: 100 },
      both
    );
    assert.equal(
      capped.candidate_ot_minutes,
      100,
      "a day maximum is a maximum for the day, not for each half of it"
    );
  });
});

/* ============================================================ the offsets */

describe("the late and early-exit offsets against overtime", () => {
  // In 30 minutes late, out 90 minutes late, a 30 minute break taken.
  const lateIn = ["09:30", "13:00", "13:30", "22:30"];

  it("changes nothing when the switch is off", () => {
    const result = day({ late_offset_against_overtime: 0 }, lateIn);
    assert.equal(result.late_minutes, 30);
    assert.equal(result.ot_offset_minutes, 0);
    assert.equal(result.candidate_ot_minutes, result.raw_ot_minutes);
  });

  it("subtracts the late minutes from the overtime when it is on", () => {
    const off = day({ late_offset_against_overtime: 0 }, lateIn);
    const on = day({ late_offset_against_overtime: 1 }, lateIn);
    assert.equal(on.ot_offset_minutes, 30);
    assert.equal(on.candidate_ot_minutes, off.candidate_ot_minutes - 30);
  });

  it("subtracts early-exit minutes the same way", () => {
    // In 90 minutes early, out 30 minutes early: early_exit_minutes = 30.
    const times = ["07:30", "13:00", "13:30", "20:30"];
    const off = day({ pre_shift_overtime_allowed: 1 }, times);
    const on = day(
      { pre_shift_overtime_allowed: 1, early_exit_offset_against_overtime: 1 },
      times
    );
    assert.equal(off.early_exit_minutes, 30);
    assert.equal(on.ot_offset_minutes, 30);
    assert.equal(on.candidate_ot_minutes, off.candidate_ot_minutes - 30);
  });

  it("never drives overtime below zero, and never becomes a wage deduction", () => {
    // 120 minutes late, 30 minutes of OT earned: the offset exceeds the OT.
    const result = day({ late_offset_against_overtime: 1 }, ["11:00", "13:00", "13:30", "21:30"]);
    assert.equal(result.candidate_ot_minutes, 0);
    assert.ok(result.candidate_ot_minutes >= 0);

    // And the shortage - the ONLY minute-based charge in v2 - is untouched by
    // the offset. The same minute is never taken twice.
    const withoutOffset = day({ late_offset_against_overtime: 0 }, ["11:00", "13:00", "13:30", "21:30"]);
    assert.equal(result.shortage_minutes, withoutOffset.shortage_minutes);
    assert.equal(result.worked_minutes, withoutOffset.worked_minutes);
    assert.equal(result.attendance_day_count, withoutOffset.attendance_day_count);
  });

  it("comes off post-shift time first, and only then off pre-shift time", () => {
    // 90 early, 30 late in, 30 late out -> 30 post-shift OT, 90 pre-shift.
    const result = resolveOvertime({
      raw_ot_minutes: 120,
      pre_shift_minutes: 90,
      late_minutes: 60,
      early_exit_minutes: 0,
      shift: {
        overtime_allowed: true,
        pre_shift_overtime_allowed: true,
        late_offset_against_overtime: true,
        maximum_ot_minutes_per_day: null,
      },
    });
    assert.equal(result.post_shift_eligible_minutes, 0, "the 30 post-shift minutes went first");
    assert.equal(result.pre_shift_eligible_minutes, 60, "the remaining 30 came off the pre-shift");
    assert.equal(result.candidate_ot_minutes, 60);
  });
});

/* =========================================================== the OT rate */

describe("the weekday OT rate", () => {
  it("is carried from that weekday's own schedule row, not from the shift", () => {
    assert.equal(day({}, ["09:00", "21:00"], { ot_rate: 2 }).ot_rate, 2);
    assert.equal(day({}, ["09:00", "21:00"], { ot_rate: 1.5 }).ot_rate, 1.5);
  });
});

/* ========================================== what v2 still refuses to do == */

describe("the rules v2 does NOT revive", () => {
  it("never classifies a day, whatever the legacy Full/Half-Day settings say", () => {
    const result = day(
      {
        missed_clock_in_rule_enabled: 1,
        missed_clock_in_treatment: "HALF_DAY",
        minimum_hours_rule_enabled: 1,
        minimum_half_day_minutes: 240,
        minimum_full_day_minutes: 480,
      },
      ["09:00", "12:00"]
    );
    assert.equal(result.attendance_day_count, 1, "any positive presence is one whole day");
    assert.ok(!("day_type" in result));
    assert.ok(!("half_day" in result));
  });

  it("settles late and early-out minutes under the shift's grace and interval rule, inside the shortage", () => {
    // 10:00 -> 21:00 with a 30-minute gap: 630 worked against NRM 660, so 30
    // short - all of it a 60-minute late arrival (only 30 of which the
    // shortage contains). Grace 5 used up, no exclusion: all 30 count, and
    // every started 15 minutes charges 30 -> 60. Early out is 0.
    const plain = day({}, ["10:00", "13:00", "13:30", "21:00"]);
    const configured = day(
      {
        late_grace_minutes: 5,
        late_deduction_interval_minutes: 15,
        late_deduct_minutes: 30,
        early_exit_grace_minutes: 5,
        early_exit_deduction_interval_minutes: 15,
        early_exit_deduct_minutes: 30,
      },
      ["10:00", "13:00", "13:30", "21:00"]
    );
    assert.equal(plain.shortage_minutes, 30);
    assert.equal(configured.worked_minutes, plain.worked_minutes, "worked minutes never move");
    assert.equal(configured.late_charged_minutes, 60);
    assert.equal(configured.shortage_minutes, 60);
    assert.equal(configured.candidate_ot_minutes, plain.candidate_ot_minutes, "OT is untouched");
  });
});
