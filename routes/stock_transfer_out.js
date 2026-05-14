const router = require("express").Router();
const respondError = require("../utils/http");

function parseOptionalIsoDate(raw, label) {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: true, value: undefined };
  }
  const s = String(raw).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return { ok: false, msg: `${label} must be YYYY-MM-DD` };
  }
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) {
    return { ok: false, msg: `${label} is not a valid calendar date` };
  }
  return { ok: true, value: s };
}

class StockTransferOutRoutes {
  constructor(stockTransferOutUsecase) {
    this.stockTransferOutUsecase = stockTransferOutUsecase;
    this.init();
  }

  init() {
    router.get("/", async (req, res) => {
      try {
        const fromParsed = parseOptionalIsoDate(req.query.from_date, "from_date");
        const toParsed = parseOptionalIsoDate(req.query.to_date, "to_date");
        if (!fromParsed.ok) {
          res.status(400).json({ code: 400, msg: fromParsed.msg });
          res.end();
          return;
        }
        if (!toParsed.ok) {
          res.status(400).json({ code: 400, msg: toParsed.msg });
          res.end();
          return;
        }
        if (fromParsed.value && toParsed.value && fromParsed.value > toParsed.value) {
          res.status(400).json({ code: 400, msg: "from_date must be on or before to_date" });
          res.end();
          return;
        }

        const isCheckedFilter = req.query.is_checked === "true" || req.query.is_checked === true;
        const list = await this.stockTransferOutUsecase.get({
          is_checked: isCheckedFilter || undefined,
          from_date: fromParsed.value,
          to_date: toParsed.value,
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
