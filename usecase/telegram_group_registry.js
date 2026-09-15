const logger = require("../utils/logger");
const {
  TELEGRAM_GROUP_CATEGORIES,
  MESSAGES,
  isValidGroupChatId,
  deriveGroupType,
  normaliseCategory,
  warningsFor,
} = require("../constants/telegram_group_registry");

/**
 * Telegram Group Registry - the rules behind the screen.
 *
 * THE VALIDATION IS HERE, NOT IN THE ROUTE. The route's Joi schema refuses a
 * malformed BODY - a missing field, a number where a string belongs - and
 * nothing more. Everything that is a rule about Telegram or about this
 * registry is enforced in this file, so a future caller that is not the
 * screen (a script, another service) gets the same answers:
 *
 *   Chat ID     `^-\d+$`. A POSITIVE id is refused with its own message
 *               because a positive Telegram id is an individual user, not a
 *               group, and that is the mistake worth naming.
 *   Category    one of the four fixed values, matched case-insensitively.
 *               ANY OTHER VALUE IS REFUSED even though the UI only ever
 *               offers four - the list is a rule, not a convenience.
 *   Uniqueness  checked before the write so the user sees a sentence.
 *               The UNIQUE index in the migration is what actually
 *               guarantees it; this check is the good error message. On
 *               EDIT the row excludes ITSELF, or every save of an unchanged
 *               group would fail against its own Chat ID.
 *   Outlet      optional, and when given it must exist.
 *
 * NEITHER WARNING BLOCKS A SAVE. A Basic Group is a legitimate registry
 * entry and so is a group the bot does not administer; both are recorded and
 * flagged, and `warnings` travels with every row so the list and the view
 * screen say the same thing without re-deriving it.
 */

function validationError(message) {
  const err = new Error(message);
  err.name = "ValidationError";
  return err;
}

function notFound(message) {
  const err = new Error(message);
  err.name = "NotFoundError";
  err.httpCode = 404;
  return err;
}

/** A required, trimmed, length-limited string. */
function requiredText(value, label, max) {
  const text = String(value === undefined || value === null ? "" : value).trim();
  if (!text) throw validationError(`${label} is required`);
  if (text.length > max) throw validationError(`${label} must be at most ${max} characters`);
  return text;
}

/**
 * The Chat ID, as it will be stored.
 *
 * The two refusals are deliberately different sentences: "you typed a user id"
 * is a different mistake from "that is not a number at all", and telling
 * somebody their `-100…` group id is invalid when they pasted a personal one
 * would send them looking in the wrong place.
 */
function normaliseChatId(value) {
  const text = String(value === undefined || value === null ? "" : value).trim();
  if (!text) throw validationError(MESSAGES.CHAT_ID_REQUIRED);
  if (/^\+?\d+$/.test(text)) throw validationError(MESSAGES.CHAT_ID_POSITIVE);
  if (!isValidGroupChatId(text)) throw validationError(MESSAGES.CHAT_ID_FORMAT);
  return text;
}

function normaliseCategoryOrThrow(value) {
  if (value === undefined || value === null || String(value).trim() === "") {
    throw validationError("Category is required");
  }
  const category = normaliseCategory(value);
  if (!category) {
    throw validationError(
      `Category must be one of: ${TELEGRAM_GROUP_CATEGORIES.join(", ")}`
    );
  }
  return category;
}

/** '', null, undefined -> null. Anything else must be a positive integer. */
function normaliseOutletId(value) {
  if (value === undefined || value === null || value === "") return null;
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw validationError("Outlet is not valid");
  return id;
}

function normaliseBotIsAdmin(value, { required = true } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) throw validationError("Bot Is Admin is required");
    return undefined;
  }
  if (value === true || value === 1 || value === "1" || value === "true" || value === "Yes") return true;
  if (value === false || value === 0 || value === "0" || value === "false" || value === "No") return false;
  throw validationError("Bot Is Admin must be Yes or No");
}

class TelegramGroupRegistryUsecase {
  constructor(telegramGroupRegistryRepo) {
    this.repo = telegramGroupRegistryRepo;
  }

  _log(code, err) {
    logger.Log({
      level: logger.LEVEL.ERROR,
      component: "USECASE.TELEGRAM_GROUP_REGISTRY",
      code: `USECASE.TELEGRAM_GROUP_REGISTRY.${code}`,
      description: err.toString(),
      category: "",
      ref: {},
    });
  }

  /**
   * The derived fields every read carries: the group type from the Chat ID,
   * and the warnings. Never stored, never sent in by a caller.
   */
  static decorate(row) {
    if (!row) return null;
    return {
      ...row,
      group_type: deriveGroupType(row.chat_id),
      warnings: warningsFor(row),
    };
  }

