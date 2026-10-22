/**
 * Article Store Master - the morning report, one row per RetailPilot article:
 * its catalogue details (masterhub) and its stock at every store (runway),
 * laid out like the old system's article_store_master sheet.
 *
 * Not in it for now, by the owner's decision: MRP, net cost, sale rate. Not
 * in it: buyer and status - masterhub has no attribute for either; allow
 * negative - not wanted. Allow purchase and purchase type are masterhub
 * article attributes (derived.article_store_attributes: purchase_allowed,
 * purchase_type).
 *
 * SPECTRA, per product address (config/retailpilot.js):
 *   masterhub  public.articles (every article), derived.article_master and
 *              constants.hsn_tax_linker (tax), derived.article_taxonomy,
 *              derived.hierarchy_master, derived.article_store_suppliers,
 *              public.vendors, public.preparation_master, public.stores,
 *              constants.tax_rates
 *   runway     public.batch_stock_positions + public.inventory_batches
 *
 * Every query is plain and ordered, so SPECTRA's paging is stable; joining
 * them happens here, in buildReport.
 */

const MASTERHUB_QUERIES = {
  // Every article: masterhub's own articles table. (derived.article_master
  // holds only a few - 118 on the first live run - so it is not the list.)
  articles: `
SELECT a.slug AS article_id, a.article_name, a.hsn_code, a.preparation_type,
       a.purchase_measure, a.sales_measure
FROM public.articles a
ORDER BY a.slug`,
  // Tax: the article's own tax code where derived.article_master has it,
  // else the HSN code's rate (constants.hsn_tax_linker).
  articleTax: `
SELECT a.slug AS article_id, a.tax_code
FROM derived.article_master a
ORDER BY a.slug`,
  hsnTax: `
SELECT l.hsn_code, l.tax_code
FROM constants.hsn_tax_linker l
ORDER BY l.hsn_code, l.tax_code`,
  taxonomy: `
SELECT t.article_id, t.level_id, t.hierarchy_id, h.hierarchy_name, h.level_name
FROM derived.article_taxonomy t
JOIN derived.hierarchy_master h ON h.hierarchy_id = t.hierarchy_id AND h.level_id = t.level_id
ORDER BY t.article_id, t.level_id`,
  suppliers: `
SELECT s.article_id, s.store_id, s.supplier_id
FROM derived.article_store_suppliers s
ORDER BY s.article_id, s.store_id, s.supplier_id`,
  vendors: `
SELECT v.id, v.name, v.trade_name
FROM public.vendors v
ORDER BY v.id`,
  taxRates: `
SELECT r.code, r.description
FROM constants.tax_rates r
ORDER BY r.code`,
  attributes: `
SELECT a.article_id, a.store_id, a.attr_id, a.attr_value
FROM derived.article_store_attributes a
WHERE a.attr_id IN ('purchase_allowed', 'purchase_type')
ORDER BY a.article_id, a.attr_id, a.store_id`,
  preparation: `
SELECT p.prepared_item, p.ingredient_item, p.ingredient_measure
FROM public.preparation_master p
ORDER BY p.prepared_item, p.ingredient_item`,
  stores: `
SELECT s.slug, s.shortname, s.name, s.type, s.is_active
FROM public.stores s
ORDER BY s.slug`,
};

const RUNWAY_QUERIES = {
  stock: `
SELECT p.store_id, b.article_id, SUM(p.quantity) AS quantity
FROM public.batch_stock_positions p
JOIN public.inventory_batches b ON b.batch_id = p.batch_id
GROUP BY p.store_id, b.article_id
ORDER BY b.article_id, p.store_id`,
};

const str = (v) => (v == null ? "" : String(v).replace(/\s+/g, " ").trim());
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const qty = (v) => Math.round(num(v) * 1000) / 1000;
const intOrNull = (v) => (/^\d+$/.test(str(v)) ? parseInt(str(v), 10) : null);

/**
 * Which taxonomy level a row is: by the level's name (Department, Category,
 * Sub-category, Brand), else by its id (department-cpg, ...).
 */
function levelOf(row) {
  const name = str(row.level_name).toLowerCase().replace(/[\s_-]+/g, "");
  const id = str(row.level_id).toLowerCase().replace(/-[a-z0-9]+$/, "").replace(/[\s_-]+/g, "");
  const key = name || id;
  if (key === "department") return "department";
  if (key === "category") return "category";
  if (key === "subcategory") return "subcategory";
  if (key === "brand") return "brand";
  return null;
}

/**
 * The stores that get a stock column: active ones, and any other that holds
 * stock (so no stock is missing from Total). Retail stores first, then
 * warehouses, each by short name; the header is the short name.
 */
