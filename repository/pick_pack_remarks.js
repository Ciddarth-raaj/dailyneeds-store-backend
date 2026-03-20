const logger = require("../utils/logger");

const TABLE = "pick_pack_remarks";

class PickPackRemarksRepository {
  constructor(db) {
    this.db = db;
  }

  getAll() {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT remark_id, label, is_active, created_at, updated_at FROM ${TABLE} ORDER BY remark_id ASC`,
        (err, rows) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PICK_PACK_REMARKS",
              code: "REPOSITORY.PICK_PACK_REMARKS.GET_ALL",
              description: err.toString(),
              category: "",
              ref: {}
            });
            return reject(err);
          }
          resolve((rows || []).map((r) => ({
            remark_id: r.remark_id,
            label: r.label,
            is_active: Boolean(r.is_active),
            created_at: r.created_at,
            updated_at: r.updated_at
          })));
        }
      );
    });
  }

  getById(remark_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT remark_id, label, is_active, created_at, updated_at FROM ${TABLE} WHERE remark_id = ?`,
        [remark_id],
        (err, rows) => {
          if (err) return reject(err);
          const row = rows && rows[0];
          if (!row) return resolve(null);
          resolve({
            remark_id: row.remark_id,
            label: row.label,
            is_active: Boolean(row.is_active),
            created_at: row.created_at,
            updated_at: row.updated_at
          });
        }
      );
    });
  }

  create(data) {
    return new Promise((resolve, reject) => {
      const isActive = data.is_active !== undefined ? (data.is_active ? 1 : 0) : 1;
      this.db.query(
        `INSERT INTO ${TABLE} (label, is_active) VALUES (?, ?)`,
        [data.label, isActive],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PICK_PACK_REMARKS",
              code: "REPOSITORY.PICK_PACK_REMARKS.CREATE",
              description: err.toString(),
              category: "",
              ref: {}
            });
            return reject(err);
          }
          resolve({ code: 200, remark_id: res.insertId });
        }
      );
    });
  }

  update(remark_id, data) {
    return new Promise((resolve, reject) => {
      const sets = ["updated_at = CURRENT_TIMESTAMP"];
      const values = [];
      if (data.label !== undefined) {
        sets.push("label = ?");
        values.push(data.label);
      }
      if (data.is_active !== undefined) {
        sets.push("is_active = ?");
        values.push(data.is_active ? 1 : 0);
      }
      if (values.length === 0) return resolve({ code: 200, affectedRows: 0 });
      values.push(remark_id);
      this.db.query(
        `UPDATE ${TABLE} SET ${sets.join(", ")} WHERE remark_id = ?`,
        values,
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PICK_PACK_REMARKS",
              code: "REPOSITORY.PICK_PACK_REMARKS.UPDATE",
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

  delete(remark_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `DELETE FROM ${TABLE} WHERE remark_id = ?`,
        [remark_id],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PICK_PACK_REMARKS",
              code: "REPOSITORY.PICK_PACK_REMARKS.DELETE",
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
  return new PickPackRemarksRepository(db);
};
