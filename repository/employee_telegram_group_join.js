const logger = require("../utils/logger");
const {
  queryAsync,
  getConnectionAsync,
  beginTransactionAsync,
  commitAsync,
  rollbackAsync,
} = require("../utils/batchInsert");
const { ATTEMPT_STATUS } = require("../constants/telegram_membership");

const TABLE = "employee_telegram_group_join_attempt";

/** A duplicate is a business outcome; anything else is a failure. */
const isDuplicateKeyError = (err) =>
  Boolean(err) && (err.code === "ER_DUP_ENTRY" || err.errno === 1062);

/**
 * Employee Telegram group JOIN ATTEMPTS - SQL only. Phase 3B.
 *
 * Every rule lives in the usecases and in `utils/telegram_membership.js`.
 * Nothing here decides whether somebody may join; it records that we asked
 * and what happened.
 *
 * ================================ NO INVITE URL IS EVER STORED =============
 *
 * Only `invite_link_hash`. The URL is a working credential - anybody holding
 * it can ask to join a real company group - and it is returned exactly once,
 * in the response to the deliberate action that created it. Telegram echoes
 * the same URL back on the join request, so a hash is enough to correlate
 * and nothing weaker is being substituted for the match.
 *
 * ============================== NO TELEGRAM USER ID IS STORED HERE =========
 *
 * The approval check reads `employee_telegram_identity`, which already owns
 * that column and already scopes it to the ACTIVE identity. A copy here
 * would be a second thing to keep in step, and the stale one would be the
 * one deciding whether to let somebody into a group.
 */
class EmployeeTelegramGroupJoinRepository {
  constructor(db) {
    this.db = db;
  }

  _log(code, err) {
    logger.Log({
      level: logger.LEVEL.ERROR,
      component: "REPOSITORY.EMPLOYEE_TELEGRAM_GROUP_JOIN",
      code: `REPOSITORY.EMPLOYEE_TELEGRAM_GROUP_JOIN.${code}`,
      description: err.toString(),
      category: "",
      ref: {},
    });
  }

  _query(code, sql, params) {
    return new Promise((resolve, reject) => {
      this.db.query(sql, params, (err, rows) => {
        if (err) {
          this._log(code, err);
          return reject(err);
        }
        resolve(rows);
      });
    });
  }

  /** `invite_link_hash` is NEVER selected - nothing outside matching needs it. */
  static _row(row) {
    if (!row) return null;
    return {
      employee_telegram_group_join_attempt_id: Number(
        row.employee_telegram_group_join_attempt_id
      ),
      employee_id: Number(row.employee_id),
      telegram_group_id: Number(row.telegram_group_id),
      status: row.status,
      expires_at: row.expires_at,
      created_at: row.created_at,
      completed_at: row.completed_at,
      concluded_at: row.concluded_at,
    };
  }

  /* --------------------------------------------------------------- reads */

  /**
   * The outstanding attempts for one employee, by group.
   *
   * EXPIRY IS APPLIED IN SQL rather than read back and filtered, so a row
   * that has timed out is never briefly treated as live by a caller that
   * forgot to check.
   */
  async getLiveAttemptsForEmployee(employeeId) {
    const rows = await this._query(
      "LIVE_FOR_EMPLOYEE",
      `SELECT employee_telegram_group_join_attempt_id, employee_id, telegram_group_id,
              status, expires_at, created_at, completed_at, concluded_at
         FROM ${TABLE}
        WHERE employee_id = ? AND status = ? AND expires_at > NOW()`,
      [employeeId, ATTEMPT_STATUS.PENDING]
    );
    const byGroup = new Map();
    for (const row of rows || []) {
      byGroup.set(Number(row.telegram_group_id), EmployeeTelegramGroupJoinRepository._row(row));
    }
    return byGroup;
  }

  /** Which groups this employee has a VERIFIED join recorded for. */
  async getJoinedGroupIds(employeeId) {
    const rows = await this._query(
      "JOINED_GROUPS",
      `SELECT DISTINCT telegram_group_id FROM ${TABLE}
        WHERE employee_id = ? AND status = ?`,
      [employeeId, ATTEMPT_STATUS.JOINED]
    );
    return new Set((rows || []).map((row) => Number(row.telegram_group_id)));
  }

  /**
   * THE ATTEMPT A JOIN REQUEST BELONGS TO, matched by the invite link's hash
   * AND the group it arrived from.
   *
   * BOTH, NOT EITHER. The hash is unique already, but binding the group into
   * the query means a link somehow replayed against a different chat cannot
   * match the attempt that was issued for this one.
   *
   * The status is NOT filtered here on purpose: an expired or superseded
   * attempt must be FOUND so the refusal can say which it was, rather than
   * looking identical to a link we never issued.
   */
  async findAttemptByInviteHash(telegramGroupId, inviteLinkHash) {
    const rows = await this._query(
      "FIND_BY_INVITE_HASH",
      `SELECT employee_telegram_group_join_attempt_id, employee_id, telegram_group_id,
              status, expires_at, created_at, completed_at, concluded_at
         FROM ${TABLE}
        WHERE telegram_group_id = ? AND invite_link_hash = ?`,
      [telegramGroupId, inviteLinkHash]
    );
    return EmployeeTelegramGroupJoinRepository._row(rows && rows[0]);
  }

