const router = require("express").Router();
const Joi = require("@hapi/joi");
const respondError = require("../utils/http")

class MaterialRoutes {
  constructor(materialUsecase) {
    this.materialUsecase = materialUsecase;

    this.init();
  }

  init() {
    router.get("/", async (req, res) => {
        try {
          const material = await this.materialUsecase.get();
          res.json(material);
        } catch (err) {
            console.log(err);
          if (err.name === "ValidationError") {
            res.json({ code: 422, msg: err.toString() });
          } else {
            res.json({ code: 500, msg: "An error occurred !" });
          }
        }
  
        res.end();
      });
      router.post("/update-status", async (req, res) => {
        try {
          const schema = {
            material_id: Joi.number().required(),
            status: Joi.number().required(),
          };
  
          const material = req.body;
          console.log(material);
          const isValid = Joi.validate(material, schema);
          if (isValid.error !== null) {
            throw isValid.error;
          }
  
          const code = await this.materialUsecase.updateStatus(material);
          res.json({ code: code });
        } catch (err) {
          if (err.name === "ValidationError") {
            res.json({ code: 422, msg: err.toString() });
          } else {
            console.log(err);
            res.json({ code: 500, msg: "An error occurred !" });
          }
        }
        res.end();
      });
      router.post("/update-material", async (req, res) => {
        try {
          const schema = {
            material_id: Joi.number().required(),

            material_details: Joi.object({
              material_name: Joi.string().required(),
              description: Joi.string().required(),
              material_category: Joi.string().required()
            }).optional(),
          };

          const material = req.body;
          const isValid = Joi.validate(material, schema);
          if (isValid.error !== null) {
            throw isValid.error;
          }
  
          const code = await this.materialUsecase.updateMaterialDetails(material);
          res.json({ code: code });
        } catch (err) {
          if (err.name === "ValidationError") {
            res.json({ code: 422, msg: err.toString() });
          } else {
            console.log(err);
            res.json({ code: 500, msg: "An error occurred !" });
          }
        }
        res.end();
      });
      router.get("/material_id", async (req, res) => {
        try {
          const schema = {
            material_id: Joi.string().required(),
          }
          const material = req.query;
          const isValid = Joi.validate(material, schema);
          if (isValid.error !== null) {
            throw isValid.error;
          }
          const data = await this.materialUsecase.getMaterialById(material.material_id);
          res.json(data);
        } catch (err) {
          console.log(err);
          if (err.name === "ValidationError") {
            res.json({ code: 422, msg: err.toString() });
          } else {
            res.json({ code: 500, msg: "An error occurred !" });
          }
        }
  
        res.end();
      });
    router.post("/create", async (req, res) => {
        try {
          const schema = {
              material_name: Joi.string().required(),
              description: Joi.string().required(),
              material_category: Joi.string().required()
          };
  
          const material = req.body;
          const isValid = Joi.validate(material, schema);
  
          if (isValid.error !== null) {
            console.log(isValid.error);
            throw isValid.error;
          }
          const response = await this.materialUsecase.create(material);
  
          res.json(response);
        } catch (err) {

          if (err.name === "ValidationError") {
            res.json({ code: 422, msg: err.toString() });
          } else {
            console.log(err);
            res.json({ code: 500, msg: err.message });
          }
        }
  
        res.end();
      });
  }
  getRouter() {
    return router;
  }
}   

module.exports = (materialUsecase) => {
  return new MaterialRoutes(materialUsecase);
};
