/**
 * EMPLOYEE ATTENDANCE CALCULATION TYPE - the pure half: the dated resolver
 * and the engine's Present/Absent Only branch.
 *
 *   node --test utils/attendance_calculation_mode.test.js
 *
 * The orchestration half (both calculating paths, recalculation, storage,
 * payroll) is `usecase/attendance_calculation_mode.test.js`.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  ATTENDANCE_CALCULATION_MODE: MODE,
  MODE_RESOLUTION_STATUS,
  resolveAttendanceCalculationMode,
  modeResolver,
  modeAwareCutoffReader,
  affectedRangeForNewMode,
} = require("./attendance_calculation_mode");
const {
  CALC_STATUS,
  PUNCH_SOURCE,
  calculateAttendanceDay,
  attendanceDateForPunch,
} = require("./attendance_engine");
const { buildShiftSnapshot } = require("./shiftResolution");
const { presenceSlice, unresolvedReason, dayIssueKey, PRESENCE_SLICE } = require("./attendance_dashboard");
const { exclusionReason, EXCLUSION } = require("./attendance_missing");
const { computeMonthlyAttendancePayroll } = require("./attendance_payroll");

const DATE = "2026-10-05"; // a Monday

function shift(config = {}) {
  return buildShiftSnapshot(
    {
      work_shift_id: 7,
      work_shift_weekly_schedule_id: 71,
      is_working_day: 1,
      in_time: "09:00",
      out_time: "21:00",
      attendance_day_cutoff: "04:00",
      break_minutes: 60,
      ot_rate: 1.5,
    },
    { work_shift_id: 7, shift_code: "GEN", overtime_allowed: 1, ...config },
    1
  );
}

function punches(...times) {
  return times.map((t, i) => ({
    punch_id: 1000 + i,
    source: PUNCH_SOURCE.BIOMAX,
    dev_id: "DEV1",
    io_time: t.length > 5 ? t : `${DATE} ${t}:00`,
  }));
}

const PAO = (over = {}) =>
  calculateAttendanceDay({
    employee_id: 42,
    attendance_date: DATE,
    shift: shift(),
    punches: [],
    attendance_calculation_mode: MODE.PRESENT_ABSENT_ONLY,
    ...over,
  });

/** Every field that would carry a shift-timing verdict or a charge. */
function assertNoShiftTimingFigures(d) {
  assert.equal(d.shortage_minutes, 0, "no shortage");
  assert.equal(d.late_minutes, null, "no late");
  assert.equal(d.early_exit_minutes, null, "no early out");
  assert.equal(d.late_charged_minutes, 0);
  assert.equal(d.early_exit_charged_minutes, 0);
  assert.equal(d.nrm_minutes, 0, "no shift duration is consumed");
  assert.equal(d.base_nrm_minutes, 0);
  assert.equal(d.worked_minutes, 0);
  assert.equal(d.regular_minutes, 0);
  assert.equal(d.candidate_ot_minutes, 0, "no OT from punch duration");
  assert.equal(d.raw_ot_minutes, 0);
  assert.equal(d.shift_authorised_ot_minutes, 0, "no shift-authorised OT");
  assert.equal(d.excess_ot_minutes, 0);
  assert.equal(d.approved_ot_minutes, 0);
  assert.equal(d.extra_break_minutes_applied, 0);
  assert.equal(d.break_override_minutes_applied, null);
  assert.deepEqual(d.review_reasons, [], "no MISSING_PUNCH / NO_SHIFT / BREAK_EXCEEDS_SHIFT");
  assert.equal(d.work_shift_id, null, "no shift is recorded - none was read");
  assert.equal(d.shift_snapshot, null);
}

/* ================================================================ resolver */

