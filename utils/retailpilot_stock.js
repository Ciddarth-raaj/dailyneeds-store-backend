/**
 * RetailPilot batch stock and prices -> the rows the Offers V3 price and
 * stock uploads and the Price Checker upload take, so the daily pull goes
 * through the same usecases as the hand-uploaded sheets.
 *
 * Tables live in RetailPilot's `public` schema (SPECTRA's whitelist), not
 * `inventory`. SPECTRA allows no subqueries and no INFORMATION_SCHEMA.
 */

/**
 * One row per batch per stock location with a non-zero quantity, with the
 * batch's default selling price (the row with no channel, customer or store).
 * item_code is the old (GoFrugal) code our product_table is keyed on;
 * article_id is RetailPilot's own id.
 */
function buildStockQuery() {
  return `
SELECT
  p.store_id,
  s.name                AS store_name,
  p.stock_location,
  b.article_id,
  a.external_id         AS item_code,
  a.article_name,
  b.batch_id,
  p.quantity,
  b.mrp,
  b.landing_cost,
  b.net_landing_cost,
  sp.selling_price      AS default_selling_price
FROM public.batch_stock_positions p
JOIN public.inventory_batches b ON b.batch_id = p.batch_id
LEFT JOIN masterhub.articles a  ON a.slug = b.article_id
LEFT JOIN masterhub.stores s    ON s.slug = p.store_id
LEFT JOIN public.batch_selling_price sp ON sp.batch_id = b.batch_id
     AND sp.channel_type IS NULL AND sp.customer_type IS NULL AND sp.store_id IS NULL
WHERE p.quantity <> 0
ORDER BY p.store_id, b.batch_id, p.stock_location
`;
}

/** In-store retail prices: store_id set = that store only, null = every store. */
function buildInstorePriceQuery() {
  return `
SELECT batch_id, store_id, selling_price
FROM public.batch_selling_price
WHERE channel_type = 'instore' AND customer_type = 'retail'
ORDER BY batch_id, store_id
`;
}

/** Old item code -> RetailPilot article id, for product_table. */
function buildArticleIdQuery() {
  return `
SELECT slug AS article_id, external_id AS item_code
FROM masterhub.articles
WHERE external_id IS NOT NULL
ORDER BY slug
`;
}

// Only stock in the selling location counts towards Offers V3 stock; damaged,
// dock, GRN-holding and production stock is not on the shelf.
const SELLABLE_LOCATION = "main";

function toIntCode(v) {
  const s = v == null ? "" : String(v).trim();
  return /^\d+$/.test(s) ? parseInt(s, 10) : null;
}

const num = (v) => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * @param stockRows rows of buildStockQuery
 * @param instoreRows rows of buildInstorePriceQuery
 * @param storeMap { [retailpilot store slug]: outlet_id } from Branch Master
 * @returns {
 *   priceRows:        Offers V3 price upload rows,
 *   stockRows:        Offers V3 stock upload rows (main location only),
 *   priceCheckerRows: Price Checker bulk rows,
 *   skipped:          [{ store_id, batch_id, item_code, reason }],
 * }
 * Selling price: the batch's in-store retail price for that store, else its
 * in-store retail price for every store, else its default price. Online and
 * B2B prices are never used.
 */
function mapStockRows(stockRows, instoreRows, storeMap) {
  const instoreForStore = new Map();
  const instoreAll = new Map();
  for (const r of instoreRows || []) {
    const price = num(r.selling_price);
    if (price == null) continue;
    if (r.store_id == null || r.store_id === "") instoreAll.set(r.batch_id, price);
    else instoreForStore.set(`${r.batch_id}|${r.store_id}`, price);
  }

  const skipped = [];
  const unmappedStores = new Set();
  // item|outlet|batch -> aggregated line
  const lines = new Map();

  for (const r of stockRows || []) {
    const outletId = storeMap[r.store_id];
    if (outletId == null) {
      unmappedStores.add(r.store_id);
      continue;
    }
    const itemCode = toIntCode(r.item_code);
    if (itemCode == null) {
      skipped.push({ store_id: r.store_id, batch_id: r.batch_id, article_id: r.article_id, reason: "no item code (external_id) in RetailPilot" });
      continue;
    }
    const key = `${itemCode}|${outletId}|${r.batch_id}`;
    let line = lines.get(key);
    if (!line) {
      const selling =
        instoreForStore.get(`${r.batch_id}|${r.store_id}`) ??
        instoreAll.get(r.batch_id) ??
        num(r.default_selling_price);
      line = {
        item_code: itemCode,
        outlet_id: outletId,
        outlet_name: r.store_name || null,
        item_name: r.article_name || null,
        batch_no: String(r.batch_id),
        mrp: num(r.mrp),
        selling_price: selling,
        landing_cost: num(r.landing_cost),
        net_landing_cost: num(r.net_landing_cost),
        sellable_qty: 0,
        has_sellable: false,
      };
      lines.set(key, line);
    }
    if (r.stock_location === SELLABLE_LOCATION) {
      line.sellable_qty += num(r.quantity) || 0;
      line.has_sellable = true;
    }
  }

  const priceRows = [];
  const stockRows2 = [];
  const priceCheckerRows = [];
  for (const l of lines.values()) {
    if (l.has_sellable) {
      stockRows2.push({
        item_code: l.item_code,
        outlet: String(l.outlet_id),
        batch_no: l.batch_no,
        stock_qty: Math.round(l.sellable_qty * 1000) / 1000,
      });
    }
    if (l.mrp == null || l.selling_price == null) {
      skipped.push({ store_id: null, outlet_id: l.outlet_id, batch_id: l.batch_no, item_code: l.item_code, reason: "no MRP / selling price in RetailPilot" });
      continue;
    }
    priceRows.push({
      item_code: l.item_code,
      outlet: String(l.outlet_id),
      batch_no: l.batch_no,
      mrp: l.mrp,
      selling_price: l.selling_price,
      landing_cost: l.landing_cost,
    });
    priceCheckerRows.push({
      outlet_id: l.outlet_id,
      outlet_name: l.outlet_name,
      item_code: l.item_code,
      item_name: l.item_name,
      batch_no: l.batch_no,
      purchase_price: l.landing_cost,
      landing_cost: l.net_landing_cost,
      old_mrp: l.mrp,
      new_mrp: l.mrp,
      old_selling_price: l.selling_price,
      new_selling_price: l.selling_price,
    });
  }

  return {
    priceRows,
    stockRows: stockRows2,
    priceCheckerRows,
    skipped,
    unmappedStores: [...unmappedStores],
  };
}

/** [{ product_id, retailpilot_article_id }] from buildArticleIdQuery rows. */
function mapArticleIds(rows) {
  const out = [];
  for (const r of rows || []) {
    const productId = toIntCode(r.item_code);
    const articleId = toIntCode(r.article_id);
    if (productId != null && articleId != null) out.push({ product_id: productId, retailpilot_article_id: articleId });
  }
  return out;
}

module.exports = {
  buildStockQuery,
  buildInstorePriceQuery,
  buildArticleIdQuery,
  mapStockRows,
  mapArticleIds,
  SELLABLE_LOCATION,
};
