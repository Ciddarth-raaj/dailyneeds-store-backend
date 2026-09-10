class PurchaseGstUsecase {
  constructor(purchaseGstRepo) {
    this.purchaseGstRepo = purchaseGstRepo;
  }

  async getAll(filters) {
    return this.purchaseGstRepo.getAll(filters);
  }

  async getById(gst_tally_purchase_id) {
    return this.purchaseGstRepo.getById(gst_tally_purchase_id);
  }

  async deleteTallyRow(gst_tally_purchase_id) {
    return this.purchaseGstRepo.deleteTallyRow(gst_tally_purchase_id);
  }

  async deleteTallyRows(ids) {
    return this.purchaseGstRepo.deleteTallyRows(ids);
  }
}

module.exports = (purchaseGstRepo) => {
  return new PurchaseGstUsecase(purchaseGstRepo);
};
