/**
 * Telegram group membership - the vocabulary. Phase 3B.
 *
 * Three separate vocabularies, deliberately not one:
 *
 *   READINESS   is about the GROUP - can we manage membership here at all
 *   MEMBERSHIP  is about the EMPLOYEE in one group - what the screen shows
 *   ATTEMPT     is about one join in flight - richer, internal, durable
 *
 * They are kept apart because they answer different questions and change for
 * different reasons. A group that stops being ready does not change anybody's
 * membership; an attempt that expires does not change the group.
 */

/**
 * WHETHER A GROUP CAN HAVE MANAGED MEMBERSHIP AT ALL.
 *
 * Every value except READY is a reason, and every reason is actionable by a
 * person: it names the one thing to go and fix. "Not ready" on its own would
 * send somebody to read code.
 */
const GROUP_READINESS = {
  READY: "READY",
  /** The registry row is switched off. Its mappings are kept; nothing acts. */
  INACTIVE_GROUP: "INACTIVE_GROUP",
  /**
   * A Basic Group. Telegram does not offer join requests or reliable member
   * administration there, so it cannot be managed - it remains a perfectly
   * valid registry entry for ordinary alerts.
   */
  BASIC_GROUP_UNSUPPORTED: "BASIC_GROUP_UNSUPPORTED",
  BOT_NOT_MEMBER: "BOT_NOT_MEMBER",
  BOT_NOT_ADMIN: "BOT_NOT_ADMIN",
  /** Admin, but without `can_invite_users` - the right join requests need. */
  BOT_PERMISSION_MISSING: "BOT_PERMISSION_MISSING",
  /**
   * We could not ask. NOT the same as "not ready": nothing is known to be
   * wrong, so this must never be reported as a configuration fault.
   */
  TELEGRAM_UNAVAILABLE: "TELEGRAM_UNAVAILABLE",
};

/** Human sentences. The API sends these so no screen invents its own. */
const READINESS_REASON = {
  READY: null,
  INACTIVE_GROUP: "Group inactive",
  BASIC_GROUP_UNSUPPORTED: "Basic Group is not supported for managed membership",
  BOT_NOT_MEMBER: "Diya is not in this group",
  BOT_NOT_ADMIN: "Diya is not an admin",
  BOT_PERMISSION_MISSING: "Diya needs permission to manage join requests",
  TELEGRAM_UNAVAILABLE: "Telegram is temporarily unavailable",
};

/**
 * WHAT THE SCREEN SHOWS FOR ONE EMPLOYEE IN ONE GROUP. Four words, because
 * four is what somebody can act on. Telegram's own member statuses and our
 * attempt statuses are both richer and neither belongs on a manager's screen.
 */
const MEMBERSHIP_STATUS = {
  JOINED: "JOINED",
  JOIN_PENDING: "JOIN_PENDING",
  ACTION_REQUIRED: "ACTION_REQUIRED",
  GROUP_NOT_READY: "GROUP_NOT_READY",
};

/**
 * THE DASHBOARD'S ANSWER. Four words, and the third exists to stay honest.
 *
 * This is LAST-VERIFIED status, not a live Telegram verdict: the employee
 * dashboard cannot ask Telegram - thousands of calls per page load on a
 * token shared with the three-second poller - so it reads the cache the
 * detail screen fills in.
 *
 * `VERIFICATION_PENDING` IS THE HONEST GAP. It means we have never checked
 * THAT identity in THAT group, which happens the moment a mapping is added
 * or somebody reconnects a different Telegram account. Folding it into
 * PENDING would say "they have not joined" about something nobody has
 * looked at, and folding it into COMPLETE would be worse. It is a
 * distinguishable state so the queue can be worked: PENDING needs the
 * employee to act, VERIFICATION_PENDING needs somebody to open their record.
 */
const TELEGRAM_COMPLETION = {
  NOT_CONNECTED: "NOT_CONNECTED",
  VERIFICATION_PENDING: "VERIFICATION_PENDING",
  PENDING: "PENDING",
  COMPLETE: "COMPLETE",
};

/** What a cached verification recorded. Never "unknown" - see the migration. */
const VERIFIED_MEMBERSHIP = {
  JOINED: "JOINED",
  NOT_JOINED: "NOT_JOINED",
};

