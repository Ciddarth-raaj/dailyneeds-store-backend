/**
 * Attendance PERMISSION - the DIRECT (management) grant, its revoke, the bulk
 * operation log and the Permission register.
 *
 * A REQUEST permission is written by `repository/attendance_regularization.js`
 * as the payload of a PERMISSION request; everything that is not a request
 * lives here. Both writers share `lib/attendance_permission_guard.js` (the
 * employee lock, the live-overlap check, the insert) and both write the
 * recalculated day through `writeCalculationsOnConnection` - the one writer
 * of attendance, behind the one payroll-lock gate.
 *
 * NOTHING HERE PATCHES A CALCULATED FIGURE. The usecase computes the day
 * with the change assumed, through the ordinary calculation path, and this
 * file stores that row in the same transaction as the change - or stores no
 * day at all while the attendance day is still open.
 */
const logger = require("../utils/logger");
const {
  queryAsync,
  getConnectionAsync,
  beginTransactionAsync,
  commitAsync,
  rollbackAsync,
} = require("../utils/batchInsert");
const { writeCalculationsOnConnection, assertMonthsNotPayrollLocked } = require("./attendance_calculation");
const { JOINED_ON } = require("../utils/joining_date");
const guard = require("./lib/attendance_permission_guard");
const { PERMISSION_COLUMNS, PERMISSION_FROM } = require("./lib/attendance_permission_select");

/**
 * The stored day was computed BEFORE the new row had an id (the calculation
 * runs outside this transaction and cannot see an uncommitted row). Its
 * figures are right - the engine read the window - but its `permission_ids`
 * list lacks the id the insert just produced. Add it, and nothing else.
 */
function withPermissionIds(rows, ids) {
  return (rows || []).map((row) => {
    let list = [];
    try {
      list = JSON.parse(row.permission_ids || "[]") || [];
    } catch (err) {
      list = [];
    }
    const merged = [...new Set([...list.filter((id) => id !== null), ...ids].map(Number))];
    return { ...row, permission_ids: JSON.stringify(merged) };
  });
}

class AttendancePermissionRepository {
  constructor(db) {
    this.db = db;
  }

  _log(code, err) {
    logger.Log({
      level: logger.LEVEL.ERROR,
      component: "REPOSITORY.ATTENDANCE_PERMISSION",
      code: `REPOSITORY.ATTENDANCE_PERMISSION.${code}`,
      description: err.toString(),
      category: "",
      ref: {},
    });
  }

  _read(code, sql, params) {
    return new Promise((resolve, reject) => {
      this.db.query(sql, params, (err, rows) => {
        if (err) {
          this._log(code, err);
          reject(err);
          return;
        }
        resolve(rows || []);
      });
    });
  }

  /* ============================================================ writes */

  /**
   * ONE DIRECT GRANT for one employee/date, atomically:
   *
   *   BEGIN
   *   payrun_employee_calculation ... FOR UPDATE   the payroll lock gate
   *   new_employee ... FOR UPDATE              the shared serialization point
   *   live windows overlapping these?          -> refused, nothing written
   *   INSERT attendance_permission (one per window)
   *   INSERT ... attendance_day_calculation    (a closed day only)
   *   COMMIT
   *
   * Returns `{ code: 200, attendance_permission_ids }`, or
   * `{ code: 409, reason: "OVERLAP", overlaps }`. A locked month throws the
   * gate's own `PAYROLL_MONTH_LOCKED` error and rolls back.
   */
  async grant({ employee_id, attendance_date, windows, header, calculations = [] }) {
    const connection = await getConnectionAsync(this.db);
    try {
      await beginTransactionAsync(connection);
      // LOCK ORDER, shared by every Permission write and by Approve & Lock:
      // the payroll row, then the employee, then the permission rows.
      await assertMonthsNotPayrollLocked(connection, [{ employee_id, attendance_date }]);
      await guard.lockEmployee(connection, employee_id);
      // Applicability before overlap, so the answer is the rule, not a clash.
      await guard.assertPermissionApplicable(connection, employee_id, attendance_date);
      const overlaps = await guard.findLiveOverlaps(connection, employee_id, attendance_date, windows);
      if (overlaps && overlaps.length > 0) {
        await rollbackAsync(connection);
        return { code: 409, reason: "OVERLAP", overlaps };
      }

      const ids = [];
      for (const w of windows) {
        /* eslint-disable no-await-in-loop */
        ids.push(
          await guard.insertPermission(connection, {
            ...header,
            employee_id,
            attendance_date,
            permission_from: w.permission_from,
            permission_to: w.permission_to,
            to_shift_end: w.to_shift_end,
            permission_minutes: w.permission_minutes,
            source: "DIRECT",
          })
        );
        /* eslint-enable no-await-in-loop */
      }

      let written = 0;
      if (Array.isArray(calculations) && calculations.length > 0) {
        const stored = await writeCalculationsOnConnection(connection, withPermissionIds(calculations, ids));
        written = stored.written;
      }
      await commitAsync(connection);
      return { code: 200, attendance_permission_ids: ids, calculations_written: written };
    } catch (err) {
      await rollbackAsync(connection);
      this._log("GRANT", err);
      throw err;
    } finally {
      connection.release();
    }
  }

