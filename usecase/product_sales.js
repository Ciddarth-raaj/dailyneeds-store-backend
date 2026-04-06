const logger = require("../utils/logger");

class ProductSalesUsecase {
  constructor(productSalesRepo) {
    this.productSalesRepo = productSalesRepo;
  }

  async bulkCreate(rows) {
    try {
      return await this.productSalesRepo.bulkCreate(rows);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.PRODUCT_SALES",
        code: "USECASE.PRODUCT_SALES.BULK_CREATE",
        description: err.toString(),
        category: "",
        ref: {},
      });
      throw err;
    }
  }
}

module.exports = (productSalesRepo) => {
  return new ProductSalesUsecase(productSalesRepo);
};
