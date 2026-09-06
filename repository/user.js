const logger = require("../utils/logger");

/**
 * User account repository — Stage 0A.
 *
 * Passwords never enter SQL. The old `WHERE password = SHA1(?)` is gone:
 * this layer returns the stored credential fields and services/password.js
 * decides whether a supplied password matches.
 *
 * Every statement that changes a credential, a status, a flag or a policy
 * carries `AND is_system_account = 0`. The break-glass account is created
 * and rotated only by scripts/auth/break-glass.js; no route, usecase or
 * repository method here can create one, convert a user into one, or touch
 * one. That guard lives in the SQL so a future caller cannot forget it.
 */

const SYSTEM_GUARD = "AND `is_system_account` = 0";

/** Columns the login path needs. `password` and `password_hash` included on purpose; nothing else reads them. */
const CREDENTIAL_COLUMNS = `
  u.user_id AS user_id,
  u.username AS username,
  u.employee_id AS employee_id,
  u.user_type AS user_type,
  u.status AS status,
  u.password AS password,
  u.password_hash AS password_hash,
  u.password_algo AS password_algo,
  u.must_change_password AS must_change_password,
  u.password_flag_reason AS password_flag_reason,
  u.failed_login_count AS failed_login_count,
  u.locked_until AS locked_until,
  u.token_valid_from AS token_valid_from,
  u.is_system_account AS is_system_account,
  u.ip_policy AS ip_policy,
  u.allowed_ips AS allowed_ips,
  o.ip_restriction_enabled AS branch_enabled,
  o.allowed_ips AS branch_ips,
  ne.status AS employee_status,
  ne.store_id AS store_id,
  ne.department_id AS department_id,
  ne.designation_id AS designation_id,
  ne.employee_name AS employee_name,
  ne.employee_image AS employee_image,
  ne.primary_contact_number AS primary_contact_number,
  d.designation_name AS designation_name`;

class UserRepository {
  constructor(db) {
    this.db = db;
  }

