/**
 * THE LAST WORKING DATE IS THE HARD UPPER BOUNDARY OF ATTENDANCE.
 *
 * Regression for employee 2284 (joined 09-09-2026, last working date
 * 13-09-2026): Employee Attendance showed 14-09..30-09 as ABSENT, so the cards
 * read All 22 / Present 3 / Absent 19, while payroll had already bounded the
 * month to 09-09..13-09 (`available_to` = `new_employee.resignation_date`,
 * inclusive).
 *
 * WHY: the read path (`calculateRange`) and the month persist calculated every
 * date of the month with no upper employment bound. Recalculate and the
 * dashboard already used `employedOn` (both bounds); the engine did not, so a
 * post-exit date with a roster and no punch became an ABSENT day - on screen,
 * and stored by Process Attendance.
 *
 * Expected, through the REAL usecases over fakes:
 *   01-09..08-09  NOT_JOINED
 *   09-09..13-09  ordinary rules (punched 9-11 -> FINAL; 12-13 no punch -> ABSENT)
 *   14-09..30-09  EXITED
 *
 *   node --test usecase/attendance_post_exit.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildCalculation = require("./attendance_calculation");
const buildRegularization = require("./attendance_regularization");
const { EmployeeWorkShiftUsecase } = require("./employee_work_shift");
const { calculateAttendanceDay, CALC_STATUS } = require("../utils/attendance_engine");
const { computeMonthlyAttendancePayroll } = require("../utils/attendance_payroll");
const { effectiveAttendanceMonth } = require("../utils/attendance_month_effective");
const { attendanceStatusOf } = require("../utils/payrun_eligibility");
const { dayIssueKey } = require("../utils/attendance_dashboard");

const EMP = 2284;
const JOINED = "2026-09-09";
const LAST = "2026-09-13";
const NOW = Date.parse("2026-10-04T12:00:00+05:30");
const pad = (n) => String(n).padStart(2, "0");
const sep = (d) => `2026-09-${pad(d)}`;
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => sep(a + i));
const SEP_1_TO_8 = range(1, 8);
const SEP_9_TO_13 = range(9, 13);
const SEP_14_TO_30 = range(14, 30);

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
  // Every weekday a working day, so 12 and 13 Sep are genuinely expected days.
  schedule: Array.from({ length: 7 }, (_, day) => ({
    work_shift_weekly_schedule_id: 700 + day, work_shift_id: 7, day_of_week: day, is_working_day: 1,
    in_time: "10:00:00", out_time: "22:00:00", attendance_day_cutoff: "04:00:00",
    break_minutes: 60, normal_work_minutes: 660, ot_rate: 1,
  })),
};

/** Production's punches: 9, 10 and 11 Sep; nothing on 12 and 13. */
function punches() {
  const out = [];
  for (const d of [9, 10, 11]) {
    for (const t of ["10:00:00", "22:00:00"]) {
      out.push({
        punch_id: out.length + 1, employee_id: EMP, io_time: `${sep(d)} ${t}`, punch_date: sep(d),
        ingest_attendance_date: sep(d), dev_id: "DEV1", ingest_source: "DEVICE",
      });
    }
  }
  return out;
}

/** The stored world as found: 14-30 Sep stored ABSENT by an earlier Process Attendance. */
function world({ lastWorkingDate = LAST } = {}) {
  const saved = { months: [], reconciliations: [], overrides: [] };
  const stale = SEP_14_TO_30.map((date) => ({
    employee_id: EMP, attendance_date: date, status: "ABSENT", is_final: 1, attendance_day_count: 0,
    review_reasons: "[]", calculation_version: 11,
  }));
  const employee = {
    employee_id: EMP, status: 1, attendance_required: 1,
    date_of_joining: JOINED, joined_on: JOINED, resignation_date: lastWorkingDate,
  };
  const repo = {
    getShiftAssignmentHistory: async () => [
      { employee_work_shift_assignment_id: 1, employee_id: EMP, work_shift_id: 7, effective_from: "2026-09-01", source: "MIGRATION_BACKFILL" },
    ],
    getDateShiftOverrides: async () => [],
    getWorkShiftWithSchedule: async (id) => (Number(id) === 7 ? SHIFT : null),
    getWorkShiftConfigVersions: async () => [],
    getRawPunchesByCalendarWindow: async (_e, from, to) => punches().filter((p) => p.punch_date >= from && p.punch_date <= to),
    getApprovedRegularizedPunches: async () => [],
    getBreakOverride: async () => ({ employee_id: EMP, attendance_required: 1, joined_on: JOINED, resignation_date: lastWorkingDate }),
    getApprovalStateByDate: async () => [],
    getEmploymentWindow: async () => ({ ...employee }),
    getMonthlyGrossAsOf: async () => ({ salary_id: 1, monthly_gross: 26000, effective_from: JOINED }),
    listCalculations: async ({ from_date, to_date }) => stale.filter((r) => r.attendance_date >= from_date && r.attendance_date <= to_date),
    saveMonthWithPayroll: async (args) => { saved.months.push(args); return { written: args.rows.length, monthly_written: 1 }; },
    saveCalculationsWithReconciliation: async (args) => { saved.reconciliations.push(args); return { written: args.rows.length, stale_removed: args.ineligible_dates.length }; },
    findPayrollLockedPeriods: async () => [],
    saveDateShiftOverride: async (args) => { saved.overrides.push(args); return { written: 1 }; },
  };
  return { saved, calculation: buildCalculation(repo) };
}

