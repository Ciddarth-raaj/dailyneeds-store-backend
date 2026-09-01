const router = require("express").Router();
const Joi = require("@hapi/joi");
const respondError = require("../utils/http");

class PurchaseGstNo2aRoutes {
  constructor(gstPurchaseNo2aUsecase) {
    this.gstPurchaseNo2aUsecase = gstPurchaseNo2aUsecase;
    this.init();
  }

  init() {
    router.get("/", async (req, res) => {
      try {
        const { error, value } = Joi.object({
          dist_bill_from_date: Joi.date(),
          dist_bill_to_date: Joi.date(),
          gst_tally_purchase_id: Joi.number().integer(),
        })
          .and("dist_bill_from_date", "dist_bill_to_date")
          .validate(req.query, { abortEarly: false });

        if (error) {
          res.status(422).json({ code: 422, msg: error.toString() });
          res.end();
          return;
        }

        const result = await this.gstPurchaseNo2aUsecase.getAll(value);
        res.json(result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.post("/", async (req, res) => {
      try {
        const { error, value } = Joi.object({
          gst_tally_purchase_ids: Joi.array()
            .items(Joi.number().integer().required())
            .min(1)
            .required(),
          accepted_by: Joi.number().integer().required(),
        }).validate(req.body);

        if (error) {
          res.status(422).json({ code: 422, msg: error.toString() });
          res.end();
          return;
        }

        const result = await this.gstPurchaseNo2aUsecase.accept(value);
        if (result.code === 422) {
          res.status(422).json(result);
        } else {
          res.json(result);
        }
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.delete("/:gstTallyPurchaseId", async (req, res) => {
      try {
        const id = parseInt(req.params.gstTallyPurchaseId, 10);
        if (!Number.isFinite(id)) {
          res.status(422).json({ code: 422, msg: "Invalid id" });
          res.end();
          return;
        }
        const result = await this.gstPurchaseNo2aUsecase.remove(id);
        if (result.code === 404) {
          res.status(404).json(result);
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

module.exports = (gstPurchaseNo2aUsecase) => {
  return new PurchaseGstNo2aRoutes(gstPurchaseNo2aUsecase);
};
