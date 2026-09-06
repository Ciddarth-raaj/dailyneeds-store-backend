require("dotenv").config();

const { TelegramClient } = require("messaging-api-telegram");
const logger = require("../utils/logger");
const { TEST_TELEGRAM_CHAT_ID } = require("../constants/telegram");

// Stage 0A: the bot token comes from the environment only. The value that
// used to be committed here is treated as compromised and has been removed;
// it must be revoked via BotFather. Without TELEGRAM_BOT_TOKEN the service
// degrades - every send rejects and is logged - rather than the process
// failing to start, so a missing variable is visible but not an outage.
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || null;
if (!BOT_TOKEN) {
  logger.Log({
    level: logger.LEVEL.ERROR,
    component: "SERVICE.TELEGRAM",
    code: "SERVICE.TELEGRAM.TOKEN-MISSING",
    description: "TELEGRAM_BOT_TOKEN is not set; Telegram notifications (including break-glass alerts) are DISABLED.",
    category: "",
    ref: {},
  });
}
const client = BOT_TOKEN ? new TelegramClient({ accessToken: BOT_TOKEN }) : null;
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
        if (!client) throw new Error("Telegram is not configured (TELEGRAM_BOT_TOKEN missing)");
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

  async sendDocument(chat_id, fileUrl, caption = "") {
    return new Promise(async (resolve, reject) => {
      try {
        if (!client) throw new Error("Telegram is not configured (TELEGRAM_BOT_TOKEN missing)");
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
        if (!client) throw new Error("Telegram is not configured (TELEGRAM_BOT_TOKEN missing)");
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
