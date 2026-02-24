const router = require("express").Router();
const respondError = require("../utils/http");

class ProductDistributorsRoutes {
  constructor(productDistributorsUsecase) {
    this.productDistributorsUsecase = productDistributorsUsecase;
    this.init();
  }

  init() {
    router.get("/", async (req, res) => {
      try {
        const list = await this.productDistributorsUsecase.getAll();
        res.json({ code: 200, data: list });
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.get("/:MDM_DIST_CODE", async (req, res) => {
      try {
        const { MDM_DIST_CODE } = req.params;
        const row = await this.productDistributorsUsecase.getByCode(MDM_DIST_CODE);
        if (!row) {
          res.status(404).json({ code: 404, msg: "Distributor not found" });
          res.end();
          return;
        }
        res.json({ code: 200, data: row });
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.delete("/:MDM_DIST_CODE", async (req, res) => {
      try {
        const { MDM_DIST_CODE } = req.params;
        const result = await this.productDistributorsUsecase.delete(MDM_DIST_CODE);
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

module.exports = (productDistributorsUsecase) => {
  return new ProductDistributorsRoutes(productDistributorsUsecase);
};
