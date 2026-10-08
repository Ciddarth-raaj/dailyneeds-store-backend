#!/usr/bin/env node
/**
 * READ-ONLY: where did an employee's APPROVED OT go between Attendance and
 * Payroll Calculation?
 *
 *   NODE_ENV=production node scripts/diagnostics/approved-ot-payroll-trace.js \
 *     --year 2026 --month 9 [--employee <id> | --name "Pavadai"]
 *
 * For the named employee it prints every stage the approved minutes pass
 * through, in order: the OT approval request, its Prior-Month OT settlement
 * (and that settlement's log), the stored day row, the stored attendance
 * month, the stored payroll calculation and its lifecycle audit.
 *
 * Then, for the WHOLE month, one line per APPROVED OT request, with the
 * minutes as each stage holds them and a verdict:
 *
 *   PAID_IN_MONTH              day, month and calculation all carry the minutes
 *   PARKED_SOURCE_REOPENED     settled forward as Prior-Month OT because the
 *                              month WAS locked at approval, but the month is
 *                              open again and no payroll has claimed it
 *   PARKED_SOURCE_LOCKED       settled forward, month still locked (expected)
 *   SETTLED_FORWARD            already INCLUDED / SETTLED in a later month
 *   DAY_ROW_MISSING_OT         the request is approved but the day row pays 0
 *   MONTH_SUMMARY_STALE        the day row pays it, the attendance month not
 *   CALCULATION_STALE          the attendance month pays it, the calculation not
 *   NOT_CALCULATED             no payroll calculation for the month yet
 *
 * Writes nothing: see `lib/read_only_db.js`.
 */
const { openReadOnly, arg, out } = require("./lib/read_only_db");

const year = Number(arg("year") || 2026);
const month = Number(arg("month") || 9);
const employeeArg = arg("employee");
const nameArg = arg("name");
if (!(Number.isInteger(year) && Number.isInteger(month) && month >= 1 && month <= 12)) {
  console.error("usage: --year <yyyy> --month <m> [--employee <id> | --name <text>]");
  process.exit(2);
}
const pad = (n) => String(n).padStart(2, "0");
const from = `${year}-${pad(month)}-01`;
const to = `${year}-${pad(month)}-${pad(new Date(Date.UTC(year, month, 0)).getUTCDate())}`;

/** A query that may hit a table this database does not have yet. */
async function maybe(select, sql, params) {
  try {
    return await select(sql, params);
  } catch (err) {
    if (err && (err.code === "ER_NO_SUCH_TABLE" || err.code === "ER_BAD_FIELD_ERROR")) return `(${err.code})`;
    throw err;
  }
}

function verdictOf(r) {
  const req = Number(r.request_approved_minutes) || 0;
  if (r.late_status) {
    if (r.late_status === "PENDING_SETTLEMENT") {
      return r.calc_status === "APPROVED_LOCKED" ? "PARKED_SOURCE_LOCKED" : "PARKED_SOURCE_REOPENED";
    }
    return "SETTLED_FORWARD";
  }
  if (r.day_approved_ot === null) return "DAY_ROW_MISSING_OT";
  if (Number(r.day_approved_ot) < req) return "DAY_ROW_MISSING_OT";
  if (r.month_approved_ot === null || Number(r.month_approved_ot) < Number(r.day_month_total)) return "MONTH_SUMMARY_STALE";
  if (r.calc_status === null) return "NOT_CALCULATED";
  if (Number(r.calc_approved_ot) !== Number(r.month_approved_ot)) return "CALCULATION_STALE";
  return "PAID_IN_MONTH";
}

