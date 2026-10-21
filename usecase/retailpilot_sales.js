const logger = require("../utils/logger");
const { validDay, buildSalesQuery, mapSalesRows } = require("../utils/retailpilot_sales");

/**
 * Sales Reconciliation's "Pull from RetailPilot": one day's POS figures per
 * store (utils/retailpilot_sales.js). Read-only - nothing is saved here; the
 * screen compares and saves exactly as it does for an uploaded CSV.
 */
class RetailPilotSales {
  constructor(spectra) {
    this.spectra = spectra;
  }

  async daySales(date) {
    const day = validDay(date);
    if (!day) return { code: 422, msg: "date must be a real day as YYYY-MM-DD" };
    if (!this.spectra.isConfigured()) {
      return { code: 400, msg: "RetailPilot is not configured (RETAILPILOT_SPECTRA_URL / RETAILPILOT_SPECTRA_KEY)" };
    }
    try {
      const rows = await this.spectra.queryAll(buildSalesQuery(day));
      return { code: 200, date: day, rows: mapSalesRows(rows, day) };
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.RETAILPILOT_SALES",
        code: "USECASE.RETAILPILOT_SALES.DAY",
        description: err.toString(),
        category: "",
        ref: { date: day },
      });
      return { code: 502, msg: err.message };
    }
  }
}

module.exports = (spectra) => new RetailPilotSales(spectra);
