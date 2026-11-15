/**
 * Business Dashboard - Purchase, Sales, Sales Return, Stock (and, once
 * RetailPilot exposes them, Purchase Return and Margin) per store, read live
 * from RetailPilot (SPECTRA). Nothing is stored here.
 *
 *   sales, sales returns   public.bills (product Mandapam, the sales key),
 *                          per bill day per store: sign 1 = sale, sign -1 =
 *                          return, amount total_payable_with_services - the
 *                          same figures Sales Reconciliation pulls.
 *   purchases              public.invoice_headers (product runway), per day
 *                          entered (India time - the GRN date the GRN pages
 *                          use) per store per invoice_type, amount total_net.
 *                          PURCHASE is a purchase; a type naming a return
 *                          (e.g. PURCHASE_RETURN) is a purchase return; every
 *                          other type is reported, not counted.
 *   stock                  public.batch_stock_positions x inventory_batches,
 *                          now, per store per stock location: quantity, value
 *                          at landing cost and at MRP.
 *
 * SPECTRA runs SQL text, so the only values built into a query are days
 * already reduced to exactly YYYY-MM-DD by validDay. No subqueries.
 */

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_RANGE_DAYS = 93;

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

const dayNumber = (day) => Date.parse(`${day}T00:00:00Z`) / 86400000;

/** { from, to } or { error } - both real days, from <= to, at most MAX_RANGE_DAYS days. */
function validRange(fromValue, toValue) {
  const from = validDay(fromValue);
  const to = validDay(toValue);
  if (!from || !to) return { error: "from_date and to_date must be real days as YYYY-MM-DD" };
  const days = dayNumber(to) - dayNumber(from) + 1;
  if (days < 1) return { error: "from_date must not be after to_date" };
  if (days > MAX_RANGE_DAYS) return { error: `Choose at most ${MAX_RANGE_DAYS} days` };
  return { from, to };
}

function checkedRange(from, to) {
  const r = validRange(from, to);
  if (r.error) throw new Error(r.error);
  return r;
}

function buildSalesRangeQuery(fromDay, toDay) {
  const { from, to } = checkedRange(fromDay, toDay);
  return `
SELECT b.bill_date AS day, b.store_slug, st.name AS store_name,
  COALESCE(SUM(b.total_payable_with_services) FILTER (WHERE b.sign = 1), 0)       AS sales,
  COALESCE(SUM(ABS(b.total_payable_with_services)) FILTER (WHERE b.sign = -1), 0) AS returns,
  COUNT(*) FILTER (WHERE b.sign = 1)  AS bills,
  COUNT(*) FILTER (WHERE b.sign = -1) AS return_bills
FROM public.bills b
LEFT JOIN peti.stores st ON st.slug = b.store_slug
WHERE b.bill_date BETWEEN DATE '${from}' AND DATE '${to}'
GROUP BY b.bill_date, b.store_slug, st.name
ORDER BY b.bill_date, b.store_slug`;
}

/**
 * One row per invoice, folded per day per store per type in mapPurchaseRows.
 * Not grouped in SQL: SPECTRA turns every literal into a parameter, so a
 * GROUP BY on the India-time day ('Asia/Kolkata' becoming $n) no longer
 * matches the same expression in the SELECT and Postgres refuses the query.
 * The day filter is the GRN pages' own, which runs.
 */
function buildPurchaseRangeQuery(fromDay, toDay) {
  const { from, to } = checkedRange(fromDay, toDay);
  return `
SELECT CAST(((h.created_at AT TIME ZONE 'Asia/Kolkata')::date) AS TEXT) AS day,
  h.store_id, h.invoice_type, h.total_net AS amount
FROM public.invoice_headers h
WHERE ((h.created_at AT TIME ZONE 'Asia/Kolkata')::date) >= DATE '${from}'
  AND ((h.created_at AT TIME ZONE 'Asia/Kolkata')::date) <= DATE '${to}'
ORDER BY h.slug`;
}

