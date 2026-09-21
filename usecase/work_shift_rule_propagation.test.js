/**
 * WORK SHIFT RULE PROPAGATION - the regression suite.
 *
 * THE BUG THIS FIXES. Attendance resolved a shift's configuration by
 * ATTENDANCE DATE, from `work_shift_config_version`. Correcting a shift rule
 * today therefore left every earlier date calculating under the old rule,
 * even dates in a payroll month nobody had settled yet - and recalculating
 * them changed nothing, because the recalculation read the same dated
 * version. September's minimum OT stayed September's forever.
 *
 * THE RULE NOW. The boundary is the PAYROLL LOCK, not the date:
 *
 *   open month   -> the LATEST shift configuration, for every date in it
 *   locked month -> the version dated to that day, frozen, never rewritten
 *
 * and saving a shift automatically recalculates the open days already
 * calculated under it.
 *
 * WHAT IS REAL HERE. The real `usecase/work_shift.js`, the real
 * `usecase/attendance_calculation.js`, the real engine and the real pure
 * resolvers, wired to each other exactly as `server.js` wires them. Only the
 * two repositories are fakes, and they mirror what the real SQL does -
 * including refusing a write into a payroll-locked month, which is the
 * guarantee the whole "locked months are untouched" half of this rests on.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildCalculation = require("../usecase/attendance_calculation");
const buildWorkShift = require("../usecase/work_shift");
const { buildConfigVersion, configVersionHash } = require("../utils/shift_config_version");

const SHIFT = 5; // "9 TO 6"
const OTHER_SHIFT = 6;
const ALICE = 101; // on 9 TO 6 all year
const BOB = 202; // on 9 TO 6, but with a locked September
const CARL = 303; // on the OTHER shift - must never be touched

/** The 9 TO 6 weekly schedule. Seven working days keeps the fixture readable. */
const scheduleFor = (workShiftId, overrides = {}) =>
  Array.from({ length: 7 }, (_, day) => ({
    work_shift_weekly_schedule_id: workShiftId * 100 + day,
    work_shift_id: workShiftId,
    day_of_week: day,
    is_working_day: 1,
    in_time: "09:00:00",
    out_time: "18:00:00",
    attendance_day_cutoff: "04:00:00",
    break_minutes: 60,
    normal_work_minutes: 480,
    ot_rate: 1,
    ...overrides,
  }));

/** `9 TO 6` with Exclude Minimum OT on and a 20 minute minimum. */
const configFor = (workShiftId, overrides = {}) => ({
  work_shift_id: workShiftId,
  shift_code: workShiftId === SHIFT ? "9 TO 6" : "OTHER",
  shift_name: workShiftId === SHIFT ? "9 TO 6" : "Other",
  active: 1,
  overtime_allowed: 1,
  overtime_minimum_minutes: 20,
  overtime_minimum_excluded: 1,
  overtime_minimum_threshold_only: 0,
  overtime_rounding_method: "NONE",
  overtime_rounding_interval_minutes: 0,
  maximum_ot_minutes_per_day: null,
  pre_shift_overtime_allowed: 0,
  pre_shift_overtime_minimum_minutes: 0,
  pre_shift_overtime_rounding_method: "NONE",
  pre_shift_overtime_rounding_interval_minutes: 0,
  pre_shift_overtime_minimum_excluded: 0,
  late_offset_against_overtime: 0,
  early_exit_offset_against_overtime: 0,
  late_grace_minutes: 0,
  late_deduction_interval_minutes: 0,
  late_deduct_minutes: 0,
  late_exclude_grace_from_deduction: 0,
  early_exit_grace_minutes: 0,
  early_exit_deduction_interval_minutes: 0,
  early_exit_deduct_minutes: 0,
  ...overrides,
});

const monthOf = (date) => String(date).slice(0, 7);

/**
 * 09:00 in, 20:00 out: eleven hours on an eight-hour shift with a one-hour
 * break, so 120 minutes of post-shift OT before any rule is applied.
 */
