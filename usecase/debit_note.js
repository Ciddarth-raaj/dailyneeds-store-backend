class DebitNoteUsecase {
  constructor(debitNoteRepo, outletUsecase) {
    this.debitNoteRepo = debitNoteRepo;
    this.outletUsecase = outletUsecase;
    this.telegram = require("../services/telegram")();
  }

  async create(data) {
    try {
      const result = await this.debitNoteRepo.create(data);
      return result;
    } catch (error) {
      throw error;
    }
  }

  async getAll(filters) {
    try {
      const result = await this.debitNoteRepo.getAll(filters);
      return result;
    } catch (error) {
      throw error;
    }
  }

  async bulkCreate(dataList) {
    try {
      const result = await this.debitNoteRepo.bulkCreate(dataList);
      return result;
    } catch (error) {
      throw error;
    }
  }

  async updatePurchaseFlags(purchaseId, flags) {
    try {
      const result = await this.debitNoteRepo.updateFlags(purchaseId, flags);
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
      const result = await this.debitNoteRepo.updateDebitNoteWithInternal(
        purchase,
        purchaseInternal
      );

      if (send_not_matched_notification) {
        try {
          const outlet = await this.outletUsecase.getOutletById(
            purchase.store_id
          );
          const outletName = outlet.length > 0 ? outlet[0].outlet_name : "N/A";

          await this.telegram.sendMessage(
            PURCHASE_TELEGRAM_CHAT_ID,
            `✅ Debit Note #${purchase.mprh_pr_refno} (${outletName}) has been updated with ${purchaseInternal.total_amount} (MPRH Amount: ${purchase.tot_item_value})`
          );
        } catch (error) {
          // do nothing
        }
      }
      return result;
    } catch (error) {
      throw error;
    }
  }
}

module.exports = (debitNoteRepo, outletUsecase) => {
  return new DebitNoteUsecase(debitNoteRepo, outletUsecase);
};
