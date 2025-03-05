const router = require("express").Router();
const Joi = require("@hapi/joi");

class PurchaseTallyRoutes {
  constructor(purchaseTallyUsecase) {
    this.purchaseTallyUsecase = purchaseTallyUsecase;
    this.init();
  }

  init() {
    // Create entry
    router.post("/", async (req, res) => {
      try {
        const schema = Joi.object({
          MasterID: Joi.string().max(200).required(),
          VoucherNo: Joi.string().max(100).required(),
          InvoiceValue: Joi.number().required(),
          SupplierName: Joi.string().required(),
          CostCentre: Joi.string().required(),
        });

        const { error, value } = schema.validate(req.body);
        if (error) {
          return res.json({ code: 422, msg: error.toString() });
        }

        const result = await this.purchaseTallyUsecase.create(value);
        res.json(result);
      } catch (err) {
        console.log(err);
        res.json({ code: 500, msg: err.message });
      }
    });

    // Get all entries
    router.get("/", async (req, res) => {
      try {
        const schema = Joi.object({
          outlet_id: Joi.number(),
          from_date: Joi.date(),
          to_date: Joi.date(),
        });

        const { error, value } = schema.validate(req.query);
        if (error) {
          return res.json({ code: 422, msg: error.toString() });
        }

        const result = await this.purchaseTallyUsecase.getAll(value);
        res.json(result);
      } catch (err) {
        console.log(err);
        res.json({ code: 500, msg: err.message });
      }
    });

    // Get entry by MasterID
    router.get("/:id", async (req, res) => {
      try {
        const result = await this.purchaseTallyUsecase.getById(req.params.id);
        res.json(result);
      } catch (err) {
        console.log(err);
        res.json({ code: 500, msg: err.message });
      }
    });

    // Update entry
    router.put("/:id", async (req, res) => {
      try {
        const schema = Joi.object({
          VoucherNo: Joi.string().max(100),
          InvoiceValue: Joi.number(),
          SupplierName: Joi.string(),
          CostCentre: Joi.string(),
        });

        const { error, value } = schema.validate(req.body);
        if (error) {
          return res.json({ code: 422, msg: error.toString() });
        }

        const result = await this.purchaseTallyUsecase.update(
          req.params.id,
          value
        );
        res.json(result);
      } catch (err) {
        console.log(err);
        res.json({ code: 500, msg: err.message });
      }
    });

    // Delete entry
    router.delete("/:id", async (req, res) => {
      try {
        const result = await this.purchaseTallyUsecase.delete(req.params.id);
        res.json(result);
      } catch (err) {
        console.log(err);
        res.json({ code: 500, msg: err.message });
      }
    });
  }

  getRouter() {
    return router;
  }
}

module.exports = (purchaseTallyUsecase) => {
  return new PurchaseTallyRoutes(purchaseTallyUsecase);
};
