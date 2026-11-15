const logger = require("../utils/logger");
const W = require("../utils/warehouse_flow");
const { storeResolver, scopeRows } = require("../utils/business_dashboard");

/** How long one RetailPilot answer is reused. Vendors change rarely. */
const TTL_MS = { default: 2 * 60 * 1000, vendors: 60 * 60 * 1000 };
const CACHE_MAX = 100;

const inScope = (storeIds) => storeIds === null || storeIds === undefined;

/**
 * Warehouse Flow (utils/warehouse_flow.js), live from RetailPilot runway.
 * Every list and every detail is narrowed to the caller's store scope.
 */
class WarehouseFlow {
  /**
   * @param spectra       SPECTRA client for runway
   * @param loadBranches  async () => Branch Master rows with a RetailPilot ID
   */
  constructor(spectra, loadBranches, now = () => Date.now()) {
    this.spectra = spectra;
    this.loadBranches = loadBranches;
    this.now = now;
    this.cache = new Map();
  }

  async _read(name, key, query, fresh) {
    if (!this.spectra || !this.spectra.isConfigured()) {
      return { ok: false, error: "RetailPilot is not configured", rows: [] };
    }
    const ttl = TTL_MS[name] || TTL_MS.default;
    const hit = this.cache.get(key);
    if (!fresh && hit && this.now() - hit.at < ttl) {
      return { ok: true, rows: hit.rows, fetched_at: new Date(hit.at).toISOString() };
    }
    try {
      const rows = await this.spectra.queryAll(query);
      const at = this.now();
      this.cache.set(key, { at, rows });
      if (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value);
      return { ok: true, rows, fetched_at: new Date(at).toISOString() };
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.WAREHOUSE_FLOW",
        code: `USECASE.WAREHOUSE_FLOW.${name.toUpperCase()}`,
        description: err.toString(),
        category: "",
        ref: { key },
      });
      return { ok: false, error: err.message, rows: [] };
    }
  }

  _visibleStores(stores, storeIds) {
    return [...stores.values()]
      .filter((s) => (inScope(storeIds) ? true : s.mapped && storeIds.map(Number).includes(s.outlet_id)))
      .sort((a, b) => Number(b.mapped) - Number(a.mapped) || a.name.localeCompare(b.name));
  }

  /** Every stage with what is in it now. Only built stages are read. */
  async getFlow({ refresh = false, store_ids = null } = {}) {
    const [branches, passes, vendors] = await Promise.all([
      this.loadBranches(),
      this._read("gate_passes", "gate_passes:open", W.buildOpenGatePassesQuery(), refresh),
      this._read("vendors", "vendors", W.buildVendorNamesQuery(), false),
    ]);
    const { resolve, stores } = storeResolver(branches);
    // Ages run from when the list was read, so a cached list is not younger than it is.
    const at = passes.fetched_at ? Date.parse(passes.fetched_at) : this.now();
    const gateRows = scopeRows(W.mapGatePassRows(passes.rows, vendors.rows, resolve, at), store_ids, stores);

    return {
      code: 200,
      data: {
        stores: this._visibleStores(stores, store_ids),
        stages: W.STAGES.map((s) =>
          s.key === "gate_pass"
            ? { ...s, ok: passes.ok, error: passes.error || null, fetched_at: passes.fetched_at || null, rows: gateRows }
            : { ...s, ok: false, error: null, rows: [] }
        ),
      },
    };
  }

  /** One gate pass, open or closed, with its inspections and their line totals. */
  async getGatePass({ slug, store_ids = null }) {
    const s = W.validSlug(slug);
    if (!s) return { code: 422, msg: "Invalid gate pass" };
    const [branches, pass, vendors] = await Promise.all([
      this.loadBranches(),
      this._read("gate_pass", `gate_pass:${s}`, W.buildGatePassQuery(s), true),
      this._read("vendors", "vendors", W.buildVendorNamesQuery(), false),
    ]);
    if (!pass.ok) return { code: 502, msg: `RetailPilot: ${pass.error}` };
    const { resolve, stores } = storeResolver(branches);
    const [gp] = scopeRows(W.mapGatePassRows(pass.rows, vendors.rows, resolve, this.now()), store_ids, stores);
    // Not found and not yours read the same: the answer never says a pass exists elsewhere.
    if (!gp) return { code: 404, msg: "Gate pass not found" };

    let totalsError = null;
    const q = W.buildInspectionTotalsQuery(gp.inspections.map((i) => i.slug));
    if (q) {
      const totals = await this._read("inspection_totals", `inspection_totals:${s}`, q, true);
      if (totals.ok) {
        const bySlug = W.mapInspectionTotals(totals.rows);
        gp.inspections = gp.inspections.map((i) => ({ ...i, totals: bySlug.get(i.slug) || null }));
      } else {
        totalsError = totals.error;
      }
    }
    const store = stores.get(gp.store);
    return {
      code: 200,
      data: { ...gp, store_name: store ? store.name : gp.store, inspection_totals_error: totalsError },
    };
  }
}

module.exports = (spectra, loadBranches, now) => new WarehouseFlow(spectra, loadBranches, now);
