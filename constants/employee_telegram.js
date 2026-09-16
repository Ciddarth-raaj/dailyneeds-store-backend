/**
 * EMPLOYEE TELEGRAM IDENTITY - the vocabulary, the lifetimes and the replies.
 *
 * One copy of every rule that means something, so the usecase, the routes and
 * the tests read the same definitions rather than three drifting copies. Same
 * arrangement as `constants/telegram_group_registry.js`.
 */

/**
 * The `/start` payload prefix an employee deep link carries.
 *
 * IT IS PHASE 1'S NAMESPACE, IMPORTED RATHER THAN RETYPED. The dispatcher
 * already reserved it, and a second literal here is exactly how the two would
 * one day disagree - at which point password reset would start answering
 * employee links with "that link has expired".
 */
const { DEEP_LINK_NAMESPACES } = require("../usecase/telegram_update_dispatcher");

const EMPLOYEE_LINK_PREFIX = DEEP_LINK_NAMESPACES.EMPLOYEE_LINK;

/** How long the QR / deep link stays usable. */
const LINK_TOKEN_TTL_MS = 15 * 60 * 1000;

/**
 * How long we wait for the employee to tap Share Phone Number after opening
 * the link. Generous enough for somebody being shown what to do by a manager,
 * short enough that an abandoned session cannot be finished by whoever picks
 * the phone up next.
 */
const PENDING_TTL_MS = 15 * 60 * 1000;

/** How long a mismatch is remembered so the screen can show WHY nothing happened. */
const MISMATCH_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * What the employee's Telegram setup currently is.
 *
 * DERIVED ON READ, NEVER STORED AS ONE COLUMN. Connected, mobile-verified and
 * "anything outstanding" are separate facts - collapsing them into a single
 * enum column is what makes a lifecycle impossible to reason about later.
 */
const TELEGRAM_STATUS = Object.freeze({
  PENDING: "PENDING",
  AWAITING_CONTACT: "AWAITING_CONTACT",
  MOBILE_MISMATCH: "MOBILE_MISMATCH",
  CONNECTED: "CONNECTED",
  DISCONNECTED: "DISCONNECTED",
});

/** Why a pending verification ended without connecting anybody. */
const PENDING_OUTCOME = Object.freeze({
  VERIFIED: "VERIFIED",
  MOBILE_MISMATCH: "MOBILE_MISMATCH",
  CONTACT_NOT_OWNED: "CONTACT_NOT_OWNED",
  DUPLICATE_IDENTITY: "DUPLICATE_IDENTITY",
  EMPLOYEE_INELIGIBLE: "EMPLOYEE_INELIGIBLE",
  SUPERSEDED: "SUPERSEDED",
  EXPIRED: "EXPIRED",
});

/**
 * Audited events. IDENTIFIERS ONLY EVER, and the audit row's own columns say
 * what may be recorded: an employee id, a Telegram user id, an actor. Never a
 * token, never a mobile number, never a message.
 */
const AUDIT_EVENT = Object.freeze({
  TOKEN_ISSUED: "TOKEN_ISSUED",
  TOKEN_CONSUMED: "TOKEN_CONSUMED",
  TOKEN_REJECTED: "TOKEN_REJECTED",
  CONTACT_NOT_OWNED: "CONTACT_NOT_OWNED",
  MOBILE_MISMATCH: "MOBILE_MISMATCH",
  CONNECTED: "CONNECTED",
  DUPLICATE_IDENTITY: "DUPLICATE_IDENTITY",
  EMPLOYEE_INELIGIBLE: "EMPLOYEE_INELIGIBLE",
  DISCONNECTED: "DISCONNECTED",
});

/**
 * Everything the bot says, in one place.
 *
 * NOT ONE OF THEM NAMES A NUMBER. Not the number Telegram shared, not the
 * number on file, not a masked version of either: the employee holds one of
 * them already and a bot reply is readable by anyone holding the phone, so
 * echoing either only ever discloses. The mismatch message says what to do
 * and nothing about what was compared.
 *
 * They are PLAIN TEXT - the bot sends them with no parse mode - so no
 * punctuation in them can break a message the way an unbalanced `_` breaks
 * Telegram's legacy Markdown.
 */
const BOT_MESSAGE = Object.freeze({
  ASK_FOR_CONTACT:
    "Daily Needs HR: please confirm this is you by sharing your phone number.\n\n" +
    "Tap the Share Phone Number button below. Do not type your number, and do not " +
    "forward anyone else's contact - only the button can verify you.",
  LINK_INVALID:
    "That setup link has expired or was already used. Ask your manager to generate a new one.",
  CONTACT_NOT_OWNED:
    "That contact is not yours, so it cannot verify you. Please use the Share Phone Number " +
    "button below, which sends your own number.",
  MOBILE_MISMATCH:
    "Your Telegram mobile does not match the mobile recorded with Daily Needs. " +
    "Please contact your manager and try again.",
  DUPLICATE_IDENTITY:
    "This Telegram account is already connected to another employee record. Please contact HR.",
  EMPLOYEE_INELIGIBLE:
    "This setup link is no longer valid. Please contact HR.",
  CONNECTED: "Telegram connected successfully ✅",
  ASK_AGAIN:
    "Please tap the Share Phone Number button below to verify your number.",
  /**
   * Something on our side failed. It says so without inventing a reason - in
   * particular it does NOT say the account belongs to somebody else, which is
   * what a database failure used to be reported as.
   */
  TRY_AGAIN:
    "Something went wrong on our side and your Telegram was not connected. " +
    "Please tap the Share Phone Number button again in a moment.",
});

/** The Share Phone Number keyboard, as `messaging-api-telegram` expresses it. */
const CONTACT_REQUEST_KEYBOARD = Object.freeze({
  keyboard: [[{ text: "Share Phone Number", requestContact: true }]],
  resizeKeyboard: true,
  oneTimeKeyboard: true,
});

module.exports = {
  EMPLOYEE_LINK_PREFIX,
  LINK_TOKEN_TTL_MS,
  PENDING_TTL_MS,
  MISMATCH_TTL_MS,
  TELEGRAM_STATUS,
  PENDING_OUTCOME,
  AUDIT_EVENT,
  BOT_MESSAGE,
  CONTACT_REQUEST_KEYBOARD,
};
