const ITM_DET_COLUMN_KEYS = new Set([
  "rt",
  "txval",
  "iamt",
  "camt",
  "samt",
  "csamt",
  "cesrt",
  "cesamt",
  "adamt",
]);

function toDecimalOrNull(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * GSTN may return filing date as string (DD-MM-YYYY, etc.) or epoch seconds/ms.
 * @param {string|number|null|undefined} value
 * @returns {number|null} epoch ms
 */
function parseGstDateToEpochMs(value) {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 1e12) return value;
    if (value > 1e9) return value * 1000;
    return null;
  }
  if (typeof value !== "string") return null;
  const t = value.trim();
  if (!t) return null;
  const iso = /^\d{4}-\d{2}-\d{2}/.exec(t);
  if (iso) {
    const d = new Date(t.slice(0, 10));
    return Number.isNaN(d.getTime()) ? null : d.getTime();
  }
  const m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(t);
  if (m) {
    const dd = parseInt(m[1], 10);
    const mm = parseInt(m[2], 10) - 1;
    const yyyy = parseInt(m[3], 10);
    const d = new Date(yyyy, mm, dd);
    return Number.isNaN(d.getTime()) ? null : d.getTime();
  }
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

/**
 * @param {number|null} epochMs
 * @returns {string|null} YYYY-MM-DD for MySQL DATE
 */
