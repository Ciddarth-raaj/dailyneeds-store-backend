const router = require("express").Router();
const Joi = require("@hapi/joi");
const respondError = require("../utils/http")

class FamilyRoutes {
  constructor(familyUsecase) {
    this.familyUsecase = familyUsecase;

    this.init();
  }

  init() {
    router.get("/", async (req, res) => {
        try {
          const family = await this.familyUsecase.get();
          res.json(family);
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
      router.get("/family_id", async (req, res) => {
        try {
          const schema = {
            family_id: Joi.string().required(),
          }
          const family = req.query;
          const isValid = Joi.validate(family, schema);
          if (isValid.error !== null) {
            throw isValid.error;
          }
          const data = await this.familyUsecase.getFamilyById(family.family_id);
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
      router.post("/update-family", async (req, res) => {
        try {
          const schema = {
            family_id: Joi.number().required(),

            family_details: Joi.object({
              name: Joi.string().optional(),
              dob: Joi.date().optional(),
              gender: Joi.string().optional(),
              blood_group: Joi.string().optional(),
              relation: Joi.string().optional(),
              nationality: Joi.string().optional(),
              profession: Joi.string().optional(),
              remarks: Joi.string().optional(),
            }).optional(),
          };

          const family = req.body;
          const isValid = Joi.validate(family, schema);
          if (isValid.error !== null) {
            throw isValid.error;
          }
  
          const code = await this.familyUsecase.updateFamilyDetails(family);
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
    router.post("/create", async (req, res) => {
        try {
          const schema = {
            name: Joi.string().required(),
            dob: Joi.date().required(),
            gender: Joi.string().required(),
            blood_group: Joi.string().required(),
            relation: Joi.string().required(),
            nationality: Joi.string().required(),
            profession: Joi.string().required(),
            remarks: Joi.string().required(),
          };
  
          const family = req.body;
          const isValid = Joi.validate(family, schema);
  
          if (isValid.error !== null) {
            console.log(isValid.error);
            throw isValid.error;
          }
          const response = await this.familyUsecase.create(family);
  
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

module.exports = (familyUsecase) => {
  return new FamilyRoutes(familyUsecase);
};
