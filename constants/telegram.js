require("dotenv").config();

const ALERTS_TELEGRAM_CHAT_ID =
  process.env.IS_TEST === "true" ? 0 : -1002381170220;

module.exports = {
  ALERTS_TELEGRAM_CHAT_ID,
};
