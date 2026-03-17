const logger = require("../utils/logger");

class StoCheckUsecase {
  constructor(stoCheckRepo) {
    this.stoCheckRepo = stoCheckRepo;
  }

  async getAll() {
    try {
      return await this.stoCheckRepo.getAll();
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.STO_CHECK",
        code: "USECASE.STO_CHECK.GET_ALL",
        description: err.toString(),
        category: "",
        ref: {},
      });
      throw err;
    }
  }

  async getByDnRefNo(dn_ref_no) {
    try {
      return await this.stoCheckRepo.getByDnRefNo(dn_ref_no);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.STO_CHECK",
        code: "USECASE.STO_CHECK.GET_BY_DN_REF_NO",
        description: err.toString(),
        category: "",
        ref: { dn_ref_no },
      });
      throw err;
    }
  }

  async getOne(dn_ref_no, product_id) {
    try {
      return await this.stoCheckRepo.getOne(dn_ref_no, product_id);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.STO_CHECK",
        code: "USECASE.STO_CHECK.GET_ONE",
        description: err.toString(),
        category: "",
        ref: { dn_ref_no, product_id },
      });
      throw err;
    }
  }

  async replaceByDnRefNo(dn_ref_no, items) {
    try {
      return await this.stoCheckRepo.replaceByDnRefNo(dn_ref_no, items);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.STO_CHECK",
        code: "USECASE.STO_CHECK.REPLACE_BY_DN_REF_NO",
        description: err.toString(),
        category: "",
        ref: { dn_ref_no },
      });
      throw err;
    }
  }

  async bulkReplace(payloads) {
    try {
      const results = [];
      for (const payload of payloads) {
        const result = await this.stoCheckRepo.replaceByDnRefNo(
          payload.dn_ref_no,
          payload.items || []
        );
        results.push({ dn_ref_no: payload.dn_ref_no, ...result });
      }
      return { code: 200, results };
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.STO_CHECK",
        code: "USECASE.STO_CHECK.BULK_REPLACE",
        description: err.toString(),
        category: "",
        ref: {},
      });
      throw err;
    }
  }

  async deleteByDnRefNo(dn_ref_no) {
    try {
      return await this.stoCheckRepo.deleteByDnRefNo(dn_ref_no);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.STO_CHECK",
        code: "USECASE.STO_CHECK.DELETE_BY_DN_REF_NO",
        description: err.toString(),
        category: "",
        ref: { dn_ref_no },
      });
      throw err;
    }
  }
}

module.exports = (stoCheckRepo) => {
  return new StoCheckUsecase(stoCheckRepo);
};
