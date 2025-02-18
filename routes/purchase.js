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
      perc: Joi.number().required(),
      value: Joi.number().required(),
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

    // Bulk create purchases
    router.post("/bulk", async (req, res) => {
      try {
        const schema = Joi.array().items(purchaseSchema);

        const { error, value } = schema.validate(req.body);
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

    // Create purchase
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

    // Update purchase
    router.put("/:id", async (req, res) => {
      try {
        const schema = Joi.object({
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

        const purchase = { ...req.body, purchase_id: req.params.id };
        const { error, value } = schema.validate(req.body);
        if (error) {
          return res.json({ code: 422, msg: error.toString() });
        }

        const result = await this.purchaseUsecase.updatePurchase(purchase);
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
  }

  getRouter() {
    return router;
  }
}

module.exports = (purchaseUsecase) => {
  return new PurchaseRoutes(purchaseUsecase);
};
