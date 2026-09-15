/**
 * Telegram Group Registry - the fixed vocabulary and the Chat ID rules.
 *
 * ONE COPY OF THE RULES. The route's Joi schema checks shape only; every
 * field rule that means something - the allowed categories, the Chat ID
 * format, the derived group type and the two warnings - lives here so the
 * usecase, the tests and any future caller read the same definitions, the
 * way `utils/workShift.js` holds the work shift rules rather than the route.
 *
 * WHY CATEGORY IS A CONSTANT AND NOT A MASTER TABLE. There are four values
 * and no requirement to add a fifth from the UI. A master table would be a
 * screen, a migration and a foreign key for a list that fits on one line,
 * and the backend would still have to be told which values are legal. When
 * a Category Master is genuinely wanted, this array is what it replaces.
 *
 * GROUP TYPE IS DERIVED, NEVER STORED. It is a pure function of the Chat ID
 * (`-100…` is a supergroup, any other negative id is a basic group), so a
 * stored column could only ever disagree with the id beside it. Nothing
 * asks the user to pick it.
 */

/** The only categories a registry row may carry. Order is display order. */
const TELEGRAM_GROUP_CATEGORIES = ["Attendance", "Maintenance", "HR", "Other"];

/**
 * A Telegram GROUP chat id: a leading minus and digits, nothing else.
 *
 * A POSITIVE ID IS A PERSON, NOT A GROUP - that is the whole reason this is
 * not `^-?\d+$`. Telegram gives users positive ids and chats negative ones,
 * so a positive value in this registry would be somebody's private chat and
 * the bot would be posting group announcements to one individual.
 */
const TELEGRAM_GROUP_CHAT_ID_RE = /^-\d+$/;

/**
 * `-0`, `-00`, … match the rule above by shape but are zero with a sign, and
 * zero is not a chat. Refused explicitly rather than left to surprise
 * somebody, and kept separate from the rule itself so the documented format
 * stays the one sentence people were given: a leading minus and digits.
 */
const ALL_ZEROS_RE = /^-0+$/;

/** Supergroups, and only supergroups, are `-100` followed by the rest. */
const SUPERGROUP_PREFIX = "-100";

const GROUP_TYPE = {
  SUPERGROUP: "Supergroup",
  BASIC_GROUP: "Basic Group",
};

/**
 * The two permission keys, read and write, exactly as the Remarks Master
 * pair is shaped (`view_*` / `add_*` -> here `view_*` / `manage_*`, the
 * newer naming used by every key added since the Biomax registry).
 *
 * Declared by the registry migration and GRANTED TO NOBODY: administrators
 * (`user_type` 2) pass through the middleware's bypass, and an administrator
 * ticks these for a designation on the rights screen when somebody else
 * should have them.
 */
const PERMISSIONS = {
  VIEW_TELEGRAM_GROUPS: "view_telegram_groups",
  MANAGE_TELEGRAM_GROUPS: "manage_telegram_groups",
};

const MESSAGES = {
  CHAT_ID_REQUIRED: "Group Chat ID is required",
  CHAT_ID_POSITIVE:
    "A positive Telegram ID belongs to an individual user, not a group. Enter the group's Chat ID, which begins with a minus - for example -1001234567890.",
  CHAT_ID_FORMAT:
    "Group Chat ID must be a negative whole number such as -1001234567890 - digits only, with a leading minus and no spaces or decimals.",
  CHAT_ID_DUPLICATE: "This Telegram Chat ID is already registered",
  BASIC_GROUP_WARNING:
    "This is a Basic Telegram Group. Invite-link and member-removal functionality will require the group to be converted to a Supergroup.",
  BOT_NOT_ADMIN_WARNING:
    "Bot is not an admin in this group. Member-removal functionality will not work.",
};

/** True for the exact strings this registry accepts as a group Chat ID. */
function isValidGroupChatId(value) {
  const text = String(value === undefined || value === null ? "" : value).trim();
  return TELEGRAM_GROUP_CHAT_ID_RE.test(text) && !ALL_ZEROS_RE.test(text);
}

/**
 * 'Supergroup' | 'Basic Group' | null.
 *
 * null for anything that is not a valid group Chat ID, so a caller that
 * forgot to validate cannot be handed a confident answer about rubbish.
 */
function deriveGroupType(chatId) {
  const value = String(chatId === undefined || chatId === null ? "" : chatId).trim();
  if (!isValidGroupChatId(value)) return null;
  return value.startsWith(SUPERGROUP_PREFIX) ? GROUP_TYPE.SUPERGROUP : GROUP_TYPE.BASIC_GROUP;
}

/** True when the id is a valid group id that is NOT a supergroup. */
function isBasicGroup(chatId) {
  return deriveGroupType(chatId) === GROUP_TYPE.BASIC_GROUP;
}

/** A canonical category match, or null. Case-insensitive, trimmed. */
function normaliseCategory(value) {
  const wanted = String(value === undefined || value === null ? "" : value).trim().toLowerCase();
  return TELEGRAM_GROUP_CATEGORIES.find((c) => c.toLowerCase() === wanted) || null;
}

/**
 * The warnings a row carries, as the list and the view screen show them.
 * Both are ADVISORY: neither one refuses a save.
 */
function warningsFor({ chat_id, bot_is_admin }) {
  const warnings = [];
  if (isBasicGroup(chat_id)) warnings.push(MESSAGES.BASIC_GROUP_WARNING);
  if (!bot_is_admin) warnings.push(MESSAGES.BOT_NOT_ADMIN_WARNING);
  return warnings;
}

module.exports = {
  PERMISSIONS,
  TELEGRAM_GROUP_CATEGORIES,
  TELEGRAM_GROUP_CHAT_ID_RE,
  ALL_ZEROS_RE,
  SUPERGROUP_PREFIX,
  GROUP_TYPE,
  MESSAGES,
  isValidGroupChatId,
  deriveGroupType,
  isBasicGroup,
  normaliseCategory,
  warningsFor,
};
