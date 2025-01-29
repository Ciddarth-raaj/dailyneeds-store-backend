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

    router.post("/epayment", async (req, res) => {
      try {
        const schema = Joi.object({
          bill_date: Joi.date().required(),
          store_id: Joi.number().required(),
          paytm_tid: Joi.string().required(),

          card_diff: Joi.number().allow(null).optional(),
          upi_diff: Joi.number().allow(null).optional(),
          sodexo_diff: Joi.number().allow(null).optional(),
          paytm_diff: Joi.number().allow(null).optional(),

          card_settled: Joi.boolean().optional(),
          upi_settled: Joi.boolean().optional(),
          sodexo_settled: Joi.boolean().optional(),
          paytm_settled: Joi.boolean().optional(),
        });

        const isValid = schema.validate(req.body);
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const result = await this.reconciliationUsecase.createOrUpdateEpayment(
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

    router.get("/sales", async (req, res) => {
      try {
        const schema = Joi.object({
          from_date: Joi.date().optional(),
          to_date: Joi.date().optional(),
          store_id: Joi.number().optional(),
        });

        const isValid = schema.validate(req.query);
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const result = await this.reconciliationUsecase.getSales(req.query);
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

    router.get("/epayment", async (req, res) => {
      try {
        const schema = Joi.object({
          from_date: Joi.date().optional(),
          to_date: Joi.date().optional(),
          store_id: Joi.number().optional(),
        });

        const isValid = schema.validate(req.query);
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const result = await this.reconciliationUsecase.getEpayment(req.query);
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

    // Delete epayment reconciliation records by date
    router.delete("/epayment/:date", async (req, res) => {
      try {
        const schema = Joi.object({
          date: Joi.date().required(),
        });

        const isValid = schema.validate({ date: req.params.date });
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const result = await this.reconciliationUsecase.deleteEpaymentByDate(
          req.params.date
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