describe("the dated resolver", () => {
  const HISTORY = [
    { employee_attendance_calculation_mode_id: 1, calculation_mode: MODE.PRESENT_ABSENT_ONLY, effective_from: "2026-10-01" },
  ];

  it("no history at all is SHIFT_BASED on every date - the opt-in default", () => {
    assert.equal(resolveAttendanceCalculationMode([], "2026-10-15"), MODE.SHIFT_BASED);
    assert.equal(resolveAttendanceCalculationMode(null, "2026-10-15"), MODE.SHIFT_BASED);
  });

  it("the day BEFORE the effective date uses the old mode; the effective date uses the new one", () => {
    assert.equal(resolveAttendanceCalculationMode(HISTORY, "2026-09-30"), MODE.SHIFT_BASED);
    assert.equal(resolveAttendanceCalculationMode(HISTORY, "2026-10-01"), MODE.PRESENT_ABSENT_ONLY);
    assert.equal(resolveAttendanceCalculationMode(HISTORY, "2026-10-31"), MODE.PRESENT_ABSENT_ONLY);
  });

  it("a later change does not reinterpret an earlier date (history is preserved)", () => {
    const later = [
      ...HISTORY,
      { employee_attendance_calculation_mode_id: 2, calculation_mode: MODE.SHIFT_BASED, effective_from: "2026-11-01" },
    ];
    assert.equal(resolveAttendanceCalculationMode(later, "2026-09-15"), MODE.SHIFT_BASED);
    assert.equal(resolveAttendanceCalculationMode(later, "2026-10-15"), MODE.PRESENT_ABSENT_ONLY);
    assert.equal(resolveAttendanceCalculationMode(later, "2026-11-15"), MODE.SHIFT_BASED);
  });

  it("a same-date correction wins on id, newest first, whatever the order rows arrive in", () => {
    const corrected = [
      { employee_attendance_calculation_mode_id: 9, calculation_mode: MODE.SHIFT_BASED, effective_from: "2026-10-01" },
      ...HISTORY,
    ];
    assert.equal(resolveAttendanceCalculationMode(corrected, "2026-10-01"), MODE.SHIFT_BASED);
  });

  it("an unknown mode value in the table is ignored rather than guessed at", () => {
    const junk = [{ employee_attendance_calculation_mode_id: 3, calculation_mode: "HALF", effective_from: "2026-10-01" }];
    assert.equal(resolveAttendanceCalculationMode(junk, "2026-10-02"), MODE.SHIFT_BASED);
  });

  it("modeResolver memoizes the same answer per date", () => {
    const modeFor = modeResolver(HISTORY);
    assert.equal(modeFor("2026-09-30"), MODE.SHIFT_BASED);
    assert.equal(modeFor("2026-10-01"), MODE.PRESENT_ABSENT_ONLY);
  });

  it("affectedRangeForNewMode stops at the next later row", () => {
    assert.deepEqual(affectedRangeForNewMode({ history: HISTORY, effectiveFrom: "2026-09-15" }), {
      from: "2026-09-15",
      superseded_from: "2026-10-01",
    });
    assert.deepEqual(affectedRangeForNewMode({ history: HISTORY, effectiveFrom: "2026-10-15" }), {
      from: "2026-10-15",
      superseded_from: null,
    });
  });
});

/* ======================================================= punch dating */

describe("punch dating under the mode", () => {
  const readShiftCutoff = () => ({ is_working_day: 1, attendance_day_cutoff: "04:00" });

  it("a Present/Absent Only date claims no punch of the following morning", () => {
    const modeFor = () => MODE.PRESENT_ABSENT_ONLY;
    const readCutoff = modeAwareCutoffReader(readShiftCutoff, modeFor);
    assert.equal(attendanceDateForPunch({ ioTime: "2026-10-06 01:30:00", readCutoff }), "2026-10-06");
  });

  it("the transition night: the last Shift Based night keeps its 00:30 OUT", () => {
    const modeFor = modeResolver([
      { employee_attendance_calculation_mode_id: 1, calculation_mode: MODE.PRESENT_ABSENT_ONLY, effective_from: "2026-10-01" },
    ]);
    const readCutoff = modeAwareCutoffReader(readShiftCutoff, modeFor);
    // 30/09 is Shift Based with a 04:00 cutoff: 01/10 00:30 belongs to 30/09.
    assert.equal(attendanceDateForPunch({ ioTime: "2026-10-01 00:30:00", readCutoff }), "2026-09-30");
    // 01/10 is Present/Absent Only: 02/10 00:30 is dated by the calendar.
    assert.equal(attendanceDateForPunch({ ioTime: "2026-10-02 00:30:00", readCutoff }), "2026-10-02");
  });

  it("Shift Based dating is untouched by the wrapper", () => {
    const readCutoff = modeAwareCutoffReader(readShiftCutoff, () => MODE.SHIFT_BASED);
    assert.equal(attendanceDateForPunch({ ioTime: "2026-10-06 01:30:00", readCutoff }), "2026-10-05");
  });
});

