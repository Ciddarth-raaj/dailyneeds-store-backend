const logger = require("../utils/logger");
const {
  queryAsync,
  getConnectionAsync,
  beginTransactionAsync,
  commitAsync,
  rollbackAsync,
} = require("../utils/batchInsert");

/**
 * THE HR SHIFT CHANGE BLOCK LEDGER.
 *
 * FOUR STATEMENTS AND ONE TABLE. It owns `attendance_shift_change_block` and
 * touches nothing else - no attendance row, no punch, no shift assignment, no
 * approval request and no payroll table is readable or writable from here. A
 * block gates a request that was never created; it has no business editing
 * anything the attendance engine produced.
 *
 * NOTHING IS EVER DELETED. `remove` fills the removal columns of the row that
 * is active; it does not delete it, and no statement in this file is a DELETE.
 * Block -> unblock -> block again leaves two permanent rows, and the history
 * of who did what, when and why survives every later change.
 *
 * THE DUPLICATE GUARD IS THE DATABASE'S. `uq_ascb_active_per_employee_date`
 * spans the generated `active_block` column, so a second active block for one
 * employee/date cannot be inserted whatever two concurrent callers do. This
 * file's job is to turn that refusal into a business answer rather than a raw
 * `ER_DUP_ENTRY` - see `create` below.
 *
 * ================== THE CROSS-TABLE RACE, AND THE LOCK THAT CLOSES IT =====
 *
 * The unique key stops two BLOCKS racing each other. It cannot stop a block
 * racing the EMPLOYEE'S OWN SUBMIT, because those write different tables:
 *
 *   HR       checks "no open request"  -> passes
 *   employee checks "no active block"  -> passes
 *   employee inserts the request
 *   HR       inserts the block
 *   =        a PENDING request AND an active block. Forbidden.
 *
 * Both writers therefore serialize on ONE deterministic row - the employee's
 * own `new_employee` row, taken with `SELECT ... FOR UPDATE` as the FIRST
 * statement of the transaction, BEFORE either side reads what it is checking
 * for. Whoever takes it goes first; the other waits, then re-reads and sees
 * the committed truth. See `SHARED_LOCK_SQL` below and the matching lock in
 * `repository/attendance_regularization.js#createRequest`.
 *
 * WHY THE EMPLOYEE ROW AND NOT THE BLOCK ROWS. The pair being coordinated
 * usually has NO row in either table yet, and `FOR UPDATE` over an empty range
 * takes a GAP lock: two transactions can both hold one and then deadlock on
 * each other's insert-intention. The employee row always exists, so the lock
 * is a single record lock - no gaps, no deadlock, and the same one for both
 * paths. `new_employee` is already the row-lock point for four repositories
 * (employee master, lifecycle, and the two Telegram ones), so this introduces
 * no new lock target.
 *
 * LOCK ORDER, WHICH IS THE WHOLE DEADLOCK STORY: `new_employee` FIRST, then
 * `attendance_shift_change_block` and `attendance_approval_request`. Both
 * paths do it in that order and nothing in this repository takes them in the
 * other. Anything added later must keep to it.
 *
 * THE COST, STATED: this serializes SHIFT CHANGE writes for one employee -
 * their own submit and HR's block cannot proceed at the same instant. It does
 * not serialize different employees, and it deliberately does not touch
 * REGULARIZATION or OT requests, which are a different claim and race nothing
 * here.
 *
 * NO `SELECT *`. Every column is named. Every date leaves as TEXT through
 * DATE_FORMAT - the API pool sets no `dateStrings`, so a bare DATE would
 * arrive as a JS Date built at local midnight and every bound would move a day
 * in IST.
 */

/** MySQL's duplicate-key error, which here means "somebody blocked it first". */
const DUPLICATE_KEY = "ER_DUP_ENTRY";

/**
 * THE SHARED SERIALIZATION POINT for shift-change writes about one employee.
 *
 * Exported so the request path locks the IDENTICAL row with the IDENTICAL
 * statement - a second, subtly different lock would serialize nothing. It is
 * always the first statement in the transaction.
 */
const SHARED_LOCK_SQL = `SELECT employee_id
         FROM new_employee
        WHERE employee_id = ?
        FOR UPDATE`;

/** The columns every read of a block returns, named once. */
const BLOCK_COLUMNS = `attendance_shift_change_block_id,
              employee_id,
              DATE_FORMAT(attendance_date, '%Y-%m-%d') AS attendance_date,
              outlet_id,
              reason,
              blocked_by_employee_id,
              blocked_by_user_id,
              DATE_FORMAT(blocked_at, '%Y-%m-%d %H:%i:%s') AS blocked_at,
              removed_by_employee_id,
              removed_by_user_id,
              DATE_FORMAT(removed_at, '%Y-%m-%d %H:%i:%s') AS removed_at,
              removal_reason`;

class AttendanceShiftChangeBlockRepository {
  constructor(db) {
    this.db = db;
  }