/** One join in flight. Durable, and richer than the screen needs. */
const ATTEMPT_STATUS = {
  PENDING: "PENDING",
  JOIN_REQUEST_RECEIVED: "JOIN_REQUEST_RECEIVED",
  APPROVED: "APPROVED",
  JOINED: "JOINED",
  EXPIRED: "EXPIRED",
  SUPERSEDED: "SUPERSEDED",
  FAILED: "FAILED",
};

/** Only PENDING is outstanding; everything else has concluded. */
const LIVE_ATTEMPT_STATUSES = [ATTEMPT_STATUS.PENDING];

/**
 * Telegram's own `ChatMember.status` values, and which of them mean the
 * person is IN the group.
 *
 * `creator` and `administrator` COUNT AS JOINED, which is the case a naive
 * `status === "member"` gets wrong: the person who created the group is in
 * it more than anybody, and asking them to join again is absurd.
 *
 * `restricted` IS CONDITIONAL and the condition is `is_member`. Telegram
 * uses the same status for somebody muted but present and somebody
 * restricted and gone, distinguished only by that flag - so it is read,
 * not assumed.
 *
 * `left` and `kicked` are not members. A kicked employee is NOT re-invited
 * automatically by this phase: somebody removed them deliberately and
 * undoing that silently is not ours to do.
 */
const TELEGRAM_MEMBER_STATUS = {
  CREATOR: "creator",
  ADMINISTRATOR: "administrator",
  MEMBER: "member",
  RESTRICTED: "restricted",
  LEFT: "left",
  KICKED: "kicked",
};

/** Present without qualification. */
const PRESENT_MEMBER_STATUSES = [
  TELEGRAM_MEMBER_STATUS.CREATOR,
  TELEGRAM_MEMBER_STATUS.ADMINISTRATOR,
  TELEGRAM_MEMBER_STATUS.MEMBER,
];

/** How long an issued invite link is good for. */
const JOIN_LINK_TTL_MS = 15 * 60 * 1000;

/**
 * Why a join request was not approved. Recorded, never sent to the person in
 * Telegram: "you are not the employee this link was for" tells a stranger
 * that the link belongs to somebody, which link they hold, and that the
 * company uses this flow. The bot says nothing at all.
 */
const JOIN_REFUSAL = {
  UNREGISTERED_GROUP: "UNREGISTERED_GROUP",
  GROUP_NOT_READY: "GROUP_NOT_READY",
  NO_MATCHING_ATTEMPT: "NO_MATCHING_ATTEMPT",
  ATTEMPT_NOT_LIVE: "ATTEMPT_NOT_LIVE",
  ATTEMPT_EXPIRED: "ATTEMPT_EXPIRED",
  IDENTITY_DISCONNECTED: "IDENTITY_DISCONNECTED",
  IDENTITY_MISMATCH: "IDENTITY_MISMATCH",
  GROUP_NO_LONGER_REQUIRED: "GROUP_NO_LONGER_REQUIRED",
  APPROVAL_FAILED: "APPROVAL_FAILED",
};

const MEMBERSHIP_MESSAGES = {
  NOT_CONNECTED: "This employee has not connected Telegram yet",
  NOT_REQUIRED: "This group is not required for this employee",
  ALREADY_JOINED: "This employee is already in this group",
  GROUP_NOT_FOUND: "Telegram group not found",
  TELEGRAM_UNAVAILABLE: "Telegram is temporarily unavailable. Try again in a moment.",
  LINK_EXPIRED: "That join link has expired. Generate a new one.",
};

module.exports = {
  TELEGRAM_COMPLETION,
  VERIFIED_MEMBERSHIP,
  GROUP_READINESS,
  READINESS_REASON,
  MEMBERSHIP_STATUS,
  ATTEMPT_STATUS,
  LIVE_ATTEMPT_STATUSES,
  TELEGRAM_MEMBER_STATUS,
  PRESENT_MEMBER_STATUSES,
  JOIN_LINK_TTL_MS,
  JOIN_REFUSAL,
  MEMBERSHIP_MESSAGES,
};
