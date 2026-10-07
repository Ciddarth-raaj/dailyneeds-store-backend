#!/usr/bin/env node
/**
 * ONE-OFF CORRECTION: LUNCH SAVINGS NEVER BECOME OT.
 *
 * Before the rule change, a four-or-more-punch day whose OUT -> IN gaps were
 * shorter than the permitted break turned the unused break into post-shift
 * OT. The engine no longer does (the whole permitted break is reserved for
 * OT on every punch count). This script brings the days ALREADY STORED under
 * the old rule in line, through the ordinary `recalculateRange` - the same
 * path the daily run, a manual recalculation and every correction use - so
 * the engine, the payroll-lock gate and the automatic-OT sync each apply
 * their own rules. It writes no SQL of its own; its one SELECT finds the
 * dates.
 *
 * ======================================================= WHICH DATES =====
 *
 * A stored day is AFFECTED when its stored raw OT is more than the new rule
 * allows:
 *
 *   punch_count >= 4 and even, actual_gap_minutes < break_allowance_minutes,
 *   raw_ot_minutes > MAX(0, worked - payroll NRM - (allowance - gaps))
 *
 * on a CLOSED date (up to yesterday, IST) that is either on or after the
 * automatic-OT cutover (`attendance_ot_auto_pending_setting`), or carries a
 * PENDING OT request (the deploy backfill raised some before the cutover).
 *
 * ========================================================== PER DATE =====
 *
 *   payroll-locked month (APPROVED_LOCKED,      -> NOT touched; reported.
 *   incl. published / paid)                       Paid OT is always locked.
 *   unlocked                                    -> recalculated and stored;
 *                                                 then the OT sync:
 *     PENDING OT                                -> reduced to the new eligible
 *                                                 OT (MINUTES_CHANGED), or
 *                                                 withdrawn when none is left
 *                                                 and no approver has acted
 *     PENDING, part-approved, now 0             -> held (an approval is clamped
 *                                                 to 0 eligible minutes)
 *     APPROVED / REJECTED request               -> the request is NEVER touched
 *                                                 and never increased; the
 *                                                 day's approved figure is the
 *                                                 engine's usual clamp to the
 *                                                 eligible OT, so it can only
 *                                                 come down
 *
 * No new OT can come from this: the rule only removes minutes. Nothing is
 * sent on Telegram. Audit rows carry trigger_source LUNCH_OT_CORRECTION.
 *
 * Usage, on the server, from the repository root:
 *
 *   NODE_ENV=production node scripts/attendance/lunch-ot-correction.js          # preview
 *   NODE_ENV=production node scripts/attendance/lunch-ot-correction.js --apply
 *
 * Idempotent: a second --apply finds no affected date. Exit 1 on any failure.
 */

const { istToday } = require("../../utils/istDate");
const { addDays } = require("../../utils/attendance_engine");

const SOURCE = "LUNCH_OT_CORRECTION";

function parseArgs(argv) {
  const out = { apply: false };
  for (const arg of argv) {
    if (arg === "--apply") out.apply = true;
    else if (arg === "--preview") out.apply = false;
    else throw new Error(`unknown argument ${arg}`);
  }
  return out;
}

const AFFECTED_SQL = `
  SELECT d.employee_id,
         DATE_FORMAT(d.attendance_date, '%Y-%m-%d') AS attendance_date,
         d.raw_ot_minutes, d.candidate_ot_minutes, d.pre_shift_ot_minutes,
         d.post_shift_ot_minutes, d.approved_ot_minutes
    FROM attendance_day_calculation d
   WHERE d.punch_count >= 4 AND MOD(d.punch_count, 2) = 0
     AND d.actual_gap_minutes IS NOT NULL
     AND d.actual_gap_minutes < d.break_allowance_minutes
     AND d.raw_ot_minutes > GREATEST(0,
           d.worked_minutes - COALESCE(d.base_nrm_minutes, d.nrm_minutes)
           - (d.break_allowance_minutes - d.actual_gap_minutes))
     AND d.attendance_date <= ?
     AND (d.attendance_date >= ?
          OR EXISTS (SELECT 1 FROM attendance_approval_request r
                      WHERE r.requested_for_employee_id = d.employee_id
                        AND r.attendance_date = d.attendance_date
                        AND r.request_type = 'OT' AND r.status = 'PENDING'))
   ORDER BY d.employee_id, d.attendance_date`;

const n = (v) => Math.max(0, Math.trunc(Number(v) || 0));
const figures = (row) => ({
  raw_ot_minutes: n(row && row.raw_ot_minutes),
  candidate_ot_minutes: n(row && row.candidate_ot_minutes),
  pre_shift_ot_minutes: n(row && row.pre_shift_ot_minutes),
  post_shift_ot_minutes: n(row && row.post_shift_ot_minutes),
  approved_ot_minutes: n(row && row.approved_ot_minutes),
});
const sameFigures = (a, b) => Object.keys(a).every((k) => a[k] === b[k]);

/**
 * @param {object} deps
 * @param {Function} deps.listAffected   ({ to_date, cutover }) -> stored rows
 * @param {Function} deps.findLocked     (rows) -> [{ employee_id, year, month }]
 * @param {Function} deps.calculateRange preview: the engine's live day
 * @param {Function} deps.syncAutoOt     preview: dry-run sync
 * @param {Function} deps.recalculateRange apply: store + sync
 */
