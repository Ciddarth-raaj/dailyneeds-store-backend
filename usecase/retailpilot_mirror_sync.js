const logger = require("../utils/logger");
const { TABLES, TAXONOMY_QUERY, LOOKBACK_DAYS, addTaxonomy } = require("../utils/retailpilot_mirror");

/**
 * Copies RetailPilot's item, hierarchy, store, vendor, batch, stock and
 * selling-price tables into our rp_* tables (utils/retailpilot_mirror.js).
 * One table failing is recorded in rp_sync_state and reported; the others
 * still run, and a failed full-refresh table keeps yesterday's rows.
 */
class RetailPilotMirrorSync {
  constructor(spectra, mirrorRepo) {
    this.spectra = spectra;
    this.mirrorRepo = mirrorRepo;
  }

  /**
   * @param dryRun read from RetailPilot and count, write nothing
   * @param full re-read the incremental tables in full too
   * @returns { code, tables: { [table]: { mode, read, written, removed, error } } }
   */
  async run({ dryRun = false, full = false } = {}) {
    const runId = `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 17)}${Math.random().toString(36).slice(2, 8)}`;
    const state = dryRun ? {} : await this.mirrorRepo.getState();
    const tables = {};

    let taxonomy = null;
    for (const spec of TABLES) {
      const incremental = spec.mode === "incremental" && !full && state[spec.table] && state[spec.table].last_full_at;
      const result = { mode: incremental ? `last ${LOOKBACK_DAYS} days` : "full", read: 0, written: 0, removed: 0, skipped: 0 };
      tables[spec.table] = result;
      try {
        if (spec.needsTaxonomy && !taxonomy) {
          taxonomy = new Map();
          await this.spectra.queryEach(TAXONOMY_QUERY, (rows) => addTaxonomy(taxonomy, rows));
        }
        const ctx = { taxonomy };
        result.read = await this.spectra.queryEach(spec.query(incremental ? LOOKBACK_DAYS : null), async (page) => {
          const rows = [];
          for (const r of page) {
            const m = spec.map(r, ctx);
            if (m) rows.push(m);
            else result.skipped += 1;
          }
          if (!dryRun) await this.mirrorRepo.upsert(spec, rows, runId);
          result.written += rows.length;
        });
        // A full refresh that read nothing is far more likely a RetailPilot
        // problem than an empty table: keep what we have.
        if (!dryRun && spec.mode === "full" && result.read > 0) {
          result.removed = await this.mirrorRepo.deleteNotInRun(spec.table, runId);
        }
        if (!dryRun) await this.mirrorRepo.saveState(spec.table, { rows: result.written, full: !incremental });
      } catch (err) {
        result.error = err.message;
        logger.Log({
          level: logger.LEVEL.ERROR,
          component: "USECASE.RETAILPILOT_MIRROR_SYNC",
          code: "USECASE.RETAILPILOT_MIRROR_SYNC.TABLE",
          description: err.toString(),
          category: "",
          ref: { table: spec.table },
        });
        if (!dryRun) {
          await this.mirrorRepo.saveState(spec.table, { rows: result.written, error: err.message.slice(0, 2000) }).catch(() => {});
        }
      }
    }

    const failed = Object.entries(tables).filter(([, t]) => t.error).map(([name]) => name);
    return { code: failed.length ? 207 : 200, dry_run: dryRun, run_id: runId, failed, tables };
  }
}

module.exports = (spectra, mirrorRepo) => new RetailPilotMirrorSync(spectra, mirrorRepo);
