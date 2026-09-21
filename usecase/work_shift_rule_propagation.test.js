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
 *   open month   -> the LATEST shift configuration, for every date in it,
 *                   whether or not that date has ever been calculated
 *   locked month -> the STORED calculation is the truth; nothing is
 *                   recalculated, re-read or rewritten, and the frozen row
 *                   keeps whatever rule it was last calculated under - which
 *                   is NOT necessarily the rule in force on its own date
 *
 * and saving a shift QUEUES a durable background recalculation of the open
 * days that shift governs.
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

/** The business date every test in this file runs on. */
const TODAY = "2026-09-21";

const SHIFT = 5; // "9 TO 6"
const OTHER_SHIFT = 6;
const ALICE = 101; // on 9 TO 6 all year
const BOB = 202; // on 9 TO 6, but with a locked September
const CARL = 303; // on the OTHER shift - must never be touched
const DEE = 404; // on 9 TO 6, and nobody has ever calculated a day for them

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
      [DEE, [{ employee_work_shift_assignment_id: 4, employee_id: DEE, work_shift_id: SHIFT, effective_from: "2026-01-01" }]],
    ]),
    overrides: new Map(),
    employment: new Map(),
    runs: [],
    heartbeats: [],
    now: Date.now(),
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
    getDateShiftOverrides: async (employeeId, from, to) =>
      (state.overrides.get(Number(employeeId)) || [])
        .filter((o) => o.attendance_date >= from && o.attendance_date <= to)
        .map((o, index) => ({
          attendance_date_shift_override_id: index + 1,
          employee_id: Number(employeeId),
          attendance_date: o.attendance_date,
          work_shift_id: Number(o.work_shift_id),
          shift_change_approved: 1,
          attendance_approval_request_id: null,
        })),
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
    // The real discovery: the DATED FACTS, never the stored rows.
    listShiftPropagationFacts: async (workShiftId) => {
      const ids = [...state.assignments.keys()].filter(
        (employeeId) =>
          state.assignments.get(employeeId).some((a) => Number(a.work_shift_id) === Number(workShiftId)) ||
          (state.overrides.get(employeeId) || []).some((o) => Number(o.work_shift_id) === Number(workShiftId))
      );
      return ids.map((employeeId) => ({
        employee_id: employeeId,
        employee: {
          employee_id: employeeId,
          attendance_required: 1,
          date_of_joining: (state.employment.get(employeeId) || {}).date_of_joining || "2020-01-01",
          resignation_date: (state.employment.get(employeeId) || {}).resignation_date || null,
        },
        assignments: state.assignments.get(employeeId),
        override_dates: (state.overrides.get(employeeId) || [])
          .filter((o) => Number(o.work_shift_id) === Number(workShiftId))
          .map((o) => o.attendance_date),
        locked_months: [...state.lockedMonths]
          .filter((key) => key.startsWith(`${employeeId}|`))
          .map((key) => key.split("|")[1]),
      }));
    },
    // The queue, as three rows of SQL do it.
    insertRecalculationRun: async (run) => {
      state.runs.push({
        attendance_recalculation_run_id: state.runs.length + 1,
        attempts: 0,
        ...run,
        status: run.status === "QUEUED" ? "QUEUED" : "RUNNING",
      });
      return state.runs.length;
    },
    claimNextQueuedRun: async () => {
      const run = state.runs.find(
        (r) => r.status === "QUEUED" && r.trigger_source === "WORK_SHIFT_SAVE"
      );
      if (!run) return null;
      run.status = "RUNNING";
      run.attempts += 1;
      run.heartbeat_at = state.now;
      return { ...run };
    },
    heartbeatRecalculationRun: async (runId) => {
      state.heartbeats.push(runId);
      const run = state.runs[runId - 1];
      if (run) run.heartbeat_at = state.now;
    },
    requeueStaleRecalculationRuns: async ({ staleSeconds = 600, maxAttempts = 3 } = {}) => {
      let requeued = 0;
      let abandoned = 0;
      state.runs.forEach((run) => {
        if (run.status !== "RUNNING" || run.trigger_source !== "WORK_SHIFT_SAVE") return;
        const stale = run.heartbeat_at === null || run.heartbeat_at === undefined
          ? true
          : state.now - run.heartbeat_at > staleSeconds * 1000;
        if (!stale) return;
        if (run.attempts >= maxAttempts) {
          run.status = "FAILED";
          run.last_error = `abandoned after ${run.attempts} attempts without completing`;
          abandoned += 1;
        } else {
          run.status = "QUEUED";
          run.heartbeat_at = null;
          requeued += 1;
        }
      });
      return { requeued, abandoned };
    },
    failRecalculationRun: async (runId, message) => {
      const run = state.runs[runId - 1];
      if (run) {
        run.status = "FAILED";
        run.last_error = message;
      }
    },
    retryRecalculationRun: async (runId) => {
      const run = state.runs[runId - 1];
      if (!run || run.trigger_source !== "WORK_SHIFT_SAVE") return false;
      if (!["FAILED", "COMPLETED_WITH_ERRORS"].includes(run.status)) return false;
      run.status = "QUEUED";
      run.attempts = 0;
      run.last_error = null;
      return true;
    },
    getRecalculationRun: async (runId) => state.runs[runId - 1] || null,
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
      // A deliberate failure, to prove what the counting does with one.
      if (
        state.failRange &&
        Number(employee_id) === state.failRange.employee_id &&
        from_date >= state.failRange.from_date
      ) {
        throw new Error("the punch store is unreachable");
      }
      state.recalculatedRanges.push({ employee_id, from_date, to_date });
      (rows || []).forEach((row) => {
        state.stored.set(`${row.employee_id}|${row.attendance_date}`, row);
      });
      return { written: (rows || []).length, stale_removed: 0 };
    },
    finishRecalculationRun: async (runId, outcome) => {
      state.runs[runId - 1] = { ...state.runs[runId - 1], ...outcome };
    },
  };

  // TODAY IS PINNED. The propagation never reaches a future date, so a test
  // that agreed with the wall clock would start failing on its own one day.
  const calculation = buildCalculation(calculationRepo, { today: TODAY });
  const workShift = buildWorkShift(workShiftRepo);
  workShift.setAttendanceRecalculationService(calculation);

  return { state, calculation, workShift, appendVersion, isLocked };
}

