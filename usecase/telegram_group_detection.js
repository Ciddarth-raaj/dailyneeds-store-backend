const logger = require("../utils/logger");
const {
  isValidGroupChatId,
  deriveGroupType,
} = require("../constants/telegram_group_registry");

/**
 * Telegram group DETECTION - the `/setup` half of registering a group.
 *
 * WHY THIS IS NOT A POLLER. `usecase/passwordReset.js#pollTelegramUpdates` is
 * the ONLY thing in this codebase that calls `telegram.getUpdates`, and it
 * advances the update offset past EVERY update it reads, acted on or not.
 * Telegram treats that offset as an acknowledgement, so an update that poller
 * consumes is an update nobody else can ever see: a second poller would not
 * "also receive" `/setup`, it would race the first one and each would eat
 * messages the other needed. Password-reset linking would start failing
 * intermittently and the cause would be invisible.
 *
 * So there is still exactly one owner of the offset, and this class is a
 * HANDLER it calls. It never touches Telegram's cursor and never fetches
 * anything.
 *
 * WHY THE STORE IS IN MEMORY, AND NOT A TABLE. A detection is a few seconds
 * of scaffolding between somebody typing `/setup` and the same person
 * clicking Detect Group; it is not a record of anything. The API and the
 * cron run in ONE process (pm2 fork mode - `ecosystem.config.js` declares no
 * `instances` and no cluster `exec_mode`), so the handler writes and the
 * route reads the same map. Losing detections on restart is correct: the
 * remedy is to send `/setup` again, which takes a second, whereas a table
 * would be a migration, a cleanup job and a place for stale group names to
 * rot. If this ever runs in cluster mode this must become shared storage -
 * see `telegram-group-detection.md`.
 *
 * WHAT IT KEEPS, AND NOTHING MORE. The chat id, the chat title and when it
 * was seen. NOT the message text, NOT the sender, NOT any member list. A
 * `/setup` in a group is the only thing that reaches it, and the only reason
 * to remember it is to offer the group on the Add form a moment later.
 */

/** How long a detection is offered before it is forgotten. */
const DETECTION_TTL_MS = 30 * 60 * 1000;

/**
 * A cap so a flood of `/setup` in many groups cannot grow the map without
 * bound. The oldest go first; anybody whose detection was dropped sends
 * `/setup` again.
 */
const MAX_DETECTIONS = 50;

/** Chat types that can be registered. A private chat is a person, not a group. */
const GROUP_CHAT_TYPES = ["group", "supergroup"];

const SETUP_COMMAND = "/setup";

/**
 * Is this message the setup command addressed to us?
 *
 * Telegram delivers `/setup` in a group as either the bare command or
 * `/setup@thebot` when several bots are present. `@someoneelse` is somebody
 * else's bot being set up and is not ours to answer.
 */
function isSetupCommand(text, botUsername) {
  const trimmed = String(text === undefined || text === null ? "" : text).trim();
  if (trimmed.toLowerCase() === SETUP_COMMAND) return true;
  const match = /^\/setup@([A-Za-z0-9_]+)$/i.exec(trimmed);
  if (!match) return false;
  if (!botUsername) return false; // cannot prove it was addressed to us
  return match[1].toLowerCase() === String(botUsername).toLowerCase();
}

class TelegramGroupDetectionUsecase {
  /**
   * @param {object} deps
   * @param {object} deps.telegram            services/telegram (getBotUsername only)
   * @param {object} deps.registryRepo        to hide groups that are already registered
   * @param {function} [deps.now]
   */
  constructor({ telegram, registryRepo, now } = {}) {
    this.telegram = telegram || null;
    this.registryRepo = registryRepo || null;
    this.now = now || (() => new Date());
    /** chat_id -> { chat_id, group_name, chat_type, detected_at } */
    this.detections = new Map();
  }

  _log(code, err, ref = {}) {
    logger.Log({
      level: logger.LEVEL.ERROR,
      component: "USECASE.TELEGRAM_GROUP_DETECTION",
      code: `USECASE.TELEGRAM_GROUP_DETECTION.${code}`,
      description: err.toString(),
      category: "",
      ref,
    });
  }

