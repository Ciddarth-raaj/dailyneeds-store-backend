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
 *   2. the BRANCH SCOPE, by the module's own rule (utils/lr_followup_scope.js):
 *      administrators and holders of `lr_followup_all_stores` see every
 *      branch, everyone else their own store, read live. A follow-up of
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

const legacyDecisionSchema = {
  decision: Joi.string().valid(Object.keys(DECISION)).required(),
  remark: Joi.string().max(1000).required(),
  received_at: Joi.string().max(40).allow(null, "").optional(),
  request_key: requestKey,
};

const closeWithoutReceiptSchema = {
  closure_reason: Joi.string().valid(["REFUNDED", "ADJUSTED", "CANCELLED"]).required(),
  remark: Joi.string().trim().min(1).max(1000).required(),
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
  closure_reason: Joi.string()
    .valid(["GOODS_RECEIVED", "REFUNDED", "ADJUSTED", "CANCELLED", "WITHOUT_RECEIPT"])
    .optional(),
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
  constructor(usecase, permissions, lrScope) {
    this.usecase = usecase;
    this.permissions = permissions;
    this.lrScope = lrScope;
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
  /**
   * The branches this caller may see: null = all, [id] = their own. The
   * module's own rule (utils/lr_followup_scope.js), not the dashboard
   * scope. The feature key was already checked by the route guard.
   */
  storeIds(req) {
    return this.lrScope.storeIds(req);
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
        const storeIds = await this.storeIds(req);
        res.json({ code: 200, data: await this.usecase.summary(storeIds) });
      })
    );

    router.get(
      "/",
      needs(PERMISSION.VIEW),
      this.handle(async (req, res) => {
        const q = this.validate(req.query, listSchema);
        const storeIds = await this.storeIds(req);
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
            closure_reason: q.closure_reason,
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
        const storeIds = await this.storeIds(req);
        res.json({ code: 200, data: await this.usecase.legacyQueue(storeIds, q) });
      })
    );

    // The go-live backfill. Company-wide by nature, so an Own Store holder
    // cannot run it.
    router.post(
      "/legacy/backfill",
      needs(PERMISSION.MANAGE_LEGACY),
      this.handle(async (req, res) => {
        const storeIds = await this.storeIds(req);
        if (storeIds !== null) {
          throw forbidden("The backfill covers every branch and needs 'LR Follow-up: All Stores'.", "OWN_STORE_ONLY");
        }
        const data = await this.usecase.backfill(requireEmployee(req, "Running the LR follow-up backfill"));
        res.json({ code: 200, data });
      })
    );

    router.get(
      "/by-source/:type(ADVANCE_REQUEST|CREDIT_PURCHASE)/:sourceId(\\d+)",
      needs(PERMISSION.VIEW),
      this.handle(async (req, res) => {
        const storeIds = await this.storeIds(req);
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
        const storeIds = await this.storeIds(req);
        res.json({ code: 200, data: await this.usecase.getDetail(id(req), storeIds) });
      })
    );

    router.patch(
      "/:id(\\d+)/lr",
      needs(PERMISSION.UPDATE),
      this.handle(async (req, res) => {
        const body = this.validate(req.body, lrSchema);
        const storeIds = await this.storeIds(req);
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
        const storeIds = await this.storeIds(req);
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
        const storeIds = await this.storeIds(req);
        const data = await this.usecase.markGoodsReceived(
          id(req),
          body,
          requireEmployee(req, "Marking goods received"),
          storeIds
        );
        res.json({ code: 200, data });
      })
    );

    // Legacy Follow-up Verification: the answer for a backfilled row.
    router.post(
      "/:id(\\d+)/legacy-decision",
      needs(PERMISSION.MANAGE_LEGACY),
      this.handle(async (req, res) => {
        const body = this.validate(req.body, legacyDecisionSchema);
        const storeIds = await this.storeIds(req);
        const data = await this.usecase.resolveLegacy(
          id(req),
          body,
          requireEmployee(req, "Recording a legacy verification decision"),
          storeIds
        );
        res.json({ code: 200, data });
      })
    );

    // The exceptional close of a LIVE follow-up whose goods will never
    // come: refunded, adjusted / settled or cancelled. Its own admin key,
    // its own endpoint, a mandatory remark - and a closure reason that can
    // never be read as goods received.
    router.post(
      "/:id(\\d+)/close-without-receipt",
      needs(PERMISSION.CLOSE_WITHOUT_RECEIPT),
      this.handle(async (req, res) => {
        const body = this.validate(req.body, closeWithoutReceiptSchema);
        const storeIds = await this.storeIds(req);
        const data = await this.usecase.closeWithoutReceipt(
          id(req),
          body,
          requireEmployee(req, "Closing a follow-up without receipt"),
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

module.exports = (usecase, permissions, lrScope) => new LrFollowupRoutes(usecase, permissions, lrScope);
