const logger = require("../utils/logger");
const { buildStockQuery, buildInstorePriceQuery, mapStockRows } = require("../utils/retailpilot_stock");

/**
 * Daily pull of batch stock and prices from RetailPilot into Offers V3 and
 * the Price Checker - the same three uploads people made by hand, in the
 * same order (Offers V3 price, then Offers V3 stock, then Price Checker),
 * through the same usecases. The article master sync runs first, so items
 * new in RetailPilot exist in product_table before their batches arrive.
 */
class RetailPilotStockSync {
  /**
   * @param loadStoreMap async () => { [retailpilot store slug]: outlet_id }
   *   from Branch Master, read on every run.
   */
  constructor(spectra, articleSync, offersV3Usecase, priceCheckerUsecase, loadStoreMap) {
    this.spectra = spectra;
    this.articleSync = articleSync;
    this.offersV3Usecase = offersV3Usecase;
    this.priceCheckerUsecase = priceCheckerUsecase;
    this.loadStoreMap = loadStoreMap;
    this.running = false;
  }

  async run({ dryRun = false } = {}) {
    if (!this.spectra.isConfigured()) {
      return { code: 400, message: "RetailPilot is not configured (RETAILPILOT_SPECTRA_URL / RETAILPILOT_SPECTRA_KEY)" };
    }
    if (this.running) {
      return { code: 409, message: "A RetailPilot stock sync is already running" };
    }

    this.running = true;
    try {
      const storeMap = (this.loadStoreMap ? await this.loadStoreMap() : null) || {};
      if (Object.keys(storeMap).length === 0) {
        return { code: 400, message: "No branch has a RetailPilot ID. Set it in Branch Master before syncing." };
      }

      const articleResult = await this.articleSync.run({ dryRun });
      if (articleResult.code !== 200) return { ...articleResult, step: "articles" };
      const { productIdOf, ...articles } = articleResult;

      const stock = await this.spectra.queryAll(buildStockQuery());
      const instore = await this.spectra.queryAll(buildInstorePriceQuery());
      const mapped = mapStockRows(stock, instore, storeMap, productIdOf);
      const warnings = [];
      if (mapped.unmappedStores.length) {
        warnings.push(`RetailPilot store(s) with no branch in Branch Master, skipped: ${mapped.unmappedStores.join(", ")}`);
      }

      const summary = {
        articles,
        retailpilot_rows: stock.length,
        price_rows: mapped.priceRows.length,
        stock_rows: mapped.stockRows.length,
        price_checker_rows: mapped.priceCheckerRows.length,
        skipped_count: mapped.skipped.length,
        skipped: mapped.skipped.slice(0, 200),
        warnings,
      };
      if (dryRun) return { code: 200, dry_run: true, ...summary };

      // A price sheet with nothing in it would delete every batch.
      if (mapped.priceRows.length === 0) {
        return { code: 400, message: "RetailPilot returned no priced batches; nothing was changed.", ...summary };
      }

      const price = await this.offersV3Usecase.processPriceUpload(mapped.priceRows, null);
      const stockResult = await this.offersV3Usecase.processStockUpload(mapped.stockRows, null);
      const priceChecker = await this.priceCheckerUsecase.bulkReplace(mapped.priceCheckerRows, null);

      return {
        code: 200,
        ...summary,
        offers_v3_price: {
          upserted: price.upserted,
          removed_batches: price.removedBatches,
          skipped: price.skippedInvalidRows,
          untagged: price.untagged ? price.untagged.length : 0,
        },
        offers_v3_stock: {
          upserted: stockResult.upserted,
          skipped: stockResult.skippedInvalidRows,
          flagged: stockResult.flagged ? stockResult.flagged.length : 0,
          reverted: stockResult.reverted ? stockResult.reverted.length : 0,
          low_stock: stockResult.lowStock ? stockResult.lowStock.length : 0,
        },
        price_checker: { job_id: priceChecker.job_id, code: priceChecker.code, msg: priceChecker.msg },
      };
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.RETAILPILOT_STOCK_SYNC",
        code: "USECASE.RETAILPILOT_STOCK_SYNC.RUN",
        description: err.toString(),
        category: "",
        ref: { dryRun },
      });
      throw err;
    } finally {
      this.running = false;
    }
  }
}

module.exports = (spectra, articleSync, offersV3Usecase, priceCheckerUsecase, loadStoreMap) =>
  new RetailPilotStockSync(spectra, articleSync, offersV3Usecase, priceCheckerUsecase, loadStoreMap);
