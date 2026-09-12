const logger = require("../utils/logger");
const {
  queryAsync,
  getConnectionAsync,
  beginTransactionAsync,
  commitAsync,
  rollbackAsync,
} = require("../utils/batchInsert");
const { writeCalculationsOnConnection } = require("./attendance_calculation");

/**
 * Attendance v2 / A3 - the regularization and OT approval store.
 *
 * THE RAW PUNCH IS NEVER TOUCHED. There is no UPDATE or DELETE of
 * `biomax_punch` in this file, and no statement that could produce one. The
 * approved manual punch is a row in `attendance_regularized_punch`, and it is
 * written when the request is raised but is invisible to the calculation until
 * the request reaches APPROVED - the calculation's own query joins on that
 * status (see `repository/attendance_calculation.js`).
 *
 * EVERY WRITE THAT CHANGES A DECISION IS TRANSACTIONAL. Creating a request
 * writes the request, its whole chain of steps and its punch together or not
 * at all; deciding a stage stamps the step and moves the request together or
 * not at all. A half-created request would be a chain nobody could finish.
 *
 * THE DECISION AND THE RECALCULATED DAY MOVE TOGETHER (review fix #4). A final
 * approval is what makes a regularized punch effective and turns candidate
 * overtime into payable overtime, so the recalculated
 * `attendance_day_calculation` row is written INSIDE the same transaction that
 * records the decision - `decideStage` takes the already-computed rows and
 * hands them to `writeCalculationsOnConnection` on its own connection. The
 * first implementation committed the approval and then recalculated
 * afterwards, which left a window in which a request was APPROVED - and its OT
 * therefore payable - while the stored day still said otherwise. There is now
 * no such window: if the day cannot be stored, the approval does not happen.
 */

class AttendanceRegularizationRepository {
  constructor(db) {
    this.db = db;
  }

