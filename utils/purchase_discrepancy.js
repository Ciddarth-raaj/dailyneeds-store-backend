/**
 * Purchase discrepancies for Accounts.
 *
 * The one definition of what the Purchase screen flags on a bill. The same
 * file lives in the frontend at util/purchaseDiscrepancy.js - keep the two
 * identical.
 *
 * severity
 *   "block"  - Tally would receive a wrong voucher; the bill cannot be
 *              approved until Accounts corrects it. Enforced for RetailPilot
 *              bills only: on a GoFrugal bill the same finding is shown as
 *              "review", so historical approval behaviour does not change
 *              (see asLegacy).
 *   "review" - may be right, may be a data-entry slip; shown, not blocking.
 *   "info"   - shown on the bill only (e.g. a round-off the sync pre-filled
 *              that Accounts have not confirmed yet).
 *
 * Plain CommonJS with no dependencies, so the backend, the Next.js app and
 * `node --test` all load it as is.
 */

const toNumber = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const str = (v) => (v == null ? "" : String(v).trim());

const parseList = (v) => {
  if (Array.isArray(v)) return v;
  if (v == null || v === "") return [];
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
};

/**
 * Same rule as the Purchase screen's and the Tally export's shouldShowIGST:
 * a missing GSTIN or a Puducherry (34) one is local (CGST/SGST), any other
 * GSTIN is an other-state supplier (IGST).
 */
function isInterstateSupplier(gstn) {
  const g = str(gstn);
  return !(g === "" || g === "0" || g.startsWith("34"));
}

const GSTIN_PATTERN = /^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]{3}$/;

/**
 * YYYY-MM-DD of a DATE value, in local time: a 'YYYY-MM-DD' string as is, a
 * Date or a timestamp string (a DATE column serialised to JSON) by its
 * local calendar day, so IST midnight stays the same day.
 */
function dayOf(v) {
  if (v == null || v === "") return null;
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** First year of the April-March financial year a YYYY-MM-DD falls in. */
function financialYearOf(day) {
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(5, 7));
  return m >= 4 ? y : y - 1;
}

const fyLabel = (start) => `${start}-${String((start + 1) % 100).padStart(2, "0")}`;

const describeLines = (lines, kind) =>
  lines
    .map((l) => `${kind} ${toNumber(l.PERC)}% on ${toNumber(l.TAXABLE).toFixed(2)} (${toNumber(l.VALUE).toFixed(2)})`)
    .join(", ");

/**
 * @param p a purchase: supplier_gstn, sgst/cgst/igst (arrays or JSON),
 *   mmh_mrc_dt, mmh_dist_bill_dt, mmh_mrc_refno; for a RetailPilot bill also
 *   voucher_fy (first year of the financial year its ref no is numbered in)
 *   and entered_at (the day it was entered in RetailPilot)
 * @returns [{ code, severity, message }]
 */
