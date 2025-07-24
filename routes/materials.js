const router = require("express").Router();
const Joi = require("@hapi/joi");
const respondError = require("../utils/http");

class MaterialsRoutes {
  constructor(materialsUsecase) {
    this.materialsUsecase = materialsUsecase;
    this.init();
  }

  init() {
    // --- materials_latest endpoints ---
    router.get("/", async (req, res) => {
      try {
        const schema = {
          offset: Joi.number().optional(),
          limit: Joi.number().optional(),
        };
        const query = req.query;
        const isValid = Joi.validate(query, schema);
        if (isValid.error !== null) throw isValid.error;
        const offset = query.offset !== undefined ? Number(query.offset) : 0;
        const limit = query.limit !== undefined ? Number(query.limit) : 50;
        const data = await this.materialsUsecase.getMaterials(offset, limit);
        res.json(data);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.get("/:id(\\d+)", async (req, res) => {
      try {
        const material_id = parseInt(req.params.id);
        if (isNaN(material_id)) throw new Error("Invalid material_id");
        const data = await this.materialsUsecase.getMaterialById(material_id);
        res.json(data);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.post("/", async (req, res) => {
      try {
        const schema = {
          name: Joi.string().required(),
          description: Joi.string().allow(null).optional(),
          unit_id: Joi.number().allow(null).optional(),
          material_category_id: Joi.number().allow(null).optional(),
          is_active: Joi.boolean().optional(),
        };
        const material = req.body;
        const isValid = Joi.validate(material, schema);
        if (isValid.error !== null) throw isValid.error;
        const resp = await this.materialsUsecase.createMaterial(material);
        res.json(resp);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.put("/:id(\\d+)", async (req, res) => {
      try {
        const material_id = parseInt(req.params.id);
        if (isNaN(material_id)) throw new Error("Invalid material_id");
        const schema = {
          name: Joi.string().optional(),
          description: Joi.string().allow(null).optional(),
          unit_id: Joi.number().allow(null).optional(),
          material_category_id: Joi.number().allow(null).optional(),
          is_active: Joi.boolean().optional(),
        };
        const material = req.body;
        const isValid = Joi.validate(material, schema);
        if (isValid.error !== null) throw isValid.error;
        const resp = await this.materialsUsecase.updateMaterial(
          material_id,
          material
        );
        res.json(resp);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.delete("/:id(\\d+)", async (req, res) => {
      try {
        const material_id = parseInt(req.params.id);
        if (isNaN(material_id)) throw new Error("Invalid material_id");
        const resp = await this.materialsUsecase.deleteMaterial(material_id);
        res.json(resp);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    // --- materials_category endpoints ---
    router.get("/categories", async (req, res) => {
      try {
        const schema = {
          offset: Joi.number().optional(),
          limit: Joi.number().optional(),
        };
        const query = req.query;
        const isValid = Joi.validate(query, schema);
        if (isValid.error !== null) throw isValid.error;
        const offset = query.offset !== undefined ? Number(query.offset) : 0;
        const limit = query.limit !== undefined ? Number(query.limit) : 50;
        const data = await this.materialsUsecase.getCategories(offset, limit);
        res.json(data);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.get("/categories/:id", async (req, res) => {
      try {
        const material_category_id = parseInt(req.params.id);
        if (isNaN(material_category_id))
          throw new Error("Invalid material_category_id");
        const data = await this.materialsUsecase.getCategoryById(
          material_category_id
        );
        res.json(data);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.post("/categories", async (req, res) => {
      try {
        const schema = {
          category_name: Joi.string().required(),
          is_active: Joi.boolean().optional(),
        };
        const category = req.body;
        const isValid = Joi.validate(category, schema);
        if (isValid.error !== null) throw isValid.error;
        const resp = await this.materialsUsecase.createCategory(category);
        res.json(resp);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.put("/categories/:id", async (req, res) => {
      try {
        const material_category_id = parseInt(req.params.id);
        if (isNaN(material_category_id))
          throw new Error("Invalid material_category_id");
        const schema = {
          category_name: Joi.string().optional(),
          is_active: Joi.boolean().optional(),
        };
        const category = req.body;
        const isValid = Joi.validate(category, schema);
        if (isValid.error !== null) throw isValid.error;
        const resp = await this.materialsUsecase.updateCategory(
          material_category_id,
          category
        );
        res.json(resp);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.delete("/categories/:id", async (req, res) => {
      try {
        const material_category_id = parseInt(req.params.id);
        if (isNaN(material_category_id))
          throw new Error("Invalid material_category_id");
        const resp = await this.materialsUsecase.deleteCategory(
          material_category_id
        );
        res.json(resp);
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

module.exports = (materialsUsecase) => {
  return new MaterialsRoutes(materialsUsecase);
};
