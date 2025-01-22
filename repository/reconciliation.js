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

  createOrUpdateEpayment(reconciliation) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `INSERT INTO accounts_reconciliation_epayment 
        (bill_date, store_id, card_diff, upi_diff, sodexo_diff, paytm_diff, paytm_tid, card_settled, upi_settled, sodexo_settled, paytm_settled)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
        card_diff = IF(VALUES(card_diff) IS NOT NULL, VALUES(card_diff), card_diff),
        upi_diff = IF(VALUES(upi_diff) IS NOT NULL, VALUES(upi_diff), upi_diff),
        sodexo_diff = IF(VALUES(sodexo_diff) IS NOT NULL, VALUES(sodexo_diff), sodexo_diff),
        paytm_diff = IF(VALUES(paytm_diff) IS NOT NULL, VALUES(paytm_diff), paytm_diff),
        paytm_tid = IF(VALUES(paytm_tid) IS NOT NULL, VALUES(paytm_tid), paytm_tid),
        card_settled = IF(VALUES(card_settled) IS NOT NULL, VALUES(card_settled), card_settled),
        upi_settled = IF(VALUES(upi_settled) IS NOT NULL, VALUES(upi_settled), upi_settled),
        sodexo_settled = IF(VALUES(sodexo_settled) IS NOT NULL, VALUES(sodexo_settled), sodexo_settled),
        paytm_settled = IF(VALUES(paytm_settled) IS NOT NULL, VALUES(paytm_settled), paytm_settled)`,
        [
          reconciliation.bill_date,
          reconciliation.store_id,
          reconciliation.card_diff !== undefined
            ? reconciliation.card_diff
            : null,
          reconciliation.upi_diff !== undefined
            ? reconciliation.upi_diff
            : null,
          reconciliation.sodexo_diff !== undefined
            ? reconciliation.sodexo_diff
            : null,
          reconciliation.paytm_diff !== undefined
            ? reconciliation.paytm_diff
            : null,
          reconciliation.paytm_tid,
          reconciliation.card_settled !== undefined
            ? reconciliation.card_settled
            : null,
          reconciliation.upi_settled !== undefined
            ? reconciliation.upi_settled
            : null,
          reconciliation.sodexo_settled !== undefined
            ? reconciliation.sodexo_settled
            : null,
          reconciliation.paytm_settled !== undefined
            ? reconciliation.paytm_settled
            : null,
        ],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.RECONCILIATION",
              code: "REPOSITORY.RECONCILIATION.EPAYMENT-CREATE-OR-UPDATE",
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

  getEpayment(filters = {}) {
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
         FROM accounts_reconciliation_epayment ars
         LEFT JOIN outlets o ON o.outlet_id = ars.store_id
         ${whereClause}
         ORDER BY ars.bill_date DESC`,
        filterValues,
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.RECONCILIATION",
              code: "REPOSITORY.RECONCILIATION.GET-EPAYMENT",
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