/* ============================================ Shift Based regression */

describe("Shift Based regression - the engine is unchanged", () => {
  const cases = {
    "a plain full day": { punches: punches("09:00", "21:00") },
    "a late arrival": { punches: punches("09:40", "21:00") },
    "an early exit": { punches: punches("09:00", "18:00") },
    "an odd punch count": { punches: punches("09:00", "13:00", "13:30") },
    "a long OT day": { punches: punches("09:00", "23:30") },
    "no punches": { punches: [] },
    "no shift": { punches: punches("09:00", "21:00"), shift: null, shift_status: "NO_SHIFT_FOR_DATE" },
  };
  for (const [name, input] of Object.entries(cases)) {
    it(`${name}: identical with the mode omitted and with SHIFT_BASED stated`, () => {
      const base = { employee_id: 42, attendance_date: DATE, shift: shift(), ...input };
      const omitted = calculateAttendanceDay(base);
      const stated = calculateAttendanceDay({ ...base, attendance_calculation_mode: MODE.SHIFT_BASED });
      assert.deepEqual(stated, omitted);
      assert.equal(omitted.attendance_calculation_mode, MODE.SHIFT_BASED);
    });
  }

  it("and a Shift Based late day still reports its late minutes and shortage", () => {
    const d = calculateAttendanceDay({ employee_id: 42, attendance_date: DATE, shift: shift(), punches: punches("09:40", "21:00") });
    assert.equal(d.late_minutes, 40);
    assert.ok(d.shortage_minutes > 0);
    assert.equal(d.status, CALC_STATUS.FINAL);
  });
});

/* ===================================================== Present/Absent Only */

