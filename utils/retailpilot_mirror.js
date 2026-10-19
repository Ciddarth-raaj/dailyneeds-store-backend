/**
 * What the daily RetailPilot sync copies into our rp_* tables, and how each
 * RetailPilot row becomes one of ours.
 *
 * mode "full": every run reads the whole table, and rows that run did not
 * see are deleted. mode "incremental": the first run reads everything, later
 * runs only rows changed in the last LOOKBACK_DAYS (nothing is deleted - a
 * batch never leaves RetailPilot).
 *
 * SPECTRA notes: tables are in RetailPilot's `public` / `masterhub` schemas,
 * no subqueries, and `CURRENT_DATE - <int>` rather than INTERVAL.
 */

const LOOKBACK_DAYS = 3;

const LEVEL_BY_ID = {
  "department-cpg": "department",
  "category-cpg": "category",
  "subcategory-cpg": "subcategory",
  "brand-cpg": "brand",
  "manufacturer-cpg": "manufacturer",
};

const str = (v, max) => {
  if (v == null) return null;
  const s = String(v).trim();
  if (s === "") return null;
  return max ? s.slice(0, max) : s;
};
const num = (v) => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const int = (v) => {
  const s = v == null ? "" : String(v).trim();
  return /^-?\d+$/.test(s) ? parseInt(s, 10) : null;
};
const bool = (v) => (v == null ? null : v === true || v === "true" || v === 1 || v === "1" ? 1 : 0);

/** RetailPilot timestamptz (IST) -> 'YYYY-MM-DD HH:MM:SS', the wall-clock time. */
function datetime(v) {
  const m = v == null ? null : String(v).match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/);
  return m ? `${m[1]} ${m[2]}` : null;
}
/** RetailPilot date; 1900-01-01 is its placeholder for "not known". */
function date(v) {
  const m = v == null ? null : String(v).match(/^(\d{4}-\d{2}-\d{2})/);
  if (!m || m[1] < "1901-01-01") return null;
  return m[1];
}
const json = (v, max) => (v == null ? null : str(typeof v === "string" ? v : JSON.stringify(v), max));

/**
 * Each spec: table, key (primary key columns), columns written, mode,
 * query(sinceDays) - sinceDays null means read everything - and map(row).
 */
