const { contentTs, isInterstateSupplier, roundOffForRow } = require("./retailpilot_purchase");

/**
 * RetailPilot debit notes -> the uppercase payload POST /debit-note/bulk
 * takes (debit_note columns), so they show on the Debit Note screen and go
 * to Tally the same way GoFrugal's did.
 *
 * In RetailPilot a debit note is a row of public.invoice_reconciliations
 * with reconciliation_type 'DEBIT_NOTE'. PURCHASE_RETURN and
 * PURCHASE_REPLACEMENT rows are the return and replacement workflows behind
 * them; reading those too would count the same claim twice.
 *
 * The query returns one row per debit note per distinct tax-rate
 * combination; mapDebitNotes folds those into one debit note each.
 */

// Column limits of the `debit_note` table.
const LIMITS = {
  MPRH_PR_NO: 20,
  MPRH_PR_REFNO: 20,
  SUPPLIER_ID: 20,
  SUPPLIER_GSTN: 20,
  SUPPLIER_NAME: 100,
};

/** The only status that is a finished debit note; others are reported. */
const SYNCED_STATUS = "SUBMITTED";

/**
 * Debit notes created in the last {days} days.
 *
 * GST rate of a line: the matching line of the supplier invoice the debit
 * note was raised on. A stock return has no invoice, so its lines take the
 * rate (and the GSTIN) of the last purchase of that article from that
 * supplier on or before the debit note.
 *
 * Taxable value of a line:
 *   - short or returned quantity on an invoice line: discrepancy_qty x
 *     (basic_cost less the line's discount spread over its quantity) - the
 *     purchase sync's taxable, per unit. unit_cost is that figure with GST
 *     added, so this only removes unit_cost's 2-decimal rounding.
 *   - a cost variance (line_value is a price difference, not qty x
 *     unit_cost) or a stock return (no invoice line): GST taken out of
 *     line_value, which includes it.
 *
 * rated is false for a line no rate was found for: it is counted at 0% and
 * reported.
 *
 * {days} must be a non-negative integer: SPECTRA parameterises literals, so
 * `CURRENT_DATE - <int>` rather than an INTERVAL (see buildPurchaseQuery).
 */
