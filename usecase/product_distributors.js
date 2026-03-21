const logger = require("../utils/logger");

class ProductDistributorsUsecase {
  constructor(productDistributorsRepo) {
    this.productDistributorsRepo = productDistributorsRepo;
  }

  async getAll() {
    try {
      return await this.productDistributorsRepo.getAll();
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.PRODUCT_DISTRIBUTORS",
        code: "USECASE.PRODUCT_DISTRIBUTORS.GET_ALL",
        description: err.toString(),
        category: "",
        ref: {}
      });
      throw err;
    }
  }

  async getByCode(MDM_DIST_CODE) {
    try {
      return await this.productDistributorsRepo.getByCode(MDM_DIST_CODE);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.PRODUCT_DISTRIBUTORS",
        code: "USECASE.PRODUCT_DISTRIBUTORS.GET_BY_CODE",
        description: err.toString(),
        category: "",
        ref: {}
      });
      throw err;
    }
  }

  async delete(MDM_DIST_CODE) {
    try {
      return await this.productDistributorsRepo.delete(MDM_DIST_CODE);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.PRODUCT_DISTRIBUTORS",
        code: "USECASE.PRODUCT_DISTRIBUTORS.DELETE",
        description: err.toString(),
        category: "",
        ref: {}
      });
      throw err;
    }
  }

  async upsertBuyerMap(payload) {
    try {
      return await this.productDistributorsRepo.upsertBuyerMap(
        payload.MDM_DIST_CODE,
        payload.buyer_id
      );
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.PRODUCT_DISTRIBUTORS",
        code: "USECASE.PRODUCT_DISTRIBUTORS.UPSERT_BUYER_MAP",
        description: err.toString(),
        category: "",
        ref: {}
      });
      throw err;
    }
  }

  async bulkUpsertBuyerMap(items) {
    try {
      return await this.productDistributorsRepo.bulkUpsertBuyerMap(items);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.PRODUCT_DISTRIBUTORS",
        code: "USECASE.PRODUCT_DISTRIBUTORS.BULK_UPSERT_BUYER_MAP",
        description: err.toString(),
        category: "",
        ref: {}
      });
      throw err;
    }
  }
}

module.exports = (productDistributorsRepo) => {
  return new ProductDistributorsUsecase(productDistributorsRepo);
};
