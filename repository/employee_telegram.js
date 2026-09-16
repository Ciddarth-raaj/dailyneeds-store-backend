const logger = require("../utils/logger");
const {
  queryAsync,
  getConnectionAsync,
  beginTransactionAsync,
  commitAsync,
  rollbackAsync,
} = require("../utils/batchInsert");

/**
 * MySQL's own name for a unique-key violation.
 *
 * A DUPLICATE IS A BUSINESS OUTCOME; ANYTHING ELSE IS A FAILURE. Treating
 * every insert error as "already connected" would tell an employee their
 * account belongs to somebody else because a network blipped, and would hide
 * a real database problem behind a plausible sentence.
 */
const DUPLICATE_KEY = "ER_DUP_ENTRY";
const isDuplicateKeyError = (err) =>
  Boolean(err) && (err.code === DUPLICATE_KEY || err.errno === 1062);

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
      // THE DATED FACTS, NOT JUST `status`. `new_employee.status` is
      // maintained by hand and has been left at 1 for most leavers - the
      // reason `utils/attendance_eligibility.js` refuses to read it at all -
      // so "is this person employed today" is decided from the joining and
      // resignation dates, which is what payroll and attendance already do.
      // Formatted as YYYY-MM-DD so the shared rule can compare them as text.
      `SELECT employee_id,
              status,
              primary_contact_number,
              DATE_FORMAT(date_of_joining, '%Y-%m-%d')  AS date_of_joining,
              DATE_FORMAT(resignation_date, '%Y-%m-%d') AS resignation_date
         FROM new_employee
        WHERE employee_id = ?`,
      [employeeId],
      { employeeId }
    );
    return rows.length === 0 ? null : rows[0];
  }

  /* -------------------------------------------------------------- tokens */

  /**
   * Issue a token, retiring whatever the employee had outstanding - as ONE
   * serialized unit per employee.
   *
   * ================================ WHY THIS IS A TRANSACTION ==============
   *
   * The rule is that a fresh QR invalidates the previous one, and as two
   * independent statements it did not hold. Two managers - or one manager
   * double-clicking - could interleave:
   *
   *     A supersedes the outstanding tokens
   *     B supersedes the outstanding tokens (there are none left)
   *     A inserts token A
   *     B inserts token B
   *
   * leaving TWO live QR codes for one employee, either of which would work.
   *
   * `SELECT … FOR UPDATE` ON THE EMPLOYEE ROW IS THE SERIALIZATION. Locking
   * the employee is what makes "supersede, then insert" indivisible for that
   * employee: the second issuer waits at the SELECT until the first commits,
   * and then supersedes the token the first just wrote. Locking the token
   * rows instead would not do it - when an employee has no outstanding token
   * there are no rows to lock, which is exactly the case that races.
   *
   * IT LOCKS ONE ROW, BRIEFLY, AND ONLY FOR ISSUANCE. Nothing else in this
   * feature locks `new_employee`, and issuing a link is a deliberate human
   * action a few times per employee, so this cannot become contention on the
   * employee master.
   */
  async createLinkToken(employeeId, tokenHash, expiresAt, issuedByUserId, supersededOutcome) {
    const connection = await getConnectionAsync(this.db);
    try {
      await beginTransactionAsync(connection);

      // The lock. The row is read for no other reason - `employedOn` was
      // already decided by the usecase before we got here.
      await queryAsync(
        connection,
        "SELECT employee_id FROM new_employee WHERE employee_id = ? FOR UPDATE",
        [employeeId]
      );

      // Retire what is outstanding. CONSUMED, NOT DELETED: a QR printed a
      // minute ago stops working and the reason it stopped is still on the
      // row, which is what makes "I scanned it and nothing happened"
      // answerable. It also kills any pending verification that token had
      // started - a fresh link must not be able to finish an older half-done
      // session.
      await queryAsync(
        connection,
        `UPDATE employee_telegram_link_tokens
            SET consumed_at = COALESCE(consumed_at, NOW()),
                pending_expires_at = NULL,
                pending_outcome = COALESCE(pending_outcome, ?)
          WHERE employee_id = ?
            AND (consumed_at IS NULL OR pending_expires_at IS NOT NULL)`,
        [supersededOutcome, employeeId]
      );

      await queryAsync(
        connection,
        `INSERT INTO employee_telegram_link_tokens
           (token_hash, employee_id, issued_by_user_id, expires_at)
         VALUES (?, ?, ?, ?)`,
        [tokenHash, employeeId, issuedByUserId === undefined ? null : issuedByUserId, expiresAt]
      );

      await commitAsync(connection);
      return { issued: true };
    } catch (err) {
      await rollbackAsync(connection);
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "REPOSITORY.EMPLOYEE-TELEGRAM",
        code: "REPOSITORY.EMPLOYEE-TELEGRAM.CREATE-TOKEN",
        description: err.toString(),
        category: "",
        ref: { employeeId },
      });
      throw err;
    } finally {
      if (connection && typeof connection.release === "function") connection.release();
    }
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
   * FINISH THE VERIFICATION - atomically, or not at all.
   *
   * ============================ WHY THIS IS ONE TRANSACTION =================
   *
   * The steps used to be four separate statements: read the pending row, mark
   * it, disconnect the old identity, insert the new one. Two copies of the
   * same contact message - Telegram retries, or an employee tapping twice -
   * could both read the SAME still-open pending row, and then:
   *
   *   caller A inserts the identity
   *   caller B runs the reconnect disconnect and RETIRES WHAT A JUST CREATED
   *   caller B inserts a second one
   *
   * and worse, the reconnect disconnect happened BEFORE the insert, so a
   * failing insert left the employee with NO active identity at all - having
   * destroyed the working one they had.
   *
   * So the whole finalisation is one transaction, and THE PENDING ROW IS THE
   * CLAIM. `pending_outcome IS NULL` in the first UPDATE's WHERE clause means
   * exactly one caller can ever proceed past it; everybody else sees
   * `affectedRows: 0`, rolls back and is told the work was already done. The
   * old identity is retired inside the same transaction as the insert that
   * replaces it, so a failure rolls BOTH back and the employee keeps the
   * identity they had.
   *
   * @returns {Promise<{outcome: string, identityCreated: boolean}>}
   *   VERIFIED            this caller finalised it
   *   ALREADY_FINALISED   somebody else did - nothing was changed
   *   DUPLICATE_IDENTITY  the Telegram account belongs to another employee
   * Any other database failure ROLLS BACK AND THROWS. It is not an outcome.
   */
  async finalizeVerification({
    tokenHash,
    employeeId,
    telegramUserId,
    chatId,
    username,
    verifiedMobile,
    verifiedOutcome,
  }) {
    const connection = await getConnectionAsync(this.db);
    try {
      await beginTransactionAsync(connection);

      // 1 - THE CLAIM. One winner, decided by the database.
      const claimed = await queryAsync(
        connection,
        `UPDATE employee_telegram_link_tokens
            SET pending_outcome = ?, pending_expires_at = NULL
          WHERE token_hash = ? AND pending_outcome IS NULL`,
        [verifiedOutcome, tokenHash]
      );
      if (!claimed || claimed.affectedRows !== 1) {
        await rollbackAsync(connection);
        return { outcome: "ALREADY_FINALISED", identityCreated: false };
      }

      // 2 - Is this Telegram account already somebody's? FOR UPDATE, so a
      // concurrent finalisation for a different employee waits here rather
      // than racing us to the insert.
      const existing = await queryAsync(
        connection,
        `SELECT employee_telegram_id, employee_id
           FROM employee_telegram_identity
          WHERE telegram_user_id = ? AND disconnected_at IS NULL
          FOR UPDATE`,
        [telegramUserId]
      );
      const owner = existing && existing[0] ? existing[0] : null;

      if (owner && Number(owner.employee_id) !== Number(employeeId)) {
        // Another employee's account. Roll the claim back so the caller can
        // close the pending row with the reason that actually applies.
        await rollbackAsync(connection);
        return { outcome: "DUPLICATE_IDENTITY", identityCreated: false };
      }

      if (owner) {
        // Already this employee's account: the identity the insert would
        // create is the one already there. Nothing to write.
        await commitAsync(connection);
        return { outcome: "VERIFIED", identityCreated: false };
      }

      // 3 - RECONNECT, INSIDE THE SAME TRANSACTION AS THE INSERT. A different
      // Telegram account for an employee who already has one: retire the old
      // row so `uq_eti_active_employee` is satisfied. If step 4 fails, this is
      // rolled back with it and the employee keeps what they had.
      await queryAsync(
        connection,
        `UPDATE employee_telegram_identity
            SET disconnected_at = NOW(), disconnect_reason = 'RECONNECT'
          WHERE employee_id = ? AND disconnected_at IS NULL`,
        [employeeId]
      );

      // 4 - the identity itself. The three unique keys are the real authority.
      try {
        await queryAsync(
          connection,
          `INSERT INTO employee_telegram_identity
             (employee_id, telegram_user_id, private_chat_id, telegram_username,
              verified_mobile, connected_at)
           VALUES (?, ?, ?, ?, ?, NOW())`,
          [employeeId, telegramUserId, chatId, username === undefined ? null : username, verifiedMobile]
        );
      } catch (err) {
        await rollbackAsync(connection);
        // A UNIQUE KEY REFUSED IT - somebody claimed the account between our
        // check and our insert. That is a duplicate and reads as one.
        if (isDuplicateKeyError(err)) {
          return { outcome: "DUPLICATE_IDENTITY", identityCreated: false };
        }
        // ANYTHING ELSE IS A FAILURE, NOT AN OUTCOME. The rollback has already
        // restored the previous active identity; the caller must not report
        // this as "already connected to another employee".
        logger.Log({
          level: logger.LEVEL.ERROR,
          component: "REPOSITORY.EMPLOYEE-TELEGRAM",
          code: "REPOSITORY.EMPLOYEE-TELEGRAM.FINALIZE-INSERT",
          description: err.toString(),
          category: "",
          ref: { employeeId, telegramUserId },
        });
        throw err;
      }

      await commitAsync(connection);
      return { outcome: "VERIFIED", identityCreated: true };
    } catch (err) {
      await rollbackAsync(connection);
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "REPOSITORY.EMPLOYEE-TELEGRAM",
        code: "REPOSITORY.EMPLOYEE-TELEGRAM.FINALIZE",
        description: err.toString(),
        category: "",
        ref: { employeeId, telegramUserId },
      });
      throw err;
    } finally {
      // Always returned to the pool, on every path.
      if (connection && typeof connection.release === "function") connection.release();
    }
  }

  /* ------------------------------------------------------ bulk summary */

  /**
   * The Telegram facts for a WHOLE employee list, in TWO queries.
   *
   * FOR THE ONBOARDING DASHBOARD, and it is two queries whatever the
   * headcount - which is the entire point. `usecase/employee_status_summary.js`
   * counts its queries in its header because asking per employee is how that
   * screen came to have no status columns at all; a Telegram column that
   * called `getStatus` 630 times would reintroduce exactly that.
   *
   * IT RETURNS FACTS, NOT A STATUS. The precedence lives in
   * `utils/employee_telegram_status.js` and is shared with the single-employee
   * read, so a dashboard badge cannot disagree with the employee's own screen.
   *
   * NOTHING SENSITIVE LEAVES THIS METHOD. No Telegram user id, no chat id, no
   * mobile, no token and no hash is selected - only whether an identity is
   * active and what the latest link attempt came to.
   *
   * THE LATEST ATTEMPT IS DECIDED IN SQL by `MAX(created_at)`. `created_at` is
   * a TIMESTAMP, so two tokens issued for one employee inside the same second
   * tie. That is harmless here: issuance is serialized per employee and
   * supersedes the previous row, so of two rows sharing a second the older one
   * carries a `pending_outcome` and reads PENDING while the newer is live -
   * and the precedence picks the live one, which is the newer. The single
   * employee read's `ORDER BY created_at DESC LIMIT 1` resolves the same tie
   * the same way for the same reason.
   */
  async getSummaryForEmployees(employeeIds) {
    const ids = (Array.isArray(employeeIds) ? employeeIds : [])
      .map((id) => Number(id))
      .filter((id) => Number.isInteger(id) && id > 0);
    if (ids.length === 0) return new Map();

    const [identities, latest] = await Promise.all([
      this.run(
        "SUMMARY-IDENTITIES",
        `SELECT employee_id
           FROM employee_telegram_identity
          WHERE disconnected_at IS NULL AND employee_id IN (?)`,
        [ids],
        {}
      ),
      this.run(
        "SUMMARY-LATEST-TOKEN",
        // `latest_is_live` is computed by MySQL against its own NOW(), beside
        // the row it is about, rather than compared to this process's clock
        // afterwards.
        `SELECT t.employee_id,
                t.pending_outcome,
                (t.pending_outcome IS NULL
                 AND t.pending_expires_at IS NOT NULL
                 AND t.pending_expires_at > NOW()) AS latest_is_live
           FROM employee_telegram_link_tokens t
           JOIN (SELECT employee_id, MAX(created_at) AS newest
                   FROM employee_telegram_link_tokens
                  WHERE employee_id IN (?)
                  GROUP BY employee_id) newest_token
             ON newest_token.employee_id = t.employee_id
            AND t.created_at = newest_token.newest`,
        [ids],
        {}
      ),
    ]);

    const connected = new Set((identities || []).map((row) => Number(row.employee_id)));
    const summary = new Map();
    for (const id of ids) {
      summary.set(id, { hasActiveIdentity: connected.has(id), latest: null, latestIsLive: false });
    }
    for (const row of latest || []) {
      const id = Number(row.employee_id);
      const entry = summary.get(id);
      if (!entry) continue;
      const isLive = Number(row.latest_is_live) === 1;
      // On a tie the LIVE row wins - see the note above.
      if (entry.latest === null || (isLive && !entry.latestIsLive)) {
        entry.latest = { pending_outcome: row.pending_outcome };
        entry.latestIsLive = isLive;
      }
    }
    return summary;
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
