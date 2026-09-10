/**
 * R18 - the attendance-date rule, exactly as approved.
 *
 *   node --test biomax/attendanceDate.test.js
 *
 * Pure: the schedule reader is injected and records what it was asked for,
 * so the tests prove not just the answer but that ONLY the previous
 * calendar day's row, and only its two permitted columns, were consulted.
 * The cutoff values used here are test data, not a Daily Needs
 * configuration; real values are entered by HR in Shift Management.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { deriveAttendanceDate, STATUS, calendarDates } = require("./attendanceDate");

/** A reader over a {dayOfWeek: row} map for one shift, recording reads. */
function reader(rowsByDay, shiftId = 7) {
  const reads = [];
  const fn = (workShiftId, dayOfWeek) => {
    reads.push({ workShiftId, dayOfWeek });
    if (workShiftId !== shiftId) return null;
    return rowsByDay[dayOfWeek] === undefined ? null : rowsByDay[dayOfWeek];
  };
  fn.reads = reads;
  return fn;
}

const working = (cutoff, id = 100) => ({
  work_shift_weekly_schedule_id: id,
  is_working_day: 1,
  attendance_day_cutoff: cutoff,
});
const rest = (id = 101) => ({
  work_shift_weekly_schedule_id: id,
  is_working_day: 0,
  attendance_day_cutoff: null,
});
const employee = { employee_id: 1952, default_work_shift_id: 7 };

// 2026-09-14 is a Monday (1); 2026-09-15 Tuesday (2); 2026-09-13 Sunday (0).

