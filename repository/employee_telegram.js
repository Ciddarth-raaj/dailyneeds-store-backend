const logger = require("../utils/logger");

/**
 * Rows behind employee Telegram identity, its one-time links and its audit.
 *
 * SHAPED ON `repository/passwordReset.js`, which is the closest thing in this
 * codebase and already got the hard parts right: one `run` helper with one
 * place to log a failure, hashes rather than secrets, and a CLAIM done by an
 * UPDATE rather than by reading a row and trusting it not to change.
 *
 * WHAT IS NEVER PASSED TO THE LOGGER FROM HERE. The `ref` on every call
 * carries identifiers only - an employee id, a Telegram user id. Not the
 * token, not its hash, not a mobile number. A repository that logged its own
 * parameters would undo the care taken everywhere else.
 */
class EmployeeTelegramRepository {
  constructor(db) {
    this.db = db;
  }

  run(code, sql, params, ref = {}) {
    return new Promise((resolve, reject) => {
      this.db.query(sql, params, (err, docs) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.EMPLOYEE-TELEGRAM",
            code: `REPOSITORY.EMPLOYEE-TELEGRAM.${code}`,
            description: err.toString(),
            category: "",
            ref,
          });
          reject(err);
          return;
        }
        resolve(docs);
      });
    });
  }

  /* ----------------------------------------------------------- employee */

  /**
   * The employment facts this feature is allowed to ask about, and no others.
   *
   * `status` decides eligibility and `primary_contact_number` is the number
   * the shared contact is compared against. Nothing else is read - this
   * feature has no business with a salary, an Aadhaar or an address.
   */
  async getEmployeeForVerification(employeeId) {
    const rows = await this.run(
      "GET-EMPLOYEE",
      `SELECT employee_id, status, primary_contact_number
         FROM new_employee
        WHERE employee_id = ?`,
      [employeeId],
      { employeeId }
    );
    return rows.length === 0 ? null : rows[0];
  }

  /* -------------------------------------------------------------- tokens */

  /**
   * Issue a token, retiring whatever the employee had outstanding.
   *
   * THE OLD ONE IS CONSUMED, NOT DELETED. Marking it consumed with a
   * SUPERSEDED outcome means a QR printed a minute ago stops working AND the
   * reason it stopped is still on the row - which is what makes "I scanned it
   * and nothing happened" answerable. It also kills any pending verification
   * that token had started: a fresh link must not be able to finish an older
   * half-done session.
   */
  async createLinkToken(employeeId, tokenHash, expiresAt, issuedByUserId, supersededOutcome) {
    await this.run(
      "SUPERSEDE-TOKENS",
      `UPDATE employee_telegram_link_tokens
          SET consumed_at = COALESCE(consumed_at, NOW()),
              pending_expires_at = NULL,
              pending_outcome = COALESCE(pending_outcome, ?)
        WHERE employee_id = ?
          AND (consumed_at IS NULL OR pending_expires_at IS NOT NULL)`,
      [supersededOutcome, employeeId],
      { employeeId }
    );
    return this.run(
      "CREATE-TOKEN",
      `INSERT INTO employee_telegram_link_tokens
         (token_hash, employee_id, issued_by_user_id, expires_at)
       VALUES (?, ?, ?, ?)`,
      [tokenHash, employeeId, issuedByUserId === undefined ? null : issuedByUserId, expiresAt],
      { employeeId }
    );
  }

  /**
   * Spend a token and open the pending verification, in ONE statement.
   *
   * THIS IS THE RACE, AND THIS IS WHERE IT IS SETTLED. `consumed_at IS NULL`
   * sits in the WHERE clause of the UPDATE itself, so of two `/start`s
   * arriving together - a slow first scan and an impatient second tap - MySQL
   * lets exactly one row-write win and reports `affectedRows: 1` to that
   * caller and `0` to the other. Nothing is read first and then trusted:
   * a SELECT, a check and a later UPDATE is the shape that lets both callers
   * believe they won.
   *
   * The Telegram user, chat and username are written BY THE SAME UPDATE, so
   * the winner's session is opened atomically with the claim rather than in a
   * second statement that could fail in between.
   *
   * Returns the employee id when this caller claimed it, otherwise null.
   */
  async consumeLinkToken(tokenHash, { telegramUserId, chatId, username, pendingExpiresAt }) {
    const claimed = await this.run(
      "CONSUME-TOKEN",
      `UPDATE employee_telegram_link_tokens
          SET consumed_at = NOW(),
              pending_telegram_user_id = ?,
              pending_chat_id = ?,
              pending_username = ?,
              pending_expires_at = ?
        WHERE token_hash = ?
          AND consumed_at IS NULL
          AND expires_at > NOW()`,
      [telegramUserId, chatId, username === undefined ? null : username, pendingExpiresAt, tokenHash],
      { telegramUserId }
    );
    if (!claimed || claimed.affectedRows !== 1) return null;

    const rows = await this.run(
      "READ-CLAIMED-TOKEN",
      "SELECT employee_id FROM employee_telegram_link_tokens WHERE token_hash = ?",
      [tokenHash],
      { telegramUserId }
    );
    return rows.length === 0 ? null : rows[0].employee_id;
  }

  /**
   * The live pending verification for a Telegram user, or null.
   *
   * Keyed by the TELEGRAM USER and not by the chat: the contact message that
   * completes the flow names `from.id`, and that is the identity we are
   * verifying. Newest first, so a re-issued link is what answers rather than
   * an older abandoned attempt.
   */
  async getPendingByTelegramUser(telegramUserId) {
    const rows = await this.run(
      "GET-PENDING",
      `SELECT token_hash, employee_id, pending_telegram_user_id, pending_chat_id,
              pending_username, pending_expires_at
         FROM employee_telegram_link_tokens
        WHERE pending_telegram_user_id = ?
          AND pending_outcome IS NULL
          AND pending_expires_at IS NOT NULL
          AND pending_expires_at > NOW()
        ORDER BY consumed_at DESC
        LIMIT 1`,
      [telegramUserId],
      { telegramUserId }
    );
    return rows.length === 0 ? null : rows[0];
  }

  /** The employee's most recent pending row, live or finished - for the status read. */
  async getLatestPendingForEmployee(employeeId) {
    const rows = await this.run(
      "GET-PENDING-EMPLOYEE",
      `SELECT token_hash, employee_id, pending_outcome, pending_expires_at, consumed_at, created_at
         FROM employee_telegram_link_tokens
        WHERE employee_id = ?
        ORDER BY created_at DESC
        LIMIT 1`,
      [employeeId],
      { employeeId }
    );
    return rows.length === 0 ? null : rows[0];
  }

  /**
   * Close a pending verification with its reason.
   *
   * `pending_outcome IS NULL` in the WHERE clause again: a session is closed
   * once, so two contact messages racing cannot both be the one that decided.
   */
  async closePending(tokenHash, outcome) {
    const closed = await this.run(
      "CLOSE-PENDING",
      `UPDATE employee_telegram_link_tokens
          SET pending_outcome = ?, pending_expires_at = NULL
        WHERE token_hash = ? AND pending_outcome IS NULL`,
      [outcome, tokenHash],
      {}
    );
    return Boolean(closed && closed.affectedRows === 1);
  }

  /* ------------------------------------------------------------ identity */

  /** The employee's live identity, or null. History rows are never returned here. */
  async getActiveIdentityByEmployee(employeeId) {
    const rows = await this.run(
      "GET-IDENTITY",
      `SELECT employee_telegram_id, employee_id, telegram_user_id, private_chat_id,
              telegram_username, connected_at
         FROM employee_telegram_identity
        WHERE employee_id = ? AND disconnected_at IS NULL`,
      [employeeId],
      { employeeId }
    );
    return rows.length === 0 ? null : rows[0];
  }

  /** Which employee, if any, this Telegram account is currently attached to. */
  async getActiveIdentityByTelegramUser(telegramUserId) {
    const rows = await this.run(
      "GET-IDENTITY-BY-TELEGRAM",
      `SELECT employee_telegram_id, employee_id, telegram_user_id
         FROM employee_telegram_identity
        WHERE telegram_user_id = ? AND disconnected_at IS NULL`,
      [telegramUserId],
      { telegramUserId }
    );
    return rows.length === 0 ? null : rows[0];
  }

  /** Retire an employee's live identity, so a new one can take its place. */
  async disconnectActiveIdentity(employeeId, reason) {
    const done = await this.run(
      "DISCONNECT-IDENTITY",
      `UPDATE employee_telegram_identity
          SET disconnected_at = NOW(), disconnect_reason = ?
        WHERE employee_id = ? AND disconnected_at IS NULL`,
      [reason, employeeId],
      { employeeId }
    );
    return done && done.affectedRows ? done.affectedRows : 0;
  }

  /**
   * Create the live identity. Only ever called once a mobile has MATCHED.
   *
   * The three unique keys in the schema are what actually enforce one active
   * identity per employee, per Telegram account and per chat; this insert
   * simply lets them do it, and the usecase turns the resulting driver error
   * into a sentence.
   */
  async createIdentity({ employeeId, telegramUserId, chatId, username, verifiedMobile }) {
    return this.run(
      "CREATE-IDENTITY",
      `INSERT INTO employee_telegram_identity
         (employee_id, telegram_user_id, private_chat_id, telegram_username,
          verified_mobile, connected_at)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [employeeId, telegramUserId, chatId, username === undefined ? null : username, verifiedMobile],
      { employeeId, telegramUserId }
    );
  }

  /* --------------------------------------------------------------- audit */

  /**
   * Record one event. IDENTIFIERS ONLY - the table has nowhere to put a
   * secret, which is the point.
   *
   * NEVER THROWS. An audit failure must not be able to change what happened to
   * an employee's Telegram setup, exactly as `PasswordResetUsecase.audit`
   * swallows its own failures.
   */
  async audit({ employeeId = null, event, telegramUserId = null, actorUserId = null, detail = null }) {
    try {
      await this.run(
        "AUDIT",
        `INSERT INTO employee_telegram_audit
           (employee_id, event, telegram_user_id, actor_user_id, detail)
         VALUES (?, ?, ?, ?, ?)`,
        [employeeId, event, telegramUserId, actorUserId, detail],
        { employeeId, event }
      );
    } catch (err) {
      // already logged by run(); an audit write is never load-bearing
    }
  }
}

module.exports = (db) => new EmployeeTelegramRepository(db);
module.exports.EmployeeTelegramRepository = EmployeeTelegramRepository;
