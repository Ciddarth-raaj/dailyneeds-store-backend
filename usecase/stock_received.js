const logger = require("../utils/logger");

class StockReceivedUsecase {
  constructor(stockReceivedRepo) {
    this.stockReceivedRepo = stockReceivedRepo;
  }

  async listGofrugalDtl(opts) {
    try {
      return await this.stockReceivedRepo.listGofrugalDtlWithSync(opts);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.STOCK_RECEIVED",
        code: "USECASE.STOCK_RECEIVED.LIST_GOFRUGAL_DTL",
        description: err.toString(),
        category: "",
        ref: {},
      });
      throw err;
    }
  }

  async getById(stock_received_id) {
    try {
      return await this.stockReceivedRepo.getById(stock_received_id);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.STOCK_RECEIVED",
        code: "USECASE.STOCK_RECEIVED.GET_BY_ID",
        description: err.toString(),
        category: "",
        ref: { stock_received_id },
      });
      throw err;
    }
  }

  async upsert(body) {
    try {
      const exists = await this.stockReceivedRepo.productExists(body.product_id);
      if (!exists) {
        const err = new Error(
          "product_id is not present in product_table"
        );
        err.name = "MissingProductIdsError";
        err.missing_product_ids = [body.product_id];
        throw err;
      }
      const row = await this.stockReceivedRepo.upsert(body);
      return { code: 200, data: row };
    } catch (err) {
      if (err.name === "MissingProductIdsError") {
        throw err;
      }
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.STOCK_RECEIVED",
        code: "USECASE.STOCK_RECEIVED.UPSERT",
        description: err.toString(),
        category: "",
        ref: {},
      });
      throw err;
    }
  }

  async deleteById(stock_received_id) {
    try {
      const result = await this.stockReceivedRepo.deleteById(stock_received_id);
      return { code: 200, ...result };
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.STOCK_RECEIVED",
        code: "USECASE.STOCK_RECEIVED.DELETE",
        description: err.toString(),
        category: "",
        ref: { stock_received_id },
      });
      throw err;
    }
  }
}

module.exports = (stockReceivedRepo) => {
  return new StockReceivedUsecase(stockReceivedRepo);
};
