/**
 * THE DAILY AUTOMATIC ATTENDANCE RECALCULATION - 06:55 IST, today-3..yesterday.
 *
 * ================================================================ WHY ======
 *
 * A stored `attendance_day_calculation` row is what every read returns once
 * its date has closed, and nothing replaces it when a punch for that date
 * arrives LATER: the direct Biomax receiver - the attendance source - stores
 * raw punches and deliberately recalculates nothing. A delayed device punch
 * for 22-Sep that lands after 22-Sep was stored would otherwise be ignored for
 * ever. This job rebuilds the last three closed-or-closing days from the raw
 * punches every morning, so such a punch is picked up by the next morning's
 * run:
 *
 *   2026-09-24 06:55  ->  2026-09-21 .. 2026-09-23
 *
 * SCHEDULE: this job is scheduled at 06:55 and the Missing Attendance
 * Telegram at 07:00, so the Telegram reads yesterday from the recalculated
 * attendance. These are START times - cron does not wait for one job to
 * finish before starting the next.
 *
 * ========================================================= WHAT IT IS ======
 *
 * ORCHESTRATION ONLY. It calls `recalculateBulk` - the Recalculate Attendance
 * screen's own path, per employee through `recalculateRange` - with the whole
 * company as the population. Every rule is that path's:
 *
 *   - only dates whose attendance day has CLOSED under their own shift
 *     snapshot and cutoff are stored (`utils/attendance_persist_guard.js`);
 *     yesterday under an overnight cutoff that has not passed is skipped and
 *     reported, and picked up by tomorrow's run;
 *   - a payroll-locked month is refused by the transactional `FOR UPDATE`
 *     gate exactly as for a manual run - nothing in it is written. The window
 *     is recalculated one calendar month at a time, so a locked month cannot
 *     block the open month beside it, and a lock refusal is reported as
 *     SKIPPED_LOCKED rather than as a failure;
 *   - employment and `attendance_required` are applied by the shared rule.
 *
 * Nothing here computes attendance, and nothing here writes a table directly.
 *
 * =================================================== SYSTEM, NOT MANUAL ====
 *
 * `attendance_recalculation_run.trigger_source` can say MANUAL or
 * WORK_SHIFT_SAVE and nothing else, and adding a value is a migration. A row
 * saying MANUAL with no requester would be a manual run nobody asked for, so
 * this job writes NO run row (`record_run: false`). It is audited instead in
 * `api_sync_log`, the table every other scheduled job already writes:
 * `log_type = 'attendance_daily_recalculation'`, `source = 'cron'`,
 * `employee_id = NULL`, the full summary in `metadata_json` - visible on the
 * API Sync Log screen - plus a console line and, on failure, `logger.Log`.
 *
 * ======================================================== SAFETY ===========
 *
 * NON-REENTRANT. A run still in flight makes the next invocation a logged
 * no-op; it is never queued behind it. The guard is in-process, which is
 * sound because the API runs as ONE pm2 fork-mode process
 * (`services/digisme_cron_topology.test.js` fails if that changes).
 *
 * IT NEVER THROWS. Every failure is caught, logged and returned as a FAILED
 * summary, so a bad morning cannot take down the API or stop the 07:00
 * Missing Attendance Telegram job from running.
 */

const { addDays } = require("../utils/attendance_engine");
const { istDateOf } = require("../utils/istDate");

const LOG_TYPE = "attendance_daily_recalculation";

/** `YYYY-MM-DD` inclusive range split at calendar-month boundaries. */
function monthSegments(from, to) {
  const segments = [];
  let cursor = from;
  while (cursor <= to) {
    const month = cursor.slice(0, 7);
    let end = cursor;
    while (addDays(end, 1) <= to && addDays(end, 1).slice(0, 7) === month) end = addDays(end, 1);
    segments.push({ from_date: cursor, to_date: end });
    cursor = addDays(end, 1);
  }
  return segments;
}
/** How many days back the window starts. today-3 .. today-1. */
const WINDOW_DAYS = 3;

/**
 * The window for a business date: `today - 3` through `today - 1`, inclusive.
 * Today is never in it - its attendance day cannot have closed.
 */
function dailyRecalculationWindow(today) {
  return { from_date: addDays(today, -WINDOW_DAYS), to_date: addDays(today, -1) };
}

/**
 * @param {object} deps
 * @param {object} deps.calculation  the attendance calculation usecase
 * @param {object} [deps.apiSyncLogger]  `{ write(entry) }`
 * @param {object} [deps.logger]  `utils/logger`
 * @param {function} [deps.now]  clock (epoch ms); production uses Date.now
 * @param {object} [deps.console]  for the one-line summary
 */
