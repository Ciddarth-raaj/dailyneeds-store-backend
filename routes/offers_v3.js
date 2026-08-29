const router = require("express").Router();
const Joi = require("@hapi/joi");
const respondError = require("../utils/http");

const OFFER_TYPES = ["percentage", "flat", "fixed_price"];

const itemSchema = Joi.object({
  item_code: Joi.string().trim().min(1).required(),
  item_name: Joi.string().trim().min(1).required(),
  offer_type: Joi.string().valid(...OFFER_TYPES).required(),
  value: Joi.number().min(0).required(),
  is_active: Joi.boolean().optional().default(true),
});

class OffersV3Routes {
  constructor(offersV3Usecase) {
    this.offersV3Usecase = offersV3Usecase;
    this.init();
  }

  init() {
    router.get("/", async (req, res) => {
      try {
        const list = await this.offersV3Usecase.getAll();
        res.json({ code: 200, data: list });
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.get("/:id", async (req, res) => {
      try {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) {
          res.status(400).json({ code: 400, msg: "Invalid id" });
          res.end();
          return;
        }
        const row = await this.offersV3Usecase.getById(id);
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

    router.post("/", async (req, res) => {
      try {
        const isValid = Joi.validate(req.body, itemSchema);
        if (isValid.error) {
          res.status(400).json({ code: 400, msg: isValid.error.message });
          res.end();
          return;
        }
        const result = await this.offersV3Usecase.create(isValid.value);
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
        const result = await this.offersV3Usecase.bulkInsert(isValid.value);
        res.json(result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    const updateSchema = Joi.object({
      item_code: Joi.string().trim().min(1).optional(),
      item_name: Joi.string().trim().min(1).optional(),
      offer_type: Joi.string().valid(...OFFER_TYPES).optional(),
      value: Joi.number().min(0).optional(),
      is_active: Joi.boolean().optional(),
    }).min(1);

    router.put("/:id", async (req, res) => {
      try {
        const isValid = Joi.validate(req.body, updateSchema);
        if (isValid.error) {
          res.status(400).json({ code: 400, msg: isValid.error.message });
          res.end();
          return;
        }
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) {
          res.status(400).json({ code: 400, msg: "Invalid id" });
          res.end();
          return;
        }
        const result = await this.offersV3Usecase.update(id, isValid.value);
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

    const bulkDeleteSchema = Joi.object({
      ids: Joi.array().items(Joi.number().integer()).min(1).required(),
    });

    router.delete("/bulk", async (req, res) => {
      try {
        const isValid = Joi.validate(req.body, bulkDeleteSchema);
        if (isValid.error) {
          res.status(400).json({ code: 400, msg: isValid.error.message });
          res.end();
          return;
        }
        const result = await this.offersV3Usecase.bulkDelete(req.body.ids);
        res.json(result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.delete("/:id", async (req, res) => {
      try {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) {
          res.status(400).json({ code: 400, msg: "Invalid id" });
          res.end();
          return;
        }
        const result = await this.offersV3Usecase.delete(id);
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

module.exports = (offersV3Usecase) => {
  return new OffersV3Routes(offersV3Usecase);
};
