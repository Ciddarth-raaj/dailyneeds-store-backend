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
const { buildPurchaseQuery, mapPurchases } = require("../utils/retailpilot_purchase");
const { purchaseDiscrepancies } = require("../utils/purchase_discrepancy");

const MAX_DAYS = 90;

/**
 * Pulls purchase invoices from RetailPilot and saves them one by one with
 * purchaseUsecase.upsertRetailPilotPurchase: new bills inserted, approved
 * bills frozen, Accounts' corrections kept on re-sync.
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
   *
   * The year is the one the seq is numbered in (RetailPilot's fy), not the
   * bill's date: a bill dated in an earlier year by mistake still belongs
   * to this year's series - it is imported and flagged for Accounts
   * (MRC_DATE_OUTSIDE_SERIES_FY), not skipped against last year's bills.
   */
  async _withoutRefnoClashes(purchases, skipped) {
    if (!purchases.length || typeof this.purchaseUsecase.findByOutletRefnos !== "function") {
      return purchases;
    }
    const keyOf = (outletId, refno, fyStart) => `${outletId}|${String(refno).trim()}|${fyStart}`;
    const seriesYear = (p) => (p.FY ? financialYearBounds(`${p.FY}-04-01`) : financialYearBounds(p.MRC_DATE));
    const keys = purchases.map((p) => {
      const fy = seriesYear(p);
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
      const rows = byKey.get(keyOf(p.STORE_ID, p.MRC_REF, seriesYear(p).start)) || [];
      const other = rows.find((r) => String(r.mmh_mrc_no == null ? "" : r.mmh_mrc_no).trim() !== p.MRC_NO);
      if (!other) return true;
      skipped.push({
        invoice_slug: p.MRC_NO,
        reason: `MRC ref ${p.MRC_REF} already belongs to purchase ${other.purchase_id} at this outlet in the same financial year`,
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

      // Bills Accounts must look at (utils/purchase_discrepancy.js), as
      // RetailPilot sent them. Reported separately from `warnings`: a
      // discrepancy is work for Accounts, not a failed sync.
      const discrepancies = purchases.flatMap((p) =>
        purchaseDiscrepancies({
          supplier_gstn: p.SUPPLIER_GSTN,
          sgst: p.SGST,
          cgst: p.CGST,
          igst: p.IGST,
          mmh_mrc_dt: p.MRC_DATE,
          mmh_dist_bill_dt: p.DIST_BILL_DT,
          mmh_mrc_refno: p.MRC_REF,
          voucher_fy: p.FY,
          entered_at: p.ENTERED_AT,
        }).map((d) => ({ invoice_slug: p.MRC_NO, mrc_ref: p.MRC_REF, outlet: p.STORE_ID, ...d }))
      );

      if (dryRun) {
        return {
          code: 200, dry_run: true, days: lookback, row_count: purchases.length,
          purchases, skipped, discrepancies, warnings,
        };
      }

      const counts = { inserted: 0, updated: 0, unchanged: 0, approved: 0 };
      const correctionsKept = [];
      for (const p of purchases) {
        const r = await this.purchaseUsecase.upsertRetailPilotPurchase(p);
        counts[r.action] += 1;
        if (r.action === "updated" && r.kept && r.kept.length) {
          correctionsKept.push({ invoice_slug: p.MRC_NO, mrc_ref: p.MRC_REF, outlet: p.STORE_ID, purchase_id: r.purchase_id, fields: r.kept });
        }
      }

      return {
        code: 200,
        days: lookback,
        row_count: purchases.length,
        inserted: counts.inserted,
        updated: counts.updated,
        unchanged: counts.unchanged,
        approved_untouched: counts.approved,
        corrections_kept: correctionsKept,
        discrepancies,
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
