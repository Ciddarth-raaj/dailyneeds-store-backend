/**
 * Attendance v2 - the SINGLE-DATE shift edit, through the real usecase.
 *
 *   node --test usecase/attendance_date_shift.test.js
 *
 * The real `usecase/attendance_calculation.js` against a fake repository that
 * returns what the real queries return. What is defended:
 *
 *   - an override for a date wins that date, and ONLY that date - the day
 *     before and the day after resolve through the assignment history exactly
 *     as before, and the employee's current shift is never written;
 *   - saving recalculates that same date under the new shift, and the
 *     override row and the recalculated day go to the repository together;
 *   - a retry (or a no-op edit) appends no second override row;
 *   - the self-only read path (`calculateRange`, what `/attendance/me`
 *     serves) stores nothing.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildCalculation = require("../usecase/attendance_calculation");
const { CALC_STATUS } = require("../utils/attendance_engine");

const EMPLOYEE = 42;

/** Seven weekly rows for a shift, every day working. */
const weekly = (workShiftId, inTime, outTime) =>
  Array.from({ length: 7 }, (_, day) => ({
    work_shift_weekly_schedule_id: workShiftId * 100 + day,
    work_shift_id: workShiftId,
    day_of_week: day,
    is_working_day: 1,
    in_time: inTime,
    out_time: outTime,
    attendance_day_cutoff: "04:00:00",
    break_minutes: 60,
    normal_work_minutes: 660,
    ot_rate: 1,
  }));

const config = (workShiftId, code, name, active = 1) => ({
  work_shift_id: workShiftId,
  shift_code: code,
  shift_name: name,
  active,
  overtime_allowed: 1,
  overtime_minimum_minutes: 0,
  overtime_rounding_method: "NONE",
  overtime_rounding_interval_minutes: 0,
  overtime_minimum_threshold_only: 0,
  maximum_ot_minutes_per_day: null,
  pre_shift_overtime_allowed: 0,
  pre_shift_overtime_minimum_minutes: 0,
  pre_shift_overtime_rounding_method: "NONE",
  pre_shift_overtime_rounding_interval_minutes: 0,
  late_offset_against_overtime: 0,
  early_exit_offset_against_overtime: 0,
});

/** Shift 7: 10:00-22:00 (the assigned one). Shift 8: 06:00-14:00. Shift 9: retired. */
const SHIFTS = {
  7: { config: config(7, "LATE", "Late Shift"), schedule: weekly(7, "10:00:00", "22:00:00") },
  8: { config: config(8, "MORN", "Morning Shift"), schedule: weekly(8, "06:00:00", "14:00:00") },
  9: { config: config(9, "OLD", "Retired Shift", 0), schedule: weekly(9, "08:00:00", "16:00:00") },
};

const punch = (id, ioTime) => ({
  punch_id: id,
  employee_id: EMPLOYEE,
  io_time: ioTime,
  punch_date: ioTime.slice(0, 10),
  ingest_attendance_date: ioTime.slice(0, 10),
  dev_id: "DEV1",
  ingest_source: "DEVICE",
});

/** Three days, each worked 10:00-22:00 exactly: on-shift for LATE, off-shift for MORN. */
const THREE_DAYS = [
  punch(1, "2026-09-14 10:00:00"), punch(2, "2026-09-14 22:00:00"),
  punch(3, "2026-09-15 10:00:00"), punch(4, "2026-09-15 22:00:00"),
  punch(5, "2026-09-16 10:00:00"), punch(6, "2026-09-16 22:00:00"),
];

function fakeRepo(state = {}) {
  const saved = { calculations: [], overrides: [], defaultShiftWrites: [] };
  const overrides = [...(state.overrides || [])];
  let nextOverrideId = 1000;
  return {
    saved,
    overrides,
    getShiftAssignmentHistory: async () => [
      {
        employee_work_shift_assignment_id: 1,
        employee_id: EMPLOYEE,
        work_shift_id: 7,
        effective_from: "2026-09-01",
        source: "MIGRATION_BACKFILL",
      },
    ],
    getDateShiftOverrides: async (_employeeId, from, to) =>
      overrides.filter((o) => o.attendance_date >= from && o.attendance_date <= to),
    getWorkShiftWithSchedule: async (id) => SHIFTS[id] || null,
    getWorkShiftConfigVersions: async () => [],
    getRawPunchesByCalendarWindow: async (_employeeId, from, to) =>
      (state.rawPunches || THREE_DAYS).filter((p) => p.punch_date >= from && p.punch_date <= to),
    getApprovedRegularizedPunches: async () => [],
    getBreakOverride: async () => null,
    getApprovalStateByDate: async () => [],
    listActiveWorkShiftOptions: async () =>
      Object.values(SHIFTS)
        .filter((s) => s.config.active === 1)
        .map((s) => ({ work_shift_id: s.config.work_shift_id, shift_code: s.config.shift_code, shift_name: s.config.shift_name })),
    saveCalculations: async (rows) => {
      saved.calculations.push(rows);
      return { written: rows.length };
    },
    saveDateShiftOverrideWithCalculation: async ({ override, rows }) => {
      const id = nextOverrideId;
      nextOverrideId += 1;
      const row = { attendance_date_shift_override_id: id, ...override };
      // The real repository commits both or neither; the fake records both.
      overrides.push(row);
      saved.overrides.push(row);
      saved.calculations.push(rows);
      return { attendance_date_shift_override_id: id, written: rows.length };
    },
  };
}

