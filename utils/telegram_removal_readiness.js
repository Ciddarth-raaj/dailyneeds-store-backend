/**
 * CAN WE REMOVE SOMEBODY FROM THIS GROUP? Phase 3C, and deliberately a
 * SEPARATE question from Phase 3B's `groupReadiness()`.
 *
 * They are not the same question and must not share an answer:
 *
 *   JOIN readiness    needs `can_invite_users`, and an INACTIVE registry row
 *                     is a correct reason to refuse - a retired group should
 *                     take no new members.
 *   REMOVAL readiness needs `can_restrict_members`, and `is_active` is
 *                     DELIBERATELY NOT CONSULTED - retiring a group must
 *                     never strand the people already inside it. The moment
 *                     cleanup is most needed is the moment the group is
 *                     being wound down.
 *
 * Merging the two would mean either asking for a right joins do not need, or
 * refusing to clean up a group somebody just switched off. So Phase 3B's
 * function is untouched and this one stands beside it.
 *
 * PURE. Give it what Telegram said; it decides nothing about what to do next.
 */
// `CHAT_TYPE` is Phase 3B's, imported rather than re-declared so the two
// functions can never disagree about what a supergroup is. Phase 3B's file is
// not modified by this phase.
const { CHAT_TYPE } = require("./telegram_membership");
const { TELEGRAM_MEMBER_STATUS } = require("../constants/telegram_membership");

const REMOVAL_READINESS = {
  READY: "READY",
  /** We could not ask. NOT a configuration fault - never reported as one. */
  TELEGRAM_UNAVAILABLE: "TELEGRAM_UNAVAILABLE",
  /** Basic Groups have no reliable member administration. */
  NOT_SUPERGROUP: "NOT_SUPERGROUP",
  BOT_NOT_MEMBER: "BOT_NOT_MEMBER",
  BOT_NOT_ADMIN: "BOT_NOT_ADMIN",
  /** Admin, but without `can_restrict_members` - the right a kick needs. */
  BOT_CANNOT_RESTRICT: "BOT_CANNOT_RESTRICT",
  /**
   * We were not ALLOWED to ask this tick - the per-tick Telegram budget is
   * spent. Deliberately distinct from TELEGRAM_UNAVAILABLE: nothing is
   * wrong, nothing should be retried with backoff, and the work simply
   * resumes on the next tick. `removalReadiness()` never returns this - the
   * caller does, before it asks - and it is listed here so the two cannot be
   * confused by anybody reading the vocabulary.
   */
  CAPPED: "CAPPED",
};

/** Human sentences, so no screen invents its own. */
const REMOVAL_READINESS_REASON = {
  READY: null,
  TELEGRAM_UNAVAILABLE: "Telegram is temporarily unavailable",
  NOT_SUPERGROUP: "Basic Group is not supported for managed membership",
  BOT_NOT_MEMBER: "Diya is not in this group",
  BOT_NOT_ADMIN: "Diya is not an admin",
  BOT_CANNOT_RESTRICT: "Diya needs permission to remove members",
  CAPPED: "Paused for this run",
};

/**
 * @param {{chat: object|null, botMember: object|null}} telegram - exactly what
 *   `getChat` and `getChatMember(bot)` returned, or null where the call failed.
 */
function removalReadiness(telegram = {}) {
  const chat = telegram.chat;
  if (!chat) {
    return {
      status: REMOVAL_READINESS.TELEGRAM_UNAVAILABLE,
      reason: REMOVAL_READINESS_REASON.TELEGRAM_UNAVAILABLE,
    };
  }
  if (chat.type !== CHAT_TYPE.SUPERGROUP) {
    return {
      status: REMOVAL_READINESS.NOT_SUPERGROUP,
      reason: REMOVAL_READINESS_REASON.NOT_SUPERGROUP,
    };
  }

  const member = telegram.botMember;
  if (!member || !member.status) {
    return {
      status: REMOVAL_READINESS.TELEGRAM_UNAVAILABLE,
      reason: REMOVAL_READINESS_REASON.TELEGRAM_UNAVAILABLE,
    };
  }
  if (
    member.status === TELEGRAM_MEMBER_STATUS.LEFT ||
    member.status === TELEGRAM_MEMBER_STATUS.KICKED
  ) {
    return {
      status: REMOVAL_READINESS.BOT_NOT_MEMBER,
      reason: REMOVAL_READINESS_REASON.BOT_NOT_MEMBER,
    };
  }
  if (member.status === TELEGRAM_MEMBER_STATUS.CREATOR) {
    // THE CREATOR HOLDS EVERY RIGHT IMPLICITLY and Telegram may omit the
    // flags entirely. Reading `can_restrict_members` here would refuse the
    // one account that certainly can.
    return { status: REMOVAL_READINESS.READY, reason: REMOVAL_READINESS_REASON.READY };
  }
  if (member.status !== TELEGRAM_MEMBER_STATUS.ADMINISTRATOR) {
    return {
      status: REMOVAL_READINESS.BOT_NOT_ADMIN,
      reason: REMOVAL_READINESS_REASON.BOT_NOT_ADMIN,
    };
  }

  // camelCase and snake_case both, because the client camelCases responses
  // and `_callBotApi` does not.
  const canRestrict =
    member.canRestrictMembers === true || member.can_restrict_members === true;
  if (!canRestrict) {
    return {
      status: REMOVAL_READINESS.BOT_CANNOT_RESTRICT,
      reason: REMOVAL_READINESS_REASON.BOT_CANNOT_RESTRICT,
    };
  }

  return { status: REMOVAL_READINESS.READY, reason: REMOVAL_READINESS_REASON.READY };
}

const canRemove = (readiness) =>
  Boolean(readiness) && readiness.status === REMOVAL_READINESS.READY;

module.exports = {
  REMOVAL_READINESS,
  REMOVAL_READINESS_REASON,
  removalReadiness,
  canRemove,
};
