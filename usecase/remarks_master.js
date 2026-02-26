const logger = require("../utils/logger");

class RemarksMasterUsecase {
  constructor(remarksMasterRepo) {
    this.remarksMasterRepo = remarksMasterRepo;
  }

  async getAll() {
    try {
      return await this.remarksMasterRepo.getAll();
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.REMARKS_MASTER",
        code: "USECASE.REMARKS_MASTER.GET_ALL",
        description: err.toString(),
        category: "",
        ref: {}
      });
      throw err;
    }
  }

  async getById(remark_id) {
    try {
      return await this.remarksMasterRepo.getById(remark_id);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.REMARKS_MASTER",
        code: "USECASE.REMARKS_MASTER.GET_BY_ID",
        description: err.toString(),
        category: "",
        ref: {}
      });
      throw err;
    }
  }

  async create(data) {
    try {
      return await this.remarksMasterRepo.create(data);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.REMARKS_MASTER",
        code: "USECASE.REMARKS_MASTER.CREATE",
        description: err.toString(),
        category: "",
        ref: {}
      });
      throw err;
    }
  }

  async update(remark_id, data) {
    try {
      return await this.remarksMasterRepo.update(remark_id, data);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.REMARKS_MASTER",
        code: "USECASE.REMARKS_MASTER.UPDATE",
        description: err.toString(),
        category: "",
        ref: {}
      });
      throw err;
    }
  }

  async delete(remark_id) {
    try {
      return await this.remarksMasterRepo.delete(remark_id);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.REMARKS_MASTER",
        code: "USECASE.REMARKS_MASTER.DELETE",
        description: err.toString(),
        category: "",
        ref: {}
      });
      throw err;
    }
  }
}

module.exports = (remarksMasterRepo) => {
  return new RemarksMasterUsecase(remarksMasterRepo);
};
