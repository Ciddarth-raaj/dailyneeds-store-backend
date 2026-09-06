const crypto = require("crypto");
const jwt = require("../services/jwt");
const passwordService = require("../services/password");
const policy = require("../utils/password_policy");
const authConfig = require("../config/auth");
const {
  isAccessAllowed,
  normalizeIpPolicy,
  parseAllowList,
  resolveIpPolicy,
  toBoolean,
  validateIpPolicy,
} = require("../utils/ip");

/** Returned when a valid login is refused because of where it came from. */
const IP_NOT_ALLOWED = {
  code: 403,
  error: "IP_NOT_ALLOWED",
  msg: "This account can only be used from an approved network.",
};

/**
 * The one answer for every credential failure: unknown user, wrong
 * password, disabled account, locked account, inactive employee. The route
 * turns it into the same 400 the app has always shown (B8).
 */
const BAD_CREDENTIALS = { code: 204 };

const validationError = (msg) => {
  const err = new Error(msg);
  err.name = "ValidationError";
  return err;
};

const forbidden = (msg, code = "FORBIDDEN") => {
  const err = new Error(msg);
  err.name = "ForbiddenError";
  err.status = 403;
  err.code = code;
  return err;
};

const notFound = (msg) => {
  const err = new Error(msg);
  err.name = "NotFoundError";
  err.status = 404;
  return err;
};

const sha256 = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
const minutesFromNow = (m) => new Date(Date.now() + m * 60 * 1000);
const toMysqlDatetime = (d) => d.toISOString().slice(0, 19).replace("T", " ");

class UserUsecase {
  /**
   * @param {object} userRepo
   * @param {object} designationRepo   unused directly; kept for wiring compatibility
   * @param {object} employeeRepo
   * @param {object} [deps]
   * @param {object} [deps.authLogRepo]  repository/auth_log
   * @param {object} [deps.telegram]     services/telegram instance
   * @param {object} [deps.config]       config/auth override (tests)
   * @param {object} [deps.passwords]    services/password override (tests)
   * @param {object} [deps.jwt]          services/jwt override (tests)
   * @param {function} [deps.now]        clock (tests)
   */
  constructor(userRepo, designationRepo, employeeRepo, deps = {}) {
    this.userRepo = userRepo;
    this.designationRepo = designationRepo;
    this.employeeRepo = employeeRepo;
    this.authLog = deps.authLogRepo || null;
    this.telegram = deps.telegram || null;
    this.config = deps.config || authConfig;
    this.passwords = deps.passwords || passwordService;
    this.jwt = deps.jwt || jwt;
    this.now = deps.now || (() => new Date());
    // B7 secondary control: failures per client IP, in-process.
    this.ipFailures = new Map();
  }

  // ---------------------------------------------------------------- audit

  async audit(event, fields = {}) {
    if (!this.authLog) return;
    try {
      await this.authLog.record({ event, ...fields });
    } catch (err) {
      // never let the audit path break authentication
    }
  }

  async alert(message) {
    if (!this.telegram) return;
    try {
      const chatId =
        this.config.breakGlass.alertChatId || require("../constants/telegram").ALERTS_TELEGRAM_CHAT_ID;
      await this.telegram.sendMessage(chatId, message, { disableNotification: false });
    } catch (err) {
      // alert delivery must not affect the login outcome
    }
  }

  // ------------------------------------------------------------ IP throttle

  _ipKey(ip) {
    return ip || "unknown";
  }

  _ipBlocked(ip) {
    const cfg = this.config.login.lockout;
    if (!cfg.enabled) return false;
    const entry = this.ipFailures.get(this._ipKey(ip));
    if (!entry) return false;
    const now = this.now().getTime();
    if (entry.blockedUntil && entry.blockedUntil > now) return true;
    return false;
  }

