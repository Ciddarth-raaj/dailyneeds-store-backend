/**
 * Out-of-stock follow-up - the pure rules behind the daily upload of
 * RetailPilot's out-of-stock report (Article ID, Category, Article, Class,
 * Store, MRP, Cover now, Planned, %, Stock, Value).
 *
 * Every line becomes a CASE: one (article, store) that is out of stock, open
 * from the first report it appears in until the first report it is missing
 * from (back in stock). Each morning's upload
 *   - refreshes the cases still out (figures, supplier, buyer, cause, tier),
 *   - opens a case for each new line,
 *   - closes the cases no longer in the report.
 *
 * TIER - how hard to chase (class X is slow moving):
 *   1 daily   class A or B, every warehouse line, a class C article out in
 *             SPREAD_STORES+ locations (a chain-wide supply problem), or a
 *             class X line worth WORTH_CHASING_X or more
 *   3 review  the other class X lines - weekly review, not chased
 *   2 ageing  everything else (class C, unknown class) - chased once it has
 *             been out AGEING_DAYS days
 *
 * CAUSE - the likely reason, which says who acts:
 *   warehouse_stock  a store is out but the warehouse holds stock: transfer
 *   po_pending       the supplier's latest PO at that store (PO Tracker) is
 *                    still open - approved or partly received: chase it
 *   (the PO is the latest one per store and supplier, as the PO Tracker
 *    shows it, with its status, fill % and last follow-up remark)
 *   no_supplier      the article has no supplier in DNDS: fix the master
 *   no_po            none of the above: the buyer should raise a PO
 */

const WAREHOUSE_STORE = "warehouse";
const WORTH_CHASING_X = 5000;
const SPREAD_STORES = 5;
const AGEING_DAYS = 5;

// The buyer's answer on a line. Discontinued / ignore take the line off the
// lists while it stays out.
const REASONS = ["ordered", "supplier_no_stock", "transfer_raised", "price_issue", "discontinued", "ignore", "other"];
const HIDING_REASONS = ["discontinued", "ignore"];

