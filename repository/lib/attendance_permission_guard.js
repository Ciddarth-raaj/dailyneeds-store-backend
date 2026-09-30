/**
 * PERMISSION - the statements that must run on the CALLER'S connection,
 * inside the caller's transaction.
 *
 * Shared by the two writers of `attendance_permission` - a PERMISSION request
 * being raised (`repository/attendance_regularization.js#createRequest`) and a
 * DIRECT grant (`repository/attendance_permission.js`) - and by the payrun's
 * Approve & Lock, so the same rule is never typed twice.
 */
const { queryAsync } = require("../../utils/batchInsert");
const {
  PERMISSION_CLOSURE_REASON,
  PERMISSION_CLOSURE_LABEL,
  permissionNotApplicableError,
} = require("../../utils/attendance_permission");
const { resolveAttendanceCalculationMode, isPresentAbsentOnly } = require("../../utils/attendance_calculation_mode");
const { readAttendanceModeHistoryOnConnection } = require("../attendance_calculation");

/**
 * THE SERIALIZATION POINT: the employee row, `FOR UPDATE`. The same statement
 * the one-day shift request and the HR block take (and the same text, so the
 * lock is literally the same one), which is what makes a request and a direct
 * grant for one employee queue behind each other rather than both passing an
 * overlap check that each made before the other committed.
 */
const EMPLOYEE_LOCK_SQL = `SELECT employee_id, store_id
         FROM new_employee
        WHERE employee_id = ?
        FOR UPDATE`;

async function lockEmployee(connection, employeeId) {
  const rows = await queryAsync(connection, EMPLOYEE_LOCK_SQL, [employeeId]);
  return (rows || [])[0] || null;
}

/**
 * The LIVE permission windows of an employee/date that overlap any of
 * `windows` (`[{permission_from, permission_to}]`, `YYYY-MM-DD HH:MM:SS`).
 *
 * LIVE means still able to become or stay effective: an unrevoked DIRECT
 * grant, or a REQUEST whose request is PENDING or APPROVED. A rejected,
 * cancelled or payroll-closed request, and a revoked grant, are history and
 * block nothing. Two windows that merely touch (one ends at 20:00, the next
 * starts at 20:00) do not overlap.
 */
async function findLiveOverlaps(connection, employeeId, attendanceDate, windows = []) {
  if (!Array.isArray(windows) || windows.length === 0) return [];
  const clauses = windows.map(() => "(p.permission_from < ? AND p.permission_to > ?)").join(" OR ");
  const params = [employeeId, attendanceDate];
  windows.forEach((w) => params.push(w.permission_to, w.permission_from));
  return queryAsync(
    connection,
    `SELECT p.attendance_permission_id, p.source, p.attendance_approval_request_id,
            DATE_FORMAT(p.permission_from, '%Y-%m-%d %H:%i:%s') AS permission_from,
            DATE_FORMAT(p.permission_to, '%Y-%m-%d %H:%i:%s') AS permission_to
       FROM attendance_permission p
       LEFT JOIN attendance_approval_request r
         ON r.attendance_approval_request_id = p.attendance_approval_request_id
      WHERE p.employee_id = ?
        AND p.attendance_date = ?
        AND ( (p.source = 'DIRECT' AND p.revoked_at IS NULL)
           OR (p.source = 'REQUEST' AND r.status IN ('PENDING','APPROVED')) )
        AND (${clauses})`,
    params
  );
}

/**
 * IS A PERMISSION APPLICABLE TO THIS EMPLOYEE ON THIS DATE? Throws the
 * business-rule refusal when the date's effective Attendance Calculation
 * Type is PRESENT_ABSENT_ONLY - there is no shortage for it to forgive.
 *
 * THE DATE'S OWN MODE, from the one effective-dated resolver the calculation
 * uses - never today's mode, a shift or a designation. A LOCKING read on the
 * caller's connection: every writer has already locked the employee row,
 * which is the lock a mode change (`repository/employee_attendance_mode.js`)
 * takes too, so the mode read here is the latest committed one and cannot
 * change before this transaction commits.
 *
 * Who may write a Permission is authorization, decided before this; whether
 * one applies to this employee/date is this rule, and no right bypasses it.
 */
async function assertPermissionApplicable(connection, employeeId, attendanceDate) {
  const history = await readAttendanceModeHistoryOnConnection(connection, Number(employeeId), "LOCK IN SHARE MODE");
  if (isPresentAbsentOnly(resolveAttendanceCalculationMode(history, attendanceDate))) {
    throw permissionNotApplicableError();
  }
}

/**
 * One `attendance_permission` row. EVERY writer of a new Permission - a
 * request being raised, a direct or bulk grant - comes through here, so the
 * applicability rule is enforced here, inside the writer's transaction: a
 * refusal rolls the whole write back (the request row with it).
 */
