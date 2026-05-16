const logger = require("../utils/logger");
const {
  mapTallyDataToPurchaseRows,
  mapTallyDataToPurchaseUpdate,
} = require("../utils/tally_purchase_mapper");

class GstTallyPurchaseUsecase {
  constructor(purchaseRepo, gstTallyPurchaseRepo) {
    this.purchaseRepo = purchaseRepo;
    this.gstTallyPurchaseRepo = gstTallyPurchaseRepo;
  }

  async sync({ action, data }) {
    const refno = String(data.VoucherNumber).trim();
    const masterId = String(data.MasterID).trim();

    if (!refno || !masterId) {
      return { code: 400, msg: "VoucherNumber and MasterID are required" };
    }

    try {
      const rows = mapTallyDataToPurchaseRows(data);

      if (action === "create") {
        await this.gstTallyPurchaseRepo.upsertFromRows(rows);
        return {
          code: 200,
          action,
          source: "gst_tally_purchase",
          mmh_mrc_refno: refno,
          master_id: masterId,
        };
      }

      if (action === "delete") {
        return await this.gstTallyPurchaseRepo.deleteByMasterId(masterId);
      }

      if (action === "update") {
        const existsInPurchase = await this.purchaseRepo.existsByMmhMrcRefno(refno);

        if (existsInPurchase) {
          const mapped = mapTallyDataToPurchaseUpdate(data);
          await this.purchaseRepo.updateFromTallyData(refno, mapped);
          return {
            code: 200,
            action,
            source: "purchase",
            mmh_mrc_refno: refno,
            master_id: masterId,
          };
        }

        await this.gstTallyPurchaseRepo.upsertFromRows(rows);
        return {
          code: 200,
          action,
          source: "gst_tally_purchase",
          mmh_mrc_refno: refno,
          master_id: masterId,
        };
      }

      return { code: 400, msg: "Invalid action" };
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.GST_TALLY_PURCHASE",
        code: "USECASE.GST_TALLY_PURCHASE.SYNC",
        description: err.toString(),
        category: "",
        ref: { action, mmh_mrc_refno: refno, master_id: masterId },
      });
      throw err;
    }
  }
}

module.exports = (purchaseRepo, gstTallyPurchaseRepo) => {
  return new GstTallyPurchaseUsecase(purchaseRepo, gstTallyPurchaseRepo);
};
