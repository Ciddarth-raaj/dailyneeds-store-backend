const logger = require("../utils/logger");

class PickPackVerificationRemarksUsecase {
  constructor(pickPackVerificationRemarksRepo) {
    this.pickPackVerificationRemarksRepo = pickPackVerificationRemarksRepo;
  }

  async getAll() {
    try {
      return await this.pickPackVerificationRemarksRepo.getAll();
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.PICK_PACK_VERIFICATION_REMARKS",
        code: "USECASE.PICK_PACK_VERIFICATION_REMARKS.GET_ALL",
        description: err.toString(),
        category: "",
        ref: {}
      });
      throw err;
    }
  }

  async getById(remark_id) {
    try {
      return await this.pickPackVerificationRemarksRepo.getById(remark_id);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.PICK_PACK_VERIFICATION_REMARKS",
        code: "USECASE.PICK_PACK_VERIFICATION_REMARKS.GET_BY_ID",
        description: err.toString(),
        category: "",
        ref: {}
      });
      throw err;
    }
  }

  async create(data) {
    try {
      return await this.pickPackVerificationRemarksRepo.create(data);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.PICK_PACK_VERIFICATION_REMARKS",
        code: "USECASE.PICK_PACK_VERIFICATION_REMARKS.CREATE",
        description: err.toString(),
        category: "",
        ref: {}
      });
      throw err;
    }
  }

  async update(remark_id, data) {
    try {
      return await this.pickPackVerificationRemarksRepo.update(remark_id, data);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.PICK_PACK_VERIFICATION_REMARKS",
        code: "USECASE.PICK_PACK_VERIFICATION_REMARKS.UPDATE",
        description: err.toString(),
        category: "",
        ref: {}
      });
      throw err;
    }
  }

  async delete(remark_id) {
    try {
      return await this.pickPackVerificationRemarksRepo.delete(remark_id);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.PICK_PACK_VERIFICATION_REMARKS",
        code: "USECASE.PICK_PACK_VERIFICATION_REMARKS.DELETE",
        description: err.toString(),
        category: "",
        ref: {}
      });
      throw err;
    }
  }
}

module.exports = (pickPackVerificationRemarksRepo) => {
  return new PickPackVerificationRemarksUsecase(pickPackVerificationRemarksRepo);
};