const str = (v) => (v == null ? "" : String(v).replace(/\s+/g, " ").trim());
const num = (v) => {
  const n = Number(String(v == null ? "" : v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
};
const money = (v) => Math.round(num(v) * 100) / 100;

/** A store as the report names it: lower case, single spaces. */
const storeKey = (v) => str(v).toLowerCase();

/**
 * The report's store name for a DNDS outlet ("Daily Needs-Vallalar Salai" ->
 * "vallalar salai"), so RetailPilot's store slugs (via outlets.retailpilot_id)
 * can be matched to report lines.
 */
function storeKeyOfOutlet(outlet, warehouseOutletId) {
  if (Number(outlet.outlet_id) === Number(warehouseOutletId)) return WAREHOUSE_STORE;
  const name = storeKey(outlet.outlet_name).replace(/^daily\s*needs\s*-\s*/, "");
  if (/\becr\b|east coast/.test(name)) return "ecr";
  return name;
}

/**
 * The upload's rows, cleaned. A row needs a numeric Article ID and a store;
 * the same (article, store) twice keeps the first. Returns { rows, skipped }.
 */
function cleanRows(raw) {
  const rows = [];
  const skipped = [];
  const seen = new Set();
  (raw || []).forEach((r, i) => {
    const article = str(r.article_id);
    const store = storeKey(r.store);
    if (!/^\d+$/.test(article) || !store) {
      skipped.push({ line: i + 2, reason: "no Article ID or Store", article: str(r.article_name) });
      return;
    }
    const key = `${article}|${store}`;
    if (seen.has(key)) {
      skipped.push({ line: i + 2, reason: "repeated line", article: str(r.article_name) });
      return;
    }
    seen.add(key);
    rows.push({
      article_id: parseInt(article, 10),
      store,
      article_name: str(r.article_name).slice(0, 255),
      category: str(r.category).slice(0, 120),
      class: str(r.class).toUpperCase().slice(0, 4),
      mrp: money(r.mrp),
      cover_now: money(r.cover_now),
      planned: money(r.planned),
      pct: money(r.pct),
      stock: money(r.stock),
      value: money(r.value),
    });
  });
  return { rows, skipped };
}

/** article id -> how many locations the report has it out in. */
function storesOut(rows) {
  const m = new Map();
  for (const r of rows) m.set(r.article_id, (m.get(r.article_id) || 0) + 1);
  return m;
}

function tierOf(row, outIn) {
  const cls = row.class;
  if (cls === "A" || cls === "B") return 1;
  if (row.store === WAREHOUSE_STORE) return 1;
  if (cls === "X") return row.value >= WORTH_CHASING_X ? 1 : 3;
  if (outIn >= SPREAD_STORES) return 1;
  return 2;
}

const OPEN_PO = ["APPROVED", "PARTIALLY_FULFILLED"];

/**
 * @param ctx { supplierCid, warehouseQty, reportDate,
 *   po: the PO Tracker order of this supplier at this store, or null }
 * @returns { cause, detail }
 */
function causeOf(row, ctx) {
  if (row.store !== WAREHOUSE_STORE && ctx.warehouseQty > 0) {
    return { cause: "warehouse_stock", detail: `Warehouse has ${fmtQty(ctx.warehouseQty)}` };
  }
  if (!ctx.supplierCid) return { cause: "no_supplier", detail: "No supplier set for this article" };
  const po = ctx.po;
  if (po && OPEN_PO.includes(po.status)) return { cause: "po_pending", detail: poText(po, ctx.reportDate) };
  if (po) return { cause: "no_po", detail: `No open PO (last: ${poText(po, ctx.reportDate)})` };
  return { cause: "no_po", detail: "No PO on the PO Tracker" };
}

/** "PO DN1/123 · 3 days · partly received 40% · \"delivers Friday\"" */
function poText(po, reportDate) {
  const age = daysBetween(po.po_date, reportDate);
  const parts = [`PO ${po.po_ref || po.po_slug}`];
  if (age != null) parts.push(`${age} day${age === 1 ? "" : "s"}`);
  const status = {
    APPROVED: "not received",
    PARTIALLY_FULFILLED: `partly received${po.qty_fill_pct != null && po.qty_fill_pct !== 0 ? ` ${po.qty_fill_pct}%` : ""}`,
  }[po.status] || String(po.status || "").toLowerCase().replace(/_/g, " ");
  if (status) parts.push(status);
  if (po.expired) parts.push("past validity");
  if (po.last_remark) parts.push(`"${po.last_remark}"`);
  return parts.join(" · ");
}

/**
 * PO Tracker orders -> Map<`${store key}|${supplier cid}`, order>, the cid
 * being DNDS's "RP<vendor id>".
 * @param storeKeyOfSlug Map<RetailPilot store slug, report store name>
 */
function poByStoreSupplier(orders, storeKeyOfSlug) {
  const m = new Map();
  for (const o of orders || []) {
    const store = storeKeyOfSlug.get(str(o.store_id));
    const vendor = str(o.supplier_id);
    if (!store || !vendor) continue;
    const key = `${store}|RP${vendor}`;
    const prev = m.get(key);
    // Several POs on the latest day: an open one wins.
    if (!prev || (!OPEN_PO.includes(prev.status) && OPEN_PO.includes(o.status))) {
      m.set(key, {
        po_slug: str(o.po_slug),
        po_ref: str(o.po_ref),
        po_date: o.po_date || null,
        status: str(o.status),
        qty_fill_pct: o.qty_fill_pct,
        expired: Boolean(o.expired),
        last_remark: o.last_followup ? str(o.last_followup.remark).slice(0, 80) : null,
      });
    }
  }
  return m;
}

const fmtQty = (q) => String(Math.round(num(q) * 1000) / 1000);

/** Whole days from a to b (YYYY-MM-DD or Date); null if either is missing. */
function daysBetween(a, b) {
  const d = (v) => {
    if (!v) return null;
    const s = v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
    const t = Date.parse(`${s}T00:00:00Z`);
    return Number.isFinite(t) ? t : null;
  };
  const x = d(a);
  const y = d(b);
  if (x == null || y == null) return null;
  return Math.round((y - x) / 86400000);
}

/**
 * Today's cases from the cleaned rows and what DNDS knows.
 * @param ctx {
 *   reportDate,
 *   enrichment: Map<article id, { distributor_id, supplier_name, buyer_id, buyer_name }>,
 *   warehouseStock: Map<article id, qty>,
 *   poByStoreSupplier: Map<`${store}|${supplier cid}`, PO> (poByStoreSupplier)
 * }
 */
function buildLines(rows, ctx) {
  const outIn = storesOut(rows);
  return rows.map((r) => {
    const e = ctx.enrichment.get(r.article_id) || {};
    const supplierCid = str(e.distributor_id) || null;
    const po = supplierCid ? ctx.poByStoreSupplier.get(`${r.store}|${supplierCid}`) || null : null;
    const { cause, detail } = causeOf(r, {
      supplierCid,
      warehouseQty: num(ctx.warehouseStock.get(r.article_id)),
      po,
      reportDate: ctx.reportDate,
    });
    return {
      ...r,
      supplier_cid: supplierCid,
      supplier_name: str(e.supplier_name) || null,
      buyer_id: e.buyer_id == null ? null : Number(e.buyer_id),
      buyer_name: str(e.buyer_name) || null,
      cause,
      cause_detail: detail.slice(0, 255),
      po_slug: po ? po.po_slug || null : null,
      tier: tierOf(r, outIn.get(r.article_id) || 1),
      stores_out: outIn.get(r.article_id) || 1,
    };
  });
}

/**
 * What the upload does to the cases.
 * @param existing cases that are open, or were closed on reportDate (a
 *   same-day re-upload): [{ id, article_id, store, status, closed_on }]
 * @returns { insert: [line], update: [{ id, line, reopen }], close: [id] }
 */
function planCases(lines, existing, reportDate) {
  const byKey = new Map();
  for (const c of existing) {
    const key = `${c.article_id}|${storeKey(c.store)}`;
    const prev = byKey.get(key);
    // An open case wins over one closed today.
    if (!prev || (prev.status !== "open" && c.status === "open")) byKey.set(key, c);
  }
  const insert = [];
  const update = [];
  const touched = new Set();
  for (const line of lines) {
    const c = byKey.get(`${line.article_id}|${line.store}`);
    if (!c) {
      insert.push(line);
      continue;
    }
    touched.add(c.id);
    update.push({ id: c.id, line, reopen: c.status !== "open" });
  }
  const close = existing.filter((c) => c.status === "open" && !touched.has(c.id)).map((c) => c.id);
  return { insert, update, close, reportDate };
}

/** YYYY-MM-DD from the file name (out_supplier_2026-11-26.csv), else null. */
function reportDateFromFileName(name) {
  const m = str(name).match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const d = `${m[1]}-${m[2]}-${m[3]}`;
  return Number.isFinite(Date.parse(`${d}T00:00:00Z`)) ? d : null;
}

module.exports = {
  WAREHOUSE_STORE,
  WORTH_CHASING_X,
  SPREAD_STORES,
  AGEING_DAYS,
  REASONS,
  HIDING_REASONS,
  OPEN_PO,
  storeKey,
  storeKeyOfOutlet,
  cleanRows,
  storesOut,
  tierOf,
  causeOf,
  daysBetween,
  buildLines,
  planCases,
  reportDateFromFileName,
  poByStoreSupplier,
  poText,
};