const TABLES = [
  {
    table: "rp_hierarchy",
    mode: "full",
    key: ["level", "hierarchy_id"],
    columns: ["level", "hierarchy_id", "name", "row_hash"],
    query: () => `
SELECT level_id, hierarchy_id, hierarchy_name, row_hash
FROM masterhub.hierarchy_master
ORDER BY level_id, hierarchy_id`,
    map: (r) => {
      const level = LEVEL_BY_ID[r.level_id];
      const id = int(r.hierarchy_id);
      if (!level || id == null) return null;
      return { level, hierarchy_id: id, name: str(r.hierarchy_name, 255), row_hash: str(r.row_hash, 32) };
    },
  },
  {
    table: "rp_stores",
    mode: "full",
    key: ["store_id"],
    columns: ["store_id", "name", "shortname", "type", "entity_id", "is_active", "external_id", "row_hash"],
    query: () => `
SELECT slug, name, shortname, type, entity_id, is_active, external_id, row_hash
FROM masterhub.stores
ORDER BY slug`,
    map: (r) =>
      r.slug == null
        ? null
        : {
            store_id: str(r.slug, 20),
            name: str(r.name, 255),
            shortname: str(r.shortname, 100),
            type: str(r.type, 30),
            entity_id: str(r.entity_id, 30),
            is_active: bool(r.is_active),
            external_id: str(r.external_id, 50),
            row_hash: str(r.row_hash, 32),
          },
  },
  {
    table: "rp_vendors",
    mode: "full",
    key: ["vendor_id"],
    columns: ["vendor_id", "name", "trade_name", "tax_id", "is_active", "external_id", "row_hash"],
    query: () => `
SELECT id, name, trade_name, tax_id, is_active, external_id, row_hash
FROM masterhub.vendors
ORDER BY id`,
    map: (r) =>
      r.id == null
        ? null
        : {
            vendor_id: str(r.id, 20),
            name: str(r.name, 255),
            trade_name: str(r.trade_name, 255),
            tax_id: str(r.tax_id, 30),
            is_active: bool(r.is_active),
            external_id: str(r.external_id, 50),
            row_hash: str(r.row_hash, 32),
          },
  },
  {
    table: "rp_articles",
    mode: "full",
    key: ["article_id"],
    columns: [
      "article_id", "old_item_code", "article_name", "description", "preparation_type", "purchase_measure",
      "sales_measure", "scale", "precision_digits", "is_reversible", "hsn_code", "ready", "vertical", "mrp",
      "trade_price", "plu_id", "department_id", "category_id", "subcategory_id", "brand_id", "manufacturer_id",
      "rp_created_at", "rp_updated_at", "row_hash",
    ],
    // The article's hierarchy ids come from article_taxonomy, read first
    // (see needsTaxonomy) and passed to map as ctx.taxonomy.
    needsTaxonomy: true,
    query: () => `
SELECT slug, external_id, article_name, description, preparation_type, purchase_measure, sales_measure,
       scale, precision, is_reversible, hsn_code, ready, vertical, mrp, trade_price, plu_id,
       created_at, updated_at, row_hash
FROM masterhub.articles
ORDER BY slug`,
    map: (r, ctx) => {
      const id = int(r.slug);
      if (id == null) return null;
      const t = (ctx && ctx.taxonomy && ctx.taxonomy.get(id)) || {};
      return {
        article_id: id,
        old_item_code: int(r.external_id),
        article_name: str(r.article_name, 500),
        description: str(r.description),
        preparation_type: str(r.preparation_type, 50),
        purchase_measure: str(r.purchase_measure, 30),
        sales_measure: str(r.sales_measure, 30),
        scale: num(r.scale),
        precision_digits: int(r.precision),
        is_reversible: bool(r.is_reversible),
        hsn_code: str(r.hsn_code, 30),
        ready: bool(r.ready),
        vertical: str(r.vertical, 30),
        mrp: num(r.mrp),
        trade_price: num(r.trade_price),
        plu_id: str(r.plu_id, 50),
        department_id: t.department ?? null,
        category_id: t.category ?? null,
        subcategory_id: t.subcategory ?? null,
        brand_id: t.brand ?? null,
        manufacturer_id: t.manufacturer ?? null,
        rp_created_at: datetime(r.created_at),
        rp_updated_at: datetime(r.updated_at),
        row_hash: str(r.row_hash, 32),
      };
    },
  },
  {
    table: "rp_article_eans",
    mode: "full",
    key: ["ean", "article_id"],
    columns: ["ean", "article_id", "enabled", "is_auto_generated", "row_hash"],
    query: () => `
SELECT ean, article_id, enabled, is_auto_generated, row_hash
FROM public.article_eans
ORDER BY ean, article_id`,
    map: (r) => {
      const id = int(r.article_id);
      const ean = str(r.ean, 50);
      if (id == null || !ean) return null;
      return { ean, article_id: id, enabled: bool(r.enabled), is_auto_generated: bool(r.is_auto_generated), row_hash: str(r.row_hash, 32) };
    },
  },
  {
    table: "rp_batches",
    mode: "incremental",
    key: ["batch_id"],
    columns: [
      "batch_id", "article_id", "store_id", "supplier_id", "initial_stock", "mrp", "basic_cost", "discount_value",
      "net_cost", "tax_perc", "landing_cost", "net_landing_cost", "hsn_code", "supplier_batch_number",
      "manufacture_date", "expiry_date", "tags", "invoice_detail_slug", "rp_created_at", "rp_updated_at", "row_hash",
    ],
    query: (sinceDays) => `
SELECT batch_id, article_id, store_id, supplier_id, initial_stock, mrp, basic_cost, discount_value, net_cost,
       tax_perc, landing_cost, net_landing_cost, hsn_code, supplier_batch_number, manufacture_date, expiry_date,
       tags, invoice_detail_slug, created_at, updated_at, row_hash
FROM public.inventory_batches
${sinceDays == null ? "" : `WHERE COALESCE(updated_at, created_at) >= CURRENT_DATE - ${sinceDays}`}
ORDER BY batch_id`,
    map: (r) => {
      const article = int(r.article_id);
      const batch = str(r.batch_id, 64);
      if (article == null || !batch) return null;
      return {
        batch_id: batch,
        article_id: article,
        store_id: str(r.store_id, 20),
        supplier_id: str(r.supplier_id, 20),
        initial_stock: num(r.initial_stock),
        mrp: num(r.mrp),
        basic_cost: num(r.basic_cost),
        discount_value: num(r.discount_value),
        net_cost: num(r.net_cost),
        tax_perc: num(r.tax_perc),
        landing_cost: num(r.landing_cost),
        net_landing_cost: num(r.net_landing_cost),
        hsn_code: str(r.hsn_code, 30),
        supplier_batch_number: str(r.supplier_batch_number, 100),
        manufacture_date: date(r.manufacture_date),
        expiry_date: date(r.expiry_date),
        tags: Array.isArray(r.tags) && r.tags.length === 0 ? null : json(r.tags, 1000),
        invoice_detail_slug: str(r.invoice_detail_slug, 50),
        rp_created_at: datetime(r.created_at),
        rp_updated_at: datetime(r.updated_at),
        row_hash: str(r.row_hash, 32),
      };
    },
  },
  {
    table: "rp_batch_prices",
    mode: "incremental",
    key: ["price_id"],
    columns: ["price_id", "batch_id", "store_id", "channel_type", "customer_type", "selling_price", "rp_updated_at", "row_hash"],
    query: (sinceDays) => `
SELECT slug, batch_id, store_id, channel_type, customer_type, selling_price, updated_at, row_hash
FROM public.batch_selling_price
${sinceDays == null ? "" : `WHERE updated_at >= CURRENT_DATE - ${sinceDays}`}
ORDER BY slug`,
    map: (r) => {
      const id = str(r.slug, 32);
      const batch = str(r.batch_id, 64);
      if (!id || !batch) return null;
      return {
        price_id: id,
        batch_id: batch,
        store_id: str(r.store_id, 20),
        channel_type: str(r.channel_type, 20),
        customer_type: str(r.customer_type, 20),
        selling_price: num(r.selling_price),
        rp_updated_at: datetime(r.updated_at),
        row_hash: str(r.row_hash, 32),
      };
    },
  },
  {
    table: "rp_batch_stock",
    mode: "full",
    key: ["batch_id", "store_id", "stock_location"],
    columns: ["batch_id", "store_id", "stock_location", "article_id", "quantity", "rp_updated_at", "row_hash"],
    query: () => `
SELECT batch_id, store_id, stock_location, article_id, quantity, updated_at, row_hash
FROM public.batch_stock_positions
WHERE quantity <> 0
ORDER BY batch_id, store_id, stock_location`,
    map: (r) => {
      const article = int(r.article_id);
      const batch = str(r.batch_id, 64);
      const store = str(r.store_id, 20);
      const loc = str(r.stock_location, 30);
      const qty = num(r.quantity);
      if (article == null || !batch || !store || !loc || qty == null) return null;
      return {
        batch_id: batch,
        store_id: store,
        stock_location: loc,
        article_id: article,
        quantity: qty,
        rp_updated_at: datetime(r.updated_at),
        row_hash: str(r.row_hash, 32),
      };
    },
  },
];

const TAXONOMY_QUERY = `
SELECT article_id, level_id, hierarchy_id
FROM masterhub.article_taxonomy
ORDER BY article_id, level_id`;

/** Map<article id, { department, category, subcategory, brand, manufacturer }> */
function addTaxonomy(map, rows) {
  for (const r of rows) {
    const article = int(r.article_id);
    const level = LEVEL_BY_ID[r.level_id];
    const id = int(r.hierarchy_id);
    if (article == null || !level || id == null) continue;
    if (!map.has(article)) map.set(article, {});
    map.get(article)[level] = id;
  }
  return map;
}

module.exports = { TABLES, TAXONOMY_QUERY, LOOKBACK_DAYS, addTaxonomy, datetime, date };
