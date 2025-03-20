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
          has_updated: Joi.boolean(),
          is_approved: Joi.boolean(),
          is_pushed: Joi.boolean(),
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

    // Update purchase flags
    router.put("/:id/flags", async (req, res) => {
      try {
        // Schema for flags update
        const flagsSchema = Joi.object({
          has_updated: Joi.boolean(),
          is_approved: Joi.boolean(),
        }).or("has_updated", "is_approved"); // At least one must be present

        const { error } = flagsSchema.validate(req.body);
        if (error) {
          return res.json({
            code: 422,
            msg: error.toString(),
            tag: "FLAGS-ERROR",
          });
        }

        const result = await this.debitNoteUsecase.updatePurchaseFlags(
          req.params.id,
          req.body
        );
        res.json(result);
      } catch (err) {
        console.log(err);
        res.json({ code: 500, msg: err.message });
      }
    });

    // Update purchase
    router.put("/:id", async (req, res) => {
      try {
        // Check if both objects exist
        if (!req.body.purchase || !req.body.purchase_internal) {
          return res.json({
            code: 422,
            msg: "Both purchase and purchase_internal must be provided",
          });
        }

        // Define purchase schema with tax arrays
        const purchaseSchema = Joi.object({
          store_id: Joi.number().required(),
          mprh_pr_no: Joi.string().max(20).required(),
          mprh_pr_refno: Joi.string().max(20).required(),
          mprh_pr_dt: Joi.date().required(),
          mprh_dist_code: Joi.string().max(20).required(),
          supplier_id: Joi.string().max(20).required(),
          supplier_name: Joi.string().max(100).required(),
          supplier_gstn: Joi.string().max(20).required(),
          tot_sgst_amt: Joi.number().precision(2).required(),
          tot_cgst_amt: Joi.number().precision(2).required(),
          tot_igst_amt: Joi.number().precision(2).required(),
          tot_gst_cess_amt: Joi.number().precision(2).required(),
          tot_item_qty: Joi.number().precision(2).required(),
          tot_item_value: Joi.number().precision(2).required(),
          ts: Joi.number().required(),
          sgst: Joi.array().items(taxItemSchema).required(),
          cgst: Joi.array().items(taxItemSchema).required(),
          igst: Joi.array().items(taxItemSchema).required(),
          cess: Joi.array().items(taxItemSchema).required(),
        });

        // Validate purchase
        const { error: purchaseError } = purchaseSchema.validate(
          req.body.purchase
        );
        if (purchaseError) {
          return res.json({
            code: 422,
            msg: purchaseError.toString(),
            tag: "DEBIT-NOTE-ERROR",
          });
        }

        // Schema for purchase_internal
        const internalSchema = Joi.object({
          tcs_value: Joi.number().precision(2).default(0.0),
          scheme_difference: Joi.number().precision(2).default(0.0),
          narration: Joi.string().allow("").optional(),
          mmh_mrc_refno: Joi.string().allow("").optional(),
          total_amount: Joi.number().precision(2).default(0.0),
          round_off: Joi.number().precision(2).default(0.0),
        });

        // Validate purchase_internal
        const { error: internalError } = internalSchema.validate(
          req.body.purchase_internal
        );
        if (internalError) {
          return res.json({
            code: 422,
            msg: internalError.toString(),
            tag: "DEBIT-NOTE-INTERNAL-ERROR",
          });
        }

        const purchase = {
          ...req.body.purchase,
          id: req.params.id,
          debit_note_id: req.params.id,
        };
        const purchase_internal = req.body.purchase_internal;
        const send_not_matched_notification =
          req.body.send_not_matched_notification ?? false;

        const result = await this.debitNoteUsecase.updatePurchaseWithInternal(
          purchase,
          purchase_internal,
          send_not_matched_notification
        );
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
