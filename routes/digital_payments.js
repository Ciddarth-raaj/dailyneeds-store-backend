const router = require("express").Router();
const Joi = require("@hapi/joi");

class DigitalPaymentsRoutes {
  constructor(digitalPaymentsUsecase) {
    this.digitalPaymentsUsecase = digitalPaymentsUsecase;
    this.init();
  }

  init() {
    router.post("/", async (req, res) => {
      try {
        const schema = Joi.object({
          store_id: Joi.string().required(),
          bank_mid: Joi.string().optional().allow(""),
          bank_tid: Joi.string().optional().allow(""),
          api_key: Joi.string().optional().allow(""),
          payment_mid: Joi.string().optional().allow(""),
          payment_tid: Joi.string().optional().allow(""),
          paytm_aggregator_id: Joi.string().optional().allow(""),
          pluxe_outlet_id: Joi.string().optional().allow(""),
          s_no: Joi.string().optional().allow(""),
        });

        const isValid = schema.validate(req.body);
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const result = await this.digitalPaymentsUsecase.create(req.body);
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

    router.get("/", async (req, res) => {
      try {
        const schema = Joi.object({
          store_id: Joi.number().optional(),
        });

        const isValid = schema.validate(req.query);
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const result = await this.digitalPaymentsUsecase.getAll(req.query);
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

    // Get digital payment by ID
    router.get("/:id", async (req, res) => {
      try {
        const schema = Joi.object({
          id: Joi.number().required(),
        });

        const isValid = schema.validate({ id: parseInt(req.params.id) });
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const result = await this.digitalPaymentsUsecase.getById(req.params.id);

        if (result.code === 404) {
          res.status(404).json(result);
        } else {
          res.json(result);
        }
      } catch (err) {
        if (err.name === "ValidationError") {
          res.json({ code: 422, msg: err.toString() });
        } else {
          console.log(err);
          res.json({ code: 500, msg: err.message });
        }
      }
    });

    // Update digital payment
    router.put("/:id", async (req, res) => {
      try {
        const idSchema = Joi.object({
          id: Joi.number().required(),
        });

        const bodySchema = Joi.object({
          bank_mid: Joi.string().optional().allow(""),
          bank_tid: Joi.string().optional().allow(""),
          api_key: Joi.string().optional().allow(""),
          payment_mid: Joi.string().optional().allow(""),
          payment_tid: Joi.string().optional().allow(""),
          paytm_aggregator_id: Joi.string().optional().allow(""),
          pluxe_outlet_id: Joi.string().optional().allow(""),
          s_no: Joi.string().optional().allow(""),
        });

        const isValidId = idSchema.validate({ id: parseInt(req.params.id) });
        const isValidBody = bodySchema.validate(req.body);

        if (isValidId.error !== null) {
          throw isValidId.error;
        }

        if (isValidBody.error !== null) {
          throw isValidBody.error;
        }

        const payment = {
          ...req.body,
          payment_id: parseInt(req.params.id),
        };

        const result = await this.digitalPaymentsUsecase.update(payment);

        if (result.code === 404) {
          res.status(404).json(result);
        } else {
          res.json(result);
        }
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

module.exports = (digitalPaymentsUsecase) => {
  return new DigitalPaymentsRoutes(digitalPaymentsUsecase);
};
