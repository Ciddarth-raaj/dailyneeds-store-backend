/**
 * RetailPilot purchase invoices -> the GRN rows the GRN pages already read
 * from GoFrugal (MMH_* header / MMD_* line fields), so the same row mappers,
 * offers, verification and mismatch logic work on both.
 *
 * Only the warehouse's purchases are GRNs (the store passed in). GRN No is
 * RetailPilot's seq, which continues GoFrugal's numbering; a line's MMD_MRC_SL_NO
 * is RetailPilot's invoice_details slug, its stable id (GRN ignores key on it).
 * Dates are the day the invoice was entered, in India time: invoice_date is
 * typed in by hand and is sometimes wrong (year 0266).
 *
 * SPECTRA runs plain SQL text, so every value built into a query is checked
 * against a strict pattern first. No subqueries, no TO_CHAR.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const STORE_RE = /^[A-Za-z0-9_-]{1,20}$/;
const SLUG_RE = /^[A-Za-z0-9_-]{1,64}$/;

const LOCAL_DAY = "((h.created_at AT TIME ZONE 'Asia/Kolkata')::date)";

function assertStore(store) {
  if (!STORE_RE.test(String(store || ""))) throw new Error("Invalid RetailPilot GRN store id");
  return store;
}
function assertDate(d) {
  if (d == null) return null;
  if (!DATE_RE.test(String(d))) throw new Error("Invalid date");
  return d;
}

const PURCHASES = (store) => `h.invoice_type = 'PURCHASE' AND h.store_id = '${assertStore(store)}'`;

const HEADER_SELECT = `
  h.slug AS mmh_mrc_no,
  CAST(h.seq AS TEXT) AS mmh_mrc_refno,
  CAST(${LOCAL_DAY} AS TEXT) AS mmh_mrc_dt,
  h.supplier_id AS mmh_dist_code,
  h.total_net AS mmh_mrc_amt,
  COALESCE(NULLIF(TRIM(v.trade_name), ''), v.name) AS supplier_name`;

const HEADER_GROUP = `h.slug, h.seq, h.created_at, h.supplier_id, h.total_net, v.trade_name, v.name`;

/** GRN headers entered in [from, to] (either may be null). */
function buildHeadersQuery(store, from, to) {
  const conds = [PURCHASES(store)];
  if (assertDate(from)) conds.push(`${LOCAL_DAY} >= DATE '${from}'`);
  if (assertDate(to)) conds.push(`${LOCAL_DAY} <= DATE '${to}'`);
  return `
SELECT ${HEADER_SELECT}, COUNT(d.slug) AS product_count
FROM public.invoice_headers h
LEFT JOIN public.invoice_details d ON d.invoice_slug = h.slug
LEFT JOIN masterhub.vendors v ON v.id = h.supplier_id
WHERE ${conds.join(" AND ")}
GROUP BY ${HEADER_GROUP}
ORDER BY h.created_at DESC, h.slug DESC`;
}

/** GRN headers whose GRN No starts with `digits` (GRN numbers are numeric). */
function buildSearchQuery(store, digits) {
  if (!/^\d{1,18}$/.test(String(digits || ""))) return null;
  return `
SELECT ${HEADER_SELECT}, COUNT(d.slug) AS product_count
FROM public.invoice_headers h
LEFT JOIN public.invoice_details d ON d.invoice_slug = h.slug
LEFT JOIN masterhub.vendors v ON v.id = h.supplier_id
WHERE ${PURCHASES(store)} AND CAST(h.seq AS TEXT) LIKE '${digits}%'
GROUP BY ${HEADER_GROUP}
ORDER BY h.created_at DESC, h.slug DESC`;
}

/** One GRN header by GRN No; the newest financial year wins. */
function buildHeaderByRefnoQuery(store, refno) {
  if (!/^\d{1,18}$/.test(String(refno || ""))) return null;
  return `
SELECT ${HEADER_SELECT}, h.created_at AS entered_at
FROM public.invoice_headers h
LEFT JOIN masterhub.vendors v ON v.id = h.supplier_id
WHERE ${PURCHASES(store)} AND h.seq = ${Number(refno)}
ORDER BY h.fy DESC, h.created_at DESC`;
}

