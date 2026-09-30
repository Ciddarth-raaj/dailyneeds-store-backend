#!/usr/bin/env node
/**
 * ONE-TIME BOOTSTRAP: give the existing, UNLOCKED monthly attendance
 * summaries a `day_rows_fingerprint` by storing each month again through the
 * normal path - `calculateMonth({ ..., persist: true })`.
 *
 * WHY NOT A SQL BACKFILL. A summary stored before the fingerprint existed may
 * already be stale against its day rows. Writing a fingerprint over today's
 * day rows without rebuilding the totals would certify figures nobody
 * rebuilt. Here every summary is rebuilt from its days and the fingerprint is
 * taken from the days the same transaction stored - this script writes no
 * SQL of its own at all.
 *
 * WHAT IT NEVER TOUCHES. A month whose payrun row is APPROVED_LOCKED is
 * skipped, and nothing is unlocked. The month persist also re-checks the lock
 * under `FOR UPDATE`, so a month locked while this runs is refused there and
 * reported, not written.
 *
 * AFTERWARDS, recalculate payroll for the same employees and month (Payrun >
 * Calculation & Review > Recalculate): their rows read "recalculation
 * required" until then, because the attendance they priced was re-stored.
 *
 * Usage, on the server, from the repository root:
 *
 *   # 1. inventory - which months hold summaries, how many are locked/untracked
 *   NODE_ENV=production node scripts/attendance/month-fingerprint-bootstrap.js
 *
 *   # 2. dry run for a month - who would be re-stored, who is skipped as locked
 *   NODE_ENV=production node scripts/attendance/month-fingerprint-bootstrap.js --month 2026-09
 *
 *   # 3. apply
 *   NODE_ENV=production node scripts/attendance/month-fingerprint-bootstrap.js --month 2026-09 --apply
 *
 * `--month` may be repeated; `--employee <id>` (repeatable) narrows a run.
 * Exit code 1 if any employee-month failed or was left without a fingerprint.
 */

const LOCKED = "APPROVED_LOCKED";

const INVENTORY_SQL = `
  SELECT m.period_year, m.period_month,
         COUNT(*) AS summaries,
         COALESCE(SUM(m.day_rows_fingerprint IS NULL), 0) AS untracked,
         COALESCE(SUM(p.status = '${LOCKED}'), 0) AS payroll_locked
    FROM attendance_monthly_payroll m
    LEFT JOIN payrun_employee_calculation p
      ON p.employee_id = m.employee_id
     AND p.period_year = m.period_year
     AND p.period_month = m.period_month
   GROUP BY m.period_year, m.period_month
   ORDER BY m.period_year, m.period_month`;

const monthRowsSql = (withEmployees) => `
  SELECT m.employee_id,
         (m.day_rows_fingerprint IS NULL) AS untracked,
         p.status AS payrun_status
    FROM attendance_monthly_payroll m
    LEFT JOIN payrun_employee_calculation p
      ON p.employee_id = m.employee_id
     AND p.period_year = m.period_year
     AND p.period_month = m.period_month
   WHERE m.period_year = ? AND m.period_month = ?${withEmployees ? " AND m.employee_id IN (?)" : ""}
   ORDER BY m.employee_id`;

const VERIFY_SQL = `
  SELECT employee_id
    FROM attendance_monthly_payroll
   WHERE period_year = ? AND period_month = ? AND employee_id IN (?)
     AND (day_rows_fingerprint IS NULL OR day_rows_fingerprint = '')`;

function parseArgs(argv) {
  const out = { months: [], employee_ids: [], apply: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") out.apply = true;
    else if (arg === "--month") {
      const m = /^(\d{4})-(\d{2})$/.exec(argv[i + 1] || "");
      if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) throw new Error("--month takes YYYY-MM");
      out.months.push({ year: Number(m[1]), month: Number(m[2]) });
      i += 1;
    } else if (arg === "--employee") {
      const id = Number(argv[i + 1]);
      if (!Number.isInteger(id) || id <= 0) throw new Error("--employee takes a positive employee id");
      out.employee_ids.push(id);
      i += 1;
    } else throw new Error(`unknown argument ${arg}`);
  }
  if (out.apply && out.months.length === 0) throw new Error("--apply needs at least one --month");
  if (out.employee_ids.length > 0 && out.months.length === 0) throw new Error("--employee needs a --month");
  return out;
}

