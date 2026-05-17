const router = require("express").Router();
const Joi = require("@hapi/joi");
const respondError = require("../utils/http");

class PurchaseGstRoutes {
  constructor(purchaseGstUsecase) {
    this.purchaseGstUsecase = purchaseGstUsecase;
    this.init();
  }

  init() {
    router.get("/", async (req, res) => {
      try {
        const { error, value } = Joi.object({
          retail_outlet_id: Joi.number(),
          from_date: Joi.date(),
          to_date: Joi.date(),
          dist_bill_from_date: Joi.date(),
          dist_bill_to_date: Joi.date(),
          mmh_mrc_refno: Joi.string(),
          master_id: Joi.string(),
        }).validate(req.query);
        if (error) {
          res.status(422).json({ code: 422, msg: error.toString() });
          res.end();
          return;
        }
        const result = await this.purchaseGstUsecase.getAll(value);
        res.json(result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.get("/:id", async (req, res) => {
      try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) {
          res.status(422).json({ code: 422, msg: "Invalid id" });
          res.end();
          return;
        }
        const result = await this.purchaseGstUsecase.getById(id);
        if (result.code === 404) {
          res.status(404).json({ code: 404, msg: "Purchase GST not found" });
        } else {
          res.json(result);
        }
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

module.exports = (purchaseGstUsecase) => {
  return new PurchaseGstRoutes(purchaseGstUsecase);
};
