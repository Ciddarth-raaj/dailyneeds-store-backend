/**
 * Business Dashboard - Purchase returns, live from RetailPilot runway
 * (public.invoice_reconciliations). Nothing is stored here.
 *
 *   PURCHASE_RETURN       a return claim. Status GOODS_SUBMITTED = the goods
 *                         are back with the supplier but the supplier has not
 *                         settled yet: an "open return", however old.
 *   DEBIT_NOTE,           how a return is settled: a child row whose
 *   PURCHASE_REPLACEMENT  parent_reconciliation_slug is the return.
 *
 * Amount of every row is difference_amount (the claimed value).
 *
 * One row per reconciliation, folded in JS: SPECTRA turns literals into
 * parameters, so a GROUP BY on the India-time day would not match its SELECT
 * (see buildPurchaseRangeQuery). The only values built into a query are days
 * already reduced to YYYY-MM-DD by validRange.
 */
const { validRange } = require("./business_dashboard");

const SETTLED_KINDS = { DEBIT_NOTE: "debit_note", PURCHASE_REPLACEMENT: "replacement" };
const OPEN_STATUS = "GOODS_SUBMITTED";

const IST_DAY = (col) => `((${col} AT TIME ZONE 'Asia/Kolkata')::date)`;

/** Debit notes and replacements raised against a return in [from, to] (India days). */
function buildSettledQuery(fromDay, toDay) {
  const r = validRange(fromDay, toDay);
  if (r.error) throw new Error(r.error);
  return `
SELECT c.slug, c.reconciliation_type AS kind, c.difference_amount AS amount,
  c.store_id, st.name AS store_name, c.supplier_id, c.created_at,
  COALESCE(NULLIF(TRIM(v.trade_name), ''), v.name) AS supplier_name
FROM public.invoice_reconciliations c
JOIN public.invoice_reconciliations p ON p.slug = c.parent_reconciliation_slug
LEFT JOIN masterhub.vendors v ON v.id = c.supplier_id
LEFT JOIN masterhub.stores st ON st.slug = c.store_id
WHERE p.reconciliation_type = 'PURCHASE_RETURN'
  AND c.reconciliation_type IN ('DEBIT_NOTE', 'PURCHASE_REPLACEMENT')
  AND ${IST_DAY("c.created_at")} >= DATE '${r.from}'
  AND ${IST_DAY("c.created_at")} <= DATE '${r.to}'
ORDER BY c.slug`;
}

/** Every return whose goods are with the supplier and not yet settled. */
function buildOpenQuery() {
  return `
SELECT r.slug, r.difference_amount AS amount, r.store_id, st.name AS store_name,
  r.supplier_id, r.created_at,
  COALESCE(NULLIF(TRIM(v.trade_name), ''), v.name) AS supplier_name
FROM public.invoice_reconciliations r
LEFT JOIN masterhub.vendors v ON v.id = r.supplier_id
LEFT JOIN masterhub.stores st ON st.slug = r.store_id
WHERE r.reconciliation_type = 'PURCHASE_RETURN' AND r.status = '${OPEN_STATUS}'
ORDER BY r.created_at`;
}

const round2 = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};
const clean = (v) => (v == null ? "" : String(v).trim());
const supplierOf = (r) => clean(r.supplier_name) || (clean(r.supplier_id) ? `Supplier ${clean(r.supplier_id)}` : "Unknown supplier");

/** YYYY-MM-DD of an instant in India time. */
function istDay(value) {
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return null;
  return new Date(t + 330 * 60000).toISOString().slice(0, 10);
}
const dayNumber = (day) => Date.parse(`${day}T00:00:00Z`) / 86400000;

/** Settled rows -> [{ slug, kind: debit_note|replacement, amount, store, supplier_id, supplier_name, day }]. */
function mapSettledRows(rows, resolve) {
  return (rows || [])
    .map((r) => ({
      slug: clean(r.slug),
      kind: SETTLED_KINDS[clean(r.kind).toUpperCase()] || null,
      amount: Math.abs(round2(r.amount)),
      store: resolve(r.store_id, r.store_name).key,
      supplier_id: clean(r.supplier_id),
      supplier_name: supplierOf(r),
      day: istDay(r.created_at),
    }))
    .filter((r) => r.kind);
}

/** Open rows -> [{ slug, amount, store, supplier_id, supplier_name, raised_on, age_days }]. */
function mapOpenRows(rows, resolve, nowMs) {
  const today = istDay(new Date(nowMs).toISOString());
  return (rows || []).map((r) => {
    const day = istDay(r.created_at);
    return {
      slug: clean(r.slug),
      amount: Math.abs(round2(r.amount)),
      store: resolve(r.store_id, r.store_name).key,
      supplier_id: clean(r.supplier_id),
      supplier_name: supplierOf(r),
      raised_on: day,
      age_days: day && today ? Math.max(0, dayNumber(today) - dayNumber(day)) : null,
    };
  });
}

module.exports = {
  OPEN_STATUS,
  buildSettledQuery,
  buildOpenQuery,
  istDay,
  mapSettledRows,
  mapOpenRows,
};
