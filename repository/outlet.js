const logger = require("../utils/logger");

class OutletRepository {
  constructor(db) {
    this.db = db;
  }

  get() {
    return new Promise((resolve, reject) => {
      this.db.query("SELECT * FROM outlets", [], (err, docs) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.OUTLET",
            code: "REPOSITORY.OUTLET.GET",
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
        "UPDATE outlets SET is_active = ? WHERE outlet_id = ?",
        [file.is_active, file.outlet_id],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.OUTLET",
              code: "REPOSITORY.OUTLET.UPDATE-STATUS",
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
  updateOutletDetails(data, outlet_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `UPDATE outlets SET ? WHERE outlet_id = ?`,
        [data, outlet_id],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.OUTLET",
              code: "REPOSITORY.OUTLET.UPDATE-OUTLET-DETAILS",
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
  create(outlet) {
    return new Promise((resolve, reject) => {
      this.db.query(
        "INSERT INTO outlets (outlet_name, outlet_address, outlet_phone, phone, outlet_nickname, telegram_username, opening_cash) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
          outlet.outlet_name,
          outlet.outlet_address,
          outlet.outlet_phone,
          outlet.phone,
          outlet.outlet_nickname,
          outlet.telegram_username,
          outlet.opening_cash,
        ],
        (err, res) => {
          if (err) {
            if (err.code === "ER_DUP_ENTRY") {
              resolve({ code: 101 });
              return;
            }
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.OUTLET",
              code: "REPOSITORY.OUTLET.CREATE",
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
  getOutletByOutletId(outlet_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        "SELECT * FROM outlets WHERE outlet_id = ?",
        [outlet_id],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.OUTLET",
              code: "REPOSITORY.OUTLET.GET-BY-OUTLET-ID",
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
  getOutletById(outlet_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        "SELECT outlet_id, outlet_name FROM outlets WHERE outlet_id = ?",
        [outlet_id],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.OUTLET",
              code: "REPOSITORY.OUTLET.GET-BY-ID",
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

      // Extract all unique columns from all rows
      const allColumns = new Set();
      rows.forEach((row) => {
        Object.keys(row).forEach((key) => allColumns.add(key));
      });

      // Build column array - put branch_id first if it exists
      const columns = Array.from(allColumns);
      const hasBranchId = columns.includes("outlet_id");
      const finalColumns = hasBranchId
        ? ["outlet_id", ...columns.filter((c) => c !== "outlet_id")]
        : columns;

      const values = rows.map((r) =>
        finalColumns.map((c) => (r[c] === null || r[c] === "" ? null : r[c]))
      );

      const placeholders = values
        .map(() => `(${finalColumns.map(() => "?").join(",")})`)
        .join(",");

      const flat = [].concat(...values);

      // Build ON DUPLICATE KEY UPDATE clause
      // Update all columns except branch_id (which is the primary key)
      const updateColumns = finalColumns.filter((c) => c !== "outlet_id");
      const updateAssignments = updateColumns
        .map((c) => `\`${c}\` = VALUES(\`${c}\`)`)
        .join(", ");

      // Also update updated_at timestamp
      const updateClause =
        updateAssignments.length > 0
          ? `ON DUPLICATE KEY UPDATE ${updateAssignments}, updated_at = CURRENT_TIMESTAMP`
          : "";

      const sql = `INSERT INTO outlets (${finalColumns
        .map((c) => `\`${c}\``)
        .join(", ")}) VALUES ${placeholders} ${updateClause}`;

      this.db.query(sql, flat, (err, result) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.BRANCHES",
            code: "REPOSITORY.BRANCHES.BULKCREATE.ERROR",
            description: err.toString(),
            category: "",
            ref: { rows },
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
  return new OutletRepository(db);
};