  _log(code, err, ref = {}) {
    logger.Log({
      level: logger.LEVEL.ERROR,
      component: "REPOSITORY.ATTENDANCE_SHIFT_CHANGE_BLOCK",
      code: `REPOSITORY.ATTENDANCE_SHIFT_CHANGE_BLOCK.${code}`,
      description: err.toString(),
      category: "",
      ref,
    });
  }

  _query(code, sql, params, { rethrowDuplicate = false } = {}) {
    return new Promise((resolve, reject) => {
      this.db.query(sql, params, (err, rows) => {
        if (err) {
          // A duplicate active block is an ORDINARY OUTCOME, not a fault: two
          // HR users pressed the button on the same row. It is handed back
          // unlogged so the usecase can say so kindly.
          if (rethrowDuplicate && err && err.code === DUPLICATE_KEY) {
            resolve({ duplicate: true });
            return;
          }
          this._log(code, err);
          reject(err);
          return;
        }
        resolve(rows || []);
      });
    });
  }

  /* --------------------------------------------------------- the reads */

  /**
   * The ACTIVE block for one employee/date, or null.
   *
   * The single-request path's read: `raiseShiftChangeRequest` and the write
   * usecase both ask this before acting.
   */
  async findActive(employeeId, attendanceDate) {
    const rows = await this._query(
      "FIND-ACTIVE",
      `SELECT ${BLOCK_COLUMNS}
         FROM attendance_shift_change_block
        WHERE employee_id = ?
          AND attendance_date = ?
          AND removed_at IS NULL
        LIMIT 1`,
      [employeeId, attendanceDate]
    );
    return rows.length > 0 ? rows[0] : null;
  }

  /**
   * Every ACTIVE block for a whole population over a window, in ONE statement.
   *
   * THE REPORT'S READ, AND THE REASON IT HAS NO N+1. A date-range report over
   * a multi-outlet population is thousands of (employee, date) pairs, and
   * asking this table once per pair is exactly the fault the report was built
   * to avoid. `IN (?)` with a BETWEEN uses `idx_ascb_employee_date`, and the
   * usecase indexes the result in memory.
   */
  async listActiveForPopulation({ employee_ids, from_date, to_date }) {
    if (!Array.isArray(employee_ids) || employee_ids.length === 0) return [];
    return this._query(
      "LIST-ACTIVE-FOR-POPULATION",
      `SELECT b.attendance_shift_change_block_id,
              b.employee_id,
              DATE_FORMAT(b.attendance_date, '%Y-%m-%d') AS attendance_date,
              b.outlet_id,
              b.reason,
              b.blocked_by_employee_id,
              b.blocked_by_user_id,
              DATE_FORMAT(b.blocked_at, '%Y-%m-%d %H:%i:%s') AS blocked_at,
              actor.employee_name AS blocked_by_employee_name
         FROM attendance_shift_change_block b
         LEFT JOIN new_employee actor ON actor.employee_id = b.blocked_by_employee_id
        WHERE b.employee_id IN (?)
          AND b.attendance_date BETWEEN ? AND ?
          AND b.removed_at IS NULL`,
      [employee_ids, from_date, to_date]
    );
  }

  /**
   * The full history for one employee/date, newest first - active and removed
   * alike. Nothing is filtered out: that is what makes it a history.
   */
  async listHistory(employeeId, attendanceDate) {
    return this._query(
      "LIST-HISTORY",
      `SELECT ${BLOCK_COLUMNS}
         FROM attendance_shift_change_block
        WHERE employee_id = ?
          AND attendance_date = ?
        ORDER BY attendance_shift_change_block_id DESC`,
      [employeeId, attendanceDate]
    );
  }

  /**
   * THE EMPLOYEE, AS THE SERVER KNOWS THEM RIGHT NOW - for authorization.
   *
   * `store_id` read here is the ONLY branch fact the write paths trust. Not
   * the report row the browser is holding, not a field in the request body,
   * and not the `outlet_id` snapshot on an existing block row: a transfer
   * since the block was made must change who may act on it, and only a live
   * read says so.
   *
   * Named columns, no `SELECT *`, and nothing sensitive: an id, a name and a
   * branch are all an authorization decision needs.
   */
  async getEmployeeForBlock(employeeId) {
    const rows = await this._query(
      "GET-EMPLOYEE-FOR-BLOCK",
      `SELECT ne.employee_id, ne.employee_name, ne.store_id,
              o.outlet_name
         FROM new_employee ne
         LEFT JOIN outlets o ON o.outlet_id = ne.store_id
        WHERE ne.employee_id = ?
        LIMIT 1`,
      [employeeId]
    );
    return rows.length > 0 ? rows[0] : null;
  }

  /* -------------------------------------------------------- the writes */

