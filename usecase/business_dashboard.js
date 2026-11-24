const logger = require("../utils/logger");
const B = require("../utils/business_dashboard");
const PR = require("../utils/purchase_returns");

/** How long one RetailPilot answer is reused before it is asked again. */
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX = 50;

/**
 * Business Dashboard: Purchase, Sales, Sales Return, Purchase Return and
 * Stock per store, live from RetailPilot (utils/business_dashboard.js).
 *
 * Each section is fetched on its own: one that fails (a key not allowed to
 * read a table, a timeout) comes back as { ok: false, error } and the rest
 * still show.
 */
class BusinessDashboard {
  /**
   * @param salesSpectra   SPECTRA client for bills (sales key, product Mandapam)
   * @param runwaySpectra  SPECTRA client for invoices and stock (product runway)
   * @param loadBranches   async () => Branch Master rows with a RetailPilot ID
   */
  constructor(salesSpectra, runwaySpectra, loadBranches, now = () => Date.now()) {
    this.salesSpectra = salesSpectra;
    this.runwaySpectra = runwaySpectra;
    this.loadBranches = loadBranches;
    this.now = now;
    this.cache = new Map();
  }

  async _cached(key, fresh, load) {
    const hit = this.cache.get(key);
    if (!fresh && hit && this.now() - hit.at < CACHE_TTL_MS) return hit;
    const value = await load();
    const entry = { at: this.now(), value };
    this.cache.set(key, entry);
    if (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value);
    return entry;
  }

  async _section(name, spectra, key, query, fresh) {
    if (!spectra || !spectra.isConfigured()) {
      return { ok: false, error: "RetailPilot is not configured for this", rows: [] };
    }
    try {
      const entry = await this._cached(key, fresh, () => spectra.queryAll(query));
      return { ok: true, rows: entry.value, fetched_at: new Date(entry.at).toISOString() };
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.BUSINESS_DASHBOARD",
        code: `USECASE.BUSINESS_DASHBOARD.${name.toUpperCase()}`,
        description: err.toString(),
        category: "",
        ref: { key },
      });
      return { ok: false, error: err.message, rows: [] };
    }
  }

  /**
   * @param {{ from_date, to_date, refresh, store_ids }} params - store_ids is
   *   the caller's resolved scope: null = all stores, [ids] = those only.
   */
  async getSummary({ from_date, to_date, refresh = false, store_ids = null }) {
    const range = B.validRange(from_date, to_date);
    if (range.error) return { code: 422, msg: range.error };
    const { from, to } = range;

    const [branches, sales, purchases, stock, margin] = await Promise.all([
      this.loadBranches(),
      this._section("sales", this.salesSpectra, `sales|${from}|${to}`, B.buildSalesRangeQuery(from, to), refresh),
      this._section("purchases", this.runwaySpectra, `purchases|${from}|${to}`, B.buildPurchaseRangeQuery(from, to), refresh),
      this._section("stock", this.runwaySpectra, "stock", B.buildStockSummaryQuery(), refresh),
      this._section("margin", this.salesSpectra, `margin|${from}|${to}`, B.buildMarginRangeQuery(from, to), refresh),
    ]);

    const { resolve, stores } = B.storeResolver(branches);
    const salesRows = B.mapSalesRows(sales.rows, resolve);
    const purchaseMapped = B.mapPurchaseRows(purchases.rows, resolve);
    const stockRows = B.mapStockRows(stock.rows, resolve);
    const marginRows = B.mapMarginRows(margin.rows, resolve);

    const scoped = (rows) => B.scopeRows(rows, store_ids, stores);
    const visibleStores = [...stores.values()].filter((s) =>
      store_ids === null || store_ids === undefined ? true : s.mapped && store_ids.map(Number).includes(s.outlet_id)
    );
    const hasReturnType = purchaseMapped.invoice_types.some((t) => t.counted_as === "purchase_return");

    return {
      code: 200,
      data: {
        from_date: from,
        to_date: to,
        stores: visibleStores.sort((a, b) => Number(b.mapped) - Number(a.mapped) || a.name.localeCompare(b.name)),
        sales: { ok: sales.ok, error: sales.error || null, fetched_at: sales.fetched_at || null, rows: scoped(salesRows) },
        purchases: {
          ok: purchases.ok,
          error: purchases.error || null,
          fetched_at: purchases.fetched_at || null,
          rows: scoped(purchaseMapped.rows),
          // Which RetailPilot invoice types were seen and how each was counted.
          // Company-wide totals, so only an All Stores caller gets them.
          invoice_types: store_ids === null || store_ids === undefined ? purchaseMapped.invoice_types : [],
          purchase_return_found: hasReturnType,
        },
        stock: { ok: stock.ok, error: stock.error || null, fetched_at: stock.fetched_at || null, rows: scoped(stockRows) },
        margin: { ok: margin.ok, error: margin.error || null, fetched_at: margin.fetched_at || null, rows: scoped(marginRows) },
      },
    };
  }

  /**
   * Purchase returns (utils/purchase_returns.js): debit notes and
   * replacements raised in the period, and every open return now (not
   * affected by the period). Same store scope as getSummary.
   */
  async getPurchaseReturns({ from_date, to_date, refresh = false, store_ids = null }) {
    const range = B.validRange(from_date, to_date);
    if (range.error) return { code: 422, msg: range.error };
    const { from, to } = range;

    // Open returns are "now": cached for the same 5 minutes, refreshed with the rest.
    const [branches, settled, open] = await Promise.all([
      this.loadBranches(),
      this._section("pr_settled", this.runwaySpectra, `pr_settled|${from}|${to}`, PR.buildSettledQuery(from, to), refresh),
      this._section("pr_open", this.runwaySpectra, "pr_open", PR.buildOpenQuery(), refresh),
    ]);

    const { resolve, stores } = B.storeResolver(branches);
    const scoped = (rows) => B.scopeRows(rows, store_ids, stores);
    const settledRows = scoped(PR.mapSettledRows(settled.rows, resolve));
    const openAt = open.fetched_at ? Date.parse(open.fetched_at) : this.now();
    const openRows = scoped(PR.mapOpenRows(open.rows, resolve, openAt));
    const allStores = store_ids === null || store_ids === undefined;
    const visibleStores = [...stores.values()]
      .filter((s) => (allStores ? true : s.mapped && store_ids.map(Number).includes(s.outlet_id)))
      .sort((a, b) => Number(b.mapped) - Number(a.mapped) || a.name.localeCompare(b.name));

    return {
      code: 200,
      data: {
        from_date: from,
        to_date: to,
        stores: visibleStores,
        settled: {
          ok: settled.ok,
          error: settled.error || null,
          fetched_at: settled.fetched_at || null,
          rows: settledRows,
        },
        open: {
          ok: open.ok,
          error: open.error || null,
          fetched_at: open.fetched_at || null,
          rows: openRows,
        },
      },
    };
  }
}

module.exports = (salesSpectra, runwaySpectra, loadBranches, now) =>
  new BusinessDashboard(salesSpectra, runwaySpectra, loadBranches, now);
