const moment = require("moment");
const logger = require("./logger");
const { normalizePurchaseTaxArrays } = require("./purchase_tax");

/**
 * A ledger line that looks like it carries tax or taxable value. Used only to
 * decide whether an unrecognised line is worth reporting: party, rounding and
 * charge ledgers are expected not to match and are not interesting.
 */
function looksLikeTaxLedger(name) {
  return /purchase|gst|cess/i.test(name);
}

const OUTLET_VOUCHER_TYPE_MAP = {
  2: "Purchase",
  3: "PurchaseDN2",
  4: "PurchaseDN1",
  5: "PurchaseDN3",
  6: "PurchaseDN4",
  7: "PurchaseDN5",
};

const VOUCHER_TYPE_TO_OUTLET_ID = Object.fromEntries(
  Object.entries(OUTLET_VOUCHER_TYPE_MAP).map(([id, name]) => [
    name,
    Number(id),
  ])
);

function parseTallyVoucherDate(value) {
  if (value == null || value === "") {
    return null;
  }
  const s = String(value).trim();
  if (/^\d{8}$/.test(s)) {
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  }
  const m = moment(s, ["YYYY-MM-DD", "YYYYMMDD", moment.ISO_8601], true);
  return m.isValid() ? m.format("YYYY-MM-DD") : null;
}

function ledgerAmountByName(ledgerentries, ledgerName) {
  if (!Array.isArray(ledgerentries)) {
    return null;
  }
  const entry = ledgerentries.find((e) => e && e.LedgerName === ledgerName);
  if (!entry || entry.LedgerAmount === "" || entry.LedgerAmount == null) {
    return null;
  }
  const amt = parseFloat(entry.LedgerAmount);
  return Number.isFinite(amt) ? Math.abs(amt) : null;
}

