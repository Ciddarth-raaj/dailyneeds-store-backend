const router = require("express").Router();
const Joi = require("@hapi/joi");

class StoreRoutes {
  constructor(storeUsecase) {
    this.storeUsecase = storeUsecase;

    this.init();
  }

  init() {
    router.get("/", async (req, res) => {
      try {
        const store = await this.storeUsecase.get();
        res.json(store);
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
        const store = req.query;
        // console.log({store: store})
        const isValid = Joi.validate(store, schema);
        if (isValid.error !== null) {
          throw isValid.error;
        }
        const data = await this.storeUsecase.getStoreById(store.store_id);
        // console.log({data: data});
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
  }
  getRouter() {
    return router;
  }
}

module.exports = (storeUsecase) => {
  return new StoreRoutes(storeUsecase);
};
