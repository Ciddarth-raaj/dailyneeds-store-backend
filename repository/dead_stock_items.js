const TABLE = "dead_stock_items";

const ENRICH_SNAPSHOT_SQL = `UPDATE dead_stock_items dsi
INNER JOIN product_table pt ON dsi.product_id = pt.product_id
LEFT JOIN outlets o ON dsi.outlet_id = o.outlet_id
LEFT JOIN product_distributor_master pdm ON pt.distributor_id = pdm.cid
LEFT JOIN product_distributor pd_map ON pd_map.cid = pt.distributor_id
LEFT JOIN new_employee ne ON ne.employee_id = pd_map.buyer_id
LEFT JOIN product_department d ON pt.department_id = d.department_id
LEFT JOIN categories cat ON pt.category_id = cat.category_id
LEFT JOIN subcategories sub ON pt.subcategory_id = sub.category_id
SET
  dsi.de_name = pt.de_name,
  dsi.de_distributor = COALESCE(pdm.mdm_dist_name, pt.de_distributor),
  dsi.buyer_name = ne.employee_name,
  dsi.outlet_name = o.outlet_name,
  dsi.department_id = pt.department_id,
  dsi.department_name = d.department_name,
  dsi.category_id = pt.category_id,
  dsi.category_name = cat.category_name,
  dsi.subcategory_id = pt.subcategory_id,
  dsi.subcategory_name = sub.subcategory_name`;

const LIST_PIVOTED_SQL = `SELECT dsi.product_id,
                dsi.outlet_id,
                MAX(dsi.outlet_name) AS outlet_name,
                MAX(dsi.de_name) AS de_name,
                MAX(dsi.de_distributor) AS de_distributor,
                MAX(dsi.buyer_name) AS buyer_name,
                MAX(dsi.department_id) AS department_id,
                MAX(dsi.department_name) AS department_name,
                MAX(dsi.category_id) AS category_id,
                MAX(dsi.category_name) AS category_name,
                MAX(dsi.subcategory_id) AS subcategory_id,
                MAX(dsi.subcategory_name) AS subcategory_name,
                SUM(CASE WHEN dsi.\`type\` = 'thirty-days' THEN dsi.stock ELSE 0 END) AS thirty_days_stock,
                SUM(CASE WHEN dsi.\`type\` = 'thirty-days' THEN dsi.stock_value ELSE 0 END) AS thirty_days_stock_value,
                SUM(CASE WHEN dsi.\`type\` = 'ninety-days' THEN dsi.stock ELSE 0 END) AS ninety_days_stock,
                SUM(CASE WHEN dsi.\`type\` = 'ninety-days' THEN dsi.stock_value ELSE 0 END) AS ninety_days_stock_value,
                SUM(CASE WHEN dsi.\`type\` = 'one-twenty-days' THEN dsi.stock ELSE 0 END) AS one_twenty_days_stock,
                SUM(CASE WHEN dsi.\`type\` = 'one-twenty-days' THEN dsi.stock_value ELSE 0 END) AS one_twenty_days_stock_value,
                SUM(CASE WHEN dsi.\`type\` = 'more-than-one-twenty-days' THEN dsi.stock ELSE 0 END) AS more_thanone_twenty_days_stock,
                SUM(CASE WHEN dsi.\`type\` = 'more-than-one-twenty-days' THEN dsi.stock_value ELSE 0 END) AS more_thanone_twenty_days_stock_value
         FROM \`${TABLE}\` dsi
         GROUP BY dsi.product_id, dsi.outlet_id`;

class DeadStockItemsRepository {
  constructor(db) {
    this.db = db;
  }

  enrichSnapshots() {
    return new Promise((resolve, reject) => {
      this.db.query(ENRICH_SNAPSHOT_SQL, [], (err, result) => {
        if (err) reject(err);
        else resolve(result);
      });
    });
  }

  listPivotedForClient() {
    return new Promise((resolve, reject) => {
      this.db.query(LIST_PIVOTED_SQL, [], (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
  }

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
            this.enrichSnapshots()
              .then(() => resolve({ code: 200, inserted: rows.length }))
              .catch(reject);
          }
        );
      });
    });
  }
}

module.exports = (db) => {
  return new DeadStockItemsRepository(db);
};
