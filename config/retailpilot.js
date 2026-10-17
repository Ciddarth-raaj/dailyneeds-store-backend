require("dotenv").config();

/**
 * RetailPilot (SPECTRA query API) settings for the purchase pull.
 *
 *   RETAILPILOT_SPECTRA_URL      base URL; requests go to <url>/spectra/query
 *   RETAILPILOT_SPECTRA_KEY      X-Authentication token
 *   RETAILPILOT_PRODUCT          X-Product header (default "runway")
 *   RETAILPILOT_STORE_MAP        JSON object: RetailPilot store_id -> our
 *                                outlet_id. Replaces DEFAULT_STORE_MAP when set.
 *   RETAILPILOT_PURCHASE_SYNC_ENABLED  "true" schedules the cron
 *   RETAILPILOT_PURCHASE_LOOKBACK_DAYS days re-read on every cron run (default 3)
 *
 * There are no defaults for the URL or key: without them the sync refuses
 * to run rather than calling anything.
 */
/**
 * RetailPilot store slug -> our outlet_id. Outlet IDs follow the Tally
 * voucher-type map in usecase/tally.js (2 Warehouse, 4 DN1, 3 DN2, 5 DN3,
 * 6 DN4, 7 DN5).
 */
const DEFAULT_STORE_MAP = {
  "9rJMC": 2, // Warehouse
  FuUGY: 4, // DN1
  huABy: 3, // DN2
  sooWy: 5, // DN3
  rnMT1: 6, // DN4
  kKFom: 7, // DN5
};

function parseStoreMap(raw) {
  if (!raw) return { ...DEFAULT_STORE_MAP };
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
    console.error(`[RETAILPILOT] RETAILPILOT_STORE_MAP ignored, using the default map: ${err.message}`);
    return { ...DEFAULT_STORE_MAP };
  }
}

const lookback = parseInt(process.env.RETAILPILOT_PURCHASE_LOOKBACK_DAYS, 10);

module.exports = {
  baseUrl: (process.env.RETAILPILOT_SPECTRA_URL || "").replace(/\/+$/, ""),
  apiKey: process.env.RETAILPILOT_SPECTRA_KEY || "",
  product: process.env.RETAILPILOT_PRODUCT || "runway",
  storeMap: parseStoreMap(process.env.RETAILPILOT_STORE_MAP),
  purchaseSyncEnabled:
    String(process.env.RETAILPILOT_PURCHASE_SYNC_ENABLED || "").toLowerCase() === "true",
  purchaseLookbackDays: Number.isInteger(lookback) && lookback >= 0 ? lookback : 3,
  pageSize: 2000,
  timeoutMs: 60000,
  parseStoreMap,
  DEFAULT_STORE_MAP,
};
