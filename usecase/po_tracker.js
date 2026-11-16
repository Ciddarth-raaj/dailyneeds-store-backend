const logger = require("../utils/logger");
const P = require("../utils/po_tracker");

/** How long one RetailPilot answer is reused (refresh=1 skips it). */
const TTL_MS = 2 * 60 * 1000;

/** PO Tracker (utils/po_tracker.js), live from RetailPilot runway. */
class PoTracker {
  constructor(spectra, now = () => Date.now()) {
    this.spectra = spectra;
    this.now = now;
    this.cache = null;
  }

  async list({ refresh = false } = {}) {
    if (!this.spectra || !this.spectra.isConfigured()) {
      return { code: 502, msg: "RetailPilot is not configured" };
    }
    if (!refresh && this.cache && this.now() - this.cache.at < TTL_MS) {
      return this._answer(this.cache);
    }
    try {
      const rows = await this.spectra.queryAll(P.PO_TRACKER_QUERY);
      this.cache = { at: this.now(), orders: P.mapPurchaseOrders(rows) };
      return this._answer(this.cache);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.PO_TRACKER",
        code: "USECASE.PO_TRACKER.LIST",
        description: err.toString(),
        category: "",
        ref: {},
      });
      return { code: 502, msg: `RetailPilot: ${err.message}` };
    }
  }

  _answer({ at, orders }) {
    return { code: 200, data: { fetched_at: new Date(at).toISOString(), orders } };
  }
}

module.exports = (spectra, now) => new PoTracker(spectra, now);
