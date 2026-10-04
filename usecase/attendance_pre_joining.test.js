/**
 * THE JOINING DATE IS THE HARD LOWER BOUNDARY OF ATTENDANCE AND PAYROLL.
 *
 * Regression for employee 2284, who joined on 09-09-2026: Employee Attendance
 * for September showed 01-09 to 08-09 as "No Shift Assigned", and Process
 * Attendance stored those dates as NO_SHIFT_FOR_DATE rows that held the
 * monthly summary out of payroll until somebody closed it by hand.
 *
 * WHY THEY WERE MATERIALISED. `calculateRange` - the one engine path behind
 * the screen's read (`readRange`), the month read and the month persist
 * (`calculateMonth({persist:true})`) - calculated every date of the range
 * with no employment bound. Recalculate clamped its window to the joining
 * date, but Process Attendance did not, so a pre-joining date became a
 * NO_SHIFT_FOR_DATE day: on screen as a live preview, then in
 * `attendance_day_calculation` as a stored row, and in the monthly summary as
 * a HELD date (is_final = 0).
 *
 * Every case below uses the same Sep 9 joiner and covers 1-8 Sep and 9 Sep
 * onward, through the REAL usecases over fakes.
 *
 *   node --test usecase/attendance_pre_joining.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildCalculation = require("./attendance_calculation");
const buildRegularization = require("./attendance_regularization");
const { EmployeeWorkShiftUsecase } = require("./employee_work_shift");
const { calculateAttendanceDay, CALC_STATUS } = require("../utils/attendance_engine");
const { computeMonthlyAttendancePayroll } = require("../utils/attendance_payroll");
const { dayIssueKey } = require("../utils/attendance_dashboard");
const { notBeforeJoining } = require("../repository/employee_work_shift");

const EMP = 2284;
const JOINED = "2026-09-09";
// Well after September has closed, so every date of it is a closed date.
const NOW = Date.parse("2026-10-04T12:00:00+05:30");

const weekly = (workShiftId) =>
  Array.from({ length: 7 }, (_, day) => ({
    work_shift_weekly_schedule_id: workShiftId * 100 + day,
    work_shift_id: workShiftId,
    day_of_week: day,
    is_working_day: 1,
    in_time: "10:00:00",
    out_time: "22:00:00",
    attendance_day_cutoff: "04:00:00",
    break_minutes: 60,
    normal_work_minutes: 660,
    ot_rate: 1,
  }));
const SHIFT = {
  config: {
    work_shift_id: 7, shift_code: "LATE", shift_name: "Late Shift", active: 1,
    overtime_allowed: 1, overtime_minimum_minutes: 0, overtime_rounding_method: "NONE",
    overtime_rounding_interval_minutes: 0, overtime_minimum_threshold_only: 0,
    maximum_ot_minutes_per_day: null, pre_shift_overtime_allowed: 0,
    pre_shift_overtime_minimum_minutes: 0, pre_shift_overtime_rounding_method: "NONE",
    pre_shift_overtime_rounding_interval_minutes: 0, late_offset_against_overtime: 0,
    early_exit_offset_against_overtime: 0,
  },
  schedule: weekly(7),
};

const pad = (n) => String(n).padStart(2, "0");
const sep = (d) => `2026-09-${pad(d)}`;
const SEP_1_TO_8 = [1, 2, 3, 4, 5, 6, 7, 8].map(sep);

/** A clean 10:00-22:00 day for every date from the 9th to the 30th. */
function workedPunches() {
  const punches = [];
  let id = 1;
  for (let d = 9; d <= 30; d += 1) {
    for (const t of ["10:00:00", "22:00:00"]) {
      punches.push({
        punch_id: id++, employee_id: EMP, io_time: `${sep(d)} ${t}`, punch_date: sep(d),
        ingest_attendance_date: sep(d), dev_id: "DEV1", ingest_source: "DEVICE",
      });
    }
  }
  return punches;
}

/**
 * The world as it was found: a shift history row backfilled from 01-09 (the
 * A0 cutover) - so a roster DOES cover the pre-joining dates - plus stale
 * stored rows for 01-09..08-09 left by an earlier Process Attendance.
 */
