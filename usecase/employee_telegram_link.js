const crypto = require("crypto");
const logger = require("../utils/logger");
const { normalizeIndianMobile, mobilesMatch } = require("../utils/mobile_number");
const { employedOn } = require("../utils/attendance_eligibility");
const { istDateOf } = require("../utils/istDate");
const { resolveTelegramState } = require("../utils/employee_telegram_status");
const {
  EMPLOYEE_LINK_PREFIX,
  LINK_TOKEN_TTL_MS,
  PENDING_TTL_MS,
  TELEGRAM_STATUS,
  PENDING_OUTCOME,
  AUDIT_EVENT,
  BOT_MESSAGE,
  CONTACT_REQUEST_KEYBOARD,
} = require("../constants/employee_telegram");

/**
 * EMPLOYEE TELEGRAM IDENTITY - connecting an employee's own Telegram account.
 *
 * ================================ WHAT THIS IS NOT =========================
 *
 * It is NOT the password-reset linking in `usecase/passwordReset.js`, and it
 * does not extend it. That flow links a dnds.co.in LOGIN (`telegram_links` is
 * keyed by `user_id`) so a forgotten password can be reset. Most of the ~200
 * employees this is for have no login at all, so an identity built on
 * `user_id` could not exist for them. Two flows, two tables, one bot, one
 * poller.
 *
 * What IS reused is the shape of the secure bits, because they were got right
 * once: a random token shown to the browser and stored only as a sha256 hash,
 * a short expiry, a deep link the employee opens in Telegram, and a chat the
 * BOT ITSELF OBSERVED rather than one anybody typed in.
 *
 * ============================ THE IDENTITY IS THE EMPLOYEE'S ==============
 *
 * The person operating the screen is usually NOT the person being linked - a
 * manager generates the QR, the employee scans it on their own phone. So the
 * token carries `employee_id`, bound at issue time on the server, and the
 * signed-in user is recorded only for the audit. There is no path by which the
 * manager's own Telegram account could end up attached to the employee's
 * record: the token decides the employee, and the `/start` decides the
 * Telegram account, and neither can be supplied by the browser.
 *
 * ================================ TWO STEPS, NOT ONE ======================
 *
 * `/start e_<token>` tells us the employee, the Telegram user and the private
 * chat - but NOT that this is the right person. Anybody holding the QR could
 * scan it. So nothing is written to `employee_telegram_identity` at that
 * point: the token row becomes a short-lived PENDING VERIFICATION, the bot
 * asks for the phone number, and only a MATCH creates the permanent identity.
 * A half-verified identity is not a state this feature can be in.
 *
 * THE PENDING STATE IS IN THE DATABASE, not in a Map. The employee scans the
 * code and then looks for the button; a restart in between must not leave them
 * tapping something that answers nothing.
 *
 * =========================== THE CONTACT MUST BE THEIR OWN ================
 *
 * Telegram lets anyone forward somebody else's contact card, and a forwarded
 * card carries that other person's number. So `contact.userId` MUST equal
 * `from.id`. Without that one comparison, employee A verifies as employee B by
 * forwarding B's contact - which is the whole feature defeated. It is checked
 * before the number is even normalised.
 *
 * ============================== WHAT IS NEVER SAID ========================
 *
 * No reply from this bot names a mobile number - not the shared one, not the
 * stored one, not a masked form of either. The employee already holds one of
 * them, and the reply is readable by whoever holds the phone; echoing either
 * could only disclose. A mismatch says what to do, and nothing about what was
 * compared.
 */

const sha256 = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");

const validationError = (message) => {
  const error = new Error(message);
  error.name = "ValidationError";
  throw error;
};

/**
 * `/start e_<token>` -> the token, or null.
 *
 * PURE, SYNCHRONOUS AND CHEAP, because `claims` calls it on every message the
 * bot receives and the whole claim contract rests on it never being able to
 * fail slowly. It does not look at the database and it never will.
 */
