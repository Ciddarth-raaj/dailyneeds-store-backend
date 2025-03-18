const router = require("express").Router();
const Joi = require("@hapi/joi");

class DebitNoteRoutes {
  constructor(debitNoteUsecase) {
    this.debitNoteUsecase = debitNoteUsecase;
    this.init();
  }

  init() {
    // Define tax object schema
    const taxItemSchema = Joi.object({
      PERC: Joi.number().required(),
      TAXABLE: Joi.number().required(),
      VALUE: Joi.number().required(),
    });

    // Create debit note
    router.post("/", async (req, res) => {
      try {
        const schema = Joi.object({
          STORE_ID: Joi.number().required(),
          MPRH_PR_NO: Joi.string().max(20).required(),
          MPRH_PR_REFNO: Joi.string().max(20).required(),
          MPRH_PR_DT: Joi.date().required(),
          MPRH_DIST_CODE: Joi.string().max(20).required(),
          SUPPLIER_ID: Joi.string().max(20).required(),
          SUPPLIER_NAME: Joi.string().max(100).required(),
          SUPPLIER_GSTN: Joi.string().max(20).required(),
          TOT_SGST_AMT: Joi.number().precision(2).required(),
          TOT_CGST_AMT: Joi.number().precision(2).required(),
          TOT_IGST_AMT: Joi.number().precision(2).required(),
          TOT_GST_CESS_AMT: Joi.number().precision(2).required(),
          TOT_ITEM_QTY: Joi.number().precision(2).required(),
          TOT_ITEM_VALUE: Joi.number().precision(2).required(),
          TS: Joi.number().required(),
          SGST: Joi.array().items(taxItemSchema).required(),
          CGST: Joi.array().items(taxItemSchema).required(),
          IGST: Joi.array().items(taxItemSchema).required(),
          CESS: Joi.array().items(taxItemSchema).required(),
        });

        const { error, value } = schema.validate(req.body);
        if (error) {
          return res.json({ code: 422, msg: error.toString() });
        }

        const result = await this.debitNoteUsecase.create(value);
        res.json(result);
      } catch (err) {
        console.log(err);
        res.json({ code: 500, msg: err.message });
      }
    });

    // Get all debit notes
    router.get("/", async (req, res) => {
      try {
        const schema = Joi.object({
          store_id: Joi.number(),
          from_date: Joi.date(),
          to_date: Joi.date(),
        });

        const { error, value } = schema.validate(req.query);
        if (error) {
          return res.json({ code: 422, msg: error.toString() });
        }

        const result = await this.debitNoteUsecase.getAll(value);
        res.json(result);
      } catch (err) {
        console.log(err);
        res.json({ code: 500, msg: err.message });
      }
    });

    // Add this endpoint in the init() method
    router.post("/bulk", async (req, res) => {
      try {
        const taxItemSchema = Joi.object({
          PERC: Joi.number().required(),
          TAXABLE: Joi.number().required(),
          VALUE: Joi.number().required(),
        });

        const debitNoteSchema = Joi.object({
          STORE_ID: Joi.number().required(),
          MPRH_PR_NO: Joi.string().max(20).required(),
          MPRH_PR_REFNO: Joi.string().max(20).required(),
          MPRH_PR_DT: Joi.date().required(),
          MPRH_DIST_CODE: Joi.string().max(20).required(),
          SUPPLIER_ID: Joi.string().max(20).required(),
          SUPPLIER_NAME: Joi.string().max(100).required(),
          SUPPLIER_GSTN: Joi.string().max(20).required(),
          TOT_SGST_AMT: Joi.number().precision(2).required(),
          TOT_CGST_AMT: Joi.number().precision(2).required(),
          TOT_IGST_AMT: Joi.number().precision(2).required(),
          TOT_GST_CESS_AMT: Joi.number().precision(2).required(),
          TOT_ITEM_QTY: Joi.number().precision(2).required(),
          TOT_ITEM_VALUE: Joi.number().precision(2).required(),
          TS: Joi.number().required(),
          SGST: Joi.array().items(taxItemSchema).required(),
          CGST: Joi.array().items(taxItemSchema).required(),
          IGST: Joi.array().items(taxItemSchema).required(),
          CESS: Joi.array().items(taxItemSchema).required(),
        });

        const schema = Joi.array().items(debitNoteSchema);

        const { error, value } = schema.validate(req.body);
        if (error) {
          return res.json({ code: 422, msg: error.toString() });
        }

        const result = await this.debitNoteUsecase.bulkCreate(value);
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

module.exports = (debitNoteUsecase) => {
  return new DebitNoteRoutes(debitNoteUsecase);
};
