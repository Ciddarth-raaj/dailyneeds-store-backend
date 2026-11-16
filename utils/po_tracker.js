/**
 * PO Tracker - for buyers to follow their purchase orders, live from
 * RetailPilot runway (SPECTRA).
 *
 *   public.po_headers   one row per PO. Only the latest PO day per store and
 *                       supplier is shown (older ones on that pair are only
 *                       counted, as older_pos_ignored); CANCELLED and
 *                       future-dated POs are left out.
 *   public.po_details   one row per PO line: ordered, received and pending
 *                       quantity at net cost.
 *   masterhub.stores / masterhub.vendors  store and supplier names.
 *
 * Fill % (quantity and value) is only worked out for PARTIALLY_FULFILLED
 * POs, received capped at ordered per line so over-supply on one line does
 * not hide a short one. Expired = past validity while still APPROVED or
 * PARTIALLY_FULFILLED.
 */

const PO_TRACKER_QUERY = `
WITH ranked AS (
  SELECT h.*,
         DENSE_RANK() OVER (PARTITION BY h.store_id, h.supplier_id ORDER BY h.po_date DESC) AS rk,
         COUNT(*)     OVER (PARTITION BY h.store_id, h.supplier_id)                         AS total_pos
  FROM public.po_headers h
  WHERE h.po_date <= CURRENT_DATE
    AND h.status <> 'CANCELLED'
),
latest AS (
  SELECT r.*,
         COUNT(*) OVER (PARTITION BY r.store_id, r.supplier_id) AS latest_day_pos
  FROM ranked r
  WHERE r.rk = 1
),
lines AS (
  SELECT d.po_slug,
         COUNT(*)                                                     AS lines,
         COUNT(*) FILTER (WHERE d.pending_quantity > 0)               AS open_lines,
         SUM(d.ordered_quantity)                                      AS ordered_qty,
         SUM(d.received_quantity)                                     AS received_qty,
         SUM(LEAST(d.received_quantity, d.ordered_quantity))          AS received_capped,
         SUM(d.ordered_quantity * d.net_cost)                         AS ordered_value,
         SUM(LEAST(d.received_quantity, d.ordered_quantity) * d.net_cost) AS received_value_capped,
         SUM(d.pending_quantity)                                      AS pending_qty,
         SUM(d.pending_quantity * d.net_cost)                         AS pending_value
  FROM public.po_details d
  GROUP BY d.po_slug
)
SELECT
  h.po_ref,
  h.slug                                                   AS po_slug,
  h.store_id,
  s.name                                                   AS store,
  h.supplier_id,
  v.trade_name,
  REGEXP_REPLACE(h.created_by, '\\s*\\([^)]*\\)\\s*$', '')   AS raised_by,
  h.status,
  h.fulfillment_status,
  h.po_date,
  h.expected_delivery_date,
  h.validity_date,
  CASE WHEN h.validity_date < CURRENT_DATE
        AND h.status IN ('APPROVED','PARTIALLY_FULFILLED')
       THEN 'Yes' ELSE 'No' END                            AS expired,
  CASE WHEN h.validity_date < CURRENT_DATE
       THEN CURRENT_DATE - h.validity_date END             AS days_past_validity,
  h.total_pos - h.latest_day_pos                           AS older_pos_ignored,
  h.net_amount,
  l.lines,
  l.open_lines,
  l.pending_qty,
  ROUND(l.pending_value::numeric, 2)                       AS pending_value,
  CASE WHEN h.status = 'PARTIALLY_FULFILLED' THEN l.ordered_qty  END AS ordered_qty,
  CASE WHEN h.status = 'PARTIALLY_FULFILLED' THEN l.received_qty END AS received_qty,
  CASE WHEN h.status = 'PARTIALLY_FULFILLED'
       THEN ROUND((100.0 * l.received_capped / NULLIF(l.ordered_qty, 0))::numeric, 1) END        AS qty_fill_pct,
  CASE WHEN h.status = 'PARTIALLY_FULFILLED'
       THEN ROUND((100.0 * l.received_value_capped / NULLIF(l.ordered_value, 0))::numeric, 1) END AS value_fill_pct
FROM latest h
LEFT JOIN masterhub.stores  s ON s.slug = h.store_id
LEFT JOIN masterhub.vendors v ON v.id   = h.supplier_id
LEFT JOIN lines             l ON l.po_slug = h.slug
ORDER BY v.trade_name, h.po_date, h.slug
`;

