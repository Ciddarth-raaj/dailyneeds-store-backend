const router = require("express").Router();
const respondError = require("../utils/http");

class PurchaseRefRoutes {
  constructor(purchaseRefUsecase) {
    this.purchaseRefUsecase = purchaseRefUsecase;
    this.init();
  }

  init() {
    /**
     * GET /purchase-ref
     *
     * Served from a short-lived cache (see usecase/purchase_ref.js); `built_at`
     * tells the client how fresh the list is. `?refresh=1` forces a rebuild —
     * concurrent rebuilds are collapsed into one, so this can't be used to pile
     * work onto the DB.
     */
    router.get("/", async (req, res) => {
      try {
        const force = ["1", "true"].includes(String(req.query.refresh || ""));
        const { rows, built_at } =
          await this.purchaseRefUsecase.listPurchaseRef({ force });
        res.json({ code: 200, data: rows, built_at });
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
