const logger = require("../utils/logger");

const TABLE = "products_expiry_checker";
const TABLE_ITEMS = "products_expiry_checker_items";

class ProductsExpiryCheckerRepository {
  constructor(db) {
    this.db = db;
  }

  // --- products_expiry_checker ---

  getAll() {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT pec.products_expiry_checker_id, pec.product_id, pec.expiry_date, pec.ref_file, pec.created_at, pec.updated_at,
                p.product_id AS product_product_id, p.de_display_name AS product_de_display_name, p.gf_item_name AS product_gf_item_name
         FROM ${TABLE} pec
         LEFT JOIN product_table p ON p.product_id = pec.product_id
         ORDER BY pec.products_expiry_checker_id DESC`,
        (err, rows) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PRODUCTS_EXPIRY_CHECKER",
              code: "REPOSITORY.PRODUCTS_EXPIRY_CHECKER.GET_ALL",
              description: err.toString(),
              category: "",
              ref: {}
            });
            return reject(err);
          }
          const headers = (rows || []).map((r) => ({
            products_expiry_checker_id: r.products_expiry_checker_id,
            product_id: r.product_id,
            expiry_date: r.expiry_date,
            ref_file: r.ref_file,
            created_at: r.created_at,
            updated_at: r.updated_at,
            product:
              r.product_product_id != null
                ? {
                    product_id: r.product_product_id,
                    de_display_name: r.product_de_display_name,
                    gf_item_name: r.product_gf_item_name
                  }
                : null
          }));
          if (headers.length === 0) return resolve([]);
          const ids = headers.map((r) => r.products_expiry_checker_id);
          this.getItemsByProductsExpiryCheckerIds(ids).then(
            (itemsById) => {
              const result = headers.map((h) => ({
                ...h,
                items: itemsById[h.products_expiry_checker_id] || []
              }));
              resolve(result);
            },
            (errItems) => reject(errItems)
          );
        }
      );
    });
  }

  getById(products_expiry_checker_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT pec.products_expiry_checker_id, pec.product_id, pec.expiry_date, pec.ref_file, pec.created_at, pec.updated_at,
                p.product_id AS product_product_id, p.de_display_name AS product_de_display_name, p.gf_item_name AS product_gf_item_name
         FROM ${TABLE} pec
         LEFT JOIN product_table p ON p.product_id = pec.product_id
         WHERE pec.products_expiry_checker_id = ?`,
        [products_expiry_checker_id],
        (err, rows) => {
          if (err) return reject(err);
          const r = rows && rows[0];
          if (!r) return resolve(null);
          const row = {
            products_expiry_checker_id: r.products_expiry_checker_id,
            product_id: r.product_id,
            expiry_date: r.expiry_date,
            ref_file: r.ref_file,
            created_at: r.created_at,
            updated_at: r.updated_at,
            product:
              r.product_product_id != null
                ? {
                    product_id: r.product_product_id,
                    de_display_name: r.product_de_display_name,
                    gf_item_name: r.product_gf_item_name
                  }
                : null
          };
          this.getItemsByProductsExpiryCheckerId(products_expiry_checker_id).then(
            (items) => {
              resolve({ ...row, items: items || [] });
            },
            (errItems) => reject(errItems)
          );
        }
      );
    });
  }

  create(data) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `INSERT INTO ${TABLE} (product_id, expiry_date, ref_file) VALUES (?, ?, ?)`,
        [data.product_id, data.expiry_date, data.ref_file || null],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PRODUCTS_EXPIRY_CHECKER",
              code: "REPOSITORY.PRODUCTS_EXPIRY_CHECKER.CREATE",
              description: err.toString(),
              category: "",
              ref: {}
            });
            return reject(err);
          }
          resolve({ code: 200, products_expiry_checker_id: res.insertId });
        }
      );
    });
  }

  update(products_expiry_checker_id, data) {
    return new Promise((resolve, reject) => {
      const sets = ["updated_at = CURRENT_TIMESTAMP"];
      const values = [];
      if (data.product_id !== undefined) {
        sets.push("product_id = ?");
        values.push(data.product_id);
      }
      if (data.expiry_date !== undefined) {
        sets.push("expiry_date = ?");
        values.push(data.expiry_date);
      }
      if (data.ref_file !== undefined) {
        sets.push("ref_file = ?");
        values.push(data.ref_file);
      }
      if (values.length === 0) return resolve({ code: 200, affectedRows: 0 });
      values.push(products_expiry_checker_id);
      this.db.query(
        `UPDATE ${TABLE} SET ${sets.join(", ")} WHERE products_expiry_checker_id = ?`,
        values,
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PRODUCTS_EXPIRY_CHECKER",
              code: "REPOSITORY.PRODUCTS_EXPIRY_CHECKER.UPDATE",
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

  delete(products_expiry_checker_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `DELETE FROM ${TABLE} WHERE products_expiry_checker_id = ?`,
        [products_expiry_checker_id],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PRODUCTS_EXPIRY_CHECKER",
              code: "REPOSITORY.PRODUCTS_EXPIRY_CHECKER.DELETE",
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

  // --- products_expiry_checker_items ---

  mapItemRow(r) {
    return {
      products_expiry_checker_id: r.products_expiry_checker_id,
      branch_id: r.branch_id,
      qty: r.qty,
      is_verified: Boolean(r.is_verified),
      created_by: r.created_by,
      created_at: r.created_at,
      updated_at: r.updated_at,
      branch:
        r.outlet_id != null
          ? {
              outlet_id: r.outlet_id,
              outlet_name: r.outlet_name,
              outlet_code: r.outlet_code
            }
          : null,
      created_by_employee:
        r.created_by_employee_id != null
          ? {
              employee_id: r.created_by_employee_id,
              employee_name: r.created_by_employee_name
            }
          : null
    };
  }

  getItemsByProductsExpiryCheckerId(products_expiry_checker_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT peci.products_expiry_checker_id, peci.branch_id, peci.qty, peci.is_verified, peci.created_by, peci.created_at, peci.updated_at,
                o.outlet_id, o.outlet_name, o.outlet_code,
                ne.employee_id AS created_by_employee_id, ne.employee_name AS created_by_employee_name
         FROM ${TABLE_ITEMS} peci
         LEFT JOIN outlets o ON o.outlet_id = peci.branch_id
         LEFT JOIN new_employee ne ON ne.employee_id = peci.created_by
         WHERE peci.products_expiry_checker_id = ? ORDER BY peci.branch_id`,
        [products_expiry_checker_id],
        (err, rows) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PRODUCTS_EXPIRY_CHECKER",
              code: "REPOSITORY.PRODUCTS_EXPIRY_CHECKER.GET_ITEMS",
              description: err.toString(),
              category: "",
              ref: {}
            });
            return reject(err);
          }
          resolve((rows || []).map((r) => this.mapItemRow(r)));
        }
      );
    });
  }

  getItemsByProductsExpiryCheckerIds(products_expiry_checker_ids) {
    if (!products_expiry_checker_ids || products_expiry_checker_ids.length === 0) {
      return Promise.resolve({});
    }
    const placeholders = products_expiry_checker_ids.map(() => "?").join(", ");
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT peci.products_expiry_checker_id, peci.branch_id, peci.qty, peci.is_verified, peci.created_by, peci.created_at, peci.updated_at,
                o.outlet_id, o.outlet_name, o.outlet_code,
                ne.employee_id AS created_by_employee_id, ne.employee_name AS created_by_employee_name
         FROM ${TABLE_ITEMS} peci
         LEFT JOIN outlets o ON o.outlet_id = peci.branch_id
         LEFT JOIN new_employee ne ON ne.employee_id = peci.created_by
         WHERE peci.products_expiry_checker_id IN (${placeholders}) ORDER BY peci.products_expiry_checker_id, peci.branch_id`,
        products_expiry_checker_ids,
        (err, rows) => {
          if (err) return reject(err);
          const byId = {};
          (rows || []).forEach((r) => {
            if (!byId[r.products_expiry_checker_id]) byId[r.products_expiry_checker_id] = [];
            byId[r.products_expiry_checker_id].push(this.mapItemRow(r));
          });
          resolve(byId);
        }
      );
    });
  }

  upsertItem(data) {
    return new Promise((resolve, reject) => {
      const isVerified = data.is_verified === true ? 1 : 0;
      this.db.query(
        `INSERT INTO ${TABLE_ITEMS} (products_expiry_checker_id, branch_id, qty, is_verified, created_by)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           qty = VALUES(qty),
           is_verified = VALUES(is_verified),
           created_by = VALUES(created_by),
           updated_at = CURRENT_TIMESTAMP`,
        [
          data.products_expiry_checker_id,
          data.branch_id,
          data.qty,
          isVerified,
          data.created_by
        ],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PRODUCTS_EXPIRY_CHECKER",
              code: "REPOSITORY.PRODUCTS_EXPIRY_CHECKER.UPSERT_ITEM",
              description: err.toString(),
              category: "",
              ref: {}
            });
            return reject(err);
          }
          resolve({
            code: 200,
            affectedRows: res.affectedRows,
            insertId: res.insertId
          });
        }
      );
    });
  }

  upsertItemsBatch(items) {
    return new Promise((resolve, reject) => {
      if (!items || items.length === 0) {
        return resolve({ code: 200, affectedRows: 0 });
      }
      const placeholders = items
        .map(() => "(?, ?, ?, ?, ?)")
        .join(", ");
      const values = items.flatMap((d) => [
        d.products_expiry_checker_id,
        d.branch_id,
        d.qty,
        d.is_verified === true ? 1 : 0,
        d.created_by
      ]);
      this.db.query(
        `INSERT INTO ${TABLE_ITEMS} (products_expiry_checker_id, branch_id, qty, is_verified, created_by)
         VALUES ${placeholders}
         ON DUPLICATE KEY UPDATE
           qty = VALUES(qty),
           is_verified = VALUES(is_verified),
           created_by = VALUES(created_by),
           updated_at = CURRENT_TIMESTAMP`,
        values,
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PRODUCTS_EXPIRY_CHECKER",
              code: "REPOSITORY.PRODUCTS_EXPIRY_CHECKER.UPSERT_ITEMS_BATCH",
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

  deleteItem(products_expiry_checker_id, branch_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `DELETE FROM ${TABLE_ITEMS} WHERE products_expiry_checker_id = ? AND branch_id = ?`,
        [products_expiry_checker_id, branch_id],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PRODUCTS_EXPIRY_CHECKER",
              code: "REPOSITORY.PRODUCTS_EXPIRY_CHECKER.DELETE_ITEM",
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
  return new ProductsExpiryCheckerRepository(db);
};
