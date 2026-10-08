#!/usr/bin/env node
/**
 * READ-ONLY: calculated OT that has NO OT approval request, and why.
 *
 *   NODE_ENV=production node scripts/diagnostics/ot-without-approval.js \
 *     [--from 2026-09-01] [--to 2026-10-07] [--employee 945] [--date 2026-09-04]
 *
 * Every stored, FINAL day with claimable OT (candidate minus what an
 * approved shift change already authorised) and no live OT request
 * (PENDING / APPROVED / REJECTED - a CANCELLED, withdrawn one does not count),
 * classified by the SAME rule the automation raises by
 * (`utils/attendance_ot_auto_gate.js`):
 *
 *   BEFORE_CUTOVER      dated before attendance_ot_auto_pending_setting
 *   OUTSIDE_WINDOW      older than the request backdate window
 *   PAYROLL_LOCKED      the employee's month is Approved & Locked
 *   AUTOMATION_OFF      the automation is switched off / not installed
 *   AWAITING_AUTOMATIC_REQUEST  within every rule: SHOULD have a request
 *                               (an anomaly worth a look)
 *
 * With --employee/--date it also prints that day's row, every OT request on
 * it (including withdrawn ones), the automation log and any deferred marker.
 *
 * Writes nothing: see `lib/read_only_db.js`.
 */
const { openReadOnly, arg, out } = require("./lib/read_only_db");
const { explainAutoOt } = require("../../utils/attendance_ot_auto_gate");
const { MAX_BACKDATE_DAYS } = require("../../utils/shift_change_eligibility");
const { istToday } = require("../../utils/istDate");
const { addDays } = require("../../utils/attendance_engine");

const from = arg("from") || "2026-09-01";
const to = arg("to") || addDays(istToday(), -1);
const employee = arg("employee") ? Number(arg("employee")) : null;
const date = arg("date");

async function maybe(select, sql, params) {
  try {
    return await select(sql, params);
  } catch (err) {
    if (err && (err.code === "ER_NO_SUCH_TABLE" || err.code === "ER_BAD_FIELD_ERROR")) return `(${err.code})`;
    throw err;
  }
}

(async () => {
  const { select, end } = openReadOnly();
  try {
    const [setting] = await select(
      `SELECT enabled, DATE_FORMAT(auto_pending_from_date, '%Y-%m-%d') AS auto_pending_from_date, created_at
         FROM attendance_ot_auto_pending_setting WHERE setting_id = 1`,
      []
    );
    out("AUTO-OT SETTING", setting || null);

    if (employee && date) {
      out(`[${employee} ${date}] DAY ROW`, await select(
        `SELECT DATE_FORMAT(attendance_date, '%Y-%m-%d') AS attendance_date, status, is_final, punch_count,
                nrm_minutes, worked_minutes, raw_ot_minutes, candidate_ot_minutes, shift_authorised_ot_minutes,
                approved_ot_minutes, ot_request_id, review_reasons, calculation_version, calculated_at
           FROM attendance_day_calculation WHERE employee_id = ? AND attendance_date = ?`,
        [employee, date]
      ));
      out(`[${employee} ${date}] EVERY REQUEST ON THE DATE (incl. withdrawn)`, await select(
        `SELECT attendance_approval_request_id, request_type, status, auto_created, candidate_ot_minutes,
                approved_ot_minutes, closure_reason, created_at, decided_at
           FROM attendance_approval_request WHERE requested_for_employee_id = ? AND attendance_date = ?`,
        [employee, date]
      ));
      out(`[${employee} ${date}] AUTO-OT LOG`, await maybe(select,
        `SELECT * FROM attendance_ot_auto_pending_log WHERE employee_id = ? AND attendance_date = ? ORDER BY 1`,
        [employee, date]
      ));
      out(`[${employee} ${date}] DEFERRED MARKER`, await maybe(select,
        `SELECT * FROM attendance_ot_deferred_sync WHERE employee_id = ? AND attendance_date = ?`,
        [employee, date]
      ));
      out(`[${employee}] PAYROLL STATUS OF THE MONTH`, await select(
        `SELECT period_year, period_month, status FROM payrun_employee_calculation
          WHERE employee_id = ? AND period_year = ? AND period_month = ?`,
        [employee, Number(date.slice(0, 4)), Number(date.slice(5, 7))]
      ));
    }

    const rows = await select(
      `SELECT c.employee_id, ne.employee_name, DATE_FORMAT(c.attendance_date, '%Y-%m-%d') AS attendance_date,
              c.candidate_ot_minutes - COALESCE(c.shift_authorised_ot_minutes, 0) AS claimable_ot_minutes,
              EXISTS (SELECT 1 FROM payrun_employee_calculation p
                       WHERE p.employee_id = c.employee_id AND p.period_year = YEAR(c.attendance_date)
                         AND p.period_month = MONTH(c.attendance_date) AND p.status = 'APPROVED_LOCKED') AS locked,
              EXISTS (SELECT 1 FROM attendance_ot_deferred_sync m
                       WHERE m.employee_id = c.employee_id AND m.attendance_date = c.attendance_date
                         AND m.status = 'WAITING_FOR_CORRECTION') AS marker_waiting
         FROM attendance_day_calculation c
         JOIN new_employee ne ON ne.employee_id = c.employee_id
        WHERE c.attendance_date BETWEEN ? AND ?
          AND c.is_final = 1 AND c.status = 'FINAL'
          AND c.candidate_ot_minutes - COALESCE(c.shift_authorised_ot_minutes, 0) > 0
          AND (? IS NULL OR c.employee_id = ?)
          AND NOT EXISTS (SELECT 1 FROM attendance_approval_request r
                           WHERE r.requested_for_employee_id = c.employee_id
                             AND r.attendance_date = c.attendance_date
                             AND r.request_type IN ('OT', 'REGULARIZATION_WITH_OT')
                             AND r.status <> 'CANCELLED')
        ORDER BY c.attendance_date, ne.employee_name`,
      [from, to, employee, employee]
    );
    const oldest = addDays(istToday(), -MAX_BACKDATE_DAYS);
    const judged = rows.map((r) => {
      const e = explainAutoOt({
        date: r.attendance_date,
        setting,
        oldest,
        max_backdate_days: MAX_BACKDATE_DAYS,
        marker_waiting: Number(r.marker_waiting) === 1,
        locked: Number(r.locked) === 1,
      });
      return { ...r, verdict: e.reason || e.state };
    });
    const byVerdict = {};
    judged.forEach((r) => {
      const v = (byVerdict[r.verdict] = byVerdict[r.verdict] || { days: 0, minutes: 0, employees: new Set() });
      v.days += 1;
      v.minutes += Number(r.claimable_ot_minutes) || 0;
      v.employees.add(Number(r.employee_id));
    });
    out(
      `CALCULATED OT WITH NO REQUEST, ${from}..${to}`,
      Object.fromEntries(
        Object.entries(byVerdict).map(([k, v]) => [k, { days: v.days, minutes: v.minutes, employees: v.employees.size }])
      )
    );
    out("EMPLOYEES AFFECTED (distinct)", new Set(judged.map((r) => Number(r.employee_id))).size);
    out("DETAIL", judged);
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    await end();
  }
})();
