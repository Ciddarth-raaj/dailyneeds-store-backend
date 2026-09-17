const logger = require("../utils/logger");
const {
  queryAsync,
  getConnectionAsync,
  beginTransactionAsync,
  commitAsync,
  rollbackAsync,
} = require("../utils/batchInsert");
const {
  CLAIM_SOURCE,
  CLAIM_STATE,
  CLOSE_OUTCOME,
} = require("../constants/telegram_membership_claim");

const TABLE = "employee_telegram_group_membership";
const EVENTS = "employee_telegram_group_membership_event";

/**
 * MANAGED MEMBERSHIP CLAIMS - SQL only. Phase 3C.
 *
 * EVERY TRANSITION IS A CONDITIONAL UPDATE. `WHERE state = <expected>` is
 * what makes a duplicate job a no-op instead of a second decision: the
 * second delivery matches no row and reports `changed: false`, exactly as
 * Phase 3B's `advanceStatus` does for join attempts.
 *
 * `tx` IS OPTIONAL THROUGHOUT. Given one - the `{query}` object both
 * `repository/employee_master.js` and `repository/employee_lifecycle.js`
 * already produce - every statement joins the caller's transaction, which is
 * how a claim change and the queue row that will act on it commit together.
 * Without one it runs on the pool.
 */
class TelegramMembershipClaimRepository {
  constructor(db) {
    this.db = db;
  }

  _log(code, err) {
    logger.Log({
      level: logger.LEVEL.ERROR,
      component: "REPOSITORY.TELEGRAM_MEMBERSHIP_CLAIM",
      code: `REPOSITORY.TELEGRAM_MEMBERSHIP_CLAIM.${code}`,
      description: err.toString(),
      category: "",
      ref: {},
    });
  }

