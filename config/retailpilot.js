require("dotenv").config();

/**
 * RetailPilot (SPECTRA query API) settings for the purchase pull.
 *
 *   RETAILPILOT_SPECTRA_URL      base URL; requests go to <url>/spectra/query
 *   RETAILPILOT_SPECTRA_KEY      X-Authentication token
 *   RETAILPILOT_PRODUCT          X-Product header (default "runway")
 *   RETAILPILOT_STORE_MAP        optional JSON object: RetailPilot store_id ->
 *                                our outlet_id. When set it replaces the map
 *                                read from Branch Master (outlets.retailpilot_id);
 *                                normally leave it unset.
 *   RETAILPILOT_PURCHASE_SYNC_ENABLED  "true" schedules the cron
 *   RETAILPILOT_PURCHASE_LOOKBACK_DAYS days re-read on every cron run (default 3)
 *
 * There are no defaults for the URL or key: without them the sync refuses
 * to run rather than calling anything.
 */
/** null when unset or unusable, so the sync falls back to Branch Master. */
function parseStoreMap(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("must be a JSON object");
    }
    const map = {};
    for (const [store, outlet] of Object.entries(parsed)) {
      const id = Number(outlet);
      if (Number.isInteger(id) && id > 0) map[String(store)] = id;
    }
    return map;
  } catch (err) {
    console.error(`[RETAILPILOT] RETAILPILOT_STORE_MAP ignored, using Branch Master: ${err.message}`);
    return null;
  }
}

const lookback = parseInt(process.env.RETAILPILOT_PURCHASE_LOOKBACK_DAYS, 10);

module.exports = {
  baseUrl: (process.env.RETAILPILOT_SPECTRA_URL || "").replace(/\/+$/, ""),
  apiKey: process.env.RETAILPILOT_SPECTRA_KEY || "",
  product: process.env.RETAILPILOT_PRODUCT || "runway",
  storeMapOverride: parseStoreMap(process.env.RETAILPILOT_STORE_MAP),
  purchaseSyncEnabled:
    String(process.env.RETAILPILOT_PURCHASE_SYNC_ENABLED || "").toLowerCase() === "true",
  purchaseLookbackDays: Number.isInteger(lookback) && lookback >= 0 ? lookback : 3,
  pageSize: 2000,
  timeoutMs: 60000,
  parseStoreMap,
};
