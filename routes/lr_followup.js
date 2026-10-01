// routes/lr_followup.js
const express = require("express");
const Joi = require("@hapi/joi");
const { requireEmployee } = require("../utils/actor");
const sendError = require("../utils/route_errors");
const { PERMISSION, SOURCE_TYPE, STATUS, DECISION, AGEING_BUCKETS } = require("../utils/lr_followup");

/**
 * Purchase / LR Follow-up.
 *
 * TWO CHECKS ON EVERY ENDPOINT, kept apart the way the Global Dashboard
 * access layer keeps them:
 *
 *   1. the permission key for the ACTION (route middleware), and
 *   2. the BRANCH SCOPE (own store / all stores), resolved from the server's
 *      own facts by `dashboardScope.resolveDashboardScope`. A follow-up of
 *      another branch reads as "not found" - knowing an id is not access.
 *
 * Follow-ups are created only by the two triggers (Advance paid, Credit
 * Purchase created) and the backfill. There is no "create follow-up" route.
 */

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

const requestKey = Joi.string().max(64).allow(null, "").optional();
const optionalDate = Joi.string().regex(/^\d{4}-\d{2}-\d{2}$/).allow(null, "").optional();

const lrSchema = {
  lr_no: Joi.string().max(100).allow(null, "").optional(),
  transporter_id: Joi.number().integer().allow(null).optional(),
  dispatch_date: optionalDate,
  expected_delivery_date: optionalDate,
  remark: Joi.string().max(1000).allow(null, "").optional(),
  request_key: requestKey,
};

const followUpSchema = {
  remark: Joi.string().max(1000).required(),
  next_follow_up_date: optionalDate,
  expected_delivery_date: optionalDate,
  request_key: requestKey,
};

const receivedSchema = {
  received_at: Joi.string().max(40).allow(null, "").optional(),
  remark: Joi.string().max(1000).allow(null, "").optional(),
  request_key: requestKey,
};

const resolveSchema = {
  decision: Joi.string().valid(Object.keys(DECISION)).required(),
  remark: Joi.string().max(1000).required(),
  received_at: Joi.string().max(40).allow(null, "").optional(),
  request_key: requestKey,
};

const SORT_FIELDS = [
  "lr_followup_id",
  "source_date",
  "amount",
  "expected_delivery_date",
  "next_follow_up_date",
  "last_follow_up_at",
  "supplier_name",
  "status",
  "ageing",
];

const listSchema = {
  limit: Joi.number().integer().min(1).optional(),
  offset: Joi.number().integer().min(0).optional(),
  status: Joi.string().valid(["OPEN", "ALL", ...Object.keys(STATUS)]).optional(),
  source_type: Joi.string().valid(Object.keys(SOURCE_TYPE)).optional(),
  distributor_code: Joi.number().integer().optional(),
  transporter_id: Joi.number().integer().optional(),
  from_date: optionalDate,
  to_date: optionalDate,
  ageing: Joi.string().valid(AGEING_BUCKETS.map((b) => b.key)).optional(),
  overdue_only: Joi.boolean().optional(),
  search: Joi.string().max(100).allow("").optional(),
  sort_by: Joi.string().valid(SORT_FIELDS).optional(),
  sort_dir: Joi.string().valid(["asc", "desc"]).optional(),
};

const forbidden = (message, reason) => {
  const err = new Error(message);
  err.name = "ForbiddenError";
  err.reason = reason;
  return err;
};

class LrFollowupRoutes {
  constructor(usecase, permissions, dashboardScope) {
    this.usecase = usecase;
    this.permissions = permissions;
    this.dashboardScope = dashboardScope;
    this.router = express.Router();
    this.init();
  }

  validate(payload, schema) {
    const result = Joi.validate(payload, schema);
    if (result.error !== null) throw result.error;
    return result.value;
  }

  /**
   * The branches this caller may see for `featureKey`: null = all, [id] =
   * their own. Refuses - never widens - when no scope is granted.
   */
  async storeIds(req, featureKey) {
    const scope = await this.dashboardScope.resolveDashboardScope(req, featureKey);
    if (scope.kind === this.dashboardScope.DASHBOARD_SCOPE.NONE) {
      throw forbidden(
        "Your account has no branch scope for LR Follow-up. Ask an administrator to grant Own Store or All Stores.",
        scope.reason
      );
    }
    return scope.store_ids;
  }

  handle(fn) {
    return async (req, res) => {
      try {
        await fn(req, res);
      } catch (err) {
        sendError(res, err);
      }
    };
  }

