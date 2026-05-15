const router = require("express").Router();
const Joi = require("@hapi/joi");
const respondError = require("../utils/http");

const bulkRowSchema = Joi.object({
  MID_ITEM_CODE: Joi.alternatives().try(Joi.string(), Joi.number()).required(),
  STOCK: Joi.number().required(),
  STOCK_VALUE: Joi.number().required(),
  MSA_NAME: Joi.string().required(),
  RETAIL_OUTLET_ID: Joi.number().integer().required(),
});

const bulkSchema = Joi.array().items(bulkRowSchema).min(1).required();

class DeadStockItemsRoutes {
  constructor(deadStockItemsUsecase) {
    this.deadStockItemsUsecase = deadStockItemsUsecase;
    this.init();
  }

  init() {
    router.get("/", async (req, res) => {
      try {
        const result = await this.deadStockItemsUsecase.listForClient();
        res.json(result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.post("/bulk", async (req, res) => {
      try {
        const isValid = Joi.validate(req.body, bulkSchema);
        if (isValid.error) {
          res.status(400).json({ code: 400, msg: isValid.error.message });
          res.end();
          return;
        }
        const rows = isValid.value.map((r) => ({
          mid_item_code: r.MID_ITEM_CODE,
          stock: r.STOCK,
          stock_value: r.STOCK_VALUE,
          msa_name: r.MSA_NAME,
          retail_outlet_id: r.RETAIL_OUTLET_ID,
        }));
        const result = await this.deadStockItemsUsecase.bulkReplace(rows);
        if (result.code === 400) {
          res.status(400).json(result);
          res.end();
          return;
        }
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

module.exports = (deadStockItemsUsecase) => {
  return new DeadStockItemsRoutes(deadStockItemsUsecase);
};
