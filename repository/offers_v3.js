const logger = require("../utils/logger");

const TABLE = "offers_v3";

const SELECT_COLS =
  "id, item_code, item_name, offer_type, value, is_active, created_at, updated_at";

const ALLOWED_UPDATE_KEYS = ["item_code", "item_name", "offer_type", "value", "is_active"];

function logError(component, code, description, ref = {}) {
  logger.Log({
    level: logger.LEVEL.ERROR,
    component,
    code,
    description,
    category: "",
    ref,
  });
}

class OffersV3Repository {
  constructor(db) {
    this.db = db;
  }

  getAll() {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT ${SELECT_COLS} FROM \`${TABLE}\` ORDER BY id DESC`,
        [],
        (err, rows) => {
          if (err) {
            logError("REPOSITORY.OFFERS_V3", "REPOSITORY.OFFERS_V3.GET_ALL", err.toString());
            return reject(err);
          }
          resolve(rows || []);
        }
      );
    });
  }

  getById(id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT ${SELECT_COLS} FROM \`${TABLE}\` WHERE id = ?`,
        [id],
        (err, rows) => {
          if (err) {
            logError("REPOSITORY.OFFERS_V3", "REPOSITORY.OFFERS_V3.GET_BY_ID", err.toString(), { id });
            return reject(err);
          }
          resolve(rows && rows[0] ? rows[0] : null);
        }
      );
    });
  }

  create(data) {
    return new Promise((resolve, reject) => {
      const is_active = data.is_active !== undefined ? (data.is_active ? 1 : 0) : 1;
      this.db.query(
        `INSERT INTO \`${TABLE}\` (item_code, item_name, offer_type, value, is_active) VALUES (?, ?, ?, ?, ?)`,
        [data.item_code, data.item_name, data.offer_type, data.value, is_active],
        (err, res) => {
          if (err) {
            if (err.code === "ER_DUP_ENTRY") {
              resolve({ code: 400, msg: "Duplicate item_code: offer already exists for this item" });
              return;
            }
            logError("REPOSITORY.OFFERS_V3", "REPOSITORY.OFFERS_V3.CREATE", err.toString());
            return reject(err);
          }
          resolve({ code: 200, id: res.insertId });
        }
      );
    });
  }

  bulkInsert(rows) {
    return new Promise((resolve, reject) => {
      if (!Array.isArray(rows) || rows.length === 0) {
        resolve({ code: 200, inserted: 0 });
        return;
      }
      const values = rows.map((r) => {
        const is_active = r.is_active !== undefined ? (r.is_active ? 1 : 0) : 1;
        return [r.item_code, r.item_name, r.offer_type, r.value, is_active];
      });
      const placeholders = values.map(() => "(?, ?, ?, ?, ?)").join(", ");
      const flat = values.flat();
      const sql = `INSERT INTO \`${TABLE}\` (item_code, item_name, offer_type, value, is_active) VALUES ${placeholders}
        ON DUPLICATE KEY UPDATE item_name = VALUES(item_name), offer_type = VALUES(offer_type),
          value = VALUES(value), is_active = VALUES(is_active), updated_at = CURRENT_TIMESTAMP`;
      this.db.query(sql, flat, (err, res) => {
        if (err) {
          logError("REPOSITORY.OFFERS_V3", "REPOSITORY.OFFERS_V3.BULK_INSERT", err.toString());
          return reject(err);
        }
        resolve({ code: 200, inserted: res.affectedRows });
      });
    });
  }

  update(id, data) {
    return new Promise((resolve, reject) => {
      const sets = ["updated_at = CURRENT_TIMESTAMP"];
      const values = [];
      ALLOWED_UPDATE_KEYS.forEach((key) => {
        if (data[key] === undefined) return;
        sets.push(`\`${key}\` = ?`);
        values.push(key === "is_active" ? (data[key] ? 1 : 0) : data[key]);
      });
      if (values.length === 0) {
        return resolve({ code: 200, affectedRows: 0 });
      }
      values.push(id);
      this.db.query(
        `UPDATE \`${TABLE}\` SET ${sets.join(", ")} WHERE id = ?`,
        values,
        (err, res) => {
          if (err) {
            if (err.code === "ER_DUP_ENTRY") {
              resolve({ code: 400, msg: "Duplicate item_code: offer already exists for this item" });
              return;
            }
            logError("REPOSITORY.OFFERS_V3", "REPOSITORY.OFFERS_V3.UPDATE", err.toString(), { id });
            return reject(err);
          }
          resolve({ code: 200, affectedRows: res.affectedRows });
        }
      );
    });
  }

  delete(id) {
    return new Promise((resolve, reject) => {
      this.db.query(`DELETE FROM \`${TABLE}\` WHERE id = ?`, [id], (err, res) => {
        if (err) {
          logError("REPOSITORY.OFFERS_V3", "REPOSITORY.OFFERS_V3.DELETE", err.toString(), { id });
          return reject(err);
        }
        resolve({ code: 200, affectedRows: res.affectedRows });
      });
    });
  }

  bulkDelete(ids) {
    return new Promise((resolve, reject) => {
      if (!Array.isArray(ids) || ids.length === 0) {
        resolve({ code: 200, affectedRows: 0 });
        return;
      }
      const placeholders = ids.map(() => "?").join(",");
      this.db.query(
        `DELETE FROM \`${TABLE}\` WHERE id IN (${placeholders})`,
        ids,
        (err, res) => {
          if (err) {
            logError("REPOSITORY.OFFERS_V3", "REPOSITORY.OFFERS_V3.BULK_DELETE", err.toString());
            return reject(err);
          }
          resolve({ code: 200, affectedRows: res.affectedRows });
        }
      );
    });
  }
}

module.exports = (db) => {
  return new OffersV3Repository(db);
};
