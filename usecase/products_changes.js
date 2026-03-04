const logger = require("../utils/logger");

class ProductsChangesUsecase {
  constructor(productsChangesRepo) {
    this.productsChangesRepo = productsChangesRepo;
  }

  async getAll(filters = {}) {
    try {
      return await this.productsChangesRepo.getAll(filters);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.PRODUCTS_CHANGES",
        code: "USECASE.PRODUCTS_CHANGES.GET_ALL",
        description: err.toString(),
        category: "",
        ref: { filters }
      });
      throw err;
    }
  }

  async getById(products_change_id) {
    try {
      const row = await this.productsChangesRepo.getById(products_change_id);
      if (!row) return null;
      return row;
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.PRODUCTS_CHANGES",
        code: "USECASE.PRODUCTS_CHANGES.GET_BY_ID",
        description: err.toString(),
        category: "",
        ref: { products_change_id }
      });
      throw err;
    }
  }

  async setApproval(products_change_id, is_approved) {
    try {
      const existing = await this.productsChangesRepo.getById(products_change_id);
      if (!existing) {
        const err = new Error("Products change record not found");
        err.code = 404;
        throw err;
      }
      await this.productsChangesRepo.setApproval(products_change_id, is_approved);
      return await this.productsChangesRepo.getById(products_change_id);
    } catch (err) {
      if (err.code === 404) throw err;
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.PRODUCTS_CHANGES",
        code: "USECASE.PRODUCTS_CHANGES.SET_APPROVAL",
        description: err.toString(),
        category: "",
        ref: { products_change_id, is_approved }
      });
      throw err;
    }
  }
}

module.exports = (productsChangesRepo) => {
  return new ProductsChangesUsecase(productsChangesRepo);
};
