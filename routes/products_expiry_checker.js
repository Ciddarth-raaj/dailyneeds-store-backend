const router = require("express").Router();
const Joi = require("@hapi/joi");
const respondError = require("../utils/http");

class ProductsExpiryCheckerRoutes {
  constructor(productsExpiryCheckerUsecase) {
    this.productsExpiryCheckerUsecase = productsExpiryCheckerUsecase;
    this.init();
  }

  init() {
    router.get("/", async (req, res) => {
      try {
        const list = await this.productsExpiryCheckerUsecase.getAll();
        res.json({ code: 200, data: list });
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.get("/:products_expiry_checker_id", async (req, res) => {
      try {
        const id = parseInt(req.params.products_expiry_checker_id, 10);
        if (isNaN(id)) {
          res.status(400).json({ code: 400, msg: "Invalid products_expiry_checker_id" });
          res.end();
          return;
        }
        const row = await this.productsExpiryCheckerUsecase.getById(id);
        if (!row) {
          res.status(404).json({ code: 404, msg: "Products expiry checker not found" });
          res.end();
          return;
        }
        res.json({ code: 200, data: row });
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    // Items upsert (and insert separately) - must be before /:id to avoid "items" as id
    const itemUpsertSchema = Joi.object({
      products_expiry_checker_id: Joi.number().integer().required(),
      branch_id: Joi.number().integer().required(),
      qty: Joi.number().required(),
      is_verified: Joi.boolean().optional().default(false)
    });

    router.post("/items", async (req, res) => {
      try {
        const isValid = Joi.validate(req.body, itemUpsertSchema);
        if (isValid.error) {
          res.status(400).json({ code: 400, msg: isValid.error.message });
          res.end();
          return;
        }
        const created_by =
          req.decoded && req.decoded.employee_id ? req.decoded.employee_id : null;
        const result = await this.productsExpiryCheckerUsecase.upsertItem({
          ...req.body,
          created_by
        });
        res.json(result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    const createSchema = Joi.object({
      product_id: Joi.number().integer().required(),
      expiry_date: Joi.date().required(),
      ref_file: Joi.string().optional().allow("", null),
      items: Joi.array()
        .items(
          Joi.object({
            branch_id: Joi.number().integer().required(),
            qty: Joi.number().required(),
            is_verified: Joi.boolean().optional().default(false)
          })
        )
        .optional()
    });

    router.post("/", async (req, res) => {
      try {
        const isValid = Joi.validate(req.body, createSchema);
        if (isValid.error) {
          res.status(400).json({ code: 400, msg: isValid.error.message });
          res.end();
          return;
        }
        const result = await this.productsExpiryCheckerUsecase.create(req.body);
        res.json(result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    const updateSchema = Joi.object({
      product_id: Joi.number().integer().optional(),
      expiry_date: Joi.date().optional(),
      ref_file: Joi.string().optional().allow("", null)
    });

    router.put("/:products_expiry_checker_id", async (req, res) => {
      try {
        const isValid = Joi.validate(req.body, updateSchema);
        if (isValid.error) {
          res.status(400).json({ code: 400, msg: isValid.error.message });
          res.end();
          return;
        }
        const id = parseInt(req.params.products_expiry_checker_id, 10);
        if (isNaN(id)) {
          res.status(400).json({ code: 400, msg: "Invalid products_expiry_checker_id" });
          res.end();
          return;
        }
        const result = await this.productsExpiryCheckerUsecase.update(id, req.body);
        res.json(result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.delete("/:products_expiry_checker_id", async (req, res) => {
      try {
        const id = parseInt(req.params.products_expiry_checker_id, 10);
        if (isNaN(id)) {
          res.status(400).json({ code: 400, msg: "Invalid products_expiry_checker_id" });
          res.end();
          return;
        }
        const result = await this.productsExpiryCheckerUsecase.delete(id);
        res.json(result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.delete("/:products_expiry_checker_id/items/:branch_id", async (req, res) => {
      try {
        const products_expiry_checker_id = parseInt(
          req.params.products_expiry_checker_id,
          10
        );
        const branch_id = parseInt(req.params.branch_id, 10);
        if (isNaN(products_expiry_checker_id) || isNaN(branch_id)) {
          res.status(400).json({
            code: 400,
            msg: "Invalid products_expiry_checker_id or branch_id"
          });
          res.end();
          return;
        }
        const result = await this.productsExpiryCheckerUsecase.deleteItem(
          products_expiry_checker_id,
          branch_id
        );
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

module.exports = (productsExpiryCheckerUsecase) => {
  return new ProductsExpiryCheckerRoutes(productsExpiryCheckerUsecase);
};