function parseEmployeeStartPayload(text) {
  if (typeof text !== "string") return null;
  const match = text.trim().match(/^\/start(?:@\w+)?\s+(\S+)$/);
  if (!match) return null;
  const payload = match[1];
  if (!payload.startsWith(EMPLOYEE_LINK_PREFIX)) return null;
  const token = payload.slice(EMPLOYEE_LINK_PREFIX.length);
  return token.length > 0 ? token : null;
}

/**
 * IS THIS PERSON EMPLOYED HERE TODAY? Checked at issue AND again at the
 * moment of verification.
 *
 * `new_employee.status` IS NOT THE ANSWER, AND MUST NOT BE THE ONLY ONE.
 * It is maintained by hand and has been left at 1 for most leavers - the
 * reason `utils/attendance_eligibility.js` refuses to read it at all and
 * decides from the dated employment facts instead. An employee who resigned
 * two years ago and whose `status` was never changed would otherwise be able
 * to generate a QR and connect a Telegram account to a live employee record.
 *
 * So the DATED RULE IS THE AUTHORITY, and it is the shared one - `employedOn`
 * from that module, the same function the attendance dashboard uses, so there
 * is no second interpretation of "employed on a date" to drift. It reads
 * `date_of_joining` and `resignation_date`: a resignation date in the past
 * excludes, and a joining date in the future excludes.
 *
 * `attendance_required` IS DELIBERATELY NOT CONSULTED. That column says
 * somebody is exempt from punching, not that they have left; an exempt
 * employee is still an employee and still gets Telegram. `employedOn` is
 * exactly the half of `eligibleOn` that leaves it out.
 *
 * STATUS IS STILL READ, BUT ONLY TO REFUSE. Where it says 0 the record has
 * been explicitly deactivated, and this feature should not connect anybody on
 * the strength of dates alone in that case. It can never ADMIT somebody the
 * dates exclude - which is the direction it is unreliable in.
 */
function isEligibleEmployee(employee, today) {
  if (!employee) return false;
  if (employee.status !== undefined && employee.status !== null && Number(employee.status) !== 1) {
    return false;
  }
  return employedOn(employee, today);
}

/**
 * Today, as the YYYY-MM-DD the dated rule compares - IN IST, ALWAYS.
 *
 * NOT the process's local date. The business day an employment fact belongs
 * to is the Indian one, and this API runs wherever it happens to be deployed:
 * reading `getFullYear()`/`getMonth()`/`getDate()` off a Date would make "is
 * this person employed today" depend on the host's zone, so between 18:30 and
 * midnight UTC a resignation effective yesterday would still look current for
 * several hours. `utils/istDate.js` already owns this arithmetic for the
 * work-shift and regularization rules; this is the same helper, given this
 * class's injected clock rather than `Date.now()`.
 */
const dateOnly = (now) => istDateOf(now);

class EmployeeTelegramLinkUsecase {
  /**
   * @param {object} repo      repository/employee_telegram
   * @param {object} telegram  services/telegram
   * @param {object} [deps]
   * @param {function} [deps.now]
   */
  constructor(repo, telegram, deps = {}) {
    this.repo = repo;
    this.telegram = telegram;
    this.now = deps.now || (() => new Date());
  }

  _log(code, description, ref = {}) {
    logger.Log({
      level: logger.LEVEL.ERROR,
      component: "USECASE.EMPLOYEE-TELEGRAM",
      code: `USECASE.EMPLOYEE-TELEGRAM.${code}`,
      description,
      category: "",
      ref,
    });
  }

  /** Say something to the employee. A delivery failure is never load-bearing. */
  async _say(chatId, text, options = {}) {
    try {
      // parseMode null: these are plain sentences, and a stray `_` in one must
      // not make Telegram reject the whole message.
      await this.telegram.sendMessage(chatId, text, { parseMode: null, ...options });
      return true;
    } catch (err) {
      this._log("SEND", err.toString(), { chat_id: chatId });
      return false;
    }
  }

  /* ------------------------------------------------------- issuing a link */

