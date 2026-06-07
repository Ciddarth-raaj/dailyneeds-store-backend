const TABLE = "dead_stock_items";

class DeadStockItemsRepository {
  constructor(db) {
    this.db = db;
  }

  /**
   * Aggregated rows: one row per (product_id, outlet_id, type) with summed stock / stock_value.
   * @returns {Promise<Array<{ product_id: number, outlet_id: number, outlet_name: string|null, type: string, stock: string, stock_value: string }>>}
   */
  listAggregatedByProductOutletType() {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT dsi.product_id,
                dsi.outlet_id,
                MAX(o.outlet_name) AS outlet_name,
                MAX(pt.de_name) AS de_name,
                MAX(pdm.mdm_dist_name) AS de_distributor,
                MAX(ne.employee_name) AS buyer_name,
                MAX(pt.department_id) AS department_id,
                MAX(d.department_name) AS department_name,
                dsi.\`type\`,
                SUM(dsi.stock) AS stock,
                SUM(dsi.stock_value) AS stock_value
         FROM \`${TABLE}\` dsi
         LEFT JOIN outlets o ON o.outlet_id = dsi.outlet_id
         LEFT JOIN product_table pt ON pt.product_id = dsi.product_id
         LEFT JOIN product_distributor_master pdm ON pt.distributor_id = pdm.cid
         LEFT JOIN product_distributor pd_map ON pd_map.cid = pt.distributor_id
         LEFT JOIN new_employee ne ON ne.employee_id = pd_map.buyer_id
         LEFT JOIN product_department d ON d.department_id = pt.department_id
         GROUP BY dsi.product_id, dsi.outlet_id, dsi.\`type\`
         ORDER BY dsi.product_id, dsi.outlet_id, dsi.\`type\``,
        (err, rows) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(rows || []);
        }
      );
    });
  }

  /**
   * Resolves which product/outlet ids exist. Missing ids are omitted (not an error).
   * @returns {Promise<{ code: 200, validProductIds: Set<number>, validOutletIds: Set<number> }>}
   */
  resolveValidProductAndOutletIds(productIds, outletIds) {
    return new Promise((resolve, reject) => {
      const validProductIds = new Set();
      const validOutletIds = new Set();

      const loadOutlets = () => {
        if (!outletIds.length) {
          resolve({ code: 200, validProductIds, validOutletIds });
          return;
        }
        const phO = outletIds.map(() => "?").join(", ");
        this.db.query(
          `SELECT outlet_id FROM outlets WHERE outlet_id IN (${phO})`,
          outletIds,
          (errO, outRows) => {
            if (errO) {
              reject(errO);
              return;
            }
            for (const x of outRows || []) {
              validOutletIds.add(x.outlet_id);
            }
            resolve({ code: 200, validProductIds, validOutletIds });
          }
        );
      };

      if (!productIds.length) {
        loadOutlets();
        return;
      }

      const phP = productIds.map(() => "?").join(", ");
      this.db.query(
        `SELECT product_id FROM product_table WHERE product_id IN (${phP})`,
        productIds,
        (errP, prodRows) => {
          if (errP) {
            reject(errP);
            return;
          }
          for (const x of prodRows || []) {
            validProductIds.add(x.product_id);
          }
          loadOutlets();
        }
      );
    });
  }

  truncateAndBulkInsert(rows) {
    return new Promise((resolve, reject) => {
      this.db.query(`TRUNCATE TABLE \`${TABLE}\``, (errTrunc) => {
        if (errTrunc) {
          reject(errTrunc);
          return;
        }
        if (!Array.isArray(rows) || rows.length === 0) {
          resolve({ code: 200, inserted: 0 });
          return;
        }

        const valueTuples = rows.map((r) => [
          r.product_id,
          r.outlet_id,
          r.type,
          r.stock,
          r.stock_value,
        ]);
        const insPh = valueTuples.map(() => "(?, ?, ?, ?, ?)").join(", ");
        const flatIns = valueTuples.flat();

        this.db.query(
          `INSERT INTO \`${TABLE}\` (product_id, outlet_id, \`type\`, stock, stock_value) VALUES ${insPh}`,
          flatIns,
          (errIns) => {
            if (errIns) {
              reject(errIns);
              return;
            }
            resolve({ code: 200, inserted: rows.length });
          }
        );
      });
    });
  }
}

module.exports = (db) => {
  return new DeadStockItemsRepository(db);
};