function world({ punches = workedPunches(), stored = null } = {}) {
  const saved = { months: [], reconciliations: [], overrides: [] };
  const staleRows =
    stored ||
    SEP_1_TO_8.map((date) => ({
      employee_id: EMP, attendance_date: date, status: "NO_SHIFT_FOR_DATE", is_final: 0,
      attendance_day_count: 0, review_reasons: JSON.stringify(["NO_SHIFT_FOR_DATE"]),
      calculation_version: 11,
    }));
  const employee = {
    employee_id: EMP, status: 1, attendance_required: 1,
    date_of_joining: JOINED, joined_on: JOINED, resignation_date: null,
  };
  const repo = {
    saved,
    getShiftAssignmentHistory: async () => [
      { employee_work_shift_assignment_id: 1, employee_id: EMP, work_shift_id: 7, effective_from: "2026-09-01", source: "MIGRATION_BACKFILL" },
    ],
    getDateShiftOverrides: async () => [],
    getWorkShiftWithSchedule: async (id) => (Number(id) === 7 ? SHIFT : null),
    getWorkShiftConfigVersions: async () => [],
    getRawPunchesByCalendarWindow: async (_e, from, to) =>
      punches.filter((p) => p.punch_date >= from && p.punch_date <= to),
    getApprovedRegularizedPunches: async () => [],
    getBreakOverride: async () => ({ employee_id: EMP, attendance_required: 1, joined_on: JOINED }),
    getApprovalStateByDate: async () => [],
    getEmploymentWindow: async () => ({ ...employee }),
    getMonthlyGrossAsOf: async () => ({ salary_id: 1, monthly_gross: 26000, effective_from: "2026-09-09" }),
    listCalculations: async ({ from_date, to_date }) =>
      staleRows.filter((r) => r.attendance_date >= from_date && r.attendance_date <= to_date),
    saveMonthWithPayroll: async (args) => {
      saved.months.push(args);
      return { written: args.rows.length, monthly_written: 1 };
    },
    saveCalculationsWithReconciliation: async (args) => {
      saved.reconciliations.push(args);
      return { written: args.rows.length, stale_removed: args.ineligible_dates.length };
    },
    findPayrollLockedPeriods: async () => [],
    saveDateShiftOverride: async (args) => {
      saved.overrides.push(args);
      return { written: 1 };
    },
  };
  const calculation = buildCalculation(repo);
  return { repo, saved, calculation };
}

/* =================================================================== */

describe("the engine: a date before the joining date", () => {
  it("is NOT_JOINED - settled, no shift, no minutes, no review reason", () => {
    const day = calculateAttendanceDay({
      employee_id: EMP,
      attendance_date: sep(3),
      shift: null,
      shift_status: "NO_SHIFT_FOR_DATE",
      before_joining: true,
    });
    assert.equal(day.status, CALC_STATUS.NOT_JOINED);
    assert.equal(day.is_final, true);
    assert.deepEqual(day.review_reasons, []);
    assert.equal(day.work_shift_id, null);
    // No late, no early exit: nothing was expected of them that day.
    assert.equal(day.late_minutes, null);
    assert.equal(day.early_exit_minutes, null);
    assert.equal(day.late_charged_minutes, 0);
    assert.equal(day.early_exit_charged_minutes, 0);
    assert.equal(day.excess_ot_minutes, 0);
    for (const f of ["attendance_day_count", "nrm_minutes", "worked_minutes", "shortage_minutes", "candidate_ot_minutes", "approved_ot_minutes", "permission_minutes", "payable_minutes"]) {
      assert.equal(day[f], 0, `${f} must be 0 before joining`);
    }
  });

  it("is never an attendance issue on any screen (not Absent, not No Shift, not Need Action)", () => {
    assert.equal(dayIssueKey({ status: "NOT_JOINED", review_reasons: [], punch_count: 0 }), null);
  });
});

describe("Employee Attendance for September (the screen's read)", () => {
  it("1-8 Sep read NOT_JOINED - never NO SHIFT ASSIGNED - even with a roster and stale stored rows covering them", async () => {
    const { calculation } = world();
    const days = await calculation.readRange({ employee_id: EMP, from_date: sep(1), to_date: sep(30), now: NOW });
    assert.equal(days.length, 30);
    const before = days.filter((d) => d.attendance_date < JOINED);
    assert.deepEqual(before.map((d) => d.attendance_date), SEP_1_TO_8);
    before.forEach((d) => {
      assert.equal(d.status, "NOT_JOINED", `${d.attendance_date}`);
      assert.equal(d.shift_resolution_status, "NOT_JOINED");
      assert.equal(d.shift_name, null);
      assert.ok(!d.review_reasons.includes("NO_SHIFT_FOR_DATE"));
      assert.equal(d.attendance_day_count, 0);
      assert.equal(d.shortage_minutes, 0);
      assert.equal(d.is_final, true);
      assert.equal(d.calculation_source, "LIVE_PREVIEW", "a stale stored row must not be shown for a pre-joining date");
    });
  });

  it("9 Sep onward is calculated normally under the rostered shift", async () => {
    const { calculation } = world();
    const days = await calculation.readRange({ employee_id: EMP, from_date: sep(1), to_date: sep(30), now: NOW });
    const after = days.filter((d) => d.attendance_date >= JOINED);
    assert.equal(after.length, 22);
    after.forEach((d) => {
      assert.equal(d.status, "FINAL", `${d.attendance_date}`);
      assert.equal(d.attendance_day_count, 1);
      assert.equal(d.nrm_minutes, 660);
      assert.equal(d.shift_name, "Late Shift");
    });
  });

  it("a 9 Sep onward date with no punch is still Absent - the boundary moves nothing after it", async () => {
    const { calculation } = world({ punches: workedPunches().filter((p) => p.punch_date !== sep(9)) });
    const [d9] = await calculation.readRange({ employee_id: EMP, from_date: sep(9), to_date: sep(9), now: NOW });
    assert.equal(d9.status, "ABSENT");
  });
});