const workedDay = (id, employeeId, date) => [
  {
    punch_id: id,
    employee_id: employeeId,
    io_time: `${date} 09:00:00`,
    punch_date: date,
    ingest_attendance_date: date,
    dev_id: "DEV",
    ingest_source: "DEVICE",
  },
  {
    punch_id: id + 1,
    employee_id: employeeId,
    io_time: `${date} 20:00:00`,
    punch_date: date,
    ingest_attendance_date: date,
    dev_id: "DEV",
    ingest_source: "DEVICE",
  },
];

/**
 * The two repositories, sharing one in-memory world: the live shift tables,
 * the append-only version history, the punches, the stored calculations and
 * the payroll locks.
 */
function world({ lockedMonths = [] } = {}) {
  const state = {
    live: new Map([
      [SHIFT, { config: configFor(SHIFT), schedule: scheduleFor(SHIFT) }],
      [OTHER_SHIFT, { config: configFor(OTHER_SHIFT), schedule: scheduleFor(OTHER_SHIFT) }],
    ]),
    versions: new Map([
      [SHIFT, []],
      [OTHER_SHIFT, []],
    ]),
    punches: [],
    stored: new Map(), // `${employee}|${date}` -> stored row
    lockedMonths: new Set(lockedMonths), // `${employee}|YYYY-MM`
    assignments: new Map([
      [ALICE, [{ employee_work_shift_assignment_id: 1, employee_id: ALICE, work_shift_id: SHIFT, effective_from: "2026-01-01" }]],
      [BOB, [{ employee_work_shift_assignment_id: 2, employee_id: BOB, work_shift_id: SHIFT, effective_from: "2026-01-01" }]],
      [CARL, [{ employee_work_shift_assignment_id: 3, employee_id: CARL, work_shift_id: OTHER_SHIFT, effective_from: "2026-01-01" }]],
    ]),
    runs: [],
    recalculatedRanges: [],
  };

  let nextVersionId = 1;
  /** What `appendConfigVersionOnConnection` does, in memory. */
  const appendVersion = (workShiftId, effectiveFrom) => {
    const live = state.live.get(workShiftId);
    const document = buildConfigVersion(live.config, live.schedule);
    const hash = configVersionHash(document);
    const history = state.versions.get(workShiftId);
    const latest = history[history.length - 1];
    if (latest && latest.config_hash === hash) return { appended: false, reason: "UNCHANGED", hash };
    const id = nextVersionId;
    nextVersionId += 1;
    history.push({
      work_shift_config_version_id: id,
      work_shift_id: workShiftId,
      effective_from: effectiveFrom,
      config_hash: hash,
      config_document: JSON.stringify(document),
      source: "WORK_SHIFT_SAVE",
    });
    return { appended: true, hash, work_shift_config_version_id: id };
  };

  const isLocked = (employeeId, date) =>
    state.lockedMonths.has(`${employeeId}|${monthOf(date)}`);

  const workShiftRepo = {
    getWorkShiftById: async (id) => {
      const live = state.live.get(Number(id));
      return live ? [live.config] : [];
    },
    getWorkShiftWithSchedule: async (id) => {
      const live = state.live.get(Number(id));
      return live ? { ...live.config, weekly_schedule: live.schedule } : null;
    },
    getWeeklySchedule: async (id) => (state.live.get(Number(id)) || { schedule: [] }).schedule,
    updateWorkShiftWithSchedule: async (id, config, schedule, options = {}) => {
      const live = state.live.get(Number(id));
      if (!live) return { code: 404, msg: "Work shift not found" };
      live.config = { ...live.config, ...config };
      if (schedule) live.schedule = schedule.map((row) => ({ ...row, work_shift_id: Number(id) }));
      const version = appendVersion(Number(id), options.effective_from || "2026-09-20");
      return { code: 200, work_shift_id: Number(id), config_version: version };
    },
  };

  const calculationRepo = {
    getShiftAssignmentHistory: async (employeeId) => state.assignments.get(Number(employeeId)) || [],
    getWorkShiftWithSchedule: async (id) => {
      const live = state.live.get(Number(id));
      return live ? { config: live.config, schedule: live.schedule } : null;
    },
    getWorkShiftConfigVersions: async (id) => state.versions.get(Number(id)) || [],
    getRawPunchesByCalendarWindow: async (employeeId, from, to) =>
      state.punches.filter(
        (p) => Number(p.employee_id) === Number(employeeId) && p.punch_date >= from && p.punch_date <= to
      ),
    getApprovedRegularizedPunches: async () => [],
    getDateShiftOverrides: async () => [],
    getBreakOverride: async () => null,
    getApprovalStateByDate: async () => [],
    getEmploymentWindow: async (employeeId) => ({
      employee_id: Number(employeeId),
      status: 1,
      attendance_required: 1,
      date_of_joining: "2020-01-01",
      resignation_date: null,
    }),
    findPayrollLockedPeriods: async (rows = []) =>
      (rows || [])
        .filter((row) => isLocked(Number(row.employee_id), row.attendance_date))
        .map((row) => ({
          employee_id: Number(row.employee_id),
          year: Number(String(row.attendance_date).slice(0, 4)),
          month: Number(String(row.attendance_date).slice(5, 7)),
        })),
    // The real query's GROUP BY, over the same stored rows.
    listShiftImpactedMonths: async (workShiftId) => {
      const buckets = new Map();
      [...state.stored.values()].forEach((row) => {
        if (Number(row.work_shift_id) !== Number(workShiftId)) return;
        const key = `${row.employee_id}|${monthOf(row.attendance_date)}`;
        if (!buckets.has(key)) {
          buckets.set(key, {
            employee_id: Number(row.employee_id),
            period_year: Number(String(row.attendance_date).slice(0, 4)),
            period_month: Number(String(row.attendance_date).slice(5, 7)),
            day_count: 0,
            from_date: row.attendance_date,
            to_date: row.attendance_date,
            payroll_locked: isLocked(row.employee_id, row.attendance_date),
          });
        }
        const bucket = buckets.get(key);
        bucket.day_count += 1;
        if (row.attendance_date < bucket.from_date) bucket.from_date = row.attendance_date;
        if (row.attendance_date > bucket.to_date) bucket.to_date = row.attendance_date;
      });
      return [...buckets.values()];
    },
    saveCalculationsWithReconciliation: async ({ employee_id, from_date, to_date, rows }) => {
      // THE PAYROLL LOCK GATE, mirrored. The real one is `FOR UPDATE` inside
      // the write transaction; this is here so a test that writes into a
      // locked month fails the way production does instead of quietly
      // passing.
      const blocked = (rows || []).find((row) => isLocked(row.employee_id, row.attendance_date));
      if (blocked) {
        const err = new Error("Attendance cannot be changed because payroll for this month is approved and locked.");
        err.name = "ValidationError";
        err.code = "PAYROLL_MONTH_LOCKED";
        throw err;
      }
      state.recalculatedRanges.push({ employee_id, from_date, to_date });
      (rows || []).forEach((row) => {
        state.stored.set(`${row.employee_id}|${row.attendance_date}`, row);
      });
      return { written: (rows || []).length, stale_removed: 0 };
    },
    insertRecalculationRun: async (run) => {
      state.runs.push({ ...run, status: "RUNNING" });
      return state.runs.length;
    },
    finishRecalculationRun: async (runId, outcome) => {
      state.runs[runId - 1] = { ...state.runs[runId - 1], ...outcome };
    },
  };

  const calculation = buildCalculation(calculationRepo);
  const workShift = buildWorkShift(workShiftRepo);
  workShift.setAttendanceRecalculationService(calculation);

  return { state, calculation, workShift, appendVersion, isLocked };
}

