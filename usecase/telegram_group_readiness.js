const logger = require("../utils/logger");
const { groupReadiness } = require("../utils/telegram_membership");
const { GROUP_READINESS } = require("../constants/telegram_membership");

/**
 * IS A REGISTERED GROUP MANAGEABLE? Phase 3B.
 *
 * Asks Telegram two questions - what kind of chat is this, and what is the
 * bot's standing in it - and hands both to the pure rule in
 * `utils/telegram_membership.js#groupReadiness`. This file does the
 * fetching and the failure handling; it decides nothing.
 *
 * THE REGISTRY'S `bot_is_admin` IS NEVER CONSULTED. It is a checkbox
 * somebody ticked when registering the group, and the entire point of this
 * usecase is that a group where the bot was later demoted must come back
 * BOT_NOT_ADMIN rather than "ready, because the form said so".
 *
 * TWO CALLS PER GROUP, ON DEMAND. Not for every group on a list page and
 * never for every employee: these are external HTTP calls to a rate-limited
 * API, and a dashboard that checked hundreds of groups on load would be slow
 * on a good day and broken on a bad one. Readiness is fetched for the one
 * group being looked at, or by a deliberate refresh.
 */
class TelegramGroupReadinessUsecase {
  constructor(telegram, deps = {}) {
    this.telegram = telegram;
    this.botUserId = deps.botUserId || null;
  }

  /**
   * The bot's own Telegram user id, needed to ask about its own membership.
   *
   * Cached for the process: it is immutable for a given token, and fetching
   * it per group would triple the call count for a value that cannot change.
   */
  async _botId() {
    if (this.botUserId) return this.botUserId;
    const me = await this.telegram.getMe();
    this.botUserId = me && (me.id || me.userId) ? Number(me.id || me.userId) : null;
    return this.botUserId;
  }

  /**
   * Readiness for one registered group.
   *
   * A TELEGRAM FAILURE IS `TELEGRAM_UNAVAILABLE`, NOT A VERDICT. Nothing is
   * known to be wrong with the group, so it must never be reported as
   * misconfigured - somebody would go and "fix" a group that was fine. It is
   * also never thrown: readiness is one column on a screen that has other
   * things to show.
   */
  async check(group) {
    if (!group) {
      return groupReadiness(null, {});
    }
    // The registry switch is ours and free; a retired group is not worth an
    // API call and Telegram has nothing to say about our own flag.
    if (!group.is_active) {
      return groupReadiness(group, {});
    }
    if (typeof this.telegram.isConfigured === "function" && !this.telegram.isConfigured()) {
      return groupReadiness(group, { unavailable: true });
    }

    try {
      const botId = await this._botId();
      if (!botId) return groupReadiness(group, { unavailable: true });

      const chat = await this.telegram.getChat(group.chat_id);
      // ORDER MATTERS FOR COST, not for the verdict: a Basic Group cannot be
      // managed whatever the bot's standing, so there is no reason to ask
      // about membership first.
      if (!chat || chat.type !== "supergroup") {
        return groupReadiness(group, { chat });
      }
      const botMember = await this.telegram.getChatMember(group.chat_id, botId);
      return groupReadiness(group, { chat, botMember });
    } catch (err) {
      // The chat id is safe to reference internally - it is the registry's
      // own key for the group - but the log says nothing about any person.
      logger.Log({
        level: logger.LEVEL.WARN,
        component: "USECASE.TELEGRAM_GROUP_READINESS",
        code: "USECASE.TELEGRAM_GROUP_READINESS.CHECK",
        description: `readiness check failed: ${err.toString()}`,
        category: "",
        ref: { telegram_group_id: group.telegram_group_id },
      });
      return groupReadiness(group, { unavailable: true });
    }
  }

  /**
   * Readiness for several groups, sequentially and BOUNDED BY THE CALLER.
   *
   * Sequential rather than parallel on purpose: the Bot API is rate limited
   * per bot, and a burst of parallel calls is the shape of request that gets
   * a 429 for everybody - including the password-reset poller sharing this
   * token. An employee has a handful of required groups, so the wall-clock
   * cost is small and predictable.
   */
  async checkMany(groups) {
    const out = new Map();
    for (const group of groups || []) {
      out.set(group.telegram_group_id, await this.check(group));
    }
    return out;
  }
}

module.exports = (telegram, deps) => new TelegramGroupReadinessUsecase(telegram, deps);
module.exports.TelegramGroupReadinessUsecase = TelegramGroupReadinessUsecase;
module.exports.GROUP_READINESS = GROUP_READINESS;
