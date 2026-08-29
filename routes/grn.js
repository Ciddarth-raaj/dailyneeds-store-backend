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

class GrnRoutes {
  constructor(grnUsecase) {
    this.grnUsecase = grnUsecase;
    this.init();
  }

  init() {
    router.get("/list", async (req, res) => {
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

        const data = await this.grnUsecase.listGrnHeaders({
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

    router.get("/detail", async (req, res) => {
      try {
        const refno =
          req.query.refno != null ? String(req.query.refno).trim() : "";
        if (!refno) {
          res.status(400).json({ code: 400, msg: "refno is required" });
          res.end();
          return;
        }

        const data = await this.grnUsecase.getGrnDetailByRefno(refno);
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
  }

  getRouter() {
    return router;
  }
}

module.exports = (grnUsecase) => {
  return new GrnRoutes(grnUsecase);
};
