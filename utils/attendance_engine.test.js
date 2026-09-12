/**
 * Attendance v2 / A2 - the required test matrix.
 *
 * Every numbered case below is one of the sixteen the approved v2 handoff
 * names, in its order, and the case number is in the test title so a reviewer
 * can map the matrix to the assertions without reading the code. Cases 9, 11
 * and 12 are about which date and which shift a punch belongs to rather than
 * about the arithmetic, so they exercise `attendanceDateForPunch` and the A0
 * resolver alongside the engine.
 *
 * Everything here is deterministic: fixed punches, fixed configuration, no
 * clock, no database, no timezone dependence.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  CALC_STATUS,
  REVIEW_REASON,
  PUNCH_SOURCE,
  calculateAttendanceDay,
  attendanceDateForPunch,
  applyOvertimeRules,
  orderPunches,
} = require("../utils/attendance_engine");

const { buildShiftSnapshot, resolveAssignmentForDate } = require("../utils/shiftResolution");

const DATE = "2026-09-14"; // a Monday

/** A shift snapshot for one weekday, with sensible OT defaults. */
function shift({
  in_time = "09:00",
  out_time = "21:00",
  break_minutes = 60,
  ot_rate = 1,
  config = {},
} = {}) {
  return buildShiftSnapshot(
    {
      work_shift_id: 7,
      work_shift_weekly_schedule_id: 71,
      is_working_day: 1,
      in_time,
      out_time,
      attendance_day_cutoff: "04:00",
      break_minutes,
      ot_rate,
    },
    { work_shift_id: 7, shift_code: "GEN", overtime_allowed: 1, ...config },
    1
  );
}

