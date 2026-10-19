const logger = require("../utils/logger");
const { LEVELS } = require("../utils/retailpilot_articles");

const CHUNK = 1000;

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Reads and writes for the RetailPilot article master sync. */
class RetailPilotMasterRepository {
  constructor(db) {
    this.db = db;
  }

  _query(sql, params = [], code = "QUERY") {
    return new Promise((resolve, reject) => {
      this.db.query(sql, params, (err, res) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.RETAILPILOT_MASTER",
            code: `REPOSITORY.RETAILPILOT_MASTER.${code}`,
            description: err.toString(),
            category: "",
            ref: {},
          });
          reject(err);
        } else resolve(res);
      });
    });
  }

  /** Map<retailpilot article id, product_id> */
  async getProductIdsByArticleId() {
    const rows = await this._query(
      `SELECT product_id, retailpilot_article_id FROM product_table WHERE retailpilot_article_id IS NOT NULL`,
      [],
      "PRODUCT_IDS"
    );
    return new Map(rows.map((r) => [Number(r.retailpilot_article_id), Number(r.product_id)]));
  }

  /** Map<old item code, product_id> */
  async getProductIdsByLegacyCode() {
    const rows = await this._query(
      `SELECT product_id, legacy_code FROM product_table WHERE legacy_code IS NOT NULL`,
      [],
      "PRODUCT_IDS_BY_LEGACY"
    );
    return new Map(rows.map((r) => [Number(r.legacy_code), Number(r.product_id)]));
  }

  /** [{ id, name }] of our table for one level. */
  async getLocalHierarchy(level) {
    const L = LEVELS[level];
    const rows = await this._query(`SELECT \`${L.id}\` AS id, \`${L.name}\` AS name FROM \`${L.table}\``, [], "LOCAL_HIERARCHY");
    return rows.map((r) => ({ id: Number(r.id), name: r.name }));
  }

  /** Upsert { id, name, parentId } rows of one level; returns affected rows. */
  async upsertHierarchy(level, rows) {
    const L = LEVELS[level];
    let affected = 0;
    for (const batch of chunk(rows, CHUNK)) {
      const cols = L.parentCol ? [L.id, L.name, L.parentCol] : [L.id, L.name];
      const updates = [`\`${L.name}\` = VALUES(\`${L.name}\`)`];
      if (L.parentCol) updates.push(`\`${L.parentCol}\` = VALUES(\`${L.parentCol}\`)`);
      const res = await this._query(
        `INSERT INTO \`${L.table}\` (${cols.map((c) => `\`${c}\``).join(", ")})
         VALUES ${batch.map(() => `(${cols.map(() => "?").join(", ")})`).join(", ")}
         ON DUPLICATE KEY UPDATE ${updates.join(", ")}`,
        batch.flatMap((r) => (L.parentCol ? [r.id, r.name, r.parentId] : [r.id, r.name])),
        "UPSERT_HIERARCHY"
      );
      affected += res.affectedRows || 0;
    }
    return affected;
  }

  /** Product ids that already exist, of the given ones. */
  async existingProductIds(ids) {
    const found = new Set();
    for (const batch of chunk(ids, CHUNK)) {
      const rows = await this._query(
        `SELECT product_id FROM product_table WHERE product_id IN (${batch.map(() => "?").join(",")})`,
        batch,
        "EXISTING_PRODUCTS"
      );
      rows.forEach((r) => found.add(Number(r.product_id)));
    }
    return found;
  }

  /**
   * Insert new products, update the RetailPilot-owned fields of existing
   * ones. A display name set here is kept; a blank one takes the article
   * name. A blank RetailPilot name, preparation type or manufacturer never
   * wipes ours; the hierarchy ids are always RetailPilot's.
   */
  async upsertProducts(rows) {
    const cols = [
      "product_id",
      "retailpilot_article_id",
      "legacy_code",
      "de_name",
      "de_display_name",
      "de_preparation_type",
      "de_manufacturer_name",
      "department_id",
      "category_id",
      "subcategory_id",
      "brand_id",
    ];
    let affected = 0;
    for (const batch of chunk(rows, CHUNK)) {
      const res = await this._query(
        `INSERT INTO product_table (${cols.join(", ")})
         VALUES ${batch.map(() => `(${cols.map(() => "?").join(", ")})`).join(", ")}
         ON DUPLICATE KEY UPDATE
           retailpilot_article_id = VALUES(retailpilot_article_id),
           legacy_code = COALESCE(legacy_code, VALUES(legacy_code)),
           de_name = COALESCE(VALUES(de_name), de_name),
           de_display_name = IF(de_display_name IS NULL OR de_display_name = '', VALUES(de_display_name), de_display_name),
           de_preparation_type = COALESCE(VALUES(de_preparation_type), de_preparation_type),
           de_manufacturer_name = COALESCE(VALUES(de_manufacturer_name), de_manufacturer_name),
           department_id = VALUES(department_id),
           category_id = VALUES(category_id),
           subcategory_id = VALUES(subcategory_id),
           brand_id = VALUES(brand_id)`,
        batch.flatMap((r) => cols.map((c) => r[c] ?? null)),
        "UPSERT_PRODUCTS"
      );
      affected += res.affectedRows || 0;
    }
    return affected;
  }
}

module.exports = (db) => new RetailPilotMasterRepository(db);
