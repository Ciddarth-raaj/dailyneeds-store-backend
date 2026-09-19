/**
 * THE BOT'S HOME MENU - what a plain `/start` answers with.
 *
 * ================================= WHAT THIS OWNS, AND ONLY THIS ===========
 *
 * A PLAIN `/start` IN A PRIVATE CHAT. Nothing else. Not `/start e_<token>`
 * (the employee link), not `/start <48-hex>` (a password reset), not a group
 * `/setup`, not a shared contact.
 *
 * ========================= WHY PLAIN `/start` IS FREE TO CLAIM =============
 *
 * `usecase/passwordReset.js#parseStartPayload` is
 * `/^\/start(?:@\w+)?\s+(\S+)$/` - the `\s+(\S+)` makes a payload MANDATORY.
 * A bare `/start` has never matched it, so the password-reset branch has
 * always ignored one and still does: this handler takes over something that
 * previously fell on the floor, rather than taking something away.
 *
 * The claim below is the mirror image - `\s*$` where that one has `\s+(\S+)` -
 * so the two predicates are mutually exclusive by construction, and
 * `usecase/telegram_employee_menu.test.js` asserts exactly that against the
 * real parser rather than against a copy of it.
 *
 * It claims all the same, rather than merely observing. A plain `/start` that
 * this handler answers must not ALSO fall through to the poller's linking
 * branch if that regex is ever loosened; claiming makes the guarantee
 * structural instead of a property of somebody else's regex.
 *
 * ================================= WHO GETS THE EMPLOYEE MENU ==============
 *
 * ONLY A VERIFIED, ACTIVE `employee_telegram_identity`, resolved from
 * `message.from.id` - the Telegram user id the BOT OBSERVED, which the sender
 * cannot set. Never from the message text, never from a URL, never from a
 * username or a display name, and there is no parameter anywhere in this file
 * that could carry an employee id inward.
 *
 * An unlinked Telegram user gets one flat sentence pointing them at Daily
 * Needs, and NOTHING ELSE: not whether that Telegram account was ever
 * connected, not whether an employee exists, not a name, not a code. Somebody
 * messaging the bot to find out who is who learns nothing either way.
 *
 * ========================= NO MINI APP URL MEANS NO BUTTONS ================
 *
 * The menu text still sends, with no keyboard. An employee sees the bot is
 * alive and reaches HR by the usual route; nothing crashes and nothing lies
 * about a screen that is not deployed.
 *
 * ======================================= WHAT IS NEVER LOGGED ==============
 *
 * No message text, no `/start` payload, no username, no chat title. The
 * Telegram user id and the chat id are the operational minimum, and the
 * employee id is recorded only where the audit trail already records it.
 */

const { webAppKeyboard, SECTION } = require("../utils/telegram_mini_app_url");

/**
 * A PLAIN `/start`: the command, an optional `@botname`, and nothing after it.
 *
 * `\s*$` is the exact complement of the password-reset parser's `\s+(\S+)$`.
 * `/start@dnds_bot` is included because Telegram appends the bot's name in
 * groups and some clients do it in private chats too.
 */
const PLAIN_START_RE = /^\/start(?:@\w+)?\s*$/;

/** The heading and the button labels, in one place. */
const MENU = Object.freeze({
  TITLE: "Daily Needs Employee Services",
  BUTTONS: Object.freeze([
    { text: "My Attendance", section: SECTION.ATTENDANCE },
    { text: "Corrections", section: SECTION.CORRECTIONS },
    { text: "Help", section: SECTION.HELP },
  ]),
});

/**
 * What an unlinked Telegram user is told.
 *
 * It names no employee, confirms nothing about this Telegram account, and
 * points at the one route that can actually help. "Not set up" is the only
 * fact disclosed, and it is a fact about the SENDER, who already knows it.
 */
const UNLINKED_MESSAGE =
  "This Telegram account is not set up for Daily Needs employee services.\n\n" +
  "Please ask your manager or HR to complete your Telegram setup in Daily Needs.";

/** True for a plain `/start` arriving in a 1:1 chat with the bot. */
function isPlainStart(message) {
  if (!message || !message.chat || message.chat.type !== "private") return false;
  return typeof message.text === "string" && PLAIN_START_RE.test(message.text.trim());
}

/**
 * The menu keyboard for a base URL, or null when none is configured.
 *
 * EXPORTED so `usecase/employee_telegram_link.js` can show the SAME menu the
 * instant verification succeeds, without rebuilding the button list. One
 * definition of the menu, two places it appears.
 */
function buildMenuKeyboard(miniAppBaseUrl) {
  return webAppKeyboard(miniAppBaseUrl, MENU.BUTTONS);
}

