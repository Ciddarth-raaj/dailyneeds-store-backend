const router = require("express").Router();
const Joi = require("@hapi/joi");

class PurchaseRoutes {
  constructor(purchaseUsecase) {
    this.purchaseUsecase = purchaseUsecase;
    this.init();
  }

  init() {
    // Define tax object schema
    const taxItemSchema = Joi.object({
      PERC: Joi.number().required(),
      TAXABLE: Joi.number().required(),
      VALUE: Joi.number().required(),
    });

    // Define purchase schema with tax arrays
    const purchaseSchema = Joi.object({
      retail_outlet_id: Joi.number().required(),
      supplier_id: Joi.string().max(20).required(),
      supplier_name: Joi.string().max(100).required(),
      supplier_gstn: Joi.string().max(20).required(),
      mmh_mrc_no: Joi.number().required(),
      mmh_mrc_dt: Joi.date().required(),
      mmh_mrc_amt: Joi.number().precision(2).required(),
      mmh_dist_bill_dt: Joi.date().required(),
      mmh_dist_bill_no: Joi.string().max(50).required(),
      mmh_mrc_refno: Joi.string().max(20).required(),
      mmh_manual_disc: Joi.number().precision(2).required(),
      tot_sgst_amt: Joi.number().precision(2).required(),
      tot_cgst_amt: Joi.number().precision(2).required(),
      tot_igst_amt: Joi.number().precision(2).required(),
      tot_gst_cess_amt: Joi.number().precision(2).required(),
      mmd_goods_tcs_amt: Joi.number().precision(2).required(),
      ts: Joi.number().required(),
      sgst: Joi.array().items(taxItemSchema).required(),
      cgst: Joi.array().items(taxItemSchema).required(),
      igst: Joi.array().items(taxItemSchema).required(),
      cess: Joi.array().items(taxItemSchema).required(),
    });

    // Define bulk purchase schema with uppercase keys
    const bulkPurchaseSchema = Joi.array().items(
      Joi.object({
        STORE_ID: Joi.number().required(),
        SUPPLIER_ID: Joi.string().max(20).required(),
        SUPPLIER_NAME: Joi.string().max(100).required(),
        SUPPLIER_GSTN: Joi.string().max(20).required(),
        MRC_NO: Joi.number().required(),
        MRC_DATE: Joi.date().required(),
        MRC_AMT: Joi.number().precision(2).required(),
        DIST_BILL_DT: Joi.date().required(),
        DIST_BILL_NO: Joi.string().max(50).required(),
        MRC_REF: Joi.string().max(20).required(),
        MANUAL_DISC: Joi.number().precision(2).required(),
        TOT_SGST_AMT: Joi.number().precision(2).required(),
        TOT_CGST_AMT: Joi.number().precision(2).required(),
        TOT_IGST_AMT: Joi.number().precision(2).required(),
        TOT_GST_CESS_AMT: Joi.number().precision(2).required(),
        GOODS_TCS_AMT: Joi.number().precision(2).required(),
        TOT_PUR_TAX_AMT: Joi.number().precision(2).required(), // have to add to db
        TS: Joi.number().required(),
        SGST: Joi.array().items(taxItemSchema).required(),
        CGST: Joi.array().items(taxItemSchema).required(),
        IGST: Joi.array().items(taxItemSchema).required(),
        CESS: Joi.array().items(taxItemSchema).required(),
      })
    );

    // Schema for purchase_internal
    const internalSchema = Joi.object({
      cash_discount: Joi.number().precision(2).default(0.0),
      scheme_difference: Joi.number().precision(2).default(0.0),
      cost_difference: Joi.number().precision(2).default(0.0),
      due: Joi.number().precision(2).default(0.0),
      freight_charges: Joi.number().precision(2).default(0.0),
      round_off: Joi.number().precision(2).default(0.0),
      jv_ledger: Joi.number().precision(2).default(0.0),
      narration: Joi.string().allow("").optional(),
      supplier_credit_note: Joi.number().precision(2).default(0.0),
      total_amount: Joi.number().precision(2).default(0.0),
      invoice_amount: Joi.number().precision(2).default(0.0),
    });

    // Bulk create purchases
    router.post("/bulk", async (req, res) => {
      try {
        const { error, value } = bulkPurchaseSchema.validate(req.body);
        if (error) {
          return res.json({ code: 422, msg: error.toString() });
        }

        const result = await this.purchaseUsecase.bulkCreatePurchase(value);
        res.json(result);
      } catch (err) {
        console.log(err);
        res.json({ code: 500, msg: err.message });
      }
    });

    // Create purchase (keep lowercase schema for single create)
    router.post("/", async (req, res) => {
      try {
        const { error, value } = purchaseSchema.validate(req.body);
        if (error) {
          return res.json({ code: 422, msg: error.toString() });
        }

        const result = await this.purchaseUsecase.createPurchase(value);
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

        const result = await this.purchaseUsecase.updatePurchaseFlags(
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

        // Validate purchase
        const { error: purchaseError } = purchaseSchema.validate(
          req.body.purchase
        );
        if (purchaseError) {
          return res.json({
            code: 422,
            msg: purchaseError.toString(),
            tag: "PURCHASE-ERROR",
          });
        }

        // Validate purchase_internal
        const { error: internalError } = internalSchema.validate(
          req.body.purchase_internal
        );
        if (internalError) {
          return res.json({
            code: 422,
            msg: internalError.toString(),
            tag: "PURCHASE-INTERNAL-ERROR",
          });
        }

        const purchase = { ...req.body.purchase, purchase_id: req.params.id };
        const purchase_internal = req.body.purchase_internal;
        const send_not_matched_notification =
          req.body.send_not_matched_notification ?? false;

        const result = await this.purchaseUsecase.updatePurchaseWithInternal(
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

    // Delete purchase
    router.delete("/:id", async (req, res) => {
      try {
        const schema = Joi.object({
          id: Joi.number().required(),
        });

        const { error } = schema.validate({ id: parseInt(req.params.id) });
        if (error) {
          return res.json({ code: 422, msg: error.toString() });
        }

        const result = await this.purchaseUsecase.deletePurchase(req.params.id);
        res.json(result);
      } catch (err) {
        console.log(err);
        res.json({ code: 500, msg: err.message });
      }
    });

    // Get all purchases
    router.get("/", async (req, res) => {
      try {
        const schema = Joi.object({
          retail_outlet_id: Joi.number(),
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

        const result = await this.purchaseUsecase.getAllPurchases(value);
        res.json(result);
      } catch (err) {
        console.log(err);
        res.json({ code: 500, msg: err.message });
      }
    });

    // Get purchase by ID
    router.get("/:id", async (req, res) => {
      try {
        const schema = Joi.object({
          id: Joi.number().required(),
        });

        const { error } = schema.validate({ id: parseInt(req.params.id) });
        if (error) {
          return res.json({ code: 422, msg: error.toString() });
        }

        const result = await this.purchaseUsecase.getPurchaseById(
          req.params.id
        );
        res.json(result);
      } catch (err) {
        console.log(err);
        res.json({ code: 500, msg: err.message });
      }
    });

    router.delete("/delete-tally/:id", async (req, res) => {
      try {
        const schema = Joi.object({
          id: Joi.number().required(),
        });

        const { error } = schema.validate({ id: parseInt(req.params.id) });
        if (error) {
          return res.json({ code: 422, msg: error.toString() });
        }

        const result = await this.purchaseUsecase.deleteTallyResponse(
          req.params.id
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

module.exports = (purchaseUsecase) => {
  return new PurchaseRoutes(purchaseUsecase);
};