const LINE_SELECT = (store) => `
  d.slug AS MMD_MRC_SL_NO,
  d.article_id AS MMD_ITEM_CODE,
  d.quantity AS MMD_RECD_QTY,
  d.free_quantity AS MMD_FREE_QTY,
  d.mrp AS MMD_MAX_RATE,
  d.basic_cost AS MMD_PUR_RATE,
  (COALESCE(d.cgst_rate, 0) + COALESCE(d.sgst_rate, 0) + COALESCE(d.igst_rate, 0)) AS MMD_PUR_TAX_PER,
  d.tax_amount AS MMD_PUR_TAX_AMT,
  d.landing_cost AS MMD_PUR_PRICE,
  COALESCE(sw.selling_price, si.selling_price, sp.selling_price) AS MMD_SALE_RATE,
  d.landing_cost * COALESCE(d.quantity, d.weight, 0) AS MMD_PUR_AMOUNT,
  d.discount_percent AS MMD_DISC_PER,
  d.discount_value AS MMD_DISC_AMT,
  h.created_at AS entered_at`;

// A line's selling price: its batch's in-store retail price for the store,
// else for every store, else the batch's default price.
const LINE_JOINS = (store) => `
LEFT JOIN public.inventory_batches b ON b.invoice_detail_slug = d.slug
LEFT JOIN public.batch_selling_price sp ON sp.batch_id = b.batch_id
     AND sp.channel_type IS NULL AND sp.customer_type IS NULL AND sp.store_id IS NULL
LEFT JOIN public.batch_selling_price si ON si.batch_id = b.batch_id
     AND si.channel_type = 'instore' AND si.customer_type = 'retail' AND si.store_id IS NULL
LEFT JOIN public.batch_selling_price sw ON sw.batch_id = b.batch_id
     AND sw.channel_type = 'instore' AND sw.customer_type = 'retail' AND sw.store_id = '${assertStore(store)}'`;

/** The lines of one GRN (by RetailPilot invoice slug). */
function buildLinesQuery(store, invoiceSlug) {
  if (!SLUG_RE.test(String(invoiceSlug || ""))) throw new Error("Invalid invoice id");
  return `
SELECT ${LINE_SELECT(store)}
FROM public.invoice_details d
JOIN public.invoice_headers h ON h.slug = d.invoice_slug
${LINE_JOINS(store)}
WHERE d.invoice_slug = '${invoiceSlug}'
ORDER BY d.slug`;
}

/** Every GRN line entered in [from, to], with its header fields. */
function buildLinesByRangeQuery(store, from, to) {
  const conds = [PURCHASES(store)];
  if (assertDate(from)) conds.push(`${LOCAL_DAY} >= DATE '${from}'`);
  if (assertDate(to)) conds.push(`${LOCAL_DAY} <= DATE '${to}'`);
  return `
SELECT CAST(h.seq AS TEXT) AS mmh_mrc_refno,
       CAST(${LOCAL_DAY} AS TEXT) AS mmh_mrc_dt,
       COALESCE(NULLIF(TRIM(v.trade_name), ''), v.name) AS supplier_name,
       ${LINE_SELECT(store)}
FROM public.invoice_details d
JOIN public.invoice_headers h ON h.slug = d.invoice_slug
LEFT JOIN masterhub.vendors v ON v.id = h.supplier_id
${LINE_JOINS(store)}
WHERE ${conds.join(" AND ")}
ORDER BY h.created_at DESC, h.slug DESC, d.slug`;
}

/**
 * Earlier purchase lines of these articles at the store, newest first, for
 * the GRN detail's previous purchase rate / net cost / selling price.
 */
function buildPreviousLinesQuery(store, articleIds, beforeIso) {
  const ids = [...new Set((articleIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) return null;
  if (!/^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})$/.test(String(beforeIso || ""))) return null;
  return `
SELECT d.article_id, d.basic_cost, d.landing_cost,
       COALESCE(sw.selling_price, si.selling_price, sp.selling_price) AS selling_price,
       h.created_at
FROM public.invoice_details d
JOIN public.invoice_headers h ON h.slug = d.invoice_slug
${LINE_JOINS(store)}
WHERE ${PURCHASES(store)} AND d.article_id IN (${ids.join(",")}) AND h.created_at < '${beforeIso}'
ORDER BY d.article_id, h.created_at DESC`;
}

/** Map<article id, { MMD_PPUR_RATE, MMD_PREV_PUR_PRICE, MMD_PMRP }> - newest earlier line each. */
function previousByArticle(rows) {
  const out = new Map();
  for (const r of rows || []) {
    const id = Number(r.article_id);
    if (out.has(id)) continue;
    out.set(id, {
      MMD_PPUR_RATE: r.basic_cost,
      MMD_PREV_PUR_PRICE: r.landing_cost,
      // Shown as "Prev. Sell.Rate" on the GRN view.
      MMD_PMRP: r.selling_price,
    });
  }
  return out;
}