  /**
   * CLAIM the block for this employee/date.
   *
   * THE UNIQUE KEY IS THE CLAIM. Two HR users acting on the same row at the
   * same instant both reach this INSERT; the database lets exactly one
   * through and refuses the other with `ER_DUP_ENTRY`, which comes back as
   * `{duplicate: true}` rather than as an exception. The caller turns that
   * into "already blocked", which is the truth and is what the second user
   * should be told - never a raw SQL error.
   */
  async create({
    employee_id,
    attendance_date,
    outlet_id = null,
    reason,
    blocked_by_employee_id = null,
    blocked_by_user_id = null,
  }) {
    const connection = await getConnectionAsync(this.db);
    try {
      await beginTransactionAsync(connection);

      // 1. THE SHARED LOCK, FIRST AND ALWAYS. Until this returns, no shift
      //    change request for this employee can be inserted, because
      //    `createRequest` takes the same row before its own checks.
      await queryAsync(connection, SHARED_LOCK_SQL, [employee_id]);

      // 2. NOW the conflicting-request read is trustworthy: anything the
      //    employee committed is visible, and nothing new can arrive while we
      //    hold the lock. A PENDING request means the approval queue owns this
      //    date; an APPROVED one means it is settled. Either way a block is
      //    refused - and refused HERE, inside the transaction, rather than by
      //    a check the race could have overtaken.
      const conflicting = await queryAsync(
        connection,
        `SELECT attendance_approval_request_id, status
           FROM attendance_approval_request
          WHERE requested_for_employee_id = ?
            AND attendance_date = ?
            AND request_type = 'SHIFT_CHANGE'
            AND status IN ('PENDING', 'APPROVED')
          ORDER BY attendance_approval_request_id DESC
          LIMIT 1`,
        [employee_id, attendance_date]
      );
      if (conflicting && conflicting.length > 0) {
        await rollbackAsync(connection);
        return {
          created: false,
          duplicate: false,
          conflicting_request: {
            attendance_approval_request_id: conflicting[0].attendance_approval_request_id,
            status: conflicting[0].status,
          },
          insert_id: null,
        };
      }

      // 3. THE INSERT. The unique key over the generated `active_block`
      //    column remains the backstop for two blocks racing - the lock makes
      //    that case wait rather than collide, but the key is what guarantees
      //    it whatever happens.
      let inserted;
      try {
        inserted = await queryAsync(
          connection,
          `INSERT INTO attendance_shift_change_block
             (employee_id, attendance_date, outlet_id, reason,
              blocked_by_employee_id, blocked_by_user_id)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [employee_id, attendance_date, outlet_id, reason, blocked_by_employee_id, blocked_by_user_id]
        );
      } catch (err) {
        await rollbackAsync(connection);
        // An ORDINARY OUTCOME, not a fault: somebody blocked it first.
        if (err && err.code === DUPLICATE_KEY) {
          return { created: false, duplicate: true, insert_id: null };
        }
        throw err;
      }

      await commitAsync(connection);
      return {
        created: true,
        duplicate: false,
        insert_id: inserted && inserted.insertId ? inserted.insertId : null,
      };
    } catch (err) {
      try {
        await rollbackAsync(connection);
      } catch (rollbackErr) {
        this._log("CREATE-BLOCK-ROLLBACK", rollbackErr);
      }
      this._log("CREATE-BLOCK", err);
      throw err;
    } finally {
      if (connection && typeof connection.release === "function") connection.release();
    }
  }

  /**
   * Remove the ACTIVE block for this employee/date.
   *
   * `AND removed_at IS NULL` is the whole concurrency story: two simultaneous
   * removals both run this UPDATE, the first matches one row and the second
   * matches none, and `affectedRows` says which happened. Neither can
   * overwrite the other's actor or reason, so the history cannot be corrupted
   * by a double click - and the row that records the removal is the one that
   * actually performed it.
   *
   * IT IS AN UPDATE, NEVER A DELETE. The block stays in the table for ever,
   * now carrying who removed it, when and why.
   */
  async remove({
    employee_id,
    attendance_date,
    removed_by_employee_id = null,
    removed_by_user_id = null,
    removal_reason,
  }) {
    const result = await this._query(
      "REMOVE-BLOCK",
      `UPDATE attendance_shift_change_block
          SET removed_at = CURRENT_TIMESTAMP(3),
              removed_by_employee_id = ?,
              removed_by_user_id = ?,
              removal_reason = ?
        WHERE employee_id = ?
          AND attendance_date = ?
          AND removed_at IS NULL`,
      [removed_by_employee_id, removed_by_user_id, removal_reason, employee_id, attendance_date]
    );
    const affected = result && result.affectedRows !== undefined ? Number(result.affectedRows) : 0;
    return { removed: affected > 0 };
  }
}

module.exports = (db) => new AttendanceShiftChangeBlockRepository(db);
module.exports.AttendanceShiftChangeBlockRepository = AttendanceShiftChangeBlockRepository;
module.exports.BLOCK_COLUMNS = BLOCK_COLUMNS;
module.exports.SHARED_LOCK_SQL = SHARED_LOCK_SQL;
module.exports.DUPLICATE_KEY = DUPLICATE_KEY;