/**
 * Run the queued propagation, the way the cron does.
 *
 * Every save QUEUES; nothing recalculates until the worker ticks. Tests that
 * want the result therefore tick it explicitly, which is also what proves the
 * save itself does none of the work.
 */
const drainQueue = async (w, { ticks = 5, today = TODAY } = {}) => {
  const results = [];
  for (let i = 0; i < ticks; i += 1) {
    /* eslint-disable no-await-in-loop */
    const tick = await w.calculation.processQueuedRecalculations({ today });
    /* eslint-enable no-await-in-loop */
    results.push(tick);
    if (!tick.claimed) break;
  }
  return results;
};

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
      100,
      "the SAVE itself recalculates nothing - it queues"
    );

    await drainQueue(w);

    assert.equal(
      storedOt(w, ALICE, "2026-09-13"),
      110,
      "13-Sep is recalculated under the new rule although it is in the past"
    );
  });

  it("THE FULL SEQUENCE: open recalc under the new rule, then lock, then another rule change", async () => {
    // This is the case that decides what a locked month means. 13-Sep is
    // calculated under the 20 minute minimum; the minimum becomes 10 while
    // September is open, so 13-Sep correctly becomes 110; September is then
    // locked; a later change to 5 must leave 13-Sep at 110 - NOT at the 100
    // the version dated to 13-Sep would reconstruct.
    const w = await seedSeptember();
    assert.equal(storedOt(w, ALICE, "2026-09-13"), 100);

    await saveMinimumOt(w, 10);
    await drainQueue(w);
    assert.equal(storedOt(w, ALICE, "2026-09-13"), 110, "open September takes the new rule");

    // Payroll approves and locks September.
    w.state.lockedMonths.add(`${ALICE}|2026-09`);

    await saveMinimumOt(w, 5);
    await drainQueue(w);

    assert.equal(
      storedOt(w, ALICE, "2026-09-13"),
      110,
      "the frozen result stands: not 115 from the new rule, and not 100 from the rule dated to 13-Sep"
    );
    await assert.rejects(
      () =>
        w.calculation.recalculateRange({
          employee_id: ALICE,
          from_date: "2026-09-13",
          to_date: "2026-09-14",
        }),
      (err) => err.code === "PAYROLL_MONTH_LOCKED",
      "and a manual recalculation cannot move it either"
    );
    assert.equal(storedOt(w, ALICE, "2026-09-13"), 110);
  });

  it("saving the shift returns promptly and says what was STARTED", async () => {
    const w = await seedSeptember();
    const result = await saveMinimumOt(w, 10);

    assert.equal(result.recalculation.queued, true);
    assert.equal(result.recalculation.status, "QUEUED");
    assert.equal(
      result.recalculation.employees_targeted,
      3,
      "Alice, Bob and Dee are on this shift - Dee has never been calculated"
    );
    assert.equal(result.recalculation.employee_months_targeted, 3);
    assert.equal(
      result.msg,
      "Shift updated. Attendance recalculation started (run #1) for 3 employees across 3 open months."
    );
    assert.equal(w.state.recalculatedRanges.length, 0, "no recalculation happened in the request");
  });

  it("AN OPEN DATE THAT WAS NEVER CALCULATED is recalculated too", async () => {
    // Discovery is from the assignment history, not from stored rows: this
    // employee punched but nobody has ever run attendance for them.
    const w = await seedSeptember();
    w.state.punches.push(...workedDay(41, DEE, "2026-09-10"));
    assert.equal(w.state.stored.get(`${DEE}|2026-09-10`), undefined);

    await saveMinimumOt(w, 10);
    await drainQueue(w);

    assert.equal(
      storedOt(w, DEE, "2026-09-10"),
      110,
      "a date with no stored calculation is exactly the date that needed the new rule"
    );
  });

  it("the whole open window is covered - from the shift assignment to today, never beyond", async () => {
    const w = await seedSeptember();
    await saveMinimumOt(w, 10);
    await drainQueue(w);

    const alice = w.state.recalculatedRanges.filter((r) => r.employee_id === ALICE);
    assert.equal(alice.length, 1, "one range for September");
    assert.equal(alice[0].from_date, "2026-09-01", "from the assignment, not from the first stored day");
    assert.equal(alice[0].to_date, TODAY, "to today");
    assert.equal(
      w.state.recalculatedRanges.every((r) => r.to_date <= TODAY),
      true,
      "and never into the future"
    );
  });

  it("a LOCKED month is skipped entirely and its days do not move", async () => {
    const w = await seedSeptember();
    w.state.lockedMonths.add(`${BOB}|2026-09`);
    assert.equal(storedOt(w, BOB, "2026-09-13"), 100);

    const save = await saveMinimumOt(w, 10);
    await drainQueue(w);

    assert.equal(storedOt(w, BOB, "2026-09-13"), 100, "the settled day is untouched");
    assert.equal(storedOt(w, ALICE, "2026-09-13"), 110, "and the open one is not");
    assert.equal(
      save.recalculation.employees_targeted,
      2,
      "Alice and Dee; Bob's only open month is the one that was locked"
    );
    assert.equal(save.recalculation.months_skipped_locked, 1);
    assert.equal(
      w.state.recalculatedRanges.some((r) => r.employee_id === BOB),
      false,
      "the locked employee-month was never even attempted"
    );
  });

  it("a month that locks BETWEEN the scope read and the write is refused and counted, not lost", async () => {
    const w = await seedSeptember();
    await saveMinimumOt(w, 10);
    // The lock lands after the run was queued, before the worker gets there.
    w.state.lockedMonths.add(`${BOB}|2026-09`);
    await drainQueue(w);

    assert.equal(storedOt(w, BOB, "2026-09-13"), 100, "the write gate refused it");
    assert.equal(storedOt(w, ALICE, "2026-09-13"), 110);
    const run = w.state.runs[0];
    assert.equal(run.status, "COMPLETED", "a refusal by the lock is not an error");
    assert.equal(run.employees_failed, 0);
    assert.ok(run.days_skipped_locked > 0, "and it is reported as skipped");
  });

  it("the MANUAL Recalculate uses the latest shift configuration for an open date", async () => {
    const w = await seedSeptember();
    // Saved with propagation unwired, so only the manual run can be what
    // brings the date up to date.
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
    await drainQueue(w);

    assert.equal(storedOt(w, CARL, "2026-09-13"), carlBefore, "another shift's employee is untouched");
    assert.equal(
      w.state.recalculatedRanges.some((r) => r.employee_id === CARL),
      false,
      "and was never recalculated at all"
    );
    w.state.recalculatedRanges.forEach((range) => {
      assert.equal(monthOf(range.from_date), "2026-09");
      assert.equal(monthOf(range.to_date), "2026-09");
      assert.equal([ALICE, BOB, DEE].includes(range.employee_id), true);
    });
  });

  it("a save that changes nothing calculable queues nothing", async () => {
    const w = await seedSeptember();
    const result = await w.workShift.update(SHIFT, {
      work_shift_details: { overtime_minimum_minutes: 20 },
      actor_employee_id: 7,
    });
    assert.deepEqual(result.recalculation, { skipped: true, reason: "CONFIGURATION_UNCHANGED" });
    assert.equal(w.state.runs.length, 0);
  });

  it("the run is auditable: who, which shift, that a shift save started it, and how it ended", async () => {
    const w = await seedSeptember();
    await saveMinimumOt(w, 10, 77);

    assert.equal(w.state.runs.length, 1);
    assert.equal(w.state.runs[0].status, "QUEUED", "durable before anything runs");
    assert.equal(w.state.runs[0].trigger_source, "WORK_SHIFT_SAVE");
    assert.equal(w.state.runs[0].work_shift_id, SHIFT);
    assert.equal(w.state.runs[0].requested_by_employee_id, 77);

    await drainQueue(w);

    const run = w.state.runs[0];
    assert.equal(run.status, "COMPLETED");
    assert.equal(run.attempts, 1);
    assert.ok(run.days_processed > 0);
    assert.equal(run.days_skipped_locked, 0);
    assert.ok(w.state.heartbeats.length > 0, "a long run beats while it works");
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
    await drainQueue(w);
    assert.equal(storedOt(w, ALICE, "2026-09-13"), 110);
    assert.equal(storedOt(w, ALICE, "2026-09-14"), 100, "14-Sep is the other shift's day");
    // And the range stops where the assignment does.
    const alice = w.state.recalculatedRanges.filter((r) => r.employee_id === ALICE);
    assert.equal(alice[alice.length - 1].to_date, "2026-09-13");
  });

  it("a single-date override ONTO this shift brings that date into scope", async () => {
    const w = await seedSeptember();
    // Carl is on the other shift, but 15-Sep was moved onto 9 TO 6.
    w.state.overrides.set(CARL, [{ attendance_date: "2026-09-15", work_shift_id: SHIFT }]);
    w.state.punches.push(...workedDay(51, CARL, "2026-09-15"));

    await saveMinimumOt(w, 10);
    await drainQueue(w);

    assert.equal(storedOt(w, CARL, "2026-09-15"), 110, "the overridden date uses 9 TO 6's new rule");
    assert.equal(storedOt(w, CARL, "2026-09-13"), 100, "his ordinary days are not this shift's");
  });
});

