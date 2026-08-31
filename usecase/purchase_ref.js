const logger = require("../utils/logger");

/**
 * How long a built Purchase Ref list is served without rebuilding.
 *
 * The list is derived from three slow, wide sources — 3 months of
 * product_sales, the GoFrugal GRN history, and the latest daily stock-holding
 * snapshot — none of which change more than a few times a day (product sync
 * 4am, stock holding 7:30am, GRN sync through the day). Rebuilding it on every
 * page view was the reason the page took tens of seconds to load.
 */
const CACHE_TTL_MS =
  Number(process.env.PURCHASE_REF_CACHE_TTL_MS) || 30 * 60 * 1000;

/**
 * Past this age a cached list is no longer served while rebuilding. Without it,
 * a build that keeps failing (GoFrugal DB down, say) would leave the page
 * quietly showing hours-old numbers instead of surfacing the error.
 */
const MAX_STALE_MS = CACHE_TTL_MS * 6;

class PurchaseRefUsecase {
  constructor(
    purchaseRefRepo,
    productSalesRepo,
    stockReceivedRepo,
    stockHoldingReportRepo
  ) {
    this.purchaseRefRepo = purchaseRefRepo;
    this.productSalesRepo = productSalesRepo;
    this.stockReceivedRepo = stockReceivedRepo;
    this.stockHoldingReportRepo = stockHoldingReportRepo;

    /** @type {{ rows: object[], builtAt: number }|null} */
    this._cache = null;
    /** @type {Promise<object[]>|null} in-flight build, shared by all callers */
    this._building = null;
  }

  /**
   * Products with sales in the trailing 3 months, each with their average
   * monthly sales, latest GRN MRP/net cost, assigned supplier name, and
   * current stock (summed across outlets, from the latest daily snapshot).
   *
   * Served from cache when fresh. A stale cache is returned immediately and
   * refreshed in the background, so only the very first caller after a restart
   * waits for the full build.
   */
  async listPurchaseRef({ force = false } = {}) {
    const cached = this._cache;
    const age = cached ? Date.now() - cached.builtAt : Infinity;

    if (!force && cached && age < CACHE_TTL_MS) {
      return this._served(cached);
    }

    if (!force && cached && age < MAX_STALE_MS) {
      // Stale: hand back what we have and rebuild behind the request.
      this._startBuild().catch(() => {
        /* already logged in _build */
      });
      return this._served(cached);
    }

    await this._startBuild();
    return this._served(this._cache);
  }

  /**
   * Callers share the cached array rather than a copy — nothing downstream
   * mutates it, and copying ~14k rows per request would undo the point.
   */
  _served(entry) {
    return {
      rows: entry.rows,
      built_at: new Date(entry.builtAt).toISOString(),
    };
  }

  /**
   * Rebuild the cache now, ignoring its age. Used by the daily cron warm-up so
   * the first user of the day doesn't pay for the build.
   */
  async refresh() {
    return this._startBuild();
  }

  /** Single-flight wrapper: concurrent callers share one build. */
  _startBuild() {
    if (!this._building) {
      this._building = this._build()
        .then((rows) => {
          this._cache = { rows, builtAt: Date.now() };
          return rows;
        })
        .finally(() => {
          this._building = null;
        });
    }
    return this._building;
  }

  async _build() {
    try {
      const avgSalesRows = await this.productSalesRepo.listAvgSalesLast3Months();
      const productIds = avgSalesRows.map((row) => row.product_id);

      const [productMap, grnPricingMap, currentStockMap] = await Promise.all([
        this.purchaseRefRepo.listProductsWithSupplierByIds(productIds),
        this.stockReceivedRepo.listLatestGrnPricingByProduct(productIds),
        this.stockHoldingReportRepo.getCurrentStockTotalsByDate(new Date()),
      ]);

      return avgSalesRows.map((row) => {
        const product = productMap.get(row.product_id) || null;
        const pricing = grnPricingMap.get(row.product_id) || null;
        return {
          product_id: row.product_id,
          name: product?.name ?? null,
          image_url: product?.image_link ?? null,
          supplier_name: product?.supplier_name ?? null,
          mrp: pricing?.mrp ?? null,
          net_cost: pricing?.net_cost ?? null,
          avg_sales: row.avg_sales,
          current_stock: currentStockMap.has(row.product_id)
            ? currentStockMap.get(row.product_id)
            : null,
        };
      });
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.PURCHASE_REF",
        code: "USECASE.PURCHASE_REF.LIST",
        description: err.toString(),
        category: "",
        ref: {},
      });
      throw err;
    }
  }
}

module.exports = (
  purchaseRefRepo,
  productSalesRepo,
  stockReceivedRepo,
  stockHoldingReportRepo
) =>
  new PurchaseRefUsecase(
    purchaseRefRepo,
    productSalesRepo,
    stockReceivedRepo,
    stockHoldingReportRepo
  );

module.exports.PurchaseRefUsecase = PurchaseRefUsecase;