function storeColumns(stores, stockRows) {
  const withStock = new Set(stockRows.filter((r) => num(r.quantity) !== 0).map((r) => str(r.store_id)));
  const known = new Map(stores.map((s) => [str(s.slug), s]));
  const cols = stores
    .filter((s) => s.is_active === true || s.is_active === 1 || s.is_active == null || withStock.has(str(s.slug)))
    .map((s) => ({
      slug: str(s.slug),
      header: str(s.shortname) || str(s.name) || str(s.slug),
      warehouse: str(s.type).toLowerCase() === "warehouse",
    }));
  // Stock at a store masterhub does not list: still shown, under its slug.
  for (const slug of withStock) {
    if (!known.has(slug)) cols.push({ slug, header: slug, warehouse: false });
  }
  cols.sort((a, b) => Number(a.warehouse) - Number(b.warehouse) || a.header.localeCompare(b.header, "en", { numeric: true }));
  return cols;
}

/**
 * The supplier(s) shown for an article: the all-stores rule (store_id NULL)
 * when there is one, else the warehouse's, else every store's; names
 * de-duplicated, joined with ", ".
 */
function supplierNames(rows, vendorName, warehouseSlugs) {
  if (!rows || !rows.length) return "";
  const all = rows.filter((r) => r.store_id == null || str(r.store_id) === "");
  const wh = rows.filter((r) => warehouseSlugs.has(str(r.store_id)));
  const pick = all.length ? all : wh.length ? wh : rows;
  const names = [];
  for (const r of pick) {
    const name = vendorName.get(str(r.supplier_id)) || str(r.supplier_id);
    if (name && !names.includes(name)) names.push(name);
  }
  return names.join(", ");
}

/**
 * One value for an article attribute that can differ by store: the
 * article-wide value (store_id NULL) when set, else the warehouse's, else the
 * stores' when they all agree, else "mixed".
 */
function attributeValue(rows, warehouseSlugs) {
  if (!rows || !rows.length) return "";
  const general = rows.find((r) => r.store_id == null || str(r.store_id) === "");
  if (general) return str(general.attr_value);
  const wh = rows.find((r) => warehouseSlugs.has(str(r.store_id)));
  if (wh) return str(wh.attr_value);
  const values = [...new Set(rows.map((r) => str(r.attr_value)))];
  return values.length === 1 ? values[0] : "mixed";
}

const ATTRIBUTE_COLUMNS = { allow_purchase: "purchase_allowed", purchase_type: "purchase_type" };

const COLUMNS_BEFORE_STOCK = [
  { key: "article_id", header: "article_id", width: 10 },
  { key: "article_name", header: "article_name", width: 50 },
  { key: "supplier_name", header: "supplier_name", width: 36 },
  { key: "brand_name", header: "brand_name", width: 20 },
  { key: "department_name", header: "department_name", width: 22 },
  { key: "category_name", header: "category_name", width: 24 },
  { key: "subcategory_name", header: "subcategory_name", width: 26 },
  { key: "allow_purchase", header: "allow_purchase", width: 14 },
  { key: "purchase_type", header: "purchase_type", width: 14 },
  { key: "preparation_type", header: "preparation_type", width: 16 },
  { key: "repackage_conversion", header: "repackage_conversion", width: 12 },
  { key: "purchase_item", header: "purchase_item", width: 12 },
  { key: "purchase_item_name", header: "purchase_item_name", width: 40 },
  { key: "subcategory_id", header: "subcategory_id", width: 12 },
  { key: "hsn_code", header: "Hsn code", width: 12 },
  { key: "tax", header: "Tax", width: 10 },
];
const COLUMNS_AFTER_STOCK = [
  { key: "pur_uom", header: "Pur uom", width: 10 },
  { key: "supply_uom", header: "Supply uom", width: 10 },
];

/**
 * @param data { articles, taxonomy, suppliers, vendors, taxRates,
 *   preparation, stores, stock } - the query results above
 * @returns { columns: [{key, header, width}], rows: [{...}], stores, totals }
 */
