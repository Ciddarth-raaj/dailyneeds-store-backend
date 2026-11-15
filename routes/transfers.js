const { DASHBOARD_PERMISSION, scopeForClient } = require("../utils/dashboard_scope");
const respondError = require("../utils/http");

/**
 * Transfers (/transfers), live from RetailPilot. Read-only. Behind the
 * Business Dashboard's key, `view_sales_dashboard`, and the dashboard store
 * scope (a transfer belongs to the store it is going to).
 *
 *   GET /transfers?from_date&to_date&refresh   open ones, or those dispatched in the range
 *   GET /transfers/:slug                       one transfer with its articles
 */
class TransfersRoutes {
  constructor(usecase, dashboards) {
    this.usecase = usecase;
    this.dashboards = dashboards;
    this.router = require("express").Router();
    this.init();
  }

  init() {
    const guard = this.dashboards.requireDashboardAccess(DASHBOARD_PERMISSION.SALES);
    const send = (res, result, extra = {}) => {
      if (result.code === 200) return res.json({ ...result, ...extra });
      const status = [404, 422, 502].includes(result.code) ? result.code : 400;
      return res.status(status).json(result);
    };

    this.router.get("/", guard, async (req, res) => {
      try {
        const result = await this.usecase.list({
          from_date: req.query.from_date,
          to_date: req.query.to_date,
          refresh: String(req.query.refresh || "") === "1",
          store_ids: this.dashboards.storeIdsFor(req),
        });
        send(res, result, { dashboard_scope: scopeForClient(req.dashboardScope) });
      } catch (err) {
        respondError(res, err);
      }
    });

    this.router.get("/:slug", guard, async (req, res) => {
      try {
        send(res, await this.usecase.get({ slug: req.params.slug, store_ids: this.dashboards.storeIdsFor(req) }));
      } catch (err) {
        respondError(res, err);
      }
    });
  }

  getRouter() {
    return this.router;
  }
}

module.exports = (usecase, dashboards) => new TransfersRoutes(usecase, dashboards);