async function inventory(query) {
  return (await query(INVENTORY_SQL)).map((r) => ({
    month: `${r.period_year}-${String(r.period_month).padStart(2, "0")}`,
    summaries: Number(r.summaries),
    untracked: Number(r.untracked),
    payroll_locked: Number(r.payroll_locked),
  }));
}

/** Who a month would re-store, and who it leaves alone because payroll is locked. */
async function planMonth(query, { year, month, employee_ids = [] }) {
  const withEmployees = employee_ids.length > 0;
  const rows = await query(monthRowsSql(withEmployees), withEmployees ? [year, month, employee_ids] : [year, month]);
  const toRestore = [];
  const locked = [];
  for (const r of rows) {
    if (r.payrun_status === LOCKED) locked.push(Number(r.employee_id));
    else toRestore.push({ employee_id: Number(r.employee_id), untracked: Boolean(Number(r.untracked)) });
  }
  return { year, month, summaries: rows.length, locked, to_restore: toRestore };
}

/**
 * Re-store each unlocked employee-month, one at a time, through
 * `calculateMonth(persist=true)`. One failure never stops the rest.
 */
async function run({ query, calculateMonth, months, employee_ids = [], apply = false, log = () => {} }) {
  const report = [];
  for (const { year, month } of months) {
    /* eslint-disable no-await-in-loop */
    const plan = await planMonth(query, { year, month, employee_ids });
    const entry = {
      month: `${year}-${String(month).padStart(2, "0")}`,
      summaries: plan.summaries,
      skipped_payroll_locked: plan.locked,
      to_restore: plan.to_restore.length,
      untracked_before: plan.to_restore.filter((e) => e.untracked).length,
      applied: apply,
      restored: [],
      locked_during_run: [],
      failed: [],
      still_without_fingerprint: [],
    };
    if (apply) {
      for (const { employee_id } of plan.to_restore) {
        try {
          await calculateMonth({ employee_id, year, month, persist: true });
          entry.restored.push(employee_id);
          log(`restored ${entry.month} employee ${employee_id}`);
        } catch (err) {
          if (err && err.code === "PAYROLL_MONTH_LOCKED") {
            entry.locked_during_run.push(employee_id);
            log(`skipped ${entry.month} employee ${employee_id}: payroll locked meanwhile`);
          } else {
            entry.failed.push({ employee_id, code: (err && err.code) || null, message: String((err && err.message) || err) });
            log(`FAILED ${entry.month} employee ${employee_id}: ${(err && err.message) || err}`);
          }
        }
      }
      if (entry.restored.length > 0) {
        entry.still_without_fingerprint = (await query(VERIFY_SQL, [year, month, entry.restored])).map((r) =>
          Number(r.employee_id)
        );
      }
    }
    /* eslint-enable no-await-in-loop */
    report.push(entry);
  }
  return report;
}

const succeeded = (report) => report.every((m) => m.failed.length === 0 && m.still_without_fingerprint.length === 0);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  global.env = process.env.NODE_ENV === undefined ? "development" : process.env.NODE_ENV;
  const mysql = await require("../../drivers/mysql")().connect();
  const pool = mysql.connection;
  const query = (sql, params = []) =>
    new Promise((resolve, reject) => pool.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));
  try {
    if (args.months.length === 0) {
      console.log(JSON.stringify({ inventory: await inventory(query) }, null, 2));
      return 0;
    }
    const repo = require("../../repository/attendance_calculation")(pool);
    const usecase = require("../../usecase/attendance_calculation")(repo);
    const report = await run({
      query,
      calculateMonth: usecase.calculateMonth,
      months: args.months,
      employee_ids: args.employee_ids,
      apply: args.apply,
      log: (line) => console.error(line),
    });
    console.log(JSON.stringify({ applied: args.apply, report }, null, 2));
    return succeeded(report) ? 0 : 1;
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

module.exports = { parseArgs, inventory, planMonth, run, succeeded, INVENTORY_SQL, VERIFY_SQL };