describe("Present/Absent Only - the engine branch", () => {
  it("qualifying attendance is Present: FINAL, one complete payable day", () => {
    const d = PAO({ punches: punches("09:00", "21:00") });
    assert.equal(d.status, CALC_STATUS.FINAL);
    assert.equal(d.is_final, true);
    assert.equal(d.attendance_day_count, 1);
    assert.equal(d.attendance_calculation_mode, MODE.PRESENT_ABSENT_ONLY);
    assertNoShiftTimingFigures(d);
  });

  it("late arrival: still Present, no Late, no shortage", () => {
    const d = PAO({ punches: punches("11:45", "21:00") });
    assert.equal(d.status, CALC_STATUS.FINAL);
    assert.equal(d.attendance_day_count, 1);
    assertNoShiftTimingFigures(d);
  });

  it("early departure: still Present, no Early, no shortage", () => {
    const d = PAO({ punches: punches("09:00", "12:10") });
    assert.equal(d.status, CALC_STATUS.FINAL);
    assertNoShiftTimingFigures(d);
  });

  it("a very short stay (15 minutes) is still Present", () => {
    const d = PAO({ punches: punches("09:00", "09:15") });
    assert.equal(d.status, CALC_STATUS.FINAL);
    assert.equal(d.attendance_day_count, 1);
    assertNoShiftTimingFigures(d);
  });

  it("a single punch is Present - no ODD_PUNCHES / MISSING_PUNCH", () => {
    const d = PAO({ punches: punches("09:00") });
    assert.equal(d.status, CALC_STATUS.FINAL);
    assert.equal(d.is_final, true);
    assert.equal(d.punch_count, 1);
    assertNoShiftTimingFigures(d);
  });

  it("an odd multi-punch day (5 punches) is Present, not a missing punch", () => {
    const d = PAO({ punches: punches("09:00", "11:00", "11:20", "15:00", "15:40") });
    assert.equal(d.status, CALC_STATUS.FINAL);
    assertNoShiftTimingFigures(d);
  });

  it("no shift assignment + attendance: Present, NOT No Shift", () => {
    const d = PAO({ punches: punches("09:00", "17:00"), shift: null, shift_status: "NO_SHIFT_FOR_DATE" });
    assert.equal(d.status, CALC_STATUS.FINAL);
    assert.notEqual(d.status, CALC_STATUS.NO_SHIFT_FOR_DATE);
    assertNoShiftTimingFigures(d);
  });

  it("a shift with no schedule row + attendance: Present, not a Shift Setup Issue", () => {
    const d = PAO({ punches: punches("09:00"), shift: null, shift_status: "NO_SCHEDULE_ROW" });
    assert.equal(d.status, CALC_STATUS.FINAL);
  });

  it("no attendance is Absent (final, count 0) - with or without a shift", () => {
    for (const s of [shift(), null]) {
      const d = PAO({ shift: s, shift_status: s ? "OK" : "NO_SHIFT_FOR_DATE" });
      assert.equal(d.status, CALC_STATUS.ABSENT);
      assert.equal(d.is_final, true);
      assert.equal(d.attendance_day_count, 0);
      assert.equal(d.shortage_minutes, 0, "an absent day is simply not paid, never charged");
    }
  });

  it("a long punch duration does not create OT - not even with an approved figure handed in", () => {
    const d = PAO({ punches: punches("06:00", "23:55"), approved_ot_minutes: 300, shift_authorised: true });
    assert.equal(d.candidate_ot_minutes, 0);
    assert.equal(d.approved_ot_minutes, 0);
    assert.equal(d.shift_authorised_ot_minutes, 0);
  });

  it("Extra Break Hours that would exceed the shift raise no BREAK_EXCEEDS_SHIFT", () => {
    const d = PAO({ punches: punches("09:00", "10:00", "10:30", "21:00"), extra_break_minutes: 900 });
    assert.equal(d.status, CALC_STATUS.FINAL);
    assert.deepEqual(d.review_reasons, []);
  });

  it("only EFFECTIVE punches count: the excluded (voided / duplicate) ones decide nothing", () => {
    const excluded = [{ punch_id: 7, io_time: `${DATE} 09:00:00`, effective_status: "VOIDED" }];
    const d = PAO({ punches: [], excluded_punches: excluded });
    assert.equal(d.status, CALC_STATUS.ABSENT, "a voided punch is not attendance");
    assert.equal(d.excluded_punches.length, 1, "but it is still carried for the audit view");
  });

  it("an APPROVED regularized punch is attendance", () => {
    const d = PAO({ regularized_punches: [{ punch_id: null, io_time: `${DATE} 10:00:00` }] });
    assert.equal(d.status, CALC_STATUS.FINAL);
  });

  it("a pending correction holds only a day with no attendance; a Present day stays Present", () => {
    const none = PAO({ regularization_pending: true });
    assert.equal(none.status, CALC_STATUS.REGULARIZATION_PENDING);
    assert.equal(none.is_final, false);
    const present = PAO({ punches: punches("09:00"), regularization_pending: true });
    assert.equal(present.status, CALC_STATUS.FINAL);
    assert.equal(present.is_final, true);
  });

  it("the attendance exemption still takes precedence", () => {
    const d = PAO({ punches: punches("09:00"), attendance_required: false });
    assert.equal(d.status, CALC_STATUS.ATTENDANCE_NOT_REQUIRED);
  });
});

/* ======================================================== consumers */

