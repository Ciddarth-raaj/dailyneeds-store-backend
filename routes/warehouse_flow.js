const { DASHBOARD_PERMISSION, scopeForClient } = require("../utils/dashboard_scope");

/**
 * The Invoice pipeline's own key: its page (/dashboard/invoice-pipeline) for
 * staff who must not see the Business Dashboard's sales and margin.
 */
const VIEW_INVOICE_PIPELINE = "view_invoice_pipeline";
const respondError = require("../utils/http");

/**
 * Warehouse Flow (/warehouse-flow): the Invoice pipeline, shown on the
 * Business Dashboard and on its own page. Behind `view_sales_dashboard` OR
 * `view_invoice_pipeline`, and the dashboard store scope. Read-only, live from RetailPilot runway.
 *
 *   GET /flow                 every stage and what is in it now
 *   GET /gate-pass/:slug      one gate pass with its inspections
 *   GET /inspection/:slug     one inspection with its gate pass
 */
class WarehouseFlowRoutes {
  constructor(usecase, dashboards) {
    this.usecase = usecase;
    this.dashboards = dashboards;
    this.router = require("express").Router();
    this.init();
  }

  init() {
    // Either key opens it: the Business Dashboard shows the pipeline too.
    // The dashboard store scope applies the same way for both.
    const guard = this.dashboards.requireDashboardAccess([DASHBOARD_PERMISSION.SALES, VIEW_INVOICE_PIPELINE]);
    const send = (res, result, extra = {}) => {
      if (result.code === 200) return res.json({ ...result, ...extra });
      const status = [404, 422, 502].includes(result.code) ? result.code : 400;
      return res.status(status).json(result);
    };

    this.router.get("/flow", guard, async (req, res) => {
      try {
        const result = await this.usecase.getFlow({
          refresh: String(req.query.refresh || "") === "1",
          store_ids: this.dashboards.storeIdsFor(req),
        });
        send(res, result, { dashboard_scope: scopeForClient(req.dashboardScope) });
      } catch (err) {
        respondError(res, err);
      }
    });

    this.router.get("/inspection/:slug", guard, async (req, res) => {
      try {
        send(res, await this.usecase.getInspection({ slug: req.params.slug, store_ids: this.dashboards.storeIdsFor(req) }));
      } catch (err) {
        respondError(res, err);
      }
    });

    this.router.get("/gate-pass/:slug", guard, async (req, res) => {
      try {
        send(res, await this.usecase.getGatePass({ slug: req.params.slug, store_ids: this.dashboards.storeIdsFor(req) }));
      } catch (err) {
        respondError(res, err);
      }
    });
  }

  getRouter() {
    return this.router;
  }
}

module.exports = (usecase, dashboards) => new WarehouseFlowRoutes(usecase, dashboards);
module.exports.VIEW_INVOICE_PIPELINE = VIEW_INVOICE_PIPELINE;
