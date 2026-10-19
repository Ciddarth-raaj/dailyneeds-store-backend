/**
 * RetailPilot article master -> product_table and the product hierarchy
 * tables (product_department, categories, subcategories, brands).
 *
 * Item code: product_id is RetailPilot's article id. An article that is
 * already here keeps its product (found by product_table.retailpilot_article_id,
 * else by its old code, masterhub.articles.external_id = legacy_code); a new
 * one gets its article id. The old code is only ever stored, in legacy_code,
 * never used as an id. Old codes run 2-52,018 and RetailPilot ids start at
 * 100,001, so the two never meet.
 *
 * Hierarchy: RetailPilot's departments, categories, subcategories and
 * brands are written into our hierarchy tables under RetailPilot's own ids
 * (an existing row with the same id is renamed), and every product points
 * at them. Old rows RetailPilot does not have are left for now and reported
 * (stale_old_rows) so they can be cleaned up once nothing needs them.
 */

const LEVELS = {
  department: { rp: "department-cpg", table: "product_department", id: "department_id", name: "department_name", parent: null },
  category: { rp: "category-cpg", table: "categories", id: "category_id", name: "category_name", parent: "department", parentCol: "department_id" },
  subcategory: { rp: "subcategory-cpg", table: "subcategories", id: "subcategory_id", name: "subcategory_name", parent: "category", parentCol: "category_id" },
  brand: { rp: "brand-cpg", table: "brands", id: "brand_id", name: "brand_name", parent: "category", parentCol: "category_id" },
};
// Parents before children, so a child's parent id is known when it is written.
const LEVEL_ORDER = ["department", "category", "subcategory", "brand"];
const MANUFACTURER_LEVEL = "manufacturer-cpg";

function buildArticleQuery() {
  return `
SELECT slug AS article_id, external_id, article_name, preparation_type
FROM masterhub.articles
ORDER BY slug
`;
}

function buildTaxonomyQuery() {
  return `
SELECT t.article_id, t.level_id, t.hierarchy_id, h.hierarchy_name
FROM masterhub.article_taxonomy t
JOIN masterhub.hierarchy_master h ON h.hierarchy_id = t.hierarchy_id AND h.level_id = t.level_id
ORDER BY t.article_id, t.level_id
`;
}

function toInt(v) {
  const s = v == null ? "" : String(v).trim();
  return /^\d+$/.test(s) ? parseInt(s, 10) : null;
}

const cleanName = (v) => (v == null ? "" : String(v).replace(/\s+/g, " ").trim());
const nameKey = (v) => cleanName(v).toLowerCase();

/**
 * @param articles rows of buildArticleQuery
 * @param existingByArticleId Map<retailpilot article id, product_id> from product_table
 * @param existingByLegacyCode Map<old item code, product_id> from product_table
 * @returns Map<article id, product_id>
 */
function resolveProductIds(articles, existingByArticleId, existingByLegacyCode = new Map()) {
  const ids = new Map();
  for (const a of articles) {
    const articleId = toInt(a.article_id);
    if (articleId == null) continue;
    const legacy = toInt(a.external_id);
    ids.set(
      articleId,
      existingByArticleId.get(articleId) ?? (legacy != null ? existingByLegacyCode.get(legacy) : undefined) ?? articleId
    );
  }
  return ids;
}

/**
 * Per article: { department, category, subcategory, brand, manufacturer } as
 * { id, name } of RetailPilot nodes.
 */
function taxonomyByArticle(taxonomyRows) {
  const byLevelId = Object.fromEntries(Object.entries(LEVELS).map(([k, v]) => [v.rp, k]));
  const out = new Map();
  for (const r of taxonomyRows) {
    const articleId = toInt(r.article_id);
    if (articleId == null) continue;
    const level = r.level_id === MANUFACTURER_LEVEL ? "manufacturer" : byLevelId[r.level_id];
    if (!level) continue;
    if (!out.has(articleId)) out.set(articleId, {});
    out.get(articleId)[level] = { id: toInt(r.hierarchy_id), name: cleanName(r.hierarchy_name) };
  }
  return out;
}

/**
 * The RetailPilot nodes of each level, each with its name and the parent
 * node most of its articles sit under (RetailPilot keeps no parent link).
 * @returns { [level]: Map<rp id, { name, parentRpId }> }
 */
function collectNodes(taxonomy) {
  const nodes = {};
  const parentVotes = {};
  for (const level of LEVEL_ORDER) {
    nodes[level] = new Map();
    parentVotes[level] = new Map();
  }
  for (const t of taxonomy.values()) {
    for (const level of LEVEL_ORDER) {
      const node = t[level];
      if (!node || node.id == null || !node.name) continue;
      if (!nodes[level].has(node.id)) nodes[level].set(node.id, { name: node.name, parentRpId: null });
      const parentLevel = LEVELS[level].parent;
      const parent = parentLevel && t[parentLevel];
      if (parent && parent.id != null) {
        const votes = parentVotes[level].get(node.id) || new Map();
        votes.set(parent.id, (votes.get(parent.id) || 0) + 1);
        parentVotes[level].set(node.id, votes);
      }
    }
  }
  for (const level of LEVEL_ORDER) {
    for (const [id, votes] of parentVotes[level]) {
      let best = null;
      let bestCount = -1;
      for (const [pid, n] of votes) {
        if (n > bestCount || (n === bestCount && pid < best)) {
          best = pid;
          bestCount = n;
        }
      }
      nodes[level].get(id).parentRpId = best;
    }
  }
  return nodes;
}

/**
 * Hierarchy rows to upsert for one level: { id, name, parentId }, all
 * RetailPilot ids. A node with no parent takes 0, the value the NOT NULL
 * parent columns take when unknown.
 */
function hierarchyRows(level, rpNodes) {
  const rows = [];
  for (const [rpId, node] of rpNodes) {
    rows.push({
      id: rpId,
      name: node.name.slice(0, 255),
      parentId: LEVELS[level].parent ? (node.parentRpId ?? 0) : null,
    });
  }
  return rows;
}

/**
 * product_table rows: the fields RetailPilot owns. Distributor, buyer,
 * pack sizes (purchase_uom / store_uom) and the rest are not in
 * RetailPilot and are left as they are.
 */
function productRows(articles, productIdOf, taxonomy) {
  const rows = [];
  for (const a of articles) {
    const articleId = toInt(a.article_id);
    if (articleId == null) continue;
    const t = taxonomy.get(articleId) || {};
    const local = (level) => (t[level] && t[level].id != null ? t[level].id : null);
    const name = cleanName(a.article_name);
    rows.push({
      product_id: productIdOf.get(articleId),
      retailpilot_article_id: articleId,
      legacy_code: toInt(a.external_id),
      de_name: name ? name.slice(0, 500) : null,
      de_display_name: name ? name.slice(0, 255) : null,
      de_preparation_type: a.preparation_type ? String(a.preparation_type).slice(0, 200) : null,
      de_manufacturer_name: t.manufacturer && t.manufacturer.name ? t.manufacturer.name.slice(0, 255) : null,
      department_id: local("department"),
      category_id: local("category"),
      subcategory_id: local("subcategory"),
      brand_id: local("brand"),
    });
  }
  return rows;
}

module.exports = {
  LEVELS,
  LEVEL_ORDER,
  buildArticleQuery,
  buildTaxonomyQuery,
  resolveProductIds,
  taxonomyByArticle,
  collectNodes,
  hierarchyRows,
  productRows,
};
