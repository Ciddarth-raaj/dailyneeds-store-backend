const logger = require("../utils/logger");

class PickPackRemarksUsecase {
  constructor(pickPackRemarksRepo) {
    this.pickPackRemarksRepo = pickPackRemarksRepo;
  }

  async getAll() {
    try {
      return await this.pickPackRemarksRepo.getAll();
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.PICK_PACK_REMARKS",
        code: "USECASE.PICK_PACK_REMARKS.GET_ALL",
        description: err.toString(),
        category: "",
        ref: {}
      });
      throw err;
    }
  }

  async getById(remark_id) {
    try {
      return await this.pickPackRemarksRepo.getById(remark_id);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.PICK_PACK_REMARKS",
        code: "USECASE.PICK_PACK_REMARKS.GET_BY_ID",
        description: err.toString(),
        category: "",
        ref: {}
      });
      throw err;
    }
  }

  async create(data) {
    try {
      return await this.pickPackRemarksRepo.create(data);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.PICK_PACK_REMARKS",
        code: "USECASE.PICK_PACK_REMARKS.CREATE",
        description: err.toString(),
        category: "",
        ref: {}
      });
      throw err;
    }
  }

  async update(remark_id, data) {
    try {
      return await this.pickPackRemarksRepo.update(remark_id, data);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.PICK_PACK_REMARKS",
        code: "USECASE.PICK_PACK_REMARKS.UPDATE",
        description: err.toString(),
        category: "",
        ref: {}
      });
      throw err;
    }
  }

  async delete(remark_id) {
    try {
      return await this.pickPackRemarksRepo.delete(remark_id);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.PICK_PACK_REMARKS",
        code: "USECASE.PICK_PACK_REMARKS.DELETE",
        description: err.toString(),
        category: "",
        ref: {}
      });
      throw err;
    }
  }
}

module.exports = (pickPackRemarksRepo) => {
  return new PickPackRemarksUsecase(pickPackRemarksRepo);
};
