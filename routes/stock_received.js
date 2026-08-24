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

/** Optional query param: calendar days subtracted from offer created_at; line qualifies if MMH_MRC_DT >= (created_at - buffer). */
function parseDaysBuffer(raw) {
  if (raw === undefined || raw === null || raw === "") {
    return 0;
  }
  const n = parseInt(String(raw), 10);
  if (Number.isNaN(n) || n < 0) {
    return 0;
  }
  return Math.min(n, 3650);
}

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

class StockReceivedRoutes {
  constructor(stockReceivedUsecase) {
    this.stockReceivedUsecase = stockReceivedUsecase;
    this.init();
  }

  init() {
    router.get("/gofrugal-dtl", async (req, res) => {
      try {
        const pendingOnly = parsePendingOnly(req.query.pending_only);
        const daysBuffer = parseDaysBuffer(req.query.days_buffer);
        const data = await this.stockReceivedUsecase.listGofrugalDtl({
          pendingOnly,
          daysBuffer,
        });
        res.json({
          code: 200,
          data,
          meta: {
            pending_only: pendingOnly,
            days_buffer: daysBuffer,
            count: data.length,
          },
        });
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.get("/grn-list", async (req, res) => {
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
        if (
          fromParsed.value &&
          toParsed.value &&
          fromParsed.value > toParsed.value
        ) {
          res.status(400).json({
            code: 400,
            msg: "from_date must be on or before to_date",
          });
          res.end();
          return;
        }

        const data = await this.stockReceivedUsecase.listGrnHeaders({
          from_date: fromParsed.value,
          to_date: toParsed.value,
        });
        res.json({
          code: 200,
          data,
          meta: {
            count: data.length,
            from_date: fromParsed.value ?? null,
            to_date: toParsed.value ?? null,
          },
        });
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.get("/grn-detail", async (req, res) => {
      try {
        const refno =
          req.query.refno != null ? String(req.query.refno).trim() : "";
        if (!refno) {
          res.status(400).json({ code: 400, msg: "refno is required" });
          res.end();
          return;
        }

        const data = await this.stockReceivedUsecase.getGrnDetailByRefno(refno);
        if (!data) {
          res.status(404).json({ code: 404, msg: "GRN not found" });
          res.end();
          return;
        }

        res.json({
          code: 200,
          data,
          meta: {
            refno,
            item_count: data.items?.length ?? 0,
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
