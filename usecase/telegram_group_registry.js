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

/**
 * 409, and it exists for exactly one refusal: deleting a group that still has
 * mappings or unresolved managed claims. Phase 3C.
 */
function conflict(message, detail = {}) {
  const err = new Error(message);
  err.name = "ConflictError";
  err.httpCode = 409;
  err.detail = detail;
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
 * THE SUBMITTED STRING IS WHAT IS CHECKED - IT IS NEVER TRIMMED FIRST. A
 * value like `" -1001234567890 "` does not satisfy the approved rule, and
 * trimming before validating would quietly turn a string the rule refuses
 * into one it accepts: the check would be passing judgement on a value
 * nobody sent, and the row would be stored under an id the user never typed.
 * Whitespace is refused as the malformed Chat ID it is, and what is stored
 * is exactly the string that was validated.
 *
 * The two refusals are deliberately different sentences: "you typed a user id"
 * is a different mistake from "that is not a number at all", and telling
 * somebody their `-100…` group id is invalid when they pasted a personal one
 * would send them looking in the wrong place. That test runs on the
 * submitted string too, so a padded `" 123 "` is a format error rather than
 * a positive-id one - it is not a usable id of any kind.
 */
function normaliseChatId(value) {
  const text = String(value === undefined || value === null ? "" : value);
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

/**
 * A yes/no field as the form, the API and a script each spell it.
 *
 * One helper for both booleans so Bot Is Admin and Status cannot drift into
 * accepting different shapes of the same answer; `label` and `invalid` keep
 * each field's own message.
 */
function normaliseFlag(value, { label, invalid, required = true } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) throw validationError(`${label} is required`);
    return undefined;
  }
  if (value === true || value === 1 || value === "1" || value === "true" || value === "Yes" || value === "Active") return true;
  if (value === false || value === 0 || value === "0" || value === "false" || value === "No" || value === "Inactive") return false;
  throw validationError(invalid);
}

function normaliseBotIsAdmin(value, options = {}) {
  return normaliseFlag(value, {
    label: "Bot Is Admin",
    invalid: "Bot Is Admin must be Yes or No",
    ...options,
  });
}

/**
 * Status. OPTIONAL ON CREATE and defaults to Active: a group somebody is
 * registering is one they are about to use, and making them say so would be
 * a required field with one sensible answer.
 */
function normaliseIsActive(value, options = {}) {
  return normaliseFlag(value, {
    label: "Status",
    invalid: MESSAGES.STATUS_INVALID,
    required: false,
    ...options,
  });
}

