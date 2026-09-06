require("dotenv").config();

const { TelegramClient } = require("messaging-api-telegram");
const logger = require("../utils/logger");
const { TEST_TELEGRAM_CHAT_ID } = require("../constants/telegram");

// The token has always lived in this file. It is read from the environment
// first so a deployment can rotate it without a code change; the literal
// stays as the fallback so existing installs keep working.
const BOT_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN ||
  "8069311027:AAE64F15h8FZY_jqnlOSzQGmzeKAR-MDYbI";

/**
 * The bot's @name, needed to build `t.me/<name>?start=...` deep links.
 *
 * There is no default: a wrong guess would send users to someone else's bot,
 * which is worse than the link feature reporting that it is not configured.
 */
const BOT_USERNAME = (process.env.TELEGRAM_BOT_USERNAME || "").replace(/^@/, "");

const client = new TelegramClient({
  accessToken: BOT_TOKEN,
});

class Telegram {
  constructor() { }

  async sendMessage(chat_id_param, msg, options = {}) {
    let chat_id = chat_id_param;

    if (process.env.IS_TEST === "true") {
      chat_id = TEST_TELEGRAM_CHAT_ID;
    }

    //test-chat-id = 800863889
    return new Promise(async (resolve, reject) => {
      try {
        await client.sendMessage(chat_id, msg, {
          disableWebPagePreview: true,
          disableNotification: true,
          ...options,
          parseMode: "Markdown",
        });
        resolve({ code: 200 });
      } catch (err) {
        logger.Log({
          level: logger.LEVEL.ERROR,
          component: "SERVICE.TELEGRAM",
          code: "SERVICE.TELEGRAM.SEND-MESSAGE",
          description: err.toString(),
          category: "",
          ref: { chat_id, msg },
        });
        reject(err);
      }
    });
  }

  /** The bot's @name, or "" when the deployment has not configured one. */
  getBotUsername() {
    return BOT_USERNAME;
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
    return client.getUpdates(options);
  }

  async sendDocument(chat_id, fileUrl, caption = "") {
    return new Promise(async (resolve, reject) => {
      try {
        await client.sendDocument(chat_id, fileUrl, {
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
          ref: { chat_id, fileUrl, caption },
        });
        reject(err);
      }
    });
  }

  async sendImages(chat_id, images, caption = "") {
    return new Promise(async (resolve, reject) => {
      try {
        await client.sendMediaGroup(chat_id, images, {
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
          ref: { chat_id, images, caption },
        });
        reject(err);
      }
    });
  }
}

module.exports = () => {
  return new Telegram();
};
