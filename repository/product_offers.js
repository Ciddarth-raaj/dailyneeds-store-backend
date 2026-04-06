const logger = require("../utils/logger");

const TABLE = "product_offers";

const ALLOWED_UPDATE_KEYS = ["mrp", "selling_price", "opening_stock", "is_active"];

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

class ProductOffersRepository {
  constructor(db) {
    this.db = db;
  }

  getAll() {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT po.product_id, po.mrp, po.selling_price, po.opening_stock, po.stock_input, po.stock_output, po.is_active, po.created_at, po.updated_at,
                pt.gf_item_name
         FROM \`${TABLE}\` po
         LEFT JOIN product_table pt ON pt.product_id = po.product_id
         ORDER BY po.product_id ASC`,
        [],
        (err, rows) => {
          if (err) {
            logError("REPOSITORY.PRODUCT_OFFERS", "REPOSITORY.PRODUCT_OFFERS.GET_ALL", err.toString());
            return reject(err);
          }
          resolve(rows || []);
        }
      );
    });
  }

  getByProductId(product_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT po.product_id, po.mrp, po.selling_price, po.opening_stock, po.stock_input, po.stock_output, po.is_active, po.created_at, po.updated_at,
                pt.gf_item_name
         FROM \`${TABLE}\` po
         LEFT JOIN product_table pt ON pt.product_id = po.product_id
         WHERE po.product_id = ?`,
        [product_id],
        (err, rows) => {
          if (err) {
            logError("REPOSITORY.PRODUCT_OFFERS", "REPOSITORY.PRODUCT_OFFERS.GET_BY_PRODUCT_ID", err.toString(), { product_id });
            return reject(err);
          }
          resolve(rows && rows[0] ? rows[0] : null);
        }
      );
    });
  }

  listOffersStockByProductIds(product_ids) {
    return new Promise((resolve, reject) => {
      if (!Array.isArray(product_ids) || product_ids.length === 0) {
        resolve([]);
        return;
      }
      const ph = product_ids.map(() => "?").join(", ");
      this.db.query(
        `SELECT po.product_id, po.stock_input, po.stock_output, pt.gf_item_name
         FROM \`${TABLE}\` po
         LEFT JOIN product_table pt ON pt.product_id = po.product_id
         WHERE po.product_id IN (${ph})`,
        product_ids,
        (err, rows) => {
          if (err) {
            logError(
              "REPOSITORY.PRODUCT_OFFERS",
              "REPOSITORY.PRODUCT_OFFERS.LIST_STOCK_BY_PRODUCT_IDS",
              err.toString(),
              {}
            );
            return reject(err);
          }
          resolve(rows || []);
        }
      );
    });
  }

  create(data) {
    return new Promise((resolve, reject) => {
      const mrp = data.mrp !== undefined && data.mrp !== null ? data.mrp : null;
      const selling_price = data.selling_price !== undefined && data.selling_price !== null ? data.selling_price : null;
      const is_active = data.is_active !== undefined ? (data.is_active ? 1 : 0) : 1;
      let opening_stock =
        data.opening_stock !== undefined && data.opening_stock !== null ? data.opening_stock : 0;
      if (!is_active) {
        opening_stock = 0;
      }
      this.db.query(
        `INSERT INTO \`${TABLE}\` (product_id, mrp, selling_price, opening_stock, is_active) VALUES (?, ?, ?, ?, ?)`,
        [data.product_id, mrp, selling_price, opening_stock, is_active],
        (err, res) => {
          if (err) {
            if (err.code === "ER_DUP_ENTRY") {
              resolve({ code: 400, msg: "Duplicate product_id: offer already exists for this product" });
              return;
            }
            logError("REPOSITORY.PRODUCT_OFFERS", "REPOSITORY.PRODUCT_OFFERS.CREATE", err.toString());
            return reject(err);
          }
          resolve({ code: 200, product_id: data.product_id });
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
        const mrp = r.mrp !== undefined && r.mrp !== null ? r.mrp : null;
        const selling_price = r.selling_price !== undefined && r.selling_price !== null ? r.selling_price : null;
        const is_active = r.is_active !== undefined ? (r.is_active ? 1 : 0) : 1;
        let opening_stock =
          r.opening_stock !== undefined && r.opening_stock !== null ? r.opening_stock : 0;
        if (!is_active) {
          opening_stock = 0;
        }
        return [r.product_id, mrp, selling_price, opening_stock, is_active];
      });
      const placeholders = values.map(() => "(?, ?, ?, ?, ?)").join(", ");
      const flat = values.flat();
      const sql = `INSERT INTO \`${TABLE}\` (product_id, mrp, selling_price, opening_stock, is_active) VALUES ${placeholders}
        ON DUPLICATE KEY UPDATE mrp = VALUES(mrp), selling_price = VALUES(selling_price),
          opening_stock = IF(VALUES(is_active) = 0, 0, VALUES(opening_stock)),
          stock_input = IF(VALUES(is_active) = 0, 0, stock_input),
          stock_output = IF(VALUES(is_active) = 0, 0, stock_output),
          is_active = VALUES(is_active), updated_at = CURRENT_TIMESTAMP`;
      this.db.query(sql, flat, (err, res) => {
        if (err) {
          logError("REPOSITORY.PRODUCT_OFFERS", "REPOSITORY.PRODUCT_OFFERS.BULK_INSERT", err.toString());
          return reject(err);
        }
        resolve({ code: 200, inserted: res.affectedRows });
      });
    });
  }

  update(product_id, data) {
    return new Promise((resolve, reject) => {
      const sets = ["updated_at = CURRENT_TIMESTAMP"];
      const values = [];
      const deactivate = data.is_active !== undefined && !data.is_active;
      ALLOWED_UPDATE_KEYS.forEach((key) => {
        if (data[key] === undefined) return;
        if (deactivate && key === "opening_stock") {
          return;
        }
        sets.push(`\`${key}\` = ?`);
        if (key === "is_active") {
          values.push(data[key] ? 1 : 0);
        } else if (key === "opening_stock") {
          const v = data[key];
          values.push(v === undefined || v === null ? 0 : v);
        } else {
          values.push(data[key] === undefined || data[key] === null ? null : data[key]);
        }
      });
      if (deactivate) {
        sets.push("`opening_stock` = 0", "`stock_input` = 0", "`stock_output` = 0");
      }
      if (values.length === 0 && !deactivate) {
        return resolve({ code: 200, affectedRows: 0 });
      }
      values.push(product_id);
      this.db.query(
        `UPDATE \`${TABLE}\` SET ${sets.join(", ")} WHERE product_id = ?`,
        values,
        (err, res) => {
          if (err) {
            logError("REPOSITORY.PRODUCT_OFFERS", "REPOSITORY.PRODUCT_OFFERS.UPDATE", err.toString(), { product_id });
            return reject(err);
          }
          resolve({ code: 200, affectedRows: res.affectedRows });
        }
      );
    });
  }

  delete(product_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `DELETE FROM \`${TABLE}\` WHERE product_id = ?`,
        [product_id],
        (err, res) => {
          if (err) return reject(err);
          resolve({ code: 200, affectedRows: res.affectedRows });
        }
      );
    });
  }

  bulkDelete(product_ids) {
    return new Promise((resolve, reject) => {
      if (!Array.isArray(product_ids) || product_ids.length === 0) {
        resolve({ code: 200, affectedRows: 0 });
        return;
      }
      const placeholders = product_ids.map(() => "?").join(",");
      this.db.query(
        `DELETE FROM \`${TABLE}\` WHERE product_id IN (${placeholders})`,
        product_ids,
        (err, res) => {
          if (err) {
            logError("REPOSITORY.PRODUCT_OFFERS", "REPOSITORY.PRODUCT_OFFERS.BULK_DELETE", err.toString());
            return reject(err);
          }
          resolve({ code: 200, affectedRows: res.affectedRows });
        }
      );
    });
  }
}

module.exports = (db) => {
  return new ProductOffersRepository(db);
};
