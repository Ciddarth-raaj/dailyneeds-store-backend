const logger = require("../utils/logger");

class StoreRepository {
  constructor(db) {
    this.db = db;
  }

  get() {
    return new Promise((resolve, reject) => {
      this.db.query("SELECT * FROM store", [], (err, docs) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.STORE",
            code: "REPOSITORY.STORE.GET",
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
  getStoreById(store_id) {
    return new Promise((resolve, reject) => {
      this.db.query("SELECT * FROM store WHERE store_id = ?",
        [store_id],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.STORE",
              code: "REPOSITORY.STORE.GET-BY-ID",
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
}

module.exports = (db) => {
  return new StoreRepository(db);
};
