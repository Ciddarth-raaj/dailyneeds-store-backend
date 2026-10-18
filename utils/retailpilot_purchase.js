const crypto = require("crypto");

/**
 * RetailPilot purchase invoices -> the uppercase payload POST /purchase/bulk
 * takes, so the pulled rows go through the same purchaseRepo.bulkCreate as
 * the old GoFrugal push (insert, update on TS change, approved rows frozen).
 *
 * The query returns one row per invoice per distinct tax-rate combination;
 * mapPurchases folds those into one purchase each.
 */

// Column limits of the `purchase` table.
const LIMITS = {
  MRC_NO: 50,
  MRC_REF: 50,
  SUPPLIER_ID: 50,
  SUPPLIER_GSTN: 20,
  DIST_BILL_NO: 50,
  SUPPLIER_NAME: 100,
};

/**
 * Purchase invoices received, invoiced, created or updated in the last
 * {days} days. The created/updated test catches a back-dated entry or an
 * edit to an older bill, which a window on the bill date alone would miss.
 * FREIGHT and any other invoice_type are left out. The supplier name is the
 * vendor's trade name, falling back to its registered name.
 *
 * {days} must be a non-negative integer. `CURRENT_DATE - <int>`, not
 * `INTERVAL '<n> days'`: SPECTRA parameterises the literal and Postgres
 * rejects `INTERVAL $1`.
 */
function buildPurchaseQuery(days) {
  const n = days;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
    throw new Error("days must be a non-negative integer");
  }
  return `
WITH line AS (
  SELECT
    d.invoice_slug,
    COALESCE(d.cgst_rate,0) AS cgst_rate,
    COALESCE(d.sgst_rate,0) AS sgst_rate,
    COALESCE(d.igst_rate,0) AS igst_rate,
    COALESCE(d.cess_rate,0) AS cess_rate,
    GREATEST(d.basic_cost * COALESCE(d.quantity, d.weight, 0)
             - COALESCE(d.discount_value,0), 0) AS taxable
  FROM public.invoice_details d
)
SELECT
  h.slug                                    AS invoice_slug,
  h.invoice_id                              AS supplier_invoice_id,
  h.seq                                     AS mrc_no,
  h.store_id,
  h.supplier_id,
  COALESCE(NULLIF(TRIM(v.trade_name), ''), v.name) AS supplier_name,
  h.supplier_gstin                          AS supplier_gstn,
  COALESCE(h.received_date, h.invoice_date) AS received_date,
  h.invoice_date,
  h.total_net                               AS invoice_amount,
  COALESCE(h.total_tcs,0)                   AS tcs,
  l.cgst_rate, l.sgst_rate, l.igst_rate, l.cess_rate,
  SUM(l.taxable)                            AS taxable
FROM public.invoice_headers h
JOIN line l                   ON l.invoice_slug = h.slug
LEFT JOIN masterhub.vendors v ON v.id = h.supplier_id
WHERE h.invoice_type = 'PURCHASE'
  AND (COALESCE(h.received_date, h.invoice_date) >= CURRENT_DATE - ${n}
       OR COALESCE(h.updated_at, h.created_at) >= CURRENT_DATE - ${n})
GROUP BY h.slug, h.invoice_id, h.seq, h.store_id, h.supplier_id, v.name, v.trade_name,
         h.supplier_gstin, h.received_date, h.invoice_date, h.total_net,
         h.total_tcs, l.cgst_rate, l.sgst_rate, l.igst_rate, l.cess_rate
ORDER BY h.slug, l.cgst_rate, l.sgst_rate, l.igst_rate, l.cess_rate
`;
}

const round2 = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

const str = (v) => (v == null ? "" : String(v).trim());