  _recordIpFailure(ip) {
    const cfg = this.config.login.lockout;
    if (!cfg.enabled) return;
    const key = this._ipKey(ip);
    const now = this.now().getTime();
    const windowMs = cfg.ipWindowMinutes * 60 * 1000;
    const entry = this.ipFailures.get(key) || { times: [], blockedUntil: 0 };
    entry.times = entry.times.filter((t) => now - t < windowMs);
    entry.times.push(now);
    if (entry.times.length >= cfg.ipThreshold) {
      entry.blockedUntil = now + cfg.ipBlockMinutes * 60 * 1000;
      entry.times = [];
    }
    this.ipFailures.set(key, entry);
    // keep the map bounded
    if (this.ipFailures.size > 10000) {
      const oldest = this.ipFailures.keys().next().value;
      this.ipFailures.delete(oldest);
    }
  }

  // ------------------------------------------------------------------ login

  /**
   * Sign in.
   *
   * Every failure path performs a password verification of the same cost as
   * a success path and returns BAD_CREDENTIALS, so neither timing nor the
   * response says whether the username exists (B8).
   *
   * `meta` = { userAgent, transport: 'body' | 'query', secure }.
   */
  async login(username, password, clientIp, meta = {}) {
    const cfg = this.config;
    const ip = clientIp || null;
    const base = { username, ip, userAgent: meta.userAgent || null };

    if (typeof username !== "string" || typeof password !== "string") {
      await this.passwords.dummyVerify("");
      return BAD_CREDENTIALS;
    }

    // A8: refuse credentials that did not arrive over HTTPS.
    if (cfg.login.requireHttps && meta.secure === false) {
      await this.audit("login_insecure_transport", base);
      return { code: 403, error: "INSECURE_TRANSPORT", msg: "Sign in over HTTPS." };
    }

    if (this._ipBlocked(ip)) {
      await this.passwords.dummyVerify(password);
      await this.audit("login_locked", { ...base, detail: "ip_throttle" });
      return BAD_CREDENTIALS;
    }

    const rows = await this.userRepo.findByUsername(username);
    const row = rows && rows.length ? rows[0] : null;

    if (!row) {
      // B8: same cost as a real verification.
      await this.passwords.dummyVerify(password);
      this._recordIpFailure(ip);
      await this.audit("login_failed", { ...base, detail: "unknown_user" });
      return BAD_CREDENTIALS;
    }

    const isSystem = Number(row.is_system_account) === 1;
    const audited = { ...base, userId: row.user_id };

    // Locked accounts still pay for a verification, so the lock is not observable by timing.
    const lockedUntil = row.locked_until ? new Date(row.locked_until).getTime() : 0;
    const isLocked = cfg.login.lockout.enabled && lockedUntil > this.now().getTime();

    if (cfg.password.rejectLegacy && row.password_algo === this.passwords.LEGACY_ALGO && !isSystem) {
      await this.passwords.dummyVerify(password);
      await this.audit("login_failed", { ...audited, detail: "legacy_rejected" });
      return BAD_CREDENTIALS;
    }

    const { ok, algo } = await this.passwords.verifyUser(row, password);

    if (isLocked) {
      await this.audit("login_locked", { ...audited, detail: "account_lock" });
      return BAD_CREDENTIALS;
    }

    if (!ok) {
      await this._onFailedPassword(row, audited, isSystem);
      return BAD_CREDENTIALS;
    }

    if (Number(row.status) !== 1) {
      await this.audit("login_inactive", { ...audited, detail: "account_disabled" });
      return BAD_CREDENTIALS;
    }

    // C2: a real employee must be active. A system account has no employee
    // row and is judged only by its own status — it must not depend on
    // new_employee, and it must not be given a fake one.
    if (!isSystem) {
      if (row.employee_id === null || row.employee_id === undefined) {
        await this.audit("login_inactive", { ...audited, detail: "no_employee_row" });
        return BAD_CREDENTIALS;
      }
      if (Number(row.employee_status) !== 1) {
        await this.audit("login_inactive", { ...audited, detail: "employee_inactive" });
        return BAD_CREDENTIALS;
      }
    }

    if (!isAccessAllowed(resolveIpPolicy(row), clientIp)) {
      await this.audit("login_ip_blocked", audited);
      return { ...IP_NOT_ALLOWED, ip: clientIp };
    }

    // B1: upgrade a legacy credential now that it has been proven. The
    // must_change_password flag is untouched — a predictable password stays
    // predictable however it is hashed.
    if (algo === this.passwords.LEGACY_ALGO && cfg.password.hashOnLogin && !isSystem) {
      try {
        const modern = await this.passwords.hash(password);
        await this.userRepo.migrateLegacyPassword(row.user_id, modern);
        await this.audit("password_migrated", audited);
      } catch (err) {
        // A failed upgrade must not fail a correct login; it will retry next time.
      }
    }

    await this.userRepo.recordSuccessfulLogin(row.user_id);
    if (meta.transport) {
      await this.audit("login_success", {
        ...audited,
        detail: meta.transport === "query" ? "legacy_query_string" : "body",
      });
    } else {
      await this.audit("login_success", audited);
    }

    if (isSystem) {
      await this.audit("break_glass_login", { ...audited, detail: "rotate_credential_now" });
      await this.alert(
        `🚨 *BREAK-GLASS LOGIN*\nAccount: \`${row.username}\` (user_id ${row.user_id})\nFrom: \`${ip || "unknown"}\`\nAt: ${this.now().toISOString()}\n\nThis credential must be rotated after use: see docs/auth-stage0a-implementation.md.`
      );
    }

    return this._issueSession(row, isSystem);
  }

