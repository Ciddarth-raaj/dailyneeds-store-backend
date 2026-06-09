const { purchaseEntryMasterId } = require("../utils/tally_master_id");

class PurchaseTallyUsecase {
  constructor(purchaseTallyRepo, gstTallyPurchaseRepo) {
    this.purchaseTallyRepo = purchaseTallyRepo;
    this.gstTallyPurchaseRepo = gstTallyPurchaseRepo;
  }

  async create(data) {
    const purchaseId =
      await this.purchaseTallyRepo.findPurchaseIdForTallyResponse(data);

    if (purchaseId == null || purchaseId === "") {
      return {
        code: 404,
        msg: "Purchase does not exist for the provided voucher number, supplier name, GSTIN, and cost centre",
      };
    }

    const masterId = purchaseEntryMasterId(purchaseId);

    const existingByPurchase =
      await this.purchaseTallyRepo.findByPurchaseId(purchaseId);
    if (
      existingByPurchase &&
      String(existingByPurchase.MasterID) !== String(masterId)
    ) {
      return {
        code: 409,
        msg: "This purchase already has a Tally response linked with a different MasterID",
        purchase_id: purchaseId,
        existing_master_id: existingByPurchase.MasterID,
      };
    }

    const existingByMaster = await this.purchaseTallyRepo.findByMasterId(
      masterId
    );
    if (
      existingByMaster &&
      Number(existingByMaster.purchase_id) !== Number(purchaseId)
    ) {
      return {
        code: 409,
        msg: "MasterID is already linked to a different purchase",
        purchase_id: existingByMaster.purchase_id,
      };
    }

    const result = await this.purchaseTallyRepo.create({
      ...data,
      MasterID: masterId,
      purchase_id: purchaseId,
    });

    if (result.code === 200 && this.gstTallyPurchaseRepo) {
      try {
        const gstCopy = await this.gstTallyPurchaseRepo.copyFromPurchase(
          purchaseId,
          masterId
        );
        return {
          ...result,
          purchase_id: purchaseId,
          gst_tally_purchase_id: gstCopy.gst_tally_purchase_id,
        };
      } catch (err) {
        return {
          code: 500,
          msg:
            err.message ||
            "Tally response saved but failed to copy purchase to GST tally table",
          purchase_id: purchaseId,
        };
      }
    }

    return result;
  }

  async getAll(filters) {
    return this.purchaseTallyRepo.getAll(filters);
  }

  async getById(id) {
    return this.purchaseTallyRepo.getById(id);
  }

  async update(id, data) {
    return this.purchaseTallyRepo.update(id, data);
  }

  async delete(id) {
    return this.purchaseTallyRepo.delete(id);
  }
}

module.exports = (purchaseTallyRepo, gstTallyPurchaseRepo) => {
  return new PurchaseTallyUsecase(purchaseTallyRepo, gstTallyPurchaseRepo);
};
