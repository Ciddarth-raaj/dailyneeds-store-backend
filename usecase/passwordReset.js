const crypto = require("crypto");
const logger = require("../utils/logger");

/** How long a `t.me/<bot>?start=...` deep link stays usable. */
const LINK_TOKEN_TTL_MS = 15 * 60 * 1000;

/** How long a reset code stays usable. Short: it arrives instantly. */
const RESET_CODE_TTL_MS = 10 * 60 * 1000;

/** Wrong guesses allowed against one code before it is dead. */
const MAX_RESET_ATTEMPTS = 5;

/** Codes one account may be sent per hour, so the bot cannot be used to spam. */
const MAX_CODES_PER_HOUR = 5;

/** Shortest password a reset may set. Matches the change-password rule. */
const MIN_PASSWORD_LENGTH = 6;

/**
 * What every forgot-password request answers, whatever actually happened.
 *
 * The screen must not become a way to discover which usernames exist or
 * whose Telegram is linked, so an unknown user, an unlinked one and a
 * successful send are indistinguishable from outside.
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
 */
class PasswordResetUsecase {
  constructor(userRepo, passwordResetRepo, telegram) {
    this.userRepo = userRepo;
    this.passwordResetRepo = passwordResetRepo;
    this.telegram = telegram;
    // Where the update poller has read up to. Held in memory only: passing it
    // back to Telegram acknowledges those updates, so a restart resumes from
    // the first one still unacknowledged rather than replaying history.
    this.updateOffset = null;
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
    // The bot names itself (see getBotUsername), so this is a reachability
    // problem rather than a missing setting — say so, since the fix differs.
    const botUsername = await this.telegram.getBotUsername();
    if (!botUsername) {
      validationError(
        "Could not reach Telegram just now. Try again in a moment."
      );
    }

    const token = crypto.randomBytes(24).toString("hex");
    await this.passwordResetRepo.createLinkToken(
      userId,
      sha256(token),
      new Date(Date.now() + LINK_TOKEN_TTL_MS)
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
   * demand.
   */
  async pollTelegramUpdates() {
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
   * hand an attacker a way to enumerate staff.
   */
  async requestReset(username) {
    try {
      const user = await this.userRepo.getByUsername(String(username || "").trim());
      if (!user) return NEUTRAL_REQUEST_RESULT;

      const link = await this.passwordResetRepo.getLinkByUserId(user.user_id);
      if (!link) return NEUTRAL_REQUEST_RESULT;

      const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      const recent = await this.passwordResetRepo.countRecentResetCodes(
        user.user_id,
        anHourAgo
      );
      if (recent >= MAX_CODES_PER_HOUR) return NEUTRAL_REQUEST_RESULT;

      const code = generateCode();
      await this.passwordResetRepo.createResetCode(
        user.user_id,
        sha256(code),
        new Date(Date.now() + RESET_CODE_TTL_MS)
      );

      await this.telegram.sendMessage(
        link.chat_id,
        `Your password reset code is *${code}*\n\n` +
          `It expires in ${Math.round(RESET_CODE_TTL_MS / 60000)} minutes and can be used once. ` +
          `If you did not ask for this, ignore this message and tell your manager — someone has your username.`
      );
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
   */
  async resetPassword(username, code, newPassword) {
    const next = typeof newPassword === "string" ? newPassword : "";
    if (next.length < MIN_PASSWORD_LENGTH) {
      validationError(
        `New password must be at least ${MIN_PASSWORD_LENGTH} characters`
      );
    }

    const INVALID = {
      code: 400,
      error: "INVALID_CODE",
      msg: "That code is wrong or has expired. Request a new one.",
    };

    const user = await this.userRepo.getByUsername(String(username || "").trim());
    if (!user) return INVALID;

    const active = await this.passwordResetRepo.getActiveResetCode(user.user_id);
    if (!active) return INVALID;

    if (active.attempts >= MAX_RESET_ATTEMPTS) {
      await this.passwordResetRepo.consumeResetCode(active.id);
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
    if (
      supplied.length !== expected.length ||
      !crypto.timingSafeEqual(supplied, expected)
    ) {
      await this.passwordResetRepo.recordResetAttempt(active.id);
      return INVALID;
    }

    // Spend the code before writing the password: if two requests race, only
    // the one that claims the row gets to change anything.
    if (!(await this.passwordResetRepo.consumeResetCode(active.id))) return INVALID;

    await this.userRepo.updatePassword(user.user_id, next);
    return { code: 200, msg: "Password updated. Sign in with your new password." };
  }
}

module.exports = (userRepo, passwordResetRepo, telegram) => {
  return new PasswordResetUsecase(userRepo, passwordResetRepo, telegram);
};

module.exports.parseStartPayload = parseStartPayload;
module.exports.MIN_PASSWORD_LENGTH = MIN_PASSWORD_LENGTH;
module.exports.MAX_RESET_ATTEMPTS = MAX_RESET_ATTEMPTS;
