const crypto = require("crypto");
const logger = require("../utils/logger");
const passwordService = require("../services/password");
const policy = require("../utils/password_policy");

/** How long a `t.me/<bot>?start=...` deep link stays usable. */
const LINK_TOKEN_TTL_MS = 15 * 60 * 1000;

/** How long a reset code stays usable. Short: it arrives instantly. */
const RESET_CODE_TTL_MS = 10 * 60 * 1000;

/** Wrong guesses allowed against one code before it is dead. */
const MAX_RESET_ATTEMPTS = 5;

/** Codes one account may be sent per hour, so the bot cannot be used to spam. */
const MAX_CODES_PER_HOUR = 5;

/**
 * What every forgot-password request answers, whatever actually happened.
 *
 * The screen must not become a way to discover which usernames exist or
 * whose Telegram is linked, so an unknown user, an unlinked one, a protected
 * one and a successful send are indistinguishable from outside.
 */
const NEUTRAL_REQUEST_RESULT = {
  code: 200,
  msg: "If that account exists and has Telegram linked, a code has been sent to it.",
};

const sha256 = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");

/** A six-digit code, uniformly distributed — `Math.random` is not good enough here. */
const generateCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, "0");

/** `/start <payload>` → the payload, or null for anything else. */
function parseStartPayload(text) {
  if (typeof text !== "string") return null;
  const match = text.trim().match(/^\/start(?:@\w+)?\s+(\S+)$/);
  return match ? match[1] : null;
}

const validationError = (message) => {
  const error = new Error(message);
  error.name = "ValidationError";
  throw error;
};

/**
 * True only for a row that is a real, active, employee-linked, non-system
 * account. Written as its own predicate so the rule is explicit in code and
 * not a side effect of how the repository joined (C2). The repository query
 * already excludes these; this is the second, independent check.
 */
function isResettableAccount(user) {
  if (!user) return false;
  if (Number(user.is_system_account) === 1) return false;
  if (user.employee_id === null || user.employee_id === undefined) return false;
  if (user.status !== undefined && Number(user.status) !== 1) return false;
  if (user.employee_status !== undefined && user.employee_status !== null && Number(user.employee_status) !== 1) return false;
  return true;
}

/**
 * Linking a Telegram account, and resetting a password through it.
 *
 * Someone who has forgotten their password cannot present a token, so the
 * proof of identity moves to a channel they already hold: they link Telegram
 * once while signed in, and the reset code goes to that chat.
 *
 * Linking deliberately does not accept a typed @username. Anyone can type
 * someone else's. The link is only made when the bot itself sees a `/start`
 * carrying a secret this server issued to a signed-in session, so the chat on
 * the other end is proven rather than claimed.
 *
 * Stage 0A integration (see docs/auth-stage0a-deployment-runbook.md §0):
 *   C1  the new password is written through services/password.js and
 *       repository setModernPassword - scrypt only, never SHA-1;
 *   C2  system / break-glass accounts are refused explicitly, here and in
 *       the repository query, never by join accident;
 *   C3  the unified password policy (utils/password_policy.js) applies,
 *       checked BEFORE the code is spent so a rejected password does not
 *       burn the code;
 *   C4  an unconfigured Telegram client makes the poller a logged no-op.
 *   Every request and completion is audited to user_auth_log; no code, no
 *   password and no token is ever logged.
 */
class PasswordResetUsecase {
  /**
   * @param {object} userRepo
   * @param {object} passwordResetRepo
   * @param {object} telegram
   * @param {object} [deps]
   * @param {object} [deps.authLogRepo]
   * @param {object} [deps.passwords]   services/password override (tests)
   * @param {function} [deps.now]
   */
  constructor(userRepo, passwordResetRepo, telegram, deps = {}) {
    this.userRepo = userRepo;
    this.passwordResetRepo = passwordResetRepo;
    this.telegram = telegram;
    this.authLog = deps.authLogRepo || null;
    this.passwords = deps.passwords || passwordService;
    this.now = deps.now || (() => new Date());
    // Where the update poller has read up to. Held in memory only: passing it
    // back to Telegram acknowledges those updates, so a restart resumes from
    // the first one still unacknowledged rather than replaying history.
    this.updateOffset = null;
    // Re-entrancy guard: a slow getUpdates must not overlap the next tick.
    this.polling = false;
  }

