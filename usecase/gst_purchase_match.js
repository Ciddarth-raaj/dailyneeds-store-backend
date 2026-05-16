class GstPurchaseMatchUsecase {
  constructor(gstPurchaseMatchRepo) {
    this.gstPurchaseMatchRepo = gstPurchaseMatchRepo;
  }

  getAll(filters) {
    return this.gstPurchaseMatchRepo.getAll(filters);
  }

  upsert(row) {
    return this.gstPurchaseMatchRepo.upsert(row);
  }

  delete(gst_purchase_match_id) {
    return this.gstPurchaseMatchRepo.delete(gst_purchase_match_id);
  }
}

module.exports = (gstPurchaseMatchRepo) => {
  return new GstPurchaseMatchUsecase(gstPurchaseMatchRepo);
};
