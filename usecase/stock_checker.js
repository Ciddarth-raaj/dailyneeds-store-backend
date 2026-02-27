const logger = require("../utils/logger");

class StockCheckerUsecase {
  constructor(stockCheckerRepo) {
    this.stockCheckerRepo = stockCheckerRepo;
  }

  async getAll() {
    try {
      return await this.stockCheckerRepo.getAll();
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.STOCK_CHECKER",
        code: "USECASE.STOCK_CHECKER.GET_ALL",
        description: err.toString(),
        category: "",
        ref: {}
      });
      throw err;
    }
  }

  async getById(stock_checker_id) {
    try {
      return await this.stockCheckerRepo.getById(stock_checker_id);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.STOCK_CHECKER",
        code: "USECASE.STOCK_CHECKER.GET_BY_ID",
        description: err.toString(),
        category: "",
        ref: {}
      });
      throw err;
    }
  }

  async create(data) {
    try {
      return await this.stockCheckerRepo.create(data);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.STOCK_CHECKER",
        code: "USECASE.STOCK_CHECKER.CREATE",
        description: err.toString(),
        category: "",
        ref: {}
      });
      throw err;
    }
  }

  async update(stock_checker_id, data) {
    try {
      return await this.stockCheckerRepo.update(stock_checker_id, data);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.STOCK_CHECKER",
        code: "USECASE.STOCK_CHECKER.UPDATE",
        description: err.toString(),
        category: "",
        ref: {}
      });
      throw err;
    }
  }

  async delete(stock_checker_id) {
    try {
      return await this.stockCheckerRepo.delete(stock_checker_id);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.STOCK_CHECKER",
        code: "USECASE.STOCK_CHECKER.DELETE",
        description: err.toString(),
        category: "",
        ref: {}
      });
      throw err;
    }
  }

  // --- stock_checker_items ---

  async getItemsByStockCheckerId(stock_checker_id) {
    try {
      return await this.stockCheckerRepo.getItemsByStockCheckerId(
        stock_checker_id
      );
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.STOCK_CHECKER",
        code: "USECASE.STOCK_CHECKER.GET_ITEMS",
        description: err.toString(),
        category: "",
        ref: {}
      });
      throw err;
    }
  }

  async getItemByStockCheckerIdAndBranchId(stock_checker_id, branch_id) {
    try {
      return await this.stockCheckerRepo.getItemByStockCheckerIdAndBranchId(
        stock_checker_id,
        branch_id
      );
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.STOCK_CHECKER",
        code: "USECASE.STOCK_CHECKER.GET_ITEM",
        description: err.toString(),
        category: "",
        ref: {}
      });
      throw err;
    }
  }

  async upsertItem(data) {
    try {
      return await this.stockCheckerRepo.upsertItem(data);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.STOCK_CHECKER",
        code: "USECASE.STOCK_CHECKER.UPSERT_ITEM",
        description: err.toString(),
        category: "",
        ref: {}
      });
      throw err;
    }
  }

  async upsertItemsBatch(items) {
    try {
      return await this.stockCheckerRepo.upsertItemsBatch(items);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.STOCK_CHECKER",
        code: "USECASE.STOCK_CHECKER.UPSERT_ITEMS_BATCH",
        description: err.toString(),
        category: "",
        ref: {}
      });
      throw err;
    }
  }

  async deleteItem(stock_checker_id, branch_id) {
    try {
      return await this.stockCheckerRepo.deleteItem(
        stock_checker_id,
        branch_id
      );
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.STOCK_CHECKER",
        code: "USECASE.STOCK_CHECKER.DELETE_ITEM",
        description: err.toString(),
        category: "",
        ref: {}
      });
      throw err;
    }
  }
}

module.exports = (stockCheckerRepo) => {
  return new StockCheckerUsecase(stockCheckerRepo);
};