function parseVoucherTotal(value) {
  if (value === "" || value == null) {
    return null;
  }
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

function isJournalEntry(tallyData) {
  return String(tallyData.VoucherType || "").trim() === "Journal";
}

/** Fallback when VoucherCostCentre does not match an outlet (PurchaseDN* voucher types). */
function resolveRetailOutletIdFromVoucherType(tallyData) {
  const voucherType = String(tallyData.VoucherType || "").trim();
  if (voucherType && VOUCHER_TYPE_TO_OUTLET_ID[voucherType] != null) {
    return VOUCHER_TYPE_TO_OUTLET_ID[voucherType];
  }
  return null;
}

function resolveRetailOutletId(tallyData) {
  return resolveRetailOutletIdFromVoucherType(tallyData);
}

function shouldUseIgst(supplierGstn) {
  if (!supplierGstn) {
    return false;
  }
  return !String(supplierGstn).startsWith("34");
}

function extractTaxArraysFromLedgerEntries(ledgerentries, supplierGstn) {
  const sgst = [];
  const cgst = [];
  const igst = [];
  const cess = [];
  const useIgst = shouldUseIgst(supplierGstn);

  if (!Array.isArray(ledgerentries)) {
    return {
      sgst,
      cgst,
      igst,
      cess,
      tot_sgst_amt: 0,
      tot_cgst_amt: 0,
      tot_igst_amt: 0,
      tot_gst_cess_amt: 0,
    };
  }

  const taxableByRate = new Map();
  const taxValueByRate = new Map();
  const unrecognised = [];

  for (const entry of ledgerentries) {
    const name = String(entry.LedgerName || "");
    const amount = parseFloat(entry.LedgerAmount);
    if (!Number.isFinite(amount)) {
      continue;
    }
    const absAmt = Math.abs(amount);
    let recognised = false;

    if (
      name === "Local GST Purchase Nil Rated" ||
      name === "IGST Purchase Nil Rated"
    ) {
      taxableByRate.set(0, (taxableByRate.get(0) || 0) + absAmt);
      recognised = true;
      continue;
    }

    let match = name.match(/^LOCAL PURCHASE (\d+(?:\.\d+)?)%$/i);
    if (match && !useIgst) {
      const combinedRate = parseFloat(match[1]);
      const perc = combinedRate / 2;
      taxableByRate.set(perc, (taxableByRate.get(perc) || 0) + absAmt);
      recognised = true;
      continue;
    }

    match = name.match(/^IGST PURCHASE (\d+(?:\.\d+)?)%$/i);
    if (match && useIgst) {
      const perc = parseFloat(match[1]);
      taxableByRate.set(perc, (taxableByRate.get(perc) || 0) + absAmt);
      recognised = true;
      continue;
    }

    match = name.match(/^CGST (\d+(?:\.\d+)?)% INPUT$/i);
    if (match && !useIgst) {
      const perc = parseFloat(match[1]);
      taxValueByRate.set(
        `cgst-${perc}`,
        (taxValueByRate.get(`cgst-${perc}`) || 0) + absAmt
      );
      recognised = true;
      continue;
    }

    match = name.match(/^SGST (\d+(?:\.\d+)?)% INPUT$/i);
    if (match && !useIgst) {
      const perc = parseFloat(match[1]);
      taxValueByRate.set(
        `sgst-${perc}`,
        (taxValueByRate.get(`sgst-${perc}`) || 0) + absAmt
      );
      recognised = true;
      continue;
    }

    match = name.match(/^IGST (\d+(?:\.\d+)?)% INPUT$/i);
    if (match && useIgst) {
      const perc = parseFloat(match[1]);
      taxValueByRate.set(
        `igst-${perc}`,
        (taxValueByRate.get(`igst-${perc}`) || 0) + absAmt
      );
      recognised = true;
    }

    // Nothing claimed this line. Silently dropping it is how a voucher ends up
    // stored with no taxable value and no tax at all, so keep the name to
    // report - the two ways that happens are a ledger named unlike any pattern
    // here, and a local/interstate line arriving on a voucher classified the
    // other way by its GSTIN.
    if (!recognised && looksLikeTaxLedger(name)) {
      unrecognised.push(name);
    }
  }

  let tot_sgst_amt = 0;
  let tot_cgst_amt = 0;
  let tot_igst_amt = 0;

  for (const [perc, taxable] of taxableByRate.entries()) {
    if (useIgst) {
      const value = taxValueByRate.get(`igst-${perc}`) || 0;
      igst.push({ PERC: perc, TAXABLE: taxable, VALUE: value });
      tot_igst_amt += value;
    } else {
      const cgstVal = taxValueByRate.get(`cgst-${perc}`) || 0;
      const sgstVal = taxValueByRate.get(`sgst-${perc}`) || 0;
      cgst.push({ PERC: perc, TAXABLE: taxable, VALUE: cgstVal });
      sgst.push({ PERC: perc, TAXABLE: taxable, VALUE: sgstVal });
      tot_cgst_amt += cgstVal;
      tot_sgst_amt += sgstVal;
    }
  }

  const tot_gst_cess_amt =
    ledgerAmountByName(ledgerentries, "CESS 12% INPUT") || 0;
  if (tot_gst_cess_amt) {
    const legacyTaxable = sgst.find((entry) => Number(entry.PERC) === 14);
    cess.push({
      PERC: 12,
      TAXABLE: legacyTaxable ? legacyTaxable.TAXABLE : 0,
      VALUE: tot_gst_cess_amt,
    });
  }

  return {
    ...normalizePurchaseTaxArrays({
      sgst,
      cgst,
      igst,
      cess,
      tot_sgst_amt,
      tot_cgst_amt,
      tot_igst_amt,
      tot_gst_cess_amt,
    }),
    // Read by the caller for reporting only; not a stored column.
    unrecognisedTaxLedgers: unrecognised,
  };
}

/**
 * Maps GET /tally/purchase entry payload to purchase + purchase_internal row shapes.
 */
function mapTallyDataToPurchaseRows(tallyData) {
  const ledgerentries = tallyData.ledgerentries || [];
  const voucherTotal = parseVoucherTotal(tallyData.Voucher_Total);
  const voucherDate = parseTallyVoucherDate(tallyData.VoucherDate);
  const distBillDate = parseTallyVoucherDate(
    tallyData.ReferenceDate || tallyData.VoucherDate
  );
  const supplierGstn = tallyData.BuyerGSTIN || null;
  const taxes = extractTaxArraysFromLedgerEntries(ledgerentries, supplierGstn);

  // A voucher that stores no taxable value and no tax is not obviously broken
  // once it is a row on a page - the amount still looks right. Report it at
  // import, naming the lines that were not understood and which way the GSTIN
  // classified the voucher, so the cause is visible without the raw payload.
  if (taxes.unrecognisedTaxLedgers.length) {
    logger.Log({
      level: logger.LEVEL.WARN,
      component: "UTILS.TALLY_PURCHASE_MAPPER",
      code: "UTILS.TALLY_PURCHASE_MAPPER.UNRECOGNISED_TAX_LEDGER",
      description: `Tax ledger lines not understood: ${taxes.unrecognisedTaxLedgers.join(
        ", "
      )}`,
      category: "",
      ref: {
        MasterID: tallyData.MasterID ?? null,
        VoucherNumber: tallyData.VoucherNumber ?? null,
        BuyerGSTIN: supplierGstn,
        treated_as: shouldUseIgst(supplierGstn) ? "interstate" : "local",
        unrecognised: taxes.unrecognisedTaxLedgers,
      },
    });
  }

  const internal = {
    cash_discount: ledgerAmountByName(ledgerentries, "Cash Discount") || 0,
    scheme_difference:
      ledgerAmountByName(ledgerentries, "Scheme Difference") || 0,
    cost_difference: ledgerAmountByName(ledgerentries, "Cost Difference") || 0,
    due: ledgerAmountByName(ledgerentries, "Due") || 0,
    freight_charges: ledgerAmountByName(ledgerentries, "Freight Charges") || 0,
    round_off: ledgerAmountByName(ledgerentries, "Round Off") || 0,
    jv_ledger: isJournalEntry(tallyData) ? 1 : 0,
    narration: tallyData.Narration || "",
    supplier_credit_note:
      ledgerAmountByName(ledgerentries, "Supplier Credit Note") || 0,
    total_amount: voucherTotal != null ? voucherTotal : 0,
    invoice_amount: voucherTotal != null ? voucherTotal : 0,
  };

  if (isJournalEntry(tallyData)) {
    return {
      purchase: {
        master_id: String(tallyData.MasterID).trim(),
        mmh_mrc_refno: String(tallyData.VoucherNumber).trim(),
        retail_outlet_id: resolveRetailOutletId(tallyData),
        supplier_id: tallyData.PartyCode || null,
        supplier_name: tallyData.PartyName || null,
        supplier_gstn: supplierGstn,
        mmh_mrc_no: null,
        mmh_mrc_dt: voucherDate,
        mmh_mrc_amt: voucherTotal != null ? voucherTotal : 0,
        mmh_dist_bill_dt: distBillDate,
        mmh_dist_bill_no: tallyData.Reference || null,
        mmh_manual_disc: 0,
        tot_sgst_amt: 0,
        tot_cgst_amt: 0,
        tot_igst_amt: 0,
        tot_gst_cess_amt: 0,
        mmd_goods_tcs_amt: 0,
        ts: Math.floor(Date.now() / 1000),
        sgst: [],
        cgst: [],
        igst: [],
        cess: [],
      },
      internal,
    };
  }

  const manualDisc = ledgerAmountByName(ledgerentries, "Discount on Purchase");

  return {
    purchase: {
      master_id: String(tallyData.MasterID).trim(),
      mmh_mrc_refno: String(tallyData.VoucherNumber).trim(),
      retail_outlet_id: resolveRetailOutletId(tallyData),
      supplier_id: tallyData.PartyCode || null,
      supplier_name: tallyData.PartyName || null,
      supplier_gstn: supplierGstn,
      mmh_mrc_no: null,
      mmh_mrc_dt: voucherDate,
      mmh_mrc_amt: voucherTotal != null ? voucherTotal : 0,
      mmh_dist_bill_dt: distBillDate,
      mmh_dist_bill_no: tallyData.Reference || null,
      mmh_manual_disc: manualDisc != null ? manualDisc : 0,
      tot_sgst_amt: taxes.tot_sgst_amt,
      tot_cgst_amt: taxes.tot_cgst_amt,
      tot_igst_amt: taxes.tot_igst_amt,
      tot_gst_cess_amt: taxes.tot_gst_cess_amt,
      mmd_goods_tcs_amt: ledgerAmountByName(ledgerentries, "TCS @ 0.1%") || 0,
      ts: Math.floor(Date.now() / 1000),
      sgst: taxes.sgst,
      cgst: taxes.cgst,
      igst: taxes.igst,
      cess: taxes.cess,
    },
    internal,
  };
}

/** Partial fields for updating an existing purchase row from tally data. */
function mapTallyDataToPurchaseUpdate(tallyData) {
  const { purchase, internal } = mapTallyDataToPurchaseRows(tallyData);
  const {
    master_id,
    mmh_mrc_refno,
    sgst,
    cgst,
    igst,
    cess,
    ...purchaseFields
  } = purchase;

  return {
    purchase: {
      ...purchaseFields,
      sgst: JSON.stringify(sgst),
      cgst: JSON.stringify(cgst),
      igst: JSON.stringify(igst),
      cess: JSON.stringify(cess),
    },
    internal,
  };
}

module.exports = {
  parseTallyVoucherDate,
  mapTallyDataToPurchaseRows,
  mapTallyDataToPurchaseUpdate,
  isJournalEntry,
  resolveRetailOutletIdFromVoucherType,
};