describe("screens and reports read a Present/Absent Only day correctly", () => {
  it("the day carries no issue: not Missing Punch, not No Shift", () => {
    assert.equal(dayIssueKey(PAO({ punches: punches("09:00") })), null);
    assert.equal(dayIssueKey(PAO({ punches: punches("09:00"), shift: null })), null);
  });

  it("the dashboard does not put a no-shift, no-punch employee in Unresolved", () => {
    const d = PAO({ shift: null });
    const slice = presenceSlice({ day: d, resolution_status: MODE_RESOLUTION_STATUS, day_closed: true });
    assert.equal(slice, PRESENCE_SLICE.NO_RECORD);
    assert.equal(unresolvedReason({ day: d, resolution_status: MODE_RESOLUTION_STATUS, day_closed: true }), null);
  });

  it("the Missing Attendance report does not chase a single-punch Present day", () => {
    const d = PAO({ punches: punches("09:00") });
    const employee = { employee_id: 42, attendance_required: 1 };
    assert.equal(
      exclusionReason({ employee, date: DATE, day: d, today: "2026-10-10" }),
      EXCLUSION.PRESENT_ABSENT_ONLY
    );
    // ...while a Shift Based odd day still is Missing Attendance.
    const shiftDay = calculateAttendanceDay({ employee_id: 42, attendance_date: DATE, shift: shift(), punches: punches("09:00") });
    assert.equal(exclusionReason({ employee, date: DATE, day: shiftDay, today: "2026-10-10" }), null);
  });
});

/* ========================================================== payroll */

describe("payroll consumes the day as one complete payable day", () => {
  const month = (days) =>
    computeMonthlyAttendancePayroll({
      employee_id: 42,
      year: 2026,
      month: 10,
      monthly_gross: 26000,
      days,
      joined_on: "2025-01-01",
      ended_on: null,
    });

  const allDates = Array.from({ length: 31 }, (_, i) => `2026-10-${String(i + 1).padStart(2, "0")}`);

  it("a present day with a ten-minute stay is paid in full: no shortage deduction", () => {
    const days = allDates.map((date, i) =>
      calculateAttendanceDay({
        employee_id: 42,
        attendance_date: date,
        shift: shift(),
        attendance_calculation_mode: MODE.PRESENT_ABSENT_ONLY,
        // 27 attended days - the first 27 of the month - each a TEN-MINUTE stay
        punches: i < 27 ? [{ punch_id: i * 2 + 1, io_time: `${date} 09:00:00` }, { punch_id: i * 2 + 2, io_time: `${date} 09:10:00` }] : [],
      })
    );
    const p = month(days);
    assert.equal(p.attendance_days, 27);
    assert.equal(Number(p.missing_minute_deduction), 0);
    assert.equal(p.shortage_minutes, 0);
    assert.equal(Number(p.approved_ot_minutes), 0);
    assert.equal(p.is_final, true, "no day is held");
    assert.deepEqual(p.unrated_dates || [], [], "no zero-NRM day is flagged: nothing on it needs a rate");
    // The existing weekly-off rule (notional offs) is applied exactly as for
    // any month: 31 dates, 4 notional offs, 27 base days.
    assert.equal(p.notional_offs, 4);
    assert.equal(p.base_days, 27);
    assert.equal(p.salary_days, 27);
    assert.equal(p.extra_days, 0);
    assert.equal(Number(p.salary_day_earnings), 27 * 1000);
  });

  it("the same ten-minute stays under Shift Based would be charged - so the mode is doing the work", () => {
    const days = allDates.slice(0, 3).map((date, i) =>
      calculateAttendanceDay({
        employee_id: 42,
        attendance_date: date,
        shift: shift(),
        punches: [{ punch_id: i * 2 + 1, io_time: `${date} 09:00:00` }, { punch_id: i * 2 + 2, io_time: `${date} 09:10:00` }],
      })
    );
    assert.ok(month(days).shortage_minutes > 0);
  });
});