  async _onFailedPassword(row, audited, isSystem) {
    const cfg = this.config.login.lockout;
    let lockUntil = null;
    if (cfg.enabled) {
      const count = Number(row.failed_login_count || 0) + 1;
      if (count >= cfg.threshold) {
        lockUntil = toMysqlDatetime(minutesFromNow(cfg.minutes));
      }
    }
    try {
      await this.userRepo.recordFailedLogin(row.user_id, lockUntil);
    } catch (err) {
      // counting must not change the outcome
    }
    this._recordIpFailure(audited.ip);
    await this.audit(isSystem ? "break_glass_login_failed" : "login_failed", {
      ...audited,
      detail: lockUntil ? "wrong_password;locked" : "wrong_password",
    });
    if (lockUntil) await this.audit("login_locked", { ...audited, detail: "threshold_reached" });
    if (isSystem) {
      await this.alert(
        `⚠️ *Failed break-glass login attempt*\nAccount: \`${row.username}\`\nFrom: \`${audited.ip || "unknown"}\``
      );
    }
  }

  /**
   * Build the token from the database row — never from anything the client
   * sent (C3). `sub` is the user-account key. `employee_id` is present only
   * when the account belongs to a real employee.
   */
  async _issueSession(row, isSystem) {
    const mustChange = Number(row.must_change_password) === 1 && !isSystem;
    const claims = {
      id: row.user_id, // kept for pre-Stage-0A readers of req.decoded.id
      user_type: row.user_type,
      designation_id: isSystem ? null : row.designation_id,
      store_id: isSystem ? null : row.store_id,
      name: isSystem ? row.username : row.employee_name,
      designation: isSystem ? "System account" : row.designation_name,
      employee_image: isSystem ? null : row.employee_image,
    };
    if (!isSystem) claims.employee_id = row.employee_id;
    if (isSystem) claims.sys = true;
    if (mustChange && this.config.password.enforcePasswordChange) claims.pwc = true;

    const token = await this.jwt.sign(claims, this.config.jwt.tokenLifetime, {
      subject: String(row.user_id),
    });

    return {
      code: 200,
      token,
      user_id: row.user_id,
      store_id: claims.store_id,
      designation_id: claims.designation_id,
      employee_id: isSystem ? null : row.employee_id,
      user_type: row.user_type,
      name: claims.name,
      designation: claims.designation,
      employee_image: claims.employee_image,
      is_system_account: isSystem,
      must_change_password: mustChange,
    };
  }

  // -------------------------------------------------------- change password

