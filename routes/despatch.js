const router = require("express").Router();
const Joi = require("@hapi/joi");

class DespatchRoutes {
  constructor(despatchUsecase) {
    this.despatchUsecase = despatchUsecase;

    this.init();
  }

  init() {
    router.post("/create", async (req, res) => {
      try {
        const schema = {
          store_id: Joi.string().required(),
          store_to: Joi.string().required(),
          vehicle: Joi.string().required(),
          driver: Joi.string().required(),
          indent_id: Joi.string().required()
        };

        const despatch = req.body;
    
        const isValid = Joi.validate(despatch, schema);
        if (isValid.error !== null) {
          console.log(isValid.error);
          throw isValid.error;
        }
       
        const response = await this.despatchUsecase.createDespatch(despatch);

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

    router.get("/despatch_id", async (req, res) => {
      try {
        const schema = {
          despatch_id: Joi.string().required(),
        }
        const despatch = req.query;
        const isValid = Joi.validate(despatch, schema);
        if (isValid.error !== null) {
          throw isValid.error;
        }
        const data = await this.despatchUsecase.getIndentsByDespatch(despatch.despatch_id);
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
    router.get("/store_id", async (req, res) => {
      try {
        const schema = {
          store_id: Joi.string().required(),
        }
        const despatch = req.query;
        const isValid = Joi.validate(despatch, schema);
        if (isValid.error !== null) {
          throw isValid.error;
        }
        const data = await this.despatchUsecase.getDespatchByStoreId(despatch.store_id);
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
    router.get("/", async (req, res) => {
      try {
          const despatch = await this.despatchUsecase.get();
          res.json(despatch);
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

module.exports = (despatchUsecase) => {
  return new DespatchRoutes(despatchUsecase);
};
