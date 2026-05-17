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

  async syncOne(item) {
    const action = String(item.Action || "").toLowerCase();
    const { Action: _action, ...data } = item;

    const refno = String(data.VoucherNumber || "").trim();
    const masterId = String(data.MasterID || "").trim();

    if (!refno || !masterId) {
      return {
        code: 400,
        msg: "VoucherNumber and MasterID are required",
        Action: item.Action,
        master_id: masterId || null,
        mmh_mrc_refno: refno || null,
      };
    }

    if (!["create", "update", "delete"].includes(action)) {
      return {
        code: 400,
        msg: "Invalid Action",
        Action: item.Action,
        master_id: masterId,
        mmh_mrc_refno: refno,
      };
    }

    try {
      const rows = mapTallyDataToPurchaseRows(data);

      if (action === "create") {
        await this.gstTallyPurchaseRepo.upsertFromRows(rows);
        return {
          code: 200,
          Action: item.Action,
          source: "gst_tally_purchase",
          mmh_mrc_refno: refno,
          master_id: masterId,
        };
      }

      if (action === "delete") {
        const del = await this.gstTallyPurchaseRepo.deleteByMasterId(masterId);
        return { ...del, Action: item.Action, master_id: masterId, mmh_mrc_refno: refno };
      }

      if (action === "update") {
        const existsInPurchase =
          await this.purchaseRepo.existsByTallyMasterId(masterId);

        if (existsInPurchase) {
          const mapped = mapTallyDataToPurchaseUpdate(data);
          const updated = await this.purchaseRepo.updateFromTallyDataByMasterId(
            masterId,
            mapped
          );
          if (updated.code === 404) {
            return {
              code: 404,
              msg: updated.msg,
              Action: item.Action,
              master_id: masterId,
              mmh_mrc_refno: refno,
            };
          }
          return {
            code: 200,
            Action: item.Action,
            source: "purchase",
            mmh_mrc_refno: refno,
            master_id: masterId,
            purchase_id: updated.purchase_id,
          };
        }

        await this.gstTallyPurchaseRepo.upsertFromRows(rows);
        return {
          code: 200,
          Action: item.Action,
          source: "gst_tally_purchase",
          mmh_mrc_refno: refno,
          master_id: masterId,
        };
      }

      return {
        code: 400,
        msg: "Invalid Action",
        Action: item.Action,
        master_id: masterId,
        mmh_mrc_refno: refno,
      };
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.GST_TALLY_PURCHASE",
        code: "USECASE.GST_TALLY_PURCHASE.SYNC",
        description: err.toString(),
        category: "",
        ref: { Action: item.Action, mmh_mrc_refno: refno, master_id: masterId },
      });
      throw err;
    }
  }

  async syncBatch({ data }) {
    const results = [];
    for (let i = 0; i < data.length; i++) {
      try {
        const result = await this.syncOne(data[i]);
        results.push({ index: i, ...result });
      } catch (err) {
        results.push({
          index: i,
          code: 500,
          msg: err.message || "Sync failed",
          Action: data[i].Action,
          master_id: data[i].MasterID ?? null,
          mmh_mrc_refno: data[i].VoucherNumber ?? null,
        });
      }
    }
    return { code: 200, results };
  }
}

module.exports = (purchaseRepo, gstTallyPurchaseRepo) => {
  return new GstTallyPurchaseUsecase(purchaseRepo, gstTallyPurchaseRepo);
};
