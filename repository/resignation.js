const logger = require("../utils/logger");

class ResignationRepository {
  constructor(db) {
    this.db = db;
  }

  get() {
    return new Promise((resolve, reject) => {
      this.db.query(
        "SELECT * FROM resignation",
        [],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.RESIGNATION",
              code: "REPOSITORY.RESIGNATION.GET",
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
  getResignationById(resignation_id) {
    return new Promise((resolve, reject) => {
      this.db.query("SELECT * FROM resignation where resignation_id = ?",
      [resignation_id], 
      (err, docs) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.RESIGNATION",
            code: "REPOSITORY.RESIGNATION.GET-ID",
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

  updateResignationDetails(data, resignation_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `UPDATE resignation SET ? WHERE resignation_id = ?`,
        [data, resignation_id],
        (err, res) => {
          if (err) {
              logger.Log({
                level: logger.LEVEL.ERROR,
                component: "REPOSITORY.RESIGNATION",
                code: "REPOSITORY.RESIGNATION.UPDATE-RESIGNATION-DETAILS",
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
  create(resignation) {
    return new Promise((resolve, reject) => {
        this.db.query(
          "INSERT INTO resignation (employee_name, reason, resignation_date) VALUES (?, ?, ?)",
          [
            resignation.employee_name,
            resignation.reason,
            resignation.resignation_date
          ],
          (err, res) => {
            if (err) {
              if (err.code === "ER_DUP_ENTRY") {
                resolve({ code: 101 });
                return;
              }
              logger.Log({
                level: logger.LEVEL.ERROR,
                component: "REPOSITORY.RESIGNATION",
                code: "REPOSITORY.RESIGNATION.CREATE",
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
  return new ResignationRepository(db);
};