describe("resolver precedence: a stored override wins its date, and only its date", () => {
  it("the day before and the day after still resolve through the assignment history", async () => {
    const repo = fakeRepo({
      overrides: [
        {
          attendance_date_shift_override_id: 5,
          employee_id: EMPLOYEE,
          attendance_date: "2026-09-15",
          work_shift_id: 8,
          previous_work_shift_id: 7,
          changed_by: 1,
        },
      ],
    });
    const usecase = buildCalculation(repo);
    const days = await usecase.calculateRange({
      employee_id: EMPLOYEE,
      from_date: "2026-09-14",
      to_date: "2026-09-16",
    });

    assert.deepEqual(
      days.map((d) => [d.attendance_date, d.work_shift_id, d.shift_source]),
      [
        ["2026-09-14", 7, "MIGRATION_BACKFILL"],
        ["2026-09-15", 8, "DATE_OVERRIDE"],
        ["2026-09-16", 7, "MIGRATION_BACKFILL"],
      ]
    );
    assert.equal(days[1].shift_name, "Morning Shift");
    assert.equal(days[0].shift_name, "Late Shift");
  });

  it("a later override row for the same date supersedes an earlier one", async () => {
    const repo = fakeRepo({
      overrides: [
        { attendance_date_shift_override_id: 5, employee_id: EMPLOYEE, attendance_date: "2026-09-15", work_shift_id: 8 },
        { attendance_date_shift_override_id: 6, employee_id: EMPLOYEE, attendance_date: "2026-09-15", work_shift_id: 7 },
      ],
    });
    const [day] = await buildCalculation(repo).calculateRange({
      employee_id: EMPLOYEE, from_date: "2026-09-15", to_date: "2026-09-15",
    });
    assert.equal(day.work_shift_id, 7);
    assert.equal(day.shift_source, "DATE_OVERRIDE");
  });
});

