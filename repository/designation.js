const logger = require("../utils/logger");

class DesignationRepository {
  constructor(db) {
    this.db = db;
  }

  get() {
    return new Promise((resolve, reject) => {
      this.db.query("SELECT * FROM designation", [], (err, docs) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.DESIGNATION",
            code: "REPOSITORY.DESIGNATION.GET",
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

  create(designation) {
    return new Promise((resolve, reject) => {
      this.db.query(
        "INSERT INTO designation (status, designation_name, online_portal) VALUES (?, ?, ?)",
        [
          designation.status,
          designation.designation_name,
          designation.online_portal,
        ],
        (err, res) => {
          if (err) {
            if (err.code === "ER_DUP_ENTRY") {
              resolve({ code: 101 });
              return;
            }
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.DESIGNATION",
              code: "REPOSITORY.DESIGNATION.CREATE",
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

  createPermission(permission_key, designation_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        "INSERT INTO permissions (permission_key, designation_id) VALUES (?, ?)",
        [permission_key, designation_id],
        (err, res) => {
          if (err) {
            if (err.code === "ER_DUP_ENTRY") {
              resolve({ code: 101 });
              return;
            }
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.DESIGNATION",
              code: "REPOSITORY.DESIGNATION.CREATE-PERMISSIONS",
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
  return new DesignationRepository(db);
};
