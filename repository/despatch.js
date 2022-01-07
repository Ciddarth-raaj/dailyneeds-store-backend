const logger = require("../utils/logger");

class DespatchRepository {
  constructor(db) {
    this.db = db;
  }

  createDespatch(despatch) {
    return new Promise((resolve, reject) => {
      this.db.query(
        "INSERT INTO despatch ( store_id, store_to, vehicle, driver, indent_id ) VALUES ( ?, ?, ?, ?, ? )",
        [
            despatch.store_id,
            despatch.store_to,
            despatch.vehicle,
            despatch.driver,
            despatch.indent_id,
        ],
        (err, res) => {
          if (err) {
            if (err.code === "ER_DUP_ENTRY") {
              resolve({ code: 101 });
              return;
            }
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.DESPATCH",
              code: "REPOSITORY.DESPATCH.CREATE",
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
  get() {
    return new Promise((resolve, reject) => {
      this.db.query(
        "SELECT * FROM despatch",
        [],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.DESPATCH",
              code: "REPOSITORY.DESPATCH.GET",
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
}

module.exports = (db) => {
  return new DespatchRepository(db);
};
