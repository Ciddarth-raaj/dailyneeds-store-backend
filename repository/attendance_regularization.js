const logger = require("../utils/logger");
const {
  queryAsync,
  getConnectionAsync,
  beginTransactionAsync,
  commitAsync,
  rollbackAsync,
} = require("../utils/batchInsert");
const {
  writeCalculationsOnConnection,
  assertMonthsNotPayrollLocked,
} = require("./attendance_calculation");
// THE SHARED SERIALIZATION POINT, imported rather than re-typed: the block
// path and this one must lock the IDENTICAL row with the IDENTICAL statement,
// and two copies of a lock serialize nothing.
const { SHARED_LOCK_SQL } = require("./attendance_shift_change_block");

/*
 * ADMIN REVOKE - the two reads a revocation is decided on, as constants,
 * because they are issued TWICE: once without a lock (the usecase validates
 * and computes the reopened day from it) and once `FOR UPDATE` inside the
 * transaction. The transaction compares the two results column for column, so
 * the statements must be the same text - a second, subtly different read
 * would compare nothing.
 */
const REVOKE_REQUEST_SQL = `SELECT attendance_approval_request_id, request_type,
              requested_for_employee_id, requested_by_employee_id,
              DATE_FORMAT(attendance_date, '%Y-%m-%d') AS attendance_date,
              reason, candidate_ot_minutes, approved_ot_minutes,
              status, current_stage_no, total_stages, finalization_state,
              closure_reason, auto_created,
              DATE_FORMAT(decided_at, '%Y-%m-%d %H:%i:%s.%f') AS decided_at
         FROM attendance_approval_request
        WHERE attendance_approval_request_id = ?`;
const REVOKE_STEPS_SQL = `SELECT attendance_approval_step_id, stage_no, approver_role, outlet_id,
              approver_employee_id, approval_level, decision,
              decided_by_employee_id,
              DATE_FORMAT(decided_at, '%Y-%m-%d %H:%i:%s.%f') AS decided_at,
              remarks, acted_as_admin_override, decision_source
         FROM attendance_approval_step
        WHERE attendance_approval_request_id = ?
        ORDER BY stage_no ASC`;

/** A request and its steps as one comparable string: every column, as text, in a fixed order. */
function revocationFingerprint(request, steps) {
  const plain = (row) =>
    row
      ? Object.keys(row)
          .sort()
          .reduce((acc, k) => {
            const v = row[k];
            acc[k] = v === null || v === undefined ? null : String(v);
            return acc;
          }, {})
      : null;
  return JSON.stringify({ request: plain(request), steps: (steps || []).map(plain) });
}

