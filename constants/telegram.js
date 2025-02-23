require("dotenv").config();

const ALERTS_TELEGRAM_CHAT_ID =
  process.env.IS_TEST === "true" ? 0 : -1002381170220;

// const PURCHASE_TELEGRAM_CHAT_ID =
//   process.env.IS_TEST === "true" ? 0 : -4668439381;

const PURCHASE_TELEGRAM_CHAT_ID = -4668439381;

module.exports = {
  ALERTS_TELEGRAM_CHAT_ID,
  PURCHASE_TELEGRAM_CHAT_ID,
};