describe("setDateShift", () => {
  it("changes THAT date, recalculates it under the new shift, and writes both together", async () => {
    const repo = fakeRepo();
    const usecase = buildCalculation(repo);

    const before = await usecase.calculateRange({
      employee_id: EMPLOYEE, from_date: "2026-09-15", to_date: "2026-09-15",
    });
    assert.equal(before[0].work_shift_id, 7);
    assert.equal(before[0].status, CALC_STATUS.FINAL);
    assert.equal(before[0].candidate_ot_minutes, 0, "10-22 on a 10-22 shift earns no OT");

    const result = await usecase.setDateShift({
      employee_id: EMPLOYEE,
      attendance_date: "2026-09-15",
      work_shift_id: 8,
      actor_employee_id: 1,
    });

    assert.equal(result.changed, true);
    assert.equal(result.previous_work_shift_id, 7);
    assert.equal(result.work_shift_id, 8);
    assert.equal(result.shift_code, "MORN");
    assert.equal(result.attendance_date_shift_override_id, 1000);

    // The audit line: employee, date, old shift, new shift, who. (When is the
    // column default.)
    assert.equal(repo.saved.overrides.length, 1);
    assert.deepEqual(
      { ...repo.saved.overrides[0], attendance_date_shift_override_id: undefined },
      {
        attendance_date_shift_override_id: undefined,
        employee_id: EMPLOYEE,
        attendance_date: "2026-09-15",
        work_shift_id: 8,
        previous_work_shift_id: 7,
        changed_by: 1,
      }
    );

    // The recalculated day went with it, in the same repository call, and is
    // genuinely calculated under the new shift: 10:00-22:00 against a
    // 06:00-14:00 roster is 4 hours late and 8 hours past the out-time.
    assert.equal(repo.saved.calculations.length, 1);
    const [stored] = repo.saved.calculations[0];
    assert.equal(stored.employee_id, EMPLOYEE);
    assert.equal(stored.attendance_date, "2026-09-15");
    assert.equal(stored.work_shift_id, 8);
    assert.equal(result.day.work_shift_id, 8);
    assert.equal(result.day.late_minutes, 240);
    assert.ok(result.day.candidate_ot_minutes > 0, "the recalculated day now carries OT");

    // Nothing was written to the employee's current shift or to the history:
    // the fake has no such method and none was called.
    assert.equal(repo.saved.defaultShiftWrites.length, 0);
  });

  it("does not affect the previous or the following date", async () => {
    const repo = fakeRepo();
    const usecase = buildCalculation(repo);
    await usecase.setDateShift({
      employee_id: EMPLOYEE, attendance_date: "2026-09-15", work_shift_id: 8, actor_employee_id: 1,
    });

    const days = await usecase.calculateRange({
      employee_id: EMPLOYEE, from_date: "2026-09-14", to_date: "2026-09-16",
    });
    assert.deepEqual(
      days.map((d) => [d.attendance_date, d.work_shift_id, d.late_minutes]),
      [
        ["2026-09-14", 7, 0],
        ["2026-09-15", 8, 240],
        ["2026-09-16", 7, 0],
      ]
    );
    // Only the edited date was ever stored by the edit.
    assert.deepEqual(
      repo.saved.calculations.flat().map((r) => r.attendance_date),
      ["2026-09-15"]
    );
  });

  it("is idempotent: a retry for a shift the date is already on appends no second row", async () => {
    const repo = fakeRepo();
    const usecase = buildCalculation(repo);
    const first = await usecase.setDateShift({
      employee_id: EMPLOYEE, attendance_date: "2026-09-15", work_shift_id: 8, actor_employee_id: 1,
    });
    const retry = await usecase.setDateShift({
      employee_id: EMPLOYEE, attendance_date: "2026-09-15", work_shift_id: 8, actor_employee_id: 1,
    });

    assert.equal(first.changed, true);
    assert.equal(retry.changed, false);
    assert.equal(retry.previous_work_shift_id, 8);
    assert.equal(repo.saved.overrides.length, 1, "one override row, not two");
    // The date is still (re)stored on the retry - the same idempotent upsert.
    assert.equal(repo.saved.calculations.length, 2);
    assert.equal(repo.saved.calculations[1][0].work_shift_id, 8);
  });

  it("a second edit back to the original shift appends a further row rather than editing one", async () => {
    const repo = fakeRepo();
    const usecase = buildCalculation(repo);
    await usecase.setDateShift({ employee_id: EMPLOYEE, attendance_date: "2026-09-15", work_shift_id: 8, actor_employee_id: 1 });
    const back = await usecase.setDateShift({ employee_id: EMPLOYEE, attendance_date: "2026-09-15", work_shift_id: 7, actor_employee_id: 2 });

    assert.equal(back.changed, true);
    assert.equal(back.previous_work_shift_id, 8);
    assert.equal(repo.saved.overrides.length, 2);
    assert.equal(repo.saved.overrides[1].changed_by, 2);
    const [day] = await usecase.calculateRange({ employee_id: EMPLOYEE, from_date: "2026-09-15", to_date: "2026-09-15" });
    assert.equal(day.work_shift_id, 7);
    assert.equal(day.late_minutes, 0);
  });

  it("refuses a shift that does not exist, and an inactive one, writing nothing", async () => {
    const repo = fakeRepo();
    const usecase = buildCalculation(repo);
    await assert.rejects(
      usecase.setDateShift({ employee_id: EMPLOYEE, attendance_date: "2026-09-15", work_shift_id: 77 }),
      (err) => err.name === "NotFoundError"
    );
    await assert.rejects(
      usecase.setDateShift({ employee_id: EMPLOYEE, attendance_date: "2026-09-15", work_shift_id: 9 }),
      (err) => err.name === "ValidationError" && /inactive/.test(err.message)
    );
    assert.equal(repo.saved.overrides.length, 0);
    assert.equal(repo.saved.calculations.length, 0);
  });

  it("refuses bad input before reading anything", async () => {
    const repo = fakeRepo();
    const usecase = buildCalculation(repo);
    for (const bad of [
      { employee_id: 0, attendance_date: "2026-09-15", work_shift_id: 8 },
      { employee_id: EMPLOYEE, attendance_date: "15/09/2026", work_shift_id: 8 },
      { employee_id: EMPLOYEE, attendance_date: "2026-09-15", work_shift_id: "x" },
    ]) {
      // eslint-disable-next-line no-await-in-loop
      await assert.rejects(usecase.setDateShift(bad), (err) => err.name === "ValidationError");
    }
    assert.equal(repo.saved.overrides.length, 0);
  });

  it("offers only ACTIVE shifts as options", async () => {
    const options = await buildCalculation(fakeRepo()).listDateShiftOptions();
    assert.deepEqual(
      options.map((o) => o.work_shift_id),
      [7, 8]
    );
  });
});

describe("the self-only read path stores nothing", () => {
  it("calculateRange - what /attendance/me serves - writes no calculation and no override", async () => {
    const repo = fakeRepo();
    const days = await buildCalculation(repo).calculateRange({
      employee_id: EMPLOYEE, from_date: "2026-09-01", to_date: "2026-09-30",
    });
    assert.equal(days.length, 30);
    assert.equal(repo.saved.calculations.length, 0);
    assert.equal(repo.saved.overrides.length, 0);
  });
});
