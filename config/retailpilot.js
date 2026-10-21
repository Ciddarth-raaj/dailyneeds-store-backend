require("dotenv").config();

/**
 * RetailPilot (SPECTRA query API) settings for the purchase pull.
 *
 *   RETAILPILOT_SPECTRA_URL      base URL; requests go to <url>/spectra/query
 *   RETAILPILOT_SPECTRA_KEY      X-Authentication token
 *   RETAILPILOT_PRODUCT          X-Product header (default "runway")
 *   RETAILPILOT_SALES_PRODUCT    X-Product header for POS sales (bills),
 *                                read by Sales Reconciliation (default "mandapam")
 *   RETAILPILOT_PURCHASE_SYNC_ENABLED  "true" schedules the cron at 9:00,
 *                                14:00 and 17:00 Asia/Kolkata
 *   RETAILPILOT_PURCHASE_LOOKBACK_DAYS days re-read on every cron run (default 3)
 *   RETAILPILOT_GRN_OUTLET_ID    the outlet whose RetailPilot purchases are the
 *                                GRN pages' GRNs (default 2, the warehouse)
 *   RETAILPILOT_STOCK_SYNC_ENABLED     the daily 6:00 Asia/Kolkata pull of batch
 *                                stock and prices into Offers V3 and the Price
 *                                Checker. ON unless set to "false".
 *
 * There are no defaults for the URL or key: without them the sync refuses
 * to run rather than calling anything. The RetailPilot store -> outlet map
 * is not configured here: it is Branch Master (outlets.retailpilot_id).
 */

const lookback = parseInt(process.env.RETAILPILOT_PURCHASE_LOOKBACK_DAYS, 10);

module.exports = {
  baseUrl: (process.env.RETAILPILOT_SPECTRA_URL || "").replace(/\/+$/, ""),
  apiKey: process.env.RETAILPILOT_SPECTRA_KEY || "",
  product: process.env.RETAILPILOT_PRODUCT || "runway",
  salesProduct: process.env.RETAILPILOT_SALES_PRODUCT || "mandapam",
  purchaseSyncEnabled:
    String(process.env.RETAILPILOT_PURCHASE_SYNC_ENABLED || "").toLowerCase() === "true",
  stockSyncEnabled:
    String(process.env.RETAILPILOT_STOCK_SYNC_ENABLED || "").toLowerCase() !== "false",
  grnSyncEnabled:
    String(process.env.RETAILPILOT_GRN_SYNC_ENABLED || "").toLowerCase() !== "false",
  grnOutletId: parseInt(process.env.RETAILPILOT_GRN_OUTLET_ID, 10) || 2,
  purchaseLookbackDays: Number.isInteger(lookback) && lookback >= 0 ? lookback : 3,
  pageSize: 2000,
  timeoutMs: 60000,
};
