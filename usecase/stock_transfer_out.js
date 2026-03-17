const logger = require("../utils/logger");

async function attachBranch(header, outletUsecase) {
  if (!outletUsecase || header.Cust_Code == null) {
    header.branch = null;
    return header;
  }
  try {
    const outlet = await outletUsecase.getOutletByGofrugalId(header.Cust_Code);
    header.branch = outlet || null;
  } catch (_) {
    header.branch = null;
  }
  return header;
}

async function attachBranches(list, outletUsecase) {
  if (!outletUsecase || !list.length) return list;
  const branches = await Promise.all(
    list.map((h) => outletUsecase.getOutletByGofrugalId(h.Cust_Code))
  );
  list.forEach((h, i) => {
    h.branch = branches[i] || null;
  });
  return list;
}

function buildFileQtyMap(stoRows) {
  const map = {};
  (stoRows || []).forEach((r) => {
    map[String(r.product_id)] = r.file_qty !== undefined && r.file_qty !== null ? r.file_qty : null;
  });
  return map;
}

async function attachFileQtyToItems(header, stoCheckUsecase) {
  if (!stoCheckUsecase || header.Dn_Ref_no == null) {
    header.is_checked = false;
    if (header.items) {
      header.items.forEach((item) => {
        item.file_qty = null;
      });
    }
    return header;
  }
  if (!header.items) {
    header.is_checked = false;
    return header;
  }
  try {
    const rows = await stoCheckUsecase.getByDnRefNo(header.Dn_Ref_no);
    header.is_checked = Array.isArray(rows) && rows.length > 0;
    const map = buildFileQtyMap(rows);
    header.items.forEach((item) => {
      const val = map[String(item.Item_Code)];
      item.file_qty = val !== undefined ? val : null;
    });
  } catch (_) {
    header.is_checked = false;
    header.items.forEach((item) => {
      item.file_qty = null;
    });
  }
  return header;
}

async function attachFileQtyToList(list, stoCheckUsecase) {
  if (!stoCheckUsecase || !list.length) return list;
  await Promise.all(list.map((h) => attachFileQtyToItems(h, stoCheckUsecase)));
  return list;
}

class StockTransferOutUsecase {
  constructor(stockTransferOutRepo, outletUsecase, stoCheckUsecase) {
    this.stockTransferOutRepo = stockTransferOutRepo;
    this.outletUsecase = outletUsecase;
    this.stoCheckUsecase = stoCheckUsecase;
  }

  async get(options = {}) {
    try {
      const list = await this.stockTransferOutRepo.get();
      await attachBranches(list, this.outletUsecase);
      await attachFileQtyToList(list, this.stoCheckUsecase);
      if (options.is_checked === true) {
        return list.filter((h) => h.is_checked === true);
      }
      return list;
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.STOCK_TRANSFER_OUT",
        code: "USECASE.STOCK_TRANSFER_OUT.GET",
        description: err.toString(),
        category: "",
        ref: {},
      });
      throw err;
    }
  }

  async getByDnNo(Dn_no) {
    try {
      const row = await this.stockTransferOutRepo.getByDnNo(Dn_no);
      if (!row) return null;
      await attachBranch(row, this.outletUsecase);
      await attachFileQtyToItems(row, this.stoCheckUsecase);
      return row;
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.STOCK_TRANSFER_OUT",
        code: "USECASE.STOCK_TRANSFER_OUT.GET_BY_DN_NO",
        description: err.toString(),
        category: "",
        ref: { Dn_no },
      });
      throw err;
    }
  }

  async getByDnRefNo(Dn_Ref_no) {
    try {
      const list = await this.stockTransferOutRepo.getByDnRefNo(Dn_Ref_no);
      await attachBranches(list, this.outletUsecase);
      await attachFileQtyToList(list, this.stoCheckUsecase);
      return list;
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.STOCK_TRANSFER_OUT",
        code: "USECASE.STOCK_TRANSFER_OUT.GET_BY_DN_REF_NO",
        description: err.toString(),
        category: "",
        ref: { Dn_Ref_no },
      });
      throw err;
    }
  }
}

module.exports = (stockTransferOutRepo, outletUsecase, stoCheckUsecase) => {
  return new StockTransferOutUsecase(stockTransferOutRepo, outletUsecase, stoCheckUsecase);
};
