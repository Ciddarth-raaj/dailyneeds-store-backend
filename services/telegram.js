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
    const options = { timeout: 0, allowedUpdates: ["message"] };
    if (offset !== undefined && offset !== null) options.offset = offset;
    return requireClient().getUpdates(options);
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