/** Punches as `HH:MM` on the attendance date, in the order given. */
function punches(...times) {
  return times.map((t, i) => ({
    punch_id: 1000 + i,
    source: PUNCH_SOURCE.BIOMAX,
    dev_id: "C26924B2E7351O35",
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

/* ================================================================ 1 - 4 == */

describe("A2 case 1 - the plain full day", () => {
  it("09:00-21:00 with a 1 hour break and two punches is 660 worked minutes", () => {
    const result = day({ punches: punches("09:00", "21:00") });

    assert.equal(result.nrm_minutes, 660);
    assert.equal(result.span_minutes, 720);
    assert.equal(result.break_allowance_minutes, 60);
    assert.equal(result.break_charged_minutes, 60);
    assert.equal(result.worked_minutes, 660);
    assert.equal(result.shortage_minutes, 0);
    assert.equal(result.attendance_day_count, 1);
    assert.equal(result.status, CALC_STATUS.FINAL);
    assert.equal(result.is_final, true);
  });
});

describe("A2 case 2 - under six hours is charged no break at all", () => {
  it("09:00-12:30 credits all 210 minutes", () => {
    const result = day({ punches: punches("09:00", "12:30") });

    assert.equal(result.span_minutes, 210);
    assert.equal(result.break_charged_minutes, 0);
    assert.equal(result.worked_minutes, 210);
    // Left before 15:00: the no-lunch rule withholds the 60m break credit,
    // so the whole 510m early out is short (NRM 660 - 210 would be 450).
    assert.equal(result.break_credit_withheld, true);
    assert.equal(result.shortage_minutes, 510);
    assert.equal(result.attendance_day_count, 1);
  });
});

describe("A2 case 3 - the break phases in over the hour after six", () => {
  it("09:00-15:30 is a 390 minute span, 30 charged, 360 credited", () => {
    const result = day({ punches: punches("09:00", "15:30") });

    assert.equal(result.span_minutes, 390);
    assert.equal(result.break_charged_minutes, 30);
    assert.equal(result.worked_minutes, 360);
  });

  it("credited minutes never fall as the span grows", () => {
    // The property the phased rule exists to guarantee: staying longer can
    // never pay less. Checked minute by minute across the phase-in.
    let previous = -1;
    for (let minutes = 0; minutes <= 720; minutes += 1) {
      const end = 9 * 60 + minutes;
      const result = day({
        punches: punches("09:00", `${String(Math.floor(end / 60)).padStart(2, "0")}:${String(end % 60).padStart(2, "0")}`),
      });
      assert.ok(
        result.worked_minutes >= previous,
        `worked minutes fell from ${previous} to ${result.worked_minutes} at span ${minutes}`
      );
      previous = result.worked_minutes;
    }
  });
});

describe("A2 case 4 - a shift whose allowed break is zero", () => {
  it("14:00-22:00 with no break credits all 480 minutes", () => {
    const result = calculateAttendanceDay({
      employee_id: 42,
      attendance_date: DATE,
      shift: shift({ in_time: "14:00", out_time: "22:00", break_minutes: 0 }),
      punches: punches("14:00", "22:00"),
    });

    assert.equal(result.nrm_minutes, 480);
    assert.equal(result.break_allowance_minutes, 0);
    assert.equal(result.break_charged_minutes, 0);
    assert.equal(result.worked_minutes, 480);
    assert.equal(result.shortage_minutes, 0);
  });
});

/* ================================================================ 5 - 7 == */

describe("A2 case 5 - four punches whose gaps come to exactly the allowance", () => {
  it("60 minutes of gaps on a 09-21 shift is 660 worked minutes", () => {
    const result = day({ punches: punches("09:00", "13:00", "14:00", "21:00") });

    assert.equal(result.punch_count, 4);
    assert.equal(result.actual_gap_minutes, 60);
    assert.equal(result.break_charged_minutes, 60);
    assert.equal(result.worked_minutes, 660);
    assert.equal(result.shortage_minutes, 0);
    assert.equal(result.candidate_ot_minutes, 0);
  });
});

describe("A2 case 6 - gaps above the allowance reduce worked minutes", () => {
  it("100 minutes of gaps is 620 worked and 40 short", () => {
    const result = day({ punches: punches("09:00", "13:00", "14:40", "21:00") });

    assert.equal(result.actual_gap_minutes, 100);
    assert.equal(result.worked_minutes, 620);
    assert.equal(result.shortage_minutes, 40);
    assert.equal(result.candidate_ot_minutes, 0);
  });
});

describe("A2 case 7 - gaps below the allowance can feed OT", () => {
  it("45 minutes of gaps is 675 worked and 15 candidate OT minutes", () => {
    const result = day({ punches: punches("09:00", "13:00", "13:45", "21:00") });

    assert.equal(result.actual_gap_minutes, 45);
    assert.equal(result.worked_minutes, 675);
    assert.equal(result.shortage_minutes, 0);
    assert.equal(result.raw_ot_minutes, 15);
    assert.equal(result.candidate_ot_minutes, 15);
    // Earned is not payable. Nothing is owed until the OT request is finally
    // approved - and the day itself is FINAL regardless: the OT claim is a
    // separate state, not an attendance status.
    assert.equal(result.approved_ot_minutes, 0);
    assert.equal(result.status, CALC_STATUS.FINAL);
    assert.equal(result.is_final, true);
  });

  it("no gap is singled out as the lunch one - three gaps sum the same way", () => {
    const result = day({
      punches: punches("09:00", "11:00", "11:15", "14:00", "14:15", "18:00", "18:15", "21:00"),
    });
    assert.equal(result.actual_gap_minutes, 45);
    assert.equal(result.worked_minutes, 675);
  });
});

/* ================================================================== 8 ==== */

describe("A2 case 8 - the employee's special break override replaces the shift break", () => {
  it("a 90 minute override on a 12 hour shift makes NRM 630, when the break was punched", () => {
    const result = day({
      punches: punches("09:00", "13:00", "14:30", "21:00"),
      break_override_minutes: 90,
    });

    assert.equal(result.nrm_minutes, 630);
    assert.equal(result.break_allowance_minutes, 90);
    assert.equal(result.break_allowance_source, "EMPLOYEE_OVERRIDE");
    // It replaces rather than adds: 60 + 90 would have been 570.
    assert.equal(result.break_charged_minutes, 90);
    assert.equal(result.worked_minutes, 630);
    assert.equal(result.shortage_minutes, 0);
  });

  it("is NOT applied on a two-punch day: the shift's break is charged and NRM is the shift's", () => {
    const result = day({
      punches: punches("09:00", "21:00"),
      break_override_minutes: 90,
    });
    assert.equal(result.break_allowance_source, "SHIFT");
    assert.equal(result.break_allowance_minutes, 60);
    assert.equal(result.nrm_minutes, 660);
    assert.equal(result.break_charged_minutes, 60);
    assert.equal(result.worked_minutes, 660);
    assert.equal(result.shortage_minutes, 0);
    assert.ok(result.notes.some((n) => /four or more punches/.test(n)));
  });

  it("a zero override on a four-punch day charges the actual gaps against an NRM of the whole span", () => {
    const result = day({
      punches: punches("09:00", "13:00", "13:30", "21:00"),
      break_override_minutes: 0,
    });
    assert.equal(result.nrm_minutes, 720);
    assert.equal(result.break_charged_minutes, 30);
    assert.equal(result.worked_minutes, 690);
    assert.equal(result.shortage_minutes, 30);
  });

  it("an absent or odd-punch day never carries the override", () => {
    assert.equal(day({ punches: [], break_override_minutes: 90 }).break_allowance_source, "SHIFT");
    assert.equal(
      day({ punches: punches("09:00", "13:00", "14:00"), break_override_minutes: 90 }).break_allowance_source,
      "SHIFT"
    );
  });
});

/* ================================================================== 9 ==== */

describe("A2 case 9 - an overrun past midnight stays on the original date", () => {
  const readCutoff = (date) =>
    date === "2026-09-14" ? { is_working_day: 1, attendance_day_cutoff: "04:00" } : null;

  it("a 10:00-22:00 employee finishing at 00:30 is still on the shift date", () => {
    assert.equal(
      attendanceDateForPunch({ ioTime: "2026-09-15 00:30:00", readCutoff }),
      "2026-09-14"
    );
  });

  it("a punch after the cutoff belongs to the new day", () => {
    assert.equal(
      attendanceDateForPunch({ ioTime: "2026-09-15 04:30:00", readCutoff }),
      "2026-09-15"
    );
  });

  it("the engine spans midnight as ordinary arithmetic", () => {
    const result = calculateAttendanceDay({
      employee_id: 42,
      attendance_date: "2026-09-14",
      shift: shift({ in_time: "10:00", out_time: "22:00", break_minutes: 60 }),
      punches: [
        { punch_id: 1, io_time: "2026-09-14 10:00:00" },
        { punch_id: 2, io_time: "2026-09-15 00:30:00" },
      ],
    });

    assert.equal(result.span_minutes, 870);
    assert.equal(result.nrm_minutes, 660);
    assert.equal(result.break_charged_minutes, 60);
    assert.equal(result.worked_minutes, 810);
    assert.equal(result.raw_ot_minutes, 150);
  });

  it("a rest day never claims the following morning's punches", () => {
    assert.equal(
      attendanceDateForPunch({
        ioTime: "2026-09-15 00:30:00",
        readCutoff: () => ({ is_working_day: 0, attendance_day_cutoff: null }),
      }),
      "2026-09-15"
    );
  });
});

/* ================================================================= 10 ==== */

describe("A2 case 10 - an odd punch count is never final", () => {
  it("three punches are flagged for review and not settled", () => {
    const result = day({ punches: punches("09:00", "13:00", "14:00") });

    assert.equal(result.punch_count, 3);
    assert.equal(result.status, CALC_STATUS.REVIEW_REQUIRED);
    assert.equal(result.is_final, false);
    assert.deepEqual(result.review_reasons, [REVIEW_REASON.MISSING_PUNCH]);
    assert.equal(result.attendance_day_count, 1, "they were demonstrably present");
    assert.equal(result.approved_ot_minutes, 0);
  });

  it("the raw punches are carried through untouched", () => {
    const result = day({ punches: punches("09:00", "13:00", "14:00") });
    assert.deepEqual(result.raw_punch_ids, [1000, 1001, 1002]);
  });

  it("a pending regularization says so rather than just REVIEW_REQUIRED", () => {
    const result = day({
      punches: punches("09:00", "13:00", "14:00"),
      regularization_pending: true,
    });
    assert.equal(result.status, CALC_STATUS.REGULARIZATION_PENDING);
    assert.equal(result.is_final, false);
  });

  it("an approved regularized punch completes the pair and settles the day", () => {
    const result = day({
      punches: punches("09:00", "13:00", "14:00"),
      regularized_punches: [
        { punch_id: 9001, source: PUNCH_SOURCE.REGULARIZED, io_time: `${DATE} 21:00:00` },
      ],
    });

    assert.equal(result.punch_count, 4);
    assert.equal(result.worked_minutes, 660);
    assert.equal(result.status, CALC_STATUS.FINAL);
    assert.equal(result.is_final, true);
    // The raw list is still exactly the three punches the device sent.
    assert.deepEqual(result.raw_punch_ids, [1000, 1001, 1002]);
    assert.equal(
      result.effective_punches.filter((p) => p.source === PUNCH_SOURCE.REGULARIZED).length,
      1
    );
  });
});

/* ================================================================= 11 ==== */

describe("A2 case 11 - a later shift change does not move a historical date", () => {
  const history = [
    { employee_work_shift_assignment_id: 1, work_shift_id: 7, effective_from: "2026-09-01" },
    { employee_work_shift_assignment_id: 2, work_shift_id: 9, effective_from: "2026-10-01" },
  ];

  it("September still resolves to the September shift after an October move", () => {
    assert.equal(resolveAssignmentForDate(history, "2026-09-14").work_shift_id, 7);
    assert.equal(resolveAssignmentForDate(history, "2026-09-30").work_shift_id, 7);
    assert.equal(resolveAssignmentForDate(history, "2026-10-01").work_shift_id, 9);
  });

  it("a date before the first assignment resolves to nothing, never to a guess", () => {
    assert.equal(resolveAssignmentForDate(history, "2026-08-31"), null);
  });

  it("a correction dated the same day wins on id, without editing the wrong row", () => {
    const corrected = [
      ...history,
      { employee_work_shift_assignment_id: 3, work_shift_id: 11, effective_from: "2026-09-01" },
    ];
    assert.equal(resolveAssignmentForDate(corrected, "2026-09-14").work_shift_id, 11);
    assert.equal(corrected.length, 3, "history is appended to, never rewritten");
  });

  it("a date with no shift produces no numbers at all", () => {
    const result = calculateAttendanceDay({
      employee_id: 42,
      attendance_date: "2026-08-31",
      shift: null,
      shift_status: "NO_SHIFT_FOR_DATE",
      punches: punches("09:00", "21:00"),
    });
    assert.equal(result.status, CALC_STATUS.NO_SHIFT_FOR_DATE);
    assert.equal(result.worked_minutes, 0);
    assert.equal(result.is_final, false);
  });
});

/* ================================================================= 12 ==== */

describe("A2 case 12 - punches aggregate by employee and date, not by device", () => {
  it("four punches across three terminals are one ordered day", () => {
    const result = calculateAttendanceDay({
      employee_id: 42,
      attendance_date: DATE,
      shift: shift(),
      punches: [
        { punch_id: 4, dev_id: "AMDB24121401307", io_time: `${DATE} 21:00:00` },
        { punch_id: 1, dev_id: "C26924B2E7351O35", io_time: `${DATE} 09:00:00` },
        { punch_id: 3, dev_id: "C2695C935328OB31", io_time: `${DATE} 14:00:00` },
        { punch_id: 2, dev_id: "C2695C935328OB31", io_time: `${DATE} 13:00:00` },
      ],
    });

    assert.equal(result.punch_count, 4);
    assert.deepEqual(result.raw_punch_ids, [1, 2, 3, 4]);
    assert.equal(result.worked_minutes, 660);
  });

  it("two punches in the same minute on two devices order deterministically", () => {
    const ordered = orderPunches(
      [
        { punch_id: 77, dev_id: "B", io_time: `${DATE} 09:00:40` },
        { punch_id: 12, dev_id: "A", io_time: `${DATE} 09:00:10` },
      ],
      DATE
    );
    assert.deepEqual(ordered.map((p) => p.punch_id), [12, 77]);
  });
});

/* ============================================================= 13 - 14 === */

describe("A2 case 13 - no punches is a settled absence", () => {
  it("day count is zero, and nothing is deducted for it", () => {
    const result = day({ punches: [] });

    assert.equal(result.attendance_day_count, 0);
    assert.equal(result.punch_count, 0);
    assert.equal(result.worked_minutes, 0);
    assert.equal(result.shortage_minutes, 0, "an unattended day is not paid, so not deducted");
    assert.equal(result.status, CALC_STATUS.ABSENT);
    assert.equal(result.is_final, true);
  });
});

describe("A2 case 14 - ten minutes present is a whole attendance day", () => {
  it("the day counts as 1 and the shortfall is separate and minute-based", () => {
    const result = day({ punches: punches("09:00", "09:10") });

    assert.equal(result.attendance_day_count, 1);
    assert.equal(result.worked_minutes, 10);
    // 710m early out under the no-lunch rule, capped at the NRM of 660.
    assert.equal(result.shortage_minutes, 660);
    // No half day, no quarter day: v2 has no such classification in payroll.
    assert.equal(result.status, CALC_STATUS.FINAL);
  });
});

/* ================================================================= 15 ==== */

describe("A2 case 15 - the Work Shift's own OT minimum, rounding and cap", () => {
  const cfg = (config) => ({ overtime_allowed: 1, ...config });

  it("OT that is not allowed is zero however long the day ran", () => {
    assert.equal(applyOvertimeRules(120, { overtime_allowed: false }), 0);
  });

  it("below the minimum qualifies for nothing", () => {
    assert.equal(applyOvertimeRules(15, cfg({ overtime_minimum_minutes: 30 })), 0);
  });

  it("the minimum is a FLOOR by default", () => {
    assert.equal(applyOvertimeRules(45, cfg({ overtime_minimum_minutes: 30 })), 45);
    assert.equal(applyOvertimeRules(30, cfg({ overtime_minimum_minutes: 30 })), 30);
  });

  it("and a qualifying THRESHOLD when the shift says so", () => {
    assert.equal(
      applyOvertimeRules(
        45,
        cfg({ overtime_minimum_minutes: 30, overtime_minimum_threshold_only: 1 })
      ),
      45
    );
    assert.equal(
      applyOvertimeRules(
        29,
        cfg({ overtime_minimum_minutes: 30, overtime_minimum_threshold_only: 1 })
      ),
      0
    );
  });

  it("rounds by the configured method and interval", () => {
    const base = { overtime_rounding_interval_minutes: 15 };
    assert.equal(applyOvertimeRules(52, cfg({ ...base, overtime_rounding_method: "UP" })), 60);
    assert.equal(applyOvertimeRules(52, cfg({ ...base, overtime_rounding_method: "DOWN" })), 45);
    assert.equal(applyOvertimeRules(52, cfg({ ...base, overtime_rounding_method: "NEAREST" })), 45);
    assert.equal(applyOvertimeRules(53, cfg({ ...base, overtime_rounding_method: "NEAREST" })), 60);
    assert.equal(applyOvertimeRules(52, cfg({ ...base, overtime_rounding_method: "NONE" })), 52);
  });

  it("caps the day", () => {
    assert.equal(applyOvertimeRules(200, cfg({ maximum_ot_minutes_per_day: 120 })), 120);
    assert.equal(applyOvertimeRules(60, cfg({ maximum_ot_minutes_per_day: 120 })), 60);
  });

  it("applies them in order: qualify, floor, round, cap", () => {
    assert.equal(
      applyOvertimeRules(
        40,
        cfg({
          overtime_minimum_minutes: 30,
          overtime_rounding_method: "UP",
          overtime_rounding_interval_minutes: 30,
          maximum_ot_minutes_per_day: 45,
        })
      ),
      45,
      "40 qualifies, floors at 40, rounds up to 60, caps at 45"
    );
  });

  it("the rules reach the engine's candidate, not just the helper", () => {
    const result = calculateAttendanceDay({
      employee_id: 42,
      attendance_date: DATE,
      shift: shift({ config: { overtime_allowed: 1, overtime_minimum_minutes: 30 } }),
      punches: punches("09:00", "13:00", "13:45", "21:00"),
    });
    assert.equal(result.raw_ot_minutes, 15);
    assert.equal(result.candidate_ot_minutes, 0, "15 is below the 30 minute minimum");
    assert.equal(result.status, CALC_STATUS.FINAL);
  });

  it("approved OT can never exceed the candidate", () => {
    const result = day({
      punches: punches("09:00", "13:00", "13:45", "21:00"),
      approved_ot_minutes: 999,
    });
    assert.equal(result.candidate_ot_minutes, 15);
    assert.equal(result.approved_ot_minutes, 15);
    assert.equal(result.status, CALC_STATUS.FINAL);
  });
});

/* ================================================================= 16 ==== */

describe("A2 case 16 - a two-punch day can never create unused-break OT", () => {
  it("leaving on time earns nothing extra, however short the real break was", () => {
    const result = day({ punches: punches("09:00", "21:00") });
    assert.equal(result.worked_minutes, 660);
    assert.equal(result.raw_ot_minutes, 0);
    assert.equal(result.candidate_ot_minutes, 0);
  });

  it("no two-punch day ending at or before the shift end produces any OT", () => {
    // Exhaustive over every finish minute up to the rostered end, on a shift
    // whose allowance is long enough that a naive "surplus = worked - NRM"
    // rule would have paid OT for skipping lunch.
    for (let end = 9 * 60; end <= 21 * 60; end += 1) {
      const hh = String(Math.floor(end / 60)).padStart(2, "0");
      const mm = String(end % 60).padStart(2, "0");
      const result = day({ punches: punches("09:00", `${hh}:${mm}`) });
      assert.equal(
        result.raw_ot_minutes,
        0,
        `two-punch day finishing ${hh}:${mm} produced ${result.raw_ot_minutes} OT minutes`
      );
    }
  });

  it("but genuinely staying past the shift end does earn OT", () => {
    const result = day({ punches: punches("09:00", "22:00") });
    assert.equal(result.span_minutes, 780);
    assert.equal(result.break_charged_minutes, 60);
    assert.equal(result.worked_minutes, 720);
    assert.equal(result.raw_ot_minutes, 60);
  });

  it("a four-punch day with the same span DOES get the surplus, because there is evidence", () => {
    const twoPunch = day({ punches: punches("09:00", "20:45") });
    const fourPunch = day({ punches: punches("09:00", "13:00", "13:15", "20:45") });

    assert.equal(twoPunch.raw_ot_minutes, 0);
    assert.equal(fourPunch.actual_gap_minutes, 15);
    assert.equal(fourPunch.worked_minutes, 690);
    assert.equal(fourPunch.raw_ot_minutes, 30);
  });
});

/* ======================================================== determinism ==== */

describe("recalculation is deterministic", () => {
  it("the same inputs produce an identical result object twice", () => {
    const input = {
      employee_id: 42,
      attendance_date: DATE,
      shift: shift(),
      punches: punches("09:00", "13:00", "13:45", "21:00"),
    };
    assert.deepEqual(calculateAttendanceDay(input), calculateAttendanceDay(input));
  });

  it("the shift snapshot hash is stable and changes when the shift changes", () => {
    assert.equal(shift().snapshot_hash, shift().snapshot_hash);
    assert.notEqual(shift().snapshot_hash, shift({ break_minutes: 30 }).snapshot_hash);
  });
});

/* ======================================================== grace forgiveness == */

describe("grace - late minutes inside the shift's grace are forgiven from the shortage", () => {
  const graced = (extra = {}) =>
    shift({
      in_time: "09:30",
      out_time: "18:30",
      break_minutes: 30,
      config: { late_grace_minutes: 10, early_exit_grace_minutes: 10, late_exclude_grace_from_deduction: 1, ...extra },
    });

  it("09:32 -> 18:30 on a 10-minute grace owes nothing (the reported 5 Sep bug)", () => {
    const result = day({ shift: graced(), punches: punches("09:32", "18:30") });
    assert.equal(result.late_minutes, 2);
    assert.equal(result.worked_minutes, 508);
    assert.equal(result.grace_forgiven_minutes, 2);
    assert.equal(result.shortage_minutes, 0);
    assert.equal(result.candidate_ot_minutes, 0, "a forgiven minute never becomes OT");
  });

  it("late beyond the grace with 'Do Not Deduct Grace Minutes' on charges only the excess", () => {
    const result = day({ shift: graced(), punches: punches("09:45", "18:30") });
    assert.equal(result.late_minutes, 15);
    assert.equal(result.grace_forgiven_minutes, 10);
    assert.equal(result.shortage_minutes, 5);
  });

  it("late beyond the grace with the switch off charges the whole late arrival", () => {
    const result = day({
      shift: graced({ late_exclude_grace_from_deduction: 0 }),
      punches: punches("09:45", "18:30"),
    });
    assert.equal(result.grace_forgiven_minutes, 0);
    assert.equal(result.shortage_minutes, 15);
  });

  it("an early out inside its grace is forgiven too; beyond it, nothing is", () => {
    const inside = day({ shift: graced(), punches: punches("09:30", "18:22") });
    assert.equal(inside.early_exit_minutes, 8);
    assert.equal(inside.shortage_minutes, 0);
    const beyond = day({ shift: graced(), punches: punches("09:30", "18:15") });
    assert.equal(beyond.shortage_minutes, 15);
  });

  it("a shift with no grace behaves exactly as before", () => {
    const result = day({
      shift: shift({ in_time: "09:30", out_time: "18:30", break_minutes: 30 }),
      punches: punches("09:32", "18:30"),
    });
    assert.equal(result.grace_forgiven_minutes, 0);
    assert.equal(result.shortage_minutes, 2);
  });

  it("forgiveness never exceeds the shortage, and a long break gap is not a late arrival", () => {
    // Late 5 (inside grace) but the shortage comes from a 90-minute lunch.
    const result = day({
      shift: graced(),
      punches: punches("09:35", "13:00", "14:30", "18:35"),
    });
    assert.equal(result.late_minutes, 5);
    assert.equal(result.worked_minutes, 450);
    assert.equal(result.shortage_minutes, 55, "60 short, 5 forgiven for the late");
  });

  it("the grace settings are part of the snapshot hash", () => {
    assert.notEqual(shift().snapshot_hash, shift({ config: { late_grace_minutes: 10 } }).snapshot_hash);
  });
});

describe("deduction rule - Deduct Minutes per Deduction Interval, settled inside the shortage", () => {
  const ruled = (extra = {}) =>
    shift({
      in_time: "09:30",
      out_time: "18:30",
      break_minutes: 30,
      config: {
        late_grace_minutes: 10,
        late_exclude_grace_from_deduction: 1,
        late_deduction_interval_minutes: 15,
        late_deduct_minutes: 30,
        early_exit_grace_minutes: 10,
        early_exit_deduction_interval_minutes: 15,
        early_exit_deduct_minutes: 30,
        ...extra,
      },
    });

  it("interval 1 / deduct 1 (or 0 / 0) is the plain one-for-one shortage", () => {
    const a = day({
      shift: ruled({ late_deduction_interval_minutes: 1, late_deduct_minutes: 1 }),
      punches: punches("09:45", "18:30"),
    });
    const b = day({
      shift: ruled({ late_deduction_interval_minutes: 0, late_deduct_minutes: 0 }),
      punches: punches("09:45", "18:30"),
    });
    assert.equal(a.shortage_minutes, 5);
    assert.equal(b.shortage_minutes, 5);
  });

  it("late 25 on grace 10 (excluded): 15 counted -> one started interval -> 30 charged", () => {
    const result = day({ shift: ruled(), punches: punches("09:55", "18:30") });
    assert.equal(result.late_minutes, 25);
    assert.equal(result.grace_forgiven_minutes, 10);
    assert.equal(result.late_charged_minutes, 30);
    assert.equal(result.shortage_minutes, 30);
    assert.equal(result.worked_minutes, 485, "worked minutes are never changed by the rule");
  });

  it("late 26: 16 counted -> two started intervals -> 60 charged", () => {
    const result = day({ shift: ruled(), punches: punches("09:56", "18:30") });
    assert.equal(result.shortage_minutes, 60);
  });

  it("with the exclusion off the whole 25 counts -> two intervals -> 60", () => {
    const result = day({
      shift: ruled({ late_exclude_grace_from_deduction: 0 }),
      punches: punches("09:55", "18:30"),
    });
    assert.equal(result.grace_forgiven_minutes, 0);
    assert.equal(result.shortage_minutes, 60);
  });

  it("early out has its own rule: out 20 early -> 20 counted -> 60 charged", () => {
    const result = day({ shift: ruled(), punches: punches("09:30", "18:10") });
    assert.equal(result.early_exit_minutes, 20);
    assert.equal(result.early_exit_charged_minutes, 60);
    assert.equal(result.shortage_minutes, 60);
  });

  it("a late arrival worked off at the end of the day is charged nothing", () => {
    // 25 late, 25 stayed on: no shortage, so nothing to settle, and no
    // penalty is invented from a day the employee fully worked.
    const result = day({ shift: ruled(), punches: punches("09:55", "18:55") });
    assert.equal(result.shortage_minutes, 0);
    assert.equal(result.late_charged_minutes, 0);
  });

  it("a shortage from a long break is not scaled by the late rule", () => {
    // 5 late (forgiven) and a 90-minute lunch: 60 short from the break only.
    const result = day({ shift: ruled(), punches: punches("09:35", "13:00", "14:30", "18:35") });
    assert.equal(result.shortage_minutes, 55);
    assert.equal(result.late_charged_minutes, 0);
  });

  it("the 4 Sep case: left before 15:00, so no lunch credit - late 17 + early 4h 26m", () => {
    // 09:57 -> 14:04 on 09:30-18:30 / 30m break: raw shortage 263, but the
    // last punch is before 15:00 so the 30m break is not credited: 17 late
    // (27 less 10 grace) + 266 early = 283.
    const result = day({
      shift: ruled({ late_deduction_interval_minutes: 1, late_deduct_minutes: 1, early_exit_deduction_interval_minutes: 1, early_exit_deduct_minutes: 1 }),
      punches: punches("09:57", "14:04"),
    });
    assert.equal(result.late_minutes, 27);
    assert.equal(result.early_exit_minutes, 266);
    assert.equal(result.worked_minutes, 247);
    assert.equal(result.break_credit_withheld, true);
    assert.equal(result.grace_forgiven_minutes, 10);
    assert.equal(result.late_charged_minutes, 17);
    assert.equal(result.early_exit_charged_minutes, 266);
    assert.equal(result.shortage_minutes, 283);
    assert.ok(result.notes.some((n) => /no lunch taken/.test(n)));
  });

  it("leaving at or after 15:00 keeps the break credit: late 27 -> 17, early 210 of which 180 in the shortage", () => {
    // 09:57 -> 15:00: span 303, no break charged, raw shortage 207.
    const result = day({
      shift: ruled({ late_deduction_interval_minutes: 1, late_deduct_minutes: 1, early_exit_deduction_interval_minutes: 1, early_exit_deduct_minutes: 1 }),
      punches: punches("09:57", "15:00"),
    });
    assert.equal(result.break_credit_withheld, false);
    assert.equal(result.shortage_minutes, 207 - 10);
  });

  it("the no-lunch rule never applies to a four-punch day: the gaps are the break", () => {
    const result = day({
      shift: ruled({ late_deduction_interval_minutes: 1, late_deduct_minutes: 1 }),
      punches: punches("09:30", "11:00", "11:20", "14:00"),
    });
    assert.equal(result.break_credit_withheld, false);
  });

  it("the settled shortage is capped at NRM", () => {
    const result = day({
      shift: ruled({ late_deduct_minutes: 600 }),
      punches: punches("11:00", "18:30"),
    });
    assert.equal(result.nrm_minutes, 510);
    assert.equal(result.shortage_minutes, 510);
  });

  it("the rule's settings are part of the snapshot hash", () => {
    assert.notEqual(ruled().snapshot_hash, ruled({ late_deduct_minutes: 45 }).snapshot_hash);
  });
});

describe("Exclude Minimum OT - only the minutes beyond the minimum are paid", () => {
  const excl = (extra = {}) =>
    shift({
      in_time: "09:30",
      out_time: "18:30",
      break_minutes: 30,
      config: {
        overtime_allowed: 1,
        overtime_minimum_minutes: 20,
        overtime_minimum_excluded: 1,
        overtime_rounding_method: "UP",
        overtime_rounding_interval_minutes: 1,
        ...extra,
      },
    });

  it("2 Sep: 39 minutes after out-time on a 20-minute minimum pays 19", () => {
    const result = day({ shift: excl(), punches: punches("09:30", "19:09") });
    assert.equal(result.raw_ot_minutes, 39);
    assert.equal(result.candidate_ot_minutes, 19);
  });

  it("under the minimum pays nothing; exactly the minimum pays nothing", () => {
    assert.equal(day({ shift: excl(), punches: punches("09:30", "18:49") }).candidate_ot_minutes, 0);
    assert.equal(day({ shift: excl(), punches: punches("09:30", "18:50") }).candidate_ot_minutes, 0);
  });

  it("with the flag off the existing readings apply (threshold-only pays 39, floor pays 39)", () => {
    assert.equal(
      day({ shift: excl({ overtime_minimum_excluded: 0, overtime_minimum_threshold_only: 1 }), punches: punches("09:30", "19:09") }).candidate_ot_minutes,
      39
    );
    assert.equal(
      day({ shift: excl({ overtime_minimum_excluded: 0, overtime_minimum_threshold_only: 0 }), punches: punches("09:30", "19:09") }).candidate_ot_minutes,
      39
    );
  });

  it("rounding and the cap apply to the excess", () => {
    const rounded = day({
      shift: excl({ overtime_rounding_method: "UP", overtime_rounding_interval_minutes: 15 }),
      punches: punches("09:30", "19:09"),
    });
    assert.equal(rounded.candidate_ot_minutes, 30, "19 rounded up to 15s");
    const capped = day({ shift: excl({ maximum_ot_minutes_per_day: 10 }), punches: punches("09:30", "19:09") });
    assert.equal(capped.candidate_ot_minutes, 10);
  });

  it("pre-shift OT has its own exclusion: 25 minutes early on a 10-minute minimum pays 15", () => {
    const pre = excl({
      pre_shift_overtime_allowed: 1,
      pre_shift_overtime_minimum_minutes: 10,
      pre_shift_overtime_minimum_excluded: 1,
    });
    const result = day({ shift: pre, punches: punches("09:05", "18:30") });
    assert.equal(result.pre_shift_minutes, 25);
    assert.equal(result.pre_shift_ot_minutes, 15);
    assert.equal(result.candidate_ot_minutes, 15);
    const off = day({ shift: excl({ pre_shift_overtime_allowed: 1, pre_shift_overtime_minimum_minutes: 10 }), punches: punches("09:05", "18:30") });
    assert.equal(off.pre_shift_ot_minutes, 25);
  });

  it("the flags are part of the snapshot hash", () => {
    assert.notEqual(excl().snapshot_hash, excl({ overtime_minimum_excluded: 0 }).snapshot_hash);
  });
});
