const router = require("express").Router();
const respondError = require("../utils/http");

class StockTransferOutRoutes {
  constructor(stockTransferOutUsecase) {
    this.stockTransferOutUsecase = stockTransferOutUsecase;
    this.init();
  }

  init() {
    router.get("/", async (req, res) => {
      try {
        const isCheckedFilter = req.query.is_checked === "true" || req.query.is_checked === true;
        const list = await this.stockTransferOutUsecase.get({
          is_checked: isCheckedFilter || undefined,
        });
        res.json({ code: 200, data: list });
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.get("/by-ref/:Dn_Ref_no", async (req, res) => {
      try {
        const Dn_Ref_no = parseInt(req.params.Dn_Ref_no, 10);
        if (isNaN(Dn_Ref_no)) {
          res.status(400).json({ code: 400, msg: "Invalid Dn_Ref_no" });
          res.end();
          return;
        }
        const list = await this.stockTransferOutUsecase.getByDnRefNo(Dn_Ref_no);
        res.json({ code: 200, data: list });
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.get("/:Dn_no", async (req, res) => {
      try {
        const Dn_no = parseInt(req.params.Dn_no, 10);
        if (isNaN(Dn_no)) {
          res.status(400).json({ code: 400, msg: "Invalid Dn_no" });
          res.end();
          return;
        }
        const row = await this.stockTransferOutUsecase.getByDnNo(Dn_no);
        if (!row) {
          res.status(404).json({ code: 404, msg: "Stock transfer out not found" });
          res.end();
          return;
        }
        res.json({ code: 200, data: row });
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

module.exports = (stockTransferOutUsecase) => {
  return new StockTransferOutRoutes(stockTransferOutUsecase);
};
