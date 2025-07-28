const router = require("express").Router();
const Joi = require("@hapi/joi");

class PurchaseOrderRoutes {
  constructor(purchaseOrderUsecase) {
    this.purchaseOrderUsecase = purchaseOrderUsecase;
    this.init();
  }

  init() {
    // Purchase Order Item Schema
    const purchaseOrderItemSchema = Joi.object({
      material_id: Joi.number().required(),
      quantity: Joi.number().integer().min(1).required(),
      rate: Joi.number().precision(2).min(0).required(),
    });

    // Purchase Order Schema
    const purchaseOrderSchema = Joi.object({
      purchase_order_ref: Joi.string().max(255).optional(),
      date: Joi.date().optional(),
      delivery_date: Joi.date().optional(),
      discount: Joi.number().precision(2).min(0).default(0.0),
      adjustment: Joi.number().precision(2).min(0).default(0.0),
      status: Joi.string()
        .valid("active", "inactive", "completed", "cancelled")
        .default("active"),
      items: Joi.array().items(purchaseOrderItemSchema).optional(),
    });

    // Purchase Order Update Schema
    const purchaseOrderUpdateSchema = Joi.object({
      purchase_order_ref: Joi.string().max(255).optional(),
      date: Joi.date().optional(),
      delivery_date: Joi.date().optional(),
      discount: Joi.number().precision(2).min(0).optional(),
      adjustment: Joi.number().precision(2).min(0).optional(),
      status: Joi.string()
        .valid("active", "inactive", "completed", "cancelled")
        .optional(),
      items: Joi.array().items(purchaseOrderItemSchema).optional(),
    });

    // Purchase Order Item Update Schema
    const purchaseOrderItemUpdateSchema = Joi.object({
      material_id: Joi.number().required(),
      quantity: Joi.number().integer().min(1).required(),
      rate: Joi.number().precision(2).min(0).required(),
    });

    // Create purchase order
    router.post("/", async (req, res) => {
      try {
        const { error, value } = purchaseOrderSchema.validate(req.body);
        if (error) {
          return res.json({ code: 422, msg: error.toString() });
        }

        const result = await this.purchaseOrderUsecase.createPurchaseOrder(
          value
        );
        res.json(result);
      } catch (err) {
        console.log(err);
        res.json({ code: 500, msg: err.message });
      }
    });

    // Create purchase order with items
    router.post("/with-items", async (req, res) => {
      try {
        const { error, value } = purchaseOrderSchema.validate(req.body);
        if (error) {
          return res.json({ code: 422, msg: error.toString() });
        }

        const result =
          await this.purchaseOrderUsecase.createPurchaseOrderWithItems(value);
        res.json(result);
      } catch (err) {
        console.log(err);
        res.json({ code: 500, msg: err.message });
      }
    });

    // Get all purchase orders
    router.get("/", async (req, res) => {
      try {
        const filters = {
          status: req.query.status,
          date_from: req.query.date_from,
          date_to: req.query.date_to,
          purchase_order_ref: req.query.purchase_order_ref,
          limit: req.query.limit ? parseInt(req.query.limit) : undefined,
          offset: req.query.offset ? parseInt(req.query.offset) : undefined,
        };

        const result = await this.purchaseOrderUsecase.getAllPurchaseOrders(
          filters
        );
        res.json({ code: 200, data: result });
      } catch (err) {
        console.log(err);
        res.json({ code: 500, msg: err.message });
      }
    });

    // Get purchase order by ID
    router.get("/:id", async (req, res) => {
      try {
        const purchaseOrderId = parseInt(req.params.id);
        if (isNaN(purchaseOrderId)) {
          return res.json({ code: 400, msg: "Invalid purchase order ID" });
        }

        const result = await this.purchaseOrderUsecase.getPurchaseOrderById(
          purchaseOrderId
        );
        if (!result) {
          return res.json({ code: 404, msg: "Purchase order not found" });
        }

        res.json({ code: 200, data: result });
      } catch (err) {
        console.log(err);
        res.json({ code: 500, msg: err.message });
      }
    });

    // Get purchase order with items
    router.get("/:id/with-items", async (req, res) => {
      try {
        const purchaseOrderId = parseInt(req.params.id);
        if (isNaN(purchaseOrderId)) {
          return res.json({ code: 400, msg: "Invalid purchase order ID" });
        }

        const result =
          await this.purchaseOrderUsecase.getPurchaseOrderWithItems(
            purchaseOrderId
          );
        if (!result) {
          return res.json({ code: 404, msg: "Purchase order not found" });
        }

        res.json({ code: 200, data: result });
      } catch (err) {
        console.log(err);
        res.json({ code: 500, msg: err.message });
      }
    });

    // Update purchase order
    router.put("/:id", async (req, res) => {
      try {
        const purchaseOrderId = parseInt(req.params.id);
        if (isNaN(purchaseOrderId)) {
          return res.json({ code: 400, msg: "Invalid purchase order ID" });
        }

        const { error, value } = purchaseOrderUpdateSchema.validate(req.body);
        if (error) {
          return res.json({ code: 422, msg: error.toString() });
        }

        const result = await this.purchaseOrderUsecase.updatePurchaseOrder(
          purchaseOrderId,
          value
        );
        res.json(result);
      } catch (err) {
        console.log(err);
        res.json({ code: 500, msg: err.message });
      }
    });

    // Update purchase order with items
    router.put("/:id/with-items", async (req, res) => {
      try {
        const purchaseOrderId = parseInt(req.params.id);
        if (isNaN(purchaseOrderId)) {
          return res.json({ code: 400, msg: "Invalid purchase order ID" });
        }

        const { error, value } = purchaseOrderUpdateSchema.validate(req.body);
        if (error) {
          return res.json({ code: 422, msg: error.toString() });
        }

        const result =
          await this.purchaseOrderUsecase.updatePurchaseOrderWithItems(
            purchaseOrderId,
            value
          );
        res.json(result);
      } catch (err) {
        console.log(err);
        res.json({ code: 500, msg: err.message });
      }
    });

    // Delete purchase order
    router.delete("/:id", async (req, res) => {
      try {
        const purchaseOrderId = parseInt(req.params.id);
        if (isNaN(purchaseOrderId)) {
          return res.json({ code: 400, msg: "Invalid purchase order ID" });
        }

        const result = await this.purchaseOrderUsecase.deletePurchaseOrder(
          purchaseOrderId
        );
        res.json(result);
      } catch (err) {
        console.log(err);
        res.json({ code: 500, msg: err.message });
      }
    });

    // Get purchase order items
    router.get("/:id/items", async (req, res) => {
      try {
        const purchaseOrderId = parseInt(req.params.id);
        if (isNaN(purchaseOrderId)) {
          return res.json({ code: 400, msg: "Invalid purchase order ID" });
        }

        const result = await this.purchaseOrderUsecase.getPurchaseOrderItems(
          purchaseOrderId
        );
        res.json({ code: 200, data: result });
      } catch (err) {
        console.log(err);
        res.json({ code: 500, msg: err.message });
      }
    });

    // Create purchase order item
    router.post("/:id/items", async (req, res) => {
      try {
        const purchaseOrderId = parseInt(req.params.id);
        if (isNaN(purchaseOrderId)) {
          return res.json({ code: 400, msg: "Invalid purchase order ID" });
        }

        const { error, value } = purchaseOrderItemSchema.validate(req.body);
        if (error) {
          return res.json({ code: 422, msg: error.toString() });
        }

        const purchaseOrderItem = {
          ...value,
          purchase_order_id: purchaseOrderId,
        };

        const result = await this.purchaseOrderUsecase.createPurchaseOrderItem(
          purchaseOrderItem
        );
        res.json(result);
      } catch (err) {
        console.log(err);
        res.json({ code: 500, msg: err.message });
      }
    });

    // Update purchase order item
    router.put("/:id/items/:itemId", async (req, res) => {
      try {
        const purchaseOrderId = parseInt(req.params.id);
        const itemId = parseInt(req.params.itemId);

        if (isNaN(purchaseOrderId) || isNaN(itemId)) {
          return res.json({ code: 400, msg: "Invalid ID" });
        }

        const { error, value } = purchaseOrderItemUpdateSchema.validate(
          req.body
        );
        if (error) {
          return res.json({ code: 422, msg: error.toString() });
        }

        const result = await this.purchaseOrderUsecase.updatePurchaseOrderItem(
          itemId,
          value
        );
        res.json(result);
      } catch (err) {
        console.log(err);
        res.json({ code: 500, msg: err.message });
      }
    });

    // Delete purchase order item
    router.delete("/:id/items/:itemId", async (req, res) => {
      try {
        const purchaseOrderId = parseInt(req.params.id);
        const itemId = parseInt(req.params.itemId);

        if (isNaN(purchaseOrderId) || isNaN(itemId)) {
          return res.json({ code: 400, msg: "Invalid ID" });
        }

        const result = await this.purchaseOrderUsecase.deletePurchaseOrderItem(
          itemId
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

module.exports = (purchaseOrderUsecase) => {
  return new PurchaseOrderRoutes(purchaseOrderUsecase);
};
