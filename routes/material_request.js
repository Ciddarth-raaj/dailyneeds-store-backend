// routes/material_request.js
const router = require("express").Router();
const Joi = require("@hapi/joi");
const respondError = require("../utils/http");

class MaterialRequestRoutes {
  constructor(materialRequestUsecase) {
    this.materialRequestUsecase = materialRequestUsecase;
    this.init();
  }

  init() {
    // Create
    router.post("/", async (req, res) => {
      try {
        const schema = {
          items: Joi.array()
            .items(
              Joi.object({
                material_id: Joi.number().required(),
                quantity: Joi.number().required(),
                remark: Joi.string().allow(null, "").optional(),
              })
            )
            .optional(),
          outlet_id: Joi.number().optional(),
          is_approved: Joi.number().valid(0, 1).optional(),
        };
        const body = req.body;
        const isValid = Joi.validate(body, schema);
        if (isValid.error !== null) throw isValid.error;

        const created_by = req.decoded.employee_id;
        const outlet_id = body.outlet_id || req.decoded.store_id;
        const is_approved =
          body.is_approved !== undefined ? body.is_approved : 0;
        const id = await this.materialRequestUsecase.createMaterialRequest(
          { created_by, outlet_id, is_approved },
          body.items || []
        );
        res.status(201).json({ material_request_id: id });
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    // Read all
    router.get("/", async (req, res) => {
      try {
        const data = await this.materialRequestUsecase.getAllMaterialRequests();
        res.json(data);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    // Read one
    router.get("/:id(\\d+)", async (req, res) => {
      try {
        const material_request_id = parseInt(req.params.id);
        if (isNaN(material_request_id))
          throw new Error("Invalid material_request_id");
        const data = await this.materialRequestUsecase.getMaterialRequestById(
          material_request_id
        );
        if (!data) return res.status(404).json({ error: "Not found" });
        res.json(data);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    // Update
    router.put("/:id(\\d+)", async (req, res) => {
      try {
        const material_request_id = parseInt(req.params.id);
        if (isNaN(material_request_id))
          throw new Error("Invalid material_request_id");
        const schema = {
          items: Joi.array()
            .items(
              Joi.object({
                material_id: Joi.number().required(),
                quantity: Joi.number().required(),
                remark: Joi.string().allow(null, "").optional(),
              })
            )
            .optional(),
          is_approved: Joi.number().valid(0, 1).optional(),
        };
        const body = req.body;
        const isValid = Joi.validate(body, schema);
        if (isValid.error !== null) throw isValid.error;
        const created_by = req.decoded.employee_id;
        const outlet_id = req.decoded.store_id;
        const is_approved =
          body.is_approved !== undefined ? body.is_approved : 0;
        await this.materialRequestUsecase.updateMaterialRequest(
          material_request_id,
          { created_by, outlet_id, is_approved },
          body.items || []
        );
        res.json({ success: true });
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    // Delete
    router.delete("/:id(\\d+)", async (req, res) => {
      try {
        const material_request_id = parseInt(req.params.id);
        if (isNaN(material_request_id))
          throw new Error("Invalid material_request_id");
        await this.materialRequestUsecase.deleteMaterialRequest(
          material_request_id
        );
        res.json({ success: true });
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

module.exports = (materialRequestUsecase) => {
  return new MaterialRequestRoutes(materialRequestUsecase);
};
