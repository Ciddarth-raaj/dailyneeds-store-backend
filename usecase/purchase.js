const { PURCHASE_TELEGRAM_CHAT_ID } = require("../constants/telegram");

class PurchaseUsecase {
  constructor(purchaseRepo, outletUsecase) {
    this.purchaseRepo = purchaseRepo;
    this.outletUsecase = outletUsecase;
    this.telegram = require("../services/telegram")();
  }

  async createPurchase(purchase) {
    try {
      const result = await this.purchaseRepo.create(purchase);
      return result;
    } catch (error) {
      throw error;
    }
  }

  async updatePurchaseWithInternal(
    purchase,
    purchaseInternal,
    send_not_matched_notification
  ) {
    try {
      const result = await this.purchaseRepo.updatePurchaseWithInternal(
        purchase,
        purchaseInternal
      );

      if (send_not_matched_notification) {
        const outlet = await this.outletUsecase.getOutletById(
          purchase.retail_outlet_id
        );
        const outletName = outlet.length > 0 ? outlet[0].outlet_name : "N/A";
        await this.telegram.sendMessage(
          PURCHASE_TELEGRAM_CHAT_ID,
          `✅ Purchase #${purchase.mmh_mrc_refno} (${outletName}) has been updated with ${purchaseInternal.total_amount} (MRC Amount: ${purchase.mmh_mrc_amt})`
        );
      }
      return result;
    } catch (error) {
      throw error;
    }
  }

  async deletePurchase(purchaseId) {
    try {
      const result = await this.purchaseRepo.delete(purchaseId);
      return result;
    } catch (error) {
      throw error;
    }
  }

  async getAllPurchases(filters) {
    try {
      const result = await this.purchaseRepo.getAll(filters);
      return result;
    } catch (error) {
      throw error;
    }
  }

  async getPurchaseById(purchaseId) {
    try {
      const result = await this.purchaseRepo.getById(purchaseId);
      return result;
    } catch (error) {
      throw error;
    }
  }

  async bulkCreatePurchase(purchaseList) {
    try {
      const result = await this.purchaseRepo.bulkCreate(purchaseList);
      return result;
    } catch (error) {
      throw error;
    }
  }

  async updatePurchaseFlags(purchaseId, flags) {
    try {
      const result = await this.purchaseRepo.updateFlags(purchaseId, flags);
      return result;
    } catch (error) {
      throw error;
    }
  }
}

module.exports = (purchaseRepo, outletUsecase) => {
  return new PurchaseUsecase(purchaseRepo, outletUsecase);
};