  /**
   * A one-time deep link for ONE employee.
   *
   * The caller has already been checked by the route - the permission key and
   * the branch scope - so what is enforced here is what the route cannot see:
   * that the employee exists, is still active, and has a usable mobile on file
   * to compare against at all.
   *
   * REFUSING EARLY ON A MALFORMED MOBILE IS DELIBERATE. The alternative is a
   * QR that can never succeed, an employee who scans it and is told their
   * number does not match, and a manager with no idea why. The message names
   * the fix.
   */
  async startLink(employeeId, { actorUserId = null } = {}) {
    const employee = await this.repo.getEmployeeForVerification(employeeId);
    if (!employee) validationError("That employee does not exist.");
    if (!isEligibleEmployee(employee, dateOnly(this.now()))) {
      await this.repo.audit({
        employeeId,
        event: AUDIT_EVENT.EMPLOYEE_INELIGIBLE,
        actorUserId,
        detail: "token_issue",
      });
      validationError(
        "This employee is not currently employed, so Telegram cannot be connected."
      );
    }
    if (normalizeIndianMobile(employee.primary_contact_number) === null) {
      validationError(
        "This employee has no valid 10-digit mobile number on record, so Telegram cannot be verified. Correct the mobile number first."
      );
    }

    const botUsername = await this.telegram.getBotUsername();
    if (!botUsername) {
      validationError("Could not reach Telegram just now. Try again in a moment.");
    }

    const token = crypto.randomBytes(24).toString("hex");
    await this.repo.createLinkToken(
      employeeId,
      sha256(token),
      new Date(this.now().getTime() + LINK_TOKEN_TTL_MS),
      actorUserId,
      PENDING_OUTCOME.SUPERSEDED
    );
    await this.repo.audit({
      employeeId,
      event: AUDIT_EVENT.TOKEN_ISSUED,
      actorUserId,
      detail: "link_token",
    });

    return {
      code: 200,
      // The QR encodes THIS and nothing else: a bot address and an opaque
      // secret. No employee id, no name, no mobile, no chat id.
      link: `https://t.me/${botUsername}?start=${EMPLOYEE_LINK_PREFIX}${token}`,
      expires_in_minutes: Math.round(LINK_TOKEN_TTL_MS / 60000),
      expires_at: new Date(this.now().getTime() + LINK_TOKEN_TTL_MS).toISOString(),
    };
  }

  /* -------------------------------------------------------------- status */

  /**
   * What the screens will eventually show. FOUR SEPARATE ANSWERS, because
   * "is anything outstanding" is a different question from "is the mobile
   * verified", and a lifecycle built on one boolean cannot tell them apart.
   *
   * It returns no Telegram user id, no chat id and no mobile number. A
   * username is included because it is what a human recognises when confirming
   * they linked the right account, and it is not proof of anything.
   */
  async getStatus(employeeId) {
    const [identity, rows] = await Promise.all([
      this.repo.getActiveIdentityByEmployee(employeeId),
      this.repo.getCurrentAttemptRows(employeeId),
    ]);

    // THE PRECEDENCE IS NOT WRITTEN HERE. It is shared with the onboarding
    // dashboard's bulk summary (`utils/employee_telegram_status.js`), applied
    // to the same facts, so a badge on a list and the status on this
    // employee's own screen cannot drift apart - including how they break a
    // tie between two attempts issued inside one second.
    const resolved = resolveTelegramState({
      hasActiveIdentity: Boolean(identity),
      rows: rows || [],
    });

    return {
      code: 200,
      data: {
        status: resolved.status,
        connected: Boolean(identity),
        mobile_verified: Boolean(identity),
        telegram_username: identity ? identity.telegram_username || null : null,
        connected_at: identity ? identity.connected_at : null,
        /**
         * WHAT THE LINK IN FRONT OF THE USER HAS COME TO - additive, and the
         * reason it exists is RECONNECT.
         *
         * When a connected employee links a different Telegram account the old
         * identity is deliberately kept until the new one verifies, so `status`
         * reads CONNECTED throughout. A screen watching only `status` would
         * therefore see "connected" the instant it generated the new QR and
         * conclude the employee had already finished - declaring success for a
         * verification that has not happened.
         *
         * This says what the CURRENT attempt is doing, independently of the
         * identity: NONE, PENDING, AWAITING_CONTACT, MOBILE_MISMATCH or
         * VERIFIED. It carries no token, no hash, no mobile number, no
         * Telegram user id and no chat id - it is a single word about progress.
         */
        link_attempt: resolved.attempt,
      },
    };
  }

