const logger = require("../utils/logger");
const { mapWithConcurrency } = require("../utils/concurrency");

/**
 * Products per `IN (...)` chunk. Kept at or below MySQL's
 * eq_range_index_dive_limit (200 by default) so the optimizer keeps using index
 * dives to cost the range rather than falling back on index statistics.
 */
const PRODUCT_CHUNK_SIZE = 200;
/**
 * Chunks in flight at once. The main pool holds 10 connections
 * (drivers/mysql.js); leaving most of them free keeps a Purchase Ref rebuild
 * from blocking every other request.
 */
const QUERY_CONCURRENCY = 4;

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

class PurchaseRefRepository {
  constructor(db) {
    this.db = db;
  }

  /** product_id, de_name, and assigned distributor's supplier name, for the given product ids. */
  async listProductsWithSupplierByIds(productIds) {
    const unique = [...new Set((productIds || []).filter((id) => id != null))];
    if (!unique.length) return new Map();

    const chunks = chunkArray(unique, PRODUCT_CHUNK_SIZE);
    const map = new Map();

    try {
      const chunkRows = await mapWithConcurrency(
        chunks,
        QUERY_CONCURRENCY,
        (ids) =>
          this._query(
            `SELECT p.product_id,
                p.de_name,
                COALESCE(pdm.mdm_dist_name, p.de_distributor) AS supplier_name,
                (
                  SELECT pi.image_url
                  FROM product_images pi
                  WHERE pi.product_id = p.product_id
                  ORDER BY pi.priority ASC, pi.image_id ASC
                  LIMIT 1
                ) AS image_link
             FROM product_table p
             LEFT JOIN product_distributor_master pdm ON pdm.cid = p.distributor_id
             WHERE p.product_id IN (${ids.map(() => "?").join(", ")})`,
            ids
          )
      );

      chunkRows.forEach((rows) => {
        (rows || []).forEach((row) => {
          map.set(row.product_id, {
            product_id: row.product_id,
            name: row.de_name ?? null,
            supplier_name: row.supplier_name ?? null,
            image_link: row.image_link ?? null,
          });
        });
      });
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "REPOSITORY.PURCHASE_REF",
        code: "REPOSITORY.PURCHASE_REF.LIST_PRODUCTS",
        description: err.toString(),
        category: "",
        ref: {},
      });
      throw err;
    }

    return map;
  }

  _query(sql, params) {
    return new Promise((resolve, reject) => {
      this.db.query(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
  }
}

module.exports = (db) => new PurchaseRefRepository(db);
