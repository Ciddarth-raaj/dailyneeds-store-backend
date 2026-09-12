/**
 * Attendance v2 - the SINGLE-DATE override in the resolver.
 *
 *   node --test utils/shiftResolution_override.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  RESOLUTION_STATUS,
  resolveOverrideForDate,
  resolveShiftForDate,
} = require("../utils/shiftResolution");

const assignments = [
  { employee_work_shift_assignment_id: 1, work_shift_id: 7, effective_from: "2026-09-01" },
];
const overrides = [
  { attendance_date_shift_override_id: 10, attendance_date: "2026-09-15", work_shift_id: 8 },
];
const readSchedule = (workShiftId, dow) => ({
  work_shift_weekly_schedule_id: workShiftId * 100 + dow,
  work_shift_id: workShiftId,
  day_of_week: dow,
  is_working_day: 1,
  in_time: workShiftId === 8 ? "06:00:00" : "10:00:00",
  out_time: workShiftId === 8 ? "14:00:00" : "22:00:00",
  attendance_day_cutoff: "04:00:00",
  break_minutes: 60,
  ot_rate: 1,
});
const readShiftConfig = (workShiftId) => ({ work_shift_id: workShiftId, shift_code: `S${workShiftId}` });

describe("resolveOverrideForDate", () => {
  it("matches the exact date only", () => {
    assert.equal(resolveOverrideForDate(overrides, "2026-09-15").work_shift_id, 8);
    assert.equal(resolveOverrideForDate(overrides, "2026-09-14"), null);
    assert.equal(resolveOverrideForDate(overrides, "2026-09-16"), null);
  });

  it("the greatest id wins a date with several rows", () => {
    const rows = [
      { attendance_date_shift_override_id: 3, attendance_date: "2026-09-15", work_shift_id: 8 },
      { attendance_date_shift_override_id: 4, attendance_date: "2026-09-15", work_shift_id: 7 },
      { attendance_date_shift_override_id: 2, attendance_date: "2026-09-15", work_shift_id: 9 },
    ];
    assert.equal(resolveOverrideForDate(rows, "2026-09-15").work_shift_id, 7);
  });

  it("tolerates no overrides at all", () => {
    assert.equal(resolveOverrideForDate(undefined, "2026-09-15"), null);
    assert.equal(resolveOverrideForDate([], "2026-09-15"), null);
  });
});

describe("resolveShiftForDate with overrides", () => {
  const resolve = (date) =>
    resolveShiftForDate({ assignments, overrides, attendanceDate: date, readSchedule, readShiftConfig });

  it("the override wins its own date and is marked as such", () => {
    const r = resolve("2026-09-15");
    assert.equal(r.status, RESOLUTION_STATUS.OK);
    assert.equal(r.work_shift_id, 8);
    assert.equal(r.assignment.source, "DATE_OVERRIDE");
    assert.equal(r.assignment.attendance_date_shift_override_id, 10);
    assert.equal(r.snapshot.in_time, "06:00:00");
  });

  it("the day before and the day after still come from the assignment history", () => {
    for (const date of ["2026-09-14", "2026-09-16"]) {
      const r = resolve(date);
      assert.equal(r.work_shift_id, 7, date);
      assert.equal(r.assignment.employee_work_shift_assignment_id, 1, date);
      assert.equal(r.snapshot.in_time, "10:00:00", date);
    }
  });

  it("an override for a date with NO assignment history still resolves that date, and only that date", () => {
    const r = resolveShiftForDate({
      assignments: [],
      overrides,
      attendanceDate: "2026-09-15",
      readSchedule,
      readShiftConfig,
    });
    assert.equal(r.status, RESOLUTION_STATUS.OK);
    assert.equal(r.work_shift_id, 8);
    const next = resolveShiftForDate({
      assignments: [],
      overrides,
      attendanceDate: "2026-09-16",
      readSchedule,
      readShiftConfig,
    });
    assert.equal(next.status, RESOLUTION_STATUS.NO_SHIFT_FOR_DATE);
  });

  it("without overrides the resolution is exactly what it was", () => {
    const r = resolveShiftForDate({ assignments, attendanceDate: "2026-09-15", readSchedule, readShiftConfig });
    assert.equal(r.work_shift_id, 7);
    assert.equal(r.assignment.employee_work_shift_assignment_id, 1);
  });
});
