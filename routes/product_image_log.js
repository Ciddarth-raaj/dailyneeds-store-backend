const router = require("express").Router();
const Joi = require("@hapi/joi");

class ProductImageLogRoutes {
  constructor(productImageLogUsecase) {
    this.productImageLogUsecase = productImageLogUsecase;
    this.init();
  }

  init() {
    const createSchema = Joi.object({
      product_id: Joi.number().integer().min(1).required(),
      change_json: Joi.alternatives()
        .try(Joi.array(), Joi.string())
        .required(),
      created_by: Joi.number().integer().min(1).required(),
    });

    const updateSchema = Joi.object({
      product_id: Joi.number().integer().min(1).optional(),
      change_json: Joi.alternatives()
        .try(Joi.array(), Joi.string())
        .optional(),
      created_by: Joi.number().integer().min(1).optional(),
    });

    // Create
    router.post("/", async (req, res) => {
      try {
        const { error, value } = createSchema.validate(req.body);
        if (error) {
          return res.json({ code: 422, msg: error.toString() });
        }
        const result = await this.productImageLogUsecase.create(value);
        res.json(result);
      } catch (err) {
        console.log(err);
        res.json({ code: 500, msg: err.message });
      }
    });

    // Get all (with optional filters; joins product and created_by user)
    router.get("/", async (req, res) => {
      try {
        const filters = {
          product_id: req.query.product_id
            ? parseInt(req.query.product_id)
            : undefined,
          created_by: req.query.created_by
            ? parseInt(req.query.created_by, 10)
            : undefined,
          date_from: req.query.date_from,
          date_to: req.query.date_to,
          limit: req.query.limit ? parseInt(req.query.limit) : undefined,
          offset: req.query.offset ? parseInt(req.query.offset) : undefined,
        };
        const result = await this.productImageLogUsecase.getAll(filters);
        res.json({ code: 200, data: result });
      } catch (err) {
        console.log(err);
        res.json({ code: 500, msg: err.message });
      }
    });

    // Get by ID (with product and created_by joined)
    router.get("/:id", async (req, res) => {
      try {
        const id = parseInt(req.params.id);
        if (isNaN(id)) {
          return res.json({ code: 400, msg: "Invalid log ID" });
        }
        const result = await this.productImageLogUsecase.getById(id);
        if (!result) {
          return res.json({ code: 404, msg: "Product image log not found" });
        }
        res.json({ code: 200, data: result });
      } catch (err) {
        console.log(err);
        res.json({ code: 500, msg: err.message });
      }
    });

    // Update
    router.put("/:id", async (req, res) => {
      try {
        const id = parseInt(req.params.id);
        if (isNaN(id)) {
          return res.json({ code: 400, msg: "Invalid log ID" });
        }
        const { error, value } = updateSchema.validate(req.body);
        if (error) {
          return res.json({ code: 422, msg: error.toString() });
        }
        const result = await this.productImageLogUsecase.update(id, value);
        res.json(result);
      } catch (err) {
        console.log(err);
        res.json({ code: 500, msg: err.message });
      }
    });

    // Delete
    router.delete("/:id", async (req, res) => {
      try {
        const id = parseInt(req.params.id);
        if (isNaN(id)) {
          return res.json({ code: 400, msg: "Invalid log ID" });
        }
        const result = await this.productImageLogUsecase.delete(id);
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

module.exports = (productImageLogUsecase) => {
  return new ProductImageLogRoutes(productImageLogUsecase);
};
