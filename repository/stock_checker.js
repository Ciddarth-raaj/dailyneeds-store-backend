const logger = require("../utils/logger");

const TABLE = "stock_checker";
const TABLE_ITEMS = "stock_checker_items";

class StockCheckerRepository {
  constructor(db) {
    this.db = db;
  }

  // --- stock_checker ---

  getAll() {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT sc.stock_checker_id, sc.product_id, sc.created_by, sc.created_at, sc.updated_at,
                ne.employee_id AS created_by_employee_id, ne.employee_name AS created_by_employee_name,
                p.product_id AS product_product_id, p.de_display_name AS product_de_display_name, p.gf_item_name AS product_gf_item_name
         FROM ${TABLE} sc
         LEFT JOIN new_employee ne ON ne.employee_id = sc.created_by
         LEFT JOIN product_table p ON p.product_id = sc.product_id
         ORDER BY sc.stock_checker_id DESC`,
        (err, rows) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.STOCK_CHECKER",
              code: "REPOSITORY.STOCK_CHECKER.GET_ALL",
              description: err.toString(),
              category: "",
              ref: {}
            });
            return reject(err);
          }
          const headers = (rows || []).map((r) => ({
            stock_checker_id: r.stock_checker_id,
            product_id: r.product_id,
            created_by: r.created_by,
            created_at: r.created_at,
            updated_at: r.updated_at,
            created_by_employee:
              r.created_by_employee_id != null
                ? {
                    employee_id: r.created_by_employee_id,
                    employee_name: r.created_by_employee_name
                  }
                : null,
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
          const ids = headers.map((r) => r.stock_checker_id);
          this.getItemsByStockCheckerIds(ids).then(
            (itemsByScId) => {
              const result = headers.map((h) => ({
                ...h,
                items: itemsByScId[h.stock_checker_id] || []
              }));
              resolve(result);
            },
            (errItems) => reject(errItems)
          );
        }
      );
    });
  }

  getById(stock_checker_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT sc.stock_checker_id, sc.product_id, sc.created_by, sc.created_at, sc.updated_at,
                ne.employee_id AS created_by_employee_id, ne.employee_name AS created_by_employee_name,
                p.product_id AS product_product_id, p.de_display_name AS product_de_display_name, p.gf_item_name AS product_gf_item_name
         FROM ${TABLE} sc
         LEFT JOIN new_employee ne ON ne.employee_id = sc.created_by
         LEFT JOIN product_table p ON p.product_id = sc.product_id
         WHERE sc.stock_checker_id = ?`,
        [stock_checker_id],
        (err, rows) => {
          if (err) return reject(err);
          const r = rows && rows[0];
          if (!r) return resolve(null);
          const row = {
            stock_checker_id: r.stock_checker_id,
            product_id: r.product_id,
            created_by: r.created_by,
            created_at: r.created_at,
            updated_at: r.updated_at,
            created_by_employee:
              r.created_by_employee_id != null
                ? {
                    employee_id: r.created_by_employee_id,
                    employee_name: r.created_by_employee_name
                  }
                : null,
            product:
              r.product_product_id != null
                ? {
                    product_id: r.product_product_id,
                    de_display_name: r.product_de_display_name,
                    gf_item_name: r.product_gf_item_name
                  }
                : null
          };
          this.getItemsByStockCheckerId(stock_checker_id).then(
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
        `INSERT INTO ${TABLE} (product_id, created_by) VALUES (?, ?)`,
        [data.product_id, data.created_by],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.STOCK_CHECKER",
              code: "REPOSITORY.STOCK_CHECKER.CREATE",
              description: err.toString(),
              category: "",
              ref: {}
            });
            return reject(err);
          }
          resolve({ code: 200, stock_checker_id: res.insertId });
        }
      );
    });
  }

  update(stock_checker_id, data) {
    return new Promise((resolve, reject) => {
      const sets = ["updated_at = CURRENT_TIMESTAMP"];
      const values = [];
      if (data.product_id !== undefined) {
        sets.push("product_id = ?");
        values.push(data.product_id);
      }
      if (data.created_by !== undefined) {
        sets.push("created_by = ?");
        values.push(data.created_by);
      }
      if (values.length === 0) return resolve({ code: 200, affectedRows: 0 });
      values.push(stock_checker_id);
      this.db.query(
        `UPDATE ${TABLE} SET ${sets.join(", ")} WHERE stock_checker_id = ?`,
        values,
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.STOCK_CHECKER",
              code: "REPOSITORY.STOCK_CHECKER.UPDATE",
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

  delete(stock_checker_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `DELETE FROM ${TABLE} WHERE stock_checker_id = ?`,
        [stock_checker_id],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.STOCK_CHECKER",
              code: "REPOSITORY.STOCK_CHECKER.DELETE",
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

  // --- stock_checker_items (same file) ---

  mapItemRow(r) {
    return {
      stock_checker_id: r.stock_checker_id,
      branch_id: r.branch_id,
      physical_stock: r.physical_stock,
      system_stock: r.system_stock,
      created_by: r.created_by,
      created_at: r.created_at,
      updated_at: r.updated_at,
      is_verified: Boolean(r.is_verified),
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

  getItemsByStockCheckerId(stock_checker_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT sci.stock_checker_id, sci.branch_id, sci.physical_stock, sci.system_stock, sci.created_by, sci.created_at, sci.updated_at, sci.is_verified,
                o.outlet_id, o.outlet_name, o.outlet_code,
                ne.employee_id AS created_by_employee_id, ne.employee_name AS created_by_employee_name
         FROM ${TABLE_ITEMS} sci
         LEFT JOIN outlets o ON o.outlet_id = sci.branch_id
         LEFT JOIN new_employee ne ON ne.employee_id = sci.created_by
         WHERE sci.stock_checker_id = ? ORDER BY sci.branch_id`,
        [stock_checker_id],
        (err, rows) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.STOCK_CHECKER",
              code: "REPOSITORY.STOCK_CHECKER.GET_ITEMS",
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

  getItemsByStockCheckerIds(stock_checker_ids) {
    if (!stock_checker_ids || stock_checker_ids.length === 0) {
      return Promise.resolve({});
    }
    const placeholders = stock_checker_ids.map(() => "?").join(", ");
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT sci.stock_checker_id, sci.branch_id, sci.physical_stock, sci.system_stock, sci.created_by, sci.created_at, sci.updated_at, sci.is_verified,
                o.outlet_id, o.outlet_name, o.outlet_code,
                ne.employee_id AS created_by_employee_id, ne.employee_name AS created_by_employee_name
         FROM ${TABLE_ITEMS} sci
         LEFT JOIN outlets o ON o.outlet_id = sci.branch_id
         LEFT JOIN new_employee ne ON ne.employee_id = sci.created_by
         WHERE sci.stock_checker_id IN (${placeholders}) ORDER BY sci.stock_checker_id, sci.branch_id`,
        stock_checker_ids,
        (err, rows) => {
          if (err) return reject(err);
          const byId = {};
          (rows || []).forEach((r) => {
            if (!byId[r.stock_checker_id]) byId[r.stock_checker_id] = [];
            byId[r.stock_checker_id].push(this.mapItemRow(r));
          });
          resolve(byId);
        }
      );
    });
  }

  getItemByStockCheckerIdAndBranchId(stock_checker_id, branch_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT sci.stock_checker_id, sci.branch_id, sci.physical_stock, sci.system_stock, sci.created_by, sci.created_at, sci.updated_at, sci.is_verified,
                o.outlet_id, o.outlet_name, o.outlet_code,
                ne.employee_id AS created_by_employee_id, ne.employee_name AS created_by_employee_name
         FROM ${TABLE_ITEMS} sci
         LEFT JOIN outlets o ON o.outlet_id = sci.branch_id
         LEFT JOIN new_employee ne ON ne.employee_id = sci.created_by
         WHERE sci.stock_checker_id = ? AND sci.branch_id = ?`,
        [stock_checker_id, branch_id],
        (err, rows) => {
          if (err) return reject(err);
          const r = rows && rows[0];
          resolve(r ? this.mapItemRow(r) : null);
        }
      );
    });
  }

  getItemCountByStockCheckerId(stock_checker_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT COUNT(*) AS cnt FROM ${TABLE_ITEMS} WHERE stock_checker_id = ?`,
        [stock_checker_id],
        (err, rows) => {
          if (err) return reject(err);
          const r = rows && rows[0];
          resolve(r ? Number(r.cnt) : 0);
        }
      );
    });
  }

  upsertItem(data) {
    return new Promise((resolve, reject) => {
      const isVerified = data.is_verified === true ? 1 : 0;
      this.db.query(
        `INSERT INTO ${TABLE_ITEMS} (stock_checker_id, branch_id, physical_stock, system_stock, created_by, is_verified)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           physical_stock = VALUES(physical_stock),
           system_stock = VALUES(system_stock),
           created_by = VALUES(created_by),
           is_verified = VALUES(is_verified),
           updated_at = CURRENT_TIMESTAMP`,
        [
          data.stock_checker_id,
          data.branch_id,
          data.physical_stock,
          data.system_stock,
          data.created_by,
          isVerified
        ],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.STOCK_CHECKER",
              code: "REPOSITORY.STOCK_CHECKER.UPSERT_ITEM",
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
        .map(() => "(?, ?, ?, ?, ?, ?)")
        .join(", ");
      const values = items.flatMap((d) => [
        d.stock_checker_id,
        d.branch_id,
        d.physical_stock,
        d.system_stock,
        d.created_by,
        d.is_verified === true ? 1 : 0
      ]);
      this.db.query(
        `INSERT INTO ${TABLE_ITEMS} (stock_checker_id, branch_id, physical_stock, system_stock, created_by, is_verified)
         VALUES ${placeholders}
         ON DUPLICATE KEY UPDATE
           physical_stock = VALUES(physical_stock),
           system_stock = VALUES(system_stock),
           created_by = VALUES(created_by),
           is_verified = VALUES(is_verified),
           updated_at = CURRENT_TIMESTAMP`,
        values,
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.STOCK_CHECKER",
              code: "REPOSITORY.STOCK_CHECKER.UPSERT_ITEMS_BATCH",
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

  deleteItem(stock_checker_id, branch_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `DELETE FROM ${TABLE_ITEMS} WHERE stock_checker_id = ? AND branch_id = ?`,
        [stock_checker_id, branch_id],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.STOCK_CHECKER",
              code: "REPOSITORY.STOCK_CHECKER.DELETE_ITEM",
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

  deleteItemsByStockCheckerId(stock_checker_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `DELETE FROM ${TABLE_ITEMS} WHERE stock_checker_id = ?`,
        [stock_checker_id],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.STOCK_CHECKER",
              code: "REPOSITORY.STOCK_CHECKER.DELETE_ITEMS_BY_STOCK_CHECKER_ID",
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
  return new StockCheckerRepository(db);
};
