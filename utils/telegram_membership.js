const {
  TELEGRAM_COMPLETION,
  VERIFIED_MEMBERSHIP,
  GROUP_READINESS,
  READINESS_REASON,
  MEMBERSHIP_STATUS,
  ATTEMPT_STATUS,
  TELEGRAM_MEMBER_STATUS,
  PRESENT_MEMBER_STATUSES,
} = require("../constants/telegram_membership");

/**
 * Telegram group membership - the decisions, as pure functions. Phase 3B.
 *
 * No database, no clock of its own, no Telegram calls. The caller fetches;
 * this decides. That split is what lets the readiness rule and the "is this
 * person in the group" rule be tested against plain objects shaped like
 * Telegram's own responses, rather than against a mock of the whole world.
 *
 * NOTHING HERE ACTS. There is no approve, no invite and no removal in this
 * file - it answers questions, and the two usecases decide what to do with
 * the answers.
 */

/** Telegram's chat types. Only a supergroup can be managed. */
const CHAT_TYPE = { SUPERGROUP: "supergroup", GROUP: "group", CHANNEL: "channel" };

/**
 * IS THIS GROUP MANAGEABLE? The five conditions, in the order a person would
 * check them, so the reason returned is the FIRST thing to go and fix rather
 * than an arbitrary one of several.
 *
 * THE REGISTRY'S `bot_is_admin` IS NOT CONSULTED. It is an operator's
 * declaration typed into a form, and the whole point of this function is to
 * ask Telegram instead. A group where somebody ticked the box and then
 * demoted the bot is exactly the case that must come back BOT_NOT_ADMIN.
 *
 * `telegram` IS THE ANSWERS, NOT THE CLIENT: `{ chat, botMember }`, or
 * `{ unavailable: true }` when the calls failed. Unavailable is NOT a
 * verdict about the group - nothing is known to be wrong with it - so it is
 * its own status and never reported as misconfiguration.
 */
function groupReadiness(group, telegram = {}) {
  if (!group) {
    return { status: GROUP_READINESS.INACTIVE_GROUP, reason: READINESS_REASON.INACTIVE_GROUP };
  }
  // The registry switch first: it is ours, it is free to check, and a group
  // somebody retired should not have Telegram questioned about it at all.
  if (!group.is_active) {
    return { status: GROUP_READINESS.INACTIVE_GROUP, reason: READINESS_REASON.INACTIVE_GROUP };
  }
  if (telegram.unavailable) {
    return {
      status: GROUP_READINESS.TELEGRAM_UNAVAILABLE,
      reason: READINESS_REASON.TELEGRAM_UNAVAILABLE,
    };
  }

  const chat = telegram.chat;
  if (!chat) {
    return {
      status: GROUP_READINESS.TELEGRAM_UNAVAILABLE,
      reason: READINESS_REASON.TELEGRAM_UNAVAILABLE,
    };
  }
  // Telegram's own `type`, not the id-derived guess the registry displays.
  // A Basic Group that has since been converted reads supergroup here, and
  // that conversion is the supported fix.
  if (chat.type !== CHAT_TYPE.SUPERGROUP) {
    return {
      status: GROUP_READINESS.BASIC_GROUP_UNSUPPORTED,
      reason: READINESS_REASON.BASIC_GROUP_UNSUPPORTED,
    };
  }

  const member = telegram.botMember;
  if (!member || !member.status) {
    return {
      status: GROUP_READINESS.TELEGRAM_UNAVAILABLE,
      reason: READINESS_REASON.TELEGRAM_UNAVAILABLE,
    };
  }
  if (
    member.status === TELEGRAM_MEMBER_STATUS.LEFT ||
    member.status === TELEGRAM_MEMBER_STATUS.KICKED
  ) {
    return { status: GROUP_READINESS.BOT_NOT_MEMBER, reason: READINESS_REASON.BOT_NOT_MEMBER };
  }
  if (
    member.status !== TELEGRAM_MEMBER_STATUS.ADMINISTRATOR &&
    member.status !== TELEGRAM_MEMBER_STATUS.CREATOR
  ) {
    return { status: GROUP_READINESS.BOT_NOT_ADMIN, reason: READINESS_REASON.BOT_NOT_ADMIN };
  }

  // THE ONE RIGHT THAT MATTERS. `can_invite_users` is what Telegram requires
  // both to create an invite link and to approve a join request - being an
  // admin with every other box ticked and this one clear fails at the moment
  // it matters, which is after somebody has already tapped the link.
  //
  // The creator has every right implicitly and Telegram may omit the flag.
  const canInvite =
    member.status === TELEGRAM_MEMBER_STATUS.CREATOR ||
    member.canInviteUsers === true ||
    member.can_invite_users === true;
  if (!canInvite) {
    return {
      status: GROUP_READINESS.BOT_PERMISSION_MISSING,
      reason: READINESS_REASON.BOT_PERMISSION_MISSING,
    };
  }

  return { status: GROUP_READINESS.READY, reason: READINESS_REASON.READY };
}

const isReady = (readiness) => Boolean(readiness) && readiness.status === GROUP_READINESS.READY;

