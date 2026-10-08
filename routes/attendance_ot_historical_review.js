const express = require("express");
const Joi = require("@hapi/joi");
const P = require("../constants/hr_permissions");
const respondError = require("../utils/http");

/**
 * HISTORICAL OT REVIEW API - see usecase/attendance_ot_historical_review.js.
 *
 * Every route requires `attendance_ot_historical_review` (granted to nobody
 * by migration; administrators hold it through the user_type 2 bypass).
 *
 *   GET  /attendance/ot/historical-review/preview    read only, writes nothing
 *   POST /attendance/ot/historical-review/authorise  creates PENDING OT for the
 *        named dates of a preview whose hash still matches; approves nothing
 *   GET  /attendance/ot/historical-review/batches    the audit of past batches
 *
 * The authorising administrator is the token's - never a body field.
 */
const DATE = Joi.string().regex(/^\d{4}-\d{2}-\d{2}$/);

class AttendanceOtHistoricalReviewRoutes {
  constructor(usecase, permissions) {
    this.usecase = usecase;
    this.permissions = permissions;
    this.router = express.Router();
    this.init();
  }

  init() {
    const gate = this.permissions.require(P.ATTENDANCE_OT_HISTORICAL_REVIEW);

    this.router.get("/attendance/ot/historical-review/preview", gate, async (req, res) => {
      try {
        const isValid = Joi.validate(req.query, {
          from_date: DATE.optional(),
          to_date: DATE.optional(),
          employee_id: Joi.number().integer().positive().optional(),
        });
        if (isValid.error !== null) throw isValid.error;
        const out = await this.usecase.preview({
          from_date: req.query.from_date || null,
          to_date: req.query.to_date || null,
          employee_id: req.query.employee_id ? Number(req.query.employee_id) : null,
        });
        res.json({ code: 200, ...out });
      } catch (err) {
        respondError(res, err);
      }
    });

    this.router.post("/attendance/ot/historical-review/authorise", gate, async (req, res) => {
      try {
        const isValid = Joi.validate(req.body || {}, {
          from_date: DATE.optional(),
          to_date: DATE.optional(),
          preview_hash: Joi.string().hex().length(64).required(),
          items: Joi.array()
            .items(Joi.object({ employee_id: Joi.number().integer().positive().required(), attendance_date: DATE.required() }))
            .min(1)
            .max(2000)
            .optional(),
          note: Joi.string().max(255).allow("", null).optional(),
          confirm: Joi.boolean().valid(true).required(),
        });
        if (isValid.error !== null) throw isValid.error;
        const out = await this.usecase.authorise({
          actor: {
            employee_id: Number(req.decoded.employee_id),
            user_id: req.decoded.id === null || req.decoded.id === undefined ? null : Number(req.decoded.id),
          },
          from_date: req.body.from_date || null,
          to_date: req.body.to_date || null,
          preview_hash: req.body.preview_hash,
          items: req.body.items || null,
          note: req.body.note || null,
        });
        res.json({ code: 200, ...out });
      } catch (err) {
        if (err && err.code === "PREVIEW_STALE") {
          res.status(409).json({ code: 409, msg: err.message, error_code: err.code });
          return;
        }
        respondError(res, err);
      }
    });

    this.router.get("/attendance/ot/historical-review/batches", gate, async (req, res) => {
      try {
        res.json({ code: 200, batches: await this.usecase.listBatches() });
      } catch (err) {
        respondError(res, err);
      }
    });
  }

  getRouter() {
    return this.router;
  }
}

module.exports = (usecase, permissions) => new AttendanceOtHistoricalReviewRoutes(usecase, permissions);
module.exports.AttendanceOtHistoricalReviewRoutes = AttendanceOtHistoricalReviewRoutes;
