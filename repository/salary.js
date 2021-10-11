const logger = require("../utils/logger");

class SalaryRepository {
  constructor(db) {
    this.db = db;
  }

  get() {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT payment_det.payment_id, payment_det.employee, payment_det.loan_amount, payment_det.installment_duration, payment_det.status, payment_det.paid_status, payment_det.created_at, new_employee.store_id FROM payment_det
        LEFT JOIN new_employee ON new_employee.employee_name = payment_det.employee`,
        [],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.SALARY",
              code: "REPOSITORY.SALARY.GET",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve(docs)
        }
      );
    });
  }
  getSalaryById(payment_id) {
    return new Promise((resolve, reject) => {
      this.db.query("SELECT * FROM payment_det WHERE payment_id = ?",
      [payment_id], 
      (err, docs) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.SALARY",
            code: "REPOSITORY.SALARY.GET-ID",
            description: err.toString(),
            category: "",
            ref: {},
          });
          reject(err);
          return;
        }
        resolve(docs);
      });
    });
  }
  updateStatus(file) {
    return new Promise((resolve, reject) => {
      this.db.query(
        "UPDATE payment_det SET status = ? WHERE payment_id = ?",
        [file.status, file.payment_id],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.SALARY",
              code: "REPOSITORY.SALARY.UPDATE-STATUS",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve(docs);
        });
    });
  }
  updatePaidStatus(file) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `UPDATE payment_det SET paid_status = ? WHERE payment_id = ?`,
        [file.paid_status, file.payment_id],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.SALARY",
              code: "REPOSITORY.SALARY.UPDATE-PAID-STATUS",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            console.log(err);
            return;
          }
          console.log(docs);
          resolve(docs);
        });
    });
  }
  updateSalaryDetails(data, payment_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `UPDATE payment_det SET ? WHERE payment_id = ?`,
        [data, payment_id],
        (err, res) => {
          if (err) {
              logger.Log({
                level: logger.LEVEL.ERROR,
                component: "REPOSITORY.SALARY",
                code: "REPOSITORY.SALARY.UPDATE-SALARY-DETAILS",
                description: err.toString(),
                category: "",
                ref: {},
              });
            reject(err);
            return;
          }
          resolve({ code: 200 });
        }
      );
    });
  }
  create(salary) {
    return new Promise((resolve, reject) => {
        this.db.query(
          "INSERT INTO payment_det (employee, loan_amount, installment_duration, status) VALUES (?, ?, ?, ?)",
          [
            salary.employee,
            salary.loan_amount,
            salary.installment_duration,
            salary.status,
          ],
          (err, res) => {
            if (err) {
              if (err.code === "ER_DUP_ENTRY") {
                resolve({ code: 101 });
                return;
              }
              logger.Log({
                level: logger.LEVEL.ERROR,
                component: "REPOSITORY.SALARY",
                code: "REPOSITORY.SALARY.CREATE",
                description: err.toString(),
                category: "",
                ref: {},
              });
              reject(err);
              return;
            }
            resolve({ code: 200, id: res.insertId });
          }
        );
      });
    }
}

module.exports = (db) => {
  return new SalaryRepository(db);
};
