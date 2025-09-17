const router = require("express").Router();
const Joi = require("@hapi/joi");
const respondError = require("../utils/http");

class RepackItemRoutes {
  constructor(repackItemUsecase) {
    this.repackItemUsecase = repackItemUsecase;

    // Joi validation schemas
    this.createSchema = Joi.object({
      item_id: Joi.number().required(),
      cleaning: Joi.boolean().allow(null).optional(),
      packing_type: Joi.number().allow(null).optional(),
      packing_material: Joi.number().allow(null).optional(),
      packing_material_size: Joi.number().allow(null).optional(),
      sticker: Joi.boolean().allow(null).optional()
    });

    this.updateSchema = Joi.object({
      cleaning: Joi.boolean().allow(null).optional(),
      packing_type: Joi.number().allow(null).optional(),
      packing_material: Joi.number().allow(null).optional(),
      packing_material_size: Joi.number().allow(null).optional(),
      sticker: Joi.boolean().allow(null).optional()
    }).min(1);

    this.itemIdSchema = Joi.object({
      item_id: Joi.number().required()
    });

    this.querySchema = Joi.object({
      limit: Joi.number().default(100).optional(),
      offset: Joi.number().default(0).optional()
    });

    this.init();
  }

  init() {
    // Create repack item
    router.post("/create", async (req, res) => {
      try {
        const repackItem = req.body;
        
        // Joi validation
        const { error, value } = this.createSchema.validate(repackItem);
        if (error) {
          return res.json({ 
            code: 422, 
            msg: "Validation error", 
            details: error.details.map(detail => detail.message) 
          });
        }

        const response = await this.repackItemUsecase.create(value);
        res.json(response);
      } catch (err) {
        console.log(err);
        res.json({ code: 500, msg: err.message });
      }
      res.end();
    });

    // Get all repack items
    router.get("/all", async (req, res) => {
      try {
        // Joi validation for query parameters
        const { error, value } = this.querySchema.validate(req.query);
        if (error) {
          return res.json({ 
            code: 422, 
            msg: "Validation error", 
            details: error.details.map(detail => detail.message) 
          });
        }

        const response = await this.repackItemUsecase.getAll(value.limit, value.offset);
        res.json(response);
      } catch (err) {
        console.log(err);
        res.json({ code: 500, msg: "An error occurred!" });
      }
      res.end();
    });

    // Get repack item by item_id
    router.get("/:item_id", async (req, res) => {
      try {
        const { item_id } = req.params;
        
        // Joi validation for item_id parameter
        const { error, value } = this.itemIdSchema.validate({ item_id: parseInt(item_id) });
        if (error) {
          return res.json({ 
            code: 422, 
            msg: "Validation error", 
            details: error.details.map(detail => detail.message) 
          });
        }

        const response = await this.repackItemUsecase.getByItemId(value.item_id);
        res.json(response);
      } catch (err) {
        console.log(err);
        res.json({ code: 500, msg: "An error occurred!" });
      }
      res.end();
    });

    // Update repack item
    router.put("/:item_id", async (req, res) => {
      try {
        const { item_id } = req.params;
        const repackItem = req.body;
        
        // Joi validation for item_id parameter
        const { error: idError, value: idValue } = this.itemIdSchema.validate({ item_id: parseInt(item_id) });
        if (idError) {
          return res.json({ 
            code: 422, 
            msg: "Validation error", 
            details: idError.details.map(detail => detail.message) 
          });
        }

        // Joi validation for request body
        const { error: bodyError, value: bodyValue } = this.updateSchema.validate(repackItem);
        if (bodyError) {
          return res.json({ 
            code: 422, 
            msg: "Validation error", 
            details: bodyError.details.map(detail => detail.message) 
          });
        }
        
        const response = await this.repackItemUsecase.update(idValue.item_id, bodyValue);
        res.json(response);
      } catch (err) {
        console.log(err);
        res.json({ code: 500, msg: err.message });
      }
      res.end();
    });

    // Delete repack item
    router.delete("/:item_id", async (req, res) => {
      try {
        const { item_id } = req.params;
        
        // Joi validation for item_id parameter
        const { error, value } = this.itemIdSchema.validate({ item_id: parseInt(item_id) });
        if (error) {
          return res.json({ 
            code: 422, 
            msg: "Validation error", 
            details: error.details.map(detail => detail.message) 
          });
        }

        const response = await this.repackItemUsecase.delete(value.item_id);
        res.json(response);
      } catch (err) {
        console.log(err);
        res.json({ code: 500, msg: err.message });
      }
      res.end();
    });

    // Get count
    router.get("/count/total", async (req, res) => {
      try {
        const response = await this.repackItemUsecase.getCount();
        res.json(response);
      } catch (err) {
        console.log(err);
        if (err.name === "ValidationError") {
          res.json({ code: 422, msg: err.toString() });
        } else {
          res.json({ code: 500, msg: "An error occurred!" });
        }
      }
      res.end();
    });
  }

  getRouter() {
    return router;
  }
}

module.exports = (repackItemUsecase) => new RepackItemRoutes(repackItemUsecase);
