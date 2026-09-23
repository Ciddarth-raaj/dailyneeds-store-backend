/**
 * THE WORK SHIFT RULE PROPAGATION HARNESS.
 *
 * Extracted verbatim from `work_shift_rule_propagation.test.js` so that the
 * cross-feature compatibility suite can drive the SAME world - the same
 * fakes, the same queue, the same worker - rather than a second copy of it
 * that would quietly drift away from the real one. Nothing here changed in
 * the move except the requires and the exports at the foot.
 *
 * Not a test file: it registers no tests and is required, never run.
 */

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

const assert = require("node:assert/strict");

const buildCalculation = require("./attendance_calculation");
const buildWorkShift = require("./work_shift");
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
    // The live shift list, as `listActiveWorkShiftOptions` returns it. Used by
    // the one-day shift request's option builder; the propagation suite never
    // asks for it, so adding it changes nothing there.
    listActiveWorkShiftOptions: async () =>
      [...state.live.values()]
        .filter((l) => Number(l.config.active) === 1)
        .map((l) => ({
          work_shift_id: l.config.work_shift_id,
          shift_code: l.config.shift_code,
          shift_name: l.config.shift_name,
        })),
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

  // TODAY IS PINNED. The propagation never reaches a date that has not
  // closed, so a test that agreed with the wall clock would start failing on
  // its own one day.
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
const drainQueue = async (w, { ticks = 5, today = TODAY, now = null } = {}) => {
  const results = [];
  for (let i = 0; i < ticks; i += 1) {
    /* eslint-disable no-await-in-loop */
    // `now` pins the INSTANT the closed-date guard is evaluated at; left
    // null, it is the last minute of `today`.
    const tick = await w.calculation.processQueuedRecalculations({ today, now });
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

module.exports = {
  TODAY,
  SHIFT,
  OTHER_SHIFT,
  ALICE,
  BOB,
  CARL,
  DEE,
  scheduleFor,
  configFor,
  monthOf,
  workedDay,
  world,
  drainQueue,
  storedOt,
  saveMinimumOt,
  seedSeptember,
};