function epochMsToSqlDate(epochMs) {
  if (epochMs == null || !Number.isFinite(epochMs)) return null;
  const d = new Date(epochMs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** GSTR-2A B2B invoice filing date field (GSTN naming varies). */
function pickFilingRawFromInv(inv) {
  if (!inv || typeof inv !== "object") return null;
  const direct = [
    inv.fldtr1,
    inv.FLDTR1,
    inv.fldt,
    inv.FLDT,
  ];
  for (const d of direct) {
    if (d != null && String(d).trim() !== "") return String(d).trim();
  }
  for (const key of Object.keys(inv)) {
    if (/^fldtr/i.test(key)) {
      const v = inv[key];
      if (v != null && String(v).trim() !== "") return String(v).trim();
    }
  }
  return null;
}

function pickIdtRawFromInv(inv) {
  if (!inv || typeof inv !== "object") return null;
  const v = inv.idt ?? inv.IDT;
  if (v == null || String(v).trim() === "") return null;
  return String(v).trim();
}

function splitItmDet(itm_det) {
  if (!itm_det || typeof itm_det !== "object") {
    return {
      rt: null,
      txval: null,
      iamt: null,
      camt: null,
      samt: null,
      csamt: null,
      cesrt: null,
      cesamt: null,
      adamt: null,
      itm_det_extra: null,
    };
  }
  const extra = { ...itm_det };
  for (const k of ITM_DET_COLUMN_KEYS) {
    delete extra[k];
  }
  const extraKeys = Object.keys(extra).filter((k) => extra[k] !== undefined);
  return {
    rt: toDecimalOrNull(itm_det.rt),
    txval: toDecimalOrNull(itm_det.txval),
    iamt: toDecimalOrNull(itm_det.iamt),
    camt: toDecimalOrNull(itm_det.camt),
    samt: toDecimalOrNull(itm_det.samt),
    csamt: toDecimalOrNull(itm_det.csamt),
    cesrt: toDecimalOrNull(itm_det.cesrt),
    cesamt: toDecimalOrNull(itm_det.cesamt),
    adamt: toDecimalOrNull(itm_det.adamt),
    itm_det_extra: extraKeys.length ? extra : null,
  };
}

function bumpMaxDate(map, key, raw) {
  const ep = parseGstDateToEpochMs(raw);
  if (ep == null) return;
  const prev = map.get(key);
  if (prev == null || ep > prev) {
    map.set(key, ep);
  }
}

/**
 * Persists GSTR-2A B2B payload into gst_b2b / gst_b2b_invoices / gst_b2b_invoice_items
 * and vendor_filing_date. For the same return period, existing rows are removed first.
 *
 * @param {Map<string, number>} ctinToVendorId — uppercased CTIN → gst_vendor_id (all vendors must exist before call)
 */
class GstB2bSyncService {
  constructor({
    gstB2bRepo,
    gstB2bInvoiceRepo,
    gstB2bInvoiceItemRepo,
    vendorFilingDateRepo,
  }) {
    this.gstB2bRepo = gstB2bRepo;
    this.gstB2bInvoiceRepo = gstB2bInvoiceRepo;
    this.gstB2bInvoiceItemRepo = gstB2bInvoiceItemRepo;
    this.vendorFilingDateRepo = vendorFilingDateRepo;
  }

  async deleteReturnPeriodData(year, month) {
    await this.vendorFilingDateRepo.deleteByReturnPeriod(year, month);
    await this.gstB2bRepo.deleteByReturnPeriod(year, month);
  }

  /**
   * @param {object[]} b2bArray Sandbox `data.data.b2b`
   * @param {number} year
   * @param {number} month 1-12
   * @param {Map<string, number>} ctinToVendorId
   */
  async syncFromB2bArray(b2bArray, year, month, ctinToVendorId) {
    await this.deleteReturnPeriodData(year, month);

    if (!ctinToVendorId || ctinToVendorId.size === 0) {
      return {
        inserted_b2b: 0,
        inserted_invoices: 0,
        inserted_items: 0,
        vendor_filings: 0,
      };
    }

    if (!Array.isArray(b2bArray) || b2bArray.length === 0) {
      for (const [, gstVendorId] of ctinToVendorId) {
        await this.vendorFilingDateRepo.insert({
          gst_vendor_id: gstVendorId,
          last_filing_date: null,
          year,
          month,
        });
      }
      return {
        inserted_b2b: 0,
        inserted_invoices: 0,
        inserted_items: 0,
        vendor_filings: ctinToVendorId.size,
      };
    }

    const maxFldEpochByCtin = new Map();
    const maxIdtEpochByCtin = new Map();

    let insertedB2b = 0;
    let insertedInvoices = 0;
    let insertedItems = 0;

    for (let bi = 0; bi < b2bArray.length; bi++) {
      const block = b2bArray[bi];
      if (!block || typeof block !== "object") continue;
      const ctin = String(block.ctin || "")
        .trim()
        .toUpperCase();
      if (!ctin) continue;

      const gstVendorId = ctinToVendorId.get(ctin);
      if (gstVendorId == null) {
        continue;
      }

      const cfs =
        block.cfs != null && block.cfs !== ""
          ? String(block.cfs).slice(0, 8)
          : null;

      const gstB2bId = await this.gstB2bRepo.insert({
        year,
        month,
        b2b_index: bi,
        gst_vendor_id: gstVendorId,
        ctin,
        cfs,
      });
      insertedB2b += 1;

      const invList = Array.isArray(block.inv) ? block.inv : [];
      for (let ii = 0; ii < invList.length; ii++) {
        const inv = invList[ii];
        if (!inv || typeof inv !== "object") continue;

        const filingRaw = pickFilingRawFromInv(inv);
        bumpMaxDate(maxFldEpochByCtin, ctin, filingRaw);

        const idtRaw = pickIdtRawFromInv(inv);
        bumpMaxDate(maxIdtEpochByCtin, ctin, idtRaw);

        const invoiceId = await this.gstB2bInvoiceRepo.insert({
          gst_b2b_id: gstB2bId,
          inv_index: ii,
          inum: inv.inum != null ? String(inv.inum) : null,
          idt: inv.idt != null ? String(inv.idt) : null,
          oinum: inv.oinum != null ? String(inv.oinum) : null,
          oidt: inv.oidt != null ? String(inv.oidt) : null,
          val: toDecimalOrNull(inv.val),
          pos: inv.pos != null ? String(inv.pos).slice(0, 8) : null,
          rchrg: inv.rchrg != null ? String(inv.rchrg).slice(0, 8) : null,
          inv_typ: inv.inv_typ != null ? String(inv.inv_typ).slice(0, 16) : null,
          etin: inv.etin != null ? String(inv.etin).slice(0, 16) : null,
          fldtr1:
            filingRaw != null ? String(filingRaw).slice(0, 64) : null,
          diff_percent:
            inv.diff_percent != null ? String(inv.diff_percent).slice(0, 16) : null,
        });
        insertedInvoices += 1;

        const itms = Array.isArray(inv.itms) ? inv.itms : [];
        let lineIdx = 0;
        for (const itm of itms) {
          if (!itm || typeof itm !== "object") continue;
          const det = itm.itm_det;
          const cols = splitItmDet(det);
          await this.gstB2bInvoiceItemRepo.insert({
            gst_b2b_invoice_id: invoiceId,
            line_index: lineIdx,
            ...cols,
          });
          lineIdx += 1;
          insertedItems += 1;
        }
      }
    }

    let vendorFilings = 0;
    for (const [ctin, gstVendorId] of ctinToVendorId) {
      const fldEp = maxFldEpochByCtin.get(ctin);
      const idtEp = maxIdtEpochByCtin.get(ctin);
      const chosenEp =
        fldEp != null ? fldEp : idtEp != null ? idtEp : null;
      const sqlDate = epochMsToSqlDate(chosenEp);

      await this.vendorFilingDateRepo.insert({
        gst_vendor_id: gstVendorId,
        last_filing_date: sqlDate,
        year,
        month,
      });
      vendorFilings += 1;
    }

    return {
      inserted_b2b: insertedB2b,
      inserted_invoices: insertedInvoices,
      inserted_items: insertedItems,
      vendor_filings: vendorFilings,
    };
  }
}

module.exports = {
  GstB2bSyncService,
  parseGstDateToEpochMs,
  epochMsToSqlDate,
  splitItmDet,
  pickFilingRawFromInv,
  pickIdtRawFromInv,
};
