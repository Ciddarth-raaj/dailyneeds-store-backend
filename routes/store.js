const router = require("express").Router();

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
  }
  getRouter() {
    return router;
  }
}

module.exports = (storeUsecase) => {
  return new StoreRoutes(storeUsecase);
};