describe("calendar arithmetic on the digits", () => {
  it("finds the previous date and its weekday without any timezone", () => {
    assert.deepEqual(calendarDates("20260915020000"), {
      calendarDate: "2026-09-15",
      previousDate: "2026-09-14",
      previousDayOfWeek: 1,
      secondsOfDay: 7200,
    });
    // Month, year and leap boundaries.
    assert.equal(calendarDates("20261001010000").previousDate, "2026-09-30");
    assert.equal(calendarDates("20270101010000").previousDate, "2026-12-31");
    assert.equal(calendarDates("20280301010000").previousDate, "2028-02-29");
    // Sunday 00:30 reads Saturday (6).
    assert.equal(calendarDates("20260913003000").previousDayOfWeek, 6);
  });

  it("is unaffected by the process timezone", () => {
    const before = process.env.TZ;
    try {
      for (const tz of ["UTC", "Asia/Kolkata", "America/Los_Angeles", "Pacific/Kiritimati"]) {
        process.env.TZ = tz;
        assert.equal(calendarDates("20260915020000").previousDate, "2026-09-14", tz);
      }
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
  });
});

describe("the rule", () => {
  it("a punch before the previous working day's cutoff belongs to the previous day", () => {
    const read = reader({ 1: working("04:00:00") });
    const r = deriveAttendanceDate({ ioTimeRaw: "20260915023000", employee, readSchedule: read });
    assert.equal(r.status, STATUS.OK);
    assert.equal(r.attendance_date, "2026-09-14");
    assert.equal(r.calendar_date, "2026-09-15");
    assert.equal(r.cutoff_applied, "04:00:00");
    assert.equal(r.work_shift_id, 7);
    assert.equal(r.work_shift_weekly_schedule_id, 100);
    // Exactly one read, of the PREVIOUS day's row.
    assert.deepEqual(read.reads, [{ workShiftId: 7, dayOfWeek: 1 }]);
  });

  it("at or after the cutoff belongs to the punch's own day (strict <)", () => {
    const read = reader({ 1: working("04:00:00") });
    assert.equal(deriveAttendanceDate({ ioTimeRaw: "20260915040000", employee, readSchedule: read }).attendance_date, "2026-09-15");
    assert.equal(deriveAttendanceDate({ ioTimeRaw: "20260915035959", employee, readSchedule: read }).attendance_date, "2026-09-14");
    assert.equal(deriveAttendanceDate({ ioTimeRaw: "20260915140500", employee, readSchedule: read }).attendance_date, "2026-09-15");
  });

  it("night shift: Mon 22:05 -> Mon; Tue 02:00 -> Mon; Tue 09:00 -> Tue (illustrative cutoff 08:00)", () => {
    const read = reader({ 0: working("08:00:00"), 1: working("08:00:00"), 2: working("08:00:00") });
    assert.equal(deriveAttendanceDate({ ioTimeRaw: "20260914220500", employee, readSchedule: read }).attendance_date, "2026-09-14");
    assert.equal(deriveAttendanceDate({ ioTimeRaw: "20260915020000", employee, readSchedule: read }).attendance_date, "2026-09-14");
    assert.equal(deriveAttendanceDate({ ioTimeRaw: "20260915090000", employee, readSchedule: read }).attendance_date, "2026-09-15");
  });

  it("previous day working, punch day rest: still the previous day's cutoff decides", () => {
    // Tuesday is a rest day; only Monday's row is read for a Tuesday punch.
    const read = reader({ 1: working("08:00:00"), 2: rest() });
    const r = deriveAttendanceDate({ ioTimeRaw: "20260915020000", employee, readSchedule: read });
    assert.equal(r.attendance_date, "2026-09-14");
    assert.deepEqual(read.reads, [{ workShiftId: 7, dayOfWeek: 1 }]);
    // A 09:00 punch on the rest day is dated to the rest day, as-is.
    assert.equal(deriveAttendanceDate({ ioTimeRaw: "20260915090000", employee, readSchedule: read }).attendance_date, "2026-09-15");
  });

  it("previous day a rest day: the punch keeps its own date, no cutoff applied", () => {
    const read = reader({ 0: rest(), 1: working("04:00:00") });
    const r = deriveAttendanceDate({ ioTimeRaw: "20260914010000", employee, readSchedule: read }); // Monday 01:00, Sunday rest
    assert.equal(r.status, STATUS.OK);
    assert.equal(r.attendance_date, "2026-09-14");
    assert.equal(r.cutoff_applied, null);
    assert.equal(r.work_shift_weekly_schedule_id, 101);
  });

  it("consecutive days with different cutoffs are independent", () => {
    const read = reader({ 1: working("08:00:00"), 2: working("04:00:00") });
    // Wednesday 05:00: Tuesday's 04:00 governs -> Wednesday.
    assert.equal(deriveAttendanceDate({ ioTimeRaw: "20260916050000", employee, readSchedule: read }).attendance_date, "2026-09-16");
    // Tuesday 05:00: Monday's 08:00 governs -> Monday.
    assert.equal(deriveAttendanceDate({ ioTimeRaw: "20260915050000", employee, readSchedule: read }).attendance_date, "2026-09-14");
  });

  it("weekday wrap: a Sunday punch reads Saturday's row", () => {
    const read = reader({ 6: working("06:00:00") });
    const r = deriveAttendanceDate({ ioTimeRaw: "20260913003000", employee, readSchedule: read });
    assert.equal(r.attendance_date, "2026-09-12");
    assert.deepEqual(read.reads, [{ workShiftId: 7, dayOfWeek: 6 }]);
  });

  it("accepts HH:MM as well as HH:MM:SS cutoffs", () => {
    const read = reader({ 1: working("04:00") });
    const r = deriveAttendanceDate({ ioTimeRaw: "20260915023000", employee, readSchedule: read });
    assert.equal(r.attendance_date, "2026-09-14");
    assert.equal(r.cutoff_applied, "04:00:00");
  });
});

describe("when it cannot be derived (A3) - stored, dated null, status says why", () => {
  it("unmatched employee: no shift read at all", () => {
    const read = reader({ 1: working("04:00:00") });
    const r = deriveAttendanceDate({ ioTimeRaw: "20260915023000", employee: null, readSchedule: read });
    assert.equal(r.status, STATUS.UNMATCHED);
    assert.equal(r.attendance_date, null);
    assert.equal(r.work_shift_id, null);
    assert.deepEqual(read.reads, []);
  });

  it("no assigned shift: no schedule read", () => {
    const read = reader({ 1: working("04:00:00") });
    for (const shift of [null, undefined]) {
      const r = deriveAttendanceDate({
        ioTimeRaw: "20260915023000",
        employee: { employee_id: 1, default_work_shift_id: shift },
        readSchedule: read,
      });
      assert.equal(r.status, STATUS.NO_SHIFT);
      assert.equal(r.attendance_date, null);
    }
    assert.deepEqual(read.reads, []);
  });

  it("no schedule row for that weekday", () => {
    const read = reader({});
    const r = deriveAttendanceDate({ ioTimeRaw: "20260915023000", employee, readSchedule: read });
    assert.equal(r.status, STATUS.NO_SCHEDULE_ROW);
    assert.equal(r.attendance_date, null);
    assert.equal(r.work_shift_id, 7);
  });

  it("working previous day with a blank cutoff is a configuration error, never a default", () => {
    for (const blank of [null, "", undefined]) {
      const read = reader({ 1: { work_shift_weekly_schedule_id: 5, is_working_day: 1, attendance_day_cutoff: blank } });
      const r = deriveAttendanceDate({ ioTimeRaw: "20260915023000", employee, readSchedule: read });
      assert.equal(r.status, STATUS.MISSING_CUTOFF, JSON.stringify(blank));
      assert.equal(r.attendance_date, null);
      assert.equal(r.work_shift_weekly_schedule_id, 5);
      assert.equal(r.cutoff_applied, null);
    }
  });
});

describe("scope guard", () => {
  it("throws if the schedule row carries anything beyond the two permitted columns", () => {
    const widened = reader({ 1: { ...working("04:00:00"), in_time: "22:00:00" } });
    assert.throws(
      () => deriveAttendanceDate({ ioTimeRaw: "20260915023000", employee, readSchedule: widened }),
      /schedule row carries 'in_time'/
    );
    for (const col of ["out_time", "break_minutes", "late_grace_minutes", "ot_rate"]) {
      const r = reader({ 1: { ...working("04:00:00"), [col]: 1 } });
      assert.throws(() => deriveAttendanceDate({ ioTimeRaw: "20260915023000", employee, readSchedule: r }), col);
    }
  });
});
