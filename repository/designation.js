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
  getDesignationByBudget() {
    return new Promise((resolve, reject) => {
      this.db.query("select designation.designation_id, designation.designation_name, budget.budget_id, budget.budget from designation LEFT JOIN budget ON budget.designation_name = designation.designation_name", [], (err, docs) => {
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
  getPermissions() {
    return new Promise((resolve, reject) => {
      this.db.query("SELECT * FROM all_permissions", [], (err, docs) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.DESIGNATION",
            code: "REPOSITORY.DESIGNATION.GET-PERMISSION",
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
        "UPDATE designation SET status = ? WHERE designation_id = ?",
        [file.status, file.designation_id],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.DESIGNATION",
              code: "REPOSITORY.DESIGNATION.UPDATE-STATUS",
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
  getById(designation_id) {
    return new Promise((resolve, reject) => {
      this.db.query("SELECT * FROM designation where designation_id = ?",
      [designation_id], 
      (err, docs) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.DESIGNATION",
            code: "REPOSITORY.DESIGNATION.GET-ID",
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
  getAllPermissions() {
    return new Promise((resolve, reject) => {
      this.db.query("SELECT * FROM all_permissions",
      [], 
      (err, docs) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.DESIGNATION",
            code: "REPOSITORY.DESIGNATION.GET-ALL-PERMISSONS",
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
  getQuery(user_type) {
    if(user_type === 2) {
      return `SELECT * FROM all_permissions`
    }
    if(user_type === 1) {
      return `SELECT permission_key FROM permissions WHERE designation_id = ?`
    }
  }
  getPermissionById(designation_id, user_type) {
    return new Promise((resolve, reject) => {
      this.db.query(
        this.getQuery(user_type),
      [designation_id], 
      (err, docs) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.DESIGNATION",
            code: "REPOSITORY.DESIGNATION.GET-PERMISSION-BY-ID",
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
  updateDesignationDetails(data, designation_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `UPDATE designation SET ? WHERE designation_id = ?`,
        [data, designation_id],
        (err, res) => {
          if (err) {
              logger.Log({
                level: logger.LEVEL.ERROR,
                component: "REPOSITORY.DESIGNATION",
                code: "REPOSITORY.DESIGNATION.UPDATE-DESIGNATION-DETAILS",
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
  create(designation) {
    return new Promise((resolve, reject) => {
      this.db.query(
        "INSERT INTO designation (status, designation_name, online_portal, login_access) VALUES (?, ?, ?, ?)",
        [
          designation.status,
          designation.designation_name,
          designation.online_portal,
          designation.login_access
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
  getDesignationCount() {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT count(designation_id) AS desigcount FROM designation`,
        [],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.DESIGNATION",
              code: "REPOSITORY.DESIGNATION.GET-DESIGNATION-COUNT",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve(docs);
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
