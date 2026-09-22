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
const { governsEmployeeMonth } = require("../utils/shift_propagation");

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
    lockedAt: new Map(),
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
    /**
     * ONE TRANSACTION, as `repository/work_shift.js` runs it: the live rows,
     * the appended version AND the propagation obligation commit together or
     * not at all. The fake works on copies and only publishes them at the
     * end, so `enqueueThrows` rolls the whole save back the way MySQL would.
     */
    updateWorkShiftWithSchedule: async (id, config, schedule, options = {}) => {
      const live = state.live.get(Number(id));
      if (!live) return { code: 404, msg: "Work shift not found" };

      const nextConfig = { ...live.config, ...config };
      const nextSchedule = schedule
        ? schedule.map((row) => ({ ...row, work_shift_id: Number(id) }))
        : live.schedule;
      const history = state.versions.get(Number(id));
      const rollbackTo = history.length;

      const previous = { config: live.config, schedule: live.schedule };
      live.config = nextConfig;
      live.schedule = nextSchedule;

      try {
        const version = appendVersion(Number(id), options.effective_from || "2026-09-20");
        let propagationRunId = null;
        if (version.appended) {
          if (state.enqueueThrows) throw new Error(state.enqueueThrows);
          // One pending job per shift, exactly as the real INSERT's guard.
          // The UNIQUE key covers QUEUED rows only, so a RUNNING run does
          // NOT stop a new obligation being recorded: the running one may
          // already be past the dates this save changed.
          const pending = state.runs.find(
            (r) =>
              Number(r.work_shift_id) === Number(id) &&
              r.trigger_source === "WORK_SHIFT_SAVE" &&
              r.status === "QUEUED"
          );
          if (pending) {
            propagationRunId = pending.attendance_recalculation_run_id;
          } else {
            state.runs.push({
              attendance_recalculation_run_id: state.runs.length + 1,
              trigger_source: "WORK_SHIFT_SAVE",
              work_shift_id: Number(id),
              requested_by_employee_id:
                options.created_by === undefined ? null : options.created_by,
              from_date: "2026-09-01",
              to_date: TODAY,
              employees_targeted: 0,
              attempts: 0,
              queued_at: state.now,
              status: "QUEUED",
            });
            propagationRunId = state.runs.length;
          }
        }
        return {
          code: 200,
          work_shift_id: Number(id),
          config_version: { ...version, propagation_run_id: propagationRunId },
        };
      } catch (err) {
        // ROLLBACK: the configuration AND the version go back.
        live.config = previous.config;
        live.schedule = previous.schedule;
        history.length = rollbackTo;
        throw err;
      }
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
        locked_at: [...state.lockedMonths]
          .filter((key) => key.startsWith(`${employeeId}|`))
          .reduce((acc, key) => ({ ...acc, [key.split("|")[1]]: state.lockedAt.get(key) || null }), {}),
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
    updateRecalculationRunScope: async (runId, scope) => {
      const run = state.runs[runId - 1];
      if (run) Object.assign(run, scope);
    },
    heartbeatRecalculationRun: async (runId) => {
      state.heartbeats.push(runId);
      const run = state.runs[runId - 1];
      if (run) run.heartbeat_at = state.now;
    },
    requeueStaleRecalculationRuns: async ({ staleSeconds = 600, maxAttempts = 3 } = {}) => {
      if (state.requeueThrows) throw new Error(state.requeueThrows);
      let superseded = 0;
      let requeued = 0;
      let abandoned = 0;
      const queuedFor = (shiftId, exceptId) =>
        state.runs.find(
          (r) =>
            r.status === "QUEUED" &&
            r.trigger_source === "WORK_SHIFT_SAVE" &&
            Number(r.work_shift_id) === Number(shiftId) &&
            r.attendance_recalculation_run_id !== exceptId
        );

      state.runs.forEach((run) => {
        if (run.status !== "RUNNING" || run.trigger_source !== "WORK_SHIFT_SAVE") return;
        const stale = run.heartbeat_at === null || run.heartbeat_at === undefined
          ? true
          : state.now - run.heartbeat_at > staleSeconds * 1000;
        if (!stale) return;

        // COALESCE FIRST. A newer queued run for the same shift already owes
        // this work, and the unique key would refuse a second queued row.
        const successor = queuedFor(run.work_shift_id, run.attendance_recalculation_run_id);
        if (successor) {
          run.status = "SUPERSEDED";
          run.superseded_by_run_id = successor.attendance_recalculation_run_id;
          run.heartbeat_at = null;
          superseded += 1;
          return;
        }
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
      return { superseded, requeued, abandoned };
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
      if (!run || run.trigger_source !== "WORK_SHIFT_SAVE") return { requeued: false };
      if (!["FAILED", "COMPLETED_WITH_ERRORS"].includes(run.status)) return { requeued: false };

      const successor = state.runs.find(
        (r) =>
          r.status === "QUEUED" &&
          r.trigger_source === "WORK_SHIFT_SAVE" &&
          Number(r.work_shift_id) === Number(run.work_shift_id) &&
          r.attendance_recalculation_run_id !== runId
      );
      if (successor) {
        run.status = "SUPERSEDED";
        run.superseded_by_run_id = successor.attendance_recalculation_run_id;
        return { requeued: false, superseded_by_run_id: successor.attendance_recalculation_run_id };
      }
      // Every figure of the previous attempt goes, exactly as the UPDATE does.
      Object.assign(run, {
        status: "QUEUED",
        attempts: 0,
        last_error: null,
        completed_at: null,
        heartbeat_at: null,
        employees_targeted: 0,
        employees_completed: 0,
        employees_failed: 0,
        days_processed: 0,
        days_skipped_locked: 0,
        errors: null,
        superseded_by_run_id: null,
        queued_at: state.now,
      });
      return { requeued: true };
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
    // An UPDATE, so a caller holding the row sees the new values - as it
    // would re-reading it from the database.
    finishRecalculationRun: async (runId, outcome) => {
      Object.assign(state.runs[runId - 1], outcome);
    },
  };

  /**
   * PAYROLL'S APPROVE & LOCK, reduced to the two things this file is about:
   * it refuses while an unresolved propagation governs the employee's month,
   * and otherwise it locks. The real guard is
   * `repository/payrun_calculation.js#_pendingShiftPropagationLocked`, driven
   * against its own statements in
   * `repository/payrun_approval_propagation_guard.test.js`; what is reused
   * HERE is the applicability rule it calls, so the two cannot disagree about
   * which months a pending run covers.
   */
  const approveAndLock = async (employeeId, month) => {
    const unresolved = state.runs.filter(
      (r) =>
        r.trigger_source === "WORK_SHIFT_SAVE" &&
        ["QUEUED", "RUNNING", "FAILED", "COMPLETED_WITH_ERRORS"].includes(r.status)
    );
    const blocking = unresolved.filter((r) =>
      governsEmployeeMonth({
        employee: state.employment.get(employeeId) || { attendance_required: 1 },
        assignments: state.assignments.get(employeeId) || [],
        overrideDates: (state.overrides.get(employeeId) || [])
          .filter((o) => Number(o.work_shift_id) === Number(r.work_shift_id))
          .map((o) => o.attendance_date),
        workShiftId: Number(r.work_shift_id),
        month,
        today: TODAY,
      })
    );
    if (blocking.length > 0) {
      return {
        outcome: "RECALCULATION_PENDING",
        pending_recalculations: blocking.map((r) => ({
          run_id: r.attendance_recalculation_run_id,
          work_shift_id: r.work_shift_id,
          status: r.status,
        })),
      };
    }
    state.lockedMonths.add(`${employeeId}|${month}`);
    state.lockedAt.set(`${employeeId}|${month}`, "2026-09-21 18:00:00.000");
    return { outcome: "APPROVED" };
  };

  // TODAY IS PINNED. The propagation never reaches a future date, so a test
  // that agreed with the wall clock would start failing on its own one day.
  const calculation = buildCalculation(calculationRepo, { today: TODAY });
  const workShift = buildWorkShift(workShiftRepo);

  return { state, calculation, workShift, appendVersion, isLocked, approveAndLock };
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

    assert.equal(w.state.runs.length, 1, "the obligation is committed with the rule change");
    assert.equal(w.state.runs[0].status, "QUEUED");
    assert.equal(result.config_version.propagation_run_id, 1);
    assert.equal(
      result.msg,
      "Shift updated. Attendance recalculation queued (run #1): every open attendance day " +
        "on this shift will be recalculated under the new rule, and payroll-locked months are skipped."
    );
    assert.equal(w.state.recalculatedRanges.length, 0, "no recalculation happened in the request");
    // The counts belong to the RUN, and the run has not started yet.
    assert.equal(w.state.runs[0].employees_targeted, 0);
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

    await saveMinimumOt(w, 10);
    const ticks = await drainQueue(w);

    assert.equal(storedOt(w, BOB, "2026-09-13"), 100, "the settled day is untouched");
    assert.equal(storedOt(w, ALICE, "2026-09-13"), 110, "and the open one is not");
    assert.equal(
      ticks[0].result.employees_targeted,
      2,
      "Alice and Dee; Bob's only open month is the one that was locked"
    );
    assert.equal(ticks[0].result.months_skipped_locked, 1);
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
    // The save queues a propagation; this test never drains it, so only the
    // MANUAL recalculation below can be what brings the date up to date.
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
    assert.equal(result.config_version.appended, false, "no version, so no obligation");
    assert.equal(result.config_version.propagation_run_id, null);
    assert.equal(result.msg, "Shift updated.");
    assert.equal(w.state.runs.length, 0);
  });

  it("A COMMITTED RULE CAN NEVER BECOME AN UNQUEUED ORPHAN", async () => {
    // The failure this guards against: the configuration commits, the queue
    // INSERT fails, nothing propagates - and the retry is a no-op because the
    // content is now UNCHANGED, so no version is appended and no propagation
    // is ever attempted. The rule would be live with the old figures stored
    // and nothing anywhere would say so.
    const w = await seedSeptember();
    w.state.enqueueThrows = "the queue table is unreachable";

    await assert.rejects(() => saveMinimumOt(w, 10), /queue table is unreachable/);

    // NEITHER committed.
    assert.equal(w.state.runs.length, 0);
    assert.equal(
      w.state.live.get(SHIFT).config.overtime_minimum_minutes,
      20,
      "the rule change rolled back with the obligation it could not record"
    );
    assert.equal(w.state.versions.get(SHIFT).length, 1, "and no version was appended");

    // So the retry is a REAL save again, not an UNCHANGED no-op.
    w.state.enqueueThrows = null;
    const retry = await saveMinimumOt(w, 10);
    assert.equal(retry.config_version.appended, true);
    assert.equal(retry.config_version.propagation_run_id, 1);

    await drainQueue(w);
    assert.equal(storedOt(w, ALICE, "2026-09-13"), 110);
  });

  it("several edits in a row owe ONE propagation, and it sees all of them", async () => {
    const w = await seedSeptember();
    await saveMinimumOt(w, 15);
    await saveMinimumOt(w, 10);

    assert.equal(w.state.runs.length, 1, "the queued run is reused, not duplicated");

    await drainQueue(w);
    assert.equal(storedOt(w, ALICE, "2026-09-13"), 110, "and it applied the LAST rule");
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

describe("payroll cannot overtake a pending propagation", () => {
  it("THE REQUIRED SEQUENCE: blocked before the worker, approved after it, frozen afterwards", async () => {
    const w = await seedSeptember();
    assert.equal(storedOt(w, ALICE, "2026-09-13"), 100, "1. 13-Sep pays 100 under the 20 minute minimum");

    // 2 + 3. The rule changes and commits with its queued propagation.
    const save = await saveMinimumOt(w, 10);
    assert.equal(w.state.runs[0].status, "QUEUED");

    // 4. The worker has NOT run.
    // 5. Approve & Lock must refuse, and say why.
    const blocked = await w.approveAndLock(ALICE, "2026-09");
    assert.equal(blocked.outcome, "RECALCULATION_PENDING");
    assert.deepEqual(blocked.pending_recalculations, [
      { run_id: save.config_version.propagation_run_id, work_shift_id: SHIFT, status: "QUEUED" },
    ]);
    assert.equal(w.isLocked(ALICE, "2026-09-13"), false, "nothing was settled");

    // 6. The worker runs.
    await drainQueue(w);
    assert.equal(storedOt(w, ALICE, "2026-09-13"), 110);
    assert.equal(w.state.runs[0].status, "COMPLETED");

    // 7. Now it approves.
    const approved = await w.approveAndLock(ALICE, "2026-09");
    assert.equal(approved.outcome, "APPROVED");

    // 8. A later rule change leaves the settled month alone.
    await saveMinimumOt(w, 5);
    await drainQueue(w);
    assert.equal(storedOt(w, ALICE, "2026-09-13"), 110, "September is frozen at what was approved");
  });

  it("a RUNNING propagation blocks too", async () => {
    const w = await seedSeptember();
    await saveMinimumOt(w, 10);
    w.state.runs[0].status = "RUNNING";
    assert.equal((await w.approveAndLock(ALICE, "2026-09")).outcome, "RECALCULATION_PENDING");
  });

  it("a FAILED propagation blocks: nobody knows whether it reached this month", async () => {
    const w = await seedSeptember();
    await saveMinimumOt(w, 10);
    w.state.runs[0].status = "FAILED";
    assert.equal((await w.approveAndLock(ALICE, "2026-09")).outcome, "RECALCULATION_PENDING");

    // And the retry clears the way once it completes.
    await w.calculation.retryRecalculationRun(1);
    await drainQueue(w);
    assert.equal((await w.approveAndLock(ALICE, "2026-09")).outcome, "APPROVED");
  });

  it("COMPLETED_WITH_ERRORS blocks the employee whose month is in the unresolved run", async () => {
    const w = await seedSeptember();
    await saveMinimumOt(w, 10);
    w.state.runs[0].status = "COMPLETED_WITH_ERRORS";
    assert.equal((await w.approveAndLock(ALICE, "2026-09")).outcome, "RECALCULATION_PENDING");
  });

  it("an unrelated shift's propagation does not block", async () => {
    const w = await seedSeptember();
    await saveMinimumOt(w, 10);
    // Carl is on the other shift and was never on 9 TO 6.
    assert.equal((await w.approveAndLock(CARL, "2026-09")).outcome, "APPROVED");
  });

  it("a month locked while the propagation was pending is reported, never skipped silently", async () => {
    // The guard above should prevent this. If a lock lands anyway - through a
    // path that predates the guard, or in the instant between its read and
    // this run reaching the month - the month has been settled on attendance
    // the rule change never reached, and that must be visible.
    const w = await seedSeptember();
    await saveMinimumOt(w, 10);
    w.state.lockedMonths.add(`${ALICE}|2026-09`);
    w.state.lockedAt.set(`${ALICE}|2026-09`, new Date(w.state.now + 60000).toISOString());

    await drainQueue(w);

    const run = w.state.runs[0];
    assert.equal(run.status, "COMPLETED_WITH_ERRORS");
    const reported = run.errors.find((e) => e.employee_id === ALICE);
    assert.ok(reported, "the employee-month is named");
    assert.match(reported.message, /was approved and locked at .*after this shift-rule recalculation was queued/s);
    assert.equal(storedOt(w, ALICE, "2026-09-13"), 100, "and the locked month is untouched");
  });
});

describe("the run row tells the truth about its own scope", () => {
  it("the queued placeholder is replaced with the REAL employees and dates", async () => {
    const w = await seedSeptember();
    const save = await saveMinimumOt(w, 10);

    const queued = w.state.runs[0];
    assert.equal(queued.employees_targeted, 0, "the save could not know, and did not guess");
    assert.equal(queued.from_date, "2026-09-01");

    await drainQueue(w);

    const run = w.state.runs[save.config_version.propagation_run_id - 1];
    assert.equal(run.employees_targeted, 3, "Alice, Bob and Dee are on this shift");
    assert.equal(run.employees_completed, 3);
    assert.equal(run.employees_failed, 0);
    assert.ok(
      run.employees_completed <= run.employees_targeted,
      "never 3 / 0 - the screen shows completed out of targeted"
    );
    assert.equal(run.from_date, "2026-09-01", "the first open affected date");
    assert.equal(run.to_date, TODAY, "and the last");
    assert.equal(run.status, "COMPLETED");
  });

  it("the range is the range actually affected, not the cutover-to-today placeholder", async () => {
    const w = await seedSeptember();
    // Everyone leaves the shift after 14-Sep, so the affected window ends there.
    [ALICE, BOB, DEE].forEach((id) => {
      w.state.assignments.set(id, [
        ...w.state.assignments.get(id),
        {
          employee_work_shift_assignment_id: 50 + id,
          employee_id: id,
          work_shift_id: OTHER_SHIFT,
          effective_from: "2026-09-15",
        },
      ]);
    });

    await saveMinimumOt(w, 10);
    await drainQueue(w);

    const run = w.state.runs[0];
    assert.equal(run.to_date, "2026-09-14", "not today, because the shift stopped governing then");
  });

  it("no open work left: the run finishes honestly at zero rather than keeping the placeholder", async () => {
    const w = await seedSeptember();
    await saveMinimumOt(w, 10);
    // Every affected month is locked before the worker gets there.
    [ALICE, BOB, DEE].forEach((id) => w.state.lockedMonths.add(`${id}|2026-09`));

    await drainQueue(w);

    const run = w.state.runs[0];
    assert.equal(run.employees_targeted, 0);
    assert.equal(run.employees_completed, 0);
    assert.equal(run.days_processed, 0);
    assert.ok(run.days_skipped_locked > 0, "the days it did not touch are counted");
    assert.equal(run.status, "COMPLETED");
    // The range now describes the SKIPPED work rather than a window of work
    // that never existed: here that is the same September span, and what
    // matters is that no employee is claimed as targeted.
    assert.equal(run.from_date, "2026-09-01");
    assert.equal(
      run.employees_completed,
      0,
      "a run that recalculated nothing says so, instead of inheriting the placeholder"
    );
  });

  it("RETRY clears the previous attempt's figures, and the next claim re-derives them", async () => {
    const w = await seedSeptember();
    await saveMinimumOt(w, 10);
    await drainQueue(w);

    // Dirty it the way a partly failed attempt would.
    Object.assign(w.state.runs[0], {
      status: "COMPLETED_WITH_ERRORS",
      employees_completed: 2,
      employees_failed: 1,
      days_processed: 40,
      days_skipped_locked: 9,
      errors: [{ employee_id: ALICE, message: "stale" }],
      last_error: "stale",
      completed_at: "2026-09-21 10:00:00",
    });

    await w.calculation.retryRecalculationRun(1);

    const requeued = w.state.runs[0];
    assert.equal(requeued.status, "QUEUED");
    assert.equal(requeued.attempts, 0);
    assert.equal(requeued.employees_targeted, 0, "the scope is pending again until re-derived");
    assert.equal(requeued.employees_completed, 0);
    assert.equal(requeued.employees_failed, 0);
    assert.equal(requeued.days_processed, 0);
    assert.equal(requeued.days_skipped_locked, 0);
    assert.equal(requeued.errors, null);
    assert.equal(requeued.last_error, null);
    assert.equal(requeued.completed_at, null);
    assert.equal(requeued.heartbeat_at, null);

    await drainQueue(w);

    const done = w.state.runs[0];
    assert.equal(done.status, "COMPLETED");
    assert.equal(done.employees_targeted, 3, "re-derived, not inherited");
    assert.equal(done.employees_completed, 3);
    assert.equal(done.employees_failed, 0);
    assert.deepEqual(done.errors, []);
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

  it("STALE RUNNING + a newer QUEUED run for the same shift: the old one is superseded, the new one drains", async () => {
    // The collision the unique pending-job key creates: run A is RUNNING, the
    // shift is edited again so run B is queued, then A's worker dies. A
    // cannot go back to QUEUED - B owns that shift's pending slot - and a
    // tick that tried would throw on every future tick and never claim B.
    const w = await seedSeptember();
    await saveMinimumOt(w, 15);
    const runA = w.state.runs[0];
    runA.status = "RUNNING";
    runA.attempts = 1;
    runA.heartbeat_at = w.state.now;

    // The shift is edited again while A is running: B is correctly created.
    await saveMinimumOt(w, 10);
    assert.equal(w.state.runs.length, 2, "a RUNNING run does not absorb a new obligation");
    const runB = w.state.runs[1];
    assert.equal(runB.status, "QUEUED");

    // A's worker dies.
    runA.heartbeat_at = w.state.now - 20 * 60 * 1000;

    const ticks = await drainQueue(w);

    assert.equal(ticks[0].recovered.superseded, 1);
    assert.equal(ticks[0].recovered.requeued, 0, "it was never put back in the queue");
    assert.equal(runA.status, "SUPERSEDED");
    assert.equal(runA.superseded_by_run_id, runB.attendance_recalculation_run_id);
    assert.equal(ticks[0].claimed, runB.attendance_recalculation_run_id, "and B was claimed");
    assert.equal(runB.status, "COMPLETED");
    assert.equal(storedOt(w, ALICE, "2026-09-13"), 110, "the latest rule reached the open dates");
  });

  it("FAILED A + QUEUED B for the same shift: Retry on A closes it, B stays the one obligation", async () => {
    const w = await seedSeptember();
    await saveMinimumOt(w, 15);
    const runA = w.state.runs[0];
    runA.status = "RUNNING";
    runA.heartbeat_at = w.state.now;
    await saveMinimumOt(w, 10);
    const runB = w.state.runs[1];
    runA.status = "FAILED";

    const retried = await w.calculation.retryRecalculationRun(
      runA.attendance_recalculation_run_id
    );

    assert.equal(retried.code, 200);
    assert.equal(retried.status, "SUPERSEDED");
    assert.equal(retried.superseded_by_run_id, runB.attendance_recalculation_run_id);
    assert.match(retried.msg, /newer recalculation \(run #2\) is already queued/);
    assert.equal(runA.status, "SUPERSEDED", "no second queued obligation was created");
    assert.equal(
      w.state.runs.filter((r) => r.status === "QUEUED").length,
      1,
      "exactly one pending job for the shift"
    );

    await drainQueue(w);
    assert.equal(runB.status, "COMPLETED");
    assert.equal(storedOt(w, ALICE, "2026-09-13"), 110);
  });

  it("different shifts do NOT coalesce", async () => {
    const w = await seedSeptember();
    await saveMinimumOt(w, 10);
    const runA = w.state.runs[0];
    runA.status = "RUNNING";
    runA.attempts = 1;
    runA.heartbeat_at = w.state.now - 20 * 60 * 1000;

    // A queued run for ANOTHER shift must not adopt this one's work.
    await w.workShift.update(OTHER_SHIFT, {
      work_shift_details: { overtime_minimum_minutes: 10 },
      actor_employee_id: 7,
    });

    const ticks = await drainQueue(w);

    assert.equal(ticks[0].recovered.superseded, 0);
    assert.equal(ticks[0].recovered.requeued, 1, "the stale run for shift 5 is requeued normally");
    assert.equal(runA.status, "COMPLETED", "and it runs");
  });

  it("payroll ignores a SUPERSEDED run but still waits for the run that replaced it", async () => {
    const w = await seedSeptember();
    await saveMinimumOt(w, 15);
    const runA = w.state.runs[0];
    runA.status = "RUNNING";
    runA.heartbeat_at = w.state.now;
    await saveMinimumOt(w, 10);
    const runB = w.state.runs[1];
    runA.heartbeat_at = w.state.now - 20 * 60 * 1000;

    // Recovery has closed A as superseded (proved in the case above); B is
    // still queued and still owes the work.
    runA.status = "SUPERSEDED";
    runA.superseded_by_run_id = runB.attendance_recalculation_run_id;

    const blocked = await w.approveAndLock(ALICE, "2026-09");
    assert.equal(blocked.outcome, "RECALCULATION_PENDING");
    assert.deepEqual(
      blocked.pending_recalculations.map((p) => p.run_id),
      [runB.attendance_recalculation_run_id],
      "the superseded run is not among the things payroll is waiting for"
    );

    await drainQueue(w);

    // Once B completes, payroll is clear.
    assert.equal(runB.status, "COMPLETED");
    assert.equal((await w.approveAndLock(ALICE, "2026-09")).outcome, "APPROVED");
    assert.equal(storedOt(w, ALICE, "2026-09-13"), 110);
  });

  it("a recovery that throws does not stop the tick from claiming the queued run", async () => {
    const w = await seedSeptember();
    await saveMinimumOt(w, 10);
    const original = w.state.requeueThrows;
    w.state.requeueThrows = "deadlock found when trying to get lock";

    const tick = await w.calculation.processQueuedRecalculations({ today: TODAY });

    assert.match(tick.recovered.error, /deadlock/);
    assert.equal(tick.claimed, 1, "the queue still drained");
    assert.equal(w.state.runs[0].status, "COMPLETED");
    w.state.requeueThrows = original;
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
