const { DASHBOARD_PERMISSION, scopeForClient } = require("../utils/dashboard_scope");
const respondError = require("../utils/http");
const { requireAdmin } = require("../middlewares/admin_only");

/**
 * Business Dashboard (/business-dashboard). Read-only, live from RetailPilot.
 *
 * Behind `view_sales_dashboard` and the shared dashboard store scope: an Own
 * Store caller gets their branch's figures only, decided on the server.
 */
class BusinessDashboardRoutes {
  constructor(usecase, dashboards, openReturnsReport = null) {
    this.usecase = usecase;
    this.dashboards = dashboards;
    this.openReturnsReport = openReturnsReport;
    this.router = require("express").Router();
    this.init();
  }

  init() {
    this.router.get(
      "/summary",
      this.dashboards.requireDashboardAccess(DASHBOARD_PERMISSION.SALES),
      async (req, res) => {
        try {
          const result = await this.usecase.getSummary({
            from_date: req.query.from_date,
            to_date: req.query.to_date,
            refresh: String(req.query.refresh || "") === "1",
            store_ids: this.dashboards.storeIdsFor(req),
          });
          if (result.code !== 200) return res.status(result.code === 422 ? 422 : 400).json(result);
          res.json({ ...result, dashboard_scope: scopeForClient(req.dashboardScope) });
        } catch (err) {
          respondError(res, err);
        }
      }
    );

    // Debit notes and replacements raised in the period, and open returns now.
    this.router.get(
      "/purchase-returns",
      this.dashboards.requireDashboardAccess(DASHBOARD_PERMISSION.SALES),
      async (req, res) => {
        try {
          const result = await this.usecase.getPurchaseReturns({
            from_date: req.query.from_date,
            to_date: req.query.to_date,
            refresh: String(req.query.refresh || "") === "1",
            store_ids: this.dashboards.storeIdsFor(req),
          });
          if (result.code !== 200) return res.status(result.code === 422 ? 422 : 400).json(result);
          res.json({ ...result, dashboard_scope: scopeForClient(req.dashboardScope) });
        } catch (err) {
          respondError(res, err);
        }
      }
    );

    // The 9:15 am Open returns Telegram message: preview it, or send it now.
    this.router.get("/open-returns/message", requireAdmin, async (req, res) => {
      try {
        if (!this.openReturnsReport) return res.status(503).json({ code: 503, msg: "The open returns report is not available" });
        const r = await this.openReturnsReport.build();
        res.status(r.code === 200 ? 200 : 502).json(r);
      } catch (err) {
        respondError(res, err);
      }
    });
    this.router.post("/open-returns/send", requireAdmin, async (req, res) => {
      try {
        if (!this.openReturnsReport) return res.status(503).json({ code: 503, msg: "The open returns report is not available" });
        const r = await this.openReturnsReport.run({ trigger: "manual" });
        res.status(r.code === 200 ? 200 : [400, 409, 502].includes(r.code) ? r.code : 500).json(r);
      } catch (err) {
        respondError(res, err);
      }
    });
  }

  getRouter() {
    return this.router;
  }
}

module.exports = (usecase, dashboards, openReturnsReport) => new BusinessDashboardRoutes(usecase, dashboards, openReturnsReport);
