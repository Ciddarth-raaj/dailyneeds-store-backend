const logger = require("../utils/logger");

class PurchaseReturnUsecase {
  constructor(purchaseReturnRepo) {
    this.purchaseReturnRepo = purchaseReturnRepo;
  }

  async getAll() {
    try {
      return await this.purchaseReturnRepo.getAll();
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.PURCHASE_RETURN",
        code: "USECASE.PURCHASE_RETURN.GET_ALL",
        description: err.toString(),
        category: "",
        ref: {}
      });
      throw err;
    }
  }

  async getById(mprh_pr_no) {
    try {
      return await this.purchaseReturnRepo.getById(mprh_pr_no);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.PURCHASE_RETURN",
        code: "USECASE.PURCHASE_RETURN.GET_BY_ID",
        description: err.toString(),
        category: "",
        ref: {}
      });
      throw err;
    }
  }

  async createExtra(data) {
    try {
      return await this.purchaseReturnRepo.createExtra(data);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.PURCHASE_RETURN",
        code: "USECASE.PURCHASE_RETURN.CREATE_EXTRA",
        description: err.toString(),
        category: "",
        ref: {}
      });
      throw err;
    }
  }

  async updateExtra(mprh_pr_no, data) {
    try {
      return await this.purchaseReturnRepo.updateExtra(mprh_pr_no, data);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.PURCHASE_RETURN",
        code: "USECASE.PURCHASE_RETURN.UPDATE_EXTRA",
        description: err.toString(),
        category: "",
        ref: {}
      });
      throw err;
    }
  }

  async getExtraByPrNo(mprh_pr_no) {
    try {
      return await this.purchaseReturnRepo.getExtraByPrNo(mprh_pr_no);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.PURCHASE_RETURN",
        code: "USECASE.PURCHASE_RETURN.GET_EXTRA",
        description: err.toString(),
        category: "",
        ref: {}
      });
      throw err;
    }
  }
}

module.exports = (purchaseReturnRepo) => {
  return new PurchaseReturnUsecase(purchaseReturnRepo);
};
