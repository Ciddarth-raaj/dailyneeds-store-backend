const logger = require("../utils/logger");
const { buildPurchaseQuery, mapPurchases } = require("../utils/retailpilot_purchase");

const MAX_DAYS = 90;

/**
 * Pulls purchase invoices from RetailPilot and saves them through the same
 * purchaseUsecase.bulkCreatePurchase the old GoFrugal push used.
 */
class RetailPilotPurchaseSync {
  /**
   * @param loadStoreMap async () => { [retailpilot store slug]: outlet_id }
   *   from Branch Master (outletUsecase.getRetailPilotStoreMap), read on
   *   every run so an edit there applies to the next sync. It is the only
   *   source of the mapping.
   */
  constructor(spectra, purchaseUsecase, config, loadStoreMap) {
    this.spectra = spectra;
    this.purchaseUsecase = purchaseUsecase;
    this.config = config;
    this.loadStoreMap = loadStoreMap;
    this.running = false;
  }

  async _storeMap() {
    return this.loadStoreMap ? (await this.loadStoreMap()) || {} : {};
  }

  /**
   * The reference is RetailPilot's seq, so it can coincide with an older
   * (GoFrugal) purchase's mmh_mrc_refno at the same outlet. Saving would then
   * overwrite that bill; a clash is skipped and reported instead. The same
   * bill coming back (same GSTIN and bill number) is not a clash.
   */
  async _withoutRefnoClashes(purchases, skipped) {
    if (!purchases.length || typeof this.purchaseUsecase.findByOutletRefnos !== "function") {
      return purchases;
    }
    const existing = await this.purchaseUsecase.findByOutletRefnos(
      purchases.map((p) => [p.STORE_ID, p.MRC_REF])
    );
    const norm = (v) => String(v == null ? "" : v).trim().toUpperCase();
    const byKey = new Map(existing.map((r) => [`${r.retail_outlet_id}|${norm(r.mmh_mrc_refno)}`, r]));
    return purchases.filter((p) => {
      const row = byKey.get(`${p.STORE_ID}|${norm(p.MRC_REF)}`);
      if (!row) return true;
      if (norm(row.supplier_gstn) === norm(p.SUPPLIER_GSTN) && norm(row.mmh_dist_bill_no) === norm(p.DIST_BILL_NO)) {
        return true;
      }
      skipped.push({
        invoice_slug: p.RP_INVOICE_SLUG,
        reason: `MRC ref ${p.MRC_REF} already belongs to purchase ${row.purchase_id} (bill ${row.mmh_dist_bill_no}, GSTIN ${row.supplier_gstn || "-"}) at this outlet`,
      });
      return false;
    });
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
      const storeMap = await this._storeMap();
      if (Object.keys(storeMap).length === 0) {
        return {
          code: 400,
          message: "No branch has a RetailPilot ID. Set it in Branch Master before syncing.",
        };
      }
      const rows = await this.spectra.queryAll(buildPurchaseQuery(lookback));
      const mapped = mapPurchases(rows, storeMap);
      const skipped = mapped.skipped;
      const purchases = await this._withoutRefnoClashes(mapped.purchases, skipped);
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

module.exports = (spectra, purchaseUsecase, config, loadStoreMap) =>
  new RetailPilotPurchaseSync(spectra, purchaseUsecase, config, loadStoreMap);
