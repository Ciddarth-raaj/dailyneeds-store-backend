const logger = require("../utils/logger");

class OffersV3Usecase {
  constructor(offersV3Repo) {
    this.offersV3Repo = offersV3Repo;
  }

  async getAll() {
    try {
      return await this.offersV3Repo.getAll();
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.OFFERS_V3",
        code: "USECASE.OFFERS_V3.GET_ALL",
        description: err.toString(),
        category: "",
        ref: {},
      });
      throw err;
    }
  }

  async getById(id) {
    try {
      return await this.offersV3Repo.getById(id);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.OFFERS_V3",
        code: "USECASE.OFFERS_V3.GET_BY_ID",
        description: err.toString(),
        category: "",
        ref: { id },
      });
      throw err;
    }
  }

  async create(data) {
    try {
      return await this.offersV3Repo.create(data);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.OFFERS_V3",
        code: "USECASE.OFFERS_V3.CREATE",
        description: err.toString(),
        category: "",
        ref: {},
      });
      throw err;
    }
  }

  async bulkInsert(rows) {
    try {
      return await this.offersV3Repo.bulkInsert(rows);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.OFFERS_V3",
        code: "USECASE.OFFERS_V3.BULK_INSERT",
        description: err.toString(),
        category: "",
        ref: {},
      });
      throw err;
    }
  }

  async update(id, data) {
    try {
      return await this.offersV3Repo.update(id, data);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.OFFERS_V3",
        code: "USECASE.OFFERS_V3.UPDATE",
        description: err.toString(),
        category: "",
        ref: { id },
      });
      throw err;
    }
  }

  async delete(id) {
    try {
      return await this.offersV3Repo.delete(id);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.OFFERS_V3",
        code: "USECASE.OFFERS_V3.DELETE",
        description: err.toString(),
        category: "",
        ref: { id },
      });
      throw err;
    }
  }

  async bulkDelete(ids) {
    try {
      return await this.offersV3Repo.bulkDelete(ids);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.OFFERS_V3",
        code: "USECASE.OFFERS_V3.BULK_DELETE",
        description: err.toString(),
        category: "",
        ref: {},
      });
      throw err;
    }
  }
}

module.exports = (offersV3Repo) => {
  return new OffersV3Usecase(offersV3Repo);
};
