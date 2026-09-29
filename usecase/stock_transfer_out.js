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

/**
 * In-memory join keys. The per-STO lookups these replace compared in SQL,
 * where sto_check.dn_ref_no (INT) matches '00123' and outlets.gofrugal_id
 * (a case-insensitive VARCHAR) ignores case and trailing spaces; the keys
 * are normalised the same way so the batched join matches what SQL matched.
 */
function refKey(v) {
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : String(v).trim();
}

function outletKey(v) {
  return String(v).trim().toLowerCase();
}

/** One outlet query for every distinct Cust_Code in `list` (not one per STO). */
async function attachBranches(list, outletUsecase) {
  if (!outletUsecase || !list.length) return list;
  const found = await outletUsecase.getOutletsByGofrugalIds(list.map((h) => h.Cust_Code));
  const byKey = {};
  Object.values(found).forEach((outlet) => {
    const key = outletKey(outlet.gofrugal_id);
    if (!(key in byKey)) byKey[key] = outlet;
  });
  list.forEach((h) => {
    h.branch = (h.Cust_Code != null && byKey[outletKey(h.Cust_Code)]) || null;
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
    header.file_items = [];
    if (header.items) {
      header.items.forEach((item) => {
        item.file_qty = null;
      });
    }
    return header;
  }
  if (!header.items) {
    header.is_checked = false;
    header.file_items = [];
    return header;
  }
  try {
    const rows = await stoCheckUsecase.getByDnRefNo(header.Dn_Ref_no);
    header.file_items = Array.isArray(rows) ? rows : [];
    header.is_checked = header.file_items.length > 0;
    const map = buildFileQtyMap(rows);
    header.items.forEach((item) => {
      const val = map[String(item.Item_Code)];
      item.file_qty = val !== undefined ? val : null;
    });
  } catch (_) {
    header.is_checked = false;
    header.file_items = [];
    header.items.forEach((item) => {
      item.file_qty = null;
    });
  }
  return header;
}

function applyFileQty(header) {
  if (!header.items) return header;
  const map = buildFileQtyMap(header.file_items);
  header.items.forEach((item) => {
    const val = map[String(item.Item_Code)];
    item.file_qty = val !== undefined ? val : null;
  });
  return header;
}

/**
 * Sets `file_items` / `is_checked` on every header from ONE sto_check query
 * over all their Dn_Ref_no values (not one query per STO). A failed read
 * leaves every header unchecked, as the per-STO lookup it replaces did.
 */
async function attachFileItems(list, stoCheckUsecase) {
  let rows = [];
  if (stoCheckUsecase && list.length) {
    try {
      rows = await stoCheckUsecase.getByDnRefNos(list.map((h) => h.Dn_Ref_no));
    } catch (_) {
      rows = [];
    }
  }
  const byRef = {};
  rows.forEach((r) => {
    const key = refKey(r.dn_ref_no);
    if (!byRef[key]) byRef[key] = [];
    byRef[key].push(r);
  });
  list.forEach((h) => {
    h.file_items = h.Dn_Ref_no != null ? byRef[refKey(h.Dn_Ref_no)] || [] : [];
    h.is_checked = h.file_items.length > 0;
  });
  return list;
}

async function attachFileQtyToList(list, stoCheckUsecase) {
  await attachFileItems(list, stoCheckUsecase);
  list.forEach(applyFileQty);
  return list;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

class StockTransferOutUsecase {
  constructor(stockTransferOutRepo, outletUsecase, stoCheckUsecase) {
    this.stockTransferOutRepo = stockTransferOutRepo;
    this.outletUsecase = outletUsecase;
    this.stoCheckUsecase = stoCheckUsecase;
  }

  /**
   * Listing: headers in the date range, each with `items`, `branch`,
   * `file_items` and `is_checked`. A fixed number of queries whatever the
   * number of STOs: headers, sto_check, detail lines, outlets.
   *
   * `is_checked === true` is applied before detail lines are loaded, and with
   * no date range the header query is restricted to checked references, so
   * unchecked history is never enriched.
   */
  async get(options = {}) {
    try {
      const checkedOnly = options.is_checked === true;
      const hasRange = Boolean(options.from_date || options.to_date);
      let headers;
      if (checkedOnly && !hasRange && this.stoCheckUsecase) {
        const refs = await this.stoCheckUsecase.getCheckedDnRefNos();
        headers = await this.stockTransferOutRepo.getHeaders({ dn_ref_nos: refs });
      } else {
        headers = await this.stockTransferOutRepo.getHeaders({
          from_date: options.from_date,
          to_date: options.to_date,
        });
      }
      if (!headers.length) return [];

      await attachFileItems(headers, this.stoCheckUsecase);
      const list = checkedOnly ? headers.filter((h) => h.is_checked === true) : headers;
      if (!list.length) return [];

      const [detailsByDnNo] = await Promise.all([
        this.stockTransferOutRepo.getDetailsByDnNos(list.map((h) => h.Dn_no)),
        attachBranches(list, this.outletUsecase),
      ]);
      list.forEach((h) => {
        h.items = detailsByDnNo[String(h.Dn_no)] || [];
        applyFileQty(h);
      });
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

  /**
   * Per-day counts for one calendar month: `[{ date, total, checked, unchecked }]`,
   * only days that have at least one STO, ascending. Two queries, no detail
   * lines. `checked` = the STO's Dn_Ref_no has sto_check rows (the listing's
   * `is_checked`).
   */
  async getCalendar(year, month) {
    try {
      const from = `${year}-${pad2(month)}-01`;
      const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
      const to = `${year}-${pad2(month)}-${pad2(lastDay)}`;

      const rows = await this.stockTransferOutRepo.getCalendarRows(from, to);
      const checked = new Set(
        rows.length && this.stoCheckUsecase
          ? (await this.stoCheckUsecase.getCheckedDnRefNos(rows.map((r) => r.Dn_Ref_no))).map(refKey)
          : []
      );

      const byDate = {};
      rows.forEach((r) => {
        if (!r.date) return;
        if (!byDate[r.date]) byDate[r.date] = { date: r.date, total: 0, checked: 0, unchecked: 0 };
        const day = byDate[r.date];
        day.total += 1;
        if (r.Dn_Ref_no != null && checked.has(refKey(r.Dn_Ref_no))) day.checked += 1;
        else day.unchecked += 1;
      });
      return Object.values(byDate).sort((a, b) => (a.date < b.date ? -1 : 1));
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.STOCK_TRANSFER_OUT",
        code: "USECASE.STOCK_TRANSFER_OUT.GET_CALENDAR",
        description: err.toString(),
        category: "",
        ref: { year, month },
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