describe("Process Attendance (the month persist) and the monthly summary", () => {
  it("stores 9-30 Sep only, removes the stale 1-8 Sep rows, and the month is FINAL with no manual closure", async () => {
    const { calculation, saved } = world();
    const result = await calculation.calculateMonth({ employee_id: EMP, year: 2026, month: 9, persist: true, now: NOW });

    assert.equal(saved.months.length, 1);
    const write = saved.months[0];
    const storedDates = write.rows.map((r) => r.attendance_date);
    assert.equal(storedDates.length, 22);
    assert.ok(storedDates.every((d) => d >= JOINED), `stored: ${storedDates}`);
    assert.ok(write.rows.every((r) => r.status !== "NOT_JOINED"));
    assert.deepEqual(write.outside_employment_dates, SEP_1_TO_8);

    // Eligibility starts on the joining date: 22 available dates, nothing held.
    assert.equal(write.monthly.available_from, JOINED);
    assert.equal(write.monthly.available_to, sep(30));
    assert.equal(write.monthly.available_dates, 22);
    assert.equal(write.monthly.attendance_days, 22);
    assert.deepEqual(JSON.parse(write.monthly.held_dates), []);
    assert.equal(write.monthly.is_final, 1);
    assert.equal(write.monthly.shortage_minutes, 0);
    assert.equal(result.is_final, true);
  });

  it("the payroll roll-up ignores pre-joining rows whatever their stored status", () => {
    const days = [
      ...SEP_1_TO_8.map((date) => ({ attendance_date: date, status: "NO_SHIFT_FOR_DATE", is_final: false, attendance_day_count: 0 })),
      // A stale FINAL row that had a day count and a shortage - still not theirs.
      { attendance_date: sep(8), status: "FINAL", is_final: true, attendance_day_count: 1, shortage_minutes: 30, nrm_minutes: 660, approved_ot_minutes: 45, ot_rate: 1 },
      ...Array.from({ length: 22 }, (_, i) => ({
        attendance_date: sep(9 + i), status: "FINAL", is_final: true, attendance_day_count: 1,
        shortage_minutes: 0, nrm_minutes: 660, approved_ot_minutes: 0, ot_rate: 1,
      })),
    ];
    const p = computeMonthlyAttendancePayroll({
      employee_id: EMP, year: 2026, month: 9, monthly_gross: 26000, days, joined_on: JOINED,
    });
    assert.equal(p.is_final, true);
    assert.deepEqual(p.held_dates, []);
    assert.equal(p.available_dates, 22);
    assert.equal(p.attendance_days, 22);
    assert.equal(p.shortage_minutes, 0);
    assert.equal(p.approved_ot_minutes, 0);
  });
});

describe("Recalculate (the stored history)", () => {
  it("calculates from 9 Sep and reconciles 1-8 Sep away", async () => {
    const { calculation, saved } = world();
    calculation.refreshAffectedMonths = async () => [];
    const r = await calculation.recalculateRange({ employee_id: EMP, from_date: sep(1), to_date: sep(30), now: NOW });
    assert.equal(r.eligible_from, JOINED);
    assert.deepEqual(r.ineligible_dates, SEP_1_TO_8);
    const rec = saved.reconciliations[0];
    assert.ok(rec.rows.every((row) => row.attendance_date >= JOINED));
    assert.deepEqual(rec.ineligible_dates, SEP_1_TO_8);
  });
});