/* =================================================================== */

describe("the engine: a date after the last working date", () => {
  it("is EXITED - settled, no shift, no minutes, no late/early, no OT, no review reason - and is not NOT_JOINED", () => {
    const day = calculateAttendanceDay({
      employee_id: EMP, attendance_date: sep(20), shift: null, shift_status: "NO_SHIFT_FOR_DATE", after_exit: true,
    });
    assert.equal(day.status, CALC_STATUS.EXITED);
    assert.notEqual(day.status, CALC_STATUS.NOT_JOINED);
    assert.equal(day.is_final, true);
    assert.deepEqual(day.review_reasons, []);
    assert.equal(day.work_shift_id, null);
    assert.equal(day.late_minutes, null);
    assert.equal(day.early_exit_minutes, null);
    for (const f of ["attendance_day_count", "nrm_minutes", "worked_minutes", "shortage_minutes", "candidate_ot_minutes",
      "approved_ot_minutes", "permission_minutes", "payable_minutes", "late_charged_minutes", "early_exit_charged_minutes"]) {
      assert.equal(day[f], 0, `${f} must be 0 after exit`);
    }
    assert.equal(dayIssueKey({ status: "EXITED", review_reasons: [], punch_count: 0 }), null, "never an attendance issue");
  });
});

describe("Employee Attendance for September (the screen's read)", () => {
  it("1-8 NOT_JOINED, 9-13 ordinary rules, 14-30 EXITED - even though 14-30 are stored ABSENT", async () => {
    const { calculation } = world();
    const days = await calculation.readRange({ employee_id: EMP, from_date: sep(1), to_date: sep(30), now: NOW });
    const byDate = Object.fromEntries(days.map((d) => [d.attendance_date, d]));
    SEP_1_TO_8.forEach((d) => assert.equal(byDate[d].status, "NOT_JOINED", d));
    for (const d of [9, 10, 11]) {
      assert.equal(byDate[sep(d)].status, "FINAL", sep(d));
      assert.equal(byDate[sep(d)].nrm_minutes, 660);
    }
    for (const d of [12, 13]) assert.equal(byDate[sep(d)].status, "ABSENT", `${sep(d)} is a working day with no punch`);
    SEP_14_TO_30.forEach((d) => {
      const day = byDate[d];
      assert.equal(day.status, "EXITED", d);
      assert.equal(day.calculation_source, "LIVE_PREVIEW", "the stale stored ABSENT row is not what is shown");
      assert.equal(day.shift_name, null);
      assert.equal(day.shift_resolution_status, "EXITED");
      assert.equal(day.nrm_minutes, 0);
      assert.equal(day.attendance_day_count, 0);
    });
  });
});