/** The stored OT for a date, as the engine last wrote it. */
const storedOt = (w, employeeId, date) => {
  const row = w.state.stored.get(`${employeeId}|${date}`);
  return row ? Number(row.candidate_ot_minutes) : null;
};

/** Save the shift's new minimum OT through the real Work Shift save path. */
const saveMinimumOt = (w, minutes, actor = 7) =>
  w.workShift.update(SHIFT, {
    work_shift_details: { overtime_minimum_minutes: minutes },
    actor_employee_id: actor,
  });

/** September is open, everyone has punched, and every day is calculated. */
async function seedSeptember({ lockedMonths = [] } = {}) {
  const w = world({ lockedMonths });
  // The first version: the shift as it stands before the edit.
  w.appendVersion(SHIFT, "2026-09-01");
  w.appendVersion(OTHER_SHIFT, "2026-09-01");

  w.state.punches.push(
    ...workedDay(1, ALICE, "2026-09-13"),
    ...workedDay(11, ALICE, "2026-09-14"),
    ...workedDay(21, BOB, "2026-09-13"),
    ...workedDay(31, CARL, "2026-09-13")
  );

  for (const employeeId of [ALICE, BOB, CARL]) {
    /* eslint-disable no-await-in-loop */
    await w.calculation.recalculateRange({
      employee_id: employeeId,
      from_date: "2026-09-13",
      to_date: "2026-09-14",
    });
    /* eslint-enable no-await-in-loop */
  }
  // The locks are applied AFTER the seed, so a locked month still has the
  // settled rows payroll was approved from.
  w.state.recalculatedRanges.length = 0;
  return w;
}

