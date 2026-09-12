/**
 * Attendance v2 / A0 - resolving which work shift applied on a date.
 *
 * The property this whole feature exists for is the last suite here: a
 * historical date's answer must not move when the employee's current shift
 * changes. Everything else is the machinery that makes that true.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  RESOLUTION_STATUS,
  SHIFT_SNAPSHOT_VERSION,
  dayOfWeek,
  resolveAssignmentForDate,
  buildShiftSnapshot,
  resolveShiftForDate,
} = require("../utils/shiftResolution");

const scheduleRow = (overrides = {}) => ({
  work_shift_weekly_schedule_id: 71,
  work_shift_id: 7,
  day_of_week: 1,
  is_working_day: 1,
  in_time: "09:00:00",
  out_time: "21:00:00",
  attendance_day_cutoff: "04:00:00",
  break_minutes: 60,
  normal_work_minutes: 660,
  ot_rate: 1,
  ...overrides,
});

const shiftConfig = (overrides = {}) => ({
  work_shift_id: 7,
  shift_code: "GEN",
  overtime_allowed: 1,
  overtime_minimum_minutes: 30,
  overtime_rounding_method: "NEAREST",
  overtime_rounding_interval_minutes: 15,
  overtime_minimum_threshold_only: 0,
  maximum_ot_minutes_per_day: 120,
  ...overrides,
});

describe("the weekday of a date", () => {
  it("is computed with UTC maths, so the process timezone cannot move it", () => {
    assert.equal(dayOfWeek("2026-09-13"), 0, "a Sunday");
    assert.equal(dayOfWeek("2026-09-14"), 1, "a Monday");
    assert.equal(dayOfWeek("2026-09-19"), 6, "a Saturday");
  });

  it("returns null for anything that is not a date", () => {
    assert.equal(dayOfWeek("not a date"), null);
    assert.equal(dayOfWeek(""), null);
  });
});

describe("picking the assignment in force", () => {
  const history = [
    { employee_work_shift_assignment_id: 2, work_shift_id: 9, effective_from: "2026-10-01" },
    { employee_work_shift_assignment_id: 1, work_shift_id: 7, effective_from: "2026-09-01" },
  ];

  it("takes the greatest effective_from that is not in the future of the date", () => {
    assert.equal(resolveAssignmentForDate(history, "2026-09-30").work_shift_id, 7);
    assert.equal(resolveAssignmentForDate(history, "2026-10-01").work_shift_id, 9);
    assert.equal(resolveAssignmentForDate(history, "2027-05-05").work_shift_id, 9);
  });

  it("does not care what order the rows arrive in", () => {
    assert.equal(
      resolveAssignmentForDate([...history].reverse(), "2026-09-30").work_shift_id,
      7
    );
  });

  it("returns null before the first row, rather than guessing", () => {
    assert.equal(resolveAssignmentForDate(history, "2026-08-31"), null);
    assert.equal(resolveAssignmentForDate([], "2026-09-14"), null);
    assert.equal(resolveAssignmentForDate(null, "2026-09-14"), null);
  });

  it("breaks a same-day tie on the newest id, which is how a correction wins", () => {
    const corrected = [
      { employee_work_shift_assignment_id: 1, work_shift_id: 7, effective_from: "2026-09-01" },
      { employee_work_shift_assignment_id: 5, work_shift_id: 11, effective_from: "2026-09-01" },
    ];
    assert.equal(resolveAssignmentForDate(corrected, "2026-09-14").work_shift_id, 11);
  });

  it("ignores a row with an unusable date rather than throwing", () => {
    const messy = [
      { employee_work_shift_assignment_id: 1, work_shift_id: 7, effective_from: "2026-09-01" },
      { employee_work_shift_assignment_id: 2, work_shift_id: 9, effective_from: null },
    ];
    assert.equal(resolveAssignmentForDate(messy, "2026-09-14").work_shift_id, 7);
  });
});

describe("the snapshot", () => {
  it("normalizes MySQL's strings and tinyints into what the engine expects", () => {
    const snapshot = buildShiftSnapshot(
      scheduleRow({ is_working_day: "1", break_minutes: "60" }),
      shiftConfig({ overtime_allowed: "1", maximum_ot_minutes_per_day: "120" }),
      1
    );

    assert.equal(snapshot.is_working_day, true);
    assert.equal(snapshot.break_minutes, 60);
    assert.equal(snapshot.shift_span_minutes, 720);
    assert.equal(snapshot.overtime_allowed, true);
    assert.equal(snapshot.maximum_ot_minutes_per_day, 120);
    assert.equal(snapshot.snapshot_version, SHIFT_SNAPSHOT_VERSION);
  });

  it("spans midnight correctly for a night shift", () => {
    const snapshot = buildShiftSnapshot(
      scheduleRow({ in_time: "22:00:00", out_time: "06:00:00" }),
      shiftConfig(),
      1
    );
    assert.equal(snapshot.shift_span_minutes, 480);
  });

  it("carries the OT configuration, so an old date recalculates under its own rules", () => {
    const snapshot = buildShiftSnapshot(scheduleRow(), shiftConfig(), 1);
    assert.equal(snapshot.overtime_minimum_minutes, 30);
    assert.equal(snapshot.overtime_rounding_method, "NEAREST");
    assert.equal(snapshot.overtime_rounding_interval_minutes, 15);
  });

  it("hashes the same configuration to the same value every time", () => {
    const a = buildShiftSnapshot(scheduleRow(), shiftConfig(), 1);
    const b = buildShiftSnapshot(scheduleRow(), shiftConfig(), 1);
    assert.equal(a.snapshot_hash, b.snapshot_hash);
    assert.equal(a.snapshot_hash.length, 32);
  });

  it("changes the hash when anything that changes a number changes", () => {
    const base = buildShiftSnapshot(scheduleRow(), shiftConfig(), 1).snapshot_hash;
    const variants = [
      buildShiftSnapshot(scheduleRow({ in_time: "10:00:00" }), shiftConfig(), 1),
      buildShiftSnapshot(scheduleRow({ break_minutes: 30 }), shiftConfig(), 1),
      buildShiftSnapshot(scheduleRow({ ot_rate: 2 }), shiftConfig(), 1),
      buildShiftSnapshot(scheduleRow(), shiftConfig({ overtime_minimum_minutes: 60 }), 1),
      buildShiftSnapshot(scheduleRow(), shiftConfig({ maximum_ot_minutes_per_day: null }), 1),
    ];
    variants.forEach((v, i) =>
      assert.notEqual(v.snapshot_hash, base, `variant ${i} hashed the same as the base`)
    );
  });
});

describe("resolving a date end to end", () => {
  const assignments = [
    { employee_work_shift_assignment_id: 1, work_shift_id: 7, effective_from: "2026-09-01" },
  ];
  const readSchedule = (id, dow) => (id === 7 ? scheduleRow({ day_of_week: dow }) : null);
  const readShiftConfig = (id) => (id === 7 ? shiftConfig() : null);

  it("returns OK with a snapshot on a working day", () => {
    const result = resolveShiftForDate({
      assignments,
      attendanceDate: "2026-09-14",
      readSchedule,
      readShiftConfig,
    });
    assert.equal(result.status, RESOLUTION_STATUS.OK);
    assert.equal(result.work_shift_id, 7);
    assert.equal(result.snapshot.shift_span_minutes, 720);
  });

  it("says REST_DAY, with a snapshot, when the roster says so", () => {
    const result = resolveShiftForDate({
      assignments,
      attendanceDate: "2026-09-14",
      readSchedule: () => scheduleRow({ is_working_day: 0, in_time: null, out_time: null }),
      readShiftConfig,
    });
    // Somebody who punches in on their day off has genuinely worked, and v2
    // pays by the day attended, so this is a resolution rather than a refusal.
    assert.equal(result.status, RESOLUTION_STATUS.REST_DAY);
    assert.ok(result.snapshot);
  });

  it("says NO_SHIFT_FOR_DATE before the first assignment", () => {
    const result = resolveShiftForDate({
      assignments,
      attendanceDate: "2026-08-31",
      readSchedule,
      readShiftConfig,
    });
    assert.equal(result.status, RESOLUTION_STATUS.NO_SHIFT_FOR_DATE);
    assert.equal(result.snapshot, null);
  });

  it("says NO_SCHEDULE_ROW when the shift has no row for that weekday", () => {
    const result = resolveShiftForDate({
      assignments,
      attendanceDate: "2026-09-14",
      readSchedule: () => null,
      readShiftConfig,
    });
    assert.equal(result.status, RESOLUTION_STATUS.NO_SCHEDULE_ROW);
    assert.equal(result.work_shift_id, 7);
    assert.equal(result.snapshot, null);
  });
});

describe("history does not move when the present does", () => {
  it("a September date resolves the same before and after an October reassignment", () => {
    const readSchedule = (id, dow) => scheduleRow({ work_shift_id: id, day_of_week: dow });
    const readShiftConfig = (id) => shiftConfig({ work_shift_id: id });

    const before = [
      { employee_work_shift_assignment_id: 1, work_shift_id: 7, effective_from: "2026-09-01" },
    ];
    const after = [
      ...before,
      { employee_work_shift_assignment_id: 2, work_shift_id: 9, effective_from: "2026-10-01" },
    ];

    const september = (assignments) =>
      resolveShiftForDate({
        assignments,
        attendanceDate: "2026-09-14",
        readSchedule,
        readShiftConfig,
      });

    assert.equal(september(before).work_shift_id, september(after).work_shift_id);
    assert.equal(september(before).snapshot.snapshot_hash, september(after).snapshot.snapshot_hash);

    // And the new shift is in force from its own date, not before it.
    assert.equal(
      resolveShiftForDate({
        assignments: after,
        attendanceDate: "2026-10-01",
        readSchedule,
        readShiftConfig,
      }).work_shift_id,
      9
    );
  });
});