  _log(code, err, ref = {}) {
    logger.Log({
      level: logger.LEVEL.ERROR,
      component: "REPOSITORY.ATTENDANCE_REGULARIZATION",
      code: `REPOSITORY.ATTENDANCE_REGULARIZATION.${code}`,
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

  /**
   * The facts about a person that decide which chain their request follows and
   * which stages they may decide.
   *
   * `requester_class` and `approver_role` both come from the designation
   * mapping, and an unmapped designation returns null for both rather than a
   * guess - the usecase then applies the documented conservative default for
   * the class, and no approver role at all.
   */
  async getApprovalIdentity(employeeId) {
    const rows = await this._read(
      "GET-APPROVAL-IDENTITY",
      `SELECT ne.employee_id,
              ne.employee_name,
              ne.store_id      AS outlet_id,
              ne.designation_id,
              d.designation_name,
              r.approver_role,
              r.requester_class
         FROM new_employee ne
         LEFT JOIN designation d ON d.designation_id = ne.designation_id
         LEFT JOIN attendance_approval_role r ON r.designation_id = ne.designation_id
        WHERE ne.employee_id = ?`,
      [employeeId]
    );
    return rows && rows[0] ? rows[0] : null;
  }

  /** One request with its ordered steps and its punch, for a decision. */
  async getRequest(requestId) {
    const rows = await this._read(
      "GET-REQUEST",
      `SELECT attendance_approval_request_id, request_type,
              requested_for_employee_id, requested_by_employee_id,
              DATE_FORMAT(attendance_date, '%Y-%m-%d') AS attendance_date,
              outlet_id, requester_class, reason,
              candidate_ot_minutes, approved_ot_minutes,
              status, current_stage_no, total_stages,
              finalization_state, auto_created
         FROM attendance_approval_request
        WHERE attendance_approval_request_id = ?`,
      [requestId]
    );
    const request = rows && rows[0] ? rows[0] : null;
    if (!request) return null;

    const steps = await this._read(
      "GET-REQUEST-STEPS",
      `SELECT attendance_approval_step_id, stage_no, approver_role, outlet_id,
              decision, decided_by_employee_id,
              DATE_FORMAT(decided_at, '%Y-%m-%d %H:%i:%s') AS decided_at,
              remarks, acted_as_admin_override
         FROM attendance_approval_step
        WHERE attendance_approval_request_id = ?
        ORDER BY stage_no ASC`,
      [requestId]
    );

    const punches = await this._read(
      "GET-REQUEST-PUNCH",
      `SELECT attendance_regularized_punch_id,
              DATE_FORMAT(punch_time, '%Y-%m-%d %H:%i:%s') AS punch_time,
              punch_source
         FROM attendance_regularized_punch
        WHERE attendance_approval_request_id = ?`,
      [requestId]
    );

    return { ...request, steps, regularized_punch: punches[0] || null };
  }

  /** Is there already an open request for this employee and date? */
  async findOpenRequest(employeeId, attendanceDate) {
    const rows = await this._read(
      "FIND-OPEN-REQUEST",
      `SELECT attendance_approval_request_id, request_type, status, current_stage_no,
              candidate_ot_minutes, auto_created
         FROM attendance_approval_request
        WHERE requested_for_employee_id = ?
          AND attendance_date = ?
          AND status = 'PENDING'`,
      [employeeId, attendanceDate]
    );
    return rows && rows[0] ? rows[0] : null;
  }

  /**
   * Every request on these dates, in any state but CANCELLED: what
   * `raiseOtRequest` checks so that one date carries one OT claim, open or
   * decided.
   */
  async findRequestsForDates(employeeId, dates) {
    if (!Array.isArray(dates) || dates.length === 0) return [];
    return this._read(
      "FIND-REQUESTS-FOR-DATES",
      `SELECT attendance_approval_request_id, request_type, status,
              DATE_FORMAT(attendance_date, '%Y-%m-%d') AS attendance_date,
              candidate_ot_minutes, auto_created
         FROM attendance_approval_request
        WHERE requested_for_employee_id = ?
          AND attendance_date IN (?)
          AND status <> 'CANCELLED'
        ORDER BY attendance_date ASC, attendance_approval_request_id ASC`,
      [employeeId, dates]
    );
  }

  /**
   * PAYROLL LOCK, the OT writes, in ONE transaction.
   *
   *   1. Every PENDING OT request for the employee in the period becomes
   *      REJECTED with the pending closure reason, approved_ot_minutes 0 and
   *      finalization SETTLED (nothing is recalculated: a rejection pays
   *      nothing and the stored day already pays nothing), and each of its
   *      outstanding steps is stamped SKIPPED with the closure label.
   *   2. For every date in `unrequested` that has NO OT record at all (any
   *      status but CANCELLED), a REJECTED OT record is INSERTed with the
   *      unrequested closure reason, the candidate the engine reported, and
   *      one SKIPPED step, so the date reads as closed and a later request
   *      for it is refused by the one-claim-per-date rule.
   *
   * Nothing APPROVED or already REJECTED is touched. Idempotent by the guard
   * in 2 and the status filter in 1.
   */
  async closeOtAtPayrollLock({
    employee_id,
    from_date,
    to_date,
    pending_closure,
    unrequested_closure,
    unrequested,
  }) {
    const connection = await getConnectionAsync(this.db);
    try {
      await beginTransactionAsync(connection);

      const pendingRows = await queryAsync(
        connection,
        `SELECT attendance_approval_request_id
           FROM attendance_approval_request
          WHERE requested_for_employee_id = ?
            AND attendance_date BETWEEN ? AND ?
            AND request_type = 'OT'
            AND status = 'PENDING'
          FOR UPDATE`,
        [employee_id, from_date, to_date]
      );
      const pendingIds = (pendingRows || []).map((r) => Number(r.attendance_approval_request_id));

      if (pendingIds.length > 0) {
        await queryAsync(
          connection,
          `UPDATE attendance_approval_request
              SET status = 'REJECTED',
                  approved_ot_minutes = 0,
                  finalization_state = 'SETTLED',
                  closure_reason = ?,
                  decided_at = CURRENT_TIMESTAMP(3)
            WHERE attendance_approval_request_id IN (?)
              AND status = 'PENDING'`,
          [pending_closure.code, pendingIds]
        );
        await queryAsync(
          connection,
          `UPDATE attendance_approval_step
              SET decision = 'SKIPPED', remarks = ?, decided_at = CURRENT_TIMESTAMP(3)
            WHERE attendance_approval_request_id IN (?)
              AND decision = 'PENDING'`,
          [pending_closure.label, pendingIds]
        );
      }

      let closedUnrequested = 0;
      for (const u of unrequested || []) {
        /* eslint-disable no-await-in-loop */
        const existing = await queryAsync(
          connection,
          `SELECT attendance_approval_request_id
             FROM attendance_approval_request
            WHERE requested_for_employee_id = ?
              AND attendance_date = ?
              AND request_type = 'OT'
              AND status <> 'CANCELLED'
            LIMIT 1`,
          [employee_id, u.attendance_date]
        );
        if (existing && existing.length > 0) continue;

        const inserted = await queryAsync(
          connection,
          `INSERT INTO attendance_approval_request
             (request_type, requested_for_employee_id, requested_by_employee_id,
              attendance_date, outlet_id, requester_class, reason,
              candidate_ot_minutes, approved_ot_minutes, auto_created,
              status, current_stage_no, total_stages, finalization_state,
              closure_reason, decided_at)
           VALUES ('OT', ?, ?, ?, ?, ?, ?, ?, 0, 1, 'REJECTED', 1, 1, 'SETTLED', ?, CURRENT_TIMESTAMP(3))`,
          [
            employee_id,
            u.closed_by === undefined ? null : u.closed_by,
            u.attendance_date,
            u.outlet_id === undefined ? null : u.outlet_id,
            u.requester_class,
            unrequested_closure.label,
            u.candidate_ot_minutes,
            unrequested_closure.code,
          ]
        );
        await queryAsync(
          connection,
          `INSERT INTO attendance_approval_step
             (attendance_approval_request_id, stage_no, approver_role, outlet_id,
              decision, remarks, decided_at)
           VALUES (?, 1, 'HR', NULL, 'SKIPPED', ?, CURRENT_TIMESTAMP(3))`,
          [inserted.insertId, unrequested_closure.label]
        );
        /* eslint-enable no-await-in-loop */
        closedUnrequested += 1;
      }

      await commitAsync(connection);
      return { rejected_pending: pendingIds.length, closed_unrequested: closedUnrequested };
    } catch (err) {
      await rollbackAsync(connection);
      this._log("CLOSE-OT-AT-PAYROLL-LOCK", err);
      throw err;
    } finally {
      connection.release();
    }
  }

  /**
   * Create a request, its whole chain, and its manual punch, atomically.
   *
   * The punch is written now rather than on approval so that what everybody in
   * the chain reviews is the exact time that will be used - an approver should
   * be agreeing to a specific punch, not to the idea of one.
   */
  async createRequest({ request, chain, punch }) {
    const connection = await getConnectionAsync(this.db);
    try {
      await beginTransactionAsync(connection);

      const inserted = await queryAsync(
        connection,
        `INSERT INTO attendance_approval_request
           (request_type, requested_for_employee_id, requested_by_employee_id,
            attendance_date, outlet_id, requester_class, reason,
            candidate_ot_minutes, auto_created, status, current_stage_no, total_stages)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', 1, ?)`,
        [
          request.request_type,
          request.requested_for_employee_id,
          request.requested_by_employee_id,
          request.attendance_date,
          request.outlet_id,
          request.requester_class,
          request.reason,
          request.candidate_ot_minutes,
          request.auto_created ? 1 : 0,
          chain.length,
        ]
      );
      const requestId = inserted.insertId;

      await queryAsync(
        connection,
        `INSERT INTO attendance_approval_step
           (attendance_approval_request_id, stage_no, approver_role, outlet_id)
         VALUES ?`,
        [chain.map((s) => [requestId, s.stage_no, s.approver_role, s.outlet_id])]
      );

      if (punch) {
        await queryAsync(
          connection,
          `INSERT INTO attendance_regularized_punch
             (attendance_approval_request_id, employee_id, attendance_date,
              punch_time, punch_source, created_by)
           VALUES (?, ?, ?, ?, 'REGULARIZED', ?)`,
          [
            requestId,
            request.requested_for_employee_id,
            request.attendance_date,
            punch.punch_time,
            request.requested_by_employee_id,
          ]
        );
      }

      await commitAsync(connection);
      return { attendance_approval_request_id: requestId, total_stages: chain.length };
    } catch (err) {
      await rollbackAsync(connection);
      this._log("CREATE-REQUEST", err);
      throw err;
    } finally {
      connection.release();
    }
  }

  /**
   * Record one stage's decision, move the request, AND store the recalculated
   * day - all in one transaction (review fix #4).
   *
   * Three statements are guarded on the state they expect - the step on being
   * still PENDING, the request on still being at this stage - so two approvers
   * clicking at the same instant cannot both succeed. A guard that matched
   * nothing rolls the whole thing back and the caller is told to re-read.
   *
   * `calculations` is the already-computed `attendance_day_calculation` row
   * (or rows) for the date, produced by the calculation usecase with this very
   * decision assumed. Writing it HERE, on this connection, is what makes the
   * approval and the attendance it causes a single atomic move: a failure to
   * store the day rolls the approval back, so there is no state in which a
   * request is APPROVED - and its overtime therefore payable - while the
   * stored day still reflects the punches as they were before it.
   *
   * `finalization_state` records which of those two cases a row is in, so the
   * invariant is legible in the data and not only in this comment. It reaches
   * SETTLED in the same commit as APPROVED; a request that is APPROVED but not
   * SETTLED cannot exist, and payroll treats anything else as not yet final.
   */
  async decideStage({
    requestId,
    stageNo,
    decision,
    actorId,
    remarks,
    adminOverride,
    next,
    calculations = null,
  }) {
    const connection = await getConnectionAsync(this.db);
    try {
      await beginTransactionAsync(connection);

      const stepResult = await queryAsync(
        connection,
        `UPDATE attendance_approval_step
            SET decision = ?, decided_by_employee_id = ?, decided_at = CURRENT_TIMESTAMP(3),
                remarks = ?, acted_as_admin_override = ?
          WHERE attendance_approval_request_id = ?
            AND stage_no = ?
            AND decision = 'PENDING'`,
        [decision, actorId, remarks || null, adminOverride ? 1 : 0, requestId, stageNo]
      );
      if (!stepResult || Number(stepResult.affectedRows) !== 1) {
        await rollbackAsync(connection);
        return { code: 409, msg: "That stage has already been decided - reload and try again" };
      }

      // SETTLED only where the recalculated day is committed in this very
      // transaction. An intermediate stage is an ordinary audit write and
      // settles nothing, so it stays NOT_REQUIRED.
      const finalizationState =
        next.status === "APPROVED" || next.status === "REJECTED" ? "SETTLED" : "NOT_REQUIRED";

      const requestResult = await queryAsync(
        connection,
        `UPDATE attendance_approval_request
            SET status = ?, current_stage_no = ?,
                approved_ot_minutes = ?,
                finalization_state = ?,
                decided_at = CASE WHEN ? IN ('APPROVED','REJECTED') THEN CURRENT_TIMESTAMP(3) ELSE decided_at END
          WHERE attendance_approval_request_id = ?
            AND status = 'PENDING'
            AND current_stage_no = ?`,
        [
          next.status,
          next.current_stage_no,
          next.approved_ot_minutes,
          finalizationState,
          next.status,
          requestId,
          stageNo,
        ]
      );
      if (!requestResult || Number(requestResult.affectedRows) !== 1) {
        await rollbackAsync(connection);
        return { code: 409, msg: "This request moved while you were deciding it - reload and try again" };
      }

      // The day the decision produced, stored before the commit. If this
      // throws, the catch below rolls the decision back with it.
      const stored = await writeCalculationsOnConnection(connection, calculations || []);

      await commitAsync(connection);
      return {
        code: 200,
        status: next.status,
        current_stage_no: next.current_stage_no,
        finalization_state: finalizationState,
        calculations_written: stored.written,
      };
    } catch (err) {
      await rollbackAsync(connection);
      this._log("DECIDE-STAGE", err);
      throw err;
    } finally {
      connection.release();
    }
  }

  /**
   * The pending queue for one actor: requests whose CURRENT stage is one this
   * actor could decide.
   *
   * Their own requests are excluded in SQL as well as in `canApprove`, because
   * a queue that shows somebody a row they can never action is a bug even when
   * the action would correctly be refused.
   */
  async listPendingFor({ approver_roles, outlet_id, actor_employee_id, limit = 200 }) {
    const roles = Array.isArray(approver_roles) ? approver_roles : [];
    if (roles.length === 0) return [];

    return this._read(
      "LIST-PENDING-FOR",
      `SELECT r.attendance_approval_request_id, r.request_type,
              r.requested_for_employee_id, ne.employee_name,
              r.requested_by_employee_id,
              DATE_FORMAT(r.attendance_date, '%Y-%m-%d') AS attendance_date,
              r.outlet_id, o.outlet_name, r.reason,
              r.candidate_ot_minutes, r.current_stage_no, r.total_stages,
              s.attendance_approval_step_id, s.approver_role,
              DATE_FORMAT(r.created_at, '%Y-%m-%d %H:%i:%s') AS created_at
         FROM attendance_approval_request r
         JOIN attendance_approval_step s
           ON s.attendance_approval_request_id = r.attendance_approval_request_id
          AND s.stage_no = r.current_stage_no
         LEFT JOIN new_employee ne ON ne.employee_id = r.requested_for_employee_id
         LEFT JOIN outlets o ON o.outlet_id = r.outlet_id
        WHERE r.status = 'PENDING'
          AND s.decision = 'PENDING'
          AND s.approver_role IN (?)
          AND (s.approver_role <> 'STORE_MANAGER' OR s.outlet_id = ?)
          AND r.requested_for_employee_id <> ?
          AND r.requested_by_employee_id <> ?
        ORDER BY r.attendance_date ASC, r.attendance_approval_request_id ASC
        LIMIT ?`,
      [roles, outlet_id === undefined ? null : outlet_id, actor_employee_id, actor_employee_id, Number(limit)]
    );
  }

  /** One employee's own requests, for the "what did I raise" view. */
  async listForEmployee({ employee_id, from_date, to_date, limit = 200 }) {
    return this._read(
      "LIST-FOR-EMPLOYEE",
      `SELECT r.attendance_approval_request_id, r.request_type,
              DATE_FORMAT(r.attendance_date, '%Y-%m-%d') AS attendance_date,
              r.reason, r.status, r.current_stage_no, r.total_stages,
              r.candidate_ot_minutes, r.approved_ot_minutes,
              DATE_FORMAT(r.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
              DATE_FORMAT(r.decided_at, '%Y-%m-%d %H:%i:%s') AS decided_at
         FROM attendance_approval_request r
        WHERE r.requested_for_employee_id = ?
          AND r.attendance_date BETWEEN ? AND ?
        ORDER BY r.attendance_date DESC, r.attendance_approval_request_id DESC
        LIMIT ?`,
      [employee_id, from_date, to_date, Number(limit)]
    );
  }
}

module.exports = (db) => new AttendanceRegularizationRepository(db);
module.exports.AttendanceRegularizationRepository = AttendanceRegularizationRepository;
