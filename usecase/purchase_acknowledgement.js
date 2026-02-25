const logger = require("../utils/logger");

class PurchaseAcknowledgementUsecase {
  constructor(purchaseAcknowledgementRepo) {
    this.purchaseAcknowledgementRepo = purchaseAcknowledgementRepo;
  }

  async getAll() {
    try {
      return await this.purchaseAcknowledgementRepo.getAll();
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.PURCHASE_ACKNOWLEDGEMENT",
        code: "USECASE.PURCHASE_ACKNOWLEDGEMENT.GET_ALL",
        description: err.toString(),
        category: "",
        ref: {}
      });
      throw err;
    }
  }

  async getById(purchase_acknowledgement_id) {
    try {
      return await this.purchaseAcknowledgementRepo.getById(purchase_acknowledgement_id);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.PURCHASE_ACKNOWLEDGEMENT",
        code: "USECASE.PURCHASE_ACKNOWLEDGEMENT.GET_BY_ID",
        description: err.toString(),
        category: "",
        ref: {}
      });
      throw err;
    }
  }

  async create(data) {
    try {
      return await this.purchaseAcknowledgementRepo.create(data);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.PURCHASE_ACKNOWLEDGEMENT",
        code: "USECASE.PURCHASE_ACKNOWLEDGEMENT.CREATE",
        description: err.toString(),
        category: "",
        ref: {}
      });
      throw err;
    }
  }

  async update(purchase_acknowledgement_id, data) {
    try {
      return await this.purchaseAcknowledgementRepo.update(purchase_acknowledgement_id, data);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.PURCHASE_ACKNOWLEDGEMENT",
        code: "USECASE.PURCHASE_ACKNOWLEDGEMENT.UPDATE",
        description: err.toString(),
        category: "",
        ref: {}
      });
      throw err;
    }
  }

  async delete(purchase_acknowledgement_id) {
    try {
      return await this.purchaseAcknowledgementRepo.delete(purchase_acknowledgement_id);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.PURCHASE_ACKNOWLEDGEMENT",
        code: "USECASE.PURCHASE_ACKNOWLEDGEMENT.DELETE",
        description: err.toString(),
        category: "",
        ref: {}
      });
      throw err;
    }
  }
}

module.exports = (purchaseAcknowledgementRepo) => {
  return new PurchaseAcknowledgementUsecase(purchaseAcknowledgementRepo);
};
