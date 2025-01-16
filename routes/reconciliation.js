const router = require("express").Router();
const Joi = require("@hapi/joi");

class ReconciliationRoutes {
  constructor(reconciliationUsecase) {
    this.reconciliationUsecase = reconciliationUsecase;
    this.init();
  }

  init() {
    router.post("/sales", async (req, res) => {
      try {
        const schema = Joi.object({
          bill_date: Joi.date().required(),
          store_id: Joi.number().required(),
          loyalty_diff: Joi.number().required(),
          sales_diff: Joi.number().required(),
          return_diff: Joi.number().required(),
        });

        const isValid = schema.validate(req.body);
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const result = await this.reconciliationUsecase.createOrUpdateSales(
          req.body
        );
        res.json(result);
      } catch (err) {
        if (err.name === "ValidationError") {
          res.json({ code: 422, msg: err.toString() });
        } else {
          console.log(err);
          res.json({ code: 500, msg: err.message });
        }
      }
    });
  }

  getRouter() {
    return router;
  }
}

module.exports = (reconciliationUsecase) => {
  return new ReconciliationRoutes(reconciliationUsecase);
};
