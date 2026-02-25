const logger = require("../utils/logger");

const TABLE = "medishopdb_MED_DISTRIBUTOR_MAST";

class ProductDistributorsRepository {
  constructor(db) {
    this.db = db;
  }

  getAll() {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT MDM_DIST_CODE, MDM_DIST_NAME, MDM_SHORT_NAME FROM ${TABLE} WHERE MDM_TAG = 'a' ORDER BY MDM_DIST_NAME`,
        (err, rows) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PRODUCT_DISTRIBUTORS",
              code: "REPOSITORY.PRODUCT_DISTRIBUTORS.GET_ALL",
              description: err.toString(),
              category: "",
              ref: {}
            });
            return reject(err);
          }
          resolve(rows || []);
        }
      );
    });
  }

  getByCode(MDM_DIST_CODE) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT MDM_DIST_CODE, MDM_DIST_NAME, MDM_SHORT_NAME FROM ${TABLE} WHERE MDM_DIST_CODE = ?`,
        [MDM_DIST_CODE],
        (err, rows) => {
          if (err) return reject(err);
          resolve(rows && rows[0] ? rows[0] : null);
        }
      );
    });
  }

  delete(MDM_DIST_CODE) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `DELETE FROM ${TABLE} WHERE MDM_DIST_CODE = ?`,
        [MDM_DIST_CODE],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PRODUCT_DISTRIBUTORS",
              code: "REPOSITORY.PRODUCT_DISTRIBUTORS.DELETE",
              description: err.toString(),
              category: "",
              ref: {}
            });
            return reject(err);
          }
          resolve({ code: 200, affectedRows: res.affectedRows });
        }
      );
    });
  }
}

module.exports = (db) => {
  return new ProductDistributorsRepository(db);
};
