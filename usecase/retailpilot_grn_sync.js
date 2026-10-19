const G = require("../utils/retailpilot_grn");

/**
 * Every 15 minutes: copy the warehouse's RetailPilot purchase invoices (GRNs)
 * into retailpilot_grn_headers / retailpilot_grn_lines, which the GRN pages
 * read.
 *
 * Each run takes RetailPilot's full GRN header list (a few hundred rows a
 * month) so GRNs deleted in RetailPilot drop out, and the lines of GRNs
 * entered or changed in the last LOOKBACK_DAYS days; the first run, with no
 * lines copied yet, takes every line. A synced GRN's lines are replaced, so
 * edited and removed lines carry over.
 */
const LOOKBACK_DAYS = 3;

class RetailPilotGrnSync {
  /**
   * @param getStoreId async () => the warehouse's RetailPilot store slug
   */
  constructor(spectra, grnRepo, getStoreId) {
    this.spectra = spectra;
    this.grnRepo = grnRepo;
    this.getStoreId = getStoreId;
    this.running = false;
  }

  async run() {
    if (!this.spectra.isConfigured()) {
      return { code: 400, message: "RetailPilot is not configured (RETAILPILOT_SPECTRA_URL / RETAILPILOT_SPECTRA_KEY)" };
    }
    if (this.running) return { code: 409, message: "A RetailPilot GRN sync is already running" };
    this.running = true;
    try {
      const store = await this.getStoreId();
      if (!store) {
        return { code: 400, message: "The GRN outlet has no RetailPilot store id in Branch Master" };
      }
      const full = (await this.grnRepo.countLines()) === 0;
      const days = full ? null : LOOKBACK_DAYS;

      const headers = (await this.spectra.queryAll(G.buildSyncHeadersQuery(store, null))).map(G.headerRow);
      // The invoices whose lines are replaced: those changed in the window
      // (read before the lines), including ones whose lines were all removed.
      const windowed = full
        ? headers.map((h) => h.invoice_slug)
        : (await this.spectra.queryAll(G.buildSyncHeadersQuery(store, days))).map((r) => r.invoice_slug);
      const lines = G.lineRows(await this.spectra.queryAll(G.buildSyncLinesQuery(store, days)));
      // Lines are kept only for GRNs whose header is stored.
      const known = new Set(headers.map((h) => h.invoice_slug));
      const keptLines = lines.filter((l) => known.has(l.invoice_slug) && l.line_id && l.product_id != null);

      const { removed } = await this.grnRepo.replaceHeaders(store, headers);
      await this.grnRepo.replaceLines(windowed.filter((s) => known.has(s)), keptLines);

      return {
        code: 200,
        message: `${headers.length} GRNs, ${keptLines.length} lines from ${windowed.length} GRNs${full ? " (full copy)" : ` changed in the last ${days} days`}${removed ? `, ${removed} removed` : ""}`,
        row_count: keptLines.length,
        grns: headers.length,
        grns_synced: windowed.length,
        grns_removed: removed,
        full,
      };
    } finally {
      this.running = false;
    }
  }
}

module.exports = (spectra, grnRepo, getStoreId) => new RetailPilotGrnSync(spectra, grnRepo, getStoreId);