const nullableId = (v) => (v === null || v === undefined ? null : Number(v));

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
 *
 * ...UNLESS THE ATTENDANCE DAY IS STILL OPEN. A day row written before the
 * date's attendance day closes is a snapshot of a half-finished day, and once
 * the date closes every read returns it as settled history
 * (`utils/attendance_persist_guard.js`). So the invariant is now two
 * sentences, and the usecase decides which applies from the date's own shift
 * snapshot and cutoff:
 *
 *   CLOSED date   decision (+ override) + the recalculated day, ONE commit -
 *                 exactly as before.
 *   OPEN date     decision (+ override) ONE commit, and NO day row. The date
 *                 has no stored row to be stale against: it reads
 *                 LIVE_PREVIEW from the committed decision, and the first
 *                 ordinary recalculation after it closes stores it. That is a
 *                 complete, successful write - `calculations` is simply empty -
 *                 and the payroll lock is still taken on the date
 *                 (`attendanceLock`), so a locked month refuses it as before.
 *
 * Only a SHIFT_CHANGE may be FINALLY approved while its date is open, and
 * intermediate stages and rejections of any type may be decided; the usecase
 * refuses final settlement of a regularization or of OT until the day closes.
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
              o.outlet_name,
              ne.designation_id,
              d.designation_name,
              r.approver_role,
              r.requester_class
         FROM new_employee ne
         LEFT JOIN designation d ON d.designation_id = ne.designation_id
         LEFT JOIN outlets o ON o.outlet_id = ne.store_id
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
              finalization_state, auto_created, chain_source,
              requested_work_shift_id, base_work_shift_id,
              telegram_chat_id, telegram_message_id
         FROM attendance_approval_request
        WHERE attendance_approval_request_id = ?`,
      [requestId]
    );
    const request = rows && rows[0] ? rows[0] : null;
    if (!request) return null;

    const steps = await this._read(
      "GET-REQUEST-STEPS",
      `SELECT s.attendance_approval_step_id, s.stage_no, s.approver_role, s.outlet_id,
              s.approver_employee_id, s.approval_level, a.employee_name AS approver_name,
              s.decision, s.decided_by_employee_id,
              DATE_FORMAT(s.decided_at, '%Y-%m-%d %H:%i:%s') AS decided_at,
              s.remarks, s.acted_as_admin_override, s.decision_source
         FROM attendance_approval_step s
         LEFT JOIN new_employee a ON a.employee_id = s.approver_employee_id
        WHERE s.attendance_approval_request_id = ?
        ORDER BY s.stage_no ASC`,
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
   * The Work Shift's regularization POLICY, from the LIVE row. Policy is not
   * effective-dated on purpose (see `utils/shift_config_version.js`): whether
   * a request may be raised is a question about now, not about the date.
   */
  async getRegularizationPolicy(workShiftId) {
    const rows = await this._read(
      "GET-REGULARIZATION-POLICY",
      `SELECT work_shift_id, regularization_allowed, regularization_control_enabled,
              regularization_limit_per_month, regularization_require_existing_punch,
              regularization_requires_approval
         FROM work_shift
        WHERE work_shift_id = ?`,
      [workShiftId]
    );
    return rows && rows[0] ? rows[0] : null;
  }

  /**
   * How many regularizations the employee has already used in a calendar
   * month: every attendance-correction request that is open or approved. A
   * rejected or cancelled one did not correct anything and is not counted
   * against the limit.
   */
  async countRegularizationsInMonth(employeeId, monthStart, monthEnd) {
    const rows = await this._read(
      "COUNT-REGULARIZATIONS-IN-MONTH",
      `SELECT COUNT(*) AS used
         FROM attendance_approval_request
        WHERE requested_for_employee_id = ?
          AND request_type IN ('REGULARIZATION', 'REGULARIZATION_WITH_OT')
          AND status IN ('PENDING', 'APPROVED')
          AND attendance_date BETWEEN ? AND ?`,
      [employeeId, monthStart, monthEnd]
    );
    return rows && rows[0] ? Number(rows[0].used) || 0 : 0;
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
   *
   * THE CHAIN IS SNAPSHOTTED. Each step stores the role it was addressed to
   * and, for an EMPLOYEE-LEVEL chain, the actual approver employee id and the
   * level it came from; `chain_source` on the request says which of the two
   * chains was resolved. Nothing about a request re-reads the approver
   * mapping afterwards, so later mapping changes do not move a request that
   * has already been raised (Replace Approver does that explicitly, and only
   * for undecided steps).
   */
  async createRequest({ request, chain, punch, auto_approve = null }) {
    const connection = await getConnectionAsync(this.db);
    try {
      await beginTransactionAsync(connection);

      /**
       * ============ THE HR BLOCK, CHECKED UNDER THE SHARED LOCK ============
       *
       * SHIFT_CHANGE ONLY. Regularization and OT race nothing here and are
       * deliberately left untouched - they take no lock and read no block.
       *
       * The usecase already refused a blocked date before calling this. That
       * check cannot be the guarantee: between it and this insert, HR may have
       * committed a block. So the date is re-read HERE, after taking the
       * employee row with `FOR UPDATE`, which is the same row and the same
       * statement `attendance_shift_change_block#create` takes before ITS
       * checks. Whoever wins the lock commits; the loser waits, re-reads, and
       * sees the other's work.
       *
       * LOCK ORDER: `new_employee` first, then the block and request tables.
       * Both paths, always. Nothing here takes them in the other order.
       */
      if (request.request_type === "SHIFT_CHANGE") {
        await queryAsync(connection, SHARED_LOCK_SQL, [request.requested_for_employee_id]);

        const blocked = await queryAsync(
          connection,
          `SELECT attendance_shift_change_block_id, reason,
                  DATE_FORMAT(attendance_date, '%Y-%m-%d') AS attendance_date
             FROM attendance_shift_change_block
            WHERE employee_id = ?
              AND attendance_date = ?
              AND removed_at IS NULL
            LIMIT 1`,
          [request.requested_for_employee_id, request.attendance_date]
        );
        if (blocked && blocked.length > 0) {
          await rollbackAsync(connection);
          // Handed back as a RESULT, not thrown: the usecase owns the wording
          // the employee sees, and it is the same sentence whichever path
          // discovered the block.
          return {
            created: false,
            hr_blocked: true,
            block: {
              attendance_shift_change_block_id: blocked[0].attendance_shift_change_block_id,
              reason: blocked[0].reason,
              attendance_date: blocked[0].attendance_date,
            },
          };
        }
      }

      // A shift whose policy needs no approval settles the request in the
      // same transaction it is raised in: APPROVED, SETTLED, its one step
      // decided, and the corrected day stored - the same invariant a decided
      // request has (see `decideStage`), reached in one commit. The pending
      // path is left exactly as it was.
      const autoApproved = Boolean(auto_approve);
      const requestParams = [
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
        request.chain_source === undefined ? null : request.chain_source,
        // SHIFT_CHANGE only. NULL on every other request type, which is what
        // keeps one insert serving all three rather than a second one that
        // would have to be kept in step with this.
        request.requested_work_shift_id === undefined ? null : request.requested_work_shift_id,
        request.base_work_shift_id === undefined ? null : request.base_work_shift_id,
      ];
      const inserted = autoApproved
        ? await queryAsync(
            connection,
            `INSERT INTO attendance_approval_request
               (request_type, requested_for_employee_id, requested_by_employee_id,
                attendance_date, outlet_id, requester_class, reason,
                candidate_ot_minutes, auto_created, status, current_stage_no, total_stages,
                chain_source, requested_work_shift_id, base_work_shift_id,
                approved_ot_minutes, finalization_state, decided_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'APPROVED', 1, ?, ?, ?, ?, 0, 'SETTLED', CURRENT_TIMESTAMP(3))`,
            requestParams
          )
        : await queryAsync(
            connection,
            `INSERT INTO attendance_approval_request
               (request_type, requested_for_employee_id, requested_by_employee_id,
                attendance_date, outlet_id, requester_class, reason,
                candidate_ot_minutes, auto_created, status, current_stage_no, total_stages,
                chain_source, requested_work_shift_id, base_work_shift_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', 1, ?, ?, ?, ?)`,
            requestParams
          );
      const requestId = inserted.insertId;

      const stepRows = chain.map((s) => [
        requestId,
        s.stage_no,
        s.approver_role,
        s.outlet_id,
        s.approver_employee_id === undefined ? null : s.approver_employee_id,
        s.approval_level === undefined ? null : s.approval_level,
      ]);
      if (autoApproved) {
        const remarks = auto_approve.remarks || "Auto-approved: the work shift does not require approval";
        await queryAsync(
          connection,
          `INSERT INTO attendance_approval_step
             (attendance_approval_request_id, stage_no, approver_role, outlet_id,
              approver_employee_id, approval_level, decision, decided_at, remarks)
           VALUES ?`,
          [stepRows.map((row) => [...row, "APPROVED", new Date(), remarks])]
        );
      } else {
        await queryAsync(
          connection,
          `INSERT INTO attendance_approval_step
             (attendance_approval_request_id, stage_no, approver_role, outlet_id,
              approver_employee_id, approval_level)
           VALUES ?`,
          [stepRows]
        );
      }

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

      // The corrected day, committed with the auto-approval - a request that
      // is APPROVED while the stored day still shows the missing punch must
      // not exist, exactly as for a decided one.
      let calculationsWritten = 0;
      if (autoApproved && Array.isArray(auto_approve.calculations) && auto_approve.calculations.length) {
        const stored = await writeCalculationsOnConnection(connection, auto_approve.calculations);
        calculationsWritten = stored.written;
      }

      await commitAsync(connection);
      return {
        attendance_approval_request_id: requestId,
        total_stages: chain.length,
        status: autoApproved ? "APPROVED" : "PENDING",
        finalization_state: autoApproved ? "SETTLED" : "NOT_REQUIRED",
        calculations_written: calculationsWritten,
      };
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
   * SETTLED means the DECISION is final and effective - the resolver and the
   * punch query read it - not that a day row was written: on an open date
   * there is none yet, by design (see the file header).
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
    decisionSource = "WEB",
    shiftOverride = null,
    // `{ employee_id, attendance_date }` - the date this decision is about.
    // Gated for the payroll lock whether or not a day row is written with it:
    // on an OPEN date `calculations` is deliberately empty, and the decision
    // (and any override) must still be refused in a locked month.
    attendanceLock = null,
  }) {
    const connection = await getConnectionAsync(this.db);
    try {
      await beginTransactionAsync(connection);

      const stepResult = await queryAsync(
        connection,
        `UPDATE attendance_approval_step
            SET decision = ?, decided_by_employee_id = ?, decided_at = CURRENT_TIMESTAMP(3),
                decision_source = ?, remarks = ?, acted_as_admin_override = ?
          WHERE attendance_approval_request_id = ?
            AND stage_no = ?
            AND decision = 'PENDING'`,
        [
          decision,
          actorId,
          decisionSource === "TELEGRAM" ? "TELEGRAM" : "WEB",
          remarks || null,
          adminOverride ? 1 : 0,
          requestId,
          stageNo,
        ]
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

      // THE APPROVED ONE-DAY SHIFT, written in THIS transaction.
      //
      // A final approval of a SHIFT_CHANGE request is the only thing that
      // makes the requested shift effective, and it becomes effective by the
      // same `attendance_date_shift_override` row a management edit writes -
      // one table, one resolver, one precedence rule. Writing it here rather
      // than after the commit is the same invariant the recalculated day
      // already has: there is no ordering in which the request reads APPROVED
      // while the date still resolves to the old shift.
      if (attendanceLock && attendanceLock.employee_id && attendanceLock.attendance_date) {
        await assertMonthsNotPayrollLocked(connection, [
          { employee_id: attendanceLock.employee_id, attendance_date: attendanceLock.attendance_date },
        ]);
      }

      let overrideId = null;
      if (shiftOverride) {
        const insertedOverride = await queryAsync(
          connection,
          `INSERT INTO attendance_date_shift_override
             (employee_id, attendance_date, work_shift_id, previous_work_shift_id,
              changed_by, attendance_approval_request_id, source, reason)
           VALUES (?, ?, ?, ?, ?, ?, 'APPROVED_REQUEST', ?)`,
          [
            shiftOverride.employee_id,
            shiftOverride.attendance_date,
            shiftOverride.work_shift_id,
            shiftOverride.previous_work_shift_id === undefined
              ? null
              : shiftOverride.previous_work_shift_id,
            actorId,
            requestId,
            shiftOverride.reason || null,
          ]
        );
        overrideId = insertedOverride ? insertedOverride.insertId : null;
      }

      // The day the decision produced, stored before the commit. If this
      // throws, the catch below rolls the decision back with it. EMPTY on a
      // date whose attendance day is still open: the decision commits alone,
      // by design, and the date is stored once it closes.
      const stored = await writeCalculationsOnConnection(connection, calculations || []);

      await commitAsync(connection);
      return {
        code: 200,
        status: next.status,
        current_stage_no: next.current_stage_no,
        finalization_state: finalizationState,
        calculations_written: stored.written,
        attendance_date_shift_override_id: overrideId,
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
   * ADMIN REVOKE, THE READ: a request and its steps exactly as the
   * revocation transaction will re-read them under lock. No lock here - the
   * usecase uses this to validate and to compute the reopened day, and the
   * transaction then proves nothing moved in between.
   */
  async getRevocationSnapshot(requestId) {
    const [request] = await this._read("REVOKE-SNAPSHOT-REQUEST", REVOKE_REQUEST_SQL, [requestId]);
    if (!request) return null;
    const steps = await this._read("REVOKE-SNAPSHOT-STEPS", REVOKE_STEPS_SQL, [requestId]);
    return { request, steps, fingerprint: revocationFingerprint(request, steps) };
  }

  /**
   * ADMIN REVOKE, THE WRITE: reopen ONE request at ONE stage, in ONE
   * transaction. Everything below commits together or not at all:
   *
   *   1  SELECT new_employee ... FOR UPDATE      the shared employee lock
   *      (`SHARED_LOCK_SQL`) - the same row, the same statement and the same
   *      first position `createRequest` uses, so a request being RAISED for
   *      this employee and this reopening serialize instead of each passing
   *      the other's conflict check.
   *   2  the steps FOR UPDATE, then the request FOR UPDATE - STEP BEFORE
   *      REQUEST, the order `decideStage` writes them in, so a concurrent
   *      decision and this revocation queue behind each other rather than
   *      deadlock.
   *   3  the locked re-read is compared with the usecase's unlocked read
   *      (`expectedFingerprint`). ANY difference - a stage decided, the
   *      request moved, a remark changed - is a 409: the reopened day was
   *      computed against a state that no longer exists.
   *   4  the rules, re-checked on the locked rows: a revocable type, not a
   *      payroll-lock closure, the target stage exists and is APPROVED or
   *      REJECTED, and no OTHER request on the date conflicts with the
   *      reopened one (below).
   *   5  the payroll lock, `payrun_employee_calculation ... FOR UPDATE`,
   *      taken whether or not a day row is written.
   *   6  the target step and every later step -> PENDING, cleared; the
   *      request -> PENDING at the target stage, approved OT cleared, not
   *      settled, not decided.
   *   7  the audit row, holding every original value step 6 cleared.
   *   8  the recalculated day (`writeCalculationsOnConnection`, which asserts
   *      the payroll lock again under the same row lock).
   *
   * CONFLICTS - what reopening may not create:
   *   - a second OPEN attendance/OT request on the date. The database's
   *     `uq_aareq_open_per_employee_date` refuses it anyway; this says so in
   *     a sentence first, and the duplicate-key error is mapped to the same
   *     409 in case a row appeared between the two.
   *   - a reopened REGULARIZATION while another request on the date is
   *     APPROVED: an approved OT claim was granted against the corrected day,
   *     and a second approved correction would be two corrections of one day.
   *     The administrator revokes that one first.
   *
   * Returns `{ code: 200, ... }`, or `{ code: 409, msg }` after a rollback. A
   * payroll lock or a storage failure THROWS, after the rollback.
   */
  async revokeStage({
    requestId,
    stageNo,
    expectedFingerprint,
    employeeId,
    actor,
    reason,
    revocableTypes,
    calculations = [],
  }) {
    const connection = await getConnectionAsync(this.db);
    const refuse = async (msg) => {
      await rollbackAsync(connection);
      return { code: 409, msg };
    };
    try {
      await beginTransactionAsync(connection);

      // 1. The employee, first.
      const employee = await queryAsync(connection, SHARED_LOCK_SQL, [employeeId]);
      if (!employee || employee.length === 0) return await refuse("That employee no longer exists");

      // 2. Steps, then the request.
      const steps = await queryAsync(connection, `${REVOKE_STEPS_SQL} FOR UPDATE`, [requestId]);
      const [request] = await queryAsync(connection, `${REVOKE_REQUEST_SQL} FOR UPDATE`, [requestId]);
      if (!request) return await refuse("That request no longer exists");

      // 3. Nothing moved since the usecase read it.
      if (
        revocationFingerprint(request, steps) !== expectedFingerprint ||
        Number(request.requested_for_employee_id) !== Number(employeeId)
      ) {
        return await refuse("This request changed while you were revoking it - reload and try again");
      }

      // 4. The rules, on the locked rows.
      if (!(revocableTypes || []).includes(request.request_type)) {
        return await refuse(`A ${request.request_type} decision cannot be revoked here`);
      }
      if (request.closure_reason) {
        return await refuse(
          "This request was closed by the payroll lock, not by an approver, and cannot be revoked"
        );
      }
      const target = (steps || []).find((st) => Number(st.stage_no) === Number(stageNo));
      if (!target) return await refuse(`This request has no stage ${stageNo}`);
      if (target.decision !== "APPROVED" && target.decision !== "REJECTED") {
        return await refuse(
          `Stage ${stageNo} has no decision to revoke - it is ${String(target.decision).toLowerCase()}`
        );
      }

      const others = await queryAsync(
        connection,
        `SELECT attendance_approval_request_id, request_type, status
           FROM attendance_approval_request
          WHERE requested_for_employee_id = ?
            AND attendance_date = ?
            AND attendance_approval_request_id <> ?
            AND request_type <> 'SHIFT_CHANGE'
            AND status IN ('PENDING', 'APPROVED')
          ORDER BY attendance_approval_request_id`,
        [employeeId, request.attendance_date, requestId]
      );
      const open = (others || []).find((o) => o.status === "PENDING");
      if (open) {
        return await refuse(
          `${request.attendance_date} already has an open ${open.request_type} request ` +
            `(#${open.attendance_approval_request_id}); decide or revoke that one first - ` +
            "a date can have only one open attendance or OT request"
        );
      }
      const approvedOther = (others || []).find((o) => o.status === "APPROVED");
      if (request.request_type !== "OT" && approvedOther) {
        return await refuse(
          `${request.attendance_date} has an approved ${approvedOther.request_type} request ` +
            `(#${approvedOther.attendance_approval_request_id}) that depends on the corrected day; ` +
            "revoke that one first"
        );
      }

      // 5. The payroll lock, whether or not a day row goes with this.
      await assertMonthsNotPayrollLocked(connection, [
        { employee_id: employeeId, attendance_date: request.attendance_date },
      ]);

      // 6. Reset: the target stage and every later one, then the request.
      const reset = (steps || []).filter((st) => Number(st.stage_no) >= Number(stageNo));
      await queryAsync(
        connection,
        `UPDATE attendance_approval_step
            SET decision = 'PENDING', decided_by_employee_id = NULL, decided_at = NULL,
                remarks = NULL, acted_as_admin_override = 0, decision_source = NULL
          WHERE attendance_approval_request_id = ?
            AND stage_no >= ?`,
        [requestId, stageNo]
      );
      try {
        await queryAsync(
          connection,
          `UPDATE attendance_approval_request
              SET status = 'PENDING', current_stage_no = ?, approved_ot_minutes = NULL,
                  finalization_state = 'NOT_REQUIRED', decided_at = NULL
            WHERE attendance_approval_request_id = ?`,
          [stageNo, requestId]
        );
      } catch (err) {
        if (err && err.code === "ER_DUP_ENTRY") {
          return await refuse(
            `${request.attendance_date} already has an open attendance or OT request; decide or revoke that one first`
          );
        }
        throw err;
      }

      // 7. The audit, holding every original value step 6 cleared.
      const inserted = await queryAsync(
        connection,
        `INSERT INTO attendance_approval_revocation
           (attendance_approval_request_id, request_type, requested_for_employee_id, attendance_date,
            revoked_stage_no, revoked_approver_role, revoked_approval_level, revoked_step_approver_employee_id,
            original_decision, original_decided_by_employee_id, original_decided_at, original_remarks,
            original_acted_as_admin_override, original_decision_source,
            original_request_status, original_current_stage_no, original_finalization_state,
            original_approved_ot_minutes, original_request_decided_at,
            reset_steps, revoked_by_employee_id, revoked_by_user_id, reason, calculations_written)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          requestId,
          request.request_type,
          employeeId,
          request.attendance_date,
          Number(stageNo),
          target.approver_role || null,
          target.approval_level || null,
          nullableId(target.approver_employee_id),
          target.decision,
          nullableId(target.decided_by_employee_id),
          target.decided_at || null,
          target.remarks || null,
          Number(target.acted_as_admin_override) === 1 ? 1 : 0,
          target.decision_source || null,
          request.status,
          Number(request.current_stage_no),
          request.finalization_state || null,
          nullableId(request.approved_ot_minutes),
          request.decided_at || null,
          JSON.stringify(
            reset.map((st) => ({
              stage_no: Number(st.stage_no),
              approver_role: st.approver_role,
              approval_level: st.approval_level || null,
              approver_employee_id: nullableId(st.approver_employee_id),
              decision: st.decision,
              decided_by_employee_id: nullableId(st.decided_by_employee_id),
              decided_at: st.decided_at || null,
              remarks: st.remarks || null,
              acted_as_admin_override: Number(st.acted_as_admin_override) === 1,
              decision_source: st.decision_source || null,
            }))
          ),
          actor && actor.employee_id ? Number(actor.employee_id) : null,
          actor && actor.user_id ? Number(actor.user_id) : null,
          reason,
          (calculations || []).length,
        ]
      );

      // 8. The reopened day. A failure here rolls everything above back.
      const stored = await writeCalculationsOnConnection(connection, calculations || []);

      await commitAsync(connection);
      return {
        code: 200,
        attendance_approval_request_id: Number(requestId),
        attendance_approval_revocation_id: inserted ? Number(inserted.insertId) : null,
        status: "PENDING",
        current_stage_no: Number(stageNo),
        reset_stage_nos: reset.map((st) => Number(st.stage_no)),
        original_request_status: request.status,
        original_decision: target.decision,
        calculations_written: stored.written,
      };
    } catch (err) {
      await rollbackAsync(connection);
      this._log("REVOKE-STAGE", err);
      throw err;
    } finally {
      connection.release();
    }
  }

  /** The revocations of these requests, newest first, for the approval screen. */
  async listRevocationsForRequests(requestIds) {
    if (!Array.isArray(requestIds) || requestIds.length === 0) return [];
    return this._read(
      "LIST-REVOCATIONS",
      `SELECT v.attendance_approval_revocation_id, v.attendance_approval_request_id,
              v.revoked_stage_no, v.revoked_approval_level, v.original_decision,
              v.original_decided_by_employee_id, d.employee_name AS original_decided_by_name,
              DATE_FORMAT(v.original_decided_at, '%Y-%m-%d %H:%i:%s') AS original_decided_at,
              v.original_request_status, v.original_approved_ot_minutes,
              v.revoked_by_employee_id, a.employee_name AS revoked_by_name,
              DATE_FORMAT(v.revoked_at, '%Y-%m-%d %H:%i:%s') AS revoked_at, v.reason
         FROM attendance_approval_revocation v
         LEFT JOIN new_employee d ON d.employee_id = v.original_decided_by_employee_id
         LEFT JOIN new_employee a ON a.employee_id = v.revoked_by_employee_id
        WHERE v.attendance_approval_request_id IN (?)
        ORDER BY v.attendance_approval_request_id ASC, v.attendance_approval_revocation_id DESC`,
      [requestIds]
    );
  }


  /**
   * The pending queue for one actor: requests whose CURRENT stage is one this
   * actor could decide.
   *
   * Their own requests are excluded in SQL as well as in `canApprove`, because
   * a queue that shows somebody a row they can never action is a bug even when
   * the action would correctly be refused.
   */
  /**
   * THE LEGACY QUEUE, AND WHY IT EXCLUDES SHIFT_CHANGE.
   *
   * `GET /attendance/regularization/pending` predates the unified approval
   * centre. It takes no request-type filter and is reached with
   * `view_attendance_approvals` alone, so a SHIFT_CHANGE row returned here
   * would be a Shift queue that nobody needed `view_shift_change_requests`
   * to read - which is exactly what that key exists to prevent. The Shift
   * queue is `/attendance/approvals?request_type=SHIFT_CHANGE`, which does
   * enforce it. Attendance and OT are unaffected.
   */
  async listPendingFor({ approver_roles, outlet_id, actor_employee_id, limit = 200 }) {
    // An actor with no role still has a queue: the employee-level steps that
    // name them. The IN (?) below needs a non-empty list, so an impossible
    // role stands in for "none".
    const roles = Array.isArray(approver_roles) && approver_roles.length > 0 ? approver_roles : ["__NONE__"];

    return this._read(
      "LIST-PENDING-FOR",
      `SELECT r.attendance_approval_request_id, r.request_type,
              r.requested_for_employee_id, ne.employee_name,
              r.requested_by_employee_id,
              DATE_FORMAT(r.attendance_date, '%Y-%m-%d') AS attendance_date,
              r.outlet_id, o.outlet_name, r.reason,
              r.candidate_ot_minutes, r.current_stage_no, r.total_stages,
              s.attendance_approval_step_id, s.approver_role,
              s.approver_employee_id, s.approval_level, r.chain_source,
              DATE_FORMAT(r.created_at, '%Y-%m-%d %H:%i:%s') AS created_at
         FROM attendance_approval_request r
         JOIN attendance_approval_step s
           ON s.attendance_approval_request_id = r.attendance_approval_request_id
          AND s.stage_no = r.current_stage_no
         LEFT JOIN new_employee ne ON ne.employee_id = r.requested_for_employee_id
         LEFT JOIN outlets o ON o.outlet_id = r.outlet_id
        WHERE r.status = 'PENDING'
          AND s.decision = 'PENDING'
          AND r.request_type <> 'SHIFT_CHANGE'
          AND (
                (s.approver_employee_id IS NULL
                 AND s.approver_role IN (?)
                 AND (s.approver_role <> 'STORE_MANAGER' OR s.outlet_id = ?))
             OR s.approver_employee_id = ?
              )
          AND r.requested_for_employee_id <> ?
          AND r.requested_by_employee_id <> ?
        ORDER BY r.attendance_date ASC, r.attendance_approval_request_id ASC
        LIMIT ?`,
      [roles, outlet_id === undefined ? null : outlet_id, actor_employee_id, actor_employee_id, actor_employee_id, Number(limit)]
    );
  }

  /**
   * The WHERE clause of an approver's visibility, shared by the list and the
   * count so the two can never disagree.
   *
   * PENDING: requests whose CURRENT stage this actor could decide now - the
   * stage's role is one of theirs (a Store Manager's only for their own
   * outlet) and the request is not their own. That is "pending with me".
   *
   * History (APPROVED / REJECTED / ALL): requests this actor was authorized
   * to see or act on - any stage of the chain carries one of their roles,
   * with the same outlet rule - and, again, never their own. An
   * administrator sees everything. Nothing here widens visibility for a
   * history tab beyond what the approver's role already gave them.
   *
   * EMPLOYEE-LEVEL STEPS are addressed to a person, so they are in scope for
   * exactly that person: a step whose `approver_employee_id` is the actor is
   * theirs, whatever their role; a step with a snapshotted approver who is
   * somebody else is nobody else's, whatever their role. Role-based steps
   * (historical, and the unmapped fallback) keep the role rule unchanged.
   * The same clause serves the list and the count, so "pending with me"
   * moves the moment Replace Approver moves a step.
   */
  _approvalScope({
    request_type,
    status,
    approver_roles,
    outlet_id,
    actor_employee_id,
    is_admin,
    filter_outlet_ids = null,
    filter_employee_id = null,
    filter_designation_id = null,
    permitted_outlet_ids = null,
  }) {
    const roles = Array.isArray(approver_roles) ? approver_roles : [];
    // `request_type` may be a list: the unified approval centre asks for one
    // tab at a time, but REGULARIZATION historically shares its queue with
    // the legacy REGULARIZATION_WITH_OT rows and they belong on that tab.
    const types = Array.isArray(request_type) ? request_type : [request_type];
    const where = ["r.request_type IN (?)"];
    const params = [types];
    const outlet = outlet_id === undefined ? null : outlet_id;

    /*
     * THE ACTOR'S AUTHORITY OVER A REQUEST, from its chain alone: the stage
     * (the CURRENT one for PENDING, ANY one for history) is addressed to them
     * by name, or carries one of their roles - a Store Manager's only for
     * their own outlet. Built once, because it is used twice below: as the
     * visibility rule itself, and as what the outlet scope may never hide.
     * `null` for an administrator, who is not narrowed by it.
     */
    let authority = null;
    if (!is_admin) {
      if (status === "PENDING") {
        authority =
          roles.length === 0
            ? { sql: "s.approver_employee_id = ?", params: [actor_employee_id] }
            : {
                sql: `((s.approver_employee_id IS NULL AND s.approver_role IN (?)
                        AND (s.approver_role <> 'STORE_MANAGER' OR s.outlet_id = ?))
                       OR s.approver_employee_id = ?)`,
                params: [roles, outlet, actor_employee_id],
              };
      } else {
        authority =
          roles.length === 0
            ? {
                sql: `EXISTS (SELECT 1 FROM attendance_approval_step x
                               WHERE x.attendance_approval_request_id = r.attendance_approval_request_id
                                 AND x.approver_employee_id = ?)`,
                params: [actor_employee_id],
              }
            : {
                sql: `EXISTS (SELECT 1 FROM attendance_approval_step x
                               WHERE x.attendance_approval_request_id = r.attendance_approval_request_id
                                 AND ((x.approver_employee_id IS NULL AND x.approver_role IN (?)
                                       AND (x.approver_role <> 'STORE_MANAGER' OR x.outlet_id = ?))
                                      OR x.approver_employee_id = ?))`,
                params: [roles, outlet, actor_employee_id],
              };
      }
    }

    if (status === "PENDING") {
      where.push("r.status = 'PENDING'");
      where.push("s.decision = 'PENDING'");
    } else if (status === "APPROVED" || status === "REJECTED") {
      where.push("r.status = ?");
      params.push(status);
    } else {
      where.push("r.status <> 'CANCELLED'");
    }
    if (authority) {
      where.push(authority.sql);
      params.push(...authority.params);
      where.push("r.requested_for_employee_id <> ?");
      where.push("r.requested_by_employee_id <> ?");
      params.push(actor_employee_id, actor_employee_id);
    }

    /*
     * THE OUTLET SCOPE, AND THE FILTERS, ARE TWO DIFFERENT THINGS.
     *
     * `permitted_outlet_ids` is AUTHORIZATION: the outlets this actor may see
     * requests from at all. It is resolved server-side from the actor's own
     * branch scope and never from anything the client sent, and it FAILS
     * CLOSED - an empty list renders `1 = 0` rather than "no restriction",
     * the same rule `repository/employee_scope.js#accessScope` follows and
     * for the same reason: a caller that forgets to resolve it returns
     * nothing and is noticed. `null` means an actor with no restriction at
     * all (an administrator, or a company-wide scope).
     *
     * IT NEVER HIDES A REQUEST THE CHAIN ADDRESSES TO THIS ACTOR. Attendance
     * Approver Setup may name ANY active employee as a person's approver, in
     * any branch, and `canApprove` lets that person decide the stage - from
     * this screen or from Telegram - whatever their branch. Company-wide
     * roles (Operations, HR) are likewise not outlet-bound in `canApprove`.
     * The outlet scope used to be a flat `r.outlet_id IN (...)` on top of
     * that, so a request from an employee OWNED by one branch (a roaming
     * operations employee kept on the warehouse's books, say) vanished from
     * the queue AND the count of an approver sitting in another - while
     * remaining theirs to decide. A queue that hides work its owner must do
     * is not a narrower scope, it is a lost request. So the chain's own
     * authority is the exception to the branch scope, and nothing else is:
     * a row this actor has no stage on is still refused outside their
     * branches, and still refused everywhere when the scope is empty.
     *
     * `filter_outlet_ids` is a CHOICE the user made on the screen. It can
     * only ever narrow what the line above already allows, so a client asking
     * for an outlet it has no rights to gets nothing rather than an error -
     * and, more importantly, gets nothing rather than the rows.
     */
    if (Array.isArray(permitted_outlet_ids)) {
      const inBranch = permitted_outlet_ids.length === 0 ? "1 = 0" : "r.outlet_id IN (?)";
      const branchParams = permitted_outlet_ids.length === 0 ? [] : [permitted_outlet_ids];
      if (authority) {
        where.push(`(${inBranch} OR ${authority.sql})`);
        params.push(...branchParams, ...authority.params);
      } else {
        where.push(inBranch);
        params.push(...branchParams);
      }
    }
    if (Array.isArray(filter_outlet_ids) && filter_outlet_ids.length > 0) {
      where.push("r.outlet_id IN (?)");
      params.push(filter_outlet_ids);
    }
    if (filter_employee_id) {
      where.push("r.requested_for_employee_id = ?");
      params.push(Number(filter_employee_id));
    }
    if (filter_designation_id) {
      where.push("ne.designation_id = ?");
      params.push(Number(filter_designation_id));
    }

    return { where: where.join(" AND "), params };
  }

  /**
   * The approval screens' rows: one request type, one status filter, the
   * actor's scope, with the employee, the outlet, the proposed punch and the
   * STORED calculation for the date joined in - so a screen can render the
   * inline detail from one query rather than one request per row.
   */
  async listApprovals(filters) {
    const { where, params } = this._approvalScope(filters);
    const limit = Number(filters.limit) > 0 ? Number(filters.limit) : 200;
    const offset = Number(filters.offset) > 0 ? Number(filters.offset) : 0;
    return this._read(
      "LIST-APPROVALS",
      `SELECT r.attendance_approval_request_id, r.request_type, r.status,
              r.requested_for_employee_id, ne.employee_name,
              r.requested_by_employee_id,
              DATE_FORMAT(r.attendance_date, '%Y-%m-%d') AS attendance_date,
              r.outlet_id, o.outlet_name, r.reason,
              r.candidate_ot_minutes, r.approved_ot_minutes,
              r.current_stage_no, r.total_stages, r.finalization_state,
              r.closure_reason, r.auto_created, r.chain_source,
              s.approver_employee_id AS current_stage_approver_employee_id,
              DATE_FORMAT(r.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
              DATE_FORMAT(r.decided_at, '%Y-%m-%d %H:%i:%s') AS decided_at,
              DATE_FORMAT(p.punch_time, '%Y-%m-%d %H:%i:%s') AS proposed_punch_time,
              c.shift_snapshot, c.effective_punches, c.nrm_minutes, c.worked_minutes,
              c.shortage_minutes, c.candidate_ot_minutes AS stored_candidate_ot_minutes,
              c.status AS stored_status, ws.shift_name,
              c.base_nrm_minutes, c.regular_minutes,
              -- SHIFT_CHANGE: the shift asked for and the permanent one it
              -- would stand in for, named from the master so the queue can be
              -- read without a second query per row.
              r.requested_work_shift_id, r.base_work_shift_id,
              rws.shift_code AS requested_shift_code, rws.shift_name AS requested_shift_name,
              bws.shift_code AS base_shift_code, bws.shift_name AS base_shift_name,
              ne.designation_id
         FROM attendance_approval_request r
         JOIN attendance_approval_step s
           ON s.attendance_approval_request_id = r.attendance_approval_request_id
          AND s.stage_no = r.current_stage_no
         LEFT JOIN new_employee ne ON ne.employee_id = r.requested_for_employee_id
         LEFT JOIN outlets o ON o.outlet_id = r.outlet_id
         LEFT JOIN attendance_regularized_punch p
           ON p.attendance_approval_request_id = r.attendance_approval_request_id
         LEFT JOIN attendance_day_calculation c
           ON c.employee_id = r.requested_for_employee_id
          AND c.attendance_date = r.attendance_date
         LEFT JOIN work_shift ws ON ws.work_shift_id = c.work_shift_id
         LEFT JOIN work_shift rws ON rws.work_shift_id = r.requested_work_shift_id
         LEFT JOIN work_shift bws ON bws.work_shift_id = r.base_work_shift_id
        WHERE ${where}
        ORDER BY r.status = 'PENDING' DESC, r.attendance_date DESC, r.attendance_approval_request_id DESC
        LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
  }

  /** The same scope, counted - never derived from a page of rows. */
  async countApprovals(filters) {
    const { where, params } = this._approvalScope(filters);
    const rows = await this._read(
      "COUNT-APPROVALS",
      // `new_employee` is joined here as well as on the list, and for one
      // reason only: the designation filter is a predicate on it, and a count
      // that could not express the same predicate as the list would be a
      // count of something else.
      `SELECT COUNT(*) AS n
         FROM attendance_approval_request r
         JOIN attendance_approval_step s
           ON s.attendance_approval_request_id = r.attendance_approval_request_id
          AND s.stage_no = r.current_stage_no
         LEFT JOIN new_employee ne ON ne.employee_id = r.requested_for_employee_id
        WHERE ${where}`,
      params
    );
    return rows && rows[0] ? Number(rows[0].n) : 0;
  }

  /** Every step of these requests, with the decider's name, one query. */
  async listStepsForRequests(requestIds) {
    if (!Array.isArray(requestIds) || requestIds.length === 0) return [];
    return this._read(
      "LIST-STEPS-FOR-REQUESTS",
      `SELECT s.attendance_approval_request_id, s.attendance_approval_step_id,
              s.stage_no, s.approver_role, s.outlet_id, s.decision,
              s.approver_employee_id, s.approval_level, a.employee_name AS approver_name,
              s.decided_by_employee_id, d.employee_name AS decided_by_name,
              DATE_FORMAT(s.decided_at, '%Y-%m-%d %H:%i:%s') AS decided_at,
              s.remarks, s.acted_as_admin_override
         FROM attendance_approval_step s
         LEFT JOIN new_employee d ON d.employee_id = s.decided_by_employee_id
         LEFT JOIN new_employee a ON a.employee_id = s.approver_employee_id
        WHERE s.attendance_approval_request_id IN (?)
        ORDER BY s.attendance_approval_request_id ASC, s.stage_no ASC`,
      [requestIds]
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
module.exports.revocationFingerprint = revocationFingerprint;