  /**
   * The live attempt for one employee in one group.
   *
   * THE FALLBACK WHEN TELEGRAM SENDS NO INVITE LINK. `chat_join_request`
   * carries `invite_link` optionally, so a request can arrive with no link
   * to match on. This finds the attempt by the employee the requesting
   * Telegram user resolves to - which is a match on the VERIFIED IDENTITY,
   * the same fact the approval check turns on, rather than a weaker one.
   */
  async findLiveAttempt(employeeId, telegramGroupId) {
    const rows = await this._query(
      "FIND_LIVE",
      `SELECT employee_telegram_group_join_attempt_id, employee_id, telegram_group_id,
              status, expires_at, created_at, completed_at, concluded_at
         FROM ${TABLE}
        WHERE employee_id = ? AND telegram_group_id = ? AND status = ?`,
      [employeeId, telegramGroupId, ATTEMPT_STATUS.PENDING]
    );
    return EmployeeTelegramGroupJoinRepository._row(rows && rows[0]);
  }

  /* -------------------------------------------------------------- writes */

  /**
   * ISSUE AN ATTEMPT: supersede whatever was outstanding, then insert - in
   * ONE TRANSACTION, holding the employee row.
   *
   * WHY THE LOCK. Two Generate clicks a few milliseconds apart would
   * otherwise both supersede and both insert, leaving two live attempts and
   * two working links for one employee. The employee row is the lock
   * deliberately: locking the attempt rows would not serialize an employee
   * who has no outstanding attempt, which is exactly the case that races.
   *
   * The UNIQUE `live_marker` is still the guarantee. The lock produces a
   * good error message and an orderly queue; the index is what makes a
   * second live row impossible even if this transaction were wrong.
   */
  async issueAttempt({
    employeeId,
    telegramGroupId,
    inviteLinkHash,
    expiresAt,
    createdBy = null,
  }) {
    const connection = await getConnectionAsync(this.db);
    try {
      await beginTransactionAsync(connection);

      await queryAsync(
        connection,
        "SELECT employee_id FROM new_employee WHERE employee_id = ? FOR UPDATE",
        [employeeId]
      );

      // SUPERSEDED, NOT DELETED. "I tapped the link and it said no" is only
      // answerable if the row that stopped working is still there saying why.
      await queryAsync(
        connection,
        `UPDATE ${TABLE}
            SET status = ?, concluded_at = NOW()
          WHERE employee_id = ? AND telegram_group_id = ? AND status = ?`,
        [ATTEMPT_STATUS.SUPERSEDED, employeeId, telegramGroupId, ATTEMPT_STATUS.PENDING]
      );

      const result = await queryAsync(
        connection,
        `INSERT INTO ${TABLE}
           (employee_id, telegram_group_id, invite_link_hash, status, expires_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          employeeId,
          telegramGroupId,
          inviteLinkHash,
          ATTEMPT_STATUS.PENDING,
          expiresAt,
          createdBy,
        ]
      );

      await commitAsync(connection);
      return { employee_telegram_group_join_attempt_id: result.insertId };
    } catch (err) {
      await rollbackAsync(connection).catch(() => {});
      if (isDuplicateKeyError(err)) {
        const duplicate = new Error("A join link was just generated for this group");
        duplicate.name = "ValidationError";
        duplicate.duplicateAttempt = true;
        throw duplicate;
      }
      this._log("ISSUE_ATTEMPT", err);
      throw err;
    } finally {
      if (connection && connection.release) connection.release();
    }
  }

  /**
   * Move an attempt on, but ONLY from the status it is expected to be in.
   *
   * THE `WHERE status = ?` IS THE IDEMPOTENCY. Telegram can deliver the same
   * `chat_join_request` more than once, and a retry must not re-approve or
   * double-count: the second call matches no row, reports `changed: false`,
   * and the caller stops. A read-then-write would have both deliveries see
   * PENDING and both proceed.
   */
  async advanceStatus(attemptId, fromStatus, toStatus, { completed = false } = {}) {
    const sets = ["status = ?"];
    const params = [toStatus];
    if (completed) {
      sets.push("completed_at = COALESCE(completed_at, NOW())");
    }
    const concluding = [
      ATTEMPT_STATUS.JOINED,
      ATTEMPT_STATUS.EXPIRED,
      ATTEMPT_STATUS.SUPERSEDED,
      ATTEMPT_STATUS.FAILED,
    ].includes(toStatus);
    if (concluding) {
      sets.push("concluded_at = COALESCE(concluded_at, NOW())");
    }
    params.push(attemptId, fromStatus);

    const result = await this._query(
      "ADVANCE_STATUS",
      `UPDATE ${TABLE} SET ${sets.join(", ")}
        WHERE employee_telegram_group_join_attempt_id = ? AND status = ?`,
      params
    );
    return { changed: Boolean(result && result.affectedRows) };
  }

  /**
   * Sweep attempts whose window has closed.
   *
   * Called on read rather than by a cron: the only moment a stale PENDING
   * matters is when somebody looks at it or a request arrives against it,
   * and a job that exists only to tidy rows nobody is reading is a job that
   * can fail unnoticed for a month.
   */
  async expireOverdue(employeeId) {
    const result = await this._query(
      "EXPIRE_OVERDUE",
      `UPDATE ${TABLE}
          SET status = ?, concluded_at = COALESCE(concluded_at, NOW())
        WHERE employee_id = ? AND status = ? AND expires_at <= NOW()`,
      [ATTEMPT_STATUS.EXPIRED, employeeId, ATTEMPT_STATUS.PENDING]
    );
    return { expired: (result && result.affectedRows) || 0 };
  }
}

module.exports = (db) => new EmployeeTelegramGroupJoinRepository(db);
module.exports.EmployeeTelegramGroupJoinRepository = EmployeeTelegramGroupJoinRepository;
module.exports.TABLE = TABLE;