  /**
   * REVOKE ONE DIRECT GRANT, atomically, guarded on the state the usecase
   * decided on: still DIRECT and still unrevoked. The row keeps everything it
   * had and gains who revoked it, when and why (and, for a whole bulk grant
   * being revoked, which revoke operation). The recalculated day - computed
   * without the window - commits with it.
   */
  async revoke({ attendance_permission_id, actor, reason, revoke_bulk_operation_id = null, calculations = [] }) {
    const connection = await getConnectionAsync(this.db);
    try {
      await beginTransactionAsync(connection);
      const ROW_SQL = `SELECT attendance_permission_id, employee_id, source, revoked_at,
                DATE_FORMAT(attendance_date, '%Y-%m-%d') AS attendance_date
           FROM attendance_permission
          WHERE attendance_permission_id = ?`;
      // The row's employee and date name the payroll row, which is locked
      // FIRST (the shared order); the permission row is then locked and
      // re-read. Its employee and date never change, so the two reads agree.
      const [located] = await queryAsync(connection, ROW_SQL, [attendance_permission_id]);
      if (!located) {
        await rollbackAsync(connection);
        return { code: 404, reason: "NOT_FOUND" };
      }
      await assertMonthsNotPayrollLocked(connection, [
        { employee_id: located.employee_id, attendance_date: located.attendance_date },
      ]);
      const rows = await queryAsync(connection, `${ROW_SQL} FOR UPDATE`, [attendance_permission_id]);
      const row = (rows || [])[0];
      if (!row) {
        await rollbackAsync(connection);
        return { code: 404, reason: "NOT_FOUND" };
      }
      if (row.source !== "DIRECT") {
        await rollbackAsync(connection);
        return { code: 409, reason: "NOT_DIRECT" };
      }
      if (row.revoked_at) {
        await rollbackAsync(connection);
        return { code: 409, reason: "ALREADY_REVOKED" };
      }
      const updated = await queryAsync(
        connection,
        `UPDATE attendance_permission
            SET revoked_by_employee_id = ?, revoked_by_user_id = ?,
                revoked_at = CURRENT_TIMESTAMP(3), revoke_reason = ?,
                revoke_bulk_operation_id = ?
          WHERE attendance_permission_id = ?
            AND revoked_at IS NULL`,
        [
          actor && actor.employee_id !== undefined ? actor.employee_id : null,
          actor && actor.user_id !== undefined ? actor.user_id : null,
          reason,
          revoke_bulk_operation_id,
          attendance_permission_id,
        ]
      );
      if (!updated || updated.affectedRows !== 1) {
        await rollbackAsync(connection);
        return { code: 409, reason: "STATE_CHANGED" };
      }
      let written = 0;
      if (Array.isArray(calculations) && calculations.length > 0) {
        const stored = await writeCalculationsOnConnection(connection, calculations);
        written = stored.written;
      }
      await commitAsync(connection);
      return { code: 200, calculations_written: written };
    } catch (err) {
      await rollbackAsync(connection);
      this._log("REVOKE", err);
      throw err;
    } finally {
      connection.release();
    }
  }

  /** The bulk operation header, written before any employee is granted. */
  async createBulkOperation(op) {
    await this._read(
      "CREATE-BULK-OPERATION",
      `INSERT INTO attendance_permission_bulk_operation
         (bulk_operation_id, target_mode, target_employee_ids, target_outlet_ids,
          attendance_date, from_time, to_time, to_shift_end, reason, remarks,
          preview_fingerprint, considered_count, created_by_employee_id, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        op.bulk_operation_id,
        op.target_mode,
        op.target_employee_ids ? JSON.stringify(op.target_employee_ids) : null,
        op.target_outlet_ids ? JSON.stringify(op.target_outlet_ids) : null,
        op.attendance_date,
        op.from_time,
        op.to_time || null,
        op.to_shift_end ? 1 : 0,
        op.reason,
        op.remarks || null,
        op.preview_fingerprint,
        op.considered_count || 0,
        op.created_by_employee_id === undefined ? null : op.created_by_employee_id,
        op.created_by_user_id === undefined ? null : op.created_by_user_id,
      ]
    );
  }

  /** The counts, once every employee has been attempted. */
  async finishBulkOperation(bulkOperationId, counts) {
    await this._read(
      "FINISH-BULK-OPERATION",
      `UPDATE attendance_permission_bulk_operation
          SET succeeded_count = ?, skipped_count = ?, failed_count = ?,
              completed_at = CURRENT_TIMESTAMP(3)
        WHERE bulk_operation_id = ?`,
      [counts.succeeded || 0, counts.skipped || 0, counts.failed || 0, bulkOperationId]
    );
  }

  /** One employee's outcome in a bulk grant. Append-only. */
  async recordBulkItem(item) {
    await this._read(
      "RECORD-BULK-ITEM",
      `INSERT INTO attendance_permission_bulk_item
         (bulk_operation_id, employee_id, outlet_id, outcome, code, message,
          attendance_permission_id, recalculated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        item.bulk_operation_id,
        item.employee_id,
        item.outlet_id === undefined ? null : item.outlet_id,
        item.outcome,
        item.code || null,
        item.message ? String(item.message).slice(0, 500) : null,
        item.attendance_permission_id === undefined ? null : item.attendance_permission_id,
        item.recalculated === undefined || item.recalculated === null ? null : item.recalculated ? 1 : 0,
      ]
    );
  }