// ---------------------------------------------------------------------
// The 15-minute GRN copy (usecase/retailpilot_grn_sync.js)
// ---------------------------------------------------------------------

/** GRNs entered or changed in the last `days` days; every GRN when days is null. */
function syncWindow(days) {
  if (days == null) return "";
  if (!Number.isInteger(days) || days < 0 || days > 3650) throw new Error("Invalid sync window");
  return ` AND COALESCE(h.updated_at, h.created_at) >= CURRENT_DATE - ${days}`;
}

function buildSyncHeadersQuery(store, days) {
  return `
SELECT h.slug AS invoice_slug, CAST(h.seq AS TEXT) AS refno, h.fy, h.store_id,
       CAST(${LOCAL_DAY} AS TEXT) AS grn_date, h.created_at AS entered_at,
       h.supplier_id, COALESCE(NULLIF(TRIM(v.trade_name), ''), v.name) AS supplier_name,
       h.total_net AS amount
FROM public.invoice_headers h
LEFT JOIN masterhub.vendors v ON v.id = h.supplier_id
WHERE ${PURCHASES(store)}${syncWindow(days)}
ORDER BY h.slug`;
}

function buildSyncLinesQuery(store, days) {
  return `
SELECT d.invoice_slug, ${LINE_SELECT(store)}
FROM public.invoice_details d
JOIN public.invoice_headers h ON h.slug = d.invoice_slug
${LINE_JOINS(store)}
WHERE ${PURCHASES(store)}${syncWindow(days)}
ORDER BY d.invoice_slug, d.slug`;
}

const toNum = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const pick = (r, k) => (r[k] !== undefined ? r[k] : r[k.toLowerCase()]);

/** RetailPilot header row -> retailpilot_grn_headers row. */
function headerRow(r) {
  return {
    invoice_slug: r.invoice_slug,
    refno: String(r.refno),
    fy: toNum(r.fy),
    store_id: r.store_id,
    grn_date: String(r.grn_date).slice(0, 10),
    entered_at: localDateTime(r.entered_at),
    supplier_id: r.supplier_id != null ? String(r.supplier_id) : null,
    supplier_name: r.supplier_name ? String(r.supplier_name).slice(0, 255) : null,
    amount: toNum(r.amount),
  };
}

/** RetailPilot line rows -> retailpilot_grn_lines rows, numbered within each GRN. */
function lineRows(rows) {
  const seen = new Map();
  return (rows || []).map((r) => {
    const n = (seen.get(r.invoice_slug) || 0) + 1;
    seen.set(r.invoice_slug, n);
    return {
      line_id: pick(r, "MMD_MRC_SL_NO"),
      invoice_slug: r.invoice_slug,
      line_no: n,
      product_id: toNum(pick(r, "MMD_ITEM_CODE")),
      recd_qty: toNum(pick(r, "MMD_RECD_QTY")),
      free_qty: toNum(pick(r, "MMD_FREE_QTY")),
      mrp: toNum(pick(r, "MMD_MAX_RATE")),
      pur_rate: toNum(pick(r, "MMD_PUR_RATE")),
      tax_per: toNum(pick(r, "MMD_PUR_TAX_PER")),
      tax_amt: toNum(pick(r, "MMD_PUR_TAX_AMT")),
      pur_price: toNum(pick(r, "MMD_PUR_PRICE")),
      sale_rate: toNum(pick(r, "MMD_SALE_RATE")),
      pur_amount: toNum(pick(r, "MMD_PUR_AMOUNT")),
      disc_per: toNum(pick(r, "MMD_DISC_PER")),
      disc_amt: toNum(pick(r, "MMD_DISC_AMT")),
    };
  });
}

/** RetailPilot timestamptz (India time) -> 'YYYY-MM-DD HH:MM:SS' wall-clock, IST. */
function localDateTime(v) {
  const d = v instanceof Date ? v : new Date(String(v));
  if (Number.isNaN(d.getTime())) return null;
  const ist = new Date(d.getTime() + 330 * 60000);
  return ist.toISOString().slice(0, 19).replace("T", " ");
}

/** RetailPilot timestamptz -> ISO string usable in a later query. */
function isoOf(v) {
  if (v instanceof Date) return v.toISOString();
  const s = String(v || "");
  return s.replace(" ", "T");
}

module.exports = {
  buildHeadersQuery,
  buildSearchQuery,
  buildHeaderByRefnoQuery,
  buildLinesQuery,
  buildLinesByRangeQuery,
  buildPreviousLinesQuery,
  previousByArticle,
  isoOf,
  buildSyncHeadersQuery,
  buildSyncLinesQuery,
  headerRow,
  lineRows,
  localDateTime,
};
