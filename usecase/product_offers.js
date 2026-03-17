const logger = require("../utils/logger");

class ProductOffersUsecase {
  constructor(productOffersRepo) {
    this.productOffersRepo = productOffersRepo;
  }

  async getAll() {
    try {
      return await this.productOffersRepo.getAll();
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.PRODUCT_OFFERS",
        code: "USECASE.PRODUCT_OFFERS.GET_ALL",
        description: err.toString(),
        category: "",
        ref: {},
      });
      throw err;
    }
  }

  async getByProductId(product_id) {
    try {
      return await this.productOffersRepo.getByProductId(product_id);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.PRODUCT_OFFERS",
        code: "USECASE.PRODUCT_OFFERS.GET_BY_PRODUCT_ID",
        description: err.toString(),
        category: "",
        ref: { product_id },
      });
      throw err;
    }
  }

  async create(data) {
    try {
      return await this.productOffersRepo.create(data);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.PRODUCT_OFFERS",
        code: "USECASE.PRODUCT_OFFERS.CREATE",
        description: err.toString(),
        category: "",
        ref: {},
      });
      throw err;
    }
  }

  async bulkInsert(rows) {
    try {
      return await this.productOffersRepo.bulkInsert(rows);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.PRODUCT_OFFERS",
        code: "USECASE.PRODUCT_OFFERS.BULK_INSERT",
        description: err.toString(),
        category: "",
        ref: {},
      });
      throw err;
    }
  }

  async update(product_id, data) {
    try {
      return await this.productOffersRepo.update(product_id, data);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.PRODUCT_OFFERS",
        code: "USECASE.PRODUCT_OFFERS.UPDATE",
        description: err.toString(),
        category: "",
        ref: { product_id },
      });
      throw err;
    }
  }

  async delete(product_id) {
    try {
      return await this.productOffersRepo.delete(product_id);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.PRODUCT_OFFERS",
        code: "USECASE.PRODUCT_OFFERS.DELETE",
        description: err.toString(),
        category: "",
        ref: { product_id },
      });
      throw err;
    }
  }

  async bulkDelete(product_ids) {
    try {
      return await this.productOffersRepo.bulkDelete(product_ids);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.PRODUCT_OFFERS",
        code: "USECASE.PRODUCT_OFFERS.BULK_DELETE",
        description: err.toString(),
        category: "",
        ref: {},
      });
      throw err;
    }
  }
}

module.exports = (productOffersRepo) => {
  return new ProductOffersUsecase(productOffersRepo);
};