describe("Process Attendance and the monthly summary", () => {
  it("stores 9-13 Sep only, removes 1-8 and 14-30, and the summary is final over 09-09..13-09", async () => {
    const { calculation, saved } = world();
    const result = await calculation.calculateMonth({ employee_id: EMP, year: 2026, month: 9, persist: true, now: NOW });
    const write = saved.months[0];
    assert.deepEqual(write.rows.map((r) => r.attendance_date), SEP_9_TO_13);
    assert.ok(write.rows.every((r) => !["NOT_JOINED", "EXITED"].includes(r.status)));
    assert.deepEqual(write.outside_employment_dates, [...SEP_1_TO_8, ...SEP_14_TO_30]);
    assert.deepEqual(result.post_exit_dates, SEP_14_TO_30);

    assert.equal(write.monthly.available_from, JOINED);
    assert.equal(write.monthly.available_to, LAST);
    assert.equal(write.monthly.available_dates, 5);
    assert.equal(write.monthly.attendance_days, 3);
    assert.deepEqual(JSON.parse(write.monthly.held_dates), []);
    assert.equal(write.monthly.is_final, 1);
    assert.equal(write.monthly.shortage_minutes, 0);
  });

  it("the payroll roll-up ignores stale post-exit rows whatever their status or figures", () => {
    const days = [
      ...[9, 10, 11].map((d) => ({ attendance_date: sep(d), status: "FINAL", is_final: true, attendance_day_count: 1, shortage_minutes: 0, nrm_minutes: 660, approved_ot_minutes: 0, ot_rate: 1 })),
      ...[12, 13].map((d) => ({ attendance_date: sep(d), status: "ABSENT", is_final: true, attendance_day_count: 0 })),
      ...SEP_14_TO_30.map((d) => ({ attendance_date: d, status: "ABSENT", is_final: true, attendance_day_count: 0 })),
      // Stale rows that WOULD cost something if read: held, shortage, OT, a day.
      { attendance_date: sep(15), status: "NO_SHIFT_FOR_DATE", is_final: false, attendance_day_count: 0 },
      { attendance_date: sep(16), status: "FINAL", is_final: true, attendance_day_count: 1, shortage_minutes: 45, approved_ot_minutes: 60, nrm_minutes: 660, ot_rate: 1 },
    ];
    const p = computeMonthlyAttendancePayroll({ employee_id: EMP, year: 2026, month: 9, monthly_gross: 26000, days, joined_on: JOINED, ended_on: LAST });
    assert.equal(p.available_dates, 5);
    assert.equal(p.attendance_days, 3);
    assert.equal(p.shortage_minutes, 0);
    assert.equal(p.approved_ot_minutes, 0);
    assert.deepEqual(p.held_dates, []);
    assert.equal(p.is_final, true);
  });
});

describe("payroll reads a stored summary with the upper boundary too (no re-process needed)", () => {
  const stored = { employee_id: EMP, is_final: 0, available_from: JOINED, available_to: LAST };

  it("held only by post-exit dates (or pre-joining + post-exit) -> final, and payroll needs no manual close", () => {
    const onlyPost = { ...stored, held_dates: JSON.stringify([sep(15), sep(20)]) };
    assert.equal(attendanceStatusOf({ attendance: onlyPost }).status, "PENDING", "as stored it needed a close");
    const row = effectiveAttendanceMonth(onlyPost);
    assert.equal(row.is_final, 1);
    assert.deepEqual(row.post_exit_held_dates, [sep(15), sep(20)]);
    assert.equal(attendanceStatusOf({ attendance: row }).status, "READY");

    const both = effectiveAttendanceMonth({ ...stored, held_dates: JSON.stringify([sep(3), sep(20)]) });
    assert.equal(both.is_final, 1);
    assert.deepEqual(both.pre_joining_held_dates, [sep(3)]);
    assert.deepEqual(both.post_exit_held_dates, [sep(20)]);
  });

  it("a held date inside 09-09..13-09 keeps it non-final", () => {
    assert.equal(effectiveAttendanceMonth({ ...stored, held_dates: JSON.stringify([sep(13), sep(20)]) }).is_final, 0);
    assert.equal(effectiveAttendanceMonth({ ...stored, held_dates: JSON.stringify([sep(9)]) }).is_final, 0);
  });
});

describe("Recalculate", () => {
  it("calculates 9-13 Sep and reconciles 1-8 and 14-30 away", async () => {
    const { calculation, saved } = world();
    const r = await calculation.recalculateRange({ employee_id: EMP, from_date: sep(1), to_date: sep(30), now: NOW });
    assert.equal(r.eligible_from, JOINED);
    assert.equal(r.eligible_to, LAST);
    assert.deepEqual(r.ineligible_dates, [...SEP_1_TO_8, ...SEP_14_TO_30]);
    assert.deepEqual(saved.reconciliations[0].rows.map((x) => x.attendance_date), SEP_9_TO_13);
  });
});