  /** `{ search?, category? }`. An unsupported category is refused, not ignored. */
  async getAll(filters = {}) {
    try {
      const search = filters.search === undefined || filters.search === null
        ? null
        : String(filters.search).trim() || null;
      let category = null;
      if (filters.category !== undefined && filters.category !== null && String(filters.category).trim() !== "") {
        category = normaliseCategoryOrThrow(filters.category);
      }
      const rows = await this.repo.getAll({ search, category });
      return rows.map(TelegramGroupRegistryUsecase.decorate);
    } catch (err) {
      if (err.name !== "ValidationError") this._log("GET_ALL", err);
      throw err;
    }
  }

  async getById(telegram_group_id) {
    try {
      const row = await this.repo.getById(telegram_group_id);
      return TelegramGroupRegistryUsecase.decorate(row);
    } catch (err) {
      this._log("GET_BY_ID", err);
      throw err;
    }
  }

  async create(body = {}, actor = {}) {
    try {
      const row = {
        group_name: requiredText(body.group_name, "Group Name", 150),
        chat_id: normaliseChatId(body.chat_id),
        category: normaliseCategoryOrThrow(body.category),
        used_for: requiredText(body.used_for, "Used For", 255),
        outlet_id: normaliseOutletId(body.outlet_id),
        bot_is_admin: normaliseBotIsAdmin(body.bot_is_admin),
        created_by: actor.employeeId === undefined ? null : actor.employeeId,
      };

      await this._assertOutletExists(row.outlet_id);
      await this._assertChatIdFree(row.chat_id, null);

      const result = await this.repo.create(row);
      return {
        ...result,
        group_type: deriveGroupType(row.chat_id),
        warnings: warningsFor(row),
      };
    } catch (err) {
      if (err.name !== "ValidationError" && err.name !== "NotFoundError") this._log("CREATE", err);
      throw err;
    }
  }

  /**
   * A partial update: only the fields present in `body` are touched, and each
   * present field is validated exactly as it is on create. Sending the row
   * back unchanged - including its own Chat ID - must succeed.
   */
  async update(telegram_group_id, body = {}, actor = {}) {
    try {
      const existing = await this.repo.getById(telegram_group_id);
      if (!existing) throw notFound("Telegram group not found");

      const fields = {};
      if (body.group_name !== undefined) fields.group_name = requiredText(body.group_name, "Group Name", 150);
      if (body.chat_id !== undefined) fields.chat_id = normaliseChatId(body.chat_id);
      if (body.category !== undefined) fields.category = normaliseCategoryOrThrow(body.category);
      if (body.used_for !== undefined) fields.used_for = requiredText(body.used_for, "Used For", 255);
      if (body.outlet_id !== undefined) fields.outlet_id = normaliseOutletId(body.outlet_id);
      if (body.bot_is_admin !== undefined) fields.bot_is_admin = normaliseBotIsAdmin(body.bot_is_admin);

      if (fields.outlet_id !== undefined) await this._assertOutletExists(fields.outlet_id);
      if (fields.chat_id !== undefined) {
        // Excluding this row is what lets a record keep its own Chat ID.
        await this._assertChatIdFree(fields.chat_id, telegram_group_id);
      }

      const result = await this.repo.update(
        telegram_group_id,
        fields,
        actor.employeeId === undefined ? null : actor.employeeId
      );
      const chatId = fields.chat_id === undefined ? existing.chat_id : fields.chat_id;
      const botIsAdmin = fields.bot_is_admin === undefined ? existing.bot_is_admin : fields.bot_is_admin;
      return {
        ...result,
        group_type: deriveGroupType(chatId),
        warnings: warningsFor({ chat_id: chatId, bot_is_admin: botIsAdmin }),
      };
    } catch (err) {
      if (err.name !== "ValidationError" && err.name !== "NotFoundError") this._log("UPDATE", err);
      throw err;
    }
  }

  async delete(telegram_group_id) {
    try {
      const existing = await this.repo.getById(telegram_group_id);
      if (!existing) throw notFound("Telegram group not found");
      return await this.repo.delete(telegram_group_id);
    } catch (err) {
      if (err.name !== "NotFoundError") this._log("DELETE", err);
      throw err;
    }
  }

  async _assertOutletExists(outlet_id) {
    if (outlet_id === null || outlet_id === undefined) return;
    if (!(await this.repo.outletExists(outlet_id))) {
      throw validationError("Outlet is not valid");
    }
  }

  async _assertChatIdFree(chat_id, excludeId) {
    const clash = await this.repo.getByChatId(chat_id, excludeId);
    if (clash) {
      throw validationError(
        `${MESSAGES.CHAT_ID_DUPLICATE}${clash.group_name ? ` to "${clash.group_name}"` : ""}.`
      );
    }
  }
}

module.exports = (telegramGroupRegistryRepo) =>
  new TelegramGroupRegistryUsecase(telegramGroupRegistryRepo);
module.exports.TelegramGroupRegistryUsecase = TelegramGroupRegistryUsecase;