describe("the recalculation queue", () => {
  it("survives a worker that died mid-run: stale RUNNING is requeued and finishes", async () => {
    const w = await seedSeptember();
    await saveMinimumOt(w, 10);

    // The worker claims the run and the process dies before finishing.
    const run = await w.state.runs[0];
    run.status = "RUNNING";
    run.attempts = 1;
    run.heartbeat_at = w.state.now - 20 * 60 * 1000;

    const ticks = await drainQueue(w);
    assert.equal(ticks[0].recovered.requeued, 1, "the stale run came back to the queue");
    assert.equal(w.state.runs[0].status, "COMPLETED");
    assert.equal(storedOt(w, ALICE, "2026-09-13"), 110, "and the work actually happened");
  });

  it("gives up after too many attempts rather than looping forever", async () => {
    const w = await seedSeptember();
    await saveMinimumOt(w, 10);
    const run = w.state.runs[0];
    run.status = "RUNNING";
    run.attempts = 3;
    run.heartbeat_at = w.state.now - 20 * 60 * 1000;

    await w.calculation.processQueuedRecalculations({ today: TODAY });

    assert.equal(run.status, "FAILED");
    assert.match(run.last_error, /abandoned after 3 attempts/);
  });

  it("a MANUAL bulk run is never claimed, requeued or abandoned by the worker", async () => {
    // A manual run is executed by the request that asked for it: it is
    // RUNNING for as long as that takes and it never heartbeats, so a
    // recovery that went by heartbeat alone would declare it dead, requeue
    // it, and hand the worker a run with no shift to propagate.
    const w = await seedSeptember();
    w.state.runs.push({
      attendance_recalculation_run_id: 1,
      trigger_source: "MANUAL",
      status: "RUNNING",
      attempts: 0,
      heartbeat_at: null,
      work_shift_id: null,
    });

    const tick = await w.calculation.processQueuedRecalculations({ today: TODAY });

    assert.equal(tick.recovered.requeued, 0);
    assert.equal(tick.recovered.abandoned, 0);
    assert.equal(tick.claimed, null);
    assert.equal(w.state.runs[0].status, "RUNNING", "the manual run is left entirely alone");

    const retried = await w.calculation.retryRecalculationRun(1);
    assert.equal(retried.code, 422, "and it is not retryable from the queue either");
  });

  it("a failed run is retryable, and a clean one is not", async () => {
    const w = await seedSeptember();
    await saveMinimumOt(w, 10);
    w.state.runs[0].status = "FAILED";

    const retried = await w.calculation.retryRecalculationRun(1);
    assert.equal(retried.code, 200);
    assert.equal(w.state.runs[0].status, "QUEUED");

    await drainQueue(w);
    assert.equal(w.state.runs[0].status, "COMPLETED");

    const again = await w.calculation.retryRecalculationRun(1);
    assert.equal(again.code, 422, "a run that completed cleanly is not re-runnable");
  });

  it("one employee with a failed month and a succeeded month counts as ONE failed employee", async () => {
    const w = await seedSeptember();
    // Two open months for Alice, and the second one blows up.
    w.state.punches.push(...workedDay(61, ALICE, "2026-10-05"));
    w.state.assignments.set(ALICE, w.state.assignments.get(ALICE));
    w.state.failRange = { employee_id: ALICE, from_date: "2026-10-01" };

    // Saved and run in late October, so both September and October are in
    // scope for everybody the shift governs.
    await w.workShift.update(SHIFT, {
      work_shift_details: { overtime_minimum_minutes: 10 },
      actor_employee_id: 7,
    });
    const ticks = await drainQueue(w, { today: "2026-10-20" });
    assert.ok(ticks[0].claimed);

    const run = w.state.runs[0];
    assert.equal(run.employees_failed, 1);
    assert.equal(
      run.employees_completed,
      2,
      "Bob and Dee completed; Alice is counted once, as failed, not also as completed"
    );
    assert.equal(run.status, "COMPLETED_WITH_ERRORS");
    assert.equal(run.errors.length, 1);
    assert.equal(run.errors[0].employee_id, ALICE);
    assert.equal(run.errors[0].period, "10/2026");
  });
});