async function insertPermission(connection, row) {
  await assertPermissionApplicable(connection, row.employee_id, row.attendance_date);
  const result = await queryAsync(
    connection,
    `INSERT INTO attendance_permission
       (employee_id, attendance_date, permission_from, permission_to, to_shift_end,
        permission_minutes, reason, remarks, source, attendance_approval_request_id,
        bulk_operation_id, outlet_id, work_shift_id, created_by_employee_id, created_by_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.employee_id,
      row.attendance_date,
      row.permission_from,
      row.permission_to,
      row.to_shift_end ? 1 : 0,
      row.permission_minutes,
      row.reason,
      row.remarks === undefined ? null : row.remarks,
      row.source,
      row.attendance_approval_request_id === undefined ? null : row.attendance_approval_request_id,
      row.bulk_operation_id === undefined ? null : row.bulk_operation_id,
      row.outlet_id === undefined ? null : row.outlet_id,
      row.work_shift_id === undefined ? null : row.work_shift_id,
      row.created_by_employee_id === undefined ? null : row.created_by_employee_id,
      row.created_by_user_id === undefined ? null : row.created_by_user_id,
    ]
  );
  return result.insertId;
}

/** The wording a pending Permission closed by the payroll lock carries. */
const PERMISSION_CLOSURE = Object.freeze({
  code: PERMISSION_CLOSURE_REASON,
  label: PERMISSION_CLOSURE_LABEL,
});

/**
 * PAYROLL LOCK: close every PENDING Permission request of the employee's
 * month, on the Approve & Lock connection and inside its transaction, after
 * the payrun row is locked.
 *
 * The existing OT closure's shape exactly: the request becomes REJECTED with
 * `closure_reason = NOT_APPROVED_BEFORE_PAYROLL_LOCK`, SETTLED (nothing is
 * left to settle - it changes no attendance), and every undecided step is
 * SKIPPED with the closure wording, so the queue no longer offers it and the
 * employee's screen reads "Closed – Not approved before payroll lock".
 *
 * WHY HERE AND NOT AS A SEPARATE STEP. A pending Permission can only ever be
 * approved into an unlocked month; once the payrun row is APPROVED_LOCKED no
 * decision can pay it. Closing it in the very transaction that locks the
 * month means there is no instant at which a month is locked and a request
 * against it still claims to be pending. Nothing APPROVED, REJECTED or
 * CANCELLED is touched, and a DIRECT grant (which is never pending) is not
 * read at all. Idempotent by the status filter.
 */
async function closePendingPermissionsForLock(connection, { employee_id, year, month }) {
  const from = `${year}-${String(month).padStart(2, "0")}-01`;
  const last = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  const to = `${year}-${String(month).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
  // A LOCKING read, so it sees the latest committed rows. Approve & Lock
  // approves several employees in ONE transaction, and a plain read there
  // would answer from the snapshot taken at the first of them - missing a
  // request committed since. The range scan also locks the employee's other
  // request rows for the month; that cannot deadlock, because every writer
  // of request rows (decide, revoke, create) takes this employee's payrun
  // row FIRST - which Approve & Lock already holds - before touching them.
  const rows = await queryAsync(
    connection,
    `SELECT attendance_approval_request_id
       FROM attendance_approval_request
      WHERE requested_for_employee_id = ?
        AND attendance_date BETWEEN ? AND ?
        AND request_type = 'PERMISSION'
        AND status = 'PENDING'
      FOR UPDATE`,
    [employee_id, from, to]
  );
  const ids = (Array.isArray(rows) ? rows : []).map((r) => Number(r.attendance_approval_request_id));
  if (ids.length === 0) return { closed: 0, request_ids: [] };
  await queryAsync(
    connection,
    `UPDATE attendance_approval_request
        SET status = 'REJECTED',
            finalization_state = 'SETTLED',
            closure_reason = ?,
            decided_at = CURRENT_TIMESTAMP(3)
      WHERE attendance_approval_request_id IN (?)
        AND status = 'PENDING'`,
    [PERMISSION_CLOSURE.code, ids]
  );
  await queryAsync(
    connection,
    `UPDATE attendance_approval_step
        SET decision = 'SKIPPED', remarks = ?, decided_at = CURRENT_TIMESTAMP(3)
      WHERE attendance_approval_request_id IN (?)
        AND decision = 'PENDING'`,
    [PERMISSION_CLOSURE.label, ids]
  );
  return { closed: ids.length, request_ids: ids };
}

module.exports = {
  EMPLOYEE_LOCK_SQL,
  PERMISSION_CLOSURE,
  lockEmployee,
  findLiveOverlaps,
  insertPermission,
  assertPermissionApplicable,
  closePendingPermissionsForLock,
};
