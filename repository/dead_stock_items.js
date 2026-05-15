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
                dsi.\`type\`,
                SUM(dsi.stock) AS stock,
                SUM(dsi.stock_value) AS stock_value
         FROM \`${TABLE}\` dsi
         LEFT JOIN outlets o ON o.outlet_id = dsi.outlet_id
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
   * @param {Array<{ product_id: number, outlet_id: number, type: string, stock: number, stock_value: number }>} rows
   */
  validateProductIdsAndOutletIds(productIds, outletIds) {
    return new Promise((resolve, reject) => {
      if (!productIds.length && !outletIds.length) {
        resolve({ code: 200 });
        return;
      }
      const phP = productIds.map(() => "?").join(", ");
      const phO = outletIds.map(() => "?").join(", ");
      this.db.query(
        `SELECT product_id FROM product_table WHERE product_id IN (${phP})`,
        productIds,
        (errP, prodRows) => {
          if (errP) {
            reject(errP);
            return;
          }
          const foundP = new Set((prodRows || []).map((x) => x.product_id));
          const missingP = productIds.filter((id) => !foundP.has(id));
          if (missingP.length) {
            resolve({
              code: 400,
              msg: `Unknown product_id(s) for MID_ITEM_CODE: ${missingP.join(", ")}`,
            });
            return;
          }

          this.db.query(
            `SELECT outlet_id FROM outlets WHERE outlet_id IN (${phO})`,
            outletIds,
            (errO, outRows) => {
              if (errO) {
                reject(errO);
                return;
              }
              const foundO = new Set((outRows || []).map((x) => x.outlet_id));
              const missingO = outletIds.filter((id) => !foundO.has(id));
              if (missingO.length) {
                resolve({
                  code: 400,
                  msg: `Unknown RETAIL_OUTLET_ID(s): ${missingO.join(", ")}`,
                });
                return;
              }
              resolve({ code: 200 });
            }
          );
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