  /* ============================================================= reads */

  /**
   * The candidates of a grant: employees who may have attendance on the
   * date, restricted to `store_ids` (the caller's scope, already narrowed by
   * any outlets they chose) and, when given, to `employee_ids`. The shared
   * eligibility rule (`utils/attendance_eligibility.js`) then decides each
   * one in the usecase, so this read stays a targeted query and never the
   * rule.
   */
  async listCandidates({ attendance_date, store_ids = null, employee_ids = null }) {
    const where = ["(ne.resignation_date IS NULL OR ne.resignation_date >= ?)"];
    const params = [attendance_date];
    if (Array.isArray(store_ids)) {
      if (store_ids.length === 0) return [];
      where.push("ne.store_id IN (?)");
      params.push(store_ids);
    }
    if (Array.isArray(employee_ids)) {
      if (employee_ids.length === 0) return [];
      where.push("ne.employee_id IN (?)");
      params.push(employee_ids);
    }
    return this._read(
      "LIST-CANDIDATES",
      `SELECT ne.employee_id, ne.employee_name, ne.store_id, o.outlet_name,
              ne.attendance_required, ne.status,
              DATE_FORMAT((${JOINED_ON("ne")}), '%Y-%m-%d') AS date_of_joining,
              DATE_FORMAT(ne.resignation_date, '%Y-%m-%d') AS resignation_date
         FROM new_employee ne
         LEFT JOIN outlets o ON o.outlet_id = ne.store_id
        WHERE ${where.join(" AND ")}
        ORDER BY o.outlet_name ASC, ne.employee_name ASC, ne.employee_id ASC`,
      params
    );
  }

  /** Every permission row of these employees on the date, in every state. */
  async listForEmployeesOnDate(employeeIds, attendanceDate) {
    if (!Array.isArray(employeeIds) || employeeIds.length === 0) return [];
    return this._read(
      "LIST-FOR-EMPLOYEES-ON-DATE",
      `SELECT ${PERMISSION_COLUMNS}
         ${PERMISSION_FROM}
        WHERE p.employee_id IN (?)
          AND p.attendance_date = ?`,
      [employeeIds, attendanceDate]
    );
  }

  /** One permission, with its request's state. */
  async getPermission(id) {
    const rows = await this._read(
      "GET-PERMISSION",
      `SELECT ${PERMISSION_COLUMNS}, ne.store_id AS employee_store_id
         ${PERMISSION_FROM}
         LEFT JOIN new_employee ne ON ne.employee_id = p.employee_id
        WHERE p.attendance_permission_id = ?`,
      [id]
    );
    return rows[0] || null;
  }

  /** The unrevoked DIRECT rows of a bulk grant. */
  async listActiveInBulkOperation(bulkOperationId) {
    return this._read(
      "LIST-ACTIVE-IN-BULK",
      `SELECT ${PERMISSION_COLUMNS}, ne.store_id AS employee_store_id
         ${PERMISSION_FROM}
         LEFT JOIN new_employee ne ON ne.employee_id = p.employee_id
        WHERE p.bulk_operation_id = ?
          AND p.source = 'DIRECT'
          AND p.revoked_at IS NULL
        ORDER BY p.attendance_permission_id ASC`,
      [bulkOperationId]
    );
  }

