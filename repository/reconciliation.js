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
}

module.exports = (db) => {
  return new ReconciliationRepository(db);
};
