require("dotenv").config();

const { TelegramClient } = require("messaging-api-telegram");
const logger = require("../utils/logger");
const { TEST_TELEGRAM_CHAT_ID } = require("../constants/telegram");

const BOT_TOKEN = "8069311027:AAE64F15h8FZY_jqnlOSzQGmzeKAR-MDYbI";
const client = new TelegramClient({
  accessToken: BOT_TOKEN,
});

class Telegram {
  constructor() {}

  async sendMessage(chat_id_param, msg, options = {}) {
    let chat_id = chat_id_param;

    console.log("ENV VAL", process.env.IS_TEST);

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
