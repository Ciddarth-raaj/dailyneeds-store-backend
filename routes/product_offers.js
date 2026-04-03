const router = require("express").Router();
const Joi = require("@hapi/joi");
const respondError = require("../utils/http");

const itemSchema = Joi.object({
  product_id: Joi.number().integer().required(),
  mrp: Joi.number().min(0).allow(null).optional(),
  selling_price: Joi.number().min(0).allow(null).optional(),
  opening_stock: Joi.number().optional().default(0),
  is_active: Joi.boolean().optional().default(true),
});

class ProductOffersRoutes {
  constructor(productOffersUsecase) {
    this.productOffersUsecase = productOffersUsecase;
    this.init();
  }

  init() {
    router.get("/", async (req, res) => {
      try {
        const list = await this.productOffersUsecase.getAll();
        res.json({ code: 200, data: list });
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.get("/by-product/:product_id", async (req, res) => {
      try {
        const product_id = parseInt(req.params.product_id, 10);
        if (isNaN(product_id)) {
          res.status(400).json({ code: 400, msg: "Invalid product_id" });
          res.end();
          return;
        }
        const row = await this.productOffersUsecase.getByProductId(product_id);
        res.json({ code: 200, data: row });
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.get("/:product_id", async (req, res) => {
      try {
        const product_id = parseInt(req.params.product_id, 10);
        if (isNaN(product_id)) {
          res.status(400).json({ code: 400, msg: "Invalid product_id" });
          res.end();
          return;
        }
        const row = await this.productOffersUsecase.getByProductId(product_id);
        if (!row) {
          res.status(404).json({ code: 404, msg: "Offer not found" });
          res.end();
          return;
        }
        res.json({ code: 200, data: row });
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    const createSchema = itemSchema;

    router.post("/", async (req, res) => {
      try {
        const isValid = Joi.validate(req.body, createSchema);
        if (isValid.error) {
          res.status(400).json({ code: 400, msg: isValid.error.message });
          res.end();
          return;
        }
        const result = await this.productOffersUsecase.create(isValid.value);
        if (result.code === 400) {
          res.status(400).json(result);
          res.end();
          return;
        }
        res.json(result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    const bulkInsertSchema = Joi.array().items(itemSchema).min(1);

    router.post("/bulk", async (req, res) => {
      try {
        const isValid = Joi.validate(req.body, bulkInsertSchema);
        if (isValid.error) {
          res.status(400).json({ code: 400, msg: isValid.error.message });
          res.end();
          return;
        }
        const result = await this.productOffersUsecase.bulkInsert(isValid.value);
        res.json(result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    const updateSchema = Joi.object({
      mrp: Joi.number().min(0).allow(null).optional(),
      selling_price: Joi.number().min(0).allow(null).optional(),
      opening_stock: Joi.number().optional().allow(null),
      is_active: Joi.boolean().optional(),
    }).min(1);

    router.put("/:product_id", async (req, res) => {
      try {
        const isValid = Joi.validate(req.body, updateSchema);
        if (isValid.error) {
          res.status(400).json({ code: 400, msg: isValid.error.message });
          res.end();
          return;
        }
        const product_id = parseInt(req.params.product_id, 10);
        if (isNaN(product_id)) {
          res.status(400).json({ code: 400, msg: "Invalid product_id" });
          res.end();
          return;
        }
        const result = await this.productOffersUsecase.update(product_id, isValid.value);
        res.json(result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    const bulkDeleteSchema = Joi.object({
      product_ids: Joi.array().items(Joi.number().integer()).min(1).required(),
    });

    router.delete("/bulk", async (req, res) => {
      try {
        const isValid = Joi.validate(req.body, bulkDeleteSchema);
        if (isValid.error) {
          res.status(400).json({ code: 400, msg: isValid.error.message });
          res.end();
          return;
        }
        const result = await this.productOffersUsecase.bulkDelete(req.body.product_ids);
        res.json(result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.delete("/:product_id", async (req, res) => {
      try {
        const product_id = parseInt(req.params.product_id, 10);
        if (isNaN(product_id)) {
          res.status(400).json({ code: 400, msg: "Invalid product_id" });
          res.end();
          return;
        }
        const result = await this.productOffersUsecase.delete(product_id);
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

module.exports = (productOffersUsecase) => {
  return new ProductOffersRoutes(productOffersUsecase);
};
