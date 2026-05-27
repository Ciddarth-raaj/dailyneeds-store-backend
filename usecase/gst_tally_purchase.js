const logger = require("../utils/logger");
const {
  mapTallyDataToPurchaseRows,
  resolveRetailOutletIdFromVoucherType,
} = require("../utils/tally_purchase_mapper");

function normalizeGstin(gstin) {
  return String(gstin || "")
    .trim()
    .toUpperCase();
}

class GstTallyPurchaseUsecase {
  constructor(gstTallyPurchaseRepo, gstVendorRepo) {
    this.gstTallyPurchaseRepo = gstTallyPurchaseRepo;
    this.gstVendorRepo = gstVendorRepo;
    this._gstinToVendorId = null;
  }

  async _loadGstinToVendorIdMap() {
    if (this._gstinToVendorId) {
      return this._gstinToVendorId;
    }
    const map = new Map();
    if (this.gstVendorRepo) {
      const vendors = await this.gstVendorRepo.getAll();
      for (const v of vendors) {
        if (!v.is_active) continue;
        const key = normalizeGstin(v.gstin);
        if (key && !map.has(key)) {
          map.set(key, v.gst_vendor_id);
        }
      }
    }
    this._gstinToVendorId = map;
    return map;
  }

  /** supplier_id from existing gst_tally_purchase row, else gst_vendors by GSTIN. */
  async resolveSupplierId(masterId, supplierGstn, supplierName) {
    const fromGst = await this.gstTallyPurchaseRepo.getSupplierIdByMasterId(
      masterId
    );
    if (fromGst) {
      return fromGst;
    }

    const gstn = normalizeGstin(supplierGstn);
    if (gstn) {
      const map = await this._loadGstinToVendorIdMap();
      const gstVendorId = map.get(gstn);
      if (gstVendorId != null) {
        return String(gstVendorId);
      }
    }

    return null;
  }

  async applyRetailOutletId(rows, tallyData) {
    const costCentre = String(tallyData.VoucherCostCentre || "").trim();
    if (costCentre) {
      const outletId =
        await this.gstTallyPurchaseRepo.findOutletIdByCostCentre(costCentre);
      if (outletId != null) {
        rows.purchase.retail_outlet_id = outletId;
        return;
      }
    }
    const fromVoucherType = resolveRetailOutletIdFromVoucherType(tallyData);
    if (fromVoucherType != null) {
      rows.purchase.retail_outlet_id = fromVoucherType;
    }
  }

  async applyResolvedSupplierId(rows, tallyData, masterId) {
    const supplierGstn =
      rows.purchase.supplier_gstn != null
        ? rows.purchase.supplier_gstn
        : tallyData.BuyerGSTIN;
    rows.purchase.supplier_id = await this.resolveSupplierId(
      masterId,
      supplierGstn,
      tallyData.PartyName
    );
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
      if (action === "delete") {
        const del = await this.gstTallyPurchaseRepo.deleteByMasterId(masterId);
        return {
          ...del,
          Action: item.Action,
          master_id: masterId,
          mmh_mrc_refno: refno,
        };
      }

      const rows = mapTallyDataToPurchaseRows(data);
      await this.applyRetailOutletId(rows, data);
      await this.applyResolvedSupplierId(rows, data, masterId);
      await this.gstTallyPurchaseRepo.upsertFromRows({
        ...rows,
        source: "tally",
      });

      return {
        code: 200,
        Action: item.Action,
        source: "gst_tally_purchase",
        mmh_mrc_refno: refno,
        master_id: masterId,
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
    this._gstinToVendorId = null;
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

module.exports = (gstTallyPurchaseRepo, gstVendorRepo) => {
  return new GstTallyPurchaseUsecase(gstTallyPurchaseRepo, gstVendorRepo);
};
