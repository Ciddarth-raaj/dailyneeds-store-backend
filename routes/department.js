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