/** YYYY-MM-DD from a date or timestamp string, without a timezone shift. */
function dateOnly(v) {
  const s = str(v);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

/**
 * Same rule as usecase/tally.js shouldShowIGST: a Puducherry (34) or missing
 * GSTIN is local. Only used for 0% lines, which carry no rate to tell.
 */
function isInterstateSupplier(gstn) {
  const g = str(gstn);
  return !(g === "" || g === "0" || g.startsWith("34"));
}

function addTax(list, perc, taxable, value) {
  const existing = list.find((e) => e.PERC === perc);
  if (existing) {
    existing.TAXABLE = round2(existing.TAXABLE + taxable);
    existing.VALUE = round2(existing.VALUE + value);
  } else {
    list.push({ PERC: perc, TAXABLE: round2(taxable), VALUE: round2(value) });
  }
}

const byPerc = (a, b) => a.PERC - b.PERC;
const sumValues = (list) => round2(list.reduce((s, e) => s + e.VALUE, 0));

/** Numeric content hash, so TS changes exactly when the purchase does. */
function contentTs(payload) {
  const hex = crypto.createHash("sha1").update(JSON.stringify(payload)).digest("hex");
  return parseInt(hex.slice(0, 12), 16);
}

/**
 * @returns {{ purchases: object[], skipped: {invoice_slug, reason}[] }}
 */
function mapPurchases(rows, storeMap) {
  const groups = new Map();
  for (const row of rows || []) {
    const slug = str(row.invoice_slug);
    if (!slug) continue;
    if (!groups.has(slug)) groups.set(slug, { header: row, lines: new Map() });
    const key = [row.cgst_rate, row.sgst_rate, row.igst_rate, row.cess_rate]
      .map((r) => Number(r) || 0)
      .join("|");
    // A row repeated across pages (data moving mid-read) is counted once.
    groups.get(slug).lines.set(key, row);
  }

  const purchases = [];
  const skipped = [];
  const seen = new Map();

  for (const [slug, { header: h, lines }] of groups) {
    const skip = (reason) => skipped.push({ invoice_slug: slug, reason });

    const outletId = storeMap[str(h.store_id)];
    if (!outletId) {
      skip(`RetailPilot store ${str(h.store_id) || "(blank)"} is not set as the RetailPilot ID of any branch in Branch Master`);
      continue;
    }
    const mrcDate = dateOnly(h.received_date);
    const billDate = dateOnly(h.invoice_date) || mrcDate;
    if (!mrcDate) {
      skip("no received/invoice date");
      continue;
    }

    // seq is RetailPilot's running number per store, invoice type and
    // financial year (Warehouse 2026-27: 6372, 6373, ... - continuing
    // GoFrugal's refno). It is the reference, mmh_mrc_refno, which the Tally
    // export sends as the voucher number and Tally's responses are matched
    // back on. The invoice slug is the MRC no, mmh_mrc_no.
    const seq = h.mrc_no == null || h.mrc_no === "" ? NaN : Number(h.mrc_no);
    if (!Number.isInteger(seq) || seq <= 0) {
      skip("no seq (MRC number) in RetailPilot");
      continue;
    }
    const key = `${outletId}|${seq}`;
    if (seen.has(key)) {
      skip(`seq ${seq} is used by another invoice (${seen.get(key)}) in the same store`);
      continue;
    }
    seen.set(key, slug);

    const fields = {
      MRC_NO: slug,
      MRC_REF: String(seq),
      SUPPLIER_ID: str(h.supplier_id),
      SUPPLIER_GSTN: str(h.supplier_gstn),
      DIST_BILL_NO: str(h.supplier_invoice_id),
    };
    const tooLong = Object.entries(fields).find(([k, v]) => v.length > LIMITS[k]);
    if (tooLong) {
      skip(`${tooLong[0]} "${tooLong[1]}" is longer than ${LIMITS[tooLong[0]]} characters`);
      continue;
    }

    const sgst = [];
    const cgst = [];
    const igst = [];
    const cess = [];
    const interstate = isInterstateSupplier(h.supplier_gstn);

    for (const line of lines.values()) {
      const taxable = Number(line.taxable) || 0;
      const cgstRate = Number(line.cgst_rate) || 0;
      const sgstRate = Number(line.sgst_rate) || 0;
      const igstRate = Number(line.igst_rate) || 0;
      const cessRate = Number(line.cess_rate) || 0;

      if (igstRate > 0) {
        addTax(igst, igstRate, taxable, (taxable * igstRate) / 100);
      } else if (cgstRate > 0 || sgstRate > 0) {
        addTax(cgst, cgstRate, taxable, (taxable * cgstRate) / 100);
        addTax(sgst, sgstRate, taxable, (taxable * sgstRate) / 100);
      } else if (interstate) {
        addTax(igst, 0, taxable, 0);
      } else {
        addTax(cgst, 0, taxable, 0);
        addTax(sgst, 0, taxable, 0);
      }
      if (cessRate > 0) addTax(cess, cessRate, taxable, (taxable * cessRate) / 100);
    }
    [sgst, cgst, igst, cess].forEach((l) => l.sort(byPerc));

    const payload = {
      STORE_ID: outletId,
      SUPPLIER_ID: fields.SUPPLIER_ID,
      SUPPLIER_NAME: str(h.supplier_name).slice(0, LIMITS.SUPPLIER_NAME),
      SUPPLIER_GSTN: fields.SUPPLIER_GSTN,
      MRC_NO: slug,
      MRC_DATE: mrcDate,
      MRC_AMT: round2(h.invoice_amount),
      DIST_BILL_DT: billDate,
      DIST_BILL_NO: fields.DIST_BILL_NO,
      MRC_REF: fields.MRC_REF,
      MANUAL_DISC: 0,
      TOT_SGST_AMT: sumValues(sgst),
      TOT_CGST_AMT: sumValues(cgst),
      TOT_IGST_AMT: sumValues(igst),
      TOT_GST_CESS_AMT: sumValues(cess),
      GOODS_TCS_AMT: round2(h.tcs),
      SGST: sgst,
      CGST: cgst,
      IGST: igst,
      CESS: cess,
    };
    payload.TS = contentTs(payload);
    purchases.push(payload);
  }

  return { purchases, skipped };
}

module.exports = {
  buildPurchaseQuery,
  mapPurchases,
  isInterstateSupplier,
  contentTs,
};
