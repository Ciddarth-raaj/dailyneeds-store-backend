const logger = require("../utils/logger");

/**
 * Authentication audit log and login metrics — Stage 0A.
 *
 * `record()` is the only writer to user_auth_log. It accepts a fixed set of
 * fields and nothing else, so a caller cannot accidentally pass a password,
 * a token or a hash through it: those are not fields. `detail` is truncated
 * to the column width and is meant for short reason codes.
 */

const EVENTS = Object.freeze([
  "login_success",
  "login_failed",
  "login_locked",
  "login_ip_blocked",
  "login_insecure_transport",
  "login_inactive",
  "account_unlocked",
  "password_migrated",
  "password_changed",
  "password_setup_completed",
  "reset_requested",
  "reset_completed",
  "admin_reset_issued",
  "break_glass_login",
  "break_glass_login_failed",
  "break_glass_credential_rotated",
  "break_glass_rotation_due",
  "system_account_created",
  "logout",
  "token_revoked",
  "sensitive_read",
  "key_rotation",
]);

class AuthLogRepository {
  constructor(db) {
    this.db = db;
  }

  _query(code, sql, params) {
    return new Promise((resolve) => {
      this.db.query(sql, params, (err, docs) => {
        if (err) {
          // Audit failures are logged but never break the request they
          // describe — a login must not fail because the log table did.
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.AUTH_LOG",
            code: `REPOSITORY.AUTH_LOG.${code}`,
            description: err.toString(),
            category: "",
            ref: {},
          });
          resolve(null);
          return;
        }
        resolve(docs);
      });
    });
  }

  record({ event, userId = null, username = null, ip = null, userAgent = null, detail = null, actorUserId = null }) {
    if (!EVENTS.includes(event)) {
      return Promise.reject(new Error(`Unknown auth log event: ${event}`));
    }
    return this._query(
      "RECORD",
      "INSERT INTO `user_auth_log` (`user_id`, `username_attempted`, `event`, `ip`, `user_agent`, `detail`, `actor_user_id`) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        userId,
        username === null ? null : String(username).slice(0, 100),
        event,
        ip === null ? null : String(ip).slice(0, 45),
        userAgent === null ? null : String(userAgent).slice(0, 255),
        detail === null ? null : String(detail).slice(0, 255),
        actorUserId,
      ]
    );
  }

  /** A daily counter. No detail is stored — this is the A7 metric. */
  bumpMetric(metric) {
    return this._query(
      "BUMP-METRIC",
      "INSERT INTO `auth_metric` (`metric`, `day`, `count`) VALUES (?, CURDATE(), 1) ON DUPLICATE KEY UPDATE `count` = `count` + 1",
      [metric]
    );
  }

  getMetrics(days = 30) {
    return this._query(
      "GET-METRICS",
      "SELECT `metric`, `day`, `count` FROM `auth_metric` WHERE `day` >= DATE_SUB(CURDATE(), INTERVAL ? DAY) ORDER BY `day` DESC, `metric` ASC",
      [days]
    );
  }

  listForUser(userId, limit = 100) {
    return this._query(
      "LIST-FOR-USER",
      "SELECT `log_id`, `user_id`, `username_attempted`, `event`, `ip`, `detail`, `actor_user_id`, `created_at` FROM `user_auth_log` WHERE `user_id` = ? ORDER BY `created_at` DESC LIMIT ?",
      [userId, limit]
    );
  }

  listRecent(limit = 200, event = null) {
    const where = event ? "WHERE `event` = ?" : "";
    const params = event ? [event, limit] : [limit];
    return this._query(
      "LIST-RECENT",
      `SELECT \`log_id\`, \`user_id\`, \`username_attempted\`, \`event\`, \`ip\`, \`detail\`, \`actor_user_id\`, \`created_at\` FROM \`user_auth_log\` ${where} ORDER BY \`created_at\` DESC LIMIT ?`,
      params
    );
  }

  /** Break-glass accounts whose credential is due rotation (A5). */
  findSystemAccountsDueRotation(rotationDays) {
    return this._query(
      "SYSTEM-ROTATION-DUE",
      `SELECT \`user_id\`, \`username\`, \`credential_rotated_at\`, \`last_login_at\`
       FROM \`user\`
       WHERE \`is_system_account\` = 1 AND \`status\` = 1
         AND (\`credential_rotated_at\` IS NULL
              OR \`credential_rotated_at\` < DATE_SUB(NOW(), INTERVAL ? DAY)
              OR (\`last_login_at\` IS NOT NULL AND \`last_login_at\` > \`credential_rotated_at\`))`,
      [rotationDays]
    );
  }
}

module.exports = (db) => new AuthLogRepository(db);
module.exports.EVENTS = EVENTS;
