const logger = require("../utils/logger");

class GrnUsecase {
  constructor(stockReceivedRepo) {
    this.stockReceivedRepo = stockReceivedRepo;
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
}

module.exports = (stockReceivedRepo) => {
  return new GrnUsecase(stockReceivedRepo);
};