  async audit(event, fields = {}) {
    if (!this.authLog) return;
    try {
      await this.authLog.record({ event, ...fields });
    } catch (err) {
      // never let the audit path change a reset outcome
    }
  }

  /** Whether this user can currently receive a reset code, for the settings screen. */
  async getLinkStatus(userId) {
    const link = await this.passwordResetRepo.getLinkByUserId(userId);
    return {
      linked: Boolean(link),
      telegram_username: link?.telegram_username ?? null,
      linked_at: link?.linked_at ?? null,
      bot_configured: (await this.telegram.getBotUsername()) !== "",
    };
  }

  /**
   * A one-time deep link the signed-in user opens in Telegram.
   *
   * The token is returned to the browser but stored only as a hash, so the
   * row cannot be turned back into a working link by anyone reading the
   * table.
   */
  async startLink(userId) {
    const botUsername = await this.telegram.getBotUsername();
    if (!botUsername) {
      validationError("Could not reach Telegram just now. Try again in a moment.");
    }

    const token = crypto.randomBytes(24).toString("hex");
    await this.passwordResetRepo.createLinkToken(
      userId,
      sha256(token),
      new Date(this.now().getTime() + LINK_TOKEN_TTL_MS)
    );

    return {
      code: 200,
      link: `https://t.me/${botUsername}?start=${token}`,
      expires_in_minutes: Math.round(LINK_TOKEN_TTL_MS / 60000),
    };
  }

  async unlink(userId) {
    await this.passwordResetRepo.deleteLink(userId);
    return { code: 200, msg: "Telegram unlinked" };
  }

  /**
   * Drain messages sent to the bot and complete any linking they carry.
   *
   * Runs on a cron tick rather than a webhook: the API is not required to be
   * reachable from the internet over HTTPS, which a Telegram webhook would
   * demand. With no token configured this is a no-op that logs once per
   * tick at debug level rather than an error every minute.
   */
  async pollTelegramUpdates() {
    if (typeof this.telegram.isConfigured === "function" && !this.telegram.isConfigured()) {
      return { code: 503, linked: 0, skipped: "not_configured" };
    }
    if (this.polling) return { code: 200, linked: 0, skipped: "in_progress" };
    this.polling = true;

    try {
      let updates;
      try {
        updates = await this.telegram.getUpdates(this.updateOffset ?? undefined);
      } catch (err) {
        // A webhook registered on the bot makes getUpdates fail with 409. Say
        // so plainly — silently polling nothing would look like linking is
        // merely slow, and nobody would think to look at the bot's setup.
        logger.Log({
          level: logger.LEVEL.ERROR,
          component: "USECASE.PASSWORD-RESET",
          code: "USECASE.PASSWORD-RESET.POLL",
          description: `${err.toString()} (a webhook set on the bot blocks getUpdates)`,
          category: "",
          ref: {},
        });
        return { code: 500, linked: 0 };
      }

      let linked = 0;
      for (const update of updates || []) {
        if (update.updateId !== undefined) {
          this.updateOffset = Math.max(this.updateOffset ?? 0, update.updateId + 1);
        }

        const message = update.message;
        const payload = parseStartPayload(message?.text);
        if (!payload || !message?.chat?.id) continue;

        try {
          if (await this.completeLink(payload, message.chat, message.from)) linked += 1;
        } catch (err) {
          // The payload (a link token) is never logged.
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "USECASE.PASSWORD-RESET",
            code: "USECASE.PASSWORD-RESET.COMPLETE-LINK",
            description: err.toString(),
            category: "",
            ref: { chat_id: message.chat.id },
          });
        }
      }