describe("no shift before the joining date", () => {
  it("Edit Shift for a single pre-joining date is refused; 9 Sep is not", async () => {
    const { calculation, saved } = world();
    await assert.rejects(
      calculation.setDateShift({ employee_id: EMP, attendance_date: sep(5), work_shift_id: 7, actor_employee_id: 1, now: NOW }),
      /before this employee's joining date/
    );
    assert.equal(saved.overrides.length, 0);
  });

  function shiftUsecase() {
    const repo = {
      findExistingEmployeeIds: async () => [EMP],
      getJoiningDate: async () => JOINED,
      getActiveWorkShift: async () => ({ work_shift_id: 8, shift_code: "MORN", active: 1 }),
      listAssignmentHistory: async () => [
        { employee_work_shift_assignment_id: 1, employee_id: EMP, work_shift_id: 7, effective_from: JOINED },
      ],
      changeAssignment: async () => ({ code: 200, affected_from: JOINED, affected_to: sep(30) }),
      correctAssignment: async () => ({ code: 200 }),
    };
    return new EmployeeWorkShiftUsecase(repo);
  }

  it("a shift change effective before the joining date is refused", async () => {
    const u = shiftUsecase();
    await assert.rejects(
      u.changeAssignment({ employee_id: EMP, work_shift_id: 8, effective_from: sep(5), reason: "roster move", today: "2026-10-04" }),
      /before this employee's joining date 2026-09-09/
    );
  });

  it("a shift change effective on the joining date is accepted", async () => {
    const u = shiftUsecase();
    const r = await u.changeAssignment({ employee_id: EMP, work_shift_id: 8, effective_from: JOINED, reason: "roster move", today: "2026-10-04" });
    assert.notEqual(r.code, 422);
  });

  it("a history correction dated before the joining date is refused", async () => {
    const u = shiftUsecase();
    await assert.rejects(
      u.correctAssignment({ employee_id: EMP, work_shift_id: 8, effective_from: sep(1), note: "fix the backfilled row", today: "2026-10-04" }),
      /before this employee's joining date/
    );
  });

  it("a bulk assignment made ahead of the first day applies from the joining date", () => {
    assert.equal(notBeforeJoining("2026-09-05", JOINED), JOINED);
    assert.equal(notBeforeJoining("2026-09-20", JOINED), "2026-09-20");
    assert.equal(notBeforeJoining("2026-09-05", null), "2026-09-05");
  });
});

describe("no attendance request before the joining date", () => {
  const regularization = () => {
    const { calculation } = world();
    return buildRegularization({}, calculation);
  };

  it("an attendance correction for 5 Sep is refused", async () => {
    await assert.rejects(
      regularization().raiseRequest({
        actor: { employee_id: EMP }, requested_for_employee_id: EMP, attendance_date: sep(5),
        reason: "forgot to punch", punch_time: "22:00", today: "2026-09-20",
      }),
      /before this employee's joining date \(2026-09-09\)/
    );
  });

  it("an OT request for 5 Sep is refused", async () => {
    await assert.rejects(
      regularization().raiseOtRequest({ actor: { employee_id: EMP }, attendance_date: sep(5), reason: "stayed late", today: "2026-09-20" }),
      /before this employee's joining date/
    );
  });

  it("a one-day shift change request for 5 Sep is refused", async () => {
    await assert.rejects(
      regularization().raiseShiftChangeRequest({ actor: { employee_id: EMP }, attendance_date: sep(5), work_shift_id: 8, reason: "covering", today: "2026-09-20" }),
      /before this employee's joining date/
    );
  });
});

describe("payroll reads a stored summary with the same boundary (no re-process needed)", () => {
  const { effectiveAttendanceMonth } = require("../utils/attendance_month_effective");
  const { attendanceStatusOf } = require("../utils/payrun_eligibility");
  const stale = {
    employee_id: EMP, is_final: 0, available_from: JOINED,
    held_dates: JSON.stringify(SEP_1_TO_8),
  };

  it("a summary held ONLY by 1-8 Sep reads final, and payroll needs no manual close", () => {
    const row = effectiveAttendanceMonth(stale);
    assert.equal(row.is_final, 1);
    assert.deepEqual(row.pre_joining_held_dates, SEP_1_TO_8);
    assert.equal(attendanceStatusOf({ attendance: stale }).status, "PENDING", "as stored, it needed a close");
    assert.equal(attendanceStatusOf({ attendance: row }).status, "READY");
  });

  it("a held date on or after 9 Sep keeps it non-final", () => {
    assert.equal(effectiveAttendanceMonth({ ...stale, held_dates: JSON.stringify([sep(3), sep(9)]) }).is_final, 0);
    assert.equal(effectiveAttendanceMonth({ ...stale, held_dates: JSON.stringify([sep(15)]) }).is_final, 0);
  });

  it("a whole-month employee is never affected, and an unreadable row is left as stored", () => {
    assert.equal(effectiveAttendanceMonth({ ...stale, available_from: sep(1), held_dates: JSON.stringify([sep(3)]) }).is_final, 0);
    assert.equal(effectiveAttendanceMonth({ ...stale, held_dates: "not json" }).is_final, 0);
    assert.equal(effectiveAttendanceMonth({ ...stale, held_dates: "[]" }).is_final, 0);
    assert.equal(effectiveAttendanceMonth({ ...stale, available_from: null }).is_final, 0);
    assert.equal(effectiveAttendanceMonth(null), null);
    const final = { is_final: 1, available_from: JOINED, held_dates: "[]" };
    assert.equal(effectiveAttendanceMonth(final), final);
  });
});
