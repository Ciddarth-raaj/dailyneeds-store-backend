#!/usr/bin/env node
/**
 * DEPLOY BACKFILL: the previous N (default 5) attendance days' eligible OT,
 * into approval - through the SAME `syncAutoOt` the attendance engine calls
 * after every stored day. This script writes no SQL of its own.
 *
 * WHAT IT DOES PER EMPLOYEE AND DATE (yesterday back N days):
 *
 *   eligible OT, no OT record                 -> created PENDING (auto)
 *   PENDING OT, minutes changed                -> follows the engine
 *   PENDING auto OT, no eligible OT any more   -> withdrawn
 *   APPROVED or REJECTED (incl. payroll-lock
 *   closures)                                  -> PRESERVED, never touched
 *   payroll-locked month, open day, before
 *   the cutover, outside employment           -> skipped, with the reason
 *
 * IDEMPOTENT. A date that already carries an OT record is matched to it, and
 * the database refuses a second PENDING one - so a second run creates
 * nothing. Nobody has to request any of these days retrospectively.
 *
 * Usage, on the server, from the repository root:
 *
 *   # 1. PREVIEW (default) - counts and per-date detail, nothing written
 *   NODE_ENV=production node scripts/attendance/ot-auto-pending-backfill.js
 *
 *   # 2. apply (after migration 20261124120000 has run)
 *   NODE_ENV=production node scripts/attendance/ot-auto-pending-backfill.js --apply
 *
 * Options: --days <n> (1..31, default 5), --employee <id> (repeatable),
 * --today YYYY-MM-DD (the business date to count back from; default IST
 * today), --no-telegram (apply without messaging first approvers).
 * Exit code 1 if any employee or date failed.
 */

const { istToday } = require("../../utils/istDate");
const { addDays } = require("../../utils/attendance_engine");

const DEFAULT_DAYS = 5;

function parseArgs(argv) {
  const out = { apply: false, days: DEFAULT_DAYS, employee_ids: [], today: null, telegram: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") out.apply = true;
    else if (arg === "--preview") out.apply = false;
    else if (arg === "--no-telegram") out.telegram = false;
    else if (arg === "--days") {
      const n = Number(argv[i + 1]);
      if (!Number.isInteger(n) || n < 1 || n > 31) throw new Error("--days takes a whole number from 1 to 31");
      out.days = n;
      i += 1;
    } else if (arg === "--employee") {
      const id = Number(argv[i + 1]);
      if (!Number.isInteger(id) || id <= 0) throw new Error("--employee takes a positive employee id");
      out.employee_ids.push(id);
      i += 1;
    } else if (arg === "--today") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(argv[i + 1] || "")) throw new Error("--today takes YYYY-MM-DD");
      out.today = argv[i + 1];
      i += 1;
    } else throw new Error(`unknown argument ${arg}`);
  }
  return out;
}

/** yesterday back `days` days, oldest first: the attendance days the deploy covers. */
function windowFor(today, days) {
  const dates = [];
  for (let n = days; n >= 1; n -= 1) dates.push(addDays(today, -n));
  return dates;
}

const CATEGORIES = [
  "created",
  "updated",
  "withdrawn",
  "unchanged",
  "preserved_approved",
  "preserved_rejected",
  "held",
  "skipped",
  "errors",
];

/**
 * Sync every employee over the window. One failure never stops the rest.
 *
 * @param {object}   deps
 * @param {Function} deps.syncAutoOt      the regularization usecase's sync
 * @param {Function} deps.listEmployees   ({ from_date, to_date }) -> [{ employee_id }]
 * @param {object}   [deps.setting]       the cutover row as stored (null = migration not run)
 */