  /* ---------------------------------------------------- the update handler */

  /**
   * DOES THIS UPDATE BELONG TO US?
   *
   * PURE AND SYNCHRONOUS, and it must stay that way. The dispatcher evaluates
   * every claim BEFORE running any handler precisely so that ownership holds
   * when the handler behind it throws or times out; a predicate that awaited a
   * database read could not offer that, and a slow database would start
   * handing employee deep links back to the password-reset branch - which
   * would answer them with "that link has expired".
   *
   * IT CLAIMS ONLY `/start e_…` IN A PRIVATE CHAT. An ordinary contact message
   * is NOT claimed: claiming it would mean claiming every contact anybody ever
   * shares with the bot, and password-reset linking has no interest in
   * contacts anyway. The handler still processes them - see `handle`.
   */
  claims(update) {
    const message = update && update.message;
    if (!message || !message.chat || message.chat.type !== "private") return false;
    return parseEmployeeStartPayload(message.text) !== null;
  }

  /**
   * One update from the dispatcher. MUST NEVER THROW - it runs inside the
   * single poll loop, beside password-reset linking.
   */
  async handle(update) {
    try {
      const message = update && update.message;
      if (!message || !message.chat || message.chat.type !== "private") return null;

      const token = parseEmployeeStartPayload(message.text);
      if (token !== null) return await this.onStart(token, message);
      if (message.contact) return await this.onContact(message);
      return null;
    } catch (err) {
      // The payload, the contact and the message text are never logged.
      this._log("HANDLE", err.toString(), {});
      return null;
    }
  }

  /**
   * `/start e_<token>` - claim the token and open the pending verification.
   *
   * The token is CLAIMED BY THE UPDATE ITSELF in the repository, so of two
   * `/start`s arriving together exactly one opens a session. The loser is told
   * the link is spent, which is true for it.
   */
  async onStart(token, message) {
    const chatId = message.chat.id;
    const from = message.from || {};
    const telegramUserId = from.id;
    if (!telegramUserId) return null;

    const pendingExpiresAt = new Date(this.now().getTime() + PENDING_TTL_MS);
    const employeeId = await this.repo.consumeLinkToken(sha256(token), {
      telegramUserId,
      chatId,
      username: from.username || null,
      pendingExpiresAt,
    });

    if (!employeeId) {
      await this.repo.audit({
        event: AUDIT_EVENT.TOKEN_REJECTED,
        telegramUserId,
        detail: "expired_or_used",
      });
      await this._say(chatId, BOT_MESSAGE.LINK_INVALID);
      return { outcome: "TOKEN_REJECTED" };
    }

    await this.repo.audit({
      employeeId,
      event: AUDIT_EVENT.TOKEN_CONSUMED,
      telegramUserId,
      detail: "start",
    });

    // ELIGIBILITY IS RE-READ HERE, not taken from the moment the QR was made.
    // A resignation can be recorded between generating a link and scanning it.
    const employee = await this.repo.getEmployeeForVerification(employeeId);
    if (!isEligibleEmployee(employee, dateOnly(this.now()))) {
      await this.repo.closePending(sha256(token), PENDING_OUTCOME.EMPLOYEE_INELIGIBLE);
      await this.repo.audit({
        employeeId,
        event: AUDIT_EVENT.EMPLOYEE_INELIGIBLE,
        telegramUserId,
        detail: "start",
      });
      await this._say(chatId, BOT_MESSAGE.EMPLOYEE_INELIGIBLE);
      return { outcome: "EMPLOYEE_INELIGIBLE" };
    }

    // THE ONLY WAY TO GIVE US A NUMBER IS THE BUTTON. It is never asked for as
    // text: a typed number proves nothing about who is typing it.
    await this._say(chatId, BOT_MESSAGE.ASK_FOR_CONTACT, {
      replyMarkup: CONTACT_REQUEST_KEYBOARD,
    });
    return { outcome: "AWAITING_CONTACT", employeeId };
  }

