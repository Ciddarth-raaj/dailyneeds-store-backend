const express = require("express");
const Joi = require("@hapi/joi");
const respondError = require("../utils/http");
const { isAdminRequest } = require("../middlewares/admin_only");

/**
 * Attendance -> DEVICE TIME CORRECTION. Administrators only.
 *
 *   GET  /attendance/device-time-corrections/options      devices, outlets, reason codes
 *   POST /attendance/device-time-corrections/preview      what would change - writes nothing
 *   POST /attendance/device-time-corrections              apply a previewed batch
 *   GET  /attendance/device-time-corrections              the batches, newest first
 *   GET  /attendance/device-time-corrections/:id          one batch and its punches
 *   POST /attendance/device-time-corrections/:id/revert   revert an applied batch
 *
 * EVERY ROUTE checks `user_type` 2 on the verified token and nothing
 * grantable - no permission key, no designation, no approver role reaches it
 * (`middlewares/admin_only.js`) - and the usecase checks the actor again. The
 * refusal is worded as the permission middleware's, with `error: ADMIN_ONLY`,
 * because the web app treats any other 403 as a dead session.
 *
 * Joi refuses every key it does not name: a client cannot send punch ids,
 * corrected times, an employee, an actor or a status. The punches are chosen
 * on the server from the criteria alone.
 */

const CRITERIA = {
  date: Joi.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).required(),
  biomax_device_id: Joi.number().integer().min(1).required(),
  outlet_id: Joi.number().integer().min(1).allow(null, "").optional(),
  from_time: Joi.string().trim().regex(/^\d{1,2}:\d{2}(:\d{2})?$/).required(),
  to_time: Joi.string().trim().regex(/^\d{1,2}:\d{2}(:\d{2})?$/).required(),
  offset_minutes: Joi.number().integer().min(-720).max(720).invalid(0).required(),
  reason_code: Joi.string().trim().max(40).required(),
  remarks: Joi.string().trim().min(5).max(500).required(),
};

class AttendanceDeviceTimeCorrectionRoutes {
  constructor(usecase) {
    this.usecase = usecase;
    this.router = express.Router();
    this.init();
  }

  static actorOf(req) {
    const d = req.decoded || {};
    return {
      employee_id: d.employee_id === null || d.employee_id === undefined ? null : Number(d.employee_id),
      user_id: d.id === null || d.id === undefined ? null : Number(d.id),
      user_type: d.user_type,
    };
  }

  /** 401 / 403 before anything else runs. */
  static adminOnly(req, res, next) {
    if (!req.decoded) return res.status(401).json({ code: 401, msg: "Unauthorized" });
    if (!isAdminRequest(req)) {
      return res.status(403).json({
        code: 403,
        msg: "You do not have permission to perform this action",
        error: "ADMIN_ONLY",
      });
    }
    return next();
  }

  init() {
    const r = this.router;
    const base = "/attendance/device-time-corrections";
    const admin = AttendanceDeviceTimeCorrectionRoutes.adminOnly;
    const actorOf = AttendanceDeviceTimeCorrectionRoutes.actorOf;

    r.get(`${base}/options`, admin, async (req, res) => {
      try {
        res.json(await this.usecase.options(actorOf(req)));
      } catch (err) {
        AttendanceDeviceTimeCorrectionRoutes.fail(res, err);
      }
    });

    r.post(`${base}/preview`, admin, async (req, res) => {
      try {
        const isValid = Joi.validate(req.body || {}, CRITERIA);
        if (isValid.error !== null) throw isValid.error;
        res.json(await this.usecase.preview(req.body, actorOf(req)));
      } catch (err) {
        AttendanceDeviceTimeCorrectionRoutes.fail(res, err);
      }
    });

    r.post(base, admin, async (req, res) => {
      try {
        const isValid = Joi.validate(req.body || {}, {
          ...CRITERIA,
          batch_ref: Joi.string().trim().guid().required(),
          preview_fingerprint: Joi.string().trim().hex().length(64).required(),
        });
        if (isValid.error !== null) throw isValid.error;
        res.json(await this.usecase.apply(req.body, actorOf(req)));
      } catch (err) {
        AttendanceDeviceTimeCorrectionRoutes.fail(res, err);
      }
    });

    r.get(base, admin, async (req, res) => {
      try {
        res.json(await this.usecase.list({ limit: req.query.limit }, actorOf(req)));
      } catch (err) {
        AttendanceDeviceTimeCorrectionRoutes.fail(res, err);
      }
    });

    r.get(`${base}/:id`, admin, async (req, res) => {
      try {
        res.json(await this.usecase.get(req.params.id, actorOf(req)));
      } catch (err) {
        AttendanceDeviceTimeCorrectionRoutes.fail(res, err);
      }
    });

    r.post(`${base}/:id/revert`, admin, async (req, res) => {
      try {
        const isValid = Joi.validate(req.body || {}, {
          reason: Joi.string().trim().min(5).max(500).required(),
        });
        if (isValid.error !== null) throw isValid.error;
        res.json(await this.usecase.revert({ correction_id: req.params.id, reason: req.body.reason }, actorOf(req)));
      } catch (err) {
        AttendanceDeviceTimeCorrectionRoutes.fail(res, err);
      }
    });
  }

  /**
   * Refusals keep their meaning on the wire: 409 for a stale preview, a
   * second apply or a second revert; 422-in-400 for a validation failure -
   * the payroll lock included, with its code and locked months so the
   * screen can say exactly which month stopped it.
   */
  static fail(res, err) {
    if (err && err.httpCode) {
      return res.status(err.httpCode).json({ code: err.httpCode, msg: err.message, error: err.code || null });
    }
    if (err && err.name === "NotFoundError") return res.status(404).json({ code: 404, msg: err.message });
    if (err && err.name === "ValidationError") {
      return res.status(400).json({
        code: 422,
        msg: err.message,
        error: err.code || null,
        locked_months: err.locked_months || undefined,
      });
    }
    return respondError(res, err);
  }

  getRouter() {
    return this.router;
  }
}

module.exports = (usecase) => new AttendanceDeviceTimeCorrectionRoutes(usecase);
module.exports.AttendanceDeviceTimeCorrectionRoutes = AttendanceDeviceTimeCorrectionRoutes;
