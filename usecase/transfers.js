const logger = require("../utils/logger");
const T = require("../utils/transfers");
const { storeResolver, scopeRows } = require("../utils/business_dashboard");

/** How long one RetailPilot answer is reused. */
const TTL_MS = 2 * 60 * 1000;
const CACHE_MAX = 100;

/**
 * Transfers (utils/transfers.js), live from RetailPilot runway. A transfer
 * belongs to the store it is going to: the caller's store scope narrows by
 * destination, on the list and on one transfer alike.
 */
class Transfers {
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
    if (!query) return { ok: true, rows: [], fetched_at: null };
    if (!this.spectra || !this.spectra.isConfigured()) {
      return { ok: false, error: "RetailPilot is not configured", rows: [] };
    }
    const hit = this.cache.get(key);
    if (!fresh && hit && this.now() - hit.at < TTL_MS) {
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
        component: "USECASE.TRANSFERS",
        code: `USECASE.TRANSFERS.${name.toUpperCase()}`,
        description: err.toString(),
        category: "",
        ref: { key },
      });
      return { ok: false, error: err.message, rows: [] };
    }
  }

  _visibleStores(stores, storeIds) {
    return [...stores.values()]
      .filter((s) => (storeIds === null || storeIds === undefined ? true : s.mapped && storeIds.map(Number).includes(s.outlet_id)))
      .sort((a, b) => Number(b.mapped) - Number(a.mapped) || a.name.localeCompare(b.name));
  }

  /**
   * Open transfers (no dates), or every one dispatched from_date..to_date,
   * each with what its store's verification found short.
   */
  async list({ from_date, to_date, refresh = false, store_ids = null } = {}) {
    const range = T.validRange(from_date, to_date);
    if (range && range.error) return { code: 422, msg: range.error };
    const key = range ? `transfers:${range.from}:${range.to}` : "transfers:open";
    const [branches, transfers] = await Promise.all([
      this.loadBranches(),
      this._read("transfers", key, T.buildTransfersQuery(range), refresh),
    ]);
    if (!transfers.ok) return { code: 502, msg: `RetailPilot: ${transfers.error}` };
    const { resolve, stores } = storeResolver(branches);
    const scoped = scopeRows(T.mapTransfers(transfers.rows, null, resolve), store_ids, stores);

    const slugs = scoped.map((t) => t.slug);
    const shortKey = `shortfalls:${slugs.slice().sort().join(",")}`;
    const shortfalls = await this._read("shortfalls", shortKey, T.buildShortfallsQuery(slugs), refresh);
    const byTransfer = shortfalls.ok ? T.mapShortfalls(shortfalls.rows) : new Map();
    const rows = scoped.map((t) => ({ ...t, short: byTransfer.get(t.slug) || null }));

    return {
      code: 200,
      data: {
        open_only: !range,
        from_date: range ? range.from : null,
        to_date: range ? range.to : null,
        fetched_at: transfers.fetched_at || null,
        shortfalls_error: shortfalls.ok ? null : shortfalls.error,
        stores: this._visibleStores(stores, store_ids),
        transfers: rows,
      },
    };
  }

  /** One transfer with its articles (per article, with boxes and batches). */
  async get({ slug, store_ids = null }) {
    const s = T.validId(slug);
    if (!s) return { code: 422, msg: "Invalid transfer" };
    const [branches, header, lines] = await Promise.all([
      this.loadBranches(),
      this._read("transfer", `transfer:${s}`, T.buildTransferQuery(s), true),
      this._read("lines", `lines:${s}`, T.buildLinesQuery(s), true),
    ]);
    if (!header.ok) return { code: 502, msg: `RetailPilot: ${header.error}` };
    const { resolve, stores } = storeResolver(branches);
    const [t] = scopeRows(T.mapTransfers(header.rows, null, resolve), store_ids, stores);
    // Not found and not yours read the same.
    if (!t) return { code: 404, msg: "Transfer not found" };

    let articles = [];
    let namesError = null;
    if (lines.ok) {
      const ids = [...new Set(lines.rows.map((l) => String(l.article_id == null ? "" : l.article_id).trim()).filter(Boolean))];
      const names = await this._read("article_names", `article_names:${s}`, T.buildArticleNamesQuery(ids), false);
      if (!names.ok) namesError = names.error;
      articles = T.articlesFromLines(lines.rows, names.ok ? names.rows : []);
    }
    const short = articles.reduce(
      (acc, a) => {
        if (a.short > 0) {
          acc.short_lines += 1;
          acc.returned_qty += a.short;
        }
        return acc;
      },
      { short_lines: 0, returned_qty: 0 }
    );
    const name = (key) => (stores.get(key) || {}).name || key;
    return {
      code: 200,
      data: {
        ...t,
        store_name: name(t.store),
        origin_name: name(t.origin),
        short: short.returned_qty > 0 ? short : null,
        articles,
        lines_error: lines.ok ? null : lines.error,
        article_names_error: namesError,
      },
    };
  }
}

module.exports = (spectra, loadBranches, now) => new Transfers(spectra, loadBranches, now);
