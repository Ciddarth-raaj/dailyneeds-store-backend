// routes/credit_purchase.js
const express = require("express");
const Joi = require("@hapi/joi");
const { requireEmployee } = require("../utils/actor");
const sendError = require("../utils/route_errors");
const { PERMISSION } = require("../utils/lr_followup");

/**
 * The minimal Credit Purchase entry. Raising one creates its LR Follow-up in
 * the same transaction (usecase/credit_purchase.js); there is no other way
 * to create a credit follow-up, and no edit or delete here.
 *
 * Reads on view_credit_purchase, raising on create_credit_purchase, both
 * narrowed to the caller's branch scope.
 */

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;
const date = Joi.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const createSchema = {
  distributor_code: Joi.number().integer().required(),
  bill_reference: Joi.string().trim().max(100).required(),
  amount: Joi.number().greater(0).max(9999999999.99).required(),
  bill_date: date.required(),
  outlet_id: Joi.number().integer().required(),
  transporter_id: Joi.number().integer().required(),
  lr_no: Joi.string().max(100).allow(null, "").optional(),
  dispatch_date: date.allow(null, "").optional(),
  expected_delivery_date: date.allow(null, "").optional(),
  remarks: Joi.string().max(500).allow(null, "").optional(),
  request_key: Joi.string().max(64).allow(null, "").optional(),
};

const forbidden = (message, reason) => {
  const err = new Error(message);
  err.name = "ForbiddenError";
  err.reason = reason;
  return err;
};

class CreditPurchaseRoutes {
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

    router.get(
      "/",
      needs(PERMISSION.VIEW_CREDIT_PURCHASE),
      this.handle(async (req, res) => {
        const q = this.validate(req.query, {
          limit: Joi.number().integer().min(1).optional(),
          offset: Joi.number().integer().min(0).optional(),
          distributor_code: Joi.number().integer().optional(),
          from_date: date.allow("").optional(),
          to_date: date.allow("").optional(),
          search: Joi.string().max(100).allow("").optional(),
        });
        const storeIds = await this.storeIds(req);
        const data = await this.usecase.list(
          {
            distributor_code: q.distributor_code,
            from_date: q.from_date || undefined,
            to_date: q.to_date || undefined,
            search: q.search,
          },
          storeIds,
          Math.min(Number(q.limit) || DEFAULT_LIMIT, MAX_LIMIT),
          Number(q.offset) || 0
        );
        res.json({ code: 200, data });
      })
    );

    router.get(
      "/:id(\\d+)",
      needs(PERMISSION.VIEW_CREDIT_PURCHASE),
      this.handle(async (req, res) => {
        const storeIds = await this.storeIds(req);
        res.json({ code: 200, data: await this.usecase.getById(parseInt(req.params.id, 10), storeIds) });
      })
    );

    router.post(
      "/",
      needs(PERMISSION.CREATE_CREDIT_PURCHASE),
      this.handle(async (req, res) => {
        const body = this.validate(req.body, createSchema);
        const storeIds = await this.storeIds(req);
        const data = await this.usecase.create(
          body,
          requireEmployee(req, "Raising a credit purchase"),
          storeIds
        );
        res.status(201).json({ code: 200, data });
      })
    );
  }

  getRouter() {
    return this.router;
  }
}

module.exports = (usecase, permissions, lrScope) =>
  new CreditPurchaseRoutes(usecase, permissions, lrScope);