  /**
   * Replace the signed-in user's own password. The current password is
   * required, the new one is checked against policy, and the result is
   * always a modern hash. A system account is refused: its credential is
   * rotated only through the documented script (A4).
   */
  async changePassword(userId, currentPassword, newPassword, meta = {}) {
    const current = typeof currentPassword === "string" ? currentPassword : "";
    const next = typeof newPassword === "string" ? newPassword : "";

    const row = await this.userRepo.getCredentialRow(userId);
    if (!row) throw notFound("Account not found");
    if (Number(row.is_system_account) === 1) {
      throw forbidden("System account credentials are rotated only through the break-glass procedure", "SYSTEM_ACCOUNT");
    }

    const verdict = policy.check(next, {
      username: row.username,
      employeeId: row.employee_id,
      mobile: row.primary_contact_number,
      currentPassword: current,
    });
    if (!verdict.ok) throw validationError(verdict.reason);

    const { ok } = await this.passwords.verifyUser(row, current);
    if (!ok) {
      await this.audit("login_failed", { userId, username: row.username, ip: meta.ip || null, detail: "change_password_wrong_current" });
      return { code: 400, error: "INCORRECT_PASSWORD", msg: "Current password is incorrect" };
    }

    const hash = await this.passwords.hash(next);
    await this.userRepo.setModernPassword(userId, hash, { clearMustChange: true });
    await this.audit("password_changed", { userId, username: row.username, ip: meta.ip || null });
    return { code: 200, msg: "Password updated" };
  }

  // ------------------------------------------------- setup / reset tokens (B)

  _newToken() {
    const raw = crypto.randomBytes(this.config.resetToken.bytes).toString("base64url");
    return { raw, hash: sha256(raw) };
  }

  /**
   * B6: an administrator issues a setup/reset token for an account. The
   * administrator never sees or chooses the password. The token is returned
   * exactly once, here, for hand-over; nothing stores it.
   */
  async issueReset(targetUserId, actorUserId, meta = {}) {
    const account = await this.userRepo.getAccount(targetUserId);
    if (!account) throw notFound("Account not found");
    if (Number(account.is_system_account) === 1) {
      throw forbidden("Break-glass accounts cannot be reset through this API", "SYSTEM_ACCOUNT");
    }
    if (Number(account.status) !== 1) throw forbidden("Account is disabled");

    await this.userRepo.expireResetTokens(targetUserId);
    const { raw, hash } = this._newToken();
    const expiresAt = toMysqlDatetime(minutesFromNow(this.config.resetToken.lifetimeMinutes));
    await this.userRepo.createResetToken(targetUserId, hash, "reset", expiresAt, actorUserId, meta.ip || null);
    await this.userRepo.setMustChangePassword(targetUserId, "admin_reset");
    await this.audit("admin_reset_issued", { userId: targetUserId, username: account.username, ip: meta.ip || null, actorUserId });
    return {
      code: 200,
      user_id: targetUserId,
      username: account.username,
      expires_at: expiresAt,
      // Single use, expires, and this is its only appearance.
      setup_token: raw,
    };
  }

  /** Called by provisioning (B4): a fresh account with no password gets a setup token. */
  async issueSetupForNewAccount(userId, actorUserId, meta = {}) {
    const { raw, hash } = this._newToken();
    const expiresAt = toMysqlDatetime(minutesFromNow(this.config.resetToken.lifetimeMinutes));
    await this.userRepo.createResetToken(userId, hash, "setup", expiresAt, actorUserId, meta.ip || null);
    await this.audit("reset_requested", { userId, actorUserId, ip: meta.ip || null, detail: "setup" });
    return { setup_token: raw, expires_at: expiresAt };
  }