class TelegramGroupRegistryUsecase {
  /**
   * `mappingRepo` and `claimRepo` are Phase 3C and OPTIONAL: without them the
   * delete behaves exactly as it did before, which is what keeps this file
   * inert until Phase 3C is wired.
   */
  constructor(telegramGroupRegistryRepo, { mappingRepo = null, claimRepo = null } = {}) {
    this.mappingRepo = mappingRepo;
    this.claimRepo = claimRepo;
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

  /**
   * `{ search?, category?, outlet_id?, bot_is_admin?, is_active? }`.
   *
   * Every filter is validated rather than passed through: an unsupported
   * category is REFUSED, not quietly ignored, because silently listing
   * everything in answer to a filter nobody supports is how a user concludes
   * the filter works. `outlet_id=none` is the company-wide groups.
   */
  async getAll(filters = {}) {
    try {
      const search = filters.search === undefined || filters.search === null
        ? null
        : String(filters.search).trim() || null;
      let category = null;
      if (filters.category !== undefined && filters.category !== null && String(filters.category).trim() !== "") {
        category = normaliseCategoryOrThrow(filters.category);
      }
      let outlet_id;
      const rawOutlet = filters.outlet_id;
      if (rawOutlet !== undefined && rawOutlet !== null && String(rawOutlet).trim() !== "") {
        outlet_id = String(rawOutlet).trim() === "none" ? "none" : normaliseOutletId(rawOutlet);
      }
      const bot_is_admin = normaliseBotIsAdmin(filters.bot_is_admin, { required: false });
      const is_active = normaliseIsActive(filters.is_active);

      const rows = await this.repo.getAll({ search, category, outlet_id, bot_is_admin, is_active });
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
        // Absent means Active - see normaliseIsActive.
        is_active: body.is_active === undefined ? true : normaliseIsActive(body.is_active),
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
      if (body.is_active !== undefined) fields.is_active = normaliseIsActive(body.is_active, { required: true });

      if (fields.outlet_id !== undefined) await this._assertOutletExists(fields.outlet_id);
      if (fields.chat_id !== undefined) {
        // Excluding this row is what lets a record keep its own Chat ID.
        await this._assertChatIdFree(fields.chat_id, telegram_group_id);
      }

      // A CHAT ID IS WHICH TELEGRAM GROUP THIS ROW IS. Changing it while the
      // row still manages people re-points every mapping and every claim at
      // a DIFFERENT group, silently: the employees stay in the old one, with
      // nothing left recording that they are there, and the cleanup that
      // would have removed them now aims somewhere else entirely.
      //
      // Renaming the row, re-categorising it, switching it off - all still
      // fine. Only the identity of the group is refused, and only while
      // something still depends on it. The message names the order that
      // works: remove the mappings, let cleanup finish, then re-point it.
      const changingChatId =
        fields.chat_id !== undefined && String(fields.chat_id) !== String(existing.chat_id);

      const actorEmployeeId = actor.employeeId === undefined ? null : actor.employeeId;
      const result = changingChatId
        ? await this._updateWithChatIdGuard(telegram_group_id, fields, actorEmployeeId)
        : await this.repo.update(telegram_group_id, fields, actorEmployeeId);
      const chatId = fields.chat_id === undefined ? existing.chat_id : fields.chat_id;
      const botIsAdmin = fields.bot_is_admin === undefined ? existing.bot_is_admin : fields.bot_is_admin;
      return {
        ...result,
        group_type: deriveGroupType(chatId),
        warnings: warningsFor({ chat_id: chatId, bot_is_admin: botIsAdmin }),
      };
    } catch (err) {
      if (
        err.name !== "ValidationError" &&
        err.name !== "NotFoundError" &&
        err.name !== "ConflictError"
      ) {
        this._log("UPDATE", err);
      }
      throw err;
    }
  }

  /**
   * THE GUARD AND THE WRITE SHARE A TRANSACTION, so a mapping or a claim
   * created between the two cannot slip through the gap - which is the only
   * gap that matters here, because the whole point of the guard is that
   * nothing still depends on this row.
   *
   * The same repository methods the delete guard uses, rather than a second
   * copy of "what counts as still managing people".
   */
  async _updateWithChatIdGuard(telegram_group_id, fields, actorEmployeeId) {
    if (!this.mappingRepo || !this.claimRepo || !this.repo.withTransaction) {
      return this.repo.update(telegram_group_id, fields, actorEmployeeId);
    }
    return this.repo.withTransaction(async (tx) => {
      const mappings = await this.mappingRepo.countForGroup(telegram_group_id, { tx });
      const claims = await this.claimRepo.countLiveForGroup(telegram_group_id, { tx });
      if (mappings > 0 || claims > 0) {
        throw conflict(
          "This group still manages people, so its Chat ID cannot be changed. Remove its " +
            "mappings, let managed membership finish its cleanup, and then change the Chat ID.",
          { mappings, unresolved_claims: claims }
        );
      }
      return this.repo.update(telegram_group_id, fields, actorEmployeeId, { tx });
    });
  }

  /**
   * HARD DELETE, GUARDED. Phase 3C.
   *
   * `employee_telegram_group_membership` cascades from this row, so deleting
   * a group with unresolved claims would erase the evidence that people
   * still need removing FROM THAT GROUP - silently, and precisely when
   * somebody is winding it down. Mappings block it too: a group that still
   * has rules is still managing people, and deleting it would strand them
   * with no record of why.
   *
   * The correct order is the one the message names: remove the mappings,
   * let reconciliation close the claims, then delete. The check and the
   * delete share a transaction, so a claim opened in between cannot slip
   * through the gap between them.
   */
  async delete(telegram_group_id) {
    try {
      const existing = await this.repo.getById(telegram_group_id);
      if (!existing) throw notFound("Telegram group not found");
      if (this.mappingRepo && this.claimRepo && this.repo.withTransaction) {
        return await this.repo.withTransaction(async (tx) => {
          const mappings = await this.mappingRepo.countForGroup(telegram_group_id, { tx });
          const claims = await this.claimRepo.countLiveForGroup(telegram_group_id, { tx });
          if (mappings > 0 || claims > 0) {
            throw conflict(
              "This group still manages people. Remove its mappings and let managed membership " +
                "finish its cleanup before deleting the group.",
              { mappings, unresolved_claims: claims }
            );
          }
          return this.repo.delete(telegram_group_id, { tx });
        });
      }
      return await this.repo.delete(telegram_group_id);
    } catch (err) {
      if (err.name !== "NotFoundError" && err.name !== "ConflictError") this._log("DELETE", err);
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

module.exports = (telegramGroupRegistryRepo, deps) =>
  new TelegramGroupRegistryUsecase(telegramGroupRegistryRepo, deps);
module.exports.TelegramGroupRegistryUsecase = TelegramGroupRegistryUsecase;