async function run({ syncAutoOt, listEmployees, setting = null, today, days, employee_ids = [], apply = false, telegram = true, log = () => {} }) {
  const dates = windowFor(today, days);
  const from = dates[0];
  const to = dates[dates.length - 1];

  if (apply && (!setting || !(setting.enabled === true || Number(setting.enabled) === 1))) {
    throw new Error(
      "Automatic pending OT is not enabled (migration 20261124120000 not run, or its setting row is disabled) - run the migration first, or preview without --apply"
    );
  }
  // A preview may be taken before the migration: it assumes the cutover the
  // migration will seed (the first date of this window).
  const assumed = setting || { enabled: 1, auto_pending_from_date: from };

  const population =
    employee_ids.length > 0
      ? employee_ids.map((employee_id) => ({ employee_id }))
      : await listEmployees({ from_date: from, to_date: to });

  const totals = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
  const skippedByReason = {};
  const detail = [];
  const failures = [];
  let createdMinutes = 0;

  for (const { employee_id } of population) {
    /* eslint-disable no-await-in-loop */
    try {
      const result = await syncAutoOt({
        employee_id,
        dates,
        today,
        source: "BACKFILL",
        dry_run: !apply,
        notify: apply && telegram,
        assume_setting: apply ? null : assumed,
      });
      if (!result.enabled) {
        failures.push({ employee_id, message: "automatic pending OT is disabled" });
        continue;
      }
      CATEGORIES.forEach((c) => {
        totals[c] += (result[c] || []).length;
      });
      (result.skipped || []).forEach((s) => {
        skippedByReason[s.reason] = (skippedByReason[s.reason] || 0) + 1;
      });
      createdMinutes += (result.created || []).reduce((n, c) => n + (Number(c.ot_minutes) || 0), 0);
      const interesting = ["created", "updated", "withdrawn", "preserved_approved", "preserved_rejected", "held", "errors"];
      if (interesting.some((c) => (result[c] || []).length > 0)) {
        const row = { employee_id };
        interesting.forEach((c) => {
          if ((result[c] || []).length > 0) row[c] = result[c];
        });
        detail.push(row);
      }
      (result.errors || []).forEach((e) => failures.push({ employee_id, ...e }));
      if ((result.created || []).length > 0) {
        log(`${apply ? "created" : "would create"} ${(result.created || []).length} pending OT for employee ${employee_id}`);
      }
    } catch (err) {
      failures.push({ employee_id, message: String((err && err.message) || err) });
      log(`FAILED employee ${employee_id}: ${(err && err.message) || err}`);
    }
    /* eslint-enable no-await-in-loop */
  }

  return {
    applied: apply,
    today,
    from_date: from,
    to_date: to,
    cutover: assumed.auto_pending_from_date,
    employees_checked: population.length,
    totals: {
      [apply ? "pending_ot_created" : "pending_ot_would_be_created"]: totals.created,
      pending_ot_minutes_created: createdMinutes,
      [apply ? "pending_ot_minutes_changed" : "pending_ot_minutes_would_change"]: totals.updated,
      [apply ? "auto_pending_withdrawn" : "auto_pending_would_be_withdrawn"]: totals.withdrawn,
      already_pending_unchanged: totals.unchanged,
      approved_preserved: totals.preserved_approved,
      rejected_preserved: totals.preserved_rejected,
      pending_held_for_approver: totals.held,
      skipped: totals.skipped,
      errors: totals.errors,
    },
    skipped_by_reason: skippedByReason,
    detail,
    failures,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  global.env = process.env.NODE_ENV === undefined ? "development" : process.env.NODE_ENV;
  const mysql = await require("../../drivers/mysql")().connect();
  const pool = mysql.connection;
  try {
    const calcRepo = require("../../repository/attendance_calculation")(pool);
    const regRepo = require("../../repository/attendance_regularization")(pool);
    const approverSetupRepo = require("../../repository/attendance_approver_setup")(pool);
    const calculation = require("../../usecase/attendance_calculation")(calcRepo);
    const regularization = require("../../usecase/attendance_regularization")(regRepo, calculation, approverSetupRepo);
    if (args.apply && args.telegram) {
      regularization.setOtNotifier(
        require("../../usecase/attendance_ot_telegram")({
          regularizationUsecase: regularization,
          employeeTelegramRepo: require("../../repository/employee_telegram")(pool),
          telegram: require("../../services/telegram")(),
          webBaseUrl: process.env.WEB_APP_BASE_URL || null,
        })
      );
    }
    const report = await run({
      syncAutoOt: regularization.syncAutoOt,
      listEmployees: ({ from_date, to_date }) => calcRepo.listEmployeesForRecalculation({ from_date, to_date }),
      setting: await regRepo.getAutoOtSetting(),
      today: istToday(args.today),
      days: args.days,
      employee_ids: args.employee_ids,
      apply: args.apply,
      telegram: args.telegram,
      log: (line) => console.error(line),
    });
    console.log(JSON.stringify(report, null, 2));
    return report.failures.length === 0 ? 0 : 1;
  } finally {
    mysql.close();
  }
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err && err.stack ? err.stack : err);
      process.exit(1);
    }
  );
}

module.exports = { parseArgs, windowFor, run, DEFAULT_DAYS };
