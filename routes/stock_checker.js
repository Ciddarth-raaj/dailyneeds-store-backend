const router = require("express").Router();
const Joi = require("@hapi/joi");
const respondError = require("../utils/http");

class StockCheckerRoutes {
  constructor(stockCheckerUsecase) {
    this.stockCheckerUsecase = stockCheckerUsecase;
    this.init();
  }

  init() {
    router.get("/", async (req, res) => {
      try {
        const list = await this.stockCheckerUsecase.getAll();
        res.json({ code: 200, data: list });
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.get("/:stock_checker_id", async (req, res) => {
      try {
        const id = parseInt(req.params.stock_checker_id, 10);
        if (isNaN(id)) {
          res.status(400).json({ code: 400, msg: "Invalid stock_checker_id" });
          res.end();
          return;
        }
        const row = await this.stockCheckerUsecase.getById(id);
        if (!row) {
          res.status(404).json({ code: 404, msg: "Stock checker not found" });
          res.end();
          return;
        }
        res.json({ code: 200, data: row });
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    // --- stock_checker_items: single endpoint for create/update (ON DUPLICATE KEY) - must be before /:stock_checker_id ---
    const itemUpsertSchema = Joi.object({
      stock_checker_id: Joi.number().integer().required(),
      branch_id: Joi.number().integer().required(),
      physical_stock: Joi.number().required(),
      system_stock: Joi.number().required(),
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
        const result = await this.stockCheckerUsecase.upsertItem({
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
      product_id: Joi.number().integer().required()
    });

    router.post("/", async (req, res) => {
      try {
        const isValid = Joi.validate(req.body, createSchema);
        if (isValid.error) {
          res.status(400).json({ code: 400, msg: isValid.error.message });
          res.end();
          return;
        }
        const created_by =
          req.decoded && req.decoded.employee_id ? req.decoded.employee_id : null;
        const result = await this.stockCheckerUsecase.create({
          ...req.body,
          created_by
        });
        res.json(result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    const updateSchema = Joi.object({
      product_id: Joi.number().integer().optional()
    });

    router.put("/:stock_checker_id", async (req, res) => {
      try {
        const isValid = Joi.validate(req.body, updateSchema);
        if (isValid.error) {
          res.status(400).json({ code: 400, msg: isValid.error.message });
          res.end();
          return;
        }
        const id = parseInt(req.params.stock_checker_id, 10);
        if (isNaN(id)) {
          res.status(400).json({ code: 400, msg: "Invalid stock_checker_id" });
          res.end();
          return;
        }
        const result = await this.stockCheckerUsecase.update(id, req.body);
        res.json(result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.delete("/:stock_checker_id", async (req, res) => {
      try {
        const id = parseInt(req.params.stock_checker_id, 10);
        if (isNaN(id)) {
          res.status(400).json({ code: 400, msg: "Invalid stock_checker_id" });
          res.end();
          return;
        }
        const result = await this.stockCheckerUsecase.delete(id);
        res.json(result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.delete("/:stock_checker_id/items/:branch_id", async (req, res) => {
      try {
        const stock_checker_id = parseInt(req.params.stock_checker_id, 10);
        const branch_id = parseInt(req.params.branch_id, 10);
        if (isNaN(stock_checker_id) || isNaN(branch_id)) {
          res.status(400).json({
            code: 400,
            msg: "Invalid stock_checker_id or branch_id"
          });
          res.end();
          return;
        }
        const result = await this.stockCheckerUsecase.deleteItem(
          stock_checker_id,
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

module.exports = (stockCheckerUsecase) => {
  return new StockCheckerRoutes(stockCheckerUsecase);
};
