const express = require("express");
const Joi = require("@hapi/joi");
const P = require("../constants/hr_permissions");
const respondError = require("../utils/http");

/**
 * Historical pull requests. Mounted at /attendance/historical-pulls.
 *
 *   GET  /            list (filters: dev_id, status, limit)   manage_biomax_historical_pull
 *   GET  /details     one pull, its command and block summaries manage_biomax_historical_pull
 *   POST /create      queue a GET_LOG_DATA for one device/range manage_biomax_historical_pull
 *
 * ADMIN ONLY at this stage: the key is granted to no designation, so only
 * user_type 2 passes. Nothing here returns raw block bytes, and nothing
 * here sends anything to a device - creating a pull only queues the
 * command; the receiver decides (and today refuses) to hand it over.
 */
class BiomaxHistoricalPullRoutes {
  constructor(usecase, permissions) {
    this.usecase = usecase;
    this.permissions = permissions;
    this.router = express.Router();
    this.init();
  }

  init() {
    const r = this.router;
    const P_ = this.permissions;

    r.get("/", P_.require(P.MANAGE_BIOMAX_HISTORICAL_PULL), async (req, res) => {
      try {
        this.validate(req.query, {
          dev_id: Joi.string().optional(),
          status: Joi.string().valid("REQUESTED", "WAITING_DEVICE", "RECEIVING", "COMPLETED", "FAILED").optional(),
          limit: Joi.number().integer().min(1).max(1000).optional(),
        });
        res.json({ code: 200, data: await this.usecase.list(req.query) });
      } catch (err) {
        this.fail(res, err);
      }
    });

    r.get("/details", P_.require(P.MANAGE_BIOMAX_HISTORICAL_PULL), async (req, res) => {
      try {
        this.validate(req.query, { biomax_historical_pull_id: Joi.number().integer().required() });
        res.json({ code: 200, data: await this.usecase.details(req.query.biomax_historical_pull_id) });
      } catch (err) {
        this.fail(res, err);
      }
    });

    r.post("/create", P_.require(P.MANAGE_BIOMAX_HISTORICAL_PULL), async (req, res) => {
      try {
        this.validate(req.body, {
          biomax_device_id: Joi.number().integer().required(),
          from: Joi.string().required(),
          to: Joi.string().required(),
        });
        res.json(await this.usecase.create(req.body, await this.permissions.actorFor(req)));
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
      const body = { code: err.httpCode, msg: err.message };
      if (err.existing_pull_id) body.existing_pull_id = err.existing_pull_id;
      res.status(err.httpCode).json(body);
      return;
    }
    if (err && err.name === "CommandRefused") {
      res.status(400).json({ code: 400, msg: err.message });
      return;
    }
    respondError(res, err);
  }

  getRouter() {
    return this.router;
  }
}

module.exports = (usecase, permissions) => new BiomaxHistoricalPullRoutes(usecase, permissions);
module.exports.BiomaxHistoricalPullRoutes = BiomaxHistoricalPullRoutes;
