/**
 * The ONE SELECT of `attendance_permission` rows every reader uses - the
 * calculation, the dashboard and the Permission register - so a row carries
 * the same fields, formatted the same way, wherever it is read.
 *
 * The request columns come from a LEFT JOIN: a DIRECT grant has no request,
 * and a REQUEST permission's state is its request's state
 * (`utils/attendance_permission.js#permissionState`). No bare DATE or
 * DATETIME leaves the database: every one goes through DATE_FORMAT, because
 * the pool sets no `dateStrings` and a JS Date built at local midnight would
 * move a day in UTC.
 */
const PERMISSION_COLUMNS = `
  p.attendance_permission_id,
  p.employee_id,
  DATE_FORMAT(p.attendance_date, '%Y-%m-%d')           AS attendance_date,
  DATE_FORMAT(p.permission_from, '%Y-%m-%d %H:%i:%s')  AS permission_from,
  DATE_FORMAT(p.permission_to, '%Y-%m-%d %H:%i:%s')    AS permission_to,
  p.to_shift_end,
  p.permission_minutes,
  p.reason,
  p.remarks,
  p.source,
  p.attendance_approval_request_id,
  p.bulk_operation_id,
  p.outlet_id,
  p.work_shift_id,
  p.created_by_employee_id,
  p.created_by_user_id,
  DATE_FORMAT(p.created_at, '%Y-%m-%d %H:%i:%s')       AS created_at,
  p.revoked_by_employee_id,
  p.revoked_by_user_id,
  DATE_FORMAT(p.revoked_at, '%Y-%m-%d %H:%i:%s')       AS revoked_at,
  p.revoke_reason,
  p.revoke_bulk_operation_id,
  r.status              AS request_status,
  r.finalization_state  AS finalization_state,
  r.closure_reason      AS closure_reason,
  r.current_stage_no    AS request_stage_no,
  r.total_stages        AS request_total_stages`;

const PERMISSION_FROM = `
  FROM attendance_permission p
  LEFT JOIN attendance_approval_request r
    ON r.attendance_approval_request_id = p.attendance_approval_request_id`;

module.exports = { PERMISSION_COLUMNS, PERMISSION_FROM };
