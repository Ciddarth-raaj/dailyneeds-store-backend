const logger = require("../utils/logger");

class PickPackVerificationsUsecase {
  constructor(pickPackVerificationsRepo) {
    this.pickPackVerificationsRepo = pickPackVerificationsRepo;
  }

  async getAll(filters) {
    try {
      return await this.pickPackVerificationsRepo.getAll(filters);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.PICK_PACK_VERIFICATIONS",
        code: "USECASE.PICK_PACK_VERIFICATIONS.GET_ALL",
        description: err.toString(),
        category: "",
        ref: {}
      });
      throw err;
    }
  }

  async getById(pick_pack_verification_id) {
    try {
      return await this.pickPackVerificationsRepo.getById(pick_pack_verification_id);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.PICK_PACK_VERIFICATIONS",
        code: "USECASE.PICK_PACK_VERIFICATIONS.GET_BY_ID",
        description: err.toString(),
        category: "",
        ref: {}
      });
      throw err;
    }
  }

  async create(data) {
    try {
      return await this.pickPackVerificationsRepo.create(data);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.PICK_PACK_VERIFICATIONS",
        code: "USECASE.PICK_PACK_VERIFICATIONS.CREATE",
        description: err.toString(),
        category: "",
        ref: {}
      });
      throw err;
    }
  }

  async update(pick_pack_verification_id, data) {
    try {
      return await this.pickPackVerificationsRepo.update(pick_pack_verification_id, data);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.PICK_PACK_VERIFICATIONS",
        code: "USECASE.PICK_PACK_VERIFICATIONS.UPDATE",
        description: err.toString(),
        category: "",
        ref: {}
      });
      throw err;
    }
  }

  async delete(pick_pack_verification_id) {
    try {
      return await this.pickPackVerificationsRepo.delete(pick_pack_verification_id);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.PICK_PACK_VERIFICATIONS",
        code: "USECASE.PICK_PACK_VERIFICATIONS.DELETE",
        description: err.toString(),
        category: "",
        ref: {}
      });
      throw err;
    }
  }
}

module.exports = (pickPackVerificationsRepo) => {
  return new PickPackVerificationsUsecase(pickPackVerificationsRepo);
};