/**
 * @param {object} deps
 * @param {object} deps.identityRepo  repository/employee_telegram.js
 * @param {object} deps.telegram      services/telegram.js
 * @param {function():?string} deps.getMiniAppUrl  read lazily; may return null
 * @param {object} [deps.log]
 */
module.exports = ({ identityRepo, telegram, getMiniAppUrl, log = null }) => {
  const COMPONENT = "USECASE.TELEGRAM-EMPLOYEE-MENU";

  const say = (code, description, ref = {}, level) => {
    if (!log || typeof log.Log !== "function") return;
    try {
      log.Log({
        level: level || (log.LEVEL && log.LEVEL.ERROR) || "error",
        component: COMPONENT,
        code: `${COMPONENT}.${code}`,
        description,
        category: "",
        ref,
      });
    } catch (err) {
      // A broken logger must never stop an employee getting their menu.
    }
  };

  /** Send, never throw. A delivery failure is logged and swallowed. */
  const send = async (chatId, text, keyboard) => {
    try {
      await telegram.sendMessage(
        chatId,
        text,
        // Plain text: the title and the fallback sentence carry no markup, and
        // a stray `_` in a future line must not make Telegram reject the whole
        // message. `replyMarkup` is OMITTED, not sent as null, when there is
        // no Mini App configured.
        keyboard ? { parseMode: null, replyMarkup: keyboard } : { parseMode: null }
      );
      return true;
    } catch (err) {
      say("SEND", err.toString(), { chat_id: chatId });
      return false;
    }
  };

  /**
   * DOES THIS UPDATE BELONG TO US?
   *
   * PURE AND SYNCHRONOUS - the dispatcher evaluates it before any handler
   * runs, so ownership survives this handler throwing or timing out. It is a
   * regex over the message text and a chat-type check; it reads no database
   * and awaits nothing.
   */
  const claims = (update) => isPlainStart(update && update.message);

  /**
   * One plain `/start`. MUST NEVER THROW: it runs inside the single poll loop,
   * beside password-reset linking and employee linking.
   */
  const handle = async (update) => {
    try {
      const message = update && update.message;
      if (!isPlainStart(message)) return null;

      const chatId = message.chat.id;
      // THE IDENTITY IS THE TELEGRAM USER ID THE BOT OBSERVED. Not the text,
      // not a username, not a display name.
      const telegramUserId = message.from && message.from.id;
      if (!telegramUserId) return null;

      // The repository query carries `disconnected_at IS NULL`, so a retired
      // identity is not a row that then gets filtered here - it is not a row.
      let identity = null;
      try {
        identity = await identityRepo.getActiveIdentityByTelegramUser(telegramUserId);
      } catch (err) {
        say("IDENTITY-LOOKUP", err.toString(), { telegram_user_id: telegramUserId });
        // FAIL CLOSED AND SAY NOTHING ABOUT EMPLOYMENT. A database blip must
        // not turn into "you are not an employee", which reads as an
        // accusation; it must certainly not turn into a menu for somebody
        // unverified. The employee taps /start again.
        return { outcome: "LOOKUP_FAILED" };
      }

      if (!identity || !identity.employee_id) {
        await send(chatId, UNLINKED_MESSAGE, null);
        say("UNLINKED", "plain /start from a Telegram account with no active identity", {
          telegram_user_id: telegramUserId,
        }, (log && log.LEVEL && log.LEVEL.INFO) || "info");
        return { outcome: "UNLINKED" };
      }

      const keyboard = buildMenuKeyboard(
        typeof getMiniAppUrl === "function" ? getMiniAppUrl() : null
      );
      await send(chatId, MENU.TITLE, keyboard);
      say("MENU", "employee menu shown", {
        telegram_user_id: telegramUserId,
        employee_id: Number(identity.employee_id),
        with_buttons: keyboard !== null,
      }, (log && log.LEVEL && log.LEVEL.INFO) || "info");
      return { outcome: "MENU", employee_id: Number(identity.employee_id) };
    } catch (err) {
      // The message text is never logged.
      say("HANDLE", err.toString(), {});
      return null;
    }
  };

  return { MENU, UNLINKED_MESSAGE, PLAIN_START_RE, isPlainStart, buildMenuKeyboard, claims, handle };
};

module.exports.MENU = MENU;
module.exports.UNLINKED_MESSAGE = UNLINKED_MESSAGE;
module.exports.PLAIN_START_RE = PLAIN_START_RE;
module.exports.isPlainStart = isPlainStart;
module.exports.buildMenuKeyboard = buildMenuKeyboard;
