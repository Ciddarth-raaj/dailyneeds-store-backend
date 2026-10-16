const logger = require("../utils/logger");
const { buildPurchaseQuery, mapPurchases } = require("../utils/retailpilot_purchase");

const MAX_DAYS = 90;

/**
 * Pulls purchase invoices from RetailPilot and saves them through the same
 * purchaseUsecase.bulkCreatePurchase the old GoFrugal push used.
 */
class RetailPilotPurchaseSync {
  constructor(spectra, purchaseUsecase, config) {
    this.spectra = spectra;
    this.purchaseUsecase = purchaseUsecase;
    this.config = config;
    this.running = false;
  }

  async run({ days, dryRun = false } = {}) {
    const lookback = days == null ? this.config.purchaseLookbackDays : Number(days);
    if (!Number.isInteger(lookback) || lookback < 0 || lookback > MAX_DAYS) {
      return { code: 400, message: `days must be an integer from 0 to ${MAX_DAYS}` };
    }
    if (!this.spectra.isConfigured()) {
      return { code: 400, message: "RetailPilot is not configured (RETAILPILOT_SPECTRA_URL / RETAILPILOT_SPECTRA_KEY)" };
    }
    if (this.running) {
      return { code: 409, message: "A RetailPilot purchase sync is already running" };
    }

    this.running = true;
    try {
      const rows = await this.spectra.queryAll(buildPurchaseQuery(lookback));
      const { purchases, skipped } = mapPurchases(rows, this.config.storeMap);
      const warnings = skipped.length
        ? [`${skipped.length} invoice(s) skipped: ${skipped.slice(0, 5).map((s) => `${s.invoice_slug} (${s.reason})`).join("; ")}`]
        : [];

      if (dryRun) {
        return { code: 200, dry_run: true, days: lookback, row_count: purchases.length, purchases, skipped, warnings };
      }

      const saved = purchases.length
        ? await this.purchaseUsecase.bulkCreatePurchase(purchases)
        : { insertedCount: 0, updatedCount: 0, unchangedCount: 0 };

      return {
        code: 200,
        days: lookback,
        row_count: purchases.length,
        inserted: saved.insertedCount,
        updated: saved.updatedCount,
        unchanged: saved.unchangedCount,
        skipped,
        warnings,
      };
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.RETAILPILOT_PURCHASE_SYNC",
        code: "USECASE.RETAILPILOT_PURCHASE_SYNC.RUN",
        description: err.toString(),
        category: "",
        ref: { days: lookback },
      });
      throw err;
    } finally {
      this.running = false;
    }
  }
}

module.exports = (spectra, purchaseUsecase, config) =>
  new RetailPilotPurchaseSync(spectra, purchaseUsecase, config);
