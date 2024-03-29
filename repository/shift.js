const logger = require("../utils/logger");

class ShiftRepository {
    constructor(db) {
        this.db = db;
    }

    get() {
        return new Promise((resolve, reject) => {
            this.db.query(
                "SELECT * FROM shift_master",
                [],
                (err, docs) => {
                    if (err) {
                        logger.Log({
                            level: logger.LEVEL.ERROR,
                            component: "REPOSITORY.SHIFT",
                            code: "REPOSITORY.SHIFT.GET",
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
    updateStatus(file) {
      return new Promise((resolve, reject) => {
        this.db.query(
          "UPDATE shift_master SET status = ? WHERE shift_id = ?",
          [file.status, file.shift_id],
          (err, docs) => {
            if (err) {
              logger.Log({
                level: logger.LEVEL.ERROR,
                component: "REPOSITORY.SHIFT",
                code: "REPOSITORY.SHIFT.UPDATE-STATUS",
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
    updateShiftDetails(data, shift_id) {
      return new Promise((resolve, reject) => {
        this.db.query(
          `UPDATE shift_master SET ? WHERE shift_id = ?`,
          [data, shift_id],
          (err, res) => {
            if (err) {
                logger.Log({
                  level: logger.LEVEL.ERROR,
                  component: "REPOSITORY.SHIFT",
                  code: "REPOSITORY.SHIFT.UPDATE-SHIFT-DETAILS",
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
    getShiftById(shift_id) {
      return new Promise((resolve, reject) => {
        this.db.query("SELECT * FROM shift_master where shift_id = ?",
        [shift_id], 
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.SHIFT",
              code: "REPOSITORY.SHIFT.GET-ID",
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
    create(shift) {
        return new Promise((resolve, reject) => {
            this.db.query(
              "INSERT INTO shift_master (status, shift_name, shift_in_time, shift_out_time) VALUES (?, ?, ?, ?)",
              [
                shift.status,
                shift.shift_name,
                shift.shift_in_time,
                shift.shift_out_time,
              ],
              (err, res) => {
                if (err) {
                  if (err.code === "ER_DUP_ENTRY") {
                    resolve({ code: 101 });
                    return;
                  }
                  logger.Log({
                    level: logger.LEVEL.ERROR,
                    component: "REPOSITORY.SHIFT",
                    code: "REPOSITORY.SHIFT.CREATE",
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
    return new ShiftRepository(db);
};
