/**
 * Read a Telegram update in EITHER SPELLING.
 *
 * `messaging-api-telegram` camelCases everything `getUpdates` hands back,
 * deep: a tap arrives as `update.callbackQuery`, its message as
 * `message.messageId`, a reply as `message.replyToMessage`. The Bot API
 * documents snake_case, and tests are written that way. Handlers read
 * through these so both reach the same code.
 */

const pick = (obj, snake, camel) => {
  if (!obj || typeof obj !== "object") return undefined;
  return obj[snake] !== undefined && obj[snake] !== null ? obj[snake] : obj[camel];
};

const callbackQueryOf = (update) => pick(update, "callback_query", "callbackQuery") || null;
const replyToOf = (message) => pick(message, "reply_to_message", "replyToMessage") || null;
const messageIdOf = (message) => {
  const id = pick(message, "message_id", "messageId");
  return id === undefined ? null : id;
};

module.exports = { callbackQueryOf, replyToOf, messageIdOf };
