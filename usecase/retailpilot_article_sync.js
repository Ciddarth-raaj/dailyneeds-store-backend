const logger = require("../utils/logger");
const A = require("../utils/retailpilot_articles");

/**
 * Daily pull of RetailPilot's article master into product_table and the
 * product hierarchy (RetailPilot replaces GoFrugal and Delium). New RetailPilot
 * items are created; existing ones get RetailPilot's name, preparation type,
 * manufacturer, department, category, subcategory and brand. See
 * utils/retailpilot_articles.js for how ids are chosen.
 */
class RetailPilotArticleSync {
  constructor(spectra, masterRepo) {
    this.spectra = spectra;
    this.masterRepo = masterRepo;
    this.running = false;
  }

  /**
   * @returns { code, productIdOf: Map<article id, product_id>, ...counts }
   *   productIdOf is what the stock sync keys batches on.
   */
  async run({ dryRun = false } = {}) {
    if (!this.spectra.isConfigured()) {
      return { code: 400, message: "RetailPilot is not configured (RETAILPILOT_SPECTRA_URL / RETAILPILOT_SPECTRA_KEY)" };
    }
    if (this.running) {
      return { code: 409, message: "A RetailPilot product sync is already running" };
    }
    this.running = true;
    try {
      const articles = await this.spectra.queryAll(A.buildArticleQuery());
      const taxonomyRows = await this.spectra.queryAll(A.buildTaxonomyQuery());
      if (articles.length === 0) {
        return { code: 400, message: "RetailPilot returned no articles; nothing was changed." };
      }

      const productIdOf = A.resolveProductIds(
        articles,
        await this.masterRepo.getProductIdsByArticleId(),
        await this.masterRepo.getProductIdsByLegacyCode()
      );
      const taxonomy = A.taxonomyByArticle(taxonomyRows);
      const nodes = A.collectNodes(taxonomy);

      const hierarchy = {};
      for (const level of A.LEVEL_ORDER) {
        const rows = A.hierarchyRows(level, nodes[level]);
        const local = await this.masterRepo.getLocalHierarchy(level);
        const localNames = new Map(local.map((r) => [r.id, r.name]));
        const rpIds = new Set(rows.map((r) => r.id));
        hierarchy[level] = {
          retailpilot: rows.length,
          new_rows: rows.filter((r) => !localNames.has(r.id)).length,
          renamed: rows.filter((r) => localNames.has(r.id) && localNames.get(r.id) !== r.name).length,
          stale_old_rows: local.filter((r) => !rpIds.has(r.id)).length,
          _rows: rows,
        };
      }

      const products = A.productRows(articles, productIdOf, taxonomy);
      const existing = await this.masterRepo.existingProductIds(products.map((p) => p.product_id));
      const newProducts = products.filter((p) => !existing.has(p.product_id));

      const summary = {
        articles: articles.length,
        products_existing: products.length - newProducts.length,
        products_new: newProducts.length,
        new_product_samples: newProducts.slice(0, 20).map((p) => ({ product_id: p.product_id, name: p.de_name })),
        hierarchy: Object.fromEntries(
          Object.entries(hierarchy).map(([k, v]) => [k, { retailpilot: v.retailpilot, new_rows: v.new_rows, renamed: v.renamed, stale_old_rows: v.stale_old_rows }])
        ),
      };
      if (dryRun) return { code: 200, dry_run: true, productIdOf, ...summary };

      for (const level of A.LEVEL_ORDER) {
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
    } finally {
      this.running = false;
    }
  }
}

module.exports = (spectra, masterRepo) => new RetailPilotArticleSync(spectra, masterRepo);
