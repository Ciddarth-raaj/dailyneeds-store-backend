const express = require("express");
const Joi = require("@hapi/joi");
const respondError = require("../utils/http");
const {
  PERMISSIONS: P,
  TELEGRAM_GROUP_CATEGORIES,
} = require("../constants/telegram_group_registry");
const {
  RULE_DIMENSIONS,
  RULE_DIMENSION,
  BULK_GRANT_MAX,
} = require("../constants/telegram_group_mapping");

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
 * Phase 3A - WHO SHOULD BELONG TO A GROUP. Configuration only; none of these
 * adds, removes, invites or bans anybody on Telegram.
 *
 *   GET    /:id/mappings            the rules, with live counts   view_telegram_groups
 *   POST   /:id/mappings            add a rule                  manage_telegram_groups
 *   DELETE /:id/mappings/:mapping   remove a rule               manage_telegram_groups
 *   GET    /:id/matched-employees   who they resolve to           view_telegram_groups
 *
 * NO NEW PERMISSION KEY. A mapping belongs to the group it maps into, so it
 * is governed by the same two keys as the group - a third key would be one
 * more thing to grant before a screen that is already behind a gate works.
 *
 * BOTH READS RESOLVE THE CALLER'S LIVE EMPLOYEE BRANCH SCOPE, because every
 * employee-derived number is scoped and not merely the names. A count of
 * other branches' staff is still information about other branches' staff.
 * The mapping RULES are company-wide and returned in full to anybody who may
 * open the screen; only the employee arithmetic narrows.
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
  constructor(
    telegramGroupRegistryUsecase,
    permissions,
    detectionUsecase,
    mappingUsecase,
    branchScope,
    membershipAdmin
  ) {
    this.usecase = telegramGroupRegistryUsecase;
    this.permissions = permissions;
    this.detection = detectionUsecase || null;
    this.mapping = mappingUsecase || null;
    this.branch = branchScope || null;
    /**
     * Phase 3C, OPTIONAL. Managed membership lives HERE, in the Group Map,
     * under `manage_telegram_groups` - the key held by the people who decide
     * what a group is for. Granting somebody a company group is granting
     * access, not recording a detail about them, so it is deliberately not
     * reachable through `employee_edit`.
     */
    this.membershipAdmin = membershipAdmin || null;
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

    /* ------------------------------------------- Phase 3A: group mapping */

    if (!this.mapping) return;

    r.get(
      "/:telegram_group_id(\\d+)/mappings",
      gate.require(P.VIEW_TELEGRAM_GROUPS),
      async (req, res) => {
        try {
          const id = parseInt(req.params.telegram_group_id, 10);
          // The RULES are company-wide and returned in full; the employee
          // COUNTS beside them are the caller's own.
          const scope = await this.scopeFor(req);
          res.json({
            code: 200,
            data: await this.mapping.getMappings(id, { scope }),
            // The vocabulary the Add Mapping form cascades through, so the
            // screen never hard-codes the dimensions or their labels.
            rule_dimensions: RULE_DIMENSIONS.map((dimension) => ({
              dimension,
              field: RULE_DIMENSION[dimension].field,
              label: RULE_DIMENSION[dimension].label,
            })),
          });
        } catch (err) {
          this.fail(res, err);
        }
        res.end();
      }
    );

    r.post(
      "/:telegram_group_id(\\d+)/mappings",
      gate.require(P.MANAGE_TELEGRAM_GROUPS),
      async (req, res) => {
        try {
          // EVERY DIMENSION IS OPTIONAL AND EVERY ONE IS `any`, because the
          // usecase owns the vocabulary AND the separate refusals - "select
          // a valid outlet", "that department no longer exists", "an
          // identical rule is already on this group". A Joi `number()` here
          // would flatten all of those into one generic message, and a
          // `required()` would re-introduce the type-then-target step this
          // screen exists to remove.
          this.validate(req.body, this._ruleSchema());
          const id = parseInt(req.params.telegram_group_id, 10);
          res.json(
            await this.mapping.addMapping(id, req.body, await this.permissions.actorFor(req))
          );
        } catch (err) {
          this.fail(res, err);
        }
        res.end();
      }
    );

    /**
     * PREVIEW - who this rule WOULD cover. Reads, writes nothing.
     *
     * POST rather than GET because the body is the rule, and the same
     * validator decides it here as at save time - so a rule the preview
     * accepted cannot be refused by Save for a reason the operator never saw.
     *
     * `view_telegram_groups`, like every other read on this screen, and the
     * branch scope is resolved SERVER-SIDE from the caller's current branch
     * assignment. There is no branch parameter on this route to send.
     */
    r.post(
      "/:telegram_group_id(\\d+)/mapping-preview",
      gate.require(P.VIEW_TELEGRAM_GROUPS),
      async (req, res) => {
        try {
          this.validate(req.body, { ...this._ruleSchema(), search: Joi.any().optional() });
          const id = parseInt(req.params.telegram_group_id, 10);
          const scope = await this.scopeFor(req);
          res.json({
            code: 200,
            data: await this.mapping.previewEmployees(id, { ...req.body, scope }),
          });
        } catch (err) {
          this.fail(res, err);
        }
        res.end();
      }
    );

    r.delete(
      "/:telegram_group_id(\\d+)/mappings/:telegram_group_mapping_id(\\d+)",
      gate.require(P.MANAGE_TELEGRAM_GROUPS),
      async (req, res) => {
        try {
          const id = parseInt(req.params.telegram_group_id, 10);
          const mappingId = parseInt(req.params.telegram_group_mapping_id, 10);
          res.json(await this.mapping.deleteMapping(id, mappingId));
        } catch (err) {
          this.fail(res, err);
        }
        res.end();
      }
    );

    /**
     * The people a group's rules resolve to.
     *
     * THE SCOPE IS RESOLVED HERE AND HANDED DOWN. `branch.resolve(req)` reads
     * the caller's CURRENT branch assignment from the database - never
     * `store_id` from the JWT, which is a copy taken at login that nothing
     * refreshes - and the usecase is given the answer rather than the
     * request. Nothing a client sends can widen it: there is no branch
     * parameter on this route to send.
     *
     * WITHOUT THE RESOLVER WIRED, THIS RETURNS NO NAMES. Failing closed, so a
     * future wiring mistake cannot quietly publish the staff list.
     */
    this._membershipRoutes(r, gate);

    r.get(
      "/:telegram_group_id(\\d+)/matched-employees",
      gate.require(P.VIEW_TELEGRAM_GROUPS),
      async (req, res) => {
        try {
          this.validate(req.query, { mapping_id: Joi.any().optional() });
          const id = parseInt(req.params.telegram_group_id, 10);
          const scope = await this.scopeFor(req);
          res.json({
            code: 200,
            data: await this.mapping.getMatchedEmployees(id, {
              mapping_id: req.query.mapping_id,
              scope,
            }),
          });
        } catch (err) {
          this.fail(res, err);
        }
        res.end();
      }
    );
  }

  /**
   * `utils/http#respondError` has no NOT-FOUND branch, so an id that does not
   * exist would be answered as a 500 - a server fault - when it is an
   * ordinary "no such group". `routes/biomax_device.js` solved this the same
   * way: honour `err.httpCode` first, and hand everything else to the shared
   * responder unchanged.
   */
  /**
   * MANAGED MEMBERSHIP - Phase 3C. Reading is `view_telegram_groups`;
   * granting and revoking are `manage_telegram_groups`, the same key that
   * already decides a group's mappings.
   */
  /** The three optional dimensions, as a Joi shape. One definition. */
  _ruleSchema() {
    const shape = {};
    for (const dimension of RULE_DIMENSIONS) {
      shape[RULE_DIMENSION[dimension].field] = Joi.any().optional();
    }
    return shape;
  }

  _membershipRoutes(r, gate) {
    if (!this.membershipAdmin) return;

    r.get(
      "/:telegram_group_id(\\d+)/membership",
      gate.require(P.VIEW_TELEGRAM_GROUPS),
      async (req, res) => {
        try {
          const id = parseInt(req.params.telegram_group_id, 10);
          res.json(await this.membershipAdmin.listForGroup(id));
        } catch (err) {
          this.fail(res, err);
        }
        res.end();
      }
    );

    r.post(
      "/:telegram_group_id(\\d+)/membership",
      gate.require(P.MANAGE_TELEGRAM_GROUPS),
      async (req, res) => {
        try {
          this.validate(req.body, { employee_id: Joi.any().required() });
          const id = parseInt(req.params.telegram_group_id, 10);
          res.json(
            await this.membershipAdmin.grantManual(
              id,
              req.body.employee_id,
              await this.permissions.actorFor(req)
            )
          );
        } catch (err) {
          this.fail(res, err);
        }
        res.end();
      }
    );

    /**
     * BULK GRANT - "Add Selected Employees" from the multi-level Map screen.
     *
     * ONE REQUEST FOR THE WHOLE SELECTION, never one per employee from the
     * browser. `manage_telegram_groups`, the same key as the single grant,
     * AND the caller's branch scope, which that key does not widen: the
     * usecase refuses the whole request if any selected employee is outside
     * it, and the scope is resolved server-side from the caller's current
     * branch assignment rather than read from the request.
     *
     * A LIST OF IDS, NOT A RULE. This creates MANUAL claims for the people
     * the operator picked. It does NOT write a mapping rule - inventing a
     * rule to describe an arbitrary selection is how a group ends up with
     * configuration nobody chose and nobody can read back.
     */
    r.post(
      "/:telegram_group_id(\\d+)/membership/bulk",
      gate.require(P.MANAGE_TELEGRAM_GROUPS),
      async (req, res) => {
        try {
          this.validate(req.body, { employee_ids: Joi.array().max(BULK_GRANT_MAX).required() });
          const id = parseInt(req.params.telegram_group_id, 10);
          const scope = await this.scopeFor(req);
          res.json(
            await this.membershipAdmin.grantManualBulk(
              id,
              req.body.employee_ids,
              await this.permissions.actorFor(req),
              { scope }
            )
          );
        } catch (err) {
          this.fail(res, err);
        }
        res.end();
      }
    );

    r.delete(
      "/:telegram_group_id(\\d+)/membership/:employee_id(\\d+)",
      gate.require(P.MANAGE_TELEGRAM_GROUPS),
      async (req, res) => {
        try {
          const id = parseInt(req.params.telegram_group_id, 10);
          const employeeId = parseInt(req.params.employee_id, 10);
          res.json(
            await this.membershipAdmin.revokeManual(
              id,
              employeeId,
              await this.permissions.actorFor(req)
            )
          );
        } catch (err) {
          this.fail(res, err);
        }
        res.end();
      }
    );

    /** Queue health and the dead-letter list, for the people who own it. */
    r.get("/membership/queue", gate.require(P.MANAGE_TELEGRAM_GROUPS), async (req, res) => {
      try {
        res.json(await this.membershipAdmin.queueHealth());
      } catch (err) {
        this.fail(res, err);
      }
      res.end();
    });

    r.post(
      "/membership/queue/:telegram_membership_job_id(\\d+)/requeue",
      gate.require(P.MANAGE_TELEGRAM_GROUPS),
      async (req, res) => {
        try {
          const jobId = parseInt(req.params.telegram_membership_job_id, 10);
          res.json(
            await this.membershipAdmin.requeue(jobId, await this.permissions.actorFor(req))
          );
        } catch (err) {
          this.fail(res, err);
        }
        res.end();
      }
    );
  }

  /**
   * THE CALLER'S EMPLOYEE SCOPE, resolved by the server and never by the
   * request. Both mapping reads need it now - the counts are scoped, not
   * only the names - so it is resolved in one place rather than twice.
   *
   * WITHOUT THE RESOLVER WIRED THIS IS `NONE`, which counts nothing and
   * lists nobody. Failing closed, so a future wiring mistake cannot quietly
   * publish other branches' staffing.
   */
  async scopeFor(req) {
    if (!this.branch) return { kind: "NONE", store_ids: [] };
    return this.branch.resolve(req);
  }

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

module.exports = (
  telegramGroupRegistryUsecase,
  permissions,
  detectionUsecase,
  mappingUsecase,
  branchScope,
  membershipAdmin
) =>
  new TelegramGroupRegistryRoutes(
    telegramGroupRegistryUsecase,
    permissions,
    detectionUsecase,
    mappingUsecase,
    branchScope,
    membershipAdmin
  );
module.exports.TelegramGroupRegistryRoutes = TelegramGroupRegistryRoutes;
