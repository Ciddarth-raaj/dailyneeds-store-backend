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

  /**
   * Every stage with what is in it now (utils/warehouse_flow.js classifyFlow),
   * plus the lists that need somebody to act. Each source is read on its own:
   * a stage whose source fails says so and the others still show.
   */
  async getFlow({ refresh = false, store_ids = null } = {}) {
    const [branches, passes, inspections, documents, allocations, vendors] = await Promise.all([
      this.loadBranches(),
      this._read("gate_passes", "gate_passes:open", W.buildOpenGatePassesQuery(), refresh),
      this._read("inspections", "inspections:active", W.buildActiveInspectionsQuery(), refresh),
      this._read("documents", "documents:active", W.buildDocumentsQuery(), refresh),
      this._read("allocations", "allocations:active", W.buildAllocationQuery(), refresh),
      this._read("vendors", "vendors", W.buildVendorNamesQuery(), false),
    ]);
    const { resolve, stores } = storeResolver(branches);
    const at = passes.fetched_at ? Date.parse(passes.fetched_at) : this.now();
    const lists = W.classifyFlow(
      W.mapGatePassRows(passes.rows, vendors.rows, resolve, at),
      W.mapInspectionRows(inspections.rows, vendors.rows, resolve),
      W.mapDocumentRows(documents.rows, vendors.rows, resolve)
    );
    lists.allocation = W.mapAllocationRows(allocations.rows, vendors.rows, resolve);
    // Which read each list depends on, so a failure is reported where it shows.
    // A list is only as good as every read it is built from: the first that
    // failed is what it reports.
    const needs = {
      gate_pass: [passes, documents],
      inspection: [inspections],
      grn: [documents, passes],
      allocation: [allocations],
      no_invoice: [passes, documents],
      written_off: [inspections],
    };
    const source = {};
    Object.keys(needs).forEach((k) => {
      source[k] = needs[k].find((r) => !r.ok) || needs[k][0];
    });
    const section = (def) => {
      const src = source[def.key];
      return {
        ...def,
        ok: src.ok,
        error: src.error || null,
        fetched_at: src.fetched_at || null,
        rows: scopeRows(lists[def.key] || [], store_ids, stores),
      };
    };

    return {
      code: 200,
      data: {
        stores: this._visibleStores(stores, store_ids),
        stages: W.STAGES.map((def) => (def.built ? section(def) : { ...def, ok: false, error: null, rows: [] })),
        attention: W.ATTENTION.map(section),
      },
    };
  }

  /** One inspection, with its line totals and its gate pass when it has one. */
  async getInspection({ slug, store_ids = null }) {
    const s = W.validSlug(slug);
    if (!s) return { code: 422, msg: "Invalid inspection" };
    const [branches, insp, vendors] = await Promise.all([
      this.loadBranches(),
      this._read("inspection", `inspection:${s}`, W.buildInspectionQuery(s), true),
      this._read("vendors", "vendors", W.buildVendorNamesQuery(), false),
    ]);
    if (!insp.ok) return { code: 502, msg: `RetailPilot: ${insp.error}` };
    const { resolve, stores } = storeResolver(branches);
    const [row] = scopeRows(W.mapInspectionRows(insp.rows, vendors.rows, resolve), store_ids, stores);
    if (!row) return { code: 404, msg: "Inspection not found" };

    const totals = await this._read("inspection_totals", `inspection_totals:i:${s}`, W.buildInspectionTotalsQuery([s]), true);
    const store = stores.get(row.store);
    return {
      code: 200,
      data: {
        ...row,
        store_name: store ? store.name : row.store,
        totals: totals.ok ? W.mapInspectionTotals(totals.rows).get(s) || null : null,
        inspection_totals_error: totals.ok ? null : totals.error,
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

    const docs = await this._read("gate_pass_documents", `gate_pass_documents:${s}`, W.buildGatePassDocumentsQuery(s), true);
    gp.documents = docs.ok ? W.mapDocumentRows(docs.rows, vendors.rows, resolve).filter((d) => !d.dropped) : [];
    gp.documents_error = docs.ok ? null : docs.error;

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
