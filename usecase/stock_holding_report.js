class StockHoldingReportUsecase {
  constructor(stockHoldingReportRepo) {
    this.stockHoldingReportRepo = stockHoldingReportRepo;
  }

  create(payload) {
    return new Promise(async (resolve, reject) => {
      try {
        const data = await this.stockHoldingReportRepo.create(payload);
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

  appendItems(stockHoldingReportId, items) {
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

  getLatestItemsPage(date, limit, offset) {
    return new Promise(async (resolve, reject) => {
      try {
        const data = await this.stockHoldingReportRepo.getLatestItemsPageByDate(
          date,
          limit,
          offset
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
}

module.exports = (stockHoldingReportRepo) => {
  return new StockHoldingReportUsecase(stockHoldingReportRepo);
};