  /**
   * A shared contact - the second half, where verification actually happens.
   *
   * ORDER MATTERS AND IS DELIBERATE:
   *   1  is there a live pending verification for THIS Telegram user?
   *   2  is the contact the sender's own?          <- the security check
   *   3  is the employee still eligible?
   *   4  is this Telegram account free?
   *   5  do the numbers match?
   * Only then is an identity written.
   */
  async onContact(message) {
    const chatId = message.chat.id;
    const from = message.from || {};
    const telegramUserId = from.id;
    const contact = message.contact || {};
    if (!telegramUserId) return null;

    const pending = await this.repo.getPendingByTelegramUser(telegramUserId);
    if (!pending) {
      // Not part of any employee flow. Say nothing that implies one exists.
      return null;
    }

    const employeeId = pending.employee_id;

    // 2 - THE FORWARDED-CONTACT CHECK. `contact.userId` is the camelCase the
    // client hands back; `user_id` is Telegram's own spelling, accepted so a
    // client upgrade cannot silently turn this check off. A contact with NO
    // owner id is a manually created card and is refused for the same reason.
    const contactOwnerId = contact.userId !== undefined ? contact.userId : contact.user_id;
    if (contactOwnerId === undefined || contactOwnerId === null || Number(contactOwnerId) !== Number(telegramUserId)) {
      await this.repo.audit({
        employeeId,
        event: AUDIT_EVENT.CONTACT_NOT_OWNED,
        telegramUserId,
        detail: "forwarded_contact",
      });
      await this._say(chatId, BOT_MESSAGE.CONTACT_NOT_OWNED, {
        replyMarkup: CONTACT_REQUEST_KEYBOARD,
      });
      // The pending session is LEFT OPEN on purpose: somebody who forwarded
      // the wrong card should be able to tap the right button, and closing it
      // would mean a fresh QR for an honest mistake.
      return { outcome: PENDING_OUTCOME.CONTACT_NOT_OWNED };
    }

    // 3 - eligibility again, at the last possible moment.
    const employee = await this.repo.getEmployeeForVerification(employeeId);
    if (!isEligibleEmployee(employee, dateOnly(this.now()))) {
      await this.repo.closePending(pending.token_hash, PENDING_OUTCOME.EMPLOYEE_INELIGIBLE);
      await this.repo.audit({
        employeeId,
        event: AUDIT_EVENT.EMPLOYEE_INELIGIBLE,
        telegramUserId,
        detail: "contact",
      });
      await this._say(chatId, BOT_MESSAGE.EMPLOYEE_INELIGIBLE);
      return { outcome: PENDING_OUTCOME.EMPLOYEE_INELIGIBLE };
    }

    // 4 - ONE TELEGRAM ACCOUNT, ONE EMPLOYEE. Checked here so the reply is a
    // sentence rather than a driver error - but NOT decided here: the
    // transaction below re-reads it under a lock, and that is what actually
    // settles a race. The reply names nobody.
    const existing = await this.repo.getActiveIdentityByTelegramUser(telegramUserId);
    if (existing && Number(existing.employee_id) !== Number(employeeId)) {
      await this.repo.closePending(pending.token_hash, PENDING_OUTCOME.DUPLICATE_IDENTITY);
      await this.repo.audit({
        employeeId,
        event: AUDIT_EVENT.DUPLICATE_IDENTITY,
        telegramUserId,
        detail: "already_linked",
      });
      await this._say(chatId, BOT_MESSAGE.DUPLICATE_IDENTITY);
      return { outcome: PENDING_OUTCOME.DUPLICATE_IDENTITY };
    }

    // 5 - the comparison, on normalised values only. Neither number is echoed.
    const sharedNumber = contact.phoneNumber !== undefined ? contact.phoneNumber : contact.phone_number;
    if (!mobilesMatch(sharedNumber, employee.primary_contact_number)) {
      await this.repo.closePending(pending.token_hash, PENDING_OUTCOME.MOBILE_MISMATCH);
      await this.repo.audit({
        employeeId,
        event: AUDIT_EVENT.MOBILE_MISMATCH,
        telegramUserId,
        detail: "mismatch",
      });
      await this._say(chatId, BOT_MESSAGE.MOBILE_MISMATCH);
      return { outcome: PENDING_OUTCOME.MOBILE_MISMATCH };
    }

    // 6 - FINALISE, IN ONE TRANSACTION.
    //
    // Everything above this line is a read that can be repeated harmlessly.
    // Everything that WRITES an identity happens inside
    // `finalizeVerification`: claiming the pending row, retiring a replaced
    // identity and inserting the new one are one unit, so two copies of the
    // same contact message cannot both get past the claim, and a failed
    // insert cannot leave an employee with the old identity already retired
    // and no new one in its place.
    let finalised;
    try {
      finalised = await this.repo.finalizeVerification({
        tokenHash: pending.token_hash,
        employeeId,
        telegramUserId,
        chatId,
        username: from.username || null,
        verifiedMobile: normalizeIndianMobile(sharedNumber),
        verifiedOutcome: PENDING_OUTCOME.VERIFIED,
      });
    } catch (err) {
      // A DATABASE FAILURE IS NOT A DUPLICATE. The transaction rolled back, so
      // the employee still has whatever identity they had and the pending row
      // is still open - they can tap the button again. Saying "already
      // connected to another employee" here would be a lie that sends them to
      // HR about a problem that does not exist.
      this._log("FINALIZE", err.toString(), { employee_id: employeeId });
      await this._say(chatId, BOT_MESSAGE.TRY_AGAIN);
      return { outcome: "ERROR" };
    }

    if (finalised.outcome === "DUPLICATE_IDENTITY") {
      await this.repo.closePending(pending.token_hash, PENDING_OUTCOME.DUPLICATE_IDENTITY);
      await this.repo.audit({
        employeeId,
        event: AUDIT_EVENT.DUPLICATE_IDENTITY,
        telegramUserId,
        detail: "unique_violation",
      });
      await this._say(chatId, BOT_MESSAGE.DUPLICATE_IDENTITY);
      return { outcome: PENDING_OUTCOME.DUPLICATE_IDENTITY };
    }

    // SOMEBODY ELSE ALREADY FINISHED THIS ONE - a duplicate contact message,
    // or a Telegram retry. The work is done and was done correctly; this
    // caller simply says nothing and writes nothing, which is what makes the
    // whole leg idempotent rather than merely safe.
    if (finalised.outcome === "ALREADY_FINALISED") {
      return { outcome: "ALREADY_FINALISED" };
    }

    await this.repo.audit({
      employeeId,
      event: AUDIT_EVENT.CONNECTED,
      telegramUserId,
      detail: "verified",
    });
    await this._say(chatId, BOT_MESSAGE.CONNECTED);
    return { outcome: PENDING_OUTCOME.VERIFIED, employeeId };
  }

  /* ---------------------------------------------------------- disconnect */

  /**
   * Retire an employee's Telegram identity.
   *
   * Included in this phase because reconnect needs it anyway: a mistyped
   * mobile corrected after a wrong account connected must be undoable without
   * a database edit. It writes history rather than deleting it.
   */
  async disconnect(employeeId, { actorUserId = null, reason = "MANUAL" } = {}) {
    const removed = await this.repo.disconnectActiveIdentity(employeeId, reason);
    if (removed > 0) {
      await this.repo.audit({
        employeeId,
        event: AUDIT_EVENT.DISCONNECTED,
        actorUserId,
        detail: reason,
      });
    }
    return { code: 200, disconnected: removed > 0 };
  }
}

module.exports = (repo, telegram, deps) => new EmployeeTelegramLinkUsecase(repo, telegram, deps);
module.exports.EmployeeTelegramLinkUsecase = EmployeeTelegramLinkUsecase;
module.exports.parseEmployeeStartPayload = parseEmployeeStartPayload;
module.exports.isEligibleEmployee = isEligibleEmployee;
