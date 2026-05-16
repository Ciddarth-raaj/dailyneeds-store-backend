const router = require("express").Router();
const Joi = require("@hapi/joi");
const respondError = require("../utils/http");
const {
  gstTallyPurchaseRequestSchema,
} = require("../utils/tally_purchase_schema");

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
      try {
        const { error, value } = gstTallyPurchaseRequestSchema.validate(
          req.body
        );
        if (error) {
          res.status(422).json({ code: 422, msg: error.toString() });
          res.end();
          return;
        }

        const result = await this.gstTallyPurchaseUsecase.sync(value);
        if (result.code === 404) {
          res.status(404).json(result);
        } else if (result.code === 400 || result.code === 422) {
          res.status(result.code).json(result);
        } else {
          res.json(result);
        }
      } catch (err) {
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
