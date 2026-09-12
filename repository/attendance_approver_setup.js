const logger = require("../utils/logger");
const {
  queryAsync,
  getConnectionAsync,
  beginTransactionAsync,
  commitAsync,
  rollbackAsync,
} = require("../utils/batchInsert");

/**
 * Attendance Approver Setup - the store for the EMPLOYEE-LEVEL chain.
 *
 * ONE ROW PER EMPLOYEE in `attendance_approver_setup`, holding employee IDS
 * only; names come from `new_employee` at read time and are never written
 * here. EVERY change appends to `attendance_approver_setup_audit` in the same
 * transaction as the change; nothing in this file UPDATEs or DELETEs an audit
 * row.
 *
 * THE REPLACE writes three things together or not at all: the master rows
 * that name the old approver at that level, the UNDECIDED steps of PENDING
 * requests that name them at that level, and one audit row per row touched.
 * A step already APPROVED, REJECTED or SKIPPED, and every step of a request
 * that is no longer PENDING, is excluded in SQL - the WHERE clause is the
 * guarantee, not a check in a loop.
 *
 * NOTHING HERE TOUCHES `biomax_punch`, salary, or payroll.
 */

const LEVEL_COLUMN = Object.freeze({
  FIRST: "first_level_approver_employee_id",
  SECOND: "second_level_approver_employee_id",
  FINAL: "final_approver_employee_id",
});

/** Only the columns a screen needs: no contact, bank, statutory or salary field. */
const EMPLOYEE_COLUMNS = `ne.employee_id, ne.employee_name, ne.status,
              ne.store_id, o.outlet_name AS store_name,
              ne.designation_id, d.designation_name,
              ne.department_id, dp.department_name`;
const EMPLOYEE_JOINS = `FROM new_employee ne
         LEFT JOIN outlets o ON o.outlet_id = ne.store_id
         LEFT JOIN designation d ON d.designation_id = ne.designation_id
         LEFT JOIN department dp ON dp.department_id = ne.department_id`;

class AttendanceApproverSetupRepository {
  constructor(db) {
    this.db = db;
  }