  /** Drop anything past its TTL. Called on every read and every write. */
  _prune() {
    const cutoff = this.now().getTime() - DETECTION_TTL_MS;
    for (const [chatId, detection] of this.detections) {
      if (new Date(detection.detected_at).getTime() < cutoff) {
        this.detections.delete(chatId);
      }
    }
    // Oldest out first if the cap is exceeded. Map preserves insertion order
    // and a re-detection deletes before it sets, so the order is by recency.
    while (this.detections.size > MAX_DETECTIONS) {
      const oldest = this.detections.keys().next().value;
      this.detections.delete(oldest);
    }
  }

  /**
   * One Telegram message, straight from the single poller.
   *
   * MUST NEVER THROW: it runs inside the password-reset poll loop, and a
   * failure here must not stop somebody linking their account. Returns the
   * detection when one was recorded, otherwise null, which is what the tests
   * assert on rather than reaching into the map.
   */
  async handleMessage(message) {
    try {
      const chat = message && message.chat;
      if (!chat) return null;

      // A private chat is one person, a channel is a broadcast; neither is a
      // group this registry can hold.
      if (!GROUP_CHAT_TYPES.includes(chat.type)) return null;

      const chatId = chat.id === undefined || chat.id === null ? "" : String(chat.id);
      // The registry's own rule, not a second copy of it: negative, digits
      // only. A positive id is a user, and a malformed one is not a chat.
      if (!isValidGroupChatId(chatId)) return null;

      let botUsername = "";
      if (this.telegram && typeof this.telegram.getBotUsername === "function") {
        try {
          botUsername = await this.telegram.getBotUsername();
        } catch (err) {
          botUsername = "";
        }
      }
      if (!isSetupCommand(message.text, botUsername)) return null;

      const detection = {
        chat_id: chatId,
        // Telegram always sends a title for a group; fall back rather than
        // storing an empty name the user then has to guess at.
        group_name: (chat.title && String(chat.title).trim()) || "Untitled Telegram group",
        chat_type: chat.type,
        detected_at: this.now().toISOString(),
      };

      // Re-detection REPLACES rather than adds: one `/setup` per group, and
      // a renamed group should offer its new title.
      this.detections.delete(chatId);
      this.detections.set(chatId, detection);
      this._prune();

      // The chat id is operational data and is logged elsewhere in this
      // codebase; the message text and the sender are not logged at all.
      return detection;
    } catch (err) {
      this._log("HANDLE_MESSAGE", err);
      return null;
    }
  }

  /**
   * Pending detections, newest first, MINUS anything already registered.
   *
   * Filtering here rather than in the UI is what stops somebody selecting a
   * group that would then be refused as a duplicate on save - the rejection
   * would be correct and completely baffling.
   */
  async list() {
    this._prune();
    const pending = [...this.detections.values()].sort((a, b) =>
      a.detected_at < b.detected_at ? 1 : -1
    );

    const out = [];
    for (const detection of pending) {
      if (this.registryRepo) {
        try {
          const existing = await this.registryRepo.getByChatId(detection.chat_id);
          if (existing) continue;
        } catch (err) {
          this._log("LIST_REGISTERED_CHECK", err, { chat_id: detection.chat_id });
          // Fail closed: if we cannot tell whether it is registered, do not
          // offer it. Saving it would be refused anyway.
          continue;
        }
      }
      out.push({
        ...detection,
        group_type: deriveGroupType(detection.chat_id),
      });
    }
    return out;
  }

  /** Forget one detection - after it has been registered, say. */
  forget(chatId) {
    return this.detections.delete(String(chatId));
  }
}

module.exports = (deps) => new TelegramGroupDetectionUsecase(deps);
module.exports.TelegramGroupDetectionUsecase = TelegramGroupDetectionUsecase;
module.exports.isSetupCommand = isSetupCommand;
module.exports.DETECTION_TTL_MS = DETECTION_TTL_MS;
module.exports.MAX_DETECTIONS = MAX_DETECTIONS;
module.exports.GROUP_CHAT_TYPES = GROUP_CHAT_TYPES;
