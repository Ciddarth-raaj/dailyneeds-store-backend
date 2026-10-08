// routes/lr_followup_manual.js
const express = require("express");
const Joi = require("@hapi/joi");
const { requireEmployee } = require("../utils/actor");
const sendError = require("../utils/route_errors");
const { PERMISSION } = require("../utils/lr_followup");

/**
 * Create LR Follow-up - the manual entry for goods a supplier dispatches on
 * credit. Mounted at /lr-followup/manual. Saving one creates the follow-up
 * (usecase/lr_followup_manual.js); from then on it is an ordinary LR
 * Follow-up, read and updated through /lr-followup. No edit or delete here.
 *
 * Supplier and transporter are required; LR No., dispatch date, expected
 * delivery date and remarks are optional. There is no bill, amount, bill
 * date or receiving outlet: every such delivery goes to the Warehouse.
 */

const date = Joi.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const createSchema = {
  distributor_code: Joi.number().integer().required(),
  transporter_id: Joi.number().integer().required(),
  lr_no: Joi.string().max(100).allow(null, "").optional(),
  dispatch_date: date.allow(null, "").optional(),
  expected_delivery_date: date.allow(null, "").optional(),
  remarks: Joi.string().max(500).allow(null, "").optional(),
  request_key: Joi.string().max(64).allow(null, "").optional(),
};

class LrFollowupManualRoutes {
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

    this.router.post(
      "/",
      needs(PERMISSION.CREATE_MANUAL),
      this.handle(async (req, res) => {
        const body = this.validate(req.body, createSchema);
        // The module's own branch rule (utils/lr_followup_scope.js).
        const storeIds = await this.lrScope.storeIds(req);
        const data = await this.usecase.create(
          body,
          requireEmployee(req, "Creating an LR Follow-up"),
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
  new LrFollowupManualRoutes(usecase, permissions, lrScope);
