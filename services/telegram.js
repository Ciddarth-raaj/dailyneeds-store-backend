const { TelegramClient } = require("messaging-api-telegram");
const logger = require("../utils/logger");

const BOT_TOKEN = "8069311027:AAE64F15h8FZY_jqnlOSzQGmzeKAR-MDYbI";
const client = new TelegramClient({
  accessToken: BOT_TOKEN,
});

class Telegram {
  constructor() {}

  async sendMessage(chat_id, msg, options = {}) {
    //test-chat-id = 800863889
    return new Promise(async (resolve, reject) => {
      try {
        await client.sendMessage(chat_id, msg, {
          disableWebPagePreview: true,
          disableNotification: true,
          ...options,
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
}

module.exports = () => {
  return new Telegram();
};