      return { code: 200, linked };
    } finally {
      this.polling = false;
    }
  }

  /**
   * Attach the chat that sent `/start <token>` to the user who generated it.
   *
   * The reply matters: a user staring at Telegram is the only one who can
   * tell whether this worked, and an expired link looks exactly like a
   * working one until something says otherwise.
   */
  async completeLink(token, chat, from) {
    const userId = await this.passwordResetRepo.consumeLinkToken(sha256(token));
    if (!userId) {
      await this.telegram
        .sendMessage(
          chat.id,
          "That link has expired or was already used. Open Link Telegram in the app again for a fresh one."
        )
        .catch(() => {});
      return false;
    }

    await this.passwordResetRepo.saveLink(userId, chat.id, from?.username ?? null);
    await this.audit("reset_requested", { userId, detail: "telegram_linked" });
    await this.telegram
      .sendMessage(
        chat.id,
        "Linked. If you ever forget your password, choose Forgot password on the login screen and the code will arrive here."
      )
      .catch(() => {});
    return true;
  }

  /**
   * Send a reset code for `username` to that account's linked Telegram.
   *
   * Always reports the same thing. The caller is not signed in, so telling
   * them whether the account exists — or whether it has Telegram — would
   * hand an attacker a way to enumerate staff. A protected account is
   * treated exactly like an unknown one.
   */
  async requestReset(username, meta = {}) {
    const name = String(username || "").trim();
    try {
      const user = await this.userRepo.getByUsername(name);
      if (!isResettableAccount(user)) {
        await this.audit("reset_requested", {
          username: name,
          ip: meta.ip || null,
          userAgent: meta.userAgent || null,
          detail: user ? "telegram;refused_protected_or_inactive" : "telegram;unknown_user",
        });
        return NEUTRAL_REQUEST_RESULT;
      }

      const link = await this.passwordResetRepo.getLinkByUserId(user.user_id);
      if (!link) {
        await this.audit("reset_requested", { userId: user.user_id, username: name, ip: meta.ip || null, detail: "telegram;not_linked" });
        return NEUTRAL_REQUEST_RESULT;
      }

      const anHourAgo = new Date(this.now().getTime() - 60 * 60 * 1000);
      const recent = await this.passwordResetRepo.countRecentResetCodes(user.user_id, anHourAgo);
      if (recent >= MAX_CODES_PER_HOUR) {
        await this.audit("reset_requested", { userId: user.user_id, username: name, ip: meta.ip || null, detail: "telegram;throttled" });
        return NEUTRAL_REQUEST_RESULT;
      }

      const code = generateCode();
      await this.passwordResetRepo.createResetCode(
        user.user_id,
        sha256(code),
        new Date(this.now().getTime() + RESET_CODE_TTL_MS)
      );

      await this.telegram.sendMessage(
        link.chat_id,
        `Your password reset code is *${code}*\n\n` +
          `Enter it on the login screen — never send it to anyone, and never reply to this chat with it. ` +
          `It expires in ${Math.round(RESET_CODE_TTL_MS / 60000)} minutes and can be used once. ` +
          `If you did not ask for this, ignore this message and tell your manager — someone has your username.`
      );
      await this.audit("reset_requested", { userId: user.user_id, username: name, ip: meta.ip || null, userAgent: meta.userAgent || null, detail: "telegram;sent" });
    } catch (err) {
      // A delivery failure must not change the answer either: the difference
      // between "sent" and "failed" is itself a signal about the account.
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.PASSWORD-RESET",
        code: "USECASE.PASSWORD-RESET.REQUEST",
        description: err.toString(),
        category: "",
        ref: {},
      });
    }

    return NEUTRAL_REQUEST_RESULT;
  }

  /**
   * Set a new password given a code delivered over Telegram.
   *
   * Unlike the request step this does report why it failed: the user is
   * holding a code they believe is right, and "wrong or expired" is the
   * difference between retyping and asking for a new one. It reveals nothing
   * — reaching here already required a code sent to a linked chat.
   *
   * Order matters for the employee experience: the new password is checked
   * against policy FIRST, so a password that is now refused (C3) does not
   * spend the code, and the same code can be retried with a better password.
   */
  async resetPassword(username, code, newPassword, meta = {}) {
    const name = String(username || "").trim();
    const next = typeof newPassword === "string" ? newPassword : "";

    const INVALID = {
      code: 400,
      error: "INVALID_CODE",
      msg: "That code is wrong or has expired. Request a new one.",
    };

    const user = await this.userRepo.getByUsername(name);
    if (!isResettableAccount(user)) {
      await this.audit("reset_completed", {
        username: name,
        ip: meta.ip || null,
        detail: user ? "telegram;failed:refused_protected_or_inactive" : "telegram;failed:unknown_user",
      });
      // Same answer as a wrong code: the caller learns nothing about the account.
      return INVALID;
    }

    // C3: policy before anything is spent. The message names what to fix.
    const verdict = policy.check(next, {
      username: user.username,
      employeeId: user.employee_id,
      mobile: user.primary_contact_number,
    });
    if (!verdict.ok) {
      return {
        code: 400,
        error: "PASSWORD_POLICY",
        msg: `${verdict.reason}. Your code is still valid — choose a different password and try again.`,
      };
    }

    const active = await this.passwordResetRepo.getActiveResetCode(user.user_id);
    if (!active) return INVALID;

    if (active.attempts >= MAX_RESET_ATTEMPTS) {
      await this.passwordResetRepo.consumeResetCode(active.id);
      await this.audit("reset_completed", { userId: user.user_id, username: name, ip: meta.ip || null, detail: "telegram;failed:too_many_attempts" });
      return {
        code: 400,
        error: "TOO_MANY_ATTEMPTS",
        msg: "Too many wrong codes. Request a new one.",
      };
    }

    // Constant-time: the comparison is over hashes of equal length, so a
    // timing difference cannot leak how much of a guess was right.
    const supplied = Buffer.from(sha256(String(code ?? "")));
    const expected = Buffer.from(active.code_hash);
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
      await this.passwordResetRepo.recordResetAttempt(active.id);
      await this.audit("reset_completed", { userId: user.user_id, username: name, ip: meta.ip || null, detail: "telegram;failed:wrong_code" });
      return INVALID;
    }

    // Spend the code before writing the password: if two requests race, only
    // the one that claims the row gets to change anything.
    if (!(await this.passwordResetRepo.consumeResetCode(active.id))) return INVALID;

    // C1: modern hash only. setModernPassword sets password_algo='scrypt',
    // nulls the legacy column, stamps password_migrated_at and
    // token_valid_from, clears must_change_password, and carries the
    // system-account guard in its SQL.
    const hash = await this.passwords.hash(next);
    await this.userRepo.setModernPassword(user.user_id, hash, { clearMustChange: true });
    await this.audit("reset_completed", { userId: user.user_id, username: name, ip: meta.ip || null, userAgent: meta.userAgent || null, detail: "telegram" });
    return { code: 200, msg: "Password updated. Sign in with your new password." };
  }
}

module.exports = (userRepo, passwordResetRepo, telegram, deps) => {
  return new PasswordResetUsecase(userRepo, passwordResetRepo, telegram, deps);
};

module.exports.parseStartPayload = parseStartPayload;
module.exports.isResettableAccount = isResettableAccount;
module.exports.MAX_RESET_ATTEMPTS = MAX_RESET_ATTEMPTS;
module.exports.RESET_CODE_TTL_MS = RESET_CODE_TTL_MS;
module.exports.NEUTRAL_REQUEST_RESULT = NEUTRAL_REQUEST_RESULT;
