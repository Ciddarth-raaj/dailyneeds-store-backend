require("dotenv").config();

const { TelegramClient } = require("messaging-api-telegram");
const logger = require("../utils/logger");
const { TEST_TELEGRAM_CHAT_ID } = require("../constants/telegram");

// Stage 0A: the bot token comes from the environment only. The value that
// used to be committed here is treated as compromised and has been removed;
// it must be revoked via BotFather. Without TELEGRAM_BOT_TOKEN the service
// degrades - every call rejects with a clear error and is logged - rather
// than the process failing to start, so a missing variable is visible but
// not an outage. The token itself is never logged.
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || null;
if (!BOT_TOKEN) {
  logger.Log({
    level: logger.LEVEL.ERROR,
    component: "SERVICE.TELEGRAM",
    code: "SERVICE.TELEGRAM.TOKEN-MISSING",
    description:
      "TELEGRAM_BOT_TOKEN is not set; Telegram notifications, break-glass alerts, Telegram linking and Telegram password resets are DISABLED.",
    category: "",
    ref: {},
  });
}

/**
 * Optional override for the bot's @name. Normally unset — the bot is asked
 * for its own name instead, so there is nothing to configure or keep in step
 * with the token.
 */
const BOT_USERNAME_OVERRIDE = (process.env.TELEGRAM_BOT_USERNAME || "").replace(/^@/, "");

const client = BOT_TOKEN ? new TelegramClient({ accessToken: BOT_TOKEN }) : null;

/**
 * The update types the bot asks Telegram for. NOTHING ELSE IS DELIVERED.
 *
 * Telegram DROPS an update type that is not named here rather than queueing
 * it, so this list is not a filter over a stream we are already paying for -
 * it is the stream. Adding a type turns traffic on; removing one turns it off
 * with no backlog left behind.
 *
 *   message            `/start <token>` linking, `/setup` group detection, and
 *                      a shared contact (which arrives as `message.contact`).
 *   chat_join_request  the approved employee join flow: the bot creates an
 *                      invite link with `creates_join_request`, the employee
 *                      taps it, and this is how we hear about it. It produces
 *                      NO traffic at all until such a link exists, so it costs
 *                      nothing to have ready.
 *
 * `chat_member` IS DELIBERATELY ABSENT. It fires for every member joining or
 * leaving EVERY group the bot is in, including groups that have nothing to do
 * with employee management. It belongs to the membership work that consumes
 * it, not here - `usecase/telegram_update_dispatcher.js` can already route it
 * the day it is switched on.
 */
/*
 * `callback_query` IS ON, and it is on for exactly one feature: the first
 * approver's Approve / Reject buttons on a one-day shift change request
 * (`usecase/attendance_shift_change_telegram.js`). Unlike `chat_member` below
 * it produces no ambient traffic at all - a callback query exists only when
 * somebody taps a button this backend itself put on a message - so turning it
 * on costs nothing until a button is tapped.
 */
const ALLOWED_UPDATES = ["message", "chat_join_request", "callback_query"];

const NOT_CONFIGURED = "Telegram is not configured (TELEGRAM_BOT_TOKEN missing)";
const requireClient = () => {
  if (!client) throw new Error(NOT_CONFIGURED);
  return client;
};

class Telegram {
  constructor() {
    /** Cached result of getMe().username — see getBotUsername. */
    this.botUsername = null;
  }

  /** True when a token is configured. Callers that poll should no-op otherwise. */
  isConfigured() {
    return Boolean(client);
  }

  /**
   * Send a text message.
   *
   * `options.parseMode` defaults to "Markdown" (every existing caller relies
   * on that). Pass `parseMode: null` to send PLAIN TEXT with no parse mode at
   * all — required for any message that interpolates user-controlled or
   * database text (usernames, IPs, ...), because Telegram's legacy Markdown
   * rejects the whole message when such text contains an unbalanced `_`, `*`
   * or backtick ("Bad Request: can't parse entities: Can't find end of the
   * entity ..."). Security alerts use the plain path: see usecase/user.js.
   */
  async sendMessage(chat_id_param, msg, options = {}) {
    let chat_id = chat_id_param;

    if (process.env.IS_TEST === "true") {
      chat_id = TEST_TELEGRAM_CHAT_ID;
    }

    const { parseMode = "Markdown", ...rest } = options || {};
    const params = {
      disableWebPagePreview: true,
      disableNotification: true,
      ...rest,
    };
    if (parseMode) params.parseMode = parseMode;

    return new Promise(async (resolve, reject) => {
      try {
        await requireClient().sendMessage(chat_id, msg, params);
        resolve({ code: 200 });
      } catch (err) {
        // `msg` is deliberately NOT logged: it may carry a reset code or an
        // alert body. Only the chat and the error are recorded.
        logger.Log({
          level: logger.LEVEL.ERROR,
          component: "SERVICE.TELEGRAM",
          code: "SERVICE.TELEGRAM.SEND-MESSAGE",
          description: err.toString(),
          category: "",
          ref: { chat_id },
        });
        reject(err);
      }
    });
  }

