const express = require("express");
const Joi = require("@hapi/joi");
const respondError = require("../utils/http");
const {
  PERMISSIONS: P,
  TELEGRAM_GROUP_CATEGORIES,
} = require("../constants/telegram_group_registry");

/**
 * Telegram Group Registry. Mounted at /telegram-groups.
 *
 *   GET    /detected  groups that sent /setup and are not yet registered
 *                                                        manage_telegram_groups
 *   GET    /          list, with `?search=` and `?category=`   view_telegram_groups
 *   GET    /:id       one group, with its derived type          view_telegram_groups
 *   POST   /          add                                      manage_telegram_groups
 *   PUT    /:id       edit                                     manage_telegram_groups
 *   DELETE /:id       remove                                   manage_telegram_groups
 *
 * The REST shape is `routes/remarks_master.js`, the master CRUD this screen
 * is modelled on. The PERMISSION MIDDLEWARE is `routes/biomax_device.js`:
 * Remarks Master gates nothing on the server and relies on the menu hiding
 * the screen, which is presentation, not a check. Both keys are granted to
 * no designation by the migration, so administrators reach this through the
 * middleware's user_type 2 bypass until somebody is given them deliberately.
 *
 * JOI CHECKS SHAPE ONLY. The Chat ID format, the category vocabulary,
 * uniqueness and the outlet's existence are enforced in
 * `usecase/telegram_group_registry.js` so there is one copy of each rule.
 * `category` is listed in the Joi schema as a plain string on purpose: the
 * usecase owns that list and returns the message naming the four values.
 */
class TelegramGroupRegistryRoutes {
  constructor(telegramGroupRegistryUsecase, permissions, detectionUsecase) {
    this.usecase = telegramGroupRegistryUsecase;
    this.permissions = permissions;
    this.detection = detectionUsecase || null;
    this.router = express.Router();
    this.init();
  }

  init() {
    const r = this.router;
    const gate = this.permissions;

    r.get("/", gate.require(P.VIEW_TELEGRAM_GROUPS), async (req, res) => {
      try {
        this.validate(req.query, {
          search: Joi.string().allow("").max(150).optional(),
          category: Joi.string().allow("").max(50).optional(),
          // "none" for the company-wide groups; the usecase owns that word.
          outlet_id: Joi.any().optional(),
          bot_is_admin: Joi.any().optional(),
          is_active: Joi.any().optional(),
        });
        const data = await this.usecase.getAll(req.query);
        res.json({ code: 200, data, categories: TELEGRAM_GROUP_CATEGORIES });
      } catch (err) {
        this.fail(res, err);
      }
      res.end();
    });

    /**
     * Pending `/setup` detections.
     *
     * DECLARED BEFORE THE `:telegram_group_id` ROUTE. That parameter is
     * digits-only so "detected" could not match it today, but a later
     * loosening of the pattern would silently swallow this path, and the
     * order costs nothing.
     *
     * Behind the MANAGE key, not the view key: a detection is the first step
     * of registering a group, so whoever may not register one has no reason
     * to see which groups are waiting. It returns the chat id, the title and
     * the time - never a message body, a sender, or anything about the bot's
     * credentials.
     */
    r.get("/detected", gate.require(P.MANAGE_TELEGRAM_GROUPS), async (req, res) => {
      try {
        if (!this.detection) {
          res.json({ code: 200, data: [] });
          res.end();
          return;
        }
        res.json({ code: 200, data: await this.detection.list() });
      } catch (err) {
        this.fail(res, err);
      }
      res.end();
    });

    r.get("/:telegram_group_id(\\d+)", gate.require(P.VIEW_TELEGRAM_GROUPS), async (req, res) => {
      try {
        const id = parseInt(req.params.telegram_group_id, 10);
        const row = await this.usecase.getById(id);
        if (!row) {
          res.status(404).json({ code: 404, msg: "Telegram group not found" });
          res.end();
          return;
        }
        res.json({ code: 200, data: row });
      } catch (err) {
        this.fail(res, err);
      }
      res.end();
    });

    r.post("/", gate.require(P.MANAGE_TELEGRAM_GROUPS), async (req, res) => {
      try {
        this.validate(req.body, {
          group_name: Joi.string().max(150).required(),
          // `any` because the usecase owns the format AND the two different
          // refusal messages; a Joi pattern here would flatten "that is a
          // user id" into "does not match pattern".
          chat_id: Joi.any().required(),
          category: Joi.string().max(50).required(),
          used_for: Joi.string().max(255).required(),
          outlet_id: Joi.any().optional(),
          bot_is_admin: Joi.any().required(),
          // Optional: a new group defaults to Active.
          is_active: Joi.any().optional(),
        });
        const result = await this.usecase.create(req.body, await this.permissions.actorFor(req));
        res.json(result);
      } catch (err) {
        this.fail(res, err);
      }
      res.end();
    });

    r.put("/:telegram_group_id(\\d+)", gate.require(P.MANAGE_TELEGRAM_GROUPS), async (req, res) => {
      try {
        this.validate(req.body, {
          group_name: Joi.string().max(150).optional(),
          chat_id: Joi.any().optional(),
          category: Joi.string().max(50).optional(),
          used_for: Joi.string().max(255).optional(),
          outlet_id: Joi.any().optional(),
          bot_is_admin: Joi.any().optional(),
          is_active: Joi.any().optional(),
        });
        const id = parseInt(req.params.telegram_group_id, 10);
        const result = await this.usecase.update(id, req.body, await this.permissions.actorFor(req));
        res.json(result);
      } catch (err) {
        this.fail(res, err);
      }
      res.end();
    });

    r.delete("/:telegram_group_id(\\d+)", gate.require(P.MANAGE_TELEGRAM_GROUPS), async (req, res) => {
      try {
        const id = parseInt(req.params.telegram_group_id, 10);
        const result = await this.usecase.delete(id);
        res.json(result);
      } catch (err) {
        this.fail(res, err);
      }
      res.end();
    });
  }

  /**
   * `utils/http#respondError` has no NOT-FOUND branch, so an id that does not
   * exist would be answered as a 500 - a server fault - when it is an
   * ordinary "no such group". `routes/biomax_device.js` solved this the same
   * way: honour `err.httpCode` first, and hand everything else to the shared
   * responder unchanged.
   */
  fail(res, err) {
    if (err && err.httpCode) {
      res.status(err.httpCode).json({ code: err.httpCode, msg: err.message });
      return;
    }
    respondError(res, err);
  }

  validate(payload, schema) {
    const isValid = Joi.validate(payload === undefined ? {} : payload, schema);
    if (isValid.error !== null) throw isValid.error;
  }

  getRouter() {
    return this.router;
  }
}

module.exports = (telegramGroupRegistryUsecase, permissions, detectionUsecase) =>
  new TelegramGroupRegistryRoutes(telegramGroupRegistryUsecase, permissions, detectionUsecase);
module.exports.TelegramGroupRegistryRoutes = TelegramGroupRegistryRoutes;