async function run({ listAffected, findLocked, calculateRange, syncAutoOt, recalculateRange, setting, today, now = null, apply = false, log = () => {} }) {
  if (!setting || !setting.auto_pending_from_date) {
    throw new Error("No automatic-OT cutover row (attendance_ot_auto_pending_setting) - nothing to correct from");
  }
  const cutover = String(setting.auto_pending_from_date).slice(0, 10);
  const yesterday = addDays(today, -1);
  const affected = (await listAffected({ to_date: yesterday, cutover })) || [];
  log(`${affected.length} stored day(s) carry unused-lunch OT (cutover ${cutover}, up to ${yesterday})`);

  const lockedPeriods = affected.length ? (await findLocked(affected)) || [] : [];
  const lockedKey = new Set(lockedPeriods.map((p) => `${Number(p.employee_id)}|${Number(p.year)}|${Number(p.month)}`));
  const isLocked = (r) => {
    const [y, m] = r.attendance_date.split("-").map(Number);
    return lockedKey.has(`${Number(r.employee_id)}|${y}|${m}`);
  };

  const report = {
    mode: apply ? "APPLY" : "PREVIEW",
    cutover,
    to_date: yesterday,
    affected_days: affected.length,
    skipped_payroll_locked: [],
    days_corrected: [],
    days_unchanged: [],
    pending_ot_reduced: [],
    pending_ot_withdrawn: [],
    pending_ot_held: [],
    approved_ot_preserved: [],
    ot_created: [],
    failures: [],
  };

  for (const row of affected) {
    const employeeId = Number(row.employee_id);
    const date = row.attendance_date;
    if (isLocked(row)) {
      report.skipped_payroll_locked.push({ employee_id: employeeId, attendance_date: date, ...figures(row) });
      continue;
    }
    const before = figures(row);
    try {
      /* eslint-disable no-await-in-loop */
      let day;
      let sync;
      if (apply) {
        const out = await recalculateRange({ employee_id: employeeId, from_date: date, to_date: date, now, ot_sync_source: SOURCE });
        day = (out.days || []).find((d) => d.attendance_date === date) || null;
        sync = out.ot_auto_pending;
        if (!day) {
          report.failures.push({ employee_id: employeeId, attendance_date: date, reason: "NOT_STORED", skipped_open_dates: out.skipped_open_dates, ineligible_dates: out.ineligible_dates });
          continue;
        }
      } else {
        [day] = await calculateRange({ employee_id: employeeId, from_date: date, to_date: date });
        sync = day ? await syncAutoOt({ employee_id: employeeId, days: [day], now, source: SOURCE, dry_run: true, notify: false }) : null;
      }
      /* eslint-enable no-await-in-loop */
      const after = figures(day);
      const entry = { employee_id: employeeId, attendance_date: date, before, after };
      if (after.approved_ot_minutes > before.approved_ot_minutes || after.candidate_ot_minutes > before.candidate_ot_minutes) {
        report.failures.push({ ...entry, reason: "OT_WOULD_INCREASE" });
        continue;
      }
      (sameFigures(before, after) ? report.days_unchanged : report.days_corrected).push(entry);
      const tag = (list) => (list || []).map((x) => ({ employee_id: employeeId, ...x }));
      if (sync) {
        report.pending_ot_reduced.push(...tag(sync.updated));
        report.pending_ot_withdrawn.push(...tag(sync.withdrawn));
        report.pending_ot_held.push(...tag(sync.held));
        report.approved_ot_preserved.push(...tag(sync.preserved_approved));
        report.ot_created.push(...tag(sync.created));
        if (Array.isArray(sync.errors) && sync.errors.length) {
          report.failures.push({ ...entry, reason: "OT_SYNC_ERROR", errors: sync.errors });
        }
      } else if (apply) {
        report.failures.push({ ...entry, reason: "OT_SYNC_NOT_RUN" });
      }
    } catch (err) {
      report.failures.push({ employee_id: employeeId, attendance_date: date, reason: "ERROR", message: err && err.message ? err.message : String(err) });
    }
  }

  report.summary = {
    affected_days: report.affected_days,
    attendance_days_corrected: report.days_corrected.length,
    attendance_days_unchanged: report.days_unchanged.length,
    days_skipped_payroll_locked: report.skipped_payroll_locked.length,
    pending_ot_requests_reduced: report.pending_ot_reduced.length,
    pending_ot_requests_withdrawn: report.pending_ot_withdrawn.length,
    pending_ot_requests_corrected: report.pending_ot_reduced.length + report.pending_ot_withdrawn.length,
    pending_ot_requests_held_part_approved: report.pending_ot_held.length,
    approved_ot_requests_preserved: report.approved_ot_preserved.length,
    approved_ot_day_figures_reduced: report.days_corrected.filter((e) => e.after.approved_ot_minutes < e.before.approved_ot_minutes).length,
    ot_requests_created: report.ot_created.length,
    failures: report.failures.length,
  };
  return report;
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
    // The server's wiring, minus Telegram: the correction messages nobody.
    calculation.setOtRequestService(regularization);
    calculation.setOtAutoSync(regularization);
    const query = (sql, params) =>
      new Promise((resolve, reject) => pool.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));
    const report = await run({
      listAffected: ({ to_date, cutover }) => query(AFFECTED_SQL, [to_date, cutover]),
      findLocked: (rows) => calcRepo.findPayrollLockedPeriodsBulk(rows),
      calculateRange: calculation.calculateRange,
      syncAutoOt: regularization.syncAutoOt,
      recalculateRange: calculation.recalculateRange,
      setting: await regRepo.getAutoOtSetting(),
      today: istToday(),
      apply: args.apply,
      log: (line) => console.error(line),
    });
    console.log(JSON.stringify(report, null, 2));
    console.error(`SUMMARY ${JSON.stringify(report.summary)}`);
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

module.exports = { parseArgs, run, AFFECTED_SQL, SOURCE };
