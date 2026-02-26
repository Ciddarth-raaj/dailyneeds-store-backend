const router = require("express").Router();
const Joi = require("@hapi/joi");
const respondError = require("../utils/http");

class GofrugalSynkerRoutes {
  constructor(usecase) {
    this.usecase = usecase;
    this.init();
  }

  init() {
    const syncSchema = {
      table_name: Joi.string().required().max(64),
      table_config: Joi.array()
        .items(
          Joi.object({
            name: Joi.string().required().max(64),
            type: Joi.string().optional().max(128),
            primaryKey: Joi.boolean().optional(),
            autoIncrement: Joi.boolean().optional(),
            nullable: Joi.boolean().optional()
          })
        )
        .min(1)
        .required(),
      unique_keys: Joi.array().items(Joi.string().max(64)).min(1).required(),
      table_items: Joi.array().items(Joi.object().unknown(true)).optional().default([])
    };

    router.post("/sync", async (req, res) => {
      try {
        const { table_name, table_config, unique_keys, table_items } = req.body;
        const isValid = Joi.validate(
          { table_name, table_config, unique_keys, table_items },
          syncSchema
        );
        if (isValid.error) {
          res.status(400).json({ code: 400, msg: isValid.error.message });
          res.end();
          return;
        }
        const configNames = new Set(table_config.map((c) => c.name));
        for (const k of unique_keys) {
          if (!configNames.has(k)) {
            res.status(400).json({
              code: 400,
              msg: `unique_keys must be a subset of table_config column names; missing: ${k}`
            });
            res.end();
            return;
          }
        }
        const result = await this.usecase.syncTable(
          table_name,
          table_config,
          unique_keys,
          table_items || []
        );
        res.json(result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    const deleteSchema = Joi.object({
      table_name: Joi.string().required().max(64).trim()
    });

    router.delete("/table", async (req, res) => {
      try {
        const isValid = Joi.validate(req.body, deleteSchema);
        if (isValid.error) {
          res.status(400).json({ code: 400, msg: isValid.error.message });
          res.end();
          return;
        }
        const { table_name } = req.body;
        const result = await this.usecase.deleteTable(table_name);
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

module.exports = (usecase) => {
  return new GofrugalSynkerRoutes(usecase);
};