describe("no shift after the last working date", () => {
  it("Edit Shift for 20 Sep is refused", async () => {
    const { calculation, saved } = world();
    await assert.rejects(
      calculation.setDateShift({ employee_id: EMP, attendance_date: sep(20), work_shift_id: 7, actor_employee_id: 1, now: NOW }),
      /not applicable after the employee's last working date/
    );
    assert.equal(saved.overrides.length, 0);
  });

  function shiftUsecase(extra = {}) {
    return new EmployeeWorkShiftUsecase({
      findExistingEmployeeIds: async (ids) => ids,
      getJoiningDate: async () => JOINED,
      getLastWorkingDate: async () => LAST,
      listLastWorkingDates: async (ids) => ids.filter((id) => id === EMP).map((id) => ({ employee_id: id, resignation_date: LAST })),
      getActiveWorkShift: async () => ({ work_shift_id: 8, shift_code: "MORN", active: 1 }),
      listAssignmentHistory: async () => [{ employee_work_shift_assignment_id: 1, employee_id: EMP, work_shift_id: 7, effective_from: JOINED }],
      changeAssignment: async () => ({ code: 200, affected_from: LAST, affected_to: LAST }),
      correctAssignment: async () => ({ code: 200 }),
      assignWorkShift: async () => ({ code: 200 }),
      ...extra,
    });
  }

  it("a shift change effective after the last working date is refused; one on it is accepted", async () => {
    await assert.rejects(
      shiftUsecase().changeAssignment({ employee_id: EMP, work_shift_id: 8, effective_from: sep(20), reason: "roster move", today: "2026-10-04" }),
      /not applicable after the employee's last working date/
    );
    const ok = await shiftUsecase().changeAssignment({ employee_id: EMP, work_shift_id: 8, effective_from: LAST, reason: "roster move", today: "2026-10-04" });
    assert.notEqual(ok.code, 422);
  });

  it("a history correction dated after the last working date is refused", async () => {
    await assert.rejects(
      shiftUsecase().correctAssignment({ employee_id: EMP, work_shift_id: 8, effective_from: sep(20), note: "fix a dated row", today: "2026-10-04" }),
      /not applicable after the employee's last working date/
    );
  });

  it("a bulk assignment effective today is refused for somebody whose employment already ended, naming them", async () => {
    let wrote = false;
    const u = shiftUsecase({ assignWorkShift: async () => { wrote = true; return { code: 200 }; } });
    const r = await u.assign({ employee_ids: [EMP, 77], work_shift_id: 8, today: "2026-10-04" });
    assert.equal(r.code, 422);
    assert.deepEqual(r.rejected_employee_ids, [EMP]);
    assert.match(r.msg, /last working date 2026-09-13/);
    assert.equal(wrote, false, "nothing is written for anybody");

    const r2 = await shiftUsecase({ assignWorkShift: async () => ({ code: 200 }) }).assign({ employee_ids: [77], work_shift_id: 8, today: "2026-10-04" });
    assert.equal(r2.code, 200, "an employee still employed is assigned as before");
  });
});

describe("no attendance request after the last working date", () => {
  const regularization = () => buildRegularization({}, world().calculation);
  const MESSAGE = /Attendance is not applicable after the employee's last working date/;

  it("an attendance correction for 20 Sep is refused", async () => {
    await assert.rejects(
      regularization().raiseRequest({ actor: { employee_id: EMP }, requested_for_employee_id: EMP, attendance_date: sep(20), reason: "forgot to punch", punch_time: "22:00", today: "2026-09-25" }),
      MESSAGE
    );
  });

  it("an OT request for 20 Sep is refused", async () => {
    await assert.rejects(
      regularization().raiseOtRequest({ actor: { employee_id: EMP }, attendance_date: sep(20), reason: "stayed late", today: "2026-09-25" }),
      MESSAGE
    );
  });

  it("a one-day shift change request for 20 Sep is refused", async () => {
    await assert.rejects(
      regularization().raiseShiftChangeRequest({ actor: { employee_id: EMP }, attendance_date: sep(20), work_shift_id: 8, reason: "covering", today: "2026-09-25" }),
      MESSAGE
    );
  });

  it("a Permission request for 20 Sep is refused - and one for 5 Sep (before joining) too", async () => {
    const windows = [{ permission_from: "10:00", permission_to: "11:00" }];
    await assert.rejects(
      regularization().raisePermissionRequest({ actor: { employee_id: EMP }, attendance_date: sep(20), windows, reason: "doctor visit", today: "2026-09-25" }),
      MESSAGE
    );
    await assert.rejects(
      regularization().raisePermissionRequest({ actor: { employee_id: EMP }, attendance_date: sep(5), windows, reason: "doctor visit", today: "2026-09-25" }),
      /before this employee's joining date/
    );
  });

  it("13 Sep, the last working date itself, is still an attendance day", async () => {
    // Reaches past the boundary guard: the fakes here have no request store,
    // so the next step fails - but not with the employment refusal.
    await assert.rejects(
      regularization().raiseRequest({ actor: { employee_id: EMP }, requested_for_employee_id: EMP, attendance_date: LAST, reason: "forgot to punch", punch_time: "22:00", today: "2026-09-25" }),
      (err) => !MESSAGE.test(err.message) && !/joining date/.test(err.message)
    );
  });
});
