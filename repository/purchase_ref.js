const logger = require("../utils/logger");

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
  listProductsWithSupplierByIds(productIds) {
    return new Promise((resolve, reject) => {
      const unique = [...new Set((productIds || []).filter((id) => id != null))];
      if (!unique.length) {
        resolve(new Map());
        return;
      }
      const chunks = chunkArray(unique, 200);
      const map = new Map();
      let pending = chunks.length;
      chunks.forEach((ids) => {
        const ph = ids.map(() => "?").join(", ");
        this.db.query(
          `SELECT p.product_id,
              p.de_name,
              COALESCE(pdm.mdm_dist_name, p.de_distributor) AS supplier_name
           FROM product_table p
           LEFT JOIN product_distributor_master pdm ON pdm.cid = p.distributor_id
           WHERE p.product_id IN (${ph})`,
          ids,
          (err, rows) => {
            if (err) {
              logger.Log({
                level: logger.LEVEL.ERROR,
                component: "REPOSITORY.PURCHASE_REF",
                code: "REPOSITORY.PURCHASE_REF.LIST_PRODUCTS",
                description: err.toString(),
                category: "",
                ref: {},
              });
              return reject(err);
            }
            (rows || []).forEach((row) => {
              map.set(row.product_id, {
                product_id: row.product_id,
                name: row.de_name ?? null,
                supplier_name: row.supplier_name ?? null,
              });
            });
            pending -= 1;
            if (pending === 0) {
              resolve(map);
            }
          }
        );
      });
    });
  }
}

module.exports = (db) => new PurchaseRefRepository(db);