  /**
   * THE PERMISSION REGISTER. Scoped to the caller's outlets by the
   * EMPLOYEE's current outlet (`store_ids`, null = unrestricted), narrowed by
   * the filters. Names are joined for the screen; the state is derived by the
   * usecase from the request columns.
   */
  async list({
    store_ids = null,
    from_date,
    to_date,
    employee_id = null,
    source = null,
    bulk_operation_id = null,
    limit = 200,
    offset = 0,
  }) {
    const where = ["p.attendance_date BETWEEN ? AND ?"];
    const params = [from_date, to_date];
    if (Array.isArray(store_ids)) {
      if (store_ids.length === 0) return { rows: [], total: 0 };
      where.push("ne.store_id IN (?)");
      params.push(store_ids);
    }
    if (employee_id) {
      where.push("p.employee_id = ?");
      params.push(employee_id);
    }
    if (source) {
      where.push("p.source = ?");
      params.push(source);
    }
    if (bulk_operation_id) {
      where.push("p.bulk_operation_id = ?");
      params.push(bulk_operation_id);
    }
    const base = `${PERMISSION_FROM}
         LEFT JOIN new_employee ne ON ne.employee_id = p.employee_id
         LEFT JOIN outlets o ON o.outlet_id = ne.store_id
         LEFT JOIN new_employee cb ON cb.employee_id = p.created_by_employee_id
         LEFT JOIN new_employee rb ON rb.employee_id = p.revoked_by_employee_id
        WHERE ${where.join(" AND ")}`;
    const [rows, count] = await Promise.all([
      this._read(
        "LIST",
        `SELECT ${PERMISSION_COLUMNS},
                ne.employee_name, ne.store_id AS employee_store_id, o.outlet_name,
                cb.employee_name AS created_by_name, rb.employee_name AS revoked_by_name
           ${base}
          ORDER BY p.attendance_date DESC, ne.employee_name ASC, p.permission_from ASC
          LIMIT ? OFFSET ?`,
        [...params, Number(limit), Number(offset)]
      ),
      this._read("COUNT", `SELECT COUNT(*) AS total ${base}`, params),
    ]);
    return { rows, total: Number((count[0] || {}).total || 0) };
  }

  /** Bulk operations touching the caller's outlets (null = all), newest first. */
  async listBulkOperations({ store_ids = null, limit = 50 }) {
    const params = [];
    let scope = "";
    if (Array.isArray(store_ids)) {
      if (store_ids.length === 0) return [];
      scope = `WHERE EXISTS (SELECT 1 FROM attendance_permission_bulk_item i
                               WHERE i.bulk_operation_id = b.bulk_operation_id
                                 AND i.outlet_id IN (?))`;
      params.push(store_ids);
    }
    params.push(Number(limit));
    return this._read(
      "LIST-BULK-OPERATIONS",
      `SELECT b.bulk_operation_id, b.target_mode, b.target_employee_ids, b.target_outlet_ids,
              DATE_FORMAT(b.attendance_date, '%Y-%m-%d') AS attendance_date,
              TIME_FORMAT(b.from_time, '%H:%i') AS from_time,
              TIME_FORMAT(b.to_time, '%H:%i') AS to_time,
              b.to_shift_end, b.reason, b.remarks,
              b.considered_count, b.succeeded_count, b.skipped_count, b.failed_count,
              b.created_by_employee_id, cb.employee_name AS created_by_name,
              DATE_FORMAT(b.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
              DATE_FORMAT(b.completed_at, '%Y-%m-%d %H:%i:%s') AS completed_at,
              (SELECT COUNT(*) FROM attendance_permission p
                WHERE p.bulk_operation_id = b.bulk_operation_id AND p.revoked_at IS NULL) AS active_count
         FROM attendance_permission_bulk_operation b
         LEFT JOIN new_employee cb ON cb.employee_id = b.created_by_employee_id
         ${scope}
        ORDER BY b.created_at DESC
        LIMIT ?`,
      params
    );
  }

  /** One bulk operation's per-employee outcomes. */
  async listBulkItems(bulkOperationId, store_ids = null) {
    const params = [bulkOperationId];
    let scope = "";
    if (Array.isArray(store_ids)) {
      if (store_ids.length === 0) return [];
      scope = "AND i.outlet_id IN (?)";
      params.push(store_ids);
    }
    return this._read(
      "LIST-BULK-ITEMS",
      `SELECT i.employee_id, ne.employee_name, i.outlet_id, o.outlet_name, i.outcome, i.code,
              i.message, i.attendance_permission_id, i.recalculated,
              DATE_FORMAT(i.acted_at, '%Y-%m-%d %H:%i:%s') AS acted_at
         FROM attendance_permission_bulk_item i
         LEFT JOIN new_employee ne ON ne.employee_id = i.employee_id
         LEFT JOIN outlets o ON o.outlet_id = i.outlet_id
        WHERE i.bulk_operation_id = ? ${scope}
        ORDER BY i.outcome ASC, o.outlet_name ASC, ne.employee_name ASC`,
      params
    );
  }
}

module.exports = (db) => new AttendancePermissionRepository(db);
module.exports.AttendancePermissionRepository = AttendancePermissionRepository;
module.exports.withPermissionIds = withPermissionIds;
