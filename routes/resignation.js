const router = require("express").Router();
const Joi = require("@hapi/joi");
const respondError = require("../utils/http")

class ResignationRoutes {
  constructor(resignationUsecase) {
    this.resignationUsecase = resignationUsecase;

    this.init();
  }

  init() {
    router.get("/", async (req, res) => {
        try {
          const resignation = await this.resignationUsecase.get();
          res.json(resignation);
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
      router.get("/employee_name", async (req, res) => {
        try {
          const schema = {
            employee_name: Joi.string().required(),
          }
          const resignation = req.query;
          const isValid = Joi.validate(resignation, schema);
          if (isValid.error !== null) {
            throw isValid.error;
          }
          const data = await this.resignationUsecase.getResignationById(resignation.employee_name);
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
            employee_name: Joi.string().required(),
            reason_type: Joi.string().required(),
            reason: Joi.string().required(),
            resignation_date: Joi.string().required(),
          };
  
          const resignation = req.body;
          console.log(resignation);
          const isValid = Joi.validate(resignation, schema);
  
          if (isValid.error !== null) {
            console.log(isValid.error);
            throw isValid.error;
          }
          const response = await this.resignationUsecase.create(resignation);
  
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

module.exports = (resignationUsecase) => {
  return new ResignationRoutes(resignationUsecase);
};
