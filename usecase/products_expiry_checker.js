const logger = require("../utils/logger");

class ProductsExpiryCheckerUsecase {
  constructor(productsExpiryCheckerRepo) {
    this.productsExpiryCheckerRepo = productsExpiryCheckerRepo;
  }

  async getAll() {
    try {
      return await this.productsExpiryCheckerRepo.getAll();
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.PRODUCTS_EXPIRY_CHECKER",
        code: "USECASE.PRODUCTS_EXPIRY_CHECKER.GET_ALL",
        description: err.toString(),
        category: "",
        ref: {}
      });
      throw err;
    }
  }

  async getById(products_expiry_checker_id) {
    try {
      return await this.productsExpiryCheckerRepo.getById(products_expiry_checker_id);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.PRODUCTS_EXPIRY_CHECKER",
        code: "USECASE.PRODUCTS_EXPIRY_CHECKER.GET_BY_ID",
        description: err.toString(),
        category: "",
        ref: {}
      });
      throw err;
    }
  }

  async create(data) {
    try {
      const items = data.items;
      const payload = {
        product_id: data.product_id,
        expiry_date: data.expiry_date,
        ref_file: data.ref_file
      };
      const result = await this.productsExpiryCheckerRepo.create(payload);
      const products_expiry_checker_id = result && result.products_expiry_checker_id;
      if (products_expiry_checker_id && Array.isArray(items) && items.length > 0) {
        const itemsWithId = items.map((it) => ({
          ...it,
          products_expiry_checker_id
        }));
        await this.productsExpiryCheckerRepo.upsertItemsBatch(itemsWithId);
      }
      return result;
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.PRODUCTS_EXPIRY_CHECKER",
        code: "USECASE.PRODUCTS_EXPIRY_CHECKER.CREATE",
        description: err.toString(),
        category: "",
        ref: {}
      });
      throw err;
    }
  }

  async update(products_expiry_checker_id, data) {
    try {
      return await this.productsExpiryCheckerRepo.update(products_expiry_checker_id, data);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.PRODUCTS_EXPIRY_CHECKER",
        code: "USECASE.PRODUCTS_EXPIRY_CHECKER.UPDATE",
        description: err.toString(),
        category: "",
        ref: {}
      });
      throw err;
    }
  }

  async delete(products_expiry_checker_id) {
    try {
      return await this.productsExpiryCheckerRepo.delete(products_expiry_checker_id);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.PRODUCTS_EXPIRY_CHECKER",
        code: "USECASE.PRODUCTS_EXPIRY_CHECKER.DELETE",
        description: err.toString(),
        category: "",
        ref: {}
      });
      throw err;
    }
  }

  async getItemsByProductsExpiryCheckerId(products_expiry_checker_id) {
    try {
      return await this.productsExpiryCheckerRepo.getItemsByProductsExpiryCheckerId(
        products_expiry_checker_id
      );
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.PRODUCTS_EXPIRY_CHECKER",
        code: "USECASE.PRODUCTS_EXPIRY_CHECKER.GET_ITEMS",
        description: err.toString(),
        category: "",
        ref: {}
      });
      throw err;
    }
  }

  async upsertItem(data) {
    try {
      return await this.productsExpiryCheckerRepo.upsertItem(data);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.PRODUCTS_EXPIRY_CHECKER",
        code: "USECASE.PRODUCTS_EXPIRY_CHECKER.UPSERT_ITEM",
        description: err.toString(),
        category: "",
        ref: {}
      });
      throw err;
    }
  }

  async upsertItemsBatch(items) {
    try {
      return await this.productsExpiryCheckerRepo.upsertItemsBatch(items);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.PRODUCTS_EXPIRY_CHECKER",
        code: "USECASE.PRODUCTS_EXPIRY_CHECKER.UPSERT_ITEMS_BATCH",
        description: err.toString(),
        category: "",
        ref: {}
      });
      throw err;
    }
  }

  async deleteItem(products_expiry_checker_id, branch_id) {
    try {
      return await this.productsExpiryCheckerRepo.deleteItem(
        products_expiry_checker_id,
        branch_id
      );
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.PRODUCTS_EXPIRY_CHECKER",
        code: "USECASE.PRODUCTS_EXPIRY_CHECKER.DELETE_ITEM",
        description: err.toString(),
        category: "",
        ref: {}
      });
      throw err;
    }
  }
}

module.exports = (productsExpiryCheckerRepo) => {
  return new ProductsExpiryCheckerUsecase(productsExpiryCheckerRepo);
};
