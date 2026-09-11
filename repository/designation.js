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
      this.db.query(
        "select designation.designation_id, designation.designation_name, budget.budget_id, budget.budget from designation LEFT JOIN budget ON budget.designation_name = designation.designation_name",
        [],
        (err, docs) => {
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
        }
      );
    });
  }
  /**
   * Id and name only, for a picker.
   *
   * `GET /designation` is `SELECT * FROM designation` behind `view_designation`
   * - a permission for ADMINISTERING designations - and that is right for the
   * master screen. But the Employee Master's Employment editor needs the same
   * two columns to populate its Designation dropdown, and a designation given
   * `employee_edit` without `view_designation` got an empty one: the field was
   * editable and unusable at the same time.
   *
   * Same answer as `getDirectory` on outlets and employees: return less rather
   * than hand back the permission. No status, no `login_access`, no
   * `online_portal`, no permission set, and no write of any kind. A designation
   * NAME is already on every row of the employee list that `view_employees`
   * returns, so this discloses nothing that screen does not.
   */
  getDirectory() {
    return new Promise((resolve, reject) => {
      this.db.query(
        "SELECT designation_id, designation_name FROM designation ORDER BY designation_name ASC",
        [],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.DESIGNATION",
              code: "REPOSITORY.DESIGNATION.GET-DIRECTORY",
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
        }
      );
    });
  }
  getById(designation_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        "SELECT * FROM designation where designation_id = ?",
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
        }
      );
    });
  }
  getAllPermissions() {
    return new Promise((resolve, reject) => {
      this.db.query("SELECT * FROM all_permissions", [], (err, docs) => {
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
    if (user_type === 2) {
      return `SELECT * FROM all_permissions`;
    }
    if (user_type === 1) {
      // Stage 0B / B2: `is_active` exists on this table but was never read,
      // so a permission switched off still granted access. It is a filter
      // now — for the authorisation check AND for the bootstrap the frontend
      // uses to decide which screens to show, which must agree.
      return `SELECT permission_key FROM permissions WHERE designation_id = ? AND is_active = 1`;
    }
  }
  getPermissionById(designation_id, user_type) {
    return new Promise((resolve, reject) => {
      this.db.query(this.getQuery(user_type), [designation_id], (err, docs) => {
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
      const onlinePortal =
        designation.online_portal === undefined || designation.online_portal === null
          ? 1
          : designation.online_portal;
      const loginAccess =
        designation.login_access === undefined || designation.login_access === null
          ? 1
          : designation.login_access;
      this.db.query(
        // `online_portal` and `login_access` are LEGACY and inert - nothing
        // reads either one - but both columns are `INT NOT NULL` with no
        // default, so the INSERT cannot leave them out: MySQL raises
        // ER_NO_DEFAULT_FOR_FIELD under STRICT_TRANS_TABLES. A caller that
        // still sends a value keeps it; one that does not gets 1, which is
        // what `services/synker.js` has always written for every designation
        // it creates. Dropping the columns would need a migration, and they
        // are deliberately kept for compatibility.
        "INSERT INTO designation (status, designation_name, online_portal, login_access) VALUES (?, ?, ?, ?)",
        [
          designation.status,
          designation.designation_name,
          onlinePortal,
          loginAccess,
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

  deletePermissions(designation_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        "DELETE FROM permissions where designation_id = ?",
        [designation_id],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.DESIGNATION",
              code: "REPOSITORY.DESIGNATION.DELETE-PERMISSIONS",
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

  bulkCreate(rows) {
    return new Promise((resolve, reject) => {
      if (!Array.isArray(rows) || rows.length === 0) {
        resolve({ affectedRows: 0 });
        return;
      }

      const columns = Object.keys(rows[0]);
      const values = rows.map((r) => columns.map((c) => r[c]));
      const placeholders = values
        .map(() => `(${columns.map(() => "?").join(",")})`)
        .join(",");
      const flat = [].concat(...values);

      const updateAssignments = columns
        .map((c) => `\`${c}\` = VALUES(\`${c}\`)`)
        .join(", ");

      const sql =
        `INSERT INTO designation (${columns.join(
          ","
        )}) VALUES ${placeholders}` +
        (updateAssignments.length > 0
          ? ` ON DUPLICATE KEY UPDATE ${updateAssignments}`
          : "");

      this.db.query(sql, flat, (err, result) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.DESIGNATIONS",
            code: "REPOSITORY.DESIGNATIONS.BULKCREATE.ERROR",
            description: err.toString(),
            category: "",
            ref: {},
          });
          reject(err);
          return;
        }
        resolve({
          affectedRows: result.affectedRows,
          insertedId: result.insertId,
        });
      });
    });
  }
}

module.exports = (db) => {
  return new DesignationRepository(db);
};
