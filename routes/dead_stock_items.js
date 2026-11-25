const router = require("express").Router();
const respondError = require("../utils/http");

class DeadStockItemsRoutes {
  constructor(deadStockItemsUsecase) {
    this.deadStockItemsUsecase = deadStockItemsUsecase;
    this.init();
  }

  init() {
    router.get("/", async (req, res) => {
      try {
        const result = await this.deadStockItemsUsecase.listForClient();
        res.json(result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

  }

  getRouter() {
    return router;
  }
}

module.exports = (deadStockItemsUsecase) => {
  return new DeadStockItemsRoutes(deadStockItemsUsecase);
};
