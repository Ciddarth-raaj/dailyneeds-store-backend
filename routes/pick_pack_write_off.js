const router = require("express").Router();
const Joi = require("@hapi/joi");
const respondError = require("../utils/http");

class PickPackWriteOffRoutes {
  constructor(pickPackWriteOffUsecase) {
    this.pickPackWriteOffUsecase = pickPackWriteOffUsecase;
    this.init();
  }

  init() {
    router.get("/", async (req, res) => {
      try {
        const schema = Joi.object({
          from_date: Joi.date().optional(),
          to_date: Joi.date().optional()
        });
        const isValid = Joi.validate(req.query, schema);
        if (isValid.error) {
          res.status(400).json({ code: 400, msg: isValid.error.message });
          res.end();
          return;
        }

        const list = await this.pickPackWriteOffUsecase.getAll({
          from_date: req.query.from_date,
          to_date: req.query.to_date
        });
        res.json({ code: 200, data: list });
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.get("/:pick_pack_write_off_id", async (req, res) => {
      try {
        const id = parseInt(req.params.pick_pack_write_off_id, 10);
        if (isNaN(id)) {
          res.status(400).json({ code: 400, msg: "Invalid pick_pack_write_off_id" });
          res.end();
          return;
        }

        const row = await this.pickPackWriteOffUsecase.getById(id);
        if (!row) {
          res.status(404).json({ code: 404, msg: "Pick pack write off not found" });
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
      product_id: Joi.number().integer().required(),
      mismatch_qty: Joi.number().integer().required(),
      date: Joi.date().required(),
      remark_id: Joi.number().integer().allow(null).optional(),
      remark_str: Joi.string().max(500).allow(null, "").optional(),
      reason_employee_id: Joi.number().integer().allow(null).optional(),
      is_verified: Joi.boolean().optional().default(false)
    });

    router.post("/", async (req, res) => {
      try {
        const isValid = Joi.validate(req.body, createSchema);
        if (isValid.error) {
          res.status(400).json({ code: 400, msg: isValid.error.message });
          res.end();
          return;
        }
        const result = await this.pickPackWriteOffUsecase.create(req.body);
        res.json(result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    const updateSchema = Joi.object({
      product_id: Joi.number().integer().optional(),
      mismatch_qty: Joi.number().integer().optional(),
      date: Joi.date().optional(),
      remark_id: Joi.number().integer().allow(null).optional(),
      remark_str: Joi.string().max(500).allow(null, "").optional(),
      reason_employee_id: Joi.number().integer().allow(null).optional(),
      is_verified: Joi.boolean().optional()
    });

    router.put("/:pick_pack_write_off_id", async (req, res) => {
      try {
        const isValid = Joi.validate(req.body, updateSchema);
        if (isValid.error) {
          res.status(400).json({ code: 400, msg: isValid.error.message });
          res.end();
          return;
        }

        const id = parseInt(req.params.pick_pack_write_off_id, 10);
        if (isNaN(id)) {
          res.status(400).json({ code: 400, msg: "Invalid pick_pack_write_off_id" });
          res.end();
          return;
        }

        const result = await this.pickPackWriteOffUsecase.update(id, req.body);
        res.json(result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.delete("/:pick_pack_write_off_id", async (req, res) => {
      try {
        const id = parseInt(req.params.pick_pack_write_off_id, 10);
        if (isNaN(id)) {
          res.status(400).json({ code: 400, msg: "Invalid pick_pack_write_off_id" });
          res.end();
          return;
        }

        const result = await this.pickPackWriteOffUsecase.delete(id);
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

module.exports = (pickPackWriteOffUsecase) => {
  return new PickPackWriteOffRoutes(pickPackWriteOffUsecase);
};
