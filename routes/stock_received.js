const router = require("express").Router();
const Joi = require("@hapi/joi");
const respondError = require("../utils/http");

function parsePendingOnly(raw) {
  if (raw === undefined || raw === null || raw === "") {
    return true;
  }
  if (raw === false) {
    return false;
  }
  if (raw === true) {
    return true;
  }
  const s = String(raw).toLowerCase();
  if (s === "false" || s === "0") {
    return false;
  }
  return true;
}

class StockReceivedRoutes {
  constructor(stockReceivedUsecase) {
    this.stockReceivedUsecase = stockReceivedUsecase;
    this.init();
  }

  init() {
    router.get("/gofrugal-dtl", async (req, res) => {
      try {
        const pendingOnly = parsePendingOnly(req.query.pending_only);
        const data = await this.stockReceivedUsecase.listGofrugalDtl({
          pendingOnly,
        });
        res.json({
          code: 200,
          data,
          meta: {
            pending_only: pendingOnly,
            count: data.length,
          },
        });
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    const upsertSchema = Joi.object({
      mmd_mrc_no: Joi.number().integer().required(),
      mmd_mrc_sl_no: Joi.number().integer().required(),
      product_id: Joi.number().integer().required(),
      recd_qty: Joi.number().required(),
      is_offer: Joi.boolean().optional().default(false),
    });

    router.post("/upsert", async (req, res) => {
      try {
        const isValid = Joi.validate(req.body, upsertSchema);
        if (isValid.error) {
          res.status(400).json({ code: 400, msg: isValid.error.message });
          res.end();
          return;
        }
        const result = await this.stockReceivedUsecase.upsert(isValid.value);
        res.json(result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.get("/:stock_received_id", async (req, res) => {
      try {
        const id = parseInt(req.params.stock_received_id, 10);
        if (isNaN(id)) {
          res.status(400).json({ code: 400, msg: "Invalid stock_received_id" });
          res.end();
          return;
        }
        const row = await this.stockReceivedUsecase.getById(id);
        if (!row) {
          res.status(404).json({ code: 404, msg: "stock_received not found" });
          res.end();
          return;
        }
        res.json({ code: 200, data: row });
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.delete("/:stock_received_id", async (req, res) => {
      try {
        const id = parseInt(req.params.stock_received_id, 10);
        if (isNaN(id)) {
          res.status(400).json({ code: 400, msg: "Invalid stock_received_id" });
          res.end();
          return;
        }
        const result = await this.stockReceivedUsecase.deleteById(id);
        if (result.affectedRows === 0) {
          res.status(404).json({ code: 404, msg: "stock_received not found" });
          res.end();
          return;
        }
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

module.exports = (stockReceivedUsecase) => {
  return new StockReceivedRoutes(stockReceivedUsecase);
};