  /**
   * B5: redeem a token and set a password. Single use, expiring, and the
   * row is consumed atomically so a token redeemed twice in a race fails
   * the second time.
   */
  async redeemSetupToken(rawToken, newPassword, meta = {}) {
    if (typeof rawToken !== "string" || rawToken.length < 16 || rawToken.length > 256) {
      throw validationError("Invalid token");
    }
    if (this._ipBlocked(meta.ip)) throw forbidden("Too many attempts. Try again later.", "RATE_LIMITED");

    const row = await this.userRepo.findResetToken(sha256(rawToken));
    const fail = async (detail) => {
      this._recordIpFailure(meta.ip);
      await this.audit("reset_completed", { userId: row ? row.user_id : null, ip: meta.ip || null, detail: `failed:${detail}` });
      throw forbidden("This link is invalid or has expired", "TOKEN_INVALID");
    };

    if (!row) return fail("unknown");
    if (row.used_at) return fail("used");
    if (new Date(row.expires_at).getTime() < this.now().getTime()) return fail("expired");
    if (Number(row.is_system_account) === 1) return fail("system_account");
    if (Number(row.status) !== 1) return fail("disabled");

    const credential = await this.userRepo.getCredentialRow(row.user_id);
    const verdict = policy.check(newPassword, {
      username: credential ? credential.username : row.username,
      employeeId: credential ? credential.employee_id : row.employee_id,
      mobile: credential ? credential.primary_contact_number : null,
    });
    if (!verdict.ok) throw validationError(verdict.reason);

    const consumed = await this.userRepo.consumeResetToken(row.reset_id);
    if (!consumed) return fail("used");

    const hash = await this.passwords.hash(newPassword);
    await this.userRepo.setModernPassword(row.user_id, hash, { clearMustChange: true });
    await this.audit(row.purpose === "setup" ? "password_setup_completed" : "reset_completed", {
      userId: row.user_id,
      username: row.username,
      ip: meta.ip || null,
    });
    return { code: 200, msg: "Password set. You can now sign in." };
  }

  // ---------------------------------------------------------- unlock (B10)

  async unlock(targetUserId, actorUserId, meta = {}) {
    const account = await this.userRepo.getAccount(targetUserId);
    if (!account) throw notFound("Account not found");
    if (Number(account.is_system_account) === 1) {
      throw forbidden("Break-glass accounts cannot be modified through this API", "SYSTEM_ACCOUNT");
    }
    await this.userRepo.unlock(targetUserId);
    await this.audit("account_unlocked", { userId: targetUserId, username: account.username, actorUserId, ip: meta.ip || null });
    return { code: 200, msg: "Account unlocked" };
  }

  // --------------------------------------------------------- logout (C5)

  async logout(userId, meta = {}) {
    await this.userRepo.bumpTokenValidFrom(userId);
    await this.audit("logout", { userId, ip: meta.ip || null });
    return { code: 200 };
  }

  async getAccount(userId) {
    return this.userRepo.getAccount(userId);
  }

  /** C4: the per-request session state, for the auth middleware. */
  async getSessionState(userId) {
    return this.userRepo.getSessionState(userId);
  }

  // ------------------------------------------------------------ IP policy

  async getIpPolicy(userId) {
    const row = await this.userRepo.getIpPolicy(userId);
    if (!row) return { exempt: true, rules: [], source: "missing" };
    return resolveIpPolicy(row);
  }

  async getIpRestrictions() {
    const rows = await this.userRepo.getIpRestrictions();
    return (rows || []).map((row) => {
      const p = normalizeIpPolicy(row.ip_policy) || "branch";
      const effective = resolveIpPolicy(row);
      return {
        ...row,
        ip_policy: p,
        allowed_ips: parseAllowList(row.allowed_ips),
        branch_enabled: toBoolean(row.branch_enabled, false),
        branch_ips: parseAllowList(row.branch_ips),
        effective,
        is_restricted: !effective.exempt,
      };
    });
  }

  async updateIpPolicy(userId, allowedIps, ipPolicy) {
    const p = normalizeIpPolicy(ipPolicy);
    if (!p) throw validationError("ip_policy must be one of branch, custom or unrestricted");

    const { valid, reason, rules } = validateIpPolicy({ restricted: p === "custom", allowedIps });
    if (!valid) throw validationError(reason);

    const value = rules.length === 0 ? null : rules.join(", ");
    await this.userRepo.updateIpPolicy(userId, value, p);
    return { code: 200, allowed_ips: rules, ip_policy: p };
  }
}

module.exports = (userRepo, designationRepo, employeeRepo, deps) => {
  return new UserUsecase(userRepo, designationRepo, employeeRepo, deps);
};
module.exports.BAD_CREDENTIALS = BAD_CREDENTIALS;