function buildDebitNoteQuery(days) {
  const n = days;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
    throw new Error("days must be a non-negative integer");
  }
  return `
WITH dn AS (
  SELECT i.id AS item_id, i.article_id AS article_id, i.line_item_index AS lii,
    i.line_value AS line_value, i.discrepancy_qty AS discrepancy_qty,
    r.slug AS recon_slug, r.fy AS fy, r.seq AS seq, r.status AS status,
    r.discrepancy_type AS discrepancy_type, r.store_id AS store_id,
    r.supplier_id AS supplier_id, r.created_at AS created_at,
    doc.invoice_slug AS invoice_slug
  FROM public.invoice_reconciliation_items i
  JOIN public.invoice_reconciliations r ON r.slug = i.reconciliation_slug
  LEFT JOIN public.invoice_documents doc ON doc.slug = r.invoice_document_slug
  WHERE r.reconciliation_type = 'DEBIT_NOTE'
    AND r.created_at >= CURRENT_DATE - ${n}
),
lastrate AS (
  SELECT DISTINCT ON (dn.item_id) dn.item_id,
    d2.cgst_rate, d2.sgst_rate, d2.igst_rate, d2.cess_rate, h2.supplier_gstin
  FROM dn
  JOIN public.invoice_details d2 ON d2.article_id::text = dn.article_id
  JOIN public.invoice_headers h2 ON h2.slug = d2.invoice_slug
  WHERE dn.invoice_slug IS NULL
    AND h2.invoice_type = 'PURCHASE'
    AND h2.supplier_id::text = dn.supplier_id::text
    AND COALESCE(h2.received_date, h2.invoice_date) <= dn.created_at::date
  ORDER BY dn.item_id, COALESCE(h2.received_date, h2.invoice_date) DESC, h2.created_at DESC
),
matched AS (
  SELECT DISTINCT ON (dn.item_id) dn.*,
    d.basic_cost AS basic_cost, COALESCE(d.quantity, d.weight) AS inv_qty,
    COALESCE(d.discount_value,0) AS inv_discount,
    COALESCE(d.cgst_rate,f.cgst_rate,0) AS cgst_rate,
    COALESCE(d.sgst_rate,f.sgst_rate,0) AS sgst_rate,
    COALESCE(d.igst_rate,f.igst_rate,0) AS igst_rate,
    COALESCE(d.cess_rate,f.cess_rate,0) AS cess_rate,
    (d.invoice_slug IS NOT NULL OR f.cgst_rate IS NOT NULL OR f.igst_rate IS NOT NULL) AS rated,
    f.supplier_gstin AS last_purchase_gstin
  FROM dn
  LEFT JOIN public.invoice_details d ON d.invoice_slug = dn.invoice_slug
    AND d.article_id::text = dn.article_id
    AND (dn.lii IS NULL OR d.line_no = dn.lii + 1)
  LEFT JOIN lastrate f ON f.item_id = dn.item_id
  ORDER BY dn.item_id, d.line_no
),
line AS (
  SELECT m.*,
    CASE
      WHEN m.discrepancy_type <> 'COST_QC_VARIANCE' AND m.basic_cost IS NOT NULL AND m.inv_qty > 0
        THEN round((m.discrepancy_qty * GREATEST(m.basic_cost - m.inv_discount / m.inv_qty, 0))::numeric, 2)
      ELSE round((m.line_value / (1 + (m.cgst_rate + m.sgst_rate + m.igst_rate + m.cess_rate)/100.0))::numeric, 2)
    END AS taxable
  FROM matched m
)
SELECT
  l.recon_slug, l.seq, l.fy, l.status, l.discrepancy_type, l.store_id, l.supplier_id,
  COALESCE(NULLIF(TRIM(v.trade_name), ''), v.name) AS supplier_name,
  MAX(COALESCE(h.supplier_gstin, l.last_purchase_gstin)) AS supplier_gstn,
  MAX(h.seq) AS invoice_seq, MAX(h.invoice_id) AS supplier_invoice_id,
  l.created_at,
  l.cgst_rate, l.sgst_rate, l.igst_rate, l.cess_rate,
  SUM(l.taxable)                           AS taxable,
  SUM(l.line_value)                        AS line_value,
  SUM(l.discrepancy_qty)                   AS qty,
  COUNT(*) FILTER (WHERE NOT l.rated)      AS unrated_lines
FROM line l
LEFT JOIN public.invoice_headers h ON h.slug = l.invoice_slug
LEFT JOIN masterhub.vendors v ON v.id = l.supplier_id
GROUP BY l.recon_slug, l.seq, l.fy, l.status, l.discrepancy_type, l.store_id, l.supplier_id,
         v.name, v.trade_name, l.created_at, l.cgst_rate, l.sgst_rate, l.igst_rate, l.cess_rate
ORDER BY l.recon_slug, l.cgst_rate, l.sgst_rate, l.igst_rate, l.cess_rate
`;
}

const round2 = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

const str = (v) => (v == null ? "" : String(v).trim());

