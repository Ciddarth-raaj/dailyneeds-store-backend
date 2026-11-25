const router = require("express").Router();
const respondError = require("../utils/http");
const { getNextCronRun } = require("../utils/api_sync_log_helpers");

/**
 * The RetailPilot Sync page: when each RetailPilot sync last ran, whether it
 * is running now, and manual starts for the stock & price sync, the GRN
 * sync and the Article Store Master build. The product, purchase and debit
 * note syncs keep their own endpoints (POST /product/sync,
 * POST /purchase/retailpilot-sync, POST /debit-note/retailpilot-sync).
 */
const SYNCS = [
  {
    key: "grn",
    log_type: "retailpilot_grn_sync",
    label: "GRNs",
    description: "Warehouse purchase invoices into the GRN pages",
    schedule: (c) => (c.grnSyncEnabled ? "Every 15 minutes" : "Not scheduled"),
    crons: (c) => (c.grnSyncEnabled ? ["*/15 * * * *"] : []),
    permission: "sync_retailpilot_purchases",
  },
  {
    key: "stock",
    log_type: "retailpilot_stock_sync",
    label: "Stock & Prices",
    description: "Products, then Offers V3 price and stock, then the Price Checker",
    schedule: (c) => (c.stockSyncEnabled ? "Daily 6:00 AM" : "Not scheduled"),
    crons: (c) => (c.stockSyncEnabled ? ["0 6 * * *"] : []),
    permission: "sync_retailpilot_stock",
  },
  {
    key: "products",
    log_type: "product_sync",
    label: "Products",
    description: "Product master: new items, names, departments, categories, subcategories, brands",
    schedule: (c) => (c.stockSyncEnabled ? "Daily 6:00 AM (with Stock & Prices)" : "Not scheduled"),
    crons: (c) => (c.stockSyncEnabled ? ["0 6 * * *"] : []),
    // The scheduled product sync runs inside the 6:00 Stock & Prices run,
    // which logs under its own type; product_sync rows are manual runs.
    scheduled_log_type: "retailpilot_stock_sync",
    permission: "allow_product_sync",
  },
  {
    key: "purchases",
    log_type: "retailpilot_purchase_sync",
    label: "Purchases",
    description: "Purchase invoices into the Purchase screen",
    schedule: (c) => (c.purchaseSyncEnabled ? "Daily 9:00 AM, 2:00 PM, 5:00 PM" : "Not scheduled"),
    crons: (c) => (c.purchaseSyncEnabled ? ["0 9,14,17 * * *"] : []),
    permission: "sync_retailpilot_purchases",
  },
  {
    key: "debit_notes",
    log_type: "retailpilot_debit_note_sync",
    label: "Debit Notes",
    description: "Debit notes into the Debit Note screen",
    schedule: (c) => (c.debitNoteSyncEnabled ? "Daily 9:00 AM, 2:00 PM, 5:00 PM" : "Not scheduled"),
    crons: (c) => (c.debitNoteSyncEnabled ? ["0 9,14,17 * * *"] : []),
    permission: "sync_retailpilot_purchases",
  },
  {
    key: "article_store_master",
    log_type: "article_store_master_report",
    label: "Article Store Master",
    description: "The Article Store Master report (catalogue and store stock) for download",
    schedule: (c) => (c.articleStoreMasterEnabled ? "Daily 5:45 AM" : "Not scheduled"),
    crons: (c) => (c.articleStoreMasterEnabled ? ["45 5 * * *"] : []),
    permission: "view_products",
  },
];

/** The soonest next run (ISO) of a list of cron expressions, IST; null if none. */
function nextRun(crons, from = new Date()) {
  const times = crons.map((c) => getNextCronRun(c, from)).filter(Boolean);
  if (!times.length) return null;
  return new Date(Math.min(...times.map((t) => t.getTime()))).toISOString();
}

class RetailPilotRoutes {
  /**
   * @param deps { apiSyncLogRepo, config, isRunning: { [key]: () => boolean },
   *   startStockSync / startGrnSync / startArticleStoreMaster: (employeeId) => { started, msg },
   *   permissions }
   */
  constructor(deps) {
    this.deps = deps;
    this.init();
  }

  async _lastRun(logType, status, source) {
    const rows = await this.deps.apiSyncLogRepo.getLogs({ log_type: logType, source, limit: status ? 20 : 1 });
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
            // The page leads with the schedule: the last run the cron made
            // and when it runs next (a manual "Sync now" is not a schedule).
            last_scheduled: await this._lastRun(s.scheduled_log_type || s.log_type, null, "cron"),
            next_run: nextRun(s.crons ? s.crons(this.deps.config) : []),
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
    startRoute("/article-store-master-sync", "view_products", (id) => this.deps.startArticleStoreMaster(id));
  }

  getRouter() {
    return router;
  }
}

module.exports = (deps) => new RetailPilotRoutes(deps);
module.exports.nextRun = nextRun;
