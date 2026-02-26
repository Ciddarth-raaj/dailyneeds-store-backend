const router = require("express").Router();
const Joi = require("@hapi/joi");
const respondError = require("../utils/http");

class RemarksMasterRoutes {
  constructor(remarksMasterUsecase) {
    this.remarksMasterUsecase = remarksMasterUsecase;
    this.init();
  }

  init() {
    router.get("/", async (req, res) => {
      try {
        const list = await this.remarksMasterUsecase.getAll();
        res.json({ code: 200, data: list });
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.get("/:remark_id", async (req, res) => {
      try {
        const id = parseInt(req.params.remark_id, 10);
        if (isNaN(id)) {
          res.status(400).json({ code: 400, msg: "Invalid remark_id" });
          res.end();
          return;
        }
        const row = await this.remarksMasterUsecase.getById(id);
        if (!row) {
          res.status(404).json({ code: 404, msg: "Remark not found" });
          res.end();
          return;
        }
        res.json({ code: 200, data: row });
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    const createSchema = Joi.object({
      label: Joi.string().required().max(255),
      is_active: Joi.boolean().optional().default(true)
    });

    router.post("/", async (req, res) => {
      try {
        const isValid = Joi.validate(req.body, createSchema);
        if (isValid.error) {
          res.status(400).json({ code: 400, msg: isValid.error.message });
          res.end();
          return;
        }
        const result = await this.remarksMasterUsecase.create(req.body);
        res.json(result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    const updateSchema = Joi.object({
      label: Joi.string().max(255).optional(),
      is_active: Joi.boolean().optional()
    });

    router.put("/:remark_id", async (req, res) => {
      try {
        const isValid = Joi.validate(req.body, updateSchema);
        if (isValid.error) {
          res.status(400).json({ code: 400, msg: isValid.error.message });
          res.end();
          return;
        }
        const id = parseInt(req.params.remark_id, 10);
        if (isNaN(id)) {
          res.status(400).json({ code: 400, msg: "Invalid remark_id" });
          res.end();
          return;
        }
        const result = await this.remarksMasterUsecase.update(id, req.body);
        res.json(result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.delete("/:remark_id", async (req, res) => {
      try {
        const id = parseInt(req.params.remark_id, 10);
        if (isNaN(id)) {
          res.status(400).json({ code: 400, msg: "Invalid remark_id" });
          res.end();
          return;
        }
        const result = await this.remarksMasterUsecase.delete(id);
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

module.exports = (remarksMasterUsecase) => {
  return new RemarksMasterRoutes(remarksMasterUsecase);
};
