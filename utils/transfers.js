/**
 * Transfers - stock dispatched from one location to another, live from
 * RetailPilot runway (SPECTRA), with each transfer's articles.
 *
 *   picknpack.stock_transfers       one row per dispatch (one truck trip to
 *                                   one store), raised at Finish Loading.
 *                                   IN_TRANSIT -> PARTIALLY_RECEIVED ->
 *                                   RECEIVED as the store unloads boxes.
 *   picknpack.stock_transfer_lines  one row per batch per box. returned_qty
 *                                   is what the receiving store's
 *                                   verification sent back (found short).
 *   masterhub.articles              article names, read on their own.
 *
 * stage_ids are the documents behind the boxes: INV-... supplier invoices
 * (cross-dock GRN), ADA-... ad-hoc allocations, anything else an STA.
 *
 * SPECTRA runs SQL text and turns literals into parameters: values put in a
 * query are days reduced to YYYY-MM-DD or ids checked against a strict
 * pattern. No subqueries; no GROUP BY on an expression holding a literal.
 */

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_RANGE_DAYS = 31;
const OPEN_STATUSES = ["IN_TRANSIT", "PARTIALLY_RECEIVED"];

const clean = (v) => (v == null ? "" : String(v).trim());
const num = (v) => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const round3 = (v) => Math.round((Number(v) || 0) * 1000) / 1000;
const iso = (v) => {
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

function validDay(value) {
  const text = clean(value);
  const m = DATE_PATTERN.exec(text);
  if (!m) return null;
  const [y, mo, d] = m.slice(1).map(Number);
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return text;
}

const validId = (value) => {
  const s = clean(value);
  return ID_PATTERN.test(s) ? s : null;
};

/** null = open transfers only; else { from, to } or { error }. */
function validRange(fromValue, toValue) {
  if (!clean(fromValue) && !clean(toValue)) return null;
  const from = validDay(fromValue);
  const to = validDay(toValue);
  if (!from || !to) return { error: "from_date and to_date must be real days as YYYY-MM-DD" };
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000 + 1;
  if (days < 1) return { error: "from_date must not be after to_date" };
  if (days > MAX_RANGE_DAYS) return { error: `Choose at most ${MAX_RANGE_DAYS} days` };
  return { from, to };
}

const HEADER_COLUMNS = `
  t.slug, t.job_type, t.origin_store, t.destination_store, t.status, t.dispatched_at,
  t.dispatched_by, t.received_at, t.truck_id, t.box_count, t.article_count, t.total_qty,
  t.total_landing_cost, t.total_mrp_value, t.total_sp_value, t.total_tax, t.total_taxable,
  t.eway_bill_no, t.stage_ids`;

/**
 * Transfers to list: the open ones (no range), or every one dispatched on
 * the days of `range` (India time).
 */
function buildTransfersQuery(range) {
  if (!range) {
    return `
SELECT ${HEADER_COLUMNS}
FROM picknpack.stock_transfers t
WHERE t.status IN ('IN_TRANSIT', 'PARTIALLY_RECEIVED')
ORDER BY t.dispatched_at, t.slug`;
  }
  const r = validRange(range.from, range.to);
  if (!r || r.error) throw new Error((r && r.error) || "A date range is required");
  return `
SELECT ${HEADER_COLUMNS}
FROM picknpack.stock_transfers t
WHERE ((t.dispatched_at AT TIME ZONE 'Asia/Kolkata')::date) >= DATE '${r.from}'
  AND ((t.dispatched_at AT TIME ZONE 'Asia/Kolkata')::date) <= DATE '${r.to}'
ORDER BY t.dispatched_at, t.slug`;
}

/** One transfer's header. */
function buildTransferQuery(slug) {
  const s = validId(slug);
  if (!s) throw new Error("Invalid transfer");
  return `
SELECT ${HEADER_COLUMNS}
FROM picknpack.stock_transfers t
WHERE t.slug = '${s}'`;
}

/** Per transfer, what its receiving store's verification sent back. */
function buildShortfallsQuery(slugs) {
  const ids = [...new Set((slugs || []).map(validId).filter(Boolean))];
  if (!ids.length) return null;
  return `
SELECT l.transfer_slug,
  COUNT(*) AS short_lines,
  COALESCE(SUM(l.returned_qty), 0) AS returned_qty,
  COALESCE(SUM(l.returned_qty * l.landing_cost), 0) AS returned_value,
  MAX(l.returned_at) AS returned_at
FROM picknpack.stock_transfer_lines l
WHERE l.returned_qty > 0
  AND l.transfer_slug IN (${ids.map((id) => `'${id}'`).join(", ")})
GROUP BY l.transfer_slug`;
}

/** Every line of one transfer. */
function buildLinesQuery(slug) {
  const s = validId(slug);
  if (!s) throw new Error("Invalid transfer");
  return `
SELECT l.slug, l.article_id, l.batch_id, l.box_id, l.qty, l.returned_qty, l.returned_at,
  l.status, l.received_at, l.received_store, l.mrp, l.landing_cost, l.net_cost, l.selling_price
FROM picknpack.stock_transfer_lines l
WHERE l.transfer_slug = '${s}'
ORDER BY l.article_id, l.box_id, l.batch_id`;
}

/** Names of these articles. Compared as text: no join between id columns of unknown types. */
function buildArticleNamesQuery(articleIds) {
  const ids = [...new Set((articleIds || []).map(validId).filter(Boolean))];
  if (!ids.length) return null;
  return `
SELECT CAST(a.slug AS TEXT) AS id, a.article_name, a.external_id
FROM masterhub.articles a
WHERE CAST(a.slug AS TEXT) IN (${ids.map((id) => `'${id}'`).join(", ")})`;
}

/** stage_ids arrive as an array, or as text such as "{a,b}" or "['a', 'b']". */
function parseIds(value) {
  if (Array.isArray(value)) return value.map(clean).filter(Boolean);
  const text = clean(value);
  if (!text) return [];
  return text
    .replace(/^[[{]|[\]}]$/g, "")
    .split(",")
    .map((v) => v.replace(/^[\s'"]+|[\s'"]+$/g, ""))
    .filter(Boolean);
}

/** What a transfer carries: supplier invoices, ad-hoc allocations, STAs. */
function documentMix(ids) {
  const mix = { invoices: 0, adhoc: 0, sta: 0 };
  ids.forEach((id) => {
    if (/^INV-/i.test(id)) mix.invoices += 1;
    else if (/^ADA-/i.test(id)) mix.adhoc += 1;
    else mix.sta += 1;
  });
  return mix;
}

/** Shortfall rows -> Map(transfer slug -> { short_lines, returned_qty, returned_value, returned_at }). */
function mapShortfalls(rows) {
  const out = new Map();
  for (const r of rows || []) {
    out.set(clean(r.transfer_slug), {
      short_lines: num(r.short_lines) || 0,
      returned_qty: round3(r.returned_qty),
      returned_value: round2(r.returned_value),
      returned_at: iso(r.returned_at),
    });
  }
  return out;
}

/** Transfer rows -> [{ slug, status, job_type, store (to), origin, times, truck, counts, values, mix, short }]. */
function mapTransfers(rows, shortfalls, resolve) {
  const seen = new Set();
  const out = [];
  for (const r of rows || []) {
    const slug = clean(r.slug);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    const ids = parseIds(r.stage_ids);
    out.push({
      slug,
      status: clean(r.status).toUpperCase() || null,
      job_type: clean(r.job_type).toUpperCase() || null,
      store: resolve(r.destination_store, null).key,
      origin: resolve(r.origin_store, null).key,
      dispatched_at: iso(r.dispatched_at),
      dispatched_by: clean(r.dispatched_by) || null,
      received_at: iso(r.received_at),
      truck_id: clean(r.truck_id) || null,
      eway_bill_no: clean(r.eway_bill_no) || null,
      box_count: num(r.box_count) || 0,
      article_count: num(r.article_count) || 0,
      total_qty: round3(r.total_qty),
      total_landing_cost: num(r.total_landing_cost),
      total_mrp_value: num(r.total_mrp_value),
      total_sp_value: num(r.total_sp_value),
      total_tax: num(r.total_tax),
      total_taxable: num(r.total_taxable),
      documents_mix: documentMix(ids),
      invoice_refs: ids.filter((id) => /^INV-/i.test(id)),
      short: (shortfalls && shortfalls.get(slug)) || null,
    });
  }
  return out;
}

/**
 * A transfer's lines, one row per article (summed over its boxes and
 * batches), each with those boxes and batches:
 *
 *   sent      qty dispatched
 *   short     qty the store's verification sent back
 *   received  sent - short, on lines the store has received; 0 while in transit
 *   value     sent x landing cost (tax-inclusive stock value)
 *
 * Sorted with short articles first, then by name.
 */
function articlesFromLines(lines, nameRows) {
  const names = new Map((nameRows || []).map((r) => [clean(r.id), { name: clean(r.article_name), code: clean(r.external_id) }]));
  const byArticle = new Map();
  for (const l of lines || []) {
    const id = clean(l.article_id) || "(none)";
    if (!byArticle.has(id)) {
      const n = names.get(id) || {};
      byArticle.set(id, {
        article_id: id,
        name: n.name || null,
        code: n.code || null,
        sent: 0,
        received: 0,
        short: 0,
        in_transit: 0,
        value: 0,
        mrp_value: 0,
        boxes: [],
      });
    }
    const a = byArticle.get(id);
    const qty = num(l.qty) || 0;
    const returned = num(l.returned_qty) || 0;
    const status = clean(l.status).toUpperCase();
    const landing = num(l.landing_cost) || 0;
    a.sent = round3(a.sent + qty);
    a.short = round3(a.short + returned);
    if (status === "RECEIVED") a.received = round3(a.received + qty - returned);
    else a.in_transit = round3(a.in_transit + qty);
    a.value = round2(a.value + qty * landing);
    a.mrp_value = round2(a.mrp_value + qty * (num(l.mrp) || 0));
    a.boxes.push({
      box_id: clean(l.box_id) || null,
      batch_id: clean(l.batch_id) || null,
      qty,
      returned_qty: returned,
      status: status || null,
      received_store: clean(l.received_store) || null,
      received_at: iso(l.received_at),
      mrp: num(l.mrp),
      landing_cost: num(l.landing_cost),
    });
  }
  return [...byArticle.values()].sort((x, y) => (y.short > 0) - (x.short > 0) || String(x.name || x.article_id).localeCompare(String(y.name || y.article_id)));
}

module.exports = {
  OPEN_STATUSES,
  MAX_RANGE_DAYS,
  validRange,
  validId,
  buildTransfersQuery,
  buildTransferQuery,
  buildShortfallsQuery,
  buildLinesQuery,
  buildArticleNamesQuery,
  parseIds,
  documentMix,
  mapShortfalls,
  mapTransfers,
  articlesFromLines,
};
