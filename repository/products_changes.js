const logger = require("../utils/logger");

class ProductsChangesRepository {
  constructor(db) {
    this.db = db;
  }

  insert(data) {
    return new Promise((resolve, reject) => {
      const changesJson =
        typeof data.changes === "string"
          ? data.changes
          : JSON.stringify(data.changes || {});
      this.db.query(
        `INSERT INTO products_changes (product_id, changes, is_approved, created_at, updated_at)
         VALUES (?, ?, ?, NOW(), NOW())`,
        [data.product_id, changesJson, data.is_approved === true ? 1 : 0],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PRODUCTS_CHANGES",
              code: "REPOSITORY.PRODUCTS_CHANGES.INSERT",
              description: err.toString(),
              category: "",
              ref: { product_id: data.product_id }
            });
            return reject(err);
          }
          resolve({ insertId: res.insertId });
        }
      );
    });
  }

  getById(products_change_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT pc.products_change_id, pc.product_id, pc.changes, pc.is_approved, pc.created_at, pc.updated_at,
                pt.gf_item_name,
                (SELECT image_url FROM product_images WHERE product_id = pc.product_id ORDER BY priority ASC, image_id ASC LIMIT 1) AS product_image_url
         FROM products_changes pc
         LEFT JOIN product_table pt ON pt.product_id = pc.product_id
         WHERE pc.products_change_id = ?`,
        [products_change_id],
        (err, rows) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PRODUCTS_CHANGES",
              code: "REPOSITORY.PRODUCTS_CHANGES.GET_BY_ID",
              description: err.toString(),
              category: "",
              ref: { products_change_id }
            });
            return reject(err);
          }
          const row = rows && rows[0];
          resolve(row ? this._formatRow(row) : null);
        }
      );
    });
  }

  getAll(filters = {}) {
    return new Promise((resolve, reject) => {
      const conditions = [];
      const values = [];
      if (filters.product_id != null && filters.product_id !== "") {
        conditions.push("pc.product_id = ?");
        values.push(filters.product_id);
      }
      if (filters.is_approved !== undefined) {
        conditions.push("pc.is_approved = ?");
        values.push(filters.is_approved ? 1 : 0);
      }
      const where = conditions.length ? " WHERE " + conditions.join(" AND ") : "";
      const limit = filters.limit != null ? Math.max(0, parseInt(filters.limit, 10) || 0) : 100;
      const offset = filters.offset != null ? Math.max(0, parseInt(filters.offset, 10) || 0) : 0;
      const sql = `SELECT pc.products_change_id, pc.product_id, pc.changes, pc.is_approved, pc.created_at, pc.updated_at,
                          pt.gf_item_name,
                          (SELECT image_url FROM product_images WHERE product_id = pc.product_id ORDER BY priority ASC, image_id ASC LIMIT 1) AS product_image_url
                   FROM products_changes pc
                   LEFT JOIN product_table pt ON pt.product_id = pc.product_id
                   ${where}
                   ORDER BY pc.created_at DESC
                   LIMIT ? OFFSET ?`;
      this.db.query(sql, [...values, limit, offset], (err, rows) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.PRODUCTS_CHANGES",
            code: "REPOSITORY.PRODUCTS_CHANGES.GET_ALL",
            description: err.toString(),
            category: "",
            ref: {}
          });
          return reject(err);
        }
        resolve((rows || []).map((r) => this._formatRow(r)));
      });
    });
  }

  setApproval(products_change_id, is_approved) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `UPDATE products_changes SET is_approved = ?, updated_at = NOW() WHERE products_change_id = ?`,
        [is_approved ? 1 : 0, products_change_id],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PRODUCTS_CHANGES",
              code: "REPOSITORY.PRODUCTS_CHANGES.SET_APPROVAL",
              description: err.toString(),
              category: "",
              ref: { products_change_id }
            });
            return reject(err);
          }
          resolve({ affectedRows: res.affectedRows });
        }
      );
    });
  }

  _formatRow(row) {
    const changes = row.changes;
    return {
      products_change_id: row.products_change_id,
      product_id: row.product_id,
      gf_item_name: row.gf_item_name ?? null,
      product_image_url: row.product_image_url ?? null,
      changes: typeof changes === "string" ? (() => { try { return JSON.parse(changes); } catch (_) { return changes; } })() : changes,
      is_approved: Boolean(row.is_approved),
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  }
}

module.exports = (db) => {
  return new ProductsChangesRepository(db);
};