function createDailyRecalculation({
  calculation,
  apiSyncLogger = null,
  logger = null,
  now = () => Date.now(),
  console: out = console,
} = {}) {
  let running = false;

  const logError = (code, err, ref = {}) => {
    if (!logger || typeof logger.Log !== "function") return;
    try {
      logger.Log({
        level: logger.LEVEL ? logger.LEVEL.ERROR : "error",
        component: "CRON.ATTENDANCE_DAILY_RECALCULATION",
        code: `CRON.ATTENDANCE_DAILY_RECALCULATION.${code}`,
        description: err && err.toString ? err.toString() : String(err),
        category: "",
        ref,
      });
    } catch (_) {
      /* logging must never throw out of a cron */
    }
  };

  const audit = async (summary) => {
    if (!apiSyncLogger || typeof apiSyncLogger.write !== "function") return;
    const failed = summary.status !== "COMPLETED";
    try {
      await apiSyncLogger.write({
        log_type: LOG_TYPE,
        method: "POST",
        path: "/attendance/calculated/daily-recalculation",
        status: failed ? "failed" : "success",
        status_code: failed ? 500 : 200,
        duration_ms: summary.duration_ms,
        row_count: Number(summary.attendance_days_processed) || 0,
        source: "cron",
        employee_id: null,
        metadata_json: summary,
        error_message: summary.message ? String(summary.message).slice(0, 512) : null,
      });
    } catch (err) {
      logError("AUDIT", err);
    }
  };

  /** One run. Never throws; always resolves to a summary. */
  const run = async () => {
    if (running) {
      out.log(`[CRON] ${LOG_TYPE} - previous run still in flight; this invocation is skipped`);
      return { skipped: true, reason: "in_progress" };
    }
    running = true;
    const started = now();
    const today = istDateOf(started);
    const { from_date, to_date } = dailyRecalculationWindow(today);
    let summary;
    try {
      // ONE BULK CALL PER CALENDAR MONTH of the window (at most two). The
      // payroll lock is a monthly fact and `recalculateRange` writes an
      // employee's window in one transaction, so a window spanning a locked
      // month and an open one must not let the lock refuse the open month's
      // dates too.
      const results = [];
      for (const segment of monthSegments(from_date, to_date)) {
        /* eslint-disable no-await-in-loop */
        const result = await calculation.recalculateBulk({
          from_date: segment.from_date,
          to_date: segment.to_date,
          actor_employee_id: null,
          // The whole run judges open/closed at the instant it started.
          now: started,
          record_run: false,
        });
        /* eslint-enable no-await-in-loop */
        results.push({ ...segment, result });
      }

      // A PAYROLL-LOCKED refusal is the lock doing its job, not a failure:
      // those employee-months are reported as skipped and nothing in them is
      // written. Anything else is an error.
      const lockedSkips = [];
      const errors = [];
      results.forEach(({ from_date: segFrom, to_date: segTo, result }) => {
        (result.errors || []).forEach((e) => {
          const entry = { ...e, from_date: segFrom, to_date: segTo };
          if (e.code === "PAYROLL_MONTH_LOCKED") lockedSkips.push(entry);
          else errors.push(entry);
        });
      });
      const sum = (key) => results.reduce((n, { result }) => n + (Number(result[key]) || 0), 0);
      const failedEmployees = new Set(errors.map((e) => e.employee_id));

      summary = {
        trigger: "DAILY_AUTO",
        business_date: today,
        from_date,
        to_date,
        segments: results.map(({ from_date: f, to_date: t }) => ({ from_date: f, to_date: t })),
        status: errors.length ? "COMPLETED_WITH_ERRORS" : "COMPLETED",
        employees_targeted: Math.max(0, ...results.map(({ result }) => Number(result.employees_targeted) || 0)),
        employees_failed: failedEmployees.size,
        attendance_days_processed: sum("attendance_days_processed"),
        attendance_days_skipped_open: sum("attendance_days_skipped_open"),
        open_dates_skipped: [
          ...new Set(results.flatMap(({ result }) => result.open_dates_skipped || [])),
        ].sort(),
        stale_rows_removed: sum("stale_rows_removed"),
        employee_months_skipped_locked: lockedSkips.length,
        skipped_locked: lockedSkips.map((e) => ({
          employee_id: e.employee_id,
          from_date: e.from_date,
          to_date: e.to_date,
        })),
        errors,
        message: errors.length
          ? `${errors.length} employee(s) not recalculated: ${errors
              .slice(0, 5)
              .map((e) => `${e.employee_id}: ${e.message}`)
              .join("; ")}`
          : undefined,
        duration_ms: now() - started,
      };
      if (errors.length) logError("EMPLOYEE_ERRORS", new Error(summary.message), { from_date, to_date });
    } catch (err) {
      summary = {
        trigger: "DAILY_AUTO",
        business_date: today,
        from_date,
        to_date,
        status: "FAILED",
        message: err && err.message ? err.message : String(err),
        errors: [],
        duration_ms: now() - started,
      };
      logError("RUN", err, { from_date, to_date });
    } finally {
      running = false;
    }

    try {
      out.log(
        `[CRON] ${LOG_TYPE} ${summary.from_date}..${summary.to_date}: ${summary.status}, ` +
          `${Number(summary.attendance_days_processed) || 0} day(s) stored, ` +
          `${Number(summary.attendance_days_skipped_open) || 0} still open skipped, ` +
          `${Number(summary.employee_months_skipped_locked) || 0} payroll-locked employee-month(s) skipped, ` +
          `${Number(summary.employees_failed) || 0} employee(s) failed, ${summary.duration_ms} ms`
      );
    } catch (_) {
      /* never throw */
    }
    await audit(summary);
    return summary;
  };

  return { run, isRunning: () => running };
}

module.exports = createDailyRecalculation;
module.exports.dailyRecalculationWindow = dailyRecalculationWindow;
module.exports.monthSegments = monthSegments;
module.exports.LOG_TYPE = LOG_TYPE;
module.exports.WINDOW_DAYS = WINDOW_DAYS;
