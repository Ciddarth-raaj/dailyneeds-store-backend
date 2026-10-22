const logger = require("../utils/logger");
const { QUERIES, supplierRows, supplierByArticle } = require("../utils/retailpilot_suppliers");

/**
 * Suppliers from RetailPilot (utils/retailpilot_suppliers.js): masterhub's
 * vendors become DNDS's supplier list, and each product's supplier follows
 * RetailPilot. Daily, after the article sync; by hand from the Distributors
 * page, with a dry run that changes nothing.
 */
class RetailPilotSupplierSync {
  constructor(masterhub, repo) {
    this.masterhub = masterhub;
    this.repo = repo;
    this.running = null;
  }

  run(options = {}) {
    if (this.running) return Promise.resolve({ code: 409, msg: "A RetailPilot supplier sync is already running" });
    this.running = this._run(options).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  async _run({ dryRun = false, scheduled = false } = {}) {
    try {
      // The first switch (old suppliers deleted or hidden) is made by a
      // person from the Distributors page, after a dry run - never by the
      // schedule. Until then the daily run does nothing.
      if (scheduled && (await this.repo.countRetailPilotSuppliers()) === 0) {
        return { code: 200, skipped: "The first switch to RetailPilot suppliers is made by hand from the Distributors page" };
      }
      if (!this.masterhub.isConfigured()) {
        return { code: 400, msg: "RetailPilot is not configured (RETAILPILOT_SPECTRA_URL / RETAILPILOT_SPECTRA_KEY)" };
      }
      const vendors = await this.masterhub.queryAll(QUERIES.vendors, 2000);
      const articleSuppliers = await this.masterhub.queryAll(QUERIES.articleSuppliers, 2000);
      const stores = await this.masterhub.queryAll(QUERIES.stores, 2000);

      const { rows, skipped } = supplierRows(vendors);
      const supplierOf = supplierByArticle(articleSuppliers, stores, new Set(rows.map((r) => r.cid)));
      const result = await this.repo.apply(rows, supplierOf, { dryRun });
      return { ...result, vendors_skipped: skipped };
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.RETAILPILOT_SUPPLIER_SYNC",
        code: "USECASE.RETAILPILOT_SUPPLIER_SYNC.RUN",
        description: err.toString(),
        category: "",
        ref: { dryRun },
      });
      return { code: 502, msg: err.message };
    }
  }
}

module.exports = (masterhub, repo) => new RetailPilotSupplierSync(masterhub, repo);
