const logger = require("../utils/logger");
const A = require("../utils/retailpilot_articles");

/**
 * Daily pull of RetailPilot's article master into product_table and the
 * product hierarchy (replaces the Delium product sync). New RetailPilot items
 * are created; existing ones get RetailPilot's name, preparation type,
 * manufacturer, department, category, subcategory and brand. See
 * utils/retailpilot_articles.js for how ids are chosen.
 */
class RetailPilotArticleSync {
  constructor(spectra, masterRepo) {
    this.spectra = spectra;
    this.masterRepo = masterRepo;
  }

  /**
   * @returns { code, productIdOf: Map<article id, product_id>, ...counts }
   *   productIdOf is what the stock sync keys batches on.
   */
  async run({ dryRun = false } = {}) {
    try {
      const articles = await this.spectra.queryAll(A.buildArticleQuery());
      const taxonomyRows = await this.spectra.queryAll(A.buildTaxonomyQuery());
      if (articles.length === 0) {
        return { code: 400, message: "RetailPilot returned no articles; nothing was changed." };
      }

      const productIdOf = A.resolveProductIds(articles, await this.masterRepo.getProductIdsByArticleId());
      const taxonomy = A.taxonomyByArticle(taxonomyRows);
      const nodes = A.collectNodes(taxonomy);

      const localIds = {};
      const hierarchy = {};
      for (const level of A.LEVEL_ORDER) {
        const mapped = await this.masterRepo.getHierarchyMap(level);
        const local = await this.masterRepo.getLocalHierarchy(level);
        const { localIdOf, newMappings } = A.mapLevel(nodes[level], local, mapped);
        localIds[level] = localIdOf;
        const parent = A.LEVELS[level].parent;
        const rows = A.hierarchyRows(level, nodes[level], localIdOf, parent ? localIds[parent] : new Map());
        const localSet = new Set(local.map((r) => r.id));
        hierarchy[level] = {
          retailpilot: nodes[level].size,
          new_rows: rows.filter((r) => !localSet.has(r.id)).length,
          matched_by_name: newMappings.filter((m) => localSet.has(m.local_id)).length,
          _rows: rows,
          _newMappings: newMappings,
        };
      }

      const products = A.productRows(articles, productIdOf, taxonomy, localIds);
      const existing = await this.masterRepo.existingProductIds(products.map((p) => p.product_id));
      const newProducts = products.filter((p) => !existing.has(p.product_id));

      const summary = {
        articles: articles.length,
        products_existing: products.length - newProducts.length,
        products_new: newProducts.length,
        new_product_samples: newProducts.slice(0, 20).map((p) => ({ product_id: p.product_id, name: p.de_name })),
        hierarchy: Object.fromEntries(
          Object.entries(hierarchy).map(([k, v]) => [k, { retailpilot: v.retailpilot, new_rows: v.new_rows, matched_by_name: v.matched_by_name }])
        ),
      };
      if (dryRun) return { code: 200, dry_run: true, productIdOf, ...summary };

      for (const level of A.LEVEL_ORDER) {
        await this.masterRepo.saveHierarchyMappings(level, hierarchy[level]._newMappings);
        await this.masterRepo.upsertHierarchy(level, hierarchy[level]._rows);
      }
      await this.masterRepo.upsertProducts(products);

      return { code: 200, productIdOf, ...summary };
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.RETAILPILOT_ARTICLE_SYNC",
        code: "USECASE.RETAILPILOT_ARTICLE_SYNC.RUN",
        description: err.toString(),
        category: "",
        ref: { dryRun },
      });
      throw err;
    }
  }
}

module.exports = (spectra, masterRepo) => new RetailPilotArticleSync(spectra, masterRepo);
