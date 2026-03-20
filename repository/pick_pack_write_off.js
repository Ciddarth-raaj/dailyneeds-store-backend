const logger = require("../utils/logger");

const TABLE = "pick_pack_write_off";

class PickPackWriteOffRepository {
  constructor(db) {
    this.db = db;
  }

  getAll(filters = {}) {
    return new Promise((resolve, reject) => {
      const where = [];
      const params = [];

      if (filters.from_date) {
        where.push("ppwo.date >= ?");
        params.push(filters.from_date);
      }
      if (filters.to_date) {
        where.push("ppwo.date <= ?");
        params.push(filters.to_date);
      }

      const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";

      this.db.query(
        `SELECT
          ppwo.pick_pack_write_off_id,
          ppwo.product_id,
          pt.gf_item_name AS product_name,
          (
            SELECT pi.image_url
            FROM product_images pi
            WHERE pi.product_id = ppwo.product_id
            ORDER BY pi.priority ASC, pi.image_id ASC
            LIMIT 1
          ) AS product_image_url,
          ppwo.mismatch_qty,
          ppwo.date,
          ppwo.remark_id,
          ppwo.remark_str,
          CASE
            WHEN ppwo.remark_id IS NOT NULL THEN ppr.label
            ELSE ppwo.remark_str
          END AS remark_value,
          ppwo.created_at,
          ppwo.updated_at
        FROM ${TABLE} ppwo
        LEFT JOIN product_table pt ON pt.product_id = ppwo.product_id
        LEFT JOIN pick_pack_remarks ppr ON ppr.remark_id = ppwo.remark_id
        ${whereClause}
        ORDER BY ppwo.date DESC, ppwo.pick_pack_write_off_id DESC`,
        params,
        (err, rows) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PICK_PACK_WRITE_OFF",
              code: "REPOSITORY.PICK_PACK_WRITE_OFF.GET_ALL",
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

  getById(pick_pack_write_off_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT
          ppwo.pick_pack_write_off_id,
          ppwo.product_id,
          pt.gf_item_name AS product_name,
          (
            SELECT pi.image_url
            FROM product_images pi
            WHERE pi.product_id = ppwo.product_id
            ORDER BY pi.priority ASC, pi.image_id ASC
            LIMIT 1
          ) AS product_image_url,
          ppwo.mismatch_qty,
          ppwo.date,
          ppwo.remark_id,
          ppwo.remark_str,
          CASE
            WHEN ppwo.remark_id IS NOT NULL THEN ppr.label
            ELSE ppwo.remark_str
          END AS remark_value,
          ppwo.created_at,
          ppwo.updated_at
        FROM ${TABLE} ppwo
        LEFT JOIN product_table pt ON pt.product_id = ppwo.product_id
        LEFT JOIN pick_pack_remarks ppr ON ppr.remark_id = ppwo.remark_id
        WHERE ppwo.pick_pack_write_off_id = ?`,
        [pick_pack_write_off_id],
        (err, rows) => {
          if (err) return reject(err);
          resolve((rows && rows[0]) || null);
        }
      );
    });
  }

  create(data) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `INSERT INTO ${TABLE} (product_id, mismatch_qty, date, remark_id, remark_str)
         VALUES (?, ?, ?, ?, ?)`,
        [
          data.product_id,
          data.mismatch_qty,
          data.date,
          data.remark_id || null,
          data.remark_str || null
        ],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PICK_PACK_WRITE_OFF",
              code: "REPOSITORY.PICK_PACK_WRITE_OFF.CREATE",
              description: err.toString(),
              category: "",
              ref: {}
            });
            return reject(err);
          }
          resolve({ code: 200, pick_pack_write_off_id: res.insertId });
        }
      );
    });
  }

  update(pick_pack_write_off_id, data) {
    return new Promise((resolve, reject) => {
      const sets = ["updated_at = CURRENT_TIMESTAMP"];
      const values = [];

      if (data.product_id !== undefined) {
        sets.push("product_id = ?");
        values.push(data.product_id);
      }
      if (data.mismatch_qty !== undefined) {
        sets.push("mismatch_qty = ?");
        values.push(data.mismatch_qty);
      }
      if (data.date !== undefined) {
        sets.push("date = ?");
        values.push(data.date);
      }
      if (data.remark_id !== undefined) {
        sets.push("remark_id = ?");
        values.push(data.remark_id || null);
      }
      if (data.remark_str !== undefined) {
        sets.push("remark_str = ?");
        values.push(data.remark_str || null);
      }

      if (values.length === 0) return resolve({ code: 200, affectedRows: 0 });

      values.push(pick_pack_write_off_id);
      this.db.query(
        `UPDATE ${TABLE} SET ${sets.join(", ")} WHERE pick_pack_write_off_id = ?`,
        values,
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PICK_PACK_WRITE_OFF",
              code: "REPOSITORY.PICK_PACK_WRITE_OFF.UPDATE",
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

  delete(pick_pack_write_off_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `DELETE FROM ${TABLE} WHERE pick_pack_write_off_id = ?`,
        [pick_pack_write_off_id],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PICK_PACK_WRITE_OFF",
              code: "REPOSITORY.PICK_PACK_WRITE_OFF.DELETE",
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
  return new PickPackWriteOffRepository(db);
};