  _query(code, sql, params, ref = {}) {
    return new Promise((resolve, reject) => {
      this.db.query(sql, params, (err, docs) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.USER",
            code: `REPOSITORY.USER.${code}`,
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

  /**
   * Every candidate row for a username, with its credential fields and the
   * joined employee/branch context. The LEFT JOIN is real here: a row with
   * no employee comes back with employee_status NULL, and the usecase
   * decides what that means. No status filter — the usecase applies it so
   * that a disabled account still costs a full password check (B8).
   */
  findByUsername(username) {
    return this._query(
      "FIND-BY-USERNAME",
      `SELECT ${CREDENTIAL_COLUMNS}
       FROM \`user\` u
       LEFT JOIN new_employee ne ON ne.employee_id = u.employee_id
       LEFT JOIN outlets o ON o.outlet_id = ne.store_id
       LEFT JOIN designation d ON d.designation_id = ne.designation_id
       WHERE u.username = ?
       ORDER BY u.status DESC, u.user_id ASC`,
      [username]
    );
  }

  /** Credential fields for one account, for change-password. */
  getCredentialRow(userId) {
    return this._query(
      "GET-CREDENTIAL-ROW",
      `SELECT ${CREDENTIAL_COLUMNS}
       FROM \`user\` u
       LEFT JOIN new_employee ne ON ne.employee_id = u.employee_id
       LEFT JOIN outlets o ON o.outlet_id = ne.store_id
       LEFT JOIN designation d ON d.designation_id = ne.designation_id
       WHERE u.user_id = ?`,
      [userId],
      { userId }
    ).then((rows) => (rows.length ? rows[0] : null));
  }

  /** Public (non-credential) view of one account, for admin flows. */
  getAccount(userId) {
    return this._query(
      "GET-ACCOUNT",
      `SELECT u.user_id, u.username, u.employee_id, u.user_type, u.status,
              u.password_algo, u.must_change_password, u.password_flag_reason,
              u.failed_login_count, u.locked_until, u.last_login_at,
              u.is_system_account, u.token_valid_from,
              ne.employee_name, ne.store_id, ne.status AS employee_status
       FROM \`user\` u
       LEFT JOIN new_employee ne ON ne.employee_id = u.employee_id
       WHERE u.user_id = ?`,
      [userId],
      { userId }
    ).then((rows) => (rows.length ? rows[0] : null));
  }

  /**
   * Store a modern hash. Clears the legacy column so the SHA-1 value cannot
   * be consulted again for this account, and stamps token_valid_from so
   * sessions issued under the old credential stop verifying (C4/C5).
   */
  setModernPassword(userId, passwordHash, { clearMustChange = false } = {}) {
    const mustChange = clearMustChange ? ", `must_change_password` = 0, `password_flag_reason` = NULL" : "";
    return this._query(
      "SET-MODERN-PASSWORD",
      `UPDATE \`user\`
       SET \`password_hash\` = ?, \`password_algo\` = 'scrypt', \`password\` = NULL,
           \`password_migrated_at\` = COALESCE(\`password_migrated_at\`, NOW()),
           \`token_valid_from\` = NOW(), \`failed_login_count\` = 0, \`locked_until\` = NULL
           ${mustChange}
       WHERE \`user_id\` = ? ${SYSTEM_GUARD}`,
      [passwordHash, userId],
      { userId }
    );
  }

  /** Deployment B: upgrade a legacy row after a successful SHA-1 login. Leaves must_change_password alone. */
  migrateLegacyPassword(userId, passwordHash) {
    return this._query(
      "MIGRATE-LEGACY-PASSWORD",
      `UPDATE \`user\`
       SET \`password_hash\` = ?, \`password_algo\` = 'scrypt', \`password\` = NULL,
           \`password_migrated_at\` = NOW()
       WHERE \`user_id\` = ? AND \`password_algo\` = 'sha1' ${SYSTEM_GUARD}`,
      [passwordHash, userId],
      { userId }
    );
  }

  recordFailedLogin(userId, lockUntil) {
    return this._query(
      "RECORD-FAILED-LOGIN",
      `UPDATE \`user\`
       SET \`failed_login_count\` = \`failed_login_count\` + 1,
           \`last_failed_login_at\` = NOW(),
           \`locked_until\` = ?
       WHERE \`user_id\` = ?`,
      [lockUntil, userId],
      { userId }
    );
  }

  recordSuccessfulLogin(userId) {
    return this._query(
      "RECORD-SUCCESSFUL-LOGIN",
      "UPDATE `user` SET `failed_login_count` = 0, `locked_until` = NULL, `last_login_at` = NOW() WHERE `user_id` = ?",
      [userId],
      { userId }
    );
  }

  /** B10: clear a temporary lock. Never for a system account. */
  unlock(userId) {
    return this._query(
      "UNLOCK",
      `UPDATE \`user\` SET \`failed_login_count\` = 0, \`locked_until\` = NULL
       WHERE \`user_id\` = ? ${SYSTEM_GUARD}`,
      [userId],
      { userId }
    );
  }

  setMustChangePassword(userId, reason) {
    return this._query(
      "SET-MUST-CHANGE",
      `UPDATE \`user\` SET \`must_change_password\` = 1, \`password_flag_reason\` = ?
       WHERE \`user_id\` = ? ${SYSTEM_GUARD}`,
      [reason || null, userId],
      { userId }
    );
  }

  /** C4/C5: reject every token issued before now for this account. */
  bumpTokenValidFrom(userId) {
    return this._query(
      "BUMP-TOKEN-VALID-FROM",
      "UPDATE `user` SET `token_valid_from` = NOW() WHERE `user_id` = ?",
      [userId],
      { userId }
    );
  }

  /** The columns the per-request session check needs. */
  getSessionState(userId) {
    return this._query(
      "GET-SESSION-STATE",
      "SELECT `user_id`, `employee_id`, `status`, `token_valid_from`, `must_change_password`, `is_system_account` FROM `user` WHERE `user_id` = ?",
      [userId],
      { userId }
    ).then((rows) => (rows.length ? rows[0] : null));
  }

  updateStatus(employee) {
    return this._query(
      "UPDATE-STATUS",
      `UPDATE \`user\` SET \`status\` = ? WHERE \`employee_id\` = ? ${SYSTEM_GUARD}`,
      [employee.status, employee.employee_id]
    );
  }

  getIpPolicy(userId) {
    return this._query(
      "GET-IP-POLICY",
      `SELECT u.user_type AS user_type,
              u.ip_policy AS ip_policy,
              u.allowed_ips AS allowed_ips,
              o.ip_restriction_enabled AS branch_enabled,
              o.allowed_ips AS branch_ips
       FROM \`user\` u
       LEFT JOIN new_employee ne ON ne.employee_id = u.employee_id
       LEFT JOIN outlets o ON o.outlet_id = ne.store_id
       WHERE u.user_id = ?`,
      [userId],
      { userId }
    ).then((docs) => (docs.length === 0 ? null : docs[0]));
  }

  getIpRestrictions() {
    return this._query(
      "GET-IP-RESTRICTIONS",
      `SELECT u.user_id AS user_id,
              u.username AS username,
              u.user_type AS user_type,
              u.ip_policy AS ip_policy,
              u.allowed_ips AS allowed_ips,
              u.employee_id AS employee_id,
              u.is_system_account AS is_system_account,
              ne.employee_name AS employee_name,
              ne.store_id AS store_id,
              o.outlet_name AS store_name,
              o.ip_restriction_enabled AS branch_enabled,
              o.allowed_ips AS branch_ips,
              d.designation_name AS designation_name
       FROM \`user\` u
       LEFT JOIN new_employee ne ON ne.employee_id = u.employee_id
       LEFT JOIN outlets o ON o.outlet_id = ne.store_id
       LEFT JOIN designation d ON d.designation_id = ne.designation_id
       WHERE u.status = 1
       ORDER BY ne.employee_name ASC, u.username ASC`,
      []
    );
  }

  updateIpPolicy(userId, allowedIps, ipPolicy) {
    return this._query(
      "UPDATE-IP-POLICY",
      `UPDATE \`user\` SET \`allowed_ips\` = ?, \`ip_policy\` = ? WHERE \`user_id\` = ? ${SYSTEM_GUARD}`,
      [allowedIps, ipPolicy, userId],
      { userId }
    );
  }

  /**
   * One active, employee-linked, NON-system login by username, or null.
   *
   * Used by the Telegram reset flow, which has no token to work from. The
   * exclusions are explicit predicates, not side effects of the join:
   * `is_system_account = 0` and `employee_id IS NOT NULL` are written out,
   * so a break-glass account can never be selected here even if the join or
   * the employee status rule changes later (C2). `ne.status = 1` matches
   * `login`: an account that could not sign in anyway has no business
   * receiving a reset code.
   */
  getByUsername(username) {
    return this._query(
      "GET-BY-USERNAME",
      `SELECT u.user_id AS user_id,
              u.username AS username,
              u.employee_id AS employee_id,
              u.is_system_account AS is_system_account,
              u.status AS status,
              ne.employee_name AS employee_name,
              ne.status AS employee_status,
              ne.primary_contact_number AS primary_contact_number
       FROM \`user\` u
       LEFT JOIN new_employee ne ON ne.employee_id = u.employee_id
       WHERE u.username = ?
         AND u.status = 1
         AND u.is_system_account = 0
         AND u.employee_id IS NOT NULL
         AND ne.status = 1`,
      [username]
    ).then((docs) => (docs.length === 0 ? null : docs[0]));
  }

  /**
   * Create a login. `passwordHash` is a modern hash or NULL (account must be
   * set up through a token). SHA-1 is never written by this method.
   * is_system_account is not a parameter and takes its column default of 0.
   */
  createLogin(username, user_type, employee_id, passwordHash, { mustChange = false, flagReason = null } = {}) {
    return this._query(
      "CREATE",
      `INSERT INTO \`user\` (\`username\`, \`user_type\`, \`employee_id\`, \`password\`, \`password_hash\`, \`password_algo\`, \`must_change_password\`, \`password_flag_reason\`)
       VALUES (?, ?, ?, NULL, ?, 'scrypt', ?, ?)`,
      [username, user_type, employee_id, passwordHash, mustChange ? 1 : 0, flagReason]
    );
  }

  createLoginIfNeeded(username, user_type, employee_id, passwordHash, { mustChange = false, flagReason = null } = {}) {
    return this._query(
      "CREATE-IF-NEEDED",
      `INSERT INTO \`user\` (\`username\`, \`user_type\`, \`employee_id\`, \`password\`, \`password_hash\`, \`password_algo\`, \`must_change_password\`, \`password_flag_reason\`)
       SELECT ?, ?, ?, NULL, ?, 'scrypt', ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM \`user\` WHERE \`employee_id\` = ?)`,
      [username, user_type, employee_id, passwordHash, mustChange ? 1 : 0, flagReason, employee_id]
    );
  }

  // ---- reset / setup tokens (Deployment B) ---------------------------------

  createResetToken(userId, tokenHash, purpose, expiresAt, requestedBy, requestedIp) {
    return this._query(
      "CREATE-RESET-TOKEN",
      "INSERT INTO `user_password_reset` (`user_id`, `token_hash`, `purpose`, `expires_at`, `requested_by`, `requested_ip`) VALUES (?, ?, ?, ?, ?, ?)",
      [userId, tokenHash, purpose, expiresAt, requestedBy, requestedIp],
      { userId }
    );
  }

  /** Invalidate every outstanding token for a user before issuing a new one. */
  expireResetTokens(userId) {
    return this._query(
      "EXPIRE-RESET-TOKENS",
      "UPDATE `user_password_reset` SET `used_at` = NOW() WHERE `user_id` = ? AND `used_at` IS NULL",
      [userId],
      { userId }
    );
  }

  findResetToken(tokenHash) {
    return this._query(
      "FIND-RESET-TOKEN",
      `SELECT r.reset_id, r.user_id, r.purpose, r.expires_at, r.used_at,
              u.is_system_account, u.status, u.username, u.employee_id
       FROM \`user_password_reset\` r
       JOIN \`user\` u ON u.user_id = r.user_id
       WHERE r.token_hash = ?`,
      [tokenHash]
    ).then((rows) => (rows.length ? rows[0] : null));
  }

  /** Mark used only if still unused: the row count tells the caller whether it won the race. */
  consumeResetToken(resetId) {
    return this._query(
      "CONSUME-RESET-TOKEN",
      "UPDATE `user_password_reset` SET `used_at` = NOW() WHERE `reset_id` = ? AND `used_at` IS NULL",
      [resetId]
    ).then((res) => Boolean(res && res.affectedRows === 1));
  }
}

module.exports = (db) => {
  return new UserRepository(db);
};
module.exports.SYSTEM_GUARD = SYSTEM_GUARD;
