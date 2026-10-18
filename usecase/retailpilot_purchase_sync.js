const logger = require("../utils/logger");
const { financialYearBounds } = require("../utils/financial_year");

/** YYYY-MM-DD from a DATE column (a Date object or a string). */
function dateOnlyString(value) {
  if (value instanceof Date) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  return String(value || "").slice(0, 10);
}
const { buildPurchaseQuery, mapPurchases, roundOffFor } = require("../utils/retailpilot_purchase");

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
   * The reference (mmh_mrc_refno) is RetailPilot's seq, the Tally voucher
   * number, and it restarts every financial year. Two bills with the same
   * reference at an outlet in the SAME financial year would confuse Tally's
   * voucher matching, so such a clash is skipped and reported. The same
   * RetailPilot bill coming back (same slug in mmh_mrc_no) is not a clash,
   * and a bill from another year with the same number is not either.
   */
  async _withoutRefnoClashes(purchases, skipped) {
    if (!purchases.length || typeof this.purchaseUsecase.findByOutletRefnos !== "function") {
      return purchases;
    }
    const keyOf = (outletId, refno, fyStart) => `${outletId}|${String(refno).trim()}|${fyStart}`;
    const keys = purchases.map((p) => {
      const fy = financialYearBounds(p.MRC_DATE);
      return [p.STORE_ID, p.MRC_REF, fy.start, fy.end];
    });
    const existing = await this.purchaseUsecase.findByOutletRefnos(keys);
    const byKey = new Map();
    for (const r of existing) {
      const fy = financialYearBounds(dateOnlyString(r.mmh_mrc_dt));
      const k = keyOf(r.retail_outlet_id, r.mmh_mrc_refno, fy.start);
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(r);
    }
    return purchases.filter((p) => {
      const rows = byKey.get(keyOf(p.STORE_ID, p.MRC_REF, financialYearBounds(p.MRC_DATE).start)) || [];
      const other = rows.find((r) => String(r.mmh_mrc_no == null ? "" : r.mmh_mrc_no).trim() !== p.MRC_NO);
      if (!other) return true;
      skipped.push({
        invoice_slug: p.MRC_NO,
        reason: `MRC ref ${p.MRC_REF} already belongs to purchase ${other.purchase_id} (bill ${other.mmh_dist_bill_no}, GSTIN ${other.supplier_gstn || "-"}) at this outlet in the same financial year`,
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

      const roundOffForAccounts = purchases
        .filter((p) => !p.ROUND_OFF_PREFILL)
        .map((p) => ({ invoice_slug: p.MRC_NO, mrc_ref: p.MRC_REF, outlet: p.STORE_ID, round_off: p.ROUND_OFF, reason: p.ROUND_OFF_NOTE }));
      if (roundOffForAccounts.length) {
        warnings.push(
          `${roundOffForAccounts.length} bill(s) need accounts to check the round-off: ` +
            roundOffForAccounts.slice(0, 5).map((r) => `${r.mrc_ref} (${r.reason})`).join("; ")
        );
      }

      if (dryRun) {
        return {
          code: 200, dry_run: true, days: lookback, row_count: purchases.length,
          purchases, skipped, round_off_for_accounts: roundOffForAccounts, warnings,
        };
      }

      const saved = purchases.length
        ? await this.purchaseUsecase.bulkCreatePurchase(purchases, { matchOn: "mmh_mrc_no" })
        : { insertedCount: 0, updatedCount: 0, unchangedCount: 0 };

      // Round-off into purchase_internal - only where accounts have not
      // started the bill yet (no internal row) and it is unapproved.
      const roundOffPrefilled =
        purchases.length && typeof this.purchaseUsecase.prefillPurchaseInternal === "function"
          ? await this.purchaseUsecase.prefillPurchaseInternal(
              purchases.filter((p) => p.ROUND_OFF_PREFILL).map((p) => ({
                retail_outlet_id: p.STORE_ID,
                mmh_mrc_no: p.MRC_NO,
                ...roundOffFor(p),
              }))
            )
          : 0;

      return {
        code: 200,
        days: lookback,
        row_count: purchases.length,
        inserted: saved.insertedCount,
        updated: saved.updatedCount,
        unchanged: saved.unchangedCount,
        round_off_prefilled: roundOffPrefilled,
        round_off_for_accounts: roundOffForAccounts,
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
