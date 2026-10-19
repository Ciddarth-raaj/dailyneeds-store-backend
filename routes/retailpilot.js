const router = require("express").Router();
const respondError = require("../utils/http");

/**
 * The RetailPilot Sync page: when each RetailPilot sync last ran, whether it
 * is running now, and manual starts for the stock & price sync and the GRN
 * sync. The product and purchase syncs keep their own endpoints
 * (POST /product/sync, POST /purchase/retailpilot-sync).
 */
const SYNCS = [
  {
    key: "grn",
    log_type: "retailpilot_grn_sync",
    label: "GRNs",
    description: "Warehouse purchase invoices into the GRN pages",
    schedule: (c) => (c.grnSyncEnabled ? "Every 15 minutes" : "Not scheduled"),
    permission: "sync_retailpilot_purchases",
  },
  {
    key: "stock",
    log_type: "retailpilot_stock_sync",
    label: "Stock & Prices",
    description: "Products, then Offers V3 price and stock, then the Price Checker",
    schedule: (c) => (c.stockSyncEnabled ? "Daily 6:00 AM" : "Not scheduled"),
    permission: "sync_retailpilot_stock",
  },
  {
    key: "products",
    log_type: "product_sync",
    label: "Products",
    description: "Product master: new items, names, departments, categories, subcategories, brands",
    schedule: (c) => (c.stockSyncEnabled ? "Daily 6:00 AM (with Stock & Prices)" : "Not scheduled"),
    permission: "allow_product_sync",
  },
  {
    key: "purchases",
    log_type: "retailpilot_purchase_sync",
    label: "Purchases",
    description: "Purchase invoices into the Purchase screen",
    schedule: (c) => (c.purchaseSyncEnabled ? "Daily 9:00 AM, 2:00 PM, 5:00 PM" : "Not scheduled"),
    permission: "sync_retailpilot_purchases",
  },
];

class RetailPilotRoutes {
  /**
   * @param deps { apiSyncLogRepo, config, isRunning: { [key]: () => boolean },
   *   startStockSync / startGrnSync: (employeeId) => { started, msg }, permissions }
   */
  constructor(deps) {
    this.deps = deps;
    this.init();
  }

  async _lastRun(logType, status) {
    const rows = await this.deps.apiSyncLogRepo.getLogs({ log_type: logType, limit: status ? 20 : 1 });
    const row = status ? rows.find((r) => r.status === status) : rows[0];
    if (!row) return null;
    return {
      at: row.created_at,
      status: row.status,
      source: row.source,
      duration_ms: row.duration_ms,
      row_count: row.row_count,
      error_message: row.error_message,
    };
  }

  init() {
    router.get("/status", async (req, res) => {
      try {
        const syncs = [];
        for (const s of SYNCS) {
          syncs.push({
            key: s.key,
            label: s.label,
            description: s.description,
            schedule: s.schedule(this.deps.config),
            permission: s.permission,
            running: Boolean(this.deps.isRunning[s.key] && this.deps.isRunning[s.key]()),
            last_run: await this._lastRun(s.log_type),
            last_success: await this._lastRun(s.log_type, "success"),
          });
        }
        res.json({ code: 200, data: syncs });
      } catch (err) {
        respondError(res, err);
      }
    });

    const requirePermission = (name) =>
      this.deps.permissions
        ? this.deps.permissions.require(name)
        : (req, res) => res.status(403).json({ code: 403, msg: "You do not have permission to perform this action" });
    const startRoute = (path, permission, start) =>
      router.post(path, requirePermission(permission), async (req, res) => {
        try {
          const result = start(req.decoded?.employee_id ?? null);
          res.json(result.started ? { code: 200, ...result } : { code: 409, ...result });
        } catch (err) {
          respondError(res, err);
        }
      });
    startRoute("/stock-sync", "sync_retailpilot_stock", (id) => this.deps.startStockSync(id));
    startRoute("/grn-sync", "sync_retailpilot_purchases", (id) => this.deps.startGrnSync(id));
  }

  getRouter() {
    return router;
  }
}

module.exports = (deps) => new RetailPilotRoutes(deps);