  init() {
    const { require: needs } = this.permissions;
    const router = this.router;
    const id = (req) => parseInt(req.params.id, 10);

    router.get(
      "/summary",
      needs(PERMISSION.VIEW),
      this.handle(async (req, res) => {
        const storeIds = await this.storeIds(req, PERMISSION.VIEW);
        res.json({ code: 200, data: await this.usecase.summary(storeIds) });
      })
    );

    router.get(
      "/",
      needs(PERMISSION.VIEW),
      this.handle(async (req, res) => {
        const q = this.validate(req.query, listSchema);
        const storeIds = await this.storeIds(req, PERMISSION.VIEW);
        const bucket = AGEING_BUCKETS.find((b) => b.key === q.ageing);
        const data = await this.usecase.list(
          {
            status: q.status,
            source_type: q.source_type,
            distributor_code: q.distributor_code,
            transporter_id: q.transporter_id,
            from_date: q.from_date || undefined,
            to_date: q.to_date || undefined,
            overdue_only: q.overdue_only,
            search: q.search,
            ageing_min: bucket ? bucket.min : undefined,
            ageing_max: bucket ? bucket.max : undefined,
          },
          storeIds,
          Math.min(Number(q.limit) || DEFAULT_LIMIT, MAX_LIMIT),
          Number(q.offset) || 0,
          q.sort_by,
          q.sort_dir
        );
        res.json({ code: 200, data });
      })
    );

    router.get(
      "/legacy",
      needs(PERMISSION.MANAGE_LEGACY),
      this.handle(async (req, res) => {
        const q = this.validate(req.query, { include_decided: Joi.boolean().optional() });
        const storeIds = await this.storeIds(req, PERMISSION.MANAGE_LEGACY);
        res.json({ code: 200, data: await this.usecase.legacyQueue(storeIds, q) });
      })
    );

    // The go-live backfill. Company-wide by nature, so an Own Store holder
    // cannot run it.
    router.post(
      "/legacy/backfill",
      needs(PERMISSION.MANAGE_LEGACY),
      this.handle(async (req, res) => {
        const storeIds = await this.storeIds(req, PERMISSION.MANAGE_LEGACY);
        if (storeIds !== null) {
          throw forbidden("The backfill covers every branch and needs All Stores scope.", "OWN_STORE_ONLY");
        }
        const data = await this.usecase.backfill(requireEmployee(req, "Running the LR follow-up backfill"));
        res.json({ code: 200, data });
      })
    );

    router.get(
      "/by-source/:type(ADVANCE_REQUEST|CREDIT_PURCHASE)/:sourceId(\\d+)",
      needs(PERMISSION.VIEW),
      this.handle(async (req, res) => {
        const storeIds = await this.storeIds(req, PERMISSION.VIEW);
        const data = await this.usecase.getBySource(
          req.params.type,
          parseInt(req.params.sourceId, 10),
          storeIds
        );
        res.json({ code: 200, data });
      })
    );

    router.get(
      "/:id(\\d+)",
      needs(PERMISSION.VIEW),
      this.handle(async (req, res) => {
        const storeIds = await this.storeIds(req, PERMISSION.VIEW);
        res.json({ code: 200, data: await this.usecase.getDetail(id(req), storeIds) });
      })
    );

    router.patch(
      "/:id(\\d+)/lr",
      needs(PERMISSION.UPDATE),
      this.handle(async (req, res) => {
        const body = this.validate(req.body, lrSchema);
        const storeIds = await this.storeIds(req, PERMISSION.UPDATE);
        const data = await this.usecase.updateLr(
          id(req),
          body,
          requireEmployee(req, "Updating LR details"),
          storeIds
        );
        res.json({ code: 200, data });
      })
    );

    router.post(
      "/:id(\\d+)/follow-ups",
      needs(PERMISSION.UPDATE),
      this.handle(async (req, res) => {
        const body = this.validate(req.body, followUpSchema);
        const storeIds = await this.storeIds(req, PERMISSION.UPDATE);
        const data = await this.usecase.addFollowUp(
          id(req),
          body,
          requireEmployee(req, "Adding a follow-up"),
          storeIds
        );
        res.status(201).json({ code: 200, data });
      })
    );

    router.post(
      "/:id(\\d+)/goods-received",
      needs(PERMISSION.MARK_RECEIVED),
      this.handle(async (req, res) => {
        const body = this.validate(req.body, receivedSchema);
        const storeIds = await this.storeIds(req, PERMISSION.MARK_RECEIVED);
        const data = await this.usecase.markGoodsReceived(
          id(req),
          body,
          requireEmployee(req, "Marking goods received"),
          storeIds
        );
        res.json({ code: 200, data });
      })
    );

    router.post(
      "/:id(\\d+)/resolve",
      needs(PERMISSION.MANAGE_LEGACY),
      this.handle(async (req, res) => {
        const body = this.validate(req.body, resolveSchema);
        const storeIds = await this.storeIds(req, PERMISSION.MANAGE_LEGACY);
        const data = await this.usecase.resolve(
          id(req),
          body,
          requireEmployee(req, "Recording a follow-up decision"),
          storeIds
        );
        res.json({ code: 200, data });
      })
    );
  }

  getRouter() {
    return this.router;
  }
}

module.exports = (usecase, permissions, dashboardScope) => new LrFollowupRoutes(usecase, permissions, dashboardScope);