const clean = (v) => (v == null ? "" : String(v).trim());
const num = (v) => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
/** YYYY-MM-DD from a date or timestamp, without a timezone shift. */
const day = (v) => {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(clean(v));
  return m ? m[1] : null;
};

/** SPECTRA rows -> one object per PO (a row repeated across pages is kept once). */
function mapPurchaseOrders(rows) {
  const out = new Map();
  for (const r of rows || []) {
    const slug = clean(r.po_slug);
    if (!slug || out.has(slug)) continue;
    out.set(slug, {
      po_slug: slug,
      po_ref: clean(r.po_ref) || slug,
      store_id: clean(r.store_id),
      store: clean(r.store) || clean(r.store_id) || "Unknown store",
      supplier_id: clean(r.supplier_id),
      supplier: clean(r.trade_name) || clean(r.supplier_id) || "Unknown supplier",
      raised_by: clean(r.raised_by),
      status: clean(r.status),
      fulfillment_status: clean(r.fulfillment_status),
      po_date: day(r.po_date),
      expected_delivery_date: day(r.expected_delivery_date),
      validity_date: day(r.validity_date),
      expired: clean(r.expired).toLowerCase() === "yes",
      days_past_validity: num(r.days_past_validity),
      older_pos_ignored: num(r.older_pos_ignored) || 0,
      net_amount: num(r.net_amount),
      lines: num(r.lines) || 0,
      open_lines: num(r.open_lines) || 0,
      pending_qty: num(r.pending_qty),
      pending_value: num(r.pending_value),
      ordered_qty: num(r.ordered_qty),
      received_qty: num(r.received_qty),
      qty_fill_pct: num(r.qty_fill_pct),
      value_fill_pct: num(r.value_fill_pct),
    });
  }
  return [...out.values()];
}

/* ------------------------------------------------------------------ */
/* Follow-ups                                                          */
/* ------------------------------------------------------------------ */

const CHANNELS = ["CALL", "WHATSAPP", "EMAIL", "VISIT"];
/** Days after the PO date before it needs chasing, and between chases. */
const FOLLOW_UP_AFTER_DAYS = 2;
const SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_\/-]{0,99}$/;

const validSlug = (value) => {
  const s = clean(value);
  return SLUG_PATTERN.test(s) ? s : null;
};

const addDays = (isoDay, n) => {
  const d = new Date(`${isoDay}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/**
 * Does this PO need chasing today? Only approved POs with nothing received
 * (Awaiting delivery and Expired), at least FOLLOW_UP_AFTER_DAYS past the
 * PO date, and either never followed up, due by the next follow-up date set
 * on the last remark, or - with no such date - last chased that many days
 * ago or more.
 *
 * @param po      a mapped PO (mapPurchaseOrders)
 * @param last    its latest follow-up, or null; last.created_day is the IST day it was written
 * @param today   IST day, YYYY-MM-DD
 */
function needsFollowUp(po, last, today) {
  if (!po || po.status !== "APPROVED" || !po.po_date) return false;
  if (po.po_date > addDays(today, -FOLLOW_UP_AFTER_DAYS)) return false;
  if (!last) return true;
  if (last.next_follow_up_date) return last.next_follow_up_date <= today;
  return !last.created_day || last.created_day <= addDays(today, -FOLLOW_UP_AFTER_DAYS);
}

module.exports = {
  PO_TRACKER_QUERY,
  mapPurchaseOrders,
  CHANNELS,
  FOLLOW_UP_AFTER_DAYS,
  validSlug,
  addDays,
  needsFollowUp,
};
