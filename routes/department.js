const router = require("express").Router();
const Joi = require("@hapi/joi");
const respondError = require("../utils/http")

class DepartmentRoutes {
  constructor(departmentUsecase) {
    this.departmentUsecase = departmentUsecase;

    this.init();
  }

  init() {
    router.get("/", async (req, res) => {
        try {
          const department = await this.departmentUsecase.get();
          console.log(department);
          res.json(department);
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
      router.post("/update-department", async (req, res) => {
        try {
          const schema = {
            department_id: Joi.number().required(),

            department_details: Joi.object({
              department_name: Joi.string().required(),
              status: Joi.number().required(),
            }).optional(),
          };

          const department = req.body;
          const isValid = Joi.validate(department, schema);
          if (isValid.error !== null) {
            throw isValid.error;
          }
  
          const code = await this.departmentUsecase.updateDepartmentDetails(department);
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
      router.get("/department_id", async (req, res) => {
        try {
          const schema = {
            department_id: Joi.string().required(),
          }
          const department = req.query;
          const isValid = Joi.validate(department, schema);
          if (isValid.error !== null) {
            throw isValid.error;
          }
          const data = await this.departmentUsecase.getDepartmentById(department.department_id);
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
            status: Joi.string().required(),
            department_name: Joi.string().required(),
          };
  
          const department = req.body;
          const isValid = Joi.validate(department, schema);
  
          if (isValid.error !== null) {
            console.log(isValid.error);
            throw isValid.error;
          }
          const response = await this.departmentUsecase.create(department);
  
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

module.exports = (departmentUsecase) => {
  return new DepartmentRoutes(departmentUsecase);
};