(async () => {
  const { select, end } = openReadOnly();
  try {
    out("WINDOW", { year, month, from, to });

    const setting = await maybe(
      select,
      `SELECT setting_id, enabled, DATE_FORMAT(auto_pending_from_date, '%Y-%m-%d') AS auto_pending_from_date,
              created_at, updated_at
         FROM attendance_ot_auto_pending_setting`,
      []
    );
    out("AUTO-OT CUTOVER (attendance_ot_auto_pending_setting)", setting);

    let ids = [];
    if (employeeArg) ids = [Number(employeeArg)];
    else if (nameArg) {
      const found = await select(
        `SELECT employee_id, employee_name FROM new_employee WHERE employee_name LIKE ? ORDER BY employee_id`,
        [`%${nameArg}%`]
      );
      out(`EMPLOYEES MATCHING "${nameArg}"`, found);
      ids = found.map((f) => Number(f.employee_id));
    }

    for (const id of ids) {
      /* eslint-disable no-await-in-loop */
      out(`[${id}] OT APPROVAL REQUESTS IN THE MONTH`, await select(
        `SELECT attendance_approval_request_id, DATE_FORMAT(attendance_date, '%Y-%m-%d') AS attendance_date,
                request_type, status, current_stage_no, total_stages, candidate_ot_minutes,
                approved_ot_minutes, finalization_state, auto_created, closure_reason,
                created_at, decided_at
           FROM attendance_approval_request
          WHERE requested_for_employee_id = ? AND attendance_date BETWEEN ? AND ?
            AND request_type IN ('OT', 'REGULARIZATION_WITH_OT')
          ORDER BY attendance_date, attendance_approval_request_id`,
        [id, from, to]
      ));
      out(`[${id}] APPROVAL STEPS`, await select(
        `SELECT s.attendance_approval_request_id, s.stage_no, s.decision, s.approver_employee_id,
                s.approver_role, s.decided_at
           FROM attendance_approval_step s
           JOIN attendance_approval_request r ON r.attendance_approval_request_id = s.attendance_approval_request_id
          WHERE r.requested_for_employee_id = ? AND r.attendance_date BETWEEN ? AND ?
            AND r.request_type IN ('OT', 'REGULARIZATION_WITH_OT')
          ORDER BY s.attendance_approval_request_id, s.stage_no`,
        [id, from, to]
      ));
      out(`[${id}] PRIOR-MONTH OT SETTLEMENTS (source = this month)`, await maybe(select,
        `SELECT * FROM attendance_ot_late_settlement
          WHERE employee_id = ? AND source_year = ? AND source_month = ?`,
        [id, year, month]
      ));
      out(`[${id}] PRIOR-MONTH OT SETTLEMENT LOG`, await maybe(select,
        `SELECT l.* FROM attendance_ot_late_settlement_log l
           JOIN attendance_ot_late_settlement s ON s.late_settlement_id = l.late_settlement_id
          WHERE s.employee_id = ? AND s.source_year = ? AND s.source_month = ?
          ORDER BY l.late_settlement_log_id`,
        [id, year, month]
      ));
      out(`[${id}] DAY ROWS WITH OT`, await select(
        `SELECT DATE_FORMAT(attendance_date, '%Y-%m-%d') AS attendance_date, status, is_final,
                nrm_minutes, break_allowance_source, worked_minutes, raw_ot_minutes,
                candidate_ot_minutes, approved_ot_minutes, ot_request_approved_minutes,
                shift_authorised_ot_minutes, ot_request_id, calculation_version, calculated_at
           FROM attendance_day_calculation
          WHERE employee_id = ? AND attendance_date BETWEEN ? AND ?
            AND (candidate_ot_minutes > 0 OR approved_ot_minutes > 0 OR raw_ot_minutes > 0)
          ORDER BY attendance_date`,
        [id, from, to]
      ));
      out(`[${id}] ATTENDANCE MONTH`, await select(
        `SELECT attendance_monthly_payroll_id, is_final, payroll_version, held_dates,
                salary_days, extra_days, monthly_gross, daily_rate,
                approved_ot_minutes, approved_ot_earnings, calculated_at, day_rows_fingerprint
           FROM attendance_monthly_payroll
          WHERE employee_id = ? AND period_year = ? AND period_month = ?`,
        [id, year, month]
      ));
      out(`[${id}] PAYROLL CALCULATION`, await select(
        `SELECT payrun_calculation_id, status, calculation_revision, calculated_at,
                attendance_monthly_payroll_id, attendance_payroll_version, attendance_calculated_at,
                daily_rate, effective_nrm_minutes, effective_nrm_source,
                approved_ot_minutes, approved_ot_hours, ot_hourly_rate, ot_amount, ot_groups,
                prior_month_ot_amount, prior_month_ot, net_pay,
                approved_at, locked_at, published_at, unlocked_at
           FROM payrun_employee_calculation
          WHERE employee_id = ? AND period_year = ? AND period_month = ?`,
        [id, year, month]
      ));
      out(`[${id}] PAYROLL LIFECYCLE AUDIT`, await maybe(select,
        `SELECT action, previous_status, new_status, mode, net_pay, acted_at
           FROM payrun_employee_lifecycle_audit
          WHERE employee_id = ? AND period_year = ? AND period_month = ?
          ORDER BY payrun_lifecycle_audit_id`,
        [id, year, month]
      ));
      out(`[${id}] PAYROLL CALCULATION AUDIT`, await select(
        `SELECT action, calculation_revision, net_pay, changed_at
           FROM payrun_employee_calculation_audit
          WHERE employee_id = ? AND period_year = ? AND period_month = ?
          ORDER BY payrun_calculation_audit_id`,
        [id, year, month]
      ));
      /* eslint-enable no-await-in-loop */
    }

    // ======================================== the whole month, per request
    const rows = await select(
      `SELECT r.requested_for_employee_id AS employee_id, ne.employee_name,
              r.attendance_approval_request_id,
              DATE_FORMAT(r.attendance_date, '%Y-%m-%d') AS attendance_date,
              r.request_type, r.finalization_state,
              r.approved_ot_minutes AS request_approved_minutes,
              DATE_FORMAT(r.decided_at, '%Y-%m-%d %H:%i') AS decided_at,
              ls.settlement_status AS late_status, ls.settlement_year AS late_year,
              ls.settlement_month AS late_month, ls.amount AS late_amount,
              d.is_final AS day_is_final, d.approved_ot_minutes AS day_approved_ot,
              (SELECT SUM(d2.approved_ot_minutes) FROM attendance_day_calculation d2
                WHERE d2.employee_id = r.requested_for_employee_id
                  AND d2.attendance_date BETWEEN ? AND ? AND d2.is_final = 1) AS day_month_total,
              m.approved_ot_minutes AS month_approved_ot, m.is_final AS month_is_final,
              c.status AS calc_status, c.approved_ot_minutes AS calc_approved_ot,
              c.ot_amount AS calc_ot_amount
         FROM attendance_approval_request r
         JOIN new_employee ne ON ne.employee_id = r.requested_for_employee_id
         LEFT JOIN attendance_ot_late_settlement ls
                ON ls.attendance_approval_request_id = r.attendance_approval_request_id
               AND ls.settlement_status <> 'CANCELLED'
         LEFT JOIN attendance_day_calculation d
                ON d.employee_id = r.requested_for_employee_id AND d.attendance_date = r.attendance_date
         LEFT JOIN attendance_monthly_payroll m
                ON m.employee_id = r.requested_for_employee_id AND m.period_year = ? AND m.period_month = ?
         LEFT JOIN payrun_employee_calculation c
                ON c.employee_id = r.requested_for_employee_id AND c.period_year = ? AND c.period_month = ?
        WHERE r.attendance_date BETWEEN ? AND ?
          AND r.status = 'APPROVED'
          AND r.request_type IN ('OT', 'REGULARIZATION_WITH_OT')
          AND r.approved_ot_minutes > 0
        ORDER BY ne.employee_name, r.attendance_date`,
      [from, to, year, month, year, month, from, to]
    );
    const judged = rows.map((r) => ({ verdict: verdictOf(r), ...r }));
    const counts = judged.reduce((acc, r) => ({ ...acc, [r.verdict]: (acc[r.verdict] || 0) + 1 }), {});
    out("MONTH SUMMARY: APPROVED OT REQUESTS BY VERDICT", counts);
    out(
      "MONTH DETAIL: EVERY APPROVED OT REQUEST NOT PAID_IN_MONTH",
      judged.filter((r) => r.verdict !== "PAID_IN_MONTH")
    );
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    await end();
  }
})();