  _log(code, err, ref = {}) {
    logger.Log({
      level: logger.LEVEL.ERROR,
      component: "REPOSITORY.ATTENDANCE_APPROVER_SETUP",
      code: `REPOSITORY.ATTENDANCE_APPROVER_SETUP.${code}`,
      description: err.toString(),
      category: "",
      ref,
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

  /* ------------------------------------------------------- employees */

  /**
   * The employees the setup screen lists, with their mapping (if any) and
   * the approver names resolved. Filters combine freely. ACTIVE employees
   * only: a resigned employee raises no request, so listing them here would
   * only invite mappings nobody can use. `search` matches the code or the
   * name.
   */
  _listWhere({ department_id, store_id, designation_id, employee_id, search }) {
    const where = ["ne.status = 1"];
    const params = [];
    if (department_id) { where.push("ne.department_id = ?"); params.push(department_id); }
    if (store_id) { where.push("ne.store_id = ?"); params.push(store_id); }
    if (designation_id) { where.push("ne.designation_id = ?"); params.push(designation_id); }
    if (employee_id) { where.push("ne.employee_id = ?"); params.push(employee_id); }
    if (search && String(search).trim() !== "") {
      const term = `%${String(search).trim()}%`;
      where.push("(ne.employee_name LIKE ? OR CAST(ne.employee_id AS CHAR) LIKE ?)");
      params.push(term, term);
    }
    return { where: where.join(" AND "), params };
  }

  async listEmployeesWithSetup(filters) {
    const { where, params } = this._listWhere(filters);
    const limit = Number(filters.limit) > 0 ? Number(filters.limit) : 200;
    const offset = Number(filters.offset) > 0 ? Number(filters.offset) : 0;
    return this._read(
      "LIST-EMPLOYEES-WITH-SETUP",
      `SELECT ${EMPLOYEE_COLUMNS},
              s.attendance_approver_setup_id, s.is_active AS setup_is_active,
              s.first_level_approver_employee_id,  a1.employee_name AS first_level_approver_name,  a1.status AS first_level_approver_status,
              s.second_level_approver_employee_id, a2.employee_name AS second_level_approver_name, a2.status AS second_level_approver_status,
              s.final_approver_employee_id,        a3.employee_name AS final_approver_name,        a3.status AS final_approver_status,
              DATE_FORMAT(s.updated_at, '%Y-%m-%d %H:%i:%s') AS setup_updated_at
         ${EMPLOYEE_JOINS}
         LEFT JOIN attendance_approver_setup s ON s.employee_id = ne.employee_id AND s.is_active = 1
         LEFT JOIN new_employee a1 ON a1.employee_id = s.first_level_approver_employee_id
         LEFT JOIN new_employee a2 ON a2.employee_id = s.second_level_approver_employee_id
         LEFT JOIN new_employee a3 ON a3.employee_id = s.final_approver_employee_id
        WHERE ${where}
        ORDER BY ne.employee_name ASC, ne.employee_id ASC
        LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
  }

  async countEmployeesWithSetup(filters) {
    const { where, params } = this._listWhere(filters);
    const rows = await this._read(
      "COUNT-EMPLOYEES-WITH-SETUP",
      `SELECT COUNT(*) AS n ${EMPLOYEE_JOINS} WHERE ${where}`,
      params
    );
    return rows && rows[0] ? Number(rows[0].n) : 0;
  }

  /** The employees named in `ids`, with the two facts validation needs. */
  async getEmployeesByIds(ids) {
    const list = [...new Set((ids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (list.length === 0) return [];
    return this._read(
      "GET-EMPLOYEES-BY-IDS",
      `SELECT ${EMPLOYEE_COLUMNS} ${EMPLOYEE_JOINS} WHERE ne.employee_id IN (?)`,
      [list]
    );
  }

  /**
   * The approver picker. Active employees by default; `include_inactive`
   * adds resigned people, which the Replace Approver's CURRENT-approver
   * search needs precisely because its purpose is to remove them.
   */
  async listApproverOptions({ include_inactive = false, search = null, limit = 1000 } = {}) {
    const where = [];
    const params = [];
    if (!include_inactive) where.push("ne.status = 1");
    if (search && String(search).trim() !== "") {
      const term = `%${String(search).trim()}%`;
      where.push("(ne.employee_name LIKE ? OR CAST(ne.employee_id AS CHAR) LIKE ?)");
      params.push(term, term);
    }
    return this._read(
      "LIST-APPROVER-OPTIONS",
      `SELECT ${EMPLOYEE_COLUMNS} ${EMPLOYEE_JOINS}
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY ne.status DESC, ne.employee_name ASC, ne.employee_id ASC
        LIMIT ?`,
      [...params, Number(limit) > 0 ? Number(limit) : 1000]
    );
  }

  /**
   * Everybody who is CURRENTLY an approver somewhere - on a master row or on
   * an undecided pending step - active or not. What the Replace Approver
   * offers as "Current Approver".
   */
  async listCurrentApprovers() {
    return this._read(
      "LIST-CURRENT-APPROVERS",
      `SELECT ${EMPLOYEE_COLUMNS},
              SUM(x.level = 'FIRST')  AS first_level_count,
              SUM(x.level = 'SECOND') AS second_level_count,
              SUM(x.level = 'FINAL')  AS final_count,
              SUM(x.pending_steps)    AS pending_step_count
         FROM (
              SELECT first_level_approver_employee_id AS approver_id, 'FIRST' AS level, 0 AS pending_steps
                FROM attendance_approver_setup WHERE is_active = 1 AND first_level_approver_employee_id IS NOT NULL
              UNION ALL
              SELECT second_level_approver_employee_id, 'SECOND', 0
                FROM attendance_approver_setup WHERE is_active = 1 AND second_level_approver_employee_id IS NOT NULL
              UNION ALL
              SELECT final_approver_employee_id, 'FINAL', 0
                FROM attendance_approver_setup WHERE is_active = 1
              UNION ALL
              SELECT st.approver_employee_id, st.approval_level, 1
                FROM attendance_approval_step st
                JOIN attendance_approval_request r ON r.attendance_approval_request_id = st.attendance_approval_request_id
               WHERE r.status = 'PENDING' AND st.decision = 'PENDING' AND st.approver_employee_id IS NOT NULL
         ) x
         JOIN new_employee ne ON ne.employee_id = x.approver_id
         LEFT JOIN outlets o ON o.outlet_id = ne.store_id
         LEFT JOIN designation d ON d.designation_id = ne.designation_id
         LEFT JOIN department dp ON dp.department_id = ne.department_id
        GROUP BY ne.employee_id
        ORDER BY ne.status DESC, ne.employee_name ASC`
    );
  }

  /* --------------------------------------------------------- setup */

  /** One employee's mapping, active or not; null when none exists. */
  async getSetup(employeeId) {
    const rows = await this._read(
      "GET-SETUP",
      `SELECT s.attendance_approver_setup_id, s.employee_id,
              s.first_level_approver_employee_id,  a1.employee_name AS first_level_approver_name,  a1.status AS first_level_approver_status,
              s.second_level_approver_employee_id, a2.employee_name AS second_level_approver_name, a2.status AS second_level_approver_status,
              s.final_approver_employee_id,        a3.employee_name AS final_approver_name,        a3.status AS final_approver_status,
              s.is_active, s.created_by, s.updated_by,
              DATE_FORMAT(s.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
              DATE_FORMAT(s.updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at
         FROM attendance_approver_setup s
         LEFT JOIN new_employee a1 ON a1.employee_id = s.first_level_approver_employee_id
         LEFT JOIN new_employee a2 ON a2.employee_id = s.second_level_approver_employee_id
         LEFT JOIN new_employee a3 ON a3.employee_id = s.final_approver_employee_id
        WHERE s.employee_id = ?`,
      [employeeId]
    );
    return rows && rows[0] ? rows[0] : null;
  }

  /**
   * The ACTIVE mapping for chain resolution at request creation. Ids only,
   * which is all a snapshot needs. Null means "use the role chain".
   */
  async getActiveSetup(employeeId) {
    const rows = await this._read(
      "GET-ACTIVE-SETUP",
      `SELECT employee_id, first_level_approver_employee_id,
              second_level_approver_employee_id, final_approver_employee_id
         FROM attendance_approver_setup
        WHERE employee_id = ? AND is_active = 1`,
      [employeeId]
    );
    return rows && rows[0] ? rows[0] : null;
  }

  /**
   * Insert or update ONE employee's mapping and append its audit rows, in
   * one transaction. `audit` is the per-level list of changes the usecase
   * computed against the previous row; an empty list writes the row and
   * nothing else (nothing changed).
   */
  async saveSetup({ setup, action_type, actor_employee_id, audit }) {
    const connection = await getConnectionAsync(this.db);
    try {
      await beginTransactionAsync(connection);
      await queryAsync(
        connection,
        `INSERT INTO attendance_approver_setup
           (employee_id, first_level_approver_employee_id, second_level_approver_employee_id,
            final_approver_employee_id, is_active, created_by, updated_by)
         VALUES (?, ?, ?, ?, 1, ?, ?)
         ON DUPLICATE KEY UPDATE
            first_level_approver_employee_id  = VALUES(first_level_approver_employee_id),
            second_level_approver_employee_id = VALUES(second_level_approver_employee_id),
            final_approver_employee_id        = VALUES(final_approver_employee_id),
            is_active = 1,
            updated_by = VALUES(updated_by)`,
        [
          setup.employee_id,
          setup.first_level_approver_employee_id,
          setup.second_level_approver_employee_id,
          setup.final_approver_employee_id,
          actor_employee_id === undefined ? null : actor_employee_id,
          actor_employee_id === undefined ? null : actor_employee_id,
        ]
      );
      if (Array.isArray(audit) && audit.length > 0) {
        await queryAsync(
          connection,
          `INSERT INTO attendance_approver_setup_audit
             (employee_id, approval_level, old_approver_employee_id, new_approver_employee_id,
              action_type, changed_by)
           VALUES ?`,
          [
            audit.map((a) => [
              setup.employee_id,
              a.approval_level,
              a.old_approver_employee_id === undefined ? null : a.old_approver_employee_id,
              a.new_approver_employee_id === undefined ? null : a.new_approver_employee_id,
              action_type,
              actor_employee_id === undefined ? null : actor_employee_id,
            ]),
          ]
        );
      }
      await commitAsync(connection);
      return { code: 200, employee_id: setup.employee_id, audit_rows: (audit || []).length };
    } catch (err) {
      await rollbackAsync(connection);
      this._log("SAVE-SETUP", err);
      throw err;
    } finally {
      connection.release();
    }
  }

  /* ------------------------------------------------------- replace */

  /** Master rows naming `approverId` at `level`. */
  async findSetupsWithApprover(level, approverId) {
    const column = LEVEL_COLUMN[level];
    if (!column) throw new Error(`Unknown approval level: ${level}`);
    return this._read(
      "FIND-SETUPS-WITH-APPROVER",
      `SELECT employee_id, first_level_approver_employee_id,
              second_level_approver_employee_id, final_approver_employee_id
         FROM attendance_approver_setup
        WHERE is_active = 1 AND \`${column}\` = ?
        ORDER BY employee_id ASC`,
      [approverId]
    );
  }

  /**
   * The UNDECIDED steps of PENDING requests assigned to `approverId` at
   * `level`, with whose request each is and who the request's OTHER stages
   * name, so the usecase can refuse the self-approval and duplicate-approver
   * cases before anything is written.
   */
  async findPendingStepsWithApprover(level, approverId) {
    return this._read(
      "FIND-PENDING-STEPS-WITH-APPROVER",
      `SELECT s.attendance_approval_step_id, s.attendance_approval_request_id, s.stage_no,
              s.approval_level, s.approver_employee_id,
              r.request_type, r.requested_for_employee_id, r.requested_by_employee_id,
              r.current_stage_no,
              (SELECT GROUP_CONCAT(o.approver_employee_id)
                 FROM attendance_approval_step o
                WHERE o.attendance_approval_request_id = s.attendance_approval_request_id
                  AND o.attendance_approval_step_id <> s.attendance_approval_step_id) AS other_approver_ids
         FROM attendance_approval_step s
         JOIN attendance_approval_request r
           ON r.attendance_approval_request_id = s.attendance_approval_request_id
        WHERE r.status = 'PENDING'
          AND s.decision = 'PENDING'
          AND s.approver_employee_id = ?
          AND s.approval_level = ?
          AND r.request_type IN ('REGULARIZATION','OT')
        ORDER BY s.attendance_approval_request_id ASC, s.stage_no ASC`,
      [approverId, level]
    );
  }

  /**
   * REPLACE, atomically: the named master rows move to the new approver, the
   * named undecided pending steps move to the new approver, and one audit
   * row is appended per master row and per step. Every UPDATE is guarded on
   * the state it expects - the master row still naming the old approver, the
   * step still PENDING on a PENDING request and still naming the old
   * approver - so a decision taken in between cannot be overwritten.
   */
  async replaceApprover({ level, old_approver_employee_id, new_approver_employee_id, setup_employee_ids, step_ids, actor_employee_id }) {
    const column = LEVEL_COLUMN[level];
    if (!column) throw new Error(`Unknown approval level: ${level}`);
    const connection = await getConnectionAsync(this.db);
    try {
      await beginTransactionAsync(connection);
      const actor = actor_employee_id === undefined ? null : actor_employee_id;
      let setupsUpdated = 0;
      let stepsUpdated = 0;

      if (Array.isArray(setup_employee_ids) && setup_employee_ids.length > 0) {
        const result = await queryAsync(
          connection,
          `UPDATE attendance_approver_setup
              SET \`${column}\` = ?, updated_by = ?
            WHERE is_active = 1
              AND employee_id IN (?)
              AND \`${column}\` = ?`,
          [new_approver_employee_id, actor, setup_employee_ids, old_approver_employee_id]
        );
        setupsUpdated = result ? Number(result.affectedRows) || 0 : 0;
        await queryAsync(
          connection,
          `INSERT INTO attendance_approver_setup_audit
             (employee_id, approval_level, old_approver_employee_id, new_approver_employee_id,
              action_type, changed_by)
           VALUES ?`,
          [setup_employee_ids.map((id) => [id, level, old_approver_employee_id, new_approver_employee_id, "REPLACE", actor])]
        );
      }

      if (Array.isArray(step_ids) && step_ids.length > 0) {
        // Which steps are actually still reassignable, read under lock so the
        // audit names exactly the rows the UPDATE moves.
        const live = await queryAsync(
          connection,
          `SELECT s.attendance_approval_step_id, s.attendance_approval_request_id,
                  r.requested_for_employee_id
             FROM attendance_approval_step s
             JOIN attendance_approval_request r
               ON r.attendance_approval_request_id = s.attendance_approval_request_id
            WHERE s.attendance_approval_step_id IN (?)
              AND r.status = 'PENDING'
              AND s.decision = 'PENDING'
              AND s.approver_employee_id = ?
              AND s.approval_level = ?
            FOR UPDATE`,
          [step_ids, old_approver_employee_id, level]
        );
        const liveIds = (live || []).map((s) => Number(s.attendance_approval_step_id));
        if (liveIds.length > 0) {
          const result = await queryAsync(
            connection,
            `UPDATE attendance_approval_step
                SET approver_employee_id = ?
              WHERE attendance_approval_step_id IN (?)
                AND decision = 'PENDING'
                AND approver_employee_id = ?`,
            [new_approver_employee_id, liveIds, old_approver_employee_id]
          );
          stepsUpdated = result ? Number(result.affectedRows) || 0 : 0;
          await queryAsync(
            connection,
            `INSERT INTO attendance_approver_setup_audit
               (employee_id, approval_level, old_approver_employee_id, new_approver_employee_id,
                action_type, attendance_approval_request_id, attendance_approval_step_id, changed_by)
             VALUES ?`,
            [
              live.map((s) => [
                s.requested_for_employee_id,
                level,
                old_approver_employee_id,
                new_approver_employee_id,
                "REPLACE",
                s.attendance_approval_request_id,
                s.attendance_approval_step_id,
                actor,
              ]),
            ]
          );
        }
      }

      await commitAsync(connection);
      return { code: 200, setups_updated: setupsUpdated, pending_steps_updated: stepsUpdated };
    } catch (err) {
      await rollbackAsync(connection);
      this._log("REPLACE-APPROVER", err);
      throw err;
    } finally {
      connection.release();
    }
  }

  /* --------------------------------------------------------- audit */

  async listAudit({ employee_id = null, approver_employee_id = null, limit = 100 } = {}) {
    const where = [];
    const params = [];
    if (employee_id) { where.push("a.employee_id = ?"); params.push(employee_id); }
    if (approver_employee_id) {
      where.push("(a.old_approver_employee_id = ? OR a.new_approver_employee_id = ?)");
      params.push(approver_employee_id, approver_employee_id);
    }
    return this._read(
      "LIST-AUDIT",
      `SELECT a.attendance_approver_setup_audit_id, a.employee_id, e.employee_name,
              a.approval_level, a.action_type,
              a.old_approver_employee_id, oa.employee_name AS old_approver_name,
              a.new_approver_employee_id, na.employee_name AS new_approver_name,
              a.attendance_approval_request_id, a.attendance_approval_step_id,
              a.changed_by, cb.employee_name AS changed_by_name,
              DATE_FORMAT(a.changed_at, '%Y-%m-%d %H:%i:%s') AS changed_at
         FROM attendance_approver_setup_audit a
         LEFT JOIN new_employee e  ON e.employee_id  = a.employee_id
         LEFT JOIN new_employee oa ON oa.employee_id = a.old_approver_employee_id
         LEFT JOIN new_employee na ON na.employee_id = a.new_approver_employee_id
         LEFT JOIN new_employee cb ON cb.employee_id = a.changed_by
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY a.attendance_approver_setup_audit_id DESC
        LIMIT ?`,
      [...params, Number(limit) > 0 ? Number(limit) : 100]
    );
  }
}

module.exports = (db) => new AttendanceApproverSetupRepository(db);
module.exports.AttendanceApproverSetupRepository = AttendanceApproverSetupRepository;
module.exports.LEVEL_COLUMN = LEVEL_COLUMN;
