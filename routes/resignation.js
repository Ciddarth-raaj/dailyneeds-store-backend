const router = require("express").Router();
const P = require("../constants/hr_permissions");
const Joi = require("@hapi/joi");
const respondError = require("../utils/http")

class ResignationRoutes {
  constructor(resignationUsecase, permissions) {
    this.permissions = permissions;
    this.resignationUsecase = resignationUsecase;

    this.init();
  }

  init() {
    router.get("/", this.permissions.require(P.VIEW_RESIGNATION), async (req, res) => {
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
      router.post("/resignation_id", this.permissions.require(P.VIEW_RESIGNATION), async (req, res) => {
        try {
          const schema = {
            resignation_id: Joi.string().required(),
          }
          const resignation = req.query;
          const isValid = Joi.validate(resignation, schema);
          if (isValid.error !== null) {
            throw isValid.error;
          }
          const response = await this.resignationUsecase.deleteResignation(resignation.resignation_id);
          res.json(response);
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
      router.get("/get/resignation_id", this.permissions.require(P.VIEW_RESIGNATION), async (req, res) => {
        try {
          const schema = {
            resignation_id: Joi.string().required(),
          }
          const resignation = req.query;
          const isValid = Joi.validate(resignation, schema);
          if (isValid.error !== null) {
            throw isValid.error;
          }
          const data = await this.resignationUsecase.getResignationByResigId(resignation.resignation_id);
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
      router.get("/employee_name", this.permissions.require(P.VIEW_RESIGNATION), async (req, res) => {
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
      router.post("/update-resignation", this.permissions.require(P.ADD_RESIGNATION), async (req, res) => {
        try {
          const schema = {
            resignation_id: Joi.number().required(),

            resignation_details: Joi.object({
              employee_name: Joi.string().optional(),
              reason_type: Joi.string().optional(),
              reason: Joi.string().optional(),
              resignation_date: Joi.string().optional(),
            }).optional(),
          };

          const resignation = req.body;
          const isValid = Joi.validate(resignation, schema);
          if (isValid.error !== null) {
            throw isValid.error;
          }
  
          const code = await this.resignationUsecase.updateResignationDetails(resignation);
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
    router.post("/create", this.permissions.require(P.ADD_RESIGNATION), async (req, res) => {
        try {
          const schema = {
            employee_name: Joi.string().required(),
            reason_type: Joi.string().required(),
            reason: Joi.string().required(),
            resignation_date: Joi.string().required(),
          };
  
          const resignation = req.body;

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

module.exports = (resignationUsecase, permissions) => {
  return new ResignationRoutes(resignationUsecase, permissions);
};