function buildReport(data) {
  const articles = data.articles || [];

  const tax = new Map((data.taxRates || []).map((r) => [str(r.code), str(r.description)]));
  const taxLabel = (code) => tax.get(str(code)) || `GST ${str(code)}%`;
  const ownTax = new Map((data.articleTax || []).filter((r) => str(r.tax_code)).map((r) => [str(r.article_id), str(r.tax_code)]));
  const hsnTax = new Map(); // hsn -> [tax codes]
  for (const r of data.hsnTax || []) {
    const h = str(r.hsn_code);
    if (!h || !str(r.tax_code)) continue;
    if (!hsnTax.has(h)) hsnTax.set(h, []);
    if (!hsnTax.get(h).includes(str(r.tax_code))) hsnTax.get(h).push(str(r.tax_code));
  }
  // The article's own code; else its HSN's rate(s), several shown as "a / b".
  const taxOf = (a) => {
    const own = ownTax.get(str(a.article_id)) || str(a.tax_code);
    if (own) return taxLabel(own);
    const codes = hsnTax.get(str(a.hsn_code)) || [];
    return codes.map(taxLabel).join(" / ");
  };
  const vendorName = new Map((data.vendors || []).map((v) => [str(v.id), str(v.trade_name) || str(v.name)]));
  const articleName = new Map(articles.map((a) => [str(a.article_id), str(a.article_name)]));

  const taxonomy = new Map();
  for (const r of data.taxonomy || []) {
    const level = levelOf(r);
    if (!level) continue;
    const id = str(r.article_id);
    if (!taxonomy.has(id)) taxonomy.set(id, {});
    taxonomy.get(id)[level] = { id: intOrNull(r.hierarchy_id), name: str(r.hierarchy_name) };
  }

  const suppliersOf = new Map();
  for (const r of data.suppliers || []) {
    const id = str(r.article_id);
    if (!suppliersOf.has(id)) suppliersOf.set(id, []);
    suppliersOf.get(id).push(r);
  }

  const recipe = new Map();
  for (const r of data.preparation || []) {
    const id = str(r.prepared_item);
    if (!id || r.ingredient_item == null) continue;
    if (!recipe.has(id)) recipe.set(id, []);
    recipe.get(id).push(r);
  }

  const attributes = new Map(); // article id -> attr id -> rows
  for (const r of data.attributes || []) {
    const id = str(r.article_id);
    if (!attributes.has(id)) attributes.set(id, new Map());
    const m = attributes.get(id);
    const attr = str(r.attr_id);
    if (!m.has(attr)) m.set(attr, []);
    m.get(attr).push(r);
  }

  const stock = data.stock || [];
  const stores = storeColumns(data.stores || [], stock);
  const warehouseSlugs = new Set(stores.filter((s) => s.warehouse).map((s) => s.slug));
  const shown = new Set(stores.map((s) => s.slug));
  const stockOf = new Map();
  for (const r of stock) {
    const slug = str(r.store_id);
    if (!shown.has(slug)) continue;
    const id = str(r.article_id);
    if (!stockOf.has(id)) stockOf.set(id, new Map());
    const m = stockOf.get(id);
    m.set(slug, qty((m.get(slug) || 0) + num(r.quantity)));
  }

  const rows = articles.map((a) => {
    const id = str(a.article_id);
    const t = taxonomy.get(id) || {};
    const lines = recipe.get(id) || [];
    const row = {
      article_id: intOrNull(a.article_id) ?? id,
      article_name: str(a.article_name),
      supplier_name: supplierNames(suppliersOf.get(id), vendorName, warehouseSlugs),
      brand_name: t.brand ? t.brand.name : "",
      department_name: t.department ? t.department.name : "",
      category_name: t.category ? t.category.name : "",
      subcategory_name: t.subcategory ? t.subcategory.name : "",
      ...Object.fromEntries(
        Object.entries(ATTRIBUTE_COLUMNS).map(([col, attr]) => [col, attributeValue(attributes.get(id)?.get(attr), warehouseSlugs)])
      ),
      preparation_type: str(a.preparation_type),
      repackage_conversion: lines.length ? lines.map((l) => num(l.ingredient_measure)).join("; ") : 0,
      purchase_item: lines.length ? lines.map((l) => str(l.ingredient_item)).join("; ") : 0,
      purchase_item_name: lines.map((l) => articleName.get(str(l.ingredient_item)) || "").filter(Boolean).join("; "),
      subcategory_id: t.subcategory ? t.subcategory.id : null,
      hsn_code: str(a.hsn_code),
      tax: taxOf(a),
      pur_uom: str(a.purchase_measure),
      supply_uom: str(a.sales_measure),
    };
    // Numbers stay numbers in the sheet: a purchase item / conversion with
    // one line is written as that number, several as text "a; b".
    for (const k of ["repackage_conversion", "purchase_item"]) {
      if (typeof row[k] === "string" && /^-?\d+(\.\d+)?$/.test(row[k])) row[k] = Number(row[k]);
    }
    const s = stockOf.get(id);
    let total = 0;
    for (const st of stores) {
      const q = s ? s.get(st.slug) || 0 : 0;
      row[`stock:${st.slug}`] = q;
      total += q;
    }
    row.total = qty(total);
    return row;
  });

  const columns = [
    ...COLUMNS_BEFORE_STOCK,
    ...stores.map((s) => ({ key: `stock:${s.slug}`, header: s.header, width: 9 })),
    { key: "total", header: "Total", width: 10 },
    ...COLUMNS_AFTER_STOCK,
  ];
  return { columns, rows, stores };
}

module.exports = {
  MASTERHUB_QUERIES,
  RUNWAY_QUERIES,
  levelOf,
  storeColumns,
  supplierNames,
  attributeValue,
  buildReport,
};
