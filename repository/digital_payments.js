const logger = require("../utils/logger");

class DigitalPaymentsRepository {
  constructor(db) {
    this.db = db;
  }

  create(payment) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `INSERT INTO digital_payments 
        (store_id, bank_mid, bank_tid, api_key, payment_mid, payment_tid, 
         paytm_aggregator_id, pluxe_outlet_id, s_no)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          payment.store_id,
          payment.bank_mid,
          payment.bank_tid,
          payment.api_key,
          payment.payment_mid,
          payment.payment_tid,
          payment.paytm_aggregator_id,
          payment.pluxe_outlet_id,
          payment.s_no,
        ],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.DIGITAL_PAYMENTS",
              code: "REPOSITORY.DIGITAL_PAYMENTS.CREATE",
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
          });
        }
      );
    });
  }

  getAll(filters = {}) {
    return new Promise((resolve, reject) => {
      let filterConditions = [];
      let filterValues = [];

      if (filters.store_id) {
        filterConditions.push("dp.store_id = ?");
        filterValues.push(filters.store_id);
      }

      const whereClause =
        filterConditions.length > 0
          ? `WHERE ${filterConditions.join(" AND ")}`
          : "";

      this.db.query(
        `SELECT dp.*, o.outlet_name 
         FROM digital_payments dp
         LEFT JOIN outlets o ON o.outlet_id = dp.store_id
         ${whereClause}
         ORDER BY dp.created_at DESC`,
        filterValues,
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.DIGITAL_PAYMENTS",
              code: "REPOSITORY.DIGITAL_PAYMENTS.GET-ALL",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }

          resolve({
            code: 200,
            data: docs,
          });
        }
      );
    });
  }

  getById(paymentId) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT dp.*, o.outlet_name 
         FROM digital_payments dp
         LEFT JOIN outlets o ON o.outlet_id = dp.store_id
         WHERE dp.digital_payment_id = ?`,
        [paymentId],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.DIGITAL_PAYMENTS",
              code: "REPOSITORY.DIGITAL_PAYMENTS.GET-BY-ID",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }

          if (docs.length === 0) {
            resolve({ code: 404, message: "Digital payment not found" });
            return;
          }

          resolve({
            code: 200,
            data: docs[0],
          });
        }
      );
    });
  }

  update(payment) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `UPDATE digital_payments 
         SET bank_mid = ?, 
             bank_tid = ?, 
             api_key = ?, 
             payment_mid = ?, 
             payment_tid = ?, 
             paytm_aggregator_id = ?, 
             pluxe_outlet_id = ?, 
             s_no = ?
         WHERE digital_payment_id = ?`,
        [
          payment.bank_mid,
          payment.bank_tid,
          payment.api_key,
          payment.payment_mid,
          payment.payment_tid,
          payment.paytm_aggregator_id,
          payment.pluxe_outlet_id,
          payment.s_no,
          payment.payment_id,
        ],
        (err, result) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.DIGITAL_PAYMENTS",
              code: "REPOSITORY.DIGITAL_PAYMENTS.UPDATE",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }

          if (result.affectedRows === 0) {
            resolve({ code: 404, message: "Digital payment not found" });
            return;
          }

          resolve({ code: 200 });
        }
      );
    });
  }
}

module.exports = (db) => {
  return new DigitalPaymentsRepository(db);
};
