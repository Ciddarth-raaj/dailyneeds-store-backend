const logger = require("../utils/logger");

/** Rows behind Telegram linking and Telegram-delivered password resets. */
class PasswordResetRepository {
  constructor(db) {
    this.db = db;
  }

  /** Promisified query with one place to log a failure. */
  run(code, sql, params, ref = {}) {
    return new Promise((resolve, reject) => {
      this.db.query(sql, params, (err, docs) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.PASSWORD-RESET",
            code: `REPOSITORY.PASSWORD-RESET.${code}`,
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

  /** The Telegram chat linked to a user, or null. */
  async getLinkByUserId(userId) {
    const rows = await this.run(
      "GET-LINK",
      "SELECT user_id, chat_id, telegram_username, linked_at FROM telegram_links WHERE user_id = ?",
      [userId],
      { userId }
    );
    return rows.length === 0 ? null : rows[0];
  }

  /**
   * Point a user at a chat, replacing whatever either side pointed at before.
   *
   * The chat row is cleared first because chat_id is unique: re-linking a
   * Telegram account that was attached to an old login must move it, not
   * fail. Both statements are one call so a crash between them cannot leave
   * the chat detached from every account.
   */
  async saveLink(userId, chatId, telegramUsername) {
    await this.run(
      "CLEAR-CHAT",
      "DELETE FROM telegram_links WHERE chat_id = ?",
      [chatId],
      { chatId }
    );
    return this.run(
      "SAVE-LINK",
      `INSERT INTO telegram_links (user_id, chat_id, telegram_username, linked_at)
       VALUES (?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE chat_id = VALUES(chat_id),
                               telegram_username = VALUES(telegram_username),
                               linked_at = NOW()`,
      [userId, chatId, telegramUsername || null],
      { userId, chatId }
    );
  }

  deleteLink(userId) {
    return this.run(
      "DELETE-LINK",
      "DELETE FROM telegram_links WHERE user_id = ?",
      [userId],
      { userId }
    );
  }

  /**
   * Store a link token. Any earlier unused token for the user is dropped, so
   * a freshly generated link is the only one that works.
   */
  async createLinkToken(userId, tokenHash, expiresAt) {
    await this.run(
      "CLEAR-LINK-TOKENS",
      "DELETE FROM telegram_link_tokens WHERE user_id = ? AND consumed_at IS NULL",
      [userId],
      { userId }
    );
    return this.run(
      "CREATE-LINK-TOKEN",
      "INSERT INTO telegram_link_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
      [tokenHash, userId, expiresAt],
      { userId }
    );
  }

  /**
   * Spend a link token, returning the user it belonged to or null.
   *
   * The UPDATE is what claims it: `consumed_at IS NULL` in the WHERE clause
   * means two updates arriving together cannot both succeed, so replaying a
   * captured deep link does nothing.
   */
  async consumeLinkToken(tokenHash) {
    const rows = await this.run(
      "READ-LINK-TOKEN",
      `SELECT user_id FROM telegram_link_tokens
       WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > NOW()`,
      [tokenHash],
      {}
    );
    if (rows.length === 0) return null;

    const claimed = await this.run(
      "CONSUME-LINK-TOKEN",
      "UPDATE telegram_link_tokens SET consumed_at = NOW() WHERE token_hash = ? AND consumed_at IS NULL",
      [tokenHash],
      {}
    );
    return claimed.affectedRows === 1 ? rows[0].user_id : null;
  }

  /** Store a reset code, retiring any the user already had outstanding. */
  async createResetCode(userId, codeHash, expiresAt) {
    await this.run(
      "CLEAR-RESET-CODES",
      "UPDATE password_reset_codes SET consumed_at = NOW() WHERE user_id = ? AND consumed_at IS NULL",
      [userId],
      { userId }
    );
    return this.run(
      "CREATE-RESET-CODE",
      "INSERT INTO password_reset_codes (user_id, code_hash, expires_at) VALUES (?, ?, ?)",
      [userId, codeHash, expiresAt],
      { userId }
    );
  }

  /** The user's live reset code row, or null when there is none. */
  async getActiveResetCode(userId) {
    const rows = await this.run(
      "GET-RESET-CODE",
      `SELECT id, user_id, code_hash, expires_at, attempts FROM password_reset_codes
       WHERE user_id = ? AND consumed_at IS NULL AND expires_at > NOW()
       ORDER BY id DESC LIMIT 1`,
      [userId],
      { userId }
    );
    return rows.length === 0 ? null : rows[0];
  }

  /** How many codes the user has been sent since `since` — the send throttle. */
  async countRecentResetCodes(userId, since) {
    const rows = await this.run(
      "COUNT-RESET-CODES",
      "SELECT COUNT(*) AS count FROM password_reset_codes WHERE user_id = ? AND created_at > ?",
      [userId, since],
      { userId }
    );
    return rows[0]?.count ?? 0;
  }

  recordResetAttempt(id) {
    return this.run(
      "RECORD-RESET-ATTEMPT",
      "UPDATE password_reset_codes SET attempts = attempts + 1 WHERE id = ?",
      [id],
      { id }
    );
  }

  /** Spend a reset code. False when something else already spent it. */
  async consumeResetCode(id) {
    const claimed = await this.run(
      "CONSUME-RESET-CODE",
      "UPDATE password_reset_codes SET consumed_at = NOW() WHERE id = ? AND consumed_at IS NULL",
      [id],
      { id }
    );
    return claimed.affectedRows === 1;
  }
}

module.exports = (db) => {
  return new PasswordResetRepository(db);
};
