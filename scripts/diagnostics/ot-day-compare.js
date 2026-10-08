#!/usr/bin/env node
/**
 * READ-ONLY: one employee's day, STORED vs what the CURRENT engine calculates,
 * and every OT request on it with how each ended.
 *
 *   NODE_ENV=production node scripts/diagnostics/ot-day-compare.js --employee 945 --date 2026-09-04
 *
 * Answers "why does Attendance show OT the Historical OT Review says is not
 * eligible?" (a day stored under an older rule - e.g. the 7 Oct rule that an
 * unused lunch is never OT - and never recalculated) and "why was this OT
 * withdrawn?" (the automation's log, an administrator's revocation).
 *
 * Writes nothing: see `lib/read_only_db.js`. The live figures are the
 * engine's in-memory answer; nothing is stored.
 */
const { openReadOnly, arg, out } = require("./lib/read_only_db");

const employeeId = Number(arg("employee"));
const date = arg("date");
if (!(Number.isInteger(employeeId) && employeeId > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(date || "")) {
  console.error("usage: --employee <id> --date YYYY-MM-DD");
  process.exit(2);
}

const FIELDS = [
  "status", "is_final", "punch_count", "nrm_minutes", "span_minutes", "break_allowance_minutes", "actual_gap_minutes",
  "break_charged_minutes", "worked_minutes", "pre_shift_minutes", "post_shift_minutes", "raw_ot_minutes",
  "candidate_ot_minutes", "shift_authorised_ot_minutes", "approved_ot_minutes", "calculation_version",
];

(async () => {
  const { db, select, end } = openReadOnly();
  try {
    const calcRepo = require("../../repository/attendance_calculation")(db);
    const calculation = require("../../usecase/attendance_calculation")(calcRepo);
    const [stored] = await select(
      `SELECT ${FIELDS.join(", ")}, effective_punches, DATE_FORMAT(calculated_at, '%Y-%m-%d %H:%i:%s') AS calculated_at
         FROM attendance_day_calculation WHERE employee_id = ? AND attendance_date = ?`,
      [employeeId, date]
    );
    const [live] = await calculation.calculateRange({ employee_id: employeeId, from_date: date, to_date: date });
    const compare = {};
    FIELDS.forEach((f) => {
      const s = stored ? stored[f] : null;
      const l = live ? live[f] : null;
      compare[f] = { stored: s === undefined ? null : s, current_engine: l === undefined ? null : l, differs: String(s) !== String(l) };
    });
    out(`[${employeeId} ${date}] STORED (calculated ${stored ? stored.calculated_at : "never"}) vs CURRENT ENGINE`, compare);
    out("EFFECTIVE PUNCHES (current engine)", live ? (live.effective_punches || []).map((p) => p.io_time || p) : null);
    const fourPunchLunch =
      live && Number(live.punch_count) >= 4 && Number(live.actual_gap_minutes) < Number(live.break_allowance_minutes);
    out("VERDICT", {
      stored_ot: stored ? Number(stored.candidate_ot_minutes) : null,
      current_ot: live ? Number(live.candidate_ot_minutes) : null,
      short_lunch_on_four_plus_punches: Boolean(fourPunchLunch),
      reading: !stored
        ? "No stored row."
        : Number(stored.candidate_ot_minutes) === Number(live && live.candidate_ot_minutes)
        ? "Stored and current agree."
        : fourPunchLunch
        ? "The stored OT includes unused lunch minutes; since 7 Oct an unused lunch is never OT (the whole permitted break is reserved). The stored row predates the rule and was not recalculated."
        : "Stored and current differ - compare the fields above (shift, punches, break) to see which input moved.",
    });
    out(`[${employeeId} ${date}] OT REQUESTS ON THE DATE`, await select(
      `SELECT r.attendance_approval_request_id AS id, r.request_type, r.status, r.auto_created, r.candidate_ot_minutes,
              r.approved_ot_minutes, r.closure_reason, r.reason,
              DATE_FORMAT(r.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
              DATE_FORMAT(r.decided_at, '%Y-%m-%d %H:%i:%s') AS decided_at,
              EXISTS (SELECT 1 FROM attendance_approval_revocation v WHERE v.attendance_approval_request_id = r.attendance_approval_request_id) AS revoked
         FROM attendance_approval_request r
        WHERE r.requested_for_employee_id = ? AND r.attendance_date = ? ORDER BY r.attendance_approval_request_id`,
      [employeeId, date]
    ));
    out("AUTOMATION LOG (created / minutes changed / withdrawn, with what triggered it)", await select(
      `SELECT attendance_approval_request_id AS id, action, previous_ot_minutes, new_ot_minutes, trigger_source,
              DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS at
         FROM attendance_ot_auto_pending_log WHERE employee_id = ? AND attendance_date = ? ORDER BY 1, at`,
      [employeeId, date]
    ));
    out("WITHDRAWAL / SKIP REMARKS ON THE STEPS", await select(
      `SELECT s.attendance_approval_request_id AS id, s.stage_no, s.decision, s.remarks
         FROM attendance_approval_step s JOIN attendance_approval_request r ON r.attendance_approval_request_id = s.attendance_approval_request_id
        WHERE r.requested_for_employee_id = ? AND r.attendance_date = ? AND s.decision IN ('SKIPPED', 'REJECTED')`,
      [employeeId, date]
    ));
    out("DEFERRED MARKER", await select(
      `SELECT deferred_sync_id, status, source, reason, resolution FROM attendance_ot_deferred_sync WHERE employee_id = ? AND attendance_date = ?`,
      [employeeId, date]
    ));
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    await end();
  }
})();
