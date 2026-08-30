const logger = require("../utils/logger");

class GrnUsecase {
  constructor(stockReceivedRepo, priceCheckerRepo) {
    this.stockReceivedRepo = stockReceivedRepo;
    this.priceCheckerRepo = priceCheckerRepo;
  }

  async listGrnHeaders(filters = {}) {
    try {
      return await this.stockReceivedRepo.listGrnHeaders(filters);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.GRN",
        code: "USECASE.GRN.LIST_GRN_HEADERS",
        description: err.toString(),
        category: "",
        ref: {},
      });
      throw err;
    }
  }

  async getGrnDetailByRefno(refno) {
    try {
      return await this.stockReceivedRepo.listGrnDetailByRefno(refno);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.GRN",
        code: "USECASE.GRN.GRN_DETAIL",
        description: err.toString(),
        category: "",
        ref: { refno },
      });
      throw err;
    }
  }

  async listGrnIssues(filters = {}) {
    try {
      const items = await this.stockReceivedRepo.listGrnDetailItemsByDateRange(
        filters.from_date,
        filters.to_date
      );

      const productIds = [
        ...new Set(
          items.map((item) => item.product_id).filter((id) => id != null)
        ),
      ];
      const batches = this.priceCheckerRepo
        ? await this.priceCheckerRepo.listGroupedItemsByProductIds(productIds)
        : [];

      const priceCheckerItemsByProduct = {};
      batches.forEach((batch) => {
        if (batch.product_id == null) return;
        const key = String(batch.product_id);
        if (!priceCheckerItemsByProduct[key]) {
          priceCheckerItemsByProduct[key] = [];
        }
        priceCheckerItemsByProduct[key].push(batch);
      });

      return { items, price_checker_items_by_product: priceCheckerItemsByProduct };
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.GRN",
        code: "USECASE.GRN.LIST_GRN_ISSUES",
        description: err.toString(),
        category: "",
        ref: { filters },
      });
      throw err;
    }
  }
}

module.exports = (stockReceivedRepo, priceCheckerRepo) => {
  return new GrnUsecase(stockReceivedRepo, priceCheckerRepo);
};
