const router = require("express").Router();
const Joi = require("@hapi/joi");
const respondError = require("../utils/http")

class DesignationRoutes {
  constructor(designationUsecase) {
    this.designationUsecase = designationUsecase;

    this.init();
  }

  init() {
    router.get("/", async (req, res) => {
        try {
          const designation = await this.designationUsecase.get();
          res.json(designation);
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
            designation_name: Joi.string().required(),
            online_portal: Joi.string().required(),
          };
  
          const designation = req.body;
          const isValid = Joi.validate(designation, schema);
  
          if (isValid.error !== null) {
            console.log(isValid.error);
            throw isValid.error;
          }
          const response = await this.designationUsecase.create(designation);
  
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

module.exports = (designationUsecase) => {
  return new DesignationRoutes(designationUsecase);
};
