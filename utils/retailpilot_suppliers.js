/**
 * Suppliers from RetailPilot (masterhub), replacing the old DNDS / GoFrugal
 * distributor list - product_distributor_master, which the Distributors page
 * and every screen showing a product's supplier read.
 *
 *   supplier rows  masterhub public.vendors -> product_distributor_master:
 *                  cid "RP<vendor id>", mdm_dist_code 1000000000 + vendor id
 *                  (whole number, cannot meet an old GoFrugal code),
 *                  name = trade name (else legal name), short name = legal
 *                  name, mdm_tag 'a' active / 'i' inactive. Buyer and
 *                  holding days are DNDS's own and are never overwritten.
 *   product supplier  derived.article_store_suppliers -> product_table
 *                  .distributor_id, for products linked to a RetailPilot
 *                  article: the all-stores supplier, else the warehouse's,
 *                  else any store's (lowest vendor id). None: blank.
 *
 * Old suppliers (not from RetailPilot) are deleted - unless an advance
 * request, credit purchase or LR follow-up refers to them: those are kept,
 * tagged 'old', and hidden from lists and pickers, so history keeps its names.
 */

const RP_CID_PREFIX = "RP";
const RP_CODE_BASE = 1000000000;
const OLD_TAG = "old";

const QUERIES = {
  vendors: `
SELECT v.id, v.name, v.trade_name, v.is_active
FROM public.vendors v
ORDER BY v.id`,
  articleSuppliers: `
SELECT s.article_id, s.store_id, s.supplier_id
FROM derived.article_store_suppliers s
ORDER BY s.article_id, s.store_id, s.supplier_id`,
  stores: `
SELECT s.slug, s.type
FROM public.stores s
ORDER BY s.slug`,
};

const str = (v) => (v == null ? "" : String(v).replace(/\s+/g, " ").trim());

const isRpCid = (cid) => str(cid).startsWith(RP_CID_PREFIX);
const cidOf = (vendorId) => `${RP_CID_PREFIX}${str(vendorId)}`;

/** Supplier rows for product_distributor_master; vendors without a numeric id are reported, not guessed. */
function supplierRows(vendors) {
  const rows = [];
  const skipped = [];
  for (const v of vendors || []) {
    const id = str(v.id);
    if (!/^\d{1,9}$/.test(id)) {
      skipped.push({ id, reason: "vendor id is not a number" });
      continue;
    }
    const legal = str(v.name);
    rows.push({
      cid: cidOf(id),
      mdm_dist_code: RP_CODE_BASE + Number(id),
      mdm_dist_name: (str(v.trade_name) || legal).slice(0, 255),
      mdm_short_name: legal.slice(0, 255) || null,
      mdm_tag: v.is_active === false || v.is_active === 0 ? "i" : "a",
    });
  }
  return { rows, skipped };
}

/**
 * Map<article id, supplier cid> from derived.article_store_suppliers: the
 * all-stores rule (store_id NULL), else the warehouse's, else any store's;
 * among several, the lowest vendor id, so the choice is stable day to day.
 */
function supplierByArticle(articleSuppliers, stores, knownCids) {
  const warehouses = new Set((stores || []).filter((s) => str(s.type).toLowerCase() === "warehouse").map((s) => str(s.slug)));
  const byArticle = new Map();
  for (const r of articleSuppliers || []) {
    const a = str(r.article_id);
    if (!a) continue;
    if (!byArticle.has(a)) byArticle.set(a, []);
    byArticle.get(a).push(r);
  }
  const lowest = (rows) =>
    rows
      .map((r) => str(r.supplier_id))
      .filter((id) => knownCids.has(cidOf(id)))
      .sort((x, y) => Number(x) - Number(y) || x.localeCompare(y))[0];
  const out = new Map();
  for (const [a, rows] of byArticle) {
    const all = rows.filter((r) => r.store_id == null || str(r.store_id) === "");
    const wh = rows.filter((r) => warehouses.has(str(r.store_id)));
    const id = lowest(all) || lowest(wh) || lowest(rows);
    if (id) out.set(a, cidOf(id));
  }
  return out;
}

/**
 * Refuse a pull that would wipe the list: no vendors at all, or fewer than
 * half of the RetailPilot suppliers DNDS already has.
 */
function guard(newCount, existingRpCount) {
  if (newCount === 0) return "RetailPilot returned no suppliers - nothing changed";
  if (existingRpCount > 0 && newCount < existingRpCount / 2) {
    return `RetailPilot returned ${newCount} suppliers, fewer than half of the ${existingRpCount} DNDS has - nothing changed`;
  }
  return null;
}

module.exports = {
  RP_CID_PREFIX,
  RP_CODE_BASE,
  OLD_TAG,
  QUERIES,
  isRpCid,
  cidOf,
  supplierRows,
  supplierByArticle,
  guard,
};
