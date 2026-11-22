const respondError = require("../utils/http");

/**
 * Warehouse Health (/warehouse-health): the warehouse manager's dashboard
 * under Dashboard -> Invoice Pipeline, and its 9 am Telegram summary.
 *
 *   GET  /?date=YYYY-MM-DD   the day's health (default yesterday, IST)   view_warehouse_health
 *   GET  /trace?article_id&to_store&stage_id   one line through every stage     view_warehouse_health
 *   POST /summary/send-me    yesterday's summary to my own Telegram      receive_warehouse_health_summary
 *                                                                        or view_warehouse_health
 */
class WarehouseHealthRoutes {
  constructor(usecase, permissions) {
    this.usecase = usecase;
    this.permissions = permissions;
    this.router = require("express").Router();
    this.init();
  }

  init() {
    const deny = (req, res) => res.status(403).json({ code: 403, msg: "You do not have permission to perform this action" });
    const need = (...keys) => (this.permissions ? this.permissions.require(...keys) : deny);
    const send = (res, result) => {
      if (result.code === 200) return res.json(result);
      return res.status([403, 404, 409, 422, 502].includes(result.code) ? result.code : 400).json(result);
    };

    this.router.get("/", need("view_warehouse_health"), async (req, res) => {
      try {
        const date = req.query.date == null ? null : String(req.query.date).trim() || null;
        send(res, await this.usecase.health({ date }));
      } catch (err) {
        respondError(res, err);
      }
    });

    // One waiting line, traced through every stage: ?article_id&to_store&stage_id
    this.router.get("/trace", need("view_warehouse_health"), async (req, res) => {
      try {
        const q = (k) => (req.query[k] == null ? null : String(req.query[k]).trim() || null);
        send(res, await this.usecase.trace({ stage_id: q("stage_id"), article_id: q("article_id"), to_store: q("to_store") }));
      } catch (err) {
        respondError(res, err);
      }
    });

    this.router.post("/summary/send-me", need("receive_warehouse_health_summary", "view_warehouse_health"), async (req, res) => {
      try {
        send(res, await this.usecase.sendToMe((req.decoded && req.decoded.employee_id) || null));
      } catch (err) {
        respondError(res, err);
      }
    });
  }

  getRouter() {
    return this.router;
  }
}

module.exports = (usecase, permissions) => new WarehouseHealthRoutes(usecase, permissions);
