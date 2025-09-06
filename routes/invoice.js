const router = require("express").Router();
const Joi = require("@hapi/joi");
const respondError = require("../utils/http");

class InvoiceRoutes {
  constructor(invoiceUsecase) {
    this.invoiceUsecase = invoiceUsecase;
    this.init();
  }

  init() {
    // Create invoice with items in a single call
    router.post("/create", async (req, res) => {
      try {
        const schema = {
          invoice_id: Joi.string().min(1).optional(),
          invoice_items: Joi.array()
            .items(
              Joi.object({
                product_id: Joi.number().required(),
                quantity: Joi.number().min(0).optional(),
                cost: Joi.number().min(0).optional(),
                discount: Joi.number().min(0).optional(),
                tax: Joi.number().min(0).optional(),
                tax_amount: Joi.number().min(0).optional(),
                markup_percentage: Joi.number().min(0).optional(),
                final_selling_price: Joi.number().min(0).optional(),
                puom: Joi.string().optional(),
                suom: Joi.string().optional(),
              })
            )
            .min(1)
            .required(),
        };

        const invoiceData = req.body;
        const isValid = Joi.validate(invoiceData, schema);
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const response = await this.invoiceUsecase.createInvoiceWithItems(
          invoiceData
        );
        res.json(response);
      } catch (err) {
        if (err.name === "ValidationError") {
          res.json({ code: 422, msg: err.toString() });
        } else {
          console.log(err);
          res.json({ code: 500, msg: err.message });
        }
      }
      res.end();
    });

    // Get invoice with items by ID
    router.get("/:invoiceId", async (req, res) => {
      try {
        const schema = {
          invoiceId: Joi.string().required(),
        };

        const data = req.params;
        const isValid = Joi.validate(data, schema);
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const response = await this.invoiceUsecase.getInvoiceWithItems(
          data.invoiceId
        );
        res.json(response);
      } catch (err) {
        if (err.name === "ValidationError") {
          res.json({ code: 422, msg: err.toString() });
        } else {
          console.log(err);
          res.json({ code: 500, msg: err.message });
        }
      }
      res.end();
    });

    // Get all invoices with pagination
    router.get("/", async (req, res) => {
      try {
        const schema = {
          limit: Joi.number().min(1).optional(),
          offset: Joi.number().min(0).optional(),
        };

        const data = req.query;
        const isValid = Joi.validate(data, schema);
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const response = await this.invoiceUsecase.getAllInvoices(
          data.limit,
          data.offset
        );
        res.json(response);
      } catch (err) {
        if (err.name === "ValidationError") {
          res.json({ code: 422, msg: err.toString() });
        } else {
          console.log(err);
          res.json({ code: 500, msg: err.message });
        }
      }
      res.end();
    });

    // Get invoice count
    router.get("/count/total", async (req, res) => {
      try {
        const response = await this.invoiceUsecase.getInvoiceCount();
        res.json(response);
      } catch (err) {
        console.log(err);
        res.json({ code: 500, msg: err.message });
      }
      res.end();
    });

    // Update invoice with items
    router.put("/:invoiceId/with-items", async (req, res) => {
      try {
        const schema = {
          invoiceId: Joi.string().required(),
        };

        const itemSchema = {
          invoice_item_id: Joi.number().optional().allow(null),
          product_id: Joi.number().required(),
          quantity: Joi.number().min(0).optional(),
          cost: Joi.number().min(0).optional(),
          discount: Joi.number().min(0).optional(),
          tax: Joi.number().min(0).optional(),
          tax_amount: Joi.number().min(0).optional(),
          markup_percentage: Joi.number().min(0).optional(),
          final_selling_price: Joi.number().min(0).optional(),
          puom: Joi.string().optional(),
          suom: Joi.string().optional(),
        };

        const data = req.params;
        const isValid = Joi.validate(data, schema);
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const invoiceData = req.body;

        // Validate invoice items if provided
        if (
          invoiceData.invoice_items &&
          Array.isArray(invoiceData.invoice_items)
        ) {
          for (const item of invoiceData.invoice_items) {
            const isItemValid = Joi.validate(item, itemSchema);
            if (isItemValid.error !== null) {
              throw isItemValid.error;
            }
          }
        }

        const response = await this.invoiceUsecase.updateInvoiceWithItems(
          data.invoiceId,
          invoiceData
        );
        res.json(response);
      } catch (err) {
        if (err.name === "ValidationError") {
          res.json({ code: 422, msg: err.toString() });
        } else {
          console.log(err);
          res.json({ code: 500, msg: err.message });
        }
      }
      res.end();
    });

    // Update invoice
    router.put("/:invoiceId", async (req, res) => {
      try {
        const schema = {
          invoiceId: Joi.string().required(),
        };

        const data = req.params;
        const isValid = Joi.validate(data, schema);
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const response = await this.invoiceUsecase.updateInvoice(
          data.invoiceId,
          req.body
        );
        res.json(response);
      } catch (err) {
        if (err.name === "ValidationError") {
          res.json({ code: 422, msg: err.toString() });
        } else {
          console.log(err);
          res.json({ code: 500, msg: err.message });
        }
      }
      res.end();
    });

    // Update invoice item
    router.put("/item/:invoiceItemId", async (req, res) => {
      try {
        const schema = {
          invoiceItemId: Joi.number().required(),
        };

        const itemSchema = {
          product_id: Joi.number().required(),
          quantity: Joi.number().min(0).optional(),
          cost: Joi.number().min(0).optional(),
          discount: Joi.number().min(0).optional(),
          tax: Joi.number().min(0).optional(),
          tax_amount: Joi.number().min(0).optional(),
          markup_percentage: Joi.number().min(0).optional(),
          final_selling_price: Joi.number().min(0).optional(),
          puom: Joi.string().optional(),
          suom: Joi.string().optional(),
        };

        const data = req.params;
        const isValid = Joi.validate(data, schema);
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const itemData = req.body;
        const isItemValid = Joi.validate(itemData, itemSchema);
        if (isItemValid.error !== null) {
          throw isItemValid.error;
        }

        const response = await this.invoiceUsecase.updateInvoiceItem(
          data.invoiceItemId,
          itemData
        );
        res.json(response);
      } catch (err) {
        if (err.name === "ValidationError") {
          res.json({ code: 422, msg: err.toString() });
        } else {
          console.log(err);
          res.json({ code: 500, msg: err.message });
        }
      }
      res.end();
    });

    // Add invoice item to existing invoice
    router.post("/:invoiceId/items", async (req, res) => {
      try {
        const schema = {
          invoiceId: Joi.string().required(),
        };

        const itemSchema = {
          product_id: Joi.number().required(),
          quantity: Joi.number().min(0).optional(),
          cost: Joi.number().min(0).optional(),
          discount: Joi.number().min(0).optional(),
          tax: Joi.number().min(0).optional(),
          tax_amount: Joi.number().min(0).optional(),
          markup_percentage: Joi.number().min(0).optional(),
          final_selling_price: Joi.number().min(0).optional(),
          puom: Joi.string().optional(),
          suom: Joi.string().optional(),
        };

        const data = req.params;
        const isValid = Joi.validate(data, schema);
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const itemData = req.body;
        const isItemValid = Joi.validate(itemData, itemSchema);
        if (isItemValid.error !== null) {
          throw isItemValid.error;
        }

        const response = await this.invoiceUsecase.addInvoiceItem(
          data.invoiceId,
          itemData
        );
        res.json(response);
      } catch (err) {
        if (err.name === "ValidationError") {
          res.json({ code: 422, msg: err.toString() });
        } else {
          console.log(err);
          res.json({ code: 500, msg: err.message });
        }
      }
      res.end();
    });

    // Delete invoice
    router.delete("/:invoiceId", async (req, res) => {
      try {
        const schema = {
          invoiceId: Joi.string().required(),
        };

        const data = req.params;
        const isValid = Joi.validate(data, schema);
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const response = await this.invoiceUsecase.deleteInvoice(
          data.invoiceId
        );
        res.json(response);
      } catch (err) {
        if (err.name === "ValidationError") {
          res.json({ code: 422, msg: err.toString() });
        } else {
          console.log(err);
          res.json({ code: 500, msg: err.message });
        }
      }
      res.end();
    });

    // Delete invoice item
    router.delete("/item/:invoiceItemId", async (req, res) => {
      try {
        const schema = {
          invoiceItemId: Joi.number().required(),
        };

        const data = req.params;
        const isValid = Joi.validate(data, schema);
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const response = await this.invoiceUsecase.deleteInvoiceItem(
          data.invoiceItemId
        );
        res.json(response);
      } catch (err) {
        if (err.name === "ValidationError") {
          res.json({ code: 422, msg: err.toString() });
        } else {
          console.log(err);
          res.json({ code: 500, msg: err.message });
        }
      }
      res.end();
    });
  }

  getRouter() {
    return router;
  }
}

module.exports = (invoiceUsecase) => {
  return new InvoiceRoutes(invoiceUsecase);
};