/**
 * Margin, per bill day per store, from public.bill_details (Mandapam, the
 * sales key). Every amount on a line is tax-inclusive and positive; bills.sign
 * makes a return line count against the day.
 *
 *   sales_ex_tax   line_payable - total_tax: what the customer paid, before tax
 *   cost           total_landing_without_tax: batch basic cost x quantity
 *
 * A line whose cost is unknown has total_landing_without_tax 0; counting it
 * would show its whole value as margin. So margin is taken only over lines
 * with a cost (costed_sales, cost), and the sales of the others are reported
 * (uncosted_sales) so the screen can say how much of sales the margin covers.
 * Service-charge lines (article_id 0) are never stock and have no cost.
 */
function buildMarginRangeQuery(fromDay, toDay) {
  const { from, to } = checkedRange(fromDay, toDay);
  return `
SELECT b.bill_date AS day, d.store_slug, st.name AS store_name,
  COALESCE(SUM((d.line_payable - d.total_tax) * b.sign), 0) AS sales_ex_tax,
  COALESCE(SUM((d.line_payable - d.total_tax) * b.sign) FILTER (WHERE d.total_landing_without_tax > 0), 0) AS costed_sales,
  COALESCE(SUM(d.total_landing_without_tax * b.sign) FILTER (WHERE d.total_landing_without_tax > 0), 0) AS cost,
  COALESCE(SUM((d.line_payable - d.total_tax) * b.sign) FILTER (WHERE d.total_landing_without_tax <= 0 AND d.article_id <> 0), 0) AS uncosted_sales
FROM public.bill_details d
JOIN public.bills b ON b.bill_no = d.bill_no
LEFT JOIN peti.stores st ON st.slug = d.store_slug
WHERE b.bill_date BETWEEN DATE '${from}' AND DATE '${to}'
GROUP BY b.bill_date, d.store_slug, st.name
ORDER BY b.bill_date, d.store_slug`;
}

function buildStockSummaryQuery() {
  return `
SELECT p.store_id, p.stock_location,
  COALESCE(SUM(p.quantity), 0)                  AS quantity,
  COALESCE(SUM(p.quantity * b.landing_cost), 0) AS cost_value,
  COALESCE(SUM(p.quantity * b.mrp), 0)          AS mrp_value,
  COUNT(DISTINCT b.article_id)                  AS articles
FROM public.batch_stock_positions p
JOIN public.inventory_batches b ON b.batch_id = p.batch_id
WHERE p.quantity <> 0
GROUP BY p.store_id, p.stock_location
ORDER BY p.store_id, p.stock_location`;
}

const round2 = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};
const int = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
};
const dayOf = (v) => {
  const m = String(v == null ? "" : v).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
};
const clean = (v) => (v == null ? "" : String(v).trim());
const normName = (v) => clean(v).toLowerCase().replace(/[^a-z0-9]+/g, "");

/** How an invoice_type counts: "purchase", "purchase_return" or null (not counted). */
function invoiceTypeKind(type) {
  const t = clean(type).toUpperCase();
  if (t === "PURCHASE") return "purchase";
  if (/RETURN|DEBIT/.test(t)) return "purchase_return";
  return null;
}

/**
 * Resolves RetailPilot stores to branches. `branches` are Branch Master rows
 * with a RetailPilot ID: { outlet_id, outlet_name, retailpilot_id }. A store
 * is matched by its ID, else (bills carry a slug that may differ) by name
 * against the branch name. An unmatched store keeps its own key so its
 * figures still show - flagged, and only to an All Stores caller.
 */
function storeResolver(branches) {
  const byId = new Map();
  const byName = new Map();
  for (const b of branches || []) {
    const id = clean(b.retailpilot_id);
    const entry = { key: `outlet:${b.outlet_id}`, outlet_id: Number(b.outlet_id), name: clean(b.outlet_name) || id, mapped: true };
    if (id) byId.set(id, entry);
    const n = normName(b.outlet_name);
    if (n) byName.set(n, entry);
  }
  const stores = new Map();
  for (const e of byId.values()) stores.set(e.key, e);
  const resolve = (storeId, storeName) => {
    const id = clean(storeId);
    let entry = (id && byId.get(id)) || byName.get(normName(storeName));
    if (!entry) {
      const key = `rp:${id || normName(storeName) || "unknown"}`;
      entry = stores.get(key) || { key, outlet_id: null, name: clean(storeName) || id || "Unknown store", mapped: false };
    }
    stores.set(entry.key, entry);
    return entry;
  };
  return { resolve, stores };
}

