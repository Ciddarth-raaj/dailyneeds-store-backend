/**
 * Sales Reconciliation: one day's POS figures per store, from RetailPilot
 * (SPECTRA, product Mandapam), in the shape of the Retail Pilot sales CSV the
 * screen already reads - date, outletname, total_bill_amount,
 * total_sales_return, loyalty - so pulling and uploading go through the same
 * parser, outlet matching and save.
 *
 *   total_bill_amount   bills (sign 1), total_payable_with_services
 *   total_sales_return  returns (sign -1), total_payable_with_services
 *   loyalty             loyalty payments, net of returns (amount * sign)
 *   tables              relational.bills, relational.bill_payments (SPECTRA
 *                       schema "relational"), masterhub.stores for the outlet
 *   outletname          masterhub.stores.name (peti.stores is not on SPECTRA's
 *                       allowed list)
 */

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar day as YYYY-MM-DD, or null. */
function validDay(value) {
  const text = String(value == null ? "" : value).trim();
  const m = DATE_PATTERN.exec(text);
  if (!m) return null;
  const [y, mo, d] = m.slice(1).map(Number);
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return text;
}

/**
 * The query, for one day. SPECTRA takes SQL text, so the date is inlined -
 * only after validDay has reduced it to exactly YYYY-MM-DD.
 */
function buildSalesQuery(day) {
  const d = validDay(day);
  if (!d) throw new Error("date must be a real day as YYYY-MM-DD");
  return `
WITH s AS (
  SELECT b.bill_date, b.store_slug,
    COALESCE(SUM(b.total_payable_with_services) FILTER (WHERE b.sign = 1), 0)  AS total_bill_amount,
    COALESCE(SUM(b.total_payable_with_services) FILTER (WHERE b.sign = -1), 0) AS total_sales_return
  FROM relational.bills b
  WHERE b.bill_date = DATE '${d}'
  GROUP BY b.bill_date, b.store_slug
),
l AS (
  SELECT b.bill_date, b.store_slug, SUM(bp.amount * b.sign) AS loyalty
  FROM relational.bill_payments bp
  JOIN relational.bills b ON b.bill_no = bp.bill_no
  WHERE bp.payment_type = 'loyalty'
    AND b.bill_date = DATE '${d}'
  GROUP BY b.bill_date, b.store_slug
)
SELECT s.bill_date AS date, st.name AS outletname, s.store_slug,
  s.total_bill_amount, s.total_sales_return, COALESCE(l.loyalty, 0) AS loyalty
FROM s
LEFT JOIN l ON l.bill_date = s.bill_date AND l.store_slug = s.store_slug
LEFT JOIN masterhub.stores st ON st.slug = s.store_slug
ORDER BY s.bill_date, st.name`;
}

const round2 = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

/**
 * SPECTRA rows -> the CSV's rows. A DATE can come back as a timestamp
 * string; only its day is kept. A store without a name keeps its slug, so
 * it shows as "not matched" on the screen instead of disappearing.
 */
function mapSalesRows(rows, day) {
  return (rows || []).map((r) => {
    const raw = String(r.date == null ? "" : r.date);
    const m = raw.match(/^(\d{4}-\d{2}-\d{2})/);
    const name = String(r.outletname == null ? "" : r.outletname).trim();
    return {
      date: m ? m[1] : day,
      outletname: name || String(r.store_slug || ""),
      store_slug: r.store_slug == null ? null : String(r.store_slug),
      total_bill_amount: round2(r.total_bill_amount),
      total_sales_return: round2(r.total_sales_return),
      loyalty: round2(r.loyalty),
    };
  });
}

module.exports = { validDay, buildSalesQuery, mapSalesRows };
