const router = require("express").Router();
const Joi = require("@hapi/joi");
const respondError = require("../utils/http");
const {
  gstTallyPurchaseRequestSchema,
} = require("../utils/tally_purchase_schema");
const gstTallyPurchaseFileLog = require("../utils/gst_tally_purchase_file_log");

class TallyRoutes {
  constructor(tallyUsecase, gstTallyPurchaseUsecase) {
    this.tallyUsecase = tallyUsecase;
    this.gstTallyPurchaseUsecase = gstTallyPurchaseUsecase;

    this.init();
  }

  init() {
    router.get("/purchase", async (req, res) => {
      try {
        const schema = Joi.object({
          from_date: Joi.date().required(),
          to_date: Joi.date().required(),
        });

        const isValid = schema.validate(req.query);
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const purchase = await this.tallyUsecase.getPurchase(
          req.query.from_date,
          req.query.to_date
        );
        res.json(purchase);
      } catch (err) {
        console.log(err);
        if (err.name === "ValidationError") {
          res.json({ error: err.toString(), data: [] });
        } else {
          res.json({ error: "An error occurred !", data: [] });
        }
      }

      res.end();
    });

    router.post("/gst-purchase", async (req, res) => {
      gstTallyPurchaseFileLog.clearPreviousLogs();
      gstTallyPurchaseFileLog.writeInput(req.body);

      try {
        const { error, value } = gstTallyPurchaseRequestSchema.validate(
          req.body
        );
        if (error) {
          const payload = { code: 422, msg: error.toString() };
          gstTallyPurchaseFileLog.writeError(payload, 422);
          res.status(422).json(payload);
          res.end();
          return;
        }

        const result = await this.gstTallyPurchaseUsecase.syncBatch(value);
        gstTallyPurchaseFileLog.writeResponse(result);
        res.json(result);
      } catch (err) {
        let httpStatus = 500;
        let payload = { code: 500, msg: "An error occurred !" };
        if (err.name === "ValidationError") {
          httpStatus = 400;
          payload = { code: 422, msg: err.toString() };
        } else if (err.name === "MissingProductIdsError") {
          httpStatus = 400;
          payload = {
            code: 400,
            msg: err.message,
            missing_product_ids: err.missing_product_ids || [],
          };
          if (err.dn_ref_no != null) {
            payload.dn_ref_no = err.dn_ref_no;
          }
        } else if (global.isDev()) {
          payload = { code: 500, msg: err.toString() };
        }
        gstTallyPurchaseFileLog.writeError(payload, httpStatus);
        respondError(res, err);
      }
      res.end();
    });

    router.get("/debit-note", async (req, res) => {
      try {
        const schema = Joi.object({
          from_date: Joi.date().required(),
          to_date: Joi.date().required(),
        });

        const isValid = schema.validate(req.query);
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const debitNote = await this.tallyUsecase.getDebitNote(
          req.query.from_date,
          req.query.to_date
        );
        res.json(debitNote);
      } catch (err) {
        console.log(err);
        if (err.name === "ValidationError") {
          res.json({ error: err.toString(), data: [] });
        } else {
          res.json({ error: "An error occurred !", data: [] });
        }
      }

      res.end();
    });

    router.get("/card-to-bank", async (req, res) => {
      try {
        const schema = Joi.object({
          from_date: Joi.date().required(),
          to_date: Joi.date().required(),
        });

        const isValid = schema.validate(req.query);
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const result = await this.tallyUsecase.getTallyCardToBank(
          req.query.from_date,
          req.query.to_date
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

    router.get("/sales-entry", async (req, res) => {
      try {
        const schema = Joi.object({
          from_date: Joi.date().required(),
          to_date: Joi.date().required(),
        });

        const isValid = schema.validate(req.query);
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const result = await this.tallyUsecase.getTallySalesEntry(
          req.query.from_date,
          req.query.to_date
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

    router.get("/expenses", async (req, res) => {
      try {
        const schema = Joi.object({
          from_date: Joi.date().required(),
          to_date: Joi.date().required(),
        });

        const isValid = schema.validate(req.query);
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const result = await this.tallyUsecase.getTallyExpenses(
          req.query.from_date,
          req.query.to_date
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

module.exports = (tallyUsecase, gstTallyPurchaseUsecase) => {
  return new TallyRoutes(tallyUsecase, gstTallyPurchaseUsecase);
};
