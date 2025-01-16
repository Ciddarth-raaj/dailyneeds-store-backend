const logger = require("../utils/logger");

class ReconciliationRepository {
  constructor(db) {
    this.db = db;
  }

  createOrUpdateSales(reconciliation) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `INSERT INTO accounts_reconciliation_sales 
        (bill_date, store_id, loyalty_diff, sales_diff, return_diff)
        VALUES (?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
        loyalty_diff = VALUES(loyalty_diff),
        sales_diff = VALUES(sales_diff),
        return_diff = VALUES(return_diff)`,
        [
          reconciliation.bill_date,
          reconciliation.store_id,
          reconciliation.loyalty_diff,
          reconciliation.sales_diff,
          reconciliation.return_diff,
        ],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.RECONCILIATION",
              code: "REPOSITORY.RECONCILIATION.CREATE-OR-UPDATE",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve({
            code: 200,
            id: res.insertId,
            inserted: res.affectedRows - res.changedRows,
            updated: res.changedRows,
          });
        }
      );
    });
  }

  getSales(filters = {}) {
    return new Promise((resolve, reject) => {
      let filterConditions = [];
      let filterValues = [];

      if (filters.from_date) {
        filterConditions.push("DATE(bill_date) >= ?");
        filterValues.push(filters.from_date);
      }
      if (filters.to_date) {
        filterConditions.push("DATE(bill_date) <= ?");
        filterValues.push(filters.to_date);
      }
      if (filters.store_id) {
        filterConditions.push("store_id = ?");
        filterValues.push(filters.store_id);
      }

      const whereClause =
        filterConditions.length > 0
          ? `WHERE ${filterConditions.join(" AND ")}`
          : "";

      this.db.query(
        `SELECT ars.*, o.outlet_name 
         FROM accounts_reconciliation_sales ars
         LEFT JOIN outlets o ON o.outlet_id = ars.store_id
         ${whereClause}
         ORDER BY ars.bill_date DESC`,
        filterValues,
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.RECONCILIATION",
              code: "REPOSITORY.RECONCILIATION.GET-SALES",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }

          // Format dates and add outlet name
          const formattedDocs = docs.map((doc) => ({
            ...doc,
            bill_date: doc.bill_date,
            outlet_name: doc.outlet_name || "",
          }));

          resolve({
            code: 200,
            data: formattedDocs,
          });
        }
      );
    });
  }
}

module.exports = (db) => {
  return new ReconciliationRepository(db);
};
