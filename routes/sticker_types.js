const router = require("express").Router();
const Joi = require("@hapi/joi");

class StickerTypesRoutes {
  constructor(stickerTypesUsecase) {
    this.stickerTypesUsecase = stickerTypesUsecase;
    this.init();
  }

  init() {
    const createSchema = Joi.object({
      label: Joi.string().max(255).required(),
    });

    const updateSchema = Joi.object({
      label: Joi.string().max(255).required(),
    });

    // Create
    router.post("/", async (req, res) => {
      try {
        const { error, value } = createSchema.validate(req.body);
        if (error) {
          return res.json({ code: 422, msg: error.toString() });
        }
        const result = await this.stickerTypesUsecase.create(value);
        res.json(result);
      } catch (err) {
        console.log(err);
        res.json({ code: 500, msg: err.message });
      }
    });

    // Get all
    router.get("/", async (req, res) => {
      try {
        const filters = {
          label: req.query.label,
          limit: req.query.limit ? parseInt(req.query.limit) : undefined,
          offset: req.query.offset ? parseInt(req.query.offset) : undefined,
        };
        const result = await this.stickerTypesUsecase.getAll(filters);
        res.json({ code: 200, data: result });
      } catch (err) {
        console.log(err);
        res.json({ code: 500, msg: err.message });
      }
    });

    // Get by ID
    router.get("/:id", async (req, res) => {
      try {
        const id = parseInt(req.params.id);
        if (isNaN(id)) {
          return res.json({ code: 400, msg: "Invalid sticker ID" });
        }
        const result = await this.stickerTypesUsecase.getById(id);
        if (!result) {
          return res.json({ code: 404, msg: "Sticker type not found" });
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
          return res.json({ code: 400, msg: "Invalid sticker ID" });
        }
        const { error, value } = updateSchema.validate(req.body);
        if (error) {
          return res.json({ code: 422, msg: error.toString() });
        }
        const result = await this.stickerTypesUsecase.update(id, value);
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
          return res.json({ code: 400, msg: "Invalid sticker ID" });
        }
        const result = await this.stickerTypesUsecase.delete(id);
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

module.exports = (stickerTypesUsecase) => {
  return new StickerTypesRoutes(stickerTypesUsecase);
};
