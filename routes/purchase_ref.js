const router = require("express").Router();
const respondError = require("../utils/http");

class PurchaseRefRoutes {
  constructor(purchaseRefUsecase) {
    this.purchaseRefUsecase = purchaseRefUsecase;
    this.init();
  }

  init() {
    router.get("/", async (req, res) => {
      try {
        const data = await this.purchaseRefUsecase.listPurchaseRef();
        res.json({ code: 200, data });
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

module.exports = (purchaseRefUsecase) => new PurchaseRefRoutes(purchaseRefUsecase);
