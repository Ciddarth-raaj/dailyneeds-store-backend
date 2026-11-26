const Joi = require("@hapi/joi");
const respondError = require("../utils/http");
const { REASONS } = require("../utils/oos_followup");

/**
 * Out-of-stock follow-up (/oos-followup), usecase/oos_followup.js.
 *
 *   POST /oos-followup/upload             the morning report's rows                upload_oos_report
 *   GET  /oos-followup?buyer_id=&hidden=1 chaser: everyone (+ scoreboard);          chase_oos | view_my_oos
 *                                         buyer: own lines only
 *   POST /oos-followup/cases/:id/answer   { reason?, note? }                       chase_oos | view_my_oos (own line)
 *   POST /oos-followup/answer             { ids, reason?, note? } - an item's stores chase_oos | view_my_oos (own lines)
 *   GET  /oos-followup/cases/:id/events   the line's answers and notes             chase_oos | view_my_oos (own line)
 */
const cell = Joi.alternatives().try(Joi.string().allow(""), Joi.number()).allow(null).optional();
const uploadSchema = Joi.object({
  report_date: Joi.string().regex(/^\d{4}-\d{2}-\d{2}$/).allow(null, "").optional(),
  file_name: Joi.string().max(255).allow(null, "").optional(),
  rows: Joi.array()
    .items(
      Joi.object({
        article_id: cell,
        category: cell,
        article_name: cell,
        class: cell,
        store: cell,
        mrp: cell,
        cover_now: cell,
        planned: cell,
        pct: cell,
        stock: cell,
        value: cell,
      })
    )
    .min(1)
    .max(50000)
    .required(),
});
const answerSchema = Joi.object({
  reason: Joi.string().valid(...REASONS).allow(null, "").optional(),
  note: Joi.string().max(500).allow(null, "").optional(),
});

class OosFollowupRoutes {
  constructor(usecase, permissions) {
    this.usecase = usecase;
    this.permissions = permissions;
    this.router = require("express").Router();
    this.init();
  }

  init() {
    const deny = (req, res) => res.status(403).json({ code: 403, msg: "You do not have permission to perform this action" });
    const need = (...keys) => (this.permissions ? this.permissions.require(...keys) : deny);
    const canChase = (req) => (this.permissions ? this.permissions.has(req, "chase_oos") : Promise.resolve(false));
    const employeeOf = (req) => (req.decoded && req.decoded.employee_id) || null;
    const send = (res, result) => {
      if (result.code === 200) return res.json(result);
      return res.status([403, 404, 409, 422].includes(result.code) ? result.code : 500).json(result);
    };
    const caseId = (req) => (/^\d+$/.test(String(req.params.id)) ? Number(req.params.id) : null);

    this.router.post("/upload", need("upload_oos_report"), async (req, res) => {
      try {
        const v = Joi.validate(req.body, uploadSchema);
        if (v.error) return res.status(400).json({ code: 400, msg: v.error.message });
        send(
          res,
          await this.usecase.upload({
            rows: v.value.rows,
            fileName: v.value.file_name || null,
            reportDate: v.value.report_date || null,
            employeeId: employeeOf(req),
          })
        );
      } catch (err) {
        respondError(res, err);
      }
    });

    this.router.get("/", need("chase_oos", "view_my_oos"), async (req, res) => {
      try {
        const b = String(req.query.buyer_id || "");
        const buyerId = b === "none" ? "none" : /^\d+$/.test(b) ? Number(b) : null;
        send(
          res,
          await this.usecase.view({
            employeeId: employeeOf(req),
            canChase: await canChase(req),
            buyerId,
            includeHidden: req.query.hidden === "1",
          })
        );
      } catch (err) {
        respondError(res, err);
      }
    });

    this.router.post("/cases/:id/answer", need("chase_oos", "view_my_oos"), async (req, res) => {
      try {
        const id = caseId(req);
        if (!id) return res.status(422).json({ code: 422, msg: "Invalid line" });
        const v = Joi.validate(req.body || {}, answerSchema);
        if (v.error) return res.status(400).json({ code: 400, msg: v.error.message });
        send(
          res,
          await this.usecase.answer({
            id,
            reason: v.value.reason || null,
            note: v.value.note || null,
            employeeId: employeeOf(req),
            canChase: await canChase(req),
          })
        );
      } catch (err) {
        respondError(res, err);
      }
    });

    this.router.post("/answer", need("chase_oos", "view_my_oos"), async (req, res) => {
      try {
        const v = Joi.validate(req.body || {}, answerSchema.keys({ ids: Joi.array().items(Joi.number().integer().positive()).min(1).max(50).required() }));
        if (v.error) return res.status(400).json({ code: 400, msg: v.error.message });
        send(
          res,
          await this.usecase.answerMany({
            ids: v.value.ids,
            reason: v.value.reason || null,
            note: v.value.note || null,
            employeeId: employeeOf(req),
            canChase: await canChase(req),
          })
        );
      } catch (err) {
        respondError(res, err);
      }
    });

    this.router.get("/cases/:id/events", need("chase_oos", "view_my_oos"), async (req, res) => {
      try {
        const id = caseId(req);
        if (!id) return res.status(422).json({ code: 422, msg: "Invalid line" });
        send(res, await this.usecase.events({ id, employeeId: employeeOf(req), canChase: await canChase(req) }));
      } catch (err) {
        respondError(res, err);
      }
    });
  }

  getRouter() {
    return this.router;
  }
}

module.exports = (usecase, permissions) => new OosFollowupRoutes(usecase, permissions);
