const router = require("express").Router();
const Joi = require("@hapi/joi");
const respondError = require("../utils/http");

class PurchaseGstMatchRoutes {
  constructor(gstPurchaseMatchUsecase) {
    this.gstPurchaseMatchUsecase = gstPurchaseMatchUsecase;
    this.init();
  }

  init() {
    const upsertSchema = Joi.object({
      gst_purchase_match_id: Joi.number().integer().optional(),
      gst_b2b_invoice_id: Joi.number().integer().required(),
      gst_tally_purchase_id: Joi.number().integer().allow(null),
      purchase_id: Joi.number().integer().allow(null),
      matched_by: Joi.number().integer().required(),
    });

    router.get("/", async (req, res) => {
      try {
        const { error, value } = Joi.object({
          from_date: Joi.date(),
          to_date: Joi.date(),
          year: Joi.number().integer(),
          month: Joi.number().integer().min(1).max(12),
          purchase_id: Joi.number().integer(),
          gst_tally_purchase_id: Joi.number().integer(),
          gst_b2b_invoice_id: Joi.number().integer(),
        })
          .and("from_date", "to_date")
          .and("year", "month")
          .validate(req.query, { abortEarly: false });

        if (error) {
          res.status(422).json({ code: 422, msg: error.toString() });
          res.end();
          return;
        }

        const hasDateRange = value.from_date && value.to_date;
        const hasReturnPeriod = value.year != null && value.month != null;
        const hasIdFilter =
          value.purchase_id != null ||
          value.gst_tally_purchase_id != null ||
          value.gst_b2b_invoice_id != null;

        if (!hasDateRange && !hasReturnPeriod && !hasIdFilter) {
          res.status(422).json({
            code: 422,
            msg:
              "Provide from_date and to_date together, year and month together, or at least one of purchase_id, gst_tally_purchase_id, gst_b2b_invoice_id",
          });
          res.end();
          return;
        }

        const result = await this.gstPurchaseMatchUsecase.getAll(value);
        res.json(result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.post("/", async (req, res) => {
      try {
        const { error, value } = upsertSchema.validate(req.body);
        if (error) {
          res.status(422).json({ code: 422, msg: error.toString() });
          res.end();
          return;
        }
        const result = await this.gstPurchaseMatchUsecase.upsert(value);
        res.json(result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.delete("/:id", async (req, res) => {
      try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) {
          res.status(422).json({ code: 422, msg: "Invalid id" });
          res.end();
          return;
        }
        const result = await this.gstPurchaseMatchUsecase.delete(id);
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

module.exports = (gstPurchaseMatchUsecase) => {
  return new PurchaseGstMatchRoutes(gstPurchaseMatchUsecase);
};
