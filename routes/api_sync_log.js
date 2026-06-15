const router = require("express").Router();
const Joi = require("@hapi/joi");
const respondError = require("../utils/http");

class ApiSyncLogRoutes {
  constructor(usecase) {
    this.usecase = usecase;
    this.init();
  }

  init() {
    router.get("/timeline", async (req, res) => {
      try {
        const schema = Joi.object({
          days: Joi.number().integer().min(1).max(30).default(7),
        });
        const { error, value } = schema.validate(req.query);
        if (error) {
          res.status(400).json({ code: 400, msg: error.message });
          res.end();
          return;
        }
        const result = await this.usecase.getTimeline(value);
        res.json(result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.get("/cron-config", async (_req, res) => {
      try {
        const result = await this.usecase.getCronConfigs();
        res.json(result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.put("/cron-config", async (req, res) => {
      try {
        const schema = Joi.object({
          log_type: Joi.string().required(),
          label: Joi.string().optional(),
          cron_expression: Joi.string().allow("").optional(),
          is_enabled: Joi.boolean().optional(),
        });
        const { error, value } = schema.validate(req.body);
        if (error) {
          res.status(400).json({ code: 400, msg: error.message });
          res.end();
          return;
        }
        const result = await this.usecase.updateCronConfig(value);
        res.json(result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.get("/", async (req, res) => {
      try {
        const schema = Joi.object({
          log_type: Joi.string().optional(),
          from_date: Joi.string().optional(),
          to_date: Joi.string().optional(),
          limit: Joi.number().integer().min(1).max(500).default(100),
          offset: Joi.number().integer().min(0).default(0),
        });
        const { error, value } = schema.validate(req.query);
        if (error) {
          res.status(400).json({ code: 400, msg: error.message });
          res.end();
          return;
        }
        const result = await this.usecase.getLogs(value);
        res.json(result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });
  }

  getRouter() {
    return router;
  }
}

module.exports = (usecase) => new ApiSyncLogRoutes(usecase);