  /**
   * The bot's @name, needed to build `t.me/<name>?start=...` deep links.
   *
   * Asked of Telegram rather than configured: the token already identifies
   * exactly one bot, so a separate setting would only be another thing to
   * get wrong. The answer cannot change without the token changing, so it is
   * cached for the life of the process; a failed lookup is not cached, so a
   * blip does not disable linking until the next restart.
   *
   * Returns "" if the bot cannot be reached or no token is configured, which
   * is the caller's signal to say linking is unavailable rather than hand out
   * a broken link.
   */
  async getBotUsername() {
    if (BOT_USERNAME_OVERRIDE) return BOT_USERNAME_OVERRIDE;
    if (this.botUsername) return this.botUsername;
    if (!client) return "";

    try {
      const me = await client.getMe();
      this.botUsername = me?.username || "";
      return this.botUsername;
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "SERVICE.TELEGRAM",
        code: "SERVICE.TELEGRAM.GET-ME",
        description: err.toString(),
        category: "",
        ref: {},
      });
      return "";
    }
  }

  /**
   * Messages sent *to* the bot since `offset`.
   *
   * Passing an offset also acknowledges everything before it, so Telegram
   * stops resending those; that is what keeps a restart from replaying old
   * updates forever. Long polling is deliberately not used — this runs on a
   * cron tick, so it must return promptly rather than hold the connection.
   */
  async getUpdates(offset) {
    const options = { timeout: 0, allowedUpdates: ALLOWED_UPDATES };
    if (offset !== undefined && offset !== null) options.offset = offset;
    return requireClient().getUpdates(options);
  }

  /**
   * Acknowledge a tapped inline button.
   *
   * Telegram shows a spinner on the button until this is called and gives up
   * after a few seconds, so it is called on EVERY path - including the ones
   * that refuse - and the text is what the approver sees as a toast.
   */
  async answerCallbackQuery(callbackQueryId, text = null) {
    const options = {};
    if (text) options.text = String(text).slice(0, 200);
    return requireClient().answerCallbackQuery(callbackQueryId, options);
  }

  /**
   * Replace a message's buttons - in practice, take them away.
   *
   * A decided request must not go on offering Approve and Reject: the second
   * tap is already refused by the database, but a button that is still there
   * invites it.
   */
  async editMessageReplyMarkup(chatId, messageId, replyMarkup) {
    return requireClient().editMessageReplyMarkup(replyMarkup, {
      chatId,
      messageId,
    });
  }

  /* ------------------------------------ Phase 3B: group membership ------ */

  /**
   * The Bot API methods this package does not implement.
   *
   * `messaging-api-telegram@1.1.0` predates Bot API 5.4, so it has no
   * `createChatInviteLink`, `approveChatJoinRequest` or
   * `declineChatJoinRequest` - it does have `getChat` and `getChatMember`,
   * which are used through the client above as normal.
   *
   * THE RAW CALL LIVES HERE AND NOWHERE ELSE. The client already holds an
   * axios instance bound to `https://api.telegram.org/bot<token>/`, so this
   * reuses the same credential, the same base URL and the same timeout
   * rather than assembling a second HTTP path around a token read from the
   * environment. A usecase that built its own request would be a second
   * place the bot token is handled, and the first place somebody logs it.
   *
   * UPGRADING THE PACKAGE IS THE REAL FIX. When a version that implements
   * these ships, delete this and call the client - the four methods below
   * are the only callers and their signatures are already the package's.
   *
   * IT SNAKE_CASES ITS OWN PARAMETERS and camelCases nothing on the way
   * back: the caller reads Telegram's own field names, so a reader checking
   * this against the Bot API documentation is comparing like with like.
   */
  async _callBotApi(method, params = {}) {
    const client = requireClient();
    const { data } = await client.axios.post(`/${method}`, params);
    if (!data || data.ok !== true) {
      // `description` is Telegram's own sentence ("CHAT_ADMIN_REQUIRED",
      // "USER_ALREADY_PARTICIPANT"). It names no token and no user.
      const err = new Error(
        `Telegram ${method} failed: ${(data && data.description) || "unknown error"}`
      );
      err.telegramMethod = method;
      err.telegramDescription = (data && data.description) || null;
      throw err;
    }
    return data.result;
  }

  /**
   * THE BOT'S OWN ACCOUNT. Needed to ask Telegram about the bot's standing in
   * a group, which is what group readiness turns on.
   *
   * THIS WAS MISSING, AND ITS ABSENCE WAS INVISIBLE. `getBotUsername` called
   * the underlying client's `getMe` from inside the service and never
   * exposed one, so `readiness.getMe()` was `undefined` on the real object -
   * a TypeError, swallowed by the readiness catch, reported as
   * TELEGRAM_UNAVAILABLE. Every group would have read "Telegram is
   * temporarily unavailable" forever: no link could be issued and nobody
   * could become Telegram Complete, and it would have looked like an outage
   * rather than a bug. The unit tests missed it because their double defined
   * `getMe` itself - which is exactly what
   * `services/telegram_contract.test.js` now exists to stop.
   *
   * It returns Telegram's own record rather than a cached username, because
   * the caller wants the id.
   */
  async getMe() {
    return requireClient().getMe();
  }

  /** The chat itself - `type` is what says Supergroup rather than Basic Group. */
  async getChat(chatId) {
    return requireClient().getChat(String(chatId));
  }

  /**
   * One member's standing in a chat.
   *
   * Used for two different questions: is the BOT an admin here with the
   * right to manage join requests, and is the EMPLOYEE already in the group.
   * Both are answered by the same call, so both are answered by Telegram
   * rather than by anything we stored earlier and hoped was still true.
   */
  async getChatMember(chatId, userId) {
    return requireClient().getChatMember(String(chatId), Number(userId));
  }

  /**
   * A single-use-shaped invite link that CREATES A JOIN REQUEST rather than
   * admitting anybody.
   *
   * `creates_join_request` is the whole security model: the link does not
   * let its holder in, it lets them ASK, and the bot then decides. A link
   * that admitted people directly would make forwarding it equivalent to
   * handing out group membership - which is exactly what the approval checks
   * in `usecase/employee_telegram_join_request.js` exist to prevent.
   *
   * `member_limit` IS DELIBERATELY NOT SET, because Telegram rejects it
   * together with `creates_join_request`. The limit of one is enforced by us
   * at approval time - against the employee's verified Telegram identity,
   * which is a stronger rule than "the first person through the door".
   */
  async createChatInviteLink(chatId, { expireDate, name } = {}) {
    const params = { chat_id: String(chatId), creates_join_request: true };
    if (expireDate) params.expire_date = Math.floor(expireDate / 1000);
    if (name) params.name = String(name).slice(0, 32);
    return this._callBotApi("createChatInviteLink", params);
  }

  /** Let this user in. IRREVERSIBLE in the sense that matters: they are now in. */
  async approveChatJoinRequest(chatId, userId) {
    return this._callBotApi("approveChatJoinRequest", {
      chat_id: String(chatId),
      user_id: Number(userId),
    });
  }

  /**
   * Refuse a join request.
   *
   * NOT called on a failed check. A request we cannot match is left pending
   * so a human can look at it: declining would be an action taken against a
   * real person on the strength of a rule that might simply be
   * misconfigured, and Phase 3B does not act against anybody.
   */
  async declineChatJoinRequest(chatId, userId) {
    return this._callBotApi("declineChatJoinRequest", {
      chat_id: String(chatId),
      user_id: Number(userId),
    });
  }

  /**
   * REMOVE SOMEBODY FROM A GROUP - Phase 3C, and the only removal primitive.
   *
   * `banChatMember` is Telegram's ONLY way for a bot to remove a member;
   * there is no "kick". On its own it also BANS them, which is not what an
   * employee leaving a branch deserves - they may be back next month, or be
   * granted the group again by hand. So the ban is undone immediately with
   * `only_if_banned`, which leaves the person removed and free to rejoin.
   *
   * The two calls are separate methods rather than one, because the second
   * failing is a different fact from the first failing: the person is out
   * either way, and only the "may they come back" part is in doubt.
   */
  async banChatMember(chatId, userId) {
    return this._callBotApi("banChatMember", {
      chat_id: String(chatId),
      user_id: Number(userId),
    });
  }

  /**
   * Lift the ban `banChatMember` left behind, and ONLY if there is one.
   * `only_if_banned: true` makes this safe to call against somebody who was
   * never banned - it does nothing rather than quietly un-restricting them.
   */
  async unbanChatMember(chatId, userId) {
    return this._callBotApi("unbanChatMember", {
      chat_id: String(chatId),
      user_id: Number(userId),
      only_if_banned: true,
    });
  }

  async sendDocument(chat_id, fileUrl, caption = "") {
    return new Promise(async (resolve, reject) => {
      try {
        await requireClient().sendDocument(chat_id, fileUrl, {
          caption,
          disableNotification: false,
        });
        resolve({ code: 200 });
      } catch (err) {
        logger.Log({
          level: logger.LEVEL.ERROR,
          component: "SERVICE.TELEGRAM",
          code: "SERVICE.TELEGRAM.SEND-DOCUMENT",
          description: err.toString(),
          category: "",
          ref: { chat_id, fileUrl },
        });
        reject(err);
      }
    });
  }

  async sendImages(chat_id, images, caption = "") {
    return new Promise(async (resolve, reject) => {
      try {
        await requireClient().sendMediaGroup(chat_id, images, {
          caption,
          disableNotification: false,
        });
        resolve({ code: 200 });
      } catch (err) {
        logger.Log({
          level: logger.LEVEL.ERROR,
          component: "SERVICE.TELEGRAM",
          code: "SERVICE.TELEGRAM.SEND-IMAGES",
          description: err.toString(),
          category: "",
          ref: { chat_id },
        });
        reject(err);
      }
    });
  }
}

module.exports = () => {
  return new Telegram();
};
module.exports.NOT_CONFIGURED = NOT_CONFIGURED;
module.exports.ALLOWED_UPDATES = ALLOWED_UPDATES;
