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
  }
  getRouter() {
    return router;
  }
}   

module.exports = (shiftUsecase) => {
  return new ShiftRoutes(shiftUsecase);
};
