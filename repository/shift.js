const logger = require("../utils/logger");

class ShiftRepository {
    constructor(db) {
        this.db = db;
    }

    get() {
        return new Promise((resolve, reject) => {
            this.db.query(
                "SELECT * FROM SHIFT_MASTER",
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