describe("work shift rule propagation", () => {
  it("the regression case: 120 raw OT, minimum 20 -> 100, and the same day becomes 110 when the minimum drops to 10", async () => {
    const w = await seedSeptember();
    assert.equal(storedOt(w, ALICE, "2026-09-13"), 100, "120 earned, 20 excluded");

    const result = await saveMinimumOt(w, 10);

    assert.equal(result.code, 200);
    assert.equal(
      storedOt(w, ALICE, "2026-09-13"),
      110,
      "13-Sep is recalculated under the new rule although it is in the past"
    );
  });

  it("saving the shift reports what it did", async () => {
    const w = await seedSeptember();
    const result = await saveMinimumOt(w, 10);

    assert.equal(result.recalculation.status, "COMPLETED");
    // Two employees x four dates: their two punched days plus the day either
    // side, which is recalculated because a cutoff change can move a punch
    // onto the neighbouring attendance date. The widening is clamped to the
    // month.
    assert.equal(result.recalculation.attendance_days_recalculated, 8);
    assert.equal(result.recalculation.attendance_days_skipped_locked, 0);
    assert.equal(result.msg, "Shift updated. 8 open attendance days recalculated. 0 locked days skipped.");
  });

  it("a LOCKED month is skipped entirely and its days do not move", async () => {
    const w = await seedSeptember();
    // Payroll approves and locks Bob's September, after his days were settled.
    w.state.lockedMonths.add(`${BOB}|2026-09`);
    const before = storedOt(w, BOB, "2026-09-13");
    assert.equal(before, 100);

    const result = await saveMinimumOt(w, 10);

    assert.equal(storedOt(w, BOB, "2026-09-13"), 100, "the settled day is untouched");
    assert.equal(storedOt(w, ALICE, "2026-09-13"), 110, "and the open one is not");
    assert.equal(result.recalculation.attendance_days_skipped_locked, 2, "Bob's two locked days");
    assert.equal(result.recalculation.months_skipped_locked, 1);
    assert.equal(result.recalculation.employees_targeted, 1, "only Alice had anything to recalculate");
    assert.equal(
      w.state.recalculatedRanges.every((r) => r.employee_id === ALICE),
      true,
      "the locked employee-month was never even attempted"
    );
  });

  it("a locked month stays frozen through a SECOND shift change, and a manual recalculate cannot move it either", async () => {
    const w = await seedSeptember();
    w.state.lockedMonths.add(`${BOB}|2026-09`);

    await saveMinimumOt(w, 10);
    await saveMinimumOt(w, 5);

    assert.equal(storedOt(w, BOB, "2026-09-13"), 100);

    await assert.rejects(
      () =>
        w.calculation.recalculateRange({
          employee_id: BOB,
          from_date: "2026-09-13",
          to_date: "2026-09-14",
        }),
      (err) => err.code === "PAYROLL_MONTH_LOCKED",
      "the payroll lock refuses the write, exactly as it did before this change"
    );
    assert.equal(storedOt(w, BOB, "2026-09-13"), 100);
  });

  it("the MANUAL Recalculate uses the latest shift configuration for an open date", async () => {
    const w = await seedSeptember();
    // The shift is edited with propagation unwired, so only the manual run
    // can be what brings the date up to date.
    w.workShift.setAttendanceRecalculationService(null);
    await saveMinimumOt(w, 10);
    assert.equal(storedOt(w, ALICE, "2026-09-13"), 100, "nothing has recalculated it yet");

    await w.calculation.recalculateRange({
      employee_id: ALICE,
      from_date: "2026-09-13",
      to_date: "2026-09-14",
    });

    assert.equal(storedOt(w, ALICE, "2026-09-13"), 110);
  });

  it("no unrelated employee or date is recalculated", async () => {
    const w = await seedSeptember();
    const carlBefore = storedOt(w, CARL, "2026-09-13");

    await saveMinimumOt(w, 10);

    assert.equal(storedOt(w, CARL, "2026-09-13"), carlBefore, "another shift's employee is untouched");
    assert.equal(
      w.state.recalculatedRanges.some((r) => r.employee_id === CARL),
      false,
      "and was never recalculated at all"
    );
    // Every range stays inside September, the month the lock decision was
    // taken on, and inside the shift's own employees.
    w.state.recalculatedRanges.forEach((range) => {
      assert.equal(monthOf(range.from_date), "2026-09");
      assert.equal(monthOf(range.to_date), "2026-09");
      assert.equal([ALICE, BOB].includes(range.employee_id), true);
    });
  });

  it("a save that changes nothing calculable recalculates nothing", async () => {
    const w = await seedSeptember();
    const result = await w.workShift.update(SHIFT, {
      work_shift_details: { overtime_minimum_minutes: 20 },
      actor_employee_id: 7,
    });
    assert.deepEqual(result.recalculation, { skipped: true, reason: "CONFIGURATION_UNCHANGED" });
    assert.equal(w.state.recalculatedRanges.length, 0);
  });

  it("the run is auditable: who, which shift, and that a shift save started it", async () => {
    const w = await seedSeptember();
    await saveMinimumOt(w, 10, 77);

    assert.equal(w.state.runs.length, 1);
    const run = w.state.runs[0];
    assert.equal(run.trigger_source, "WORK_SHIFT_SAVE");
    assert.equal(run.work_shift_id, SHIFT);
    assert.equal(run.requested_by_employee_id, 77);
    assert.equal(run.status, "COMPLETED");
    assert.equal(run.days_processed, 8);
    assert.equal(run.days_skipped_locked, 0);
  });

  it("the employee's shift on the DATE still decides which shift's rules apply", async () => {
    const w = await seedSeptember();
    // Alice moves to the other shift from 14-Sep. 13-Sep is still 9 TO 6.
    w.state.assignments.set(ALICE, [
      ...w.state.assignments.get(ALICE),
      {
        employee_work_shift_assignment_id: 9,
        employee_id: ALICE,
        work_shift_id: OTHER_SHIFT,
        effective_from: "2026-09-14",
      },
    ]);
    await w.calculation.recalculateRange({
      employee_id: ALICE,
      from_date: "2026-09-13",
      to_date: "2026-09-14",
    });

    assert.equal(
      Number(w.state.stored.get(`${ALICE}|2026-09-13`).work_shift_id),
      SHIFT,
      "13-Sep keeps the shift she was on that day"
    );
    assert.equal(Number(w.state.stored.get(`${ALICE}|2026-09-14`).work_shift_id), OTHER_SHIFT);

    // Editing 9 TO 6 now reaches 13-Sep and not 14-Sep.
    await saveMinimumOt(w, 10);
    assert.equal(storedOt(w, ALICE, "2026-09-13"), 110);
    assert.equal(storedOt(w, ALICE, "2026-09-14"), 100, "14-Sep is the other shift's day");
  });
});