/** YYYY-MM-DD from a date or timestamp string, without a timezone shift. */
function dateOnly(v) {
  const m = str(v).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
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

/**
 * @returns {{ debitNotes: object[], skipped: {recon_slug, reason}[] }}
 */
function mapDebitNotes(rows, storeMap) {
  const groups = new Map();
  for (const row of rows || []) {
    const slug = str(row.recon_slug);
    if (!slug) continue;
    if (!groups.has(slug)) groups.set(slug, { header: row, lines: new Map() });
    const key = [row.cgst_rate, row.sgst_rate, row.igst_rate, row.cess_rate]
      .map((r) => Number(r) || 0)
      .join("|");
    // A row repeated across pages (data moving mid-read) is counted once.
    groups.get(slug).lines.set(key, row);
  }

  const debitNotes = [];
  const skipped = [];
  const seen = new Map();

  for (const [slug, { header: h, lines }] of groups) {
    const skip = (reason) => skipped.push({ recon_slug: slug, reason });

    const status = str(h.status);
    if (status !== SYNCED_STATUS) {
      skip(`status ${status || "(blank)"} - only ${SYNCED_STATUS} debit notes are imported`);
      continue;
    }
    const outletId = storeMap[str(h.store_id)];
    if (!outletId) {
      skip(`RetailPilot store ${str(h.store_id) || "(blank)"} is not set as the RetailPilot ID of any branch in Branch Master`);
      continue;
    }
    const prDate = dateOnly(h.created_at);
    if (!prDate) {
      skip("no created date");
      continue;
    }

    // seq is the debit note's number in its store's series for the
    // financial year (Warehouse 2026-27: 1407, 1408, ...). It is the
    // reference, mprh_pr_refno, which the Tally export sends as the voucher
    // number; the reconciliation slug (REC-...) is mprh_pr_no.
    const seq = h.seq == null || h.seq === "" ? NaN : Number(h.seq);
    if (!Number.isInteger(seq) || seq <= 0) {
      skip("no seq (debit note number) in RetailPilot");
      continue;
    }
    const fy = Number(h.fy);
    const key = `${outletId}|${Number.isInteger(fy) ? fy : ""}|${seq}`;
    if (seen.has(key)) {
      skip(`seq ${seq} is used by another debit note (${seen.get(key)}) in the same store`);
      continue;
    }
    seen.set(key, slug);

    // A stock return's GSTIN comes from its lines' last purchases, so it can
    // differ by rate group: the first one found is the debit note's.
    const gstin = [...lines.values()].map((l) => str(l.supplier_gstn)).find(Boolean) || "";
    const fields = {
      MPRH_PR_NO: slug,
      MPRH_PR_REFNO: String(seq),
      SUPPLIER_ID: str(h.supplier_id),
      SUPPLIER_GSTN: gstin,
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
    const interstate = isInterstateSupplier(gstin);
    let qty = 0;
    let value = 0;
    let unrated = 0;

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
      qty += Number(line.qty) || 0;
      value += Number(line.line_value) || 0;
      unrated += Number(line.unrated_lines) || 0;
    }
    [sgst, cgst, igst, cess].forEach((l) => l.sort(byPerc));

    const payload = {
      STORE_ID: outletId,
      MPRH_PR_NO: slug,
      MPRH_PR_REFNO: fields.MPRH_PR_REFNO,
      MPRH_PR_DT: prDate,
      MPRH_DIST_CODE: fields.SUPPLIER_ID,
      SUPPLIER_ID: fields.SUPPLIER_ID,
      SUPPLIER_NAME: str(h.supplier_name).slice(0, LIMITS.SUPPLIER_NAME),
      SUPPLIER_GSTN: gstin,
      TOT_SGST_AMT: sumValues(sgst),
      TOT_CGST_AMT: sumValues(cgst),
      TOT_IGST_AMT: sumValues(igst),
      TOT_GST_CESS_AMT: sumValues(cess),
      TOT_ITEM_QTY: round2(qty),
      TOT_ITEM_VALUE: round2(value),
      SGST: sgst,
      CGST: cgst,
      IGST: igst,
      CESS: cess,
    };
    // Not debit_note columns: shown in a dry run and used for the clash
    // check - the financial year of the seq series, the kind of debit note,
    // the purchase it was raised on, and lines no GST rate was found for.
    payload.FY = Number.isInteger(fy) && fy > 2000 ? fy : null;
    payload.DISCREPANCY_TYPE = str(h.discrepancy_type);
    payload.PURCHASE_REF = h.invoice_seq == null ? "" : str(h.invoice_seq);
    payload.SUPPLIER_INVOICE_ID = str(h.supplier_invoice_id);
    payload.UNRATED_LINES = unrated;
    // For the Debit Note screen's internal fields (debit_note_internal), as
    // the purchase sync pre-fills purchase_internal: the debit note's total
    // rounded to the nearest rupee, the round-off that takes the screen's
    // sum (taxable + GST, util/debit-note.js calculateTotalAmount - the same
    // sum as the Purchase screen's) to it, and the purchase's MRC ref no.
    // roundOffForRow against a bill amount of 0 gives minus that sum.
    const exact = -roundOffForRow({
      supplier_gstn: gstin,
      igst,
      sgst,
      tot_igst_amt: payload.TOT_IGST_AMT,
      tot_sgst_amt: payload.TOT_SGST_AMT,
      tot_cgst_amt: payload.TOT_CGST_AMT,
      mmh_mrc_amt: 0,
    }).round_off;
    payload.TOTAL_AMOUNT = Math.round(exact);
    payload.ROUND_OFF = round2(payload.TOTAL_AMOUNT - exact);
    payload.TS = contentTs(payload);
    debitNotes.push(payload);
  }

  return { debitNotes, skipped };
}

module.exports = { buildDebitNoteQuery, mapDebitNotes, SYNCED_STATUS };
