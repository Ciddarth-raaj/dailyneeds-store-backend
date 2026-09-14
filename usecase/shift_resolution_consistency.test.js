/**
 * ONE SOURCE OF TRUTH FOR "WHICH SHIFT APPLIED".
 *
 *   node --test usecase/shift_resolution_consistency.test.js
 *
 * These are the regression tests for the two "assigned shift shows as No
 * Shift" defects, and both were about the same thing: the system answered
 * "which shift applied" from two different places.
 *
 *   1. PUNCH DATING read `new_employee.default_work_shift_id` (live, current
 *      state) while the engine, the dashboard and payroll read the DATED
 *      assignment history. A punch's status is stamped once at ingest, so
 *      once the two disagreed, the Punch Audit said "No Shift" for ever -
 *      Recalculate rewrites `attendance_calculation` and never touched it.
 *
 *   2. ADD EMPLOYEE wrote `default_work_shift_id` and appended NO history
 *      row, so every employee created after the A0 deploy read as ASSIGNED
 *      on the Shift Assignment screen and resolved to NO_SHIFT_FOR_DATE
 *      everywhere else.
 *
 * Neither fix is about a particular employee id, and nothing here names one.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { deriveAttendanceDate, STATUS } = require("../biomax/attendanceDate");
const {
  resolveWorkShiftIdForPunch,
  resolveShiftForDate,
  RESOLUTION_STATUS,
} = require("../utils/shiftResolution");

const WORKING = { work_shift_weekly_schedule_id: 77, is_working_day: 1, attendance_day_cutoff: "04:00:00" };

/** Shift 7, every weekday working, 09:00-18:00, cutoff 04:00. */
const schedule = () => ({ work_shift_id: 7, day_of_week: 0, is_working_day: 1, in_time: "09:00", out_time: "18:00", attendance_day_cutoff: "04:00", break_minutes: 30, ot_rate: 1 });

describe("resolveWorkShiftIdForPunch", () => {
  const history = [{ employee_work_shift_assignment_id: 1, work_shift_id: 7, effective_from: "2026-09-01" }];

  it("answers from the dated history", () => {
    assert.equal(resolveWorkShiftIdForPunch(history, "2026-09-15", "2026-09-14"), 7);
  });

  it("is null before the first assignment - never a fallback to the live column", () => {
    assert.equal(resolveWorkShiftIdForPunch(history, "2026-08-20", "2026-08-19"), null);
    assert.equal(resolveWorkShiftIdForPunch([], "2026-09-15", "2026-09-14"), null);
  });

  it("uses the PREVIOUS day's assignment, because that is the day whose cutoff may claim the punch", () => {
    const moved = [
      { employee_work_shift_assignment_id: 1, work_shift_id: 7, effective_from: "2026-09-01" },
      { employee_work_shift_assignment_id: 2, work_shift_id: 9, effective_from: "2026-09-15" },
    ];
    assert.equal(resolveWorkShiftIdForPunch(moved, "2026-09-15", "2026-09-14"), 7);
    assert.equal(resolveWorkShiftIdForPunch(moved, "2026-09-16", "2026-09-15"), 9);
  });

  it("falls back to the punch's OWN date when the employee started that very day", () => {
    const joinedToday = [{ employee_work_shift_assignment_id: 3, work_shift_id: 7, effective_from: "2026-09-15" }];
    assert.equal(resolveWorkShiftIdForPunch(joinedToday, "2026-09-15", "2026-09-14"), 7);
  });
});

describe("dating a punch and calculating its date agree", () => {
  const assignments = [{ employee_work_shift_assignment_id: 1, work_shift_id: 7, effective_from: "2026-09-01" }];
  const employee = { employee_id: 1865, default_work_shift_id: null };

  it("an employee assigned in the history dates their punch, even with the live column NULL", () => {
    // THE DEFECT: `default_work_shift_id` is NULL - which it is after a
    // historical CORRECTION, which deliberately does not touch it - and the
    // old rule read exactly that column and answered NO_SHIFT.
    const workShiftId = resolveWorkShiftIdForPunch(assignments, "2026-09-15", "2026-09-14");
    const decision = deriveAttendanceDate({
      ioTimeRaw: "20260915090200",
      employee,
      workShiftId,
      readSchedule: () => WORKING,
    });
    assert.equal(decision.status, STATUS.OK);
    assert.equal(decision.attendance_date, "2026-09-15");
    assert.equal(decision.work_shift_id, 7);

    // And the engine's resolver, reading the same history, agrees.
    const resolution = resolveShiftForDate({
      assignments,
      attendanceDate: "2026-09-15",
      readSchedule: () => schedule(),
      readShiftConfig: () => ({ shift_code: "GEN" }),
    });
    assert.equal(resolution.status, RESOLUTION_STATUS.OK);
    assert.equal(resolution.work_shift_id, 7);
  });

  it("no history means NO_SHIFT on BOTH sides - never one saying yes and the other no", () => {
    const decision = deriveAttendanceDate({
      ioTimeRaw: "20260915090200",
      // The live column is set and is deliberately IGNORED: honouring it
      // here is precisely what made the Punch Audit and the Attendance
      // Dashboard disagree about the same employee.
      employee: { employee_id: 2282, default_work_shift_id: 7 },
      workShiftId: resolveWorkShiftIdForPunch([], "2026-09-15", "2026-09-14"),
      readSchedule: () => WORKING,
    });
    assert.equal(decision.status, STATUS.NO_SHIFT);

    const resolution = resolveShiftForDate({
      assignments: [],
      attendanceDate: "2026-09-15",
      readSchedule: () => schedule(),
      readShiftConfig: () => ({}),
    });
    assert.equal(resolution.status, RESOLUTION_STATUS.NO_SHIFT_FOR_DATE);
  });

  it("omitting workShiftId entirely still reads the live column, for a caller with no history", () => {
    const decision = deriveAttendanceDate({
      ioTimeRaw: "20260915090200",
      employee: { employee_id: 3, default_work_shift_id: 7 },
      readSchedule: () => WORKING,
    });
    assert.equal(decision.status, STATUS.OK);
    assert.equal(decision.work_shift_id, 7);
  });
});
