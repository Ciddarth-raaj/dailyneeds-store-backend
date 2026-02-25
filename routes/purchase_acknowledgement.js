const router = require("express").Router();
const Joi = require("@hapi/joi");
const respondError = require("../utils/http");

class PurchaseAcknowledgementRoutes {
  constructor(purchaseAcknowledgementUsecase) {
    this.purchaseAcknowledgementUsecase = purchaseAcknowledgementUsecase;
    this.init();
  }

  init() {
    router.get("/", async (req, res) => {
      try {
        const list = await this.purchaseAcknowledgementUsecase.getAll();
        res.json({ code: 200, data: list });
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.get("/:purchase_acknowledgement_id", async (req, res) => {
      try {
        const id = parseInt(req.params.purchase_acknowledgement_id, 10);
        if (isNaN(id)) {
          res.status(400).json({ code: 400, msg: "Invalid purchase_acknowledgement_id" });
          res.end();
          return;
        }
        const row = await this.purchaseAcknowledgementUsecase.getById(id);
        if (!row) {
          res.status(404).json({ code: 404, msg: "Purchase acknowledgement not found" });
          res.end();
          return;
        }
        res.json({ code: 200, data: row });
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    const invoiceItemSchema = Joi.object({
      invoice_no: Joi.string().max(100).optional().allow(null, ""),
      invoice_date: Joi.date().required(),
      amount: Joi.number().min(0).optional().default(0)
    });

    const createSchema = Joi.object({
      distributor_id: Joi.string().required().max(50),
      invoices: Joi.array().items(invoiceItemSchema).min(1).required()
    });

    router.post("/", async (req, res) => {
      try {
        const isValid = Joi.validate(req.body, createSchema);
        if (isValid.error) {
          res.status(400).json({ code: 400, msg: isValid.error.message });
          res.end();
          return;
        }
        const created_by = req.decoded && req.decoded.employee_id ? req.decoded.employee_id : null;
        const result = await this.purchaseAcknowledgementUsecase.create({ ...req.body, created_by });
        res.json(result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    const updateSchema = Joi.object({
      distributor_id: Joi.string().max(50).optional(),
      invoices: Joi.array().items(invoiceItemSchema).min(1).optional()
    });

    router.put("/:purchase_acknowledgement_id", async (req, res) => {
      try {
        const isValid = Joi.validate(req.body, updateSchema);
        if (isValid.error) {
          res.status(400).json({ code: 400, msg: isValid.error.message });
          res.end();
          return;
        }
        const id = parseInt(req.params.purchase_acknowledgement_id, 10);
        if (isNaN(id)) {
          res.status(400).json({ code: 400, msg: "Invalid purchase_acknowledgement_id" });
          res.end();
          return;
        }
        const result = await this.purchaseAcknowledgementUsecase.update(id, req.body);
        res.json(result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.delete("/:purchase_acknowledgement_id", async (req, res) => {
      try {
        const id = parseInt(req.params.purchase_acknowledgement_id, 10);
        if (isNaN(id)) {
          res.status(400).json({ code: 400, msg: "Invalid purchase_acknowledgement_id" });
          res.end();
          return;
        }
        const result = await this.purchaseAcknowledgementUsecase.delete(id);
        res.json(result);
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

module.exports = (purchaseAcknowledgementUsecase) => {
  return new PurchaseAcknowledgementRoutes(purchaseAcknowledgementUsecase);
};
