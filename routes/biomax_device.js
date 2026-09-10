const express = require("express");
const Joi = require("@hapi/joi");
const P = require("../constants/hr_permissions");
const respondError = require("../utils/http");

/**
 * Biomax device management. Mounted at /attendance/devices.
 *
 *   GET  /                    list, with current location and status    view_biomax_devices
 *   GET  /unregistered        Cloud IDs that punched but are not registered  view_biomax_devices
 *   GET  /details             one device: periods and event history        view_biomax_devices
 *   POST /create              add a device with its first period           manage_biomax_devices
 *   POST /update-details      label / notes                                 manage_biomax_devices
 *   POST /assign              move (or re-activate): new period from a time manage_biomax_devices
 *   POST /deactivate          close the open period                         manage_biomax_devices
 *   POST /correct-cloud-id    audited typo correction, refused after punches manage_biomax_devices
 *
 * Both keys are ADMIN ONLY at go-live: the migration grants them to no
 * designation, and administrators pass through the middleware's user_type 2
 * bypass. An administrator can grant them to a designation on the
 * designation permissions screen later.
 *
 * A Cloud ID is never edited through /update-details. A broken terminal is
 * replaced by deactivating it and creating the new Cloud ID as a new
 * device; the old record and its punches stay as they were (R17).
 */
class BiomaxDeviceRoutes {
  constructor(biomaxDeviceUsecase, permissions) {
    this.usecase = biomaxDeviceUsecase;
    this.permissions = permissions;
    this.router = express.Router();
    this.init();
  }

  init() {
    const r = this.router;
    const P_ = this.permissions;

    r.get("/", P_.require(P.VIEW_BIOMAX_DEVICES), async (req, res) => {
      try {
        res.json({ code: 200, data: await this.usecase.list() });
      } catch (err) {
        this.fail(res, err);
      }
    });

    r.get("/unregistered", P_.require(P.VIEW_BIOMAX_DEVICES), async (req, res) => {
      try {
        res.json({ code: 200, data: await this.usecase.unregisteredSeen() });
      } catch (err) {
        this.fail(res, err);
      }
    });

    r.get("/details", P_.require(P.VIEW_BIOMAX_DEVICES), async (req, res) => {
      try {
        this.validate(req.query, { biomax_device_id: Joi.number().integer().required() });
        res.json({ code: 200, data: await this.usecase.details(req.query.biomax_device_id) });
      } catch (err) {
        this.fail(res, err);
      }
    });

    r.post("/create", P_.require(P.MANAGE_BIOMAX_DEVICES), async (req, res) => {
      try {
        this.validate(req.body, {
          dev_id: Joi.string().required(),
          label: Joi.string().required(),
          notes: Joi.string().allow("", null).optional(),
          outlet_id: Joi.number().integer().required(),
          effective_from: Joi.string().required(),
          note: Joi.string().allow("", null).optional(),
        });
        res.json(await this.usecase.create(req.body, await this.permissions.actorFor(req)));
      } catch (err) {
        this.fail(res, err);
      }
    });

    r.post("/update-details", P_.require(P.MANAGE_BIOMAX_DEVICES), async (req, res) => {
      try {
        this.validate(req.body, {
          biomax_device_id: Joi.number().integer().required(),
          label: Joi.string().optional(),
          notes: Joi.string().allow("", null).optional(),
          dev_id: Joi.any().optional(), // refused by the usecase with a clear message
        });
        res.json(await this.usecase.updateDetails(req.body, await this.permissions.actorFor(req)));
      } catch (err) {
        this.fail(res, err);
      }
    });

    r.post("/assign", P_.require(P.MANAGE_BIOMAX_DEVICES), async (req, res) => {
      try {
        this.validate(req.body, {
          biomax_device_id: Joi.number().integer().required(),
          outlet_id: Joi.number().integer().required(),
          effective_from: Joi.string().required(),
          note: Joi.string().allow("", null).optional(),
          confirm_before_last_punch: Joi.any().optional(),
        });
        res.json(await this.usecase.assign(req.body, await this.permissions.actorFor(req)));
      } catch (err) {
        this.fail(res, err);
      }
    });

    r.post("/deactivate", P_.require(P.MANAGE_BIOMAX_DEVICES), async (req, res) => {
      try {
        this.validate(req.body, {
          biomax_device_id: Joi.number().integer().required(),
          effective_to: Joi.string().required(),
          note: Joi.string().allow("", null).optional(),
          confirm_before_last_punch: Joi.any().optional(),
        });
        res.json(await this.usecase.deactivate(req.body, await this.permissions.actorFor(req)));
      } catch (err) {
        this.fail(res, err);
      }
    });

    r.post("/correct-cloud-id", P_.require(P.MANAGE_BIOMAX_DEVICES), async (req, res) => {
      try {
        this.validate(req.body, {
          biomax_device_id: Joi.number().integer().required(),
          dev_id: Joi.string().required(),
          reason: Joi.string().required(),
        });
        res.json(await this.usecase.correctCloudId(req.body, await this.permissions.actorFor(req)));
      } catch (err) {
        this.fail(res, err);
      }
    });
  }

  validate(payload, schema) {
    const isValid = Joi.validate(payload === undefined ? {} : payload, schema);
    if (isValid.error !== null) throw isValid.error;
  }

  fail(res, err) {
    if (err && err.httpCode) {
      res.status(err.httpCode).json({ code: err.httpCode, msg: err.message });
      return;
    }
    if (err && err.name === "ValidationError" && err.needs_confirmation) {
      res.status(409).json({ code: 409, msg: err.message, needs_confirmation: true, last_punch_at: err.last_punch_at });
      return;
    }
    respondError(res, err);
  }

  getRouter() {
    return this.router;
  }
}

module.exports = (biomaxDeviceUsecase, permissions) =>
  new BiomaxDeviceRoutes(biomaxDeviceUsecase, permissions);
module.exports.BiomaxDeviceRoutes = BiomaxDeviceRoutes;
