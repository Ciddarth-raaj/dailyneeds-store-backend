const { DASHBOARD_PERMISSION, scopeForClient } = require("../utils/dashboard_scope");
const respondError = require("../utils/http");

/**
 * Business Dashboard (/business-dashboard). Read-only, live from RetailPilot.
 *
 * Behind `view_sales_dashboard` and the shared dashboard store scope: an Own
 * Store caller gets their branch's figures only, decided on the server.
 */
class BusinessDashboardRoutes {
  constructor(usecase, dashboards) {
    this.usecase = usecase;
    this.dashboards = dashboards;
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
  }

  getRouter() {
    return this.router;
  }
}

module.exports = (usecase, dashboards) => new BusinessDashboardRoutes(usecase, dashboards);
