const router = require("express").Router();
const Joi = require("@hapi/joi");
const respondError = require("../utils/http");

class ProductsChangesRoutes {
  constructor(usecase) {
    this.usecase = usecase;
    this.init();
  }

  init() {
    router.get("/", async (req, res) => {
      try {
        const filters = {
          product_id: req.query.product_id != null && req.query.product_id !== "" ? req.query.product_id : undefined,
          is_approved: req.query.is_approved === "true" ? true : req.query.is_approved === "false" ? false : undefined,
          limit: req.query.limit != null ? parseInt(req.query.limit, 10) : undefined,
          offset: req.query.offset != null ? parseInt(req.query.offset, 10) : undefined
        };
        const data = await this.usecase.getAll(filters);
        res.json({ code: 200, data });
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.get("/:products_change_id", async (req, res) => {
      try {
        const id = parseInt(req.params.products_change_id, 10);
        if (Number.isNaN(id) || id < 1) {
          res.status(400).json({ code: 400, msg: "Invalid products_change_id" });
          res.end();
          return;
        }
        const row = await this.usecase.getById(id);
        if (!row) {
          res.status(404).json({ code: 404, msg: "Not found" });
          res.end();
          return;
        }
        res.json({ code: 200, data: row });
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    const approveSchema = Joi.object({
      is_approved: Joi.boolean().required()
    });

    router.put("/:products_change_id/approve", async (req, res) => {
      try {
        const id = parseInt(req.params.products_change_id, 10);
        if (Number.isNaN(id) || id < 1) {
          res.status(400).json({ code: 400, msg: "Invalid products_change_id" });
          res.end();
          return;
        }
        const validated = Joi.validate(req.body, approveSchema);
        if (validated.error) {
          res.status(400).json({ code: 400, msg: validated.error.message });
          res.end();
          return;
        }
        const data = await this.usecase.setApproval(id, validated.value.is_approved);
        res.json({ code: 200, data });
      } catch (err) {
        if (err.code === 404) {
          res.status(404).json({ code: 404, msg: "Not found" });
          res.end();
          return;
        }
        respondError(res, err);
      }
      res.end();
    });
  }

  getRouter() {
    return router;
  }
}

module.exports = (usecase) => {
  return new ProductsChangesRoutes(usecase);
};