  _query(code, sql, params, tx) {
    if (tx) return tx.query(sql, params);
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

  static _row(row) {
    if (!row) return null;
    return {
      employee_telegram_group_membership_id: Number(row.employee_telegram_group_membership_id),
      employee_id: Number(row.employee_id),
      telegram_group_id: Number(row.telegram_group_id),
      source: row.source,
      state: row.state,
      intent_reason: row.intent_reason || null,
      close_outcome: row.close_outcome || null,
      adopted_from_existing_member: Boolean(row.adopted_from_existing_member),
      removal_requested_at: row.removal_requested_at || null,
      closed_at: row.closed_at || null,
      created_at: row.created_at || null,
      updated_at: row.updated_at || null,
    };
  }

  /**
   * One transaction on one pooled connection, the same `{query}` shape every
   * other repository here produces - so the queue repository can be handed
   * the same `tx` and a claim, its audit row and the job that will act on it
   * commit together or not at all.
   */
  async withTransaction(fn) {
    const connection = await getConnectionAsync(this.db);
    const tx = { query: (sql, params) => queryAsync(connection, sql, params) };
    try {
      await beginTransactionAsync(connection);
      const result = await fn(tx);
      await commitAsync(connection);
      return result;
    } catch (err) {
      await rollbackAsync(connection);
      this._log("TRANSACTION", err);
      throw err;
    } finally {
      connection.release();
    }
  }

  /* ------------------------------------------------------------- reads -- */

  /** Every claim for one employee, live and closed. */
  async getForEmployee(employeeId, { tx, forUpdate = false } = {}) {
    const rows = await this._query(
      "FOR-EMPLOYEE",
      `SELECT * FROM ${TABLE} WHERE employee_id = ?${forUpdate ? " FOR UPDATE" : ""}`,
      [Number(employeeId)],
      tx
    );
    return (rows || []).map(TelegramMembershipClaimRepository._row);
  }

  /** Every LIVE claim in one group, both sources. */
  async getLiveForGroup(telegramGroupId, { tx } = {}) {
    const rows = await this._query(
      "LIVE-FOR-GROUP",
      `SELECT * FROM ${TABLE}
        WHERE telegram_group_id = ? AND state IN ('ACTIVE','REMOVAL_PENDING')`,
      [Number(telegramGroupId)],
      tx
    );
    return (rows || []).map(TelegramMembershipClaimRepository._row);
  }

  /**
   * THE GROUPS A MANUAL GRANT PUTS AN EMPLOYEE IN, shaped exactly like the
   * group object `getAllMappingsWithGroups()` returns, so Phase 3B's
   * `requiredGroups()` can union the two without knowing which is which.
   */
  async getManualActiveGroups(employeeId) {
    const rows = await this._query(
      "MANUAL-ACTIVE-GROUPS",
      `SELECT g.telegram_group_id, g.group_name, g.chat_id, g.category, g.used_for,
              g.outlet_id, g.bot_is_admin, g.is_active
         FROM ${TABLE} m
         JOIN telegram_group_registry g ON g.telegram_group_id = m.telegram_group_id
        WHERE m.employee_id = ? AND m.source = ? AND m.state = ?
        ORDER BY g.group_name ASC`,
      [Number(employeeId), CLAIM_SOURCE.MANUAL, CLAIM_STATE.ACTIVE]
    );
    return (rows || []).map((row) => ({
      telegram_group_id: Number(row.telegram_group_id),
      group_name: row.group_name,
      chat_id: String(row.chat_id),
      category: row.category,
      used_for: row.used_for,
      outlet_id:
        row.outlet_id === null || row.outlet_id === undefined ? null : Number(row.outlet_id),
      bot_is_admin: Boolean(row.bot_is_admin),
      is_active: Boolean(row.is_active),
    }));
  }

  /** Employee ids with any live claim - used by the recovery sweep. */
  async getEmployeeIdsWithLiveClaims() {
    const rows = await this._query(
      "EMPLOYEES-WITH-LIVE-CLAIMS",
      `SELECT DISTINCT employee_id FROM ${TABLE} WHERE state IN ('ACTIVE','REMOVAL_PENDING')`,
      []
    );
    return (rows || []).map((r) => Number(r.employee_id));
  }

  /** Employee ids stuck in REMOVAL_PENDING - the sweep re-enqueues these. */
  async getEmployeeIdsAwaitingRemoval() {
    const rows = await this._query(
      "EMPLOYEES-AWAITING-REMOVAL",
      `SELECT DISTINCT employee_id FROM ${TABLE} WHERE state = ?`,
      [CLAIM_STATE.REMOVAL_PENDING]
    );
    return (rows || []).map((r) => Number(r.employee_id));
  }

  /**
   * Names for a screen, for ids we already hold. Name only - a membership
   * screen has no business with a mobile number or a Telegram handle.
   */
  async describeEmployees(employeeIds) {
    const ids = [...new Set((employeeIds || []).map(Number).filter(Number.isInteger))];
    if (!ids.length) return new Map();
    const rows = await this._query(
      "DESCRIBE-EMPLOYEES",
      `SELECT employee_id, employee_name FROM new_employee WHERE employee_id IN (?)`,
      [ids]
    );
    return new Map((rows || []).map((row) => [Number(row.employee_id), row.employee_name]));
  }

  /** How many live claims block a registry hard delete. */
  async countLiveForGroup(telegramGroupId, { tx } = {}) {
    const rows = await this._query(
      "COUNT-LIVE-FOR-GROUP",
      `SELECT COUNT(*) AS n FROM ${TABLE}
        WHERE telegram_group_id = ? AND state IN ('ACTIVE','REMOVAL_PENDING')`,
      [Number(telegramGroupId)],
      tx
    );
    return rows && rows[0] ? Number(rows[0].n) : 0;
  }

  /* ------------------------------------------------------------ writes -- */

  /**
   * OPEN OR REOPEN, on the natural key.
   *
   * The unique triple means a claim is re-opened IN PLACE - a second row for
   * the same employee, group and source cannot exist, so a person who
   * becomes eligible again reuses the row that recorded them leaving. The
   * upsert also clears the removal intent, because an open claim has none.
   */
  async open({ employeeId, telegramGroupId, source, actorEmployeeId = null }, { tx } = {}) {
    const res = await this._query(
      "OPEN",
      `INSERT INTO ${TABLE}
         (employee_id, telegram_group_id, source, state, created_by, updated_by)
       VALUES (?, ?, ?, '${CLAIM_STATE.ACTIVE}', ?, ?)
       ON DUPLICATE KEY UPDATE
         state = '${CLAIM_STATE.ACTIVE}',
         intent_reason = NULL,
         close_outcome = NULL,
         removal_requested_at = NULL,
         closed_at = NULL,
         updated_by = VALUES(updated_by)`,
      [Number(employeeId), Number(telegramGroupId), source, actorEmployeeId, actorEmployeeId],
      tx
    );
    // affectedRows: 1 = inserted, 2 = updated an existing row, 0 = unchanged.
    return { changed: Boolean(res && res.affectedRows), reopened: Boolean(res && res.affectedRows === 2) };
  }

  /** ACTIVE -> REMOVAL_PENDING. Conditional, so a repeat changes nothing. */
  async requestRemoval(
    { employeeId, telegramGroupId, source, intentReason, actorEmployeeId = null },
    { tx } = {}
  ) {
    const res = await this._query(
      "REQUEST-REMOVAL",
      `UPDATE ${TABLE}
          SET state = '${CLAIM_STATE.REMOVAL_PENDING}',
              intent_reason = ?, removal_requested_at = NOW(), updated_by = ?
        WHERE employee_id = ? AND telegram_group_id = ? AND source = ?
          AND state = '${CLAIM_STATE.ACTIVE}'`,
      [intentReason, actorEmployeeId, Number(employeeId), Number(telegramGroupId), source],
      tx
    );
    return { changed: Boolean(res && res.affectedRows) };
  }

  /**
   * REMOVAL_PENDING -> ACTIVE. Eligibility returned before cleanup ran, so
   * the intent is cancelled and nobody is kicked for a change that undid
   * itself.
   */
  async cancelRemoval({ employeeId, telegramGroupId, source, actorEmployeeId = null }, { tx } = {}) {
    const res = await this._query(
      "CANCEL-REMOVAL",
      `UPDATE ${TABLE}
          SET state = '${CLAIM_STATE.ACTIVE}', intent_reason = NULL,
              removal_requested_at = NULL, updated_by = ?
        WHERE employee_id = ? AND telegram_group_id = ? AND source = ?
          AND state = '${CLAIM_STATE.REMOVAL_PENDING}'`,
      [actorEmployeeId, Number(employeeId), Number(telegramGroupId), source],
      tx
    );
    return { changed: Boolean(res && res.affectedRows) };
  }

  /**
   * -> CLOSED. `fromStates` is the guard: closing after a confirmed removal
   * allows only REMOVAL_PENDING, while the retained-by-other-source close
   * happens straight from ACTIVE.
   */
  async close(
    {
      employeeId,
      telegramGroupId,
      source,
      closeOutcome,
      intentReason = null,
      fromStates = [CLAIM_STATE.REMOVAL_PENDING],
      actorEmployeeId = null,
    },
    { tx } = {}
  ) {
    const placeholders = fromStates.map(() => "?").join(",");
    const res = await this._query(
      "CLOSE",
      `UPDATE ${TABLE}
          SET state = '${CLAIM_STATE.CLOSED}', close_outcome = ?,
              intent_reason = COALESCE(?, intent_reason),
              closed_at = NOW(), updated_by = ?
        WHERE employee_id = ? AND telegram_group_id = ? AND source = ?
          AND state IN (${placeholders})`,
      [
        closeOutcome,
        intentReason,
        actorEmployeeId,
        Number(employeeId),
        Number(telegramGroupId),
        source,
        ...fromStates,
      ],
      tx
    );
    return { changed: Boolean(res && res.affectedRows) };
  }

  /** Records that they were already in the group when we first claimed it. */
  async markAdopted({ employeeId, telegramGroupId, source }, { tx } = {}) {
    const res = await this._query(
      "MARK-ADOPTED",
      `UPDATE ${TABLE} SET adopted_from_existing_member = 1
        WHERE employee_id = ? AND telegram_group_id = ? AND source = ?
          AND adopted_from_existing_member = 0`,
      [Number(employeeId), Number(telegramGroupId), source],
      tx
    );
    return { changed: Boolean(res && res.affectedRows) };
  }

  /* ------------------------------------------------------------ events -- */

  /**
   * TYPED AUDIT ONLY. Every argument is a number we own or a value from a
   * closed vocabulary; there is no free-text parameter to pass an error
   * message, a chat id or an invite URL into.
   */
  async recordEvent(
    {
      employeeId,
      telegramGroupId = null,
      source = null,
      employeeTelegramId = null,
      eventType,
      detailCode = null,
      jobId = null,
      actorEmployeeId = null,
    },
    { tx } = {}
  ) {
    await this._query(
      "RECORD-EVENT",
      `INSERT INTO ${EVENTS}
         (employee_id, telegram_group_id, source, employee_telegram_id,
          event_type, detail_code, telegram_membership_job_id, actor_employee_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        Number(employeeId),
        telegramGroupId === null ? null : Number(telegramGroupId),
        source,
        employeeTelegramId === null ? null : Number(employeeTelegramId),
        eventType,
        detailCode,
        jobId === null ? null : Number(jobId),
        actorEmployeeId === null ? null : Number(actorEmployeeId),
      ],
      tx
    );
  }

  /** The history one employee's record shows. Newest first, bounded. */
  async getEventsForEmployee(employeeId, { limit = 100 } = {}) {
    const rows = await this._query(
      "EVENTS-FOR-EMPLOYEE",
      `SELECT e.*, g.group_name
         FROM ${EVENTS} e
         LEFT JOIN telegram_group_registry g ON g.telegram_group_id = e.telegram_group_id
        WHERE e.employee_id = ?
        ORDER BY e.created_at DESC, e.employee_telegram_group_membership_event_id DESC
        LIMIT ?`,
      [Number(employeeId), Number(limit)]
    );
    return (rows || []).map((row) => ({
      event_type: row.event_type,
      detail_code: row.detail_code || null,
      source: row.source || null,
      telegram_group_id:
        row.telegram_group_id === null ? null : Number(row.telegram_group_id),
      group_name: row.group_name || null,
      created_at: row.created_at,
    }));
  }
}

module.exports = (db) => new TelegramMembershipClaimRepository(db);
module.exports.TelegramMembershipClaimRepository = TelegramMembershipClaimRepository;
module.exports.CLOSE_OUTCOME = CLOSE_OUTCOME;