function purchaseDiscrepancies(p) {
  const out = [];
  if (!p) return out;

  const gstn = str(p.supplier_gstn);
  // A blank GSTIN is an UNREGISTERED supplier - valid, and never flagged by
  // itself. Registration is not inferred from anything else: there is no
  // registered/unregistered field on the purchase or the supplier.
  const unregistered = gstn === "" || gstn === "0";
  const interstate = isInterstateSupplier(gstn);
  const charged = (l) => toNumber(l.TAXABLE) !== 0 || toNumber(l.VALUE) !== 0;
  const taxed = (l) => toNumber(l.VALUE) !== 0;
  const cgst = parseList(p.cgst);
  const sgst = parseList(p.sgst);
  const igst = parseList(p.igst);

  if (unregistered) {
    // GST on a bill from an unregistered supplier: Accounts decide the
    // treatment. Exported as it stands, CGST/SGST would go to Tally as INPUT
    // tax (input tax credit claimed) and IGST would be left out entirely.
    const taxLines = [
      describeLines(igst.filter(taxed), "IGST"),
      describeLines(cgst.filter(taxed), "CGST"),
      describeLines(sgst.filter(taxed), "SGST"),
    ].filter(Boolean);
    if (taxLines.length) {
      out.push({
        code: "UNREGISTERED_SUPPLIER_TAX",
        severity: "block",
        message:
          `Unregistered supplier (no GSTIN) with GST on the bill: ${taxLines.join(", ")}. ` +
          "Review the tax treatment before approval: if the supplier is registered, enter its GSTIN; " +
          "if not, enter the bill without input tax (e.g. the amount as nil-rated). " +
          "As it stands Tally would get CGST/SGST as input tax and no IGST.",
      });
    } else if (igst.some(charged)) {
      out.push({
        code: "TAX_TYPE_MISMATCH",
        severity: "block",
        message:
          `IGST lines (${describeLines(igst.filter(charged), "IGST")}) on an unregistered supplier: ` +
          "the screen and Tally take CGST/SGST lines only for a supplier with no GSTIN, so this value would drop out. " +
          "Re-enter it below.",
      });
    }
  } else if (interstate) {
    // Registered, other state: the screen and Tally read IGST only.
    const local = [...cgst, ...sgst].filter(charged);
    if (local.length) {
      const lines = [describeLines(cgst.filter(charged), "CGST"), describeLines(sgst.filter(charged), "SGST")].filter(Boolean).join(", ");
      out.push({
        code: "TAX_TYPE_MISMATCH",
        severity: "block",
        message:
          `CGST/SGST charged (${lines}) but GSTIN ${gstn} is another state's, ` +
          "so the screen and Tally take IGST only. Correct the GSTIN or the tax.",
      });
    }
  } else if (igst.some(charged)) {
    // Registered, Puducherry: the screen and Tally read CGST/SGST only.
    out.push({
      code: "TAX_TYPE_MISMATCH",
      severity: "block",
      message:
        `IGST charged (${describeLines(igst.filter(charged), "IGST")}) but GSTIN ${gstn} is local, ` +
        "so the screen and Tally take CGST/SGST only. Correct the GSTIN or the tax.",
    });
  }

  if (gstn && gstn !== "0" && !GSTIN_PATTERN.test(gstn.toUpperCase())) {
    out.push({
      code: "GSTIN_INVALID",
      severity: "review",
      message: `GSTIN ${gstn} is not a 15-character GSTIN.`,
    });
  }

  const mrc = dayOf(p.mmh_mrc_dt);
  const bill = dayOf(p.mmh_dist_bill_dt);

  // The MRC ref no is the Tally voucher number and restarts every April:
  // a voucher dated in another year than its number's series would land in
  // that year's books, next to that year's bill with the same number.
  const voucherFy = Number(p.voucher_fy);
  if (mrc && Number.isInteger(voucherFy) && voucherFy > 2000 && financialYearOf(mrc) !== voucherFy) {
    const entered = dayOf(p.entered_at);
    out.push({
      code: "MRC_DATE_OUTSIDE_SERIES_FY",
      severity: "block",
      message:
        `MRC date ${mrc} is in FY ${fyLabel(financialYearOf(mrc))}, but MRC ref no ${str(p.mmh_mrc_refno) || "-"} ` +
        `is numbered in the FY ${fyLabel(voucherFy)} series${entered ? ` (entered ${entered})` : ""}. Correct the MRC date.`,
    });
  }

  if (mrc && bill) {
    const mrcFy = financialYearOf(mrc);
    const billFy = financialYearOf(bill);
    if (mrcFy !== billFy) {
      out.push({
        code: "BILL_DATE_OTHER_FY",
        severity: "review",
        message: `Supplier bill date ${bill} is in FY ${fyLabel(billFy)}, the MRC date ${mrc} in FY ${fyLabel(mrcFy)}.`,
      });
    } else if (bill > mrc) {
      out.push({
        code: "BILL_DATE_AFTER_MRC",
        severity: "review",
        message: `Supplier bill date ${bill} is after the MRC date ${mrc}.`,
      });
    }
  }

  return out;
}

const hasBlockingDiscrepancy = (list) => (list || []).some((d) => d.severity === "block");

/** A GoFrugal bill's findings: shown for review, never blocking approval. */
const asLegacy = (list) => (list || []).map((d) => (d.severity === "block" ? { ...d, severity: "review" } : d));

module.exports = {
  purchaseDiscrepancies,
  hasBlockingDiscrepancy,
  asLegacy,
  isInterstateSupplier,
  dayOf,
  financialYearOf,
};