/** Bills rows -> [{ day, store, sales, returns, bills, return_bills }]. */
function mapSalesRows(rows, resolve) {
  return (rows || []).map((r) => ({
    day: dayOf(r.day),
    store: resolve(r.store_slug, r.store_name).key,
    sales: round2(r.sales),
    returns: round2(r.returns),
    bills: int(r.bills),
    return_bills: int(r.return_bills),
  }));
}

/**
 * Invoice rows -> { rows: [{ day, store, purchase, purchase_invoices,
 * purchase_return, purchase_return_invoices }], invoice_types: [{ type,
 * counted_as, invoices, amount }] }. Returns are reported as positive amounts.
 */
function mapPurchaseRows(rows, resolve) {
  const cells = new Map();
  const types = new Map();
  for (const r of rows || []) {
    const type = clean(r.invoice_type) || "(blank)";
    const kind = invoiceTypeKind(r.invoice_type);
    const amount = round2(r.amount);
    const invoices = r.invoices == null ? 1 : int(r.invoices);
    const t = types.get(type) || { type, counted_as: kind, invoices: 0, amount: 0 };
    t.invoices += invoices;
    t.amount = round2(t.amount + amount);
    types.set(type, t);
    if (!kind) continue;
    const day = dayOf(r.day);
    const store = resolve(r.store_id, null).key;
    const k = `${day}|${store}`;
    const c = cells.get(k) || { day, store, purchase: 0, purchase_invoices: 0, purchase_return: 0, purchase_return_invoices: 0 };
    if (kind === "purchase") {
      c.purchase = round2(c.purchase + amount);
      c.purchase_invoices += invoices;
    } else {
      c.purchase_return = round2(c.purchase_return + Math.abs(amount));
      c.purchase_return_invoices += invoices;
    }
    cells.set(k, c);
  }
  return {
    rows: [...cells.values()],
    invoice_types: [...types.values()].sort((a, b) => b.amount - a.amount),
  };
}

// The selling location; damaged, dock, GRN-holding and production stock is not on the shelf.
const SELLABLE_LOCATION = "main";

/** bill_details rows -> [{ day, store, sales_ex_tax, costed_sales, cost, margin, uncosted_sales }]. */
function mapMarginRows(rows, resolve) {
  return (rows || []).map((r) => {
    const costed = round2(r.costed_sales);
    const cost = round2(r.cost);
    return {
      day: dayOf(r.day),
      store: resolve(r.store_slug, r.store_name).key,
      sales_ex_tax: round2(r.sales_ex_tax),
      costed_sales: costed,
      cost,
      margin: round2(costed - cost),
      uncosted_sales: round2(r.uncosted_sales),
    };
  });
}

/** Stock rows -> [{ store, quantity, cost_value, mrp_value, sellable_cost_value, articles, locations }]. */
function mapStockRows(rows, resolve) {
  const out = new Map();
  for (const r of rows || []) {
    const store = resolve(r.store_id, null).key;
    const s = out.get(store) || { store, quantity: 0, cost_value: 0, mrp_value: 0, sellable_cost_value: 0, articles: 0, locations: [] };
    const location = clean(r.stock_location) || "(none)";
    const cost = round2(r.cost_value);
    s.quantity = round2(s.quantity + Number(r.quantity || 0));
    s.cost_value = round2(s.cost_value + cost);
    s.mrp_value = round2(s.mrp_value + round2(r.mrp_value));
    if (location.toLowerCase() === SELLABLE_LOCATION) s.sellable_cost_value = round2(s.sellable_cost_value + cost);
    // Articles per location can overlap; the largest location is a floor, not a sum.
    s.articles = Math.max(s.articles, int(r.articles));
    s.locations.push({ location, quantity: round2(r.quantity), cost_value: cost });
    out.set(store, s);
  }
  return [...out.values()];
}

