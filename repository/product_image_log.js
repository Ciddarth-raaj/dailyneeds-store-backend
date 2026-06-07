const logger = require("../utils/logger");

class ProductImageLogRepository {
  constructor(db) {
    this.db = db;
  }

  create(data) {
    return new Promise((resolve, reject) => {
      const changeJson =
        typeof data.change_json === "string"
          ? data.change_json
          : JSON.stringify(data.change_json || []);
      this.db.query(
        `INSERT INTO product_image_log (product_id, change_json, created_by)
         VALUES (?, ?, ?)`,
        [data.product_id, changeJson, data.created_by],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PRODUCT_IMAGE_LOG",
              code: "REPOSITORY.PRODUCT_IMAGE_LOG.CREATE",
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

  getById(logId) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT pil.*,
                pt.product_id, pt.gf_item_name, pt.de_display_name, pt.de_name,
                ne.employee_id as created_by_employee_code, ne.employee_name as created_by_employee_name
         FROM product_image_log pil
         LEFT JOIN product_table pt ON pil.product_id = pt.product_id
         LEFT JOIN new_employee ne ON pil.created_by = ne.employee_id
         WHERE pil.product_image_log_id = ?`,
        [logId],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PRODUCT_IMAGE_LOG",
              code: "REPOSITORY.PRODUCT_IMAGE_LOG.GET_BY_ID",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          const row = docs[0];
          if (!row) {
            resolve(null);
            return;
          }
          resolve(this._formatRow(row));
        }
      );
    });
  }

  getAll(filters = {}) {
    return new Promise((resolve, reject) => {
      let query = `
        SELECT pil.*,
               pt.product_id, pt.gf_item_name, pt.de_display_name, pt.de_name,
               ne.employee_id as created_by_employee_code, ne.employee_name as created_by_employee_name
        FROM product_image_log pil
        LEFT JOIN product_table pt ON pil.product_id = pt.product_id
        LEFT JOIN new_employee ne ON pil.created_by = ne.employee_id
      `;
      const conditions = [];
      const params = [];

      if (filters.product_id) {
        conditions.push("pil.product_id = ?");
        params.push(filters.product_id);
      }
      if (filters.created_by) {
        conditions.push("pil.created_by = ?");
        params.push(filters.created_by);
      }
      if (filters.date_from) {
        conditions.push("pil.created_at >= ?");
        params.push(`${filters.date_from} 00:00:00`);
      }
      if (filters.date_to) {
        conditions.push("pil.created_at <= ?");
        params.push(`${filters.date_to} 23:59:59`);
      }

      if (conditions.length > 0) {
        query += " WHERE " + conditions.join(" AND ");
      }
      query += " ORDER BY pil.created_at DESC";

      if (filters.limit) {
        query += " LIMIT ?";
        params.push(filters.limit);
      }
      if (filters.offset) {
        query += " OFFSET ?";
        params.push(filters.offset);
      }

      this.db.query(query, params, (err, docs) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.PRODUCT_IMAGE_LOG",
            code: "REPOSITORY.PRODUCT_IMAGE_LOG.GET_ALL",
            description: err.toString(),
            category: "",
            ref: {},
          });
          reject(err);
          return;
        }
        resolve(docs.map((row) => this._formatRow(row)));
      });
    });
  }

  _formatRow(row) {
    const change_json =
      typeof row.change_json === "string"
        ? (() => {
            try {
              return JSON.parse(row.change_json);
            } catch (_) {
              return row.change_json;
            }
          })()
        : row.change_json;
    return {
      product_image_log_id: row.product_image_log_id,
      product_id: row.product_id,
      change_json,
      created_by: row.created_by,
      created_at: row.created_at,
      product: row.product_id
        ? {
            product_id: row.product_id,
            de_name: row.de_name,
            de_display_name: row.de_display_name,
            gf_item_name: row.gf_item_name, // @deprecated — use de_name
          }
        : null,
      created_by_employee: row.created_by_employee_code
        ? {
            employee_code: row.created_by_employee_code,
            employee_name: row.created_by_employee_name,
          }
        : null,
    };
  }

  update(logId, data) {
    return new Promise((resolve, reject) => {
      const changeJson =
        typeof data.change_json === "string"
          ? data.change_json
          : JSON.stringify(data.change_json || []);
      this.db.query(
        `UPDATE product_image_log SET product_id = ?, change_json = ?, created_by = ?
         WHERE product_image_log_id = ?`,
        [data.product_id, changeJson, data.created_by, logId],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PRODUCT_IMAGE_LOG",
              code: "REPOSITORY.PRODUCT_IMAGE_LOG.UPDATE",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve({ code: 200, affectedRows: res.affectedRows });
        }
      );
    });
  }

  delete(logId) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `DELETE FROM product_image_log WHERE product_image_log_id = ?`,
        [logId],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PRODUCT_IMAGE_LOG",
              code: "REPOSITORY.PRODUCT_IMAGE_LOG.DELETE",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve({ code: 200, affectedRows: res.affectedRows });
        }
      );
    });
  }
}

module.exports = (db) => {
  return new ProductImageLogRepository(db);
};
