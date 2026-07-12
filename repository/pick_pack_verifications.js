const logger = require("../utils/logger");

const TABLE = "pick_pack_verifications";

function mapVerificationRow(r) {
  if (!r) return null;
  return {
    ...r,
    is_verified: Boolean(r.is_verified)
  };
}

class PickPackVerificationsRepository {
  constructor(db) {
    this.db = db;
  }

  getAll(filters = {}) {
    return new Promise((resolve, reject) => {
      const where = [];
      const params = [];

      if (filters.from_date) {
        where.push("ppr.date >= ?");
        params.push(filters.from_date);
      }
      if (filters.to_date) {
        where.push("ppr.date <= ?");
        params.push(filters.to_date);
      }
      if (filters.job_type) {
        where.push("ppr.job_type = ?");
        params.push(filters.job_type);
      }

      const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";

      this.db.query(
        `SELECT
          ppr.pick_pack_verification_id,
          ppr.product_id,
          pt.de_name AS product_name,
          (
            SELECT pi.image_url
            FROM product_images pi
            WHERE pi.product_id = ppr.product_id
            ORDER BY pi.priority ASC, pi.image_id ASC
            LIMIT 1
          ) AS product_image_url,
          ppr.mismatch_qty,
          ppr.date,
          ppr.job_type,
          ppr.remark_id,
          ppr.remark_str,
          CASE
            WHEN ppr.remark_id IS NOT NULL THEN pprm.label
            ELSE ppr.remark_str
          END AS remark_value,
          ppr.is_verified,
          ppr.created_at,
          ppr.updated_at
        FROM ${TABLE} ppr
        LEFT JOIN product_table pt ON pt.product_id = ppr.product_id
        LEFT JOIN pick_pack_verification_remarks pprm ON pprm.remark_id = ppr.remark_id
        ${whereClause}
        ORDER BY ppr.date DESC, ppr.pick_pack_verification_id DESC`,
        params,
        (err, rows) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PICK_PACK_VERIFICATIONS",
              code: "REPOSITORY.PICK_PACK_VERIFICATIONS.GET_ALL",
              description: err.toString(),
              category: "",
              ref: {}
            });
            return reject(err);
          }
          resolve((rows || []).map(mapVerificationRow));
        }
      );
    });
  }

  getById(pick_pack_verification_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT
          ppr.pick_pack_verification_id,
          ppr.product_id,
          pt.de_name AS product_name,
          (
            SELECT pi.image_url
            FROM product_images pi
            WHERE pi.product_id = ppr.product_id
            ORDER BY pi.priority ASC, pi.image_id ASC
            LIMIT 1
          ) AS product_image_url,
          ppr.mismatch_qty,
          ppr.date,
          ppr.job_type,
          ppr.remark_id,
          ppr.remark_str,
          CASE
            WHEN ppr.remark_id IS NOT NULL THEN pprm.label
            ELSE ppr.remark_str
          END AS remark_value,
          ppr.is_verified,
          ppr.created_at,
          ppr.updated_at
        FROM ${TABLE} ppr
        LEFT JOIN product_table pt ON pt.product_id = ppr.product_id
        LEFT JOIN pick_pack_verification_remarks pprm ON pprm.remark_id = ppr.remark_id
        WHERE ppr.pick_pack_verification_id = ?`,
        [pick_pack_verification_id],
        (err, rows) => {
          if (err) return reject(err);
          resolve(mapVerificationRow((rows && rows[0]) || null));
        }
      );
    });
  }

  create(data) {
    return new Promise((resolve, reject) => {
      const isVerified =
        data.is_verified !== undefined ? (data.is_verified ? 1 : 0) : 0;
      this.db.query(
        `INSERT INTO ${TABLE} (product_id, mismatch_qty, date, job_type, remark_id, remark_str, is_verified)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          data.product_id,
          data.mismatch_qty,
          data.date,
          data.job_type,
          data.remark_id || null,
          data.remark_str || null,
          isVerified
        ],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PICK_PACK_VERIFICATIONS",
              code: "REPOSITORY.PICK_PACK_VERIFICATIONS.CREATE",
              description: err.toString(),
              category: "",
              ref: {}
            });
            return reject(err);
          }
          resolve({ code: 200, pick_pack_verification_id: res.insertId });
        }
      );
    });
  }

  update(pick_pack_verification_id, data) {
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
      if (data.job_type !== undefined) {
        sets.push("job_type = ?");
        values.push(data.job_type);
      }
      if (data.remark_id !== undefined) {
        sets.push("remark_id = ?");
        values.push(data.remark_id || null);
      }
      if (data.remark_str !== undefined) {
        sets.push("remark_str = ?");
        values.push(data.remark_str || null);
      }
      if (data.is_verified !== undefined) {
        sets.push("is_verified = ?");
        values.push(data.is_verified ? 1 : 0);
      }

      if (values.length === 0) return resolve({ code: 200, affectedRows: 0 });

      values.push(pick_pack_verification_id);
      this.db.query(
        `UPDATE ${TABLE} SET ${sets.join(", ")} WHERE pick_pack_verification_id = ?`,
        values,
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PICK_PACK_VERIFICATIONS",
              code: "REPOSITORY.PICK_PACK_VERIFICATIONS.UPDATE",
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

  delete(pick_pack_verification_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `DELETE FROM ${TABLE} WHERE pick_pack_verification_id = ?`,
        [pick_pack_verification_id],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PICK_PACK_VERIFICATIONS",
              code: "REPOSITORY.PICK_PACK_VERIFICATIONS.DELETE",
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
  return new PickPackVerificationsRepository(db);
};
