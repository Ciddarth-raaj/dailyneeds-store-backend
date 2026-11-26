const Joi = require("@hapi/joi");
const respondError = require("../utils/http");
const { CHANNELS, STOP_REASONS } = require("../utils/po_tracker");

/**
 * PO Tracker (/po-tracker): POs live from RetailPilot (read-only) and the
 * team's supplier follow-up remarks.
 *
 *   GET  /po-tracker?refresh=1        latest POs per store and supplier, with each one's last remark   view_po_tracker
 *   GET  /po-tracker/:slug/followups  one PO's remarks + the supplier's on its other POs              view_po_tracker
 *   POST /po-tracker/:slug/followups  add a remark                                                     add_po_followup
 *   POST /po-tracker/:slug/stop       stop following a PO (reason, note)                               view_po_tracker (everyone on the tracker)
 *   POST /po-tracker/:slug/resume     follow it again                                                  view_po_tracker
 *   POST /po-tracker/daily-summary/send-me   today's follow-up summary so far, to my own Telegram      receive_po_daily_summary
 */
const day = Joi.string().regex(/^\d{4}-\d{2}-\d{2}$/).allow(null, "").optional();
const followupSchema = Joi.object({
  channel: Joi.string().valid(...CHANNELS).required(),
  remark: Joi.string().trim().min(1).max(1000).required(),
  promised_delivery_date: day,
  next_follow_up_date: day,
});

const stopSchema = Joi.object({
  reason: Joi.string().valid(...STOP_REASONS).required(),
  note: Joi.string().trim().max(1000).allow("", null).optional(),
});
const resumeSchema = Joi.object({
  note: Joi.string().trim().max(1000).allow("", null).optional(),
});

class PoTrackerRoutes {
  constructor(usecase, permissions, dailySummary = null) {
    this.usecase = usecase;
    this.permissions = permissions;
    this.dailySummary = dailySummary;
    this.router = require("express").Router();
    this.init();
  }

  init() {
    const deny = (req, res) => res.status(403).json({ code: 403, msg: "You do not have permission to perform this action" });
    const need = (key) => (this.permissions ? this.permissions.require(key) : deny);
    const send = (res, result) => {
      if (result.code === 200) return res.json(result);
      return res.status([403, 404, 422, 502].includes(result.code) ? result.code : 400).json(result);
    };

    this.router.get("/", need("view_po_tracker"), async (req, res) => {
      try {
        send(res, await this.usecase.list({ refresh: String(req.query.refresh || "") === "1" }));
      } catch (err) {
        respondError(res, err);
      }
    });

    this.router.post("/daily-summary/send-me", need("receive_po_daily_summary"), async (req, res) => {
      try {
        if (!this.dailySummary) return res.status(400).json({ code: 400, msg: "Daily summary is not set up" });
        send(res, await this.dailySummary.sendToMe((req.decoded && req.decoded.employee_id) || null));
      } catch (err) {
        respondError(res, err);
      }
    });

    const employee = (req) => (req.decoded && req.decoded.employee_id) || null;
    this.router.post("/:slug/stop", need("view_po_tracker"), async (req, res) => {
      try {
        const { error, value } = stopSchema.validate(req.body || {});
        if (error) return res.status(422).json({ code: 422, msg: error.details[0].message });
        send(res, await this.usecase.stopFollowup({ slug: req.params.slug, ...value, employee_id: employee(req) }));
      } catch (err) {
        respondError(res, err);
      }
    });

    this.router.post("/:slug/resume", need("view_po_tracker"), async (req, res) => {
      try {
        const { error, value } = resumeSchema.validate(req.body || {});
        if (error) return res.status(422).json({ code: 422, msg: error.details[0].message });
        send(res, await this.usecase.resumeFollowup({ slug: req.params.slug, ...value, employee_id: employee(req) }));
      } catch (err) {
        respondError(res, err);
      }
    });

    this.router.get("/:slug/followups", need("view_po_tracker"), async (req, res) => {
      try {
        send(res, await this.usecase.followups({ slug: req.params.slug }));
      } catch (err) {
        respondError(res, err);
      }
    });

    this.router.post("/:slug/followups", need("add_po_followup"), async (req, res) => {
      try {
        const { error, value } = followupSchema.validate(req.body || {});
        if (error) return res.status(422).json({ code: 422, msg: error.details[0].message });
        send(
          res,
          await this.usecase.addFollowup({
            slug: req.params.slug,
            ...value,
            employee_id: (req.decoded && req.decoded.employee_id) || null,
          })
        );
      } catch (err) {
        respondError(res, err);
      }
    });
  }

  getRouter() {
    return this.router;
  }
}

module.exports = (usecase, permissions, dailySummary) => new PoTrackerRoutes(usecase, permissions, dailySummary);
