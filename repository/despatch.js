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
  getIndentsByDespatch(despatch_id) {
    return new Promise((resolve, reject) => {
      this.db.query("SELECT indent_id FROM despatch where despatch_id = ?",
      [despatch_id], 
      (err, docs) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.DESPATCH",
            code: "REPOSITORY.DESPATCH.GET-DESPATCH-BY-ID",
            description: err.toString(),
            category: "",
            ref: {},
          });
          reject(err);
          return;
        }
        resolve(docs[0].indent_id);
      });
    });
  }
  getDespatchByStoreId(store_id) {
    return new Promise((resolve, reject) => {
      this.db.query("SELECT * FROM despatch where store_id = ?",
      [store_id], 
      (err, docs) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.STORE",
            code: "REPOSITORY.STORE.GET-STORE-BY-ID",
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
