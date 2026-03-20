const logger = require("../utils/logger");

class PickPackWriteOffUsecase {
  constructor(pickPackWriteOffRepo) {
    this.pickPackWriteOffRepo = pickPackWriteOffRepo;
  }

  async getAll(filters) {
    try {
      return await this.pickPackWriteOffRepo.getAll(filters);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.PICK_PACK_WRITE_OFF",
        code: "USECASE.PICK_PACK_WRITE_OFF.GET_ALL",
        description: err.toString(),
        category: "",
        ref: {}
      });
      throw err;
    }
  }

  async getById(pick_pack_write_off_id) {
    try {
      return await this.pickPackWriteOffRepo.getById(pick_pack_write_off_id);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.PICK_PACK_WRITE_OFF",
        code: "USECASE.PICK_PACK_WRITE_OFF.GET_BY_ID",
        description: err.toString(),
        category: "",
        ref: {}
      });
      throw err;
    }
  }

  async create(data) {
    try {
      return await this.pickPackWriteOffRepo.create(data);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.PICK_PACK_WRITE_OFF",
        code: "USECASE.PICK_PACK_WRITE_OFF.CREATE",
        description: err.toString(),
        category: "",
        ref: {}
      });
      throw err;
    }
  }

  async update(pick_pack_write_off_id, data) {
    try {
      return await this.pickPackWriteOffRepo.update(pick_pack_write_off_id, data);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.PICK_PACK_WRITE_OFF",
        code: "USECASE.PICK_PACK_WRITE_OFF.UPDATE",
        description: err.toString(),
        category: "",
        ref: {}
      });
      throw err;
    }
  }

  async delete(pick_pack_write_off_id) {
    try {
      return await this.pickPackWriteOffRepo.delete(pick_pack_write_off_id);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.PICK_PACK_WRITE_OFF",
        code: "USECASE.PICK_PACK_WRITE_OFF.DELETE",
        description: err.toString(),
        category: "",
        ref: {}
      });
      throw err;
    }
  }
}

module.exports = (pickPackWriteOffRepo) => {
  return new PickPackWriteOffUsecase(pickPackWriteOffRepo);
};