/**
 * Gate passes OPEN right now (runway public.gate_passes: OPEN until the
 * vehicle exits and the pass is CLOSED), oldest first, with any GRN
 * inspection started against each (grn_inspection_header.gatepass_slug) -
 * a pass with none is a vehicle still waiting to be unloaded. Not for a date
 * range: open is open, whenever the vehicle came in.
 */
function buildOpenGatePassQuery() {
  return `
SELECT g.slug, g.store_id, g.supplier_id, g.vehicle_number, g.driver_name, g.driver_phone,
  g.entry_time, g.created_by,
  i.slug AS inspection_slug, i.state AS inspection_state
FROM public.gate_passes g
LEFT JOIN public.grn_inspection_header i ON i.gatepass_slug = g.slug
WHERE g.status = 'OPEN'
ORDER BY g.entry_time, g.slug`;
}

/**
 * Supplier names, read on their own rather than joined: a join on ids of
 * two different column types would fail the whole gate pass query.
 */
function buildVendorNamesQuery() {
  return `
SELECT CAST(v.id AS TEXT) AS id, COALESCE(NULLIF(TRIM(v.trade_name), ''), v.name) AS name
FROM masterhub.vendors v
ORDER BY v.id`;
}

/**
 * Gate pass rows (one per inspection, or one with none) -> one per pass:
 * [{ slug, store, supplier_id, supplier_name, vehicle_number, driver_name,
 *    driver_phone, entry_time, open_hours, inspections: [{ slug, state }] }].
 */
function mapGatePassRows(rows, vendorRows, resolve, nowMs = Date.now()) {
  const vendors = new Map((vendorRows || []).map((v) => [clean(v.id), clean(v.name)]));
  const passes = new Map();
  for (const r of rows || []) {
    const slug = clean(r.slug);
    if (!slug) continue;
    let p = passes.get(slug);
    if (!p) {
      const entered = Date.parse(r.entry_time);
      p = {
        slug,
        store: resolve(r.store_id, null).key,
        supplier_id: clean(r.supplier_id) || null,
        supplier_name: vendors.get(clean(r.supplier_id)) || null,
        vehicle_number: clean(r.vehicle_number) || null,
        driver_name: clean(r.driver_name) || null,
        driver_phone: clean(r.driver_phone) || null,
        created_by: clean(r.created_by) || null,
        entry_time: Number.isFinite(entered) ? new Date(entered).toISOString() : null,
        open_hours: Number.isFinite(entered) ? Math.max(0, Math.round(((nowMs - entered) / 3600000) * 10) / 10) : null,
        inspections: [],
      };
      passes.set(slug, p);
    }
    const insp = clean(r.inspection_slug);
    if (insp && !p.inspections.some((x) => x.slug === insp)) {
      p.inspections.push({ slug: insp, state: clean(r.inspection_state) || null });
    }
  }
  return [...passes.values()];
}

/**
 * Keeps only what the caller's store scope allows. `storeIds` null = every
 * store (including stores not in Branch Master); a list = those branches only.
 */
function scopeRows(rows, storeIds, storesByKey) {
  if (storeIds === null || storeIds === undefined) return rows;
  const allowed = new Set(storeIds.map(Number));
  return rows.filter((r) => {
    const s = storesByKey.get(r.store);
    return s && s.mapped && allowed.has(s.outlet_id);
  });
}

module.exports = {
  MAX_RANGE_DAYS,
  validDay,
  validRange,
  buildSalesRangeQuery,
  buildPurchaseRangeQuery,
  buildStockSummaryQuery,
  buildMarginRangeQuery,
  buildOpenGatePassQuery,
  buildVendorNamesQuery,
  mapGatePassRows,
  mapMarginRows,
  invoiceTypeKind,
  storeResolver,
  mapSalesRows,
  mapPurchaseRows,
  mapStockRows,
  scopeRows,
};
