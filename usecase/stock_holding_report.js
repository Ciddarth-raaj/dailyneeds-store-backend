const moment = require("moment");
const logger = require("../utils/logger");
const {
  fetchStockInfoItemsForStores,
} = require("../services/delium_stock_info");

const IMPORT_BATCH_SIZE = 5000;

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

class StockHoldingReportUsecase {
  constructor(stockHoldingReportRepo, outletRepo) {
    this.stockHoldingReportRepo = stockHoldingReportRepo;
    this.outletRepo = outletRepo;
  }

  async finalizeUpload(stockHoldingReportId) {
    const cleanup = await this.stockHoldingReportRepo.deleteAllExceptReportId(
      stockHoldingReportId
    );
    return cleanup;
  }

  create(payload) {
    return new Promise(async (resolve, reject) => {
      try {
        const data = await this.stockHoldingReportRepo.create(payload);
        if ((payload.items || []).length > 0) {
          await this.finalizeUpload(data.stock_holding_report_id);
        }
        resolve({
          code: 200,
          message: "Stock holding report created successfully",
          data,
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  createHeader(payload) {
    return new Promise(async (resolve, reject) => {
      try {
        const stock_holding_report_id =
          await this.stockHoldingReportRepo.createReportHeader(payload);
        resolve({
          code: 200,
          message: "Stock holding report header created successfully",
          data: {
            stock_holding_report_id,
            report_name: payload.report_name,
            date: payload.date,
            created_by: payload.created_by,
            item_count: 0,
          },
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  appendItems(stockHoldingReportId, items, options = {}) {
    const { finalize = false } = options;
    return new Promise(async (resolve, reject) => {
      try {
        const exists = await this.stockHoldingReportRepo.reportExists(
          stockHoldingReportId
        );
        if (!exists) {
          resolve({
            code: 404,
            message: "Stock holding report not found",
          });
          return;
        }
        const data = await this.stockHoldingReportRepo.appendItems(
          stockHoldingReportId,
          items
        );
        if (finalize) {
          await this.finalizeUpload(stockHoldingReportId);
        }
        resolve({
          code: 200,
          message: "Stock holding items appended successfully",
          data,
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  getAllReports() {
    return new Promise(async (resolve, reject) => {
      try {
        const data = await this.stockHoldingReportRepo.getAllReports();
        resolve({
          code: 200,
          message: "Stock holding reports fetched successfully",
          data,
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  getById(stockHoldingReportId, options = {}) {
    return new Promise(async (resolve, reject) => {
      try {
        const data = await this.stockHoldingReportRepo.getById(
          stockHoldingReportId,
          options
        );
        if (!data) {
          resolve({
            code: 404,
            message: "Stock holding report not found",
          });
          return;
        }
        resolve({
          code: 200,
          message: "Stock holding report fetched successfully",
          data,
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  getReportById(date, options = {}) {
    return new Promise(async (resolve, reject) => {
      try {
        const data = await this.stockHoldingReportRepo.getLatestReportByDate(
          date,
          options
        );
        if (!data) {
          resolve({
            code: 404,
            message: "Stock holding report not found",
          });
          return;
        }
        resolve({
          code: 200,
          message:
            "Latest stock holding report on or before date fetched successfully",
          data,
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  getLatestItemsPage(date, limit, offset, reportId = null) {
    return new Promise(async (resolve, reject) => {
      try {
        const data = await this.stockHoldingReportRepo.getLatestItemsPageByDate(
          date,
          limit,
          offset,
          reportId
        );
        if (!data) {
          resolve({
            code: 404,
            message: "Stock holding report not found",
          });
          return;
        }
        resolve({
          code: 200,
          message: "Stock holding report items fetched successfully",
          data,
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  delete(stockHoldingReportId) {
    return new Promise(async (resolve, reject) => {
      try {
        const exists = await this.stockHoldingReportRepo.reportExists(
          stockHoldingReportId
        );
        if (!exists) {
          resolve({
            code: 404,
            message: "Stock holding report not found",
          });
          return;
        }

        const result = await this.stockHoldingReportRepo.delete(
          stockHoldingReportId
        );
        resolve({
          code: 200,
          message: "Stock holding report deleted successfully",
          data: result,
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  async _importItemsBatched({ report_name, date, created_by, items }) {
    if (!items.length) {
      return {
        code: 400,
        message: "No valid stock holding rows to import",
      };
    }

    if (items.length <= IMPORT_BATCH_SIZE) {
      const data = await this.stockHoldingReportRepo.create({
        report_name,
        date,
        created_by,
        items,
      });
      await this.finalizeUpload(data.stock_holding_report_id);
      return {
        code: 200,
        message: "Stock holding report synced successfully",
        data,
      };
    }

    const header = await this.stockHoldingReportRepo.createReportHeader({
      report_name,
      date,
      created_by,
    });
    const batches = chunkArray(items, IMPORT_BATCH_SIZE);

    for (let i = 0; i < batches.length; i++) {
      const isLastBatch = i === batches.length - 1;
      await this.stockHoldingReportRepo.appendItems(header, batches[i]);
      if (isLastBatch) {
        await this.finalizeUpload(header);
      }
    }

    const item_count = await this.stockHoldingReportRepo.getItemCountByReportId(
      header
    );

    return {
      code: 200,
      message: "Stock holding report synced successfully",
      data: {
        stock_holding_report_id: header,
        report_name,
        date,
        created_by,
        item_count,
      },
    };
  }

  _logDeliumSync(step, description, ref = {}) {
    logger.Log({
      level: logger.LEVEL.INFO,
      component: "USECASE.STOCK_HOLDING_REPORT",
      code: `USECASE.STOCK_HOLDING_REPORT.SYNC_DELIUM.${step}`,
      description,
      category: "",
      ref,
    });
  }

  async syncFromDeliumApi(options = {}) {
    const date = options.date || moment().format("YYYY-MM-DD");
    const report_name =
      options.report_name || `Stock Holding ${moment(date).format("DD MMM YYYY")}`;
    const created_by = options.created_by ?? null;

    this._logDeliumSync("START", "Delium stock holding sync started", {
      date,
      report_name,
      created_by,
    });

    try {
      const outlets = await this.outletRepo.get();
      const storeIds = (outlets || [])
        .filter((o) => o?.outlet_id != null && o.is_active !== 0)
        .map((o) => Number(o.outlet_id))
        .filter((id) => Number.isFinite(id) && id > 0);

      this._logDeliumSync("OUTLETS", "Resolved active outlet store ids", {
        outlet_count: (outlets || []).length,
        active_store_ids: storeIds,
      });

      if (!storeIds.length) {
        const result = {
          code: 400,
          message: "No active outlets found for Delium stock sync",
        };
        this._logDeliumSync("ABORT", result.message, result);
        return result;
      }

      const { items: rawItems, errors: fetchErrors } =
        await fetchStockInfoItemsForStores(storeIds);

      this._logDeliumSync("FETCH", "Delium API fetch completed", {
        raw_row_count: rawItems.length,
        fetch_error_count: fetchErrors.length,
        fetch_errors: fetchErrors.length ? fetchErrors : undefined,
      });

      if (!rawItems.length) {
        const result = {
          code: 400,
          message: "Delium API returned no stock rows",
          fetch_errors: fetchErrors,
        };
        this._logDeliumSync("ABORT", result.message, result);
        return result;
      }

      const productIds = new Set();
      const outletIds = new Set();
      for (const item of rawItems) {
        productIds.add(item.product_id);
        outletIds.add(item.outlet_id);
      }

      const { validProductIds, validOutletIds } =
        await this.stockHoldingReportRepo.resolveValidProductAndOutletIds(
          [...productIds],
          [...outletIds]
        );

      const validItems = rawItems.filter(
        (item) =>
          validProductIds.has(item.product_id) &&
          validOutletIds.has(item.outlet_id)
      );

      const skipped_invalid = rawItems.length - validItems.length;

      this._logDeliumSync("VALIDATE", "Filtered rows against local products/outlets", {
        raw_row_count: rawItems.length,
        valid_row_count: validItems.length,
        skipped_invalid_rows: skipped_invalid,
        distinct_product_ids: productIds.size,
        distinct_outlet_ids: outletIds.size,
        matched_product_ids: validProductIds.size,
        matched_outlet_ids: validOutletIds.size,
      });

      if (!validItems.length) {
        const result = {
          code: 400,
          message: "No valid stock holding rows to import after validation",
          raw_row_count: rawItems.length,
          skipped_invalid_rows: skipped_invalid,
          fetch_errors: fetchErrors.length ? fetchErrors : undefined,
        };
        this._logDeliumSync("ABORT", result.message, result);
        return result;
      }

      this._logDeliumSync("IMPORT", "Importing validated rows into stock holding report", {
        valid_row_count: validItems.length,
        report_name,
        date,
      });

      const result = await this._importItemsBatched({
        report_name,
        date,
        created_by,
        items: validItems,
      });

      if (result.code === 200) {
        result.data = {
          ...result.data,
          imported_rows: validItems.length,
          skipped_invalid_rows: skipped_invalid,
          stores_synced: storeIds.length - fetchErrors.length,
          fetch_errors: fetchErrors.length ? fetchErrors : undefined,
        };
        this._logDeliumSync("SUCCESS", "Delium stock holding sync completed", result.data);
      } else {
        this._logDeliumSync("IMPORT_FAILED", result.message || "Import failed", result);
      }

      return result;
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.STOCK_HOLDING_REPORT",
        code: "USECASE.STOCK_HOLDING_REPORT.SYNC_DELIUM.ERROR",
        description: err.toString(),
        category: "",
        ref: {},
      });
      throw err;
    }
  }
}

module.exports = (stockHoldingReportRepo, outletRepo) => {
  return new StockHoldingReportUsecase(stockHoldingReportRepo, outletRepo);
};
