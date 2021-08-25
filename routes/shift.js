const router = require("express").Router();
const Joi = require("@hapi/joi");
const respondError = require("../utils/http")

class ShiftRoutes {
  constructor(shiftUsecase) {
    this.shiftUsecase = shiftUsecase;

    this.init();
  }

  init() {
    router.get("/", async (req, res) => {
        try {
          const shift = await this.shiftUsecase.get();
          res.json(shift);
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
            status: Joi.number().required(),
            shift_name: Joi.string().required(),
            shift_in_time: Joi.string().required(),
            shift_out_time: Joi.string().required(),
          };
  
          const shift = req.body;
          const isValid = Joi.validate(shift, schema);
          
          if (isValid.error !== null) {
            throw isValid.error;
          }
  
          const response = await this.shiftUsecase.create(shift);
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

module.exports = (shiftUsecase) => {
  return new ShiftRoutes(shiftUsecase);
};
