const router = require("express").Router();
const Joi = require("@hapi/joi");
const respondError = require("../utils/http");

const saleRowSchema = Joi.object({
  RETAIL_OUTLET_ID: Joi.number().integer().required(),
  ITEM_CODE: Joi.alternatives().try(Joi.string(), Joi.number()).required(),
  TRAN_DATE: Joi.string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .required(),
  TRAN_QTY: Joi.number().required(),
});

const bulkSchema = Joi.array().items(saleRowSchema).min(1).required();

class ProductSalesRoutes {
  constructor(productSalesUsecase) {
    this.productSalesUsecase = productSalesUsecase;
    this.init();
  }

  init() {
    router.post("/bulk", async (req, res) => {
      try {
        const isValid = Joi.validate(req.body, bulkSchema);
        if (isValid.error) {
          res.status(400).json({ code: 400, msg: isValid.error.message });
          res.end();
          return;
        }
        const rows = isValid.value.map((r) => ({
          retail_outlet_id: r.RETAIL_OUTLET_ID,
          item_code: r.ITEM_CODE,
          tran_date: r.TRAN_DATE,
          tran_qty: r.TRAN_QTY,
        }));
        const result = await this.productSalesUsecase.bulkCreate(rows);
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

module.exports = (productSalesUsecase) => {
  return new ProductSalesRoutes(productSalesUsecase);
};