/**
 * IS THIS PERSON IN THE GROUP, according to Telegram?
 *
 * `restricted` is the subtle one: Telegram uses it for somebody muted but
 * STILL PRESENT and for somebody restricted and gone, and only `is_member`
 * tells them apart. Treating all `restricted` as absent would send a
 * perfectly present employee a join link they cannot use; treating all of it
 * as present would mark a removed employee complete.
 */
function isTelegramMember(chatMember) {
  if (!chatMember || !chatMember.status) return false;
  if (PRESENT_MEMBER_STATUSES.includes(chatMember.status)) return true;
  if (chatMember.status === TELEGRAM_MEMBER_STATUS.RESTRICTED) {
    return chatMember.isMember === true || chatMember.is_member === true;
  }
  return false;
}

/**
 * WHAT THE SCREEN SHOWS for one employee in one group.
 *
 * Readiness comes FIRST, and deliberately even before a known membership:
 * if we cannot manage the group we cannot honestly report anything about it,
 * and a "Joined" derived from a stale reading would make an employee look
 * complete when nothing can be verified.
 */
function membershipStatus({ readiness, joined, liveAttempt } = {}) {
  if (!isReady(readiness)) return MEMBERSHIP_STATUS.GROUP_NOT_READY;
  if (joined) return MEMBERSHIP_STATUS.JOINED;
  if (liveAttempt) return MEMBERSHIP_STATUS.JOIN_PENDING;
  return MEMBERSHIP_STATUS.ACTION_REQUIRED;
}

/** An attempt is outstanding only while PENDING and not yet past its expiry. */
function attemptIsLive(attempt, now) {
  if (!attempt || attempt.status !== ATTEMPT_STATUS.PENDING) return false;
  const expires = attempt.expires_at ? new Date(attempt.expires_at).getTime() : null;
  if (expires === null || Number.isNaN(expires)) return false;
  return expires > new Date(now).getTime();
}

/**
 * IS THIS EMPLOYEE TELEGRAM COMPLETE?
 *
 * DERIVED, NEVER STORED. Every input moves on its own: an identity can be
 * disconnected, a mapping can be added, an employee can transfer into a new
 * outlet's group. A stored boolean would be wrong from the first of those
 * and nothing would say so.
 *
 * ZERO REQUIRED GROUPS IS COMPLETE, provided the identity is connected -
 * there is nothing left to do, and reporting somebody incomplete for a
 * requirement nobody has placed on them would be a queue item that can never
 * be cleared.
 *
 * A GROUP THAT IS NOT READY MEANS NOT COMPLETE. The employee has done
 * nothing wrong and this is not their fault, but the company's requirement
 * is genuinely unmet, and reporting complete would hide the group that needs
 * fixing behind a green tick.
 */
function telegramComplete({ connected, groups } = {}) {
  if (!connected) return false;
  const list = groups || [];
  if (list.length === 0) return true;
  return list.every((group) => group.membership_status === MEMBERSHIP_STATUS.JOINED);
}

/**
 * THE DASHBOARD'S COMPLETION, from cached verifications alone.
 *
 * Pure, and deliberately separate from `telegramComplete` above: that one
 * answers "is this person complete, according to Telegram, right now" for
 * the detail screen, and this one answers "what should the queue show,
 * according to the last time anybody looked". They must not be the same
 * function, because they are not the same question and the second one is
 * allowed to be out of date.
 *
 * `verifications` IS KEYED BY GROUP AND IS ALREADY SCOPED TO THE EMPLOYEE'S
 * CURRENT IDENTITY ROW by the query that produced it. That is what makes a
 * reconnect invalidate everything automatically: the new identity row has no
 * verifications, so every required group reads VERIFICATION_PENDING until
 * somebody opens the record - which is true, because that Telegram account
 * has never been checked in that group.
 *
 * ORDER OF THE CHECKS MATTERS. Unverified is reported ahead of not-joined,
 * because claiming somebody has not joined a group nobody has looked at is a
 * statement we have no evidence for.
 */
function dashboardCompletion({ connected, requiredGroupIds, verifications } = {}) {
  if (!connected) return TELEGRAM_COMPLETION.NOT_CONNECTED;

  const required = requiredGroupIds || [];
  // Nothing required, and an identity connected: there is nothing left to do
  // and no verification anybody could be waiting for.
  if (required.length === 0) return TELEGRAM_COMPLETION.COMPLETE;

  const byGroup = verifications || new Map();
  let anyUnverified = false;
  let anyNotComplete = false;

  for (const groupId of required) {
    const row = byGroup.get(Number(groupId));
    if (!row) {
      anyUnverified = true;
      continue;
    }
    // A group we last saw as unmanageable is a real, definitive problem -
    // the requirement is unmet - so it is PENDING rather than unverified.
    if (row.readiness_status !== GROUP_READINESS.READY) {
      anyNotComplete = true;
      continue;
    }
    if (row.membership !== VERIFIED_MEMBERSHIP.JOINED) anyNotComplete = true;
  }

  if (anyUnverified) return TELEGRAM_COMPLETION.VERIFICATION_PENDING;
  if (anyNotComplete) return TELEGRAM_COMPLETION.PENDING;
  return TELEGRAM_COMPLETION.COMPLETE;
}

module.exports = {
  CHAT_TYPE,
  dashboardCompletion,
  groupReadiness,
  isReady,
  isTelegramMember,
  membershipStatus,
  attemptIsLive,
  telegramComplete,
};
