const logger = require("../utils/logger");

const ITEM_TABLE = "offers_v3_item";
const BATCH_TABLE = "offers_v3_batch";
const STOCK_TABLE = "offers_v3_batch_stock";
const UNTAGGED_TABLE = "offers_v3_untagged_batches";
const PRICE_TABLE = "price_checker_items";

const ITEM_SELECT = `oi.id, oi.item_code, pt.de_name AS item_name, oi.offer_type, oi.value,
                oi.status, oi.created_by, COALESCE(ne.employee_name, '') AS created_by_name,
                oi.created_at, oi.updated_at`;
const ITEM_JOINS = `LEFT JOIN product_table pt ON pt.product_id = oi.item_code
                LEFT JOIN new_employee ne ON ne.employee_id = oi.created_by`;

const BATCH_SELECT = `ob.id, ob.item_code, pt.de_name AS item_name, ob.outlet_id, o.outlet_name,
                ob.batch_no, ob.offer_type, ob.value, ob.status, ob.created_by,
                COALESCE(ne.employee_name, '') AS created_by_name, ob.created_at, ob.updated_at`;
const BATCH_JOINS = `LEFT JOIN product_table pt ON pt.product_id = ob.item_code
                LEFT JOIN outlets o ON o.outlet_id = ob.outlet_id
                LEFT JOIN new_employee ne ON ne.employee_id = ob.created_by`;

const ITEM_ACTIVE_STATUSES = ["active"];
const BATCH_OCCUPYING_STATUSES = ["active", "zero_stock_flagged"];

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

  // ---------------------------------------------------------------------
  // Item-level offers
  // ---------------------------------------------------------------------

  listItemOffers({ status } = {}) {
    return new Promise((resolve, reject) => {
      const where = [];
      const params = [];
      if (status) {
        where.push("oi.status = ?");
        params.push(status);
      }
      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
      this.db.query(
        `SELECT ${ITEM_SELECT} FROM \`${ITEM_TABLE}\` oi ${ITEM_JOINS} ${whereSql} ORDER BY oi.id DESC`,
        params,
        (err, rows) => {
          if (err) {
            logError("REPOSITORY.OFFERS_V3", "REPOSITORY.OFFERS_V3.LIST_ITEM_OFFERS", err.toString());
            return reject(err);
          }
          resolve(rows || []);
        }
      );
    });
  }

  getItemOfferById(id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT ${ITEM_SELECT} FROM \`${ITEM_TABLE}\` oi ${ITEM_JOINS} WHERE oi.id = ?`,
        [id],
        (err, rows) => {
          if (err) {
            logError("REPOSITORY.OFFERS_V3", "REPOSITORY.OFFERS_V3.GET_ITEM_OFFER", err.toString(), { id });
            return reject(err);
          }
          resolve(rows && rows[0] ? rows[0] : null);
        }
      );
    });
  }

  getActiveItemOfferByItemCode(item_code) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT ${ITEM_SELECT} FROM \`${ITEM_TABLE}\` oi ${ITEM_JOINS}
         WHERE oi.item_code = ? AND oi.status IN (${ITEM_ACTIVE_STATUSES.map(() => "?").join(",")})
         LIMIT 1`,
        [item_code, ...ITEM_ACTIVE_STATUSES],
        (err, rows) => {
          if (err) {
            logError(
              "REPOSITORY.OFFERS_V3",
              "REPOSITORY.OFFERS_V3.GET_ACTIVE_ITEM_OFFER",
              err.toString(),
              { item_code }
            );
            return reject(err);
          }
          resolve(rows && rows[0] ? rows[0] : null);
        }
      );
    });
  }

  createItemOffer(data) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `INSERT INTO \`${ITEM_TABLE}\` (item_code, offer_type, value, status, created_by) VALUES (?, ?, ?, ?, ?)`,
        [data.item_code, data.offer_type, data.value, data.status || "active", data.created_by ?? null],
        (err, res) => {
          if (err) {
            logError("REPOSITORY.OFFERS_V3", "REPOSITORY.OFFERS_V3.CREATE_ITEM_OFFER", err.toString());
            return reject(err);
          }
          resolve({ code: 200, id: res.insertId });
        }
      );
    });
  }

  updateItemOffer(id, data) {
    return new Promise((resolve, reject) => {
      const keys = ["offer_type", "value", "status"].filter((k) => data[k] !== undefined);
      if (keys.length === 0) {
        return resolve({ code: 200, affectedRows: 0 });
      }
      const sets = ["updated_at = CURRENT_TIMESTAMP", ...keys.map((k) => `\`${k}\` = ?`)];
      const values = [...keys.map((k) => data[k]), id];
      this.db.query(
        `UPDATE \`${ITEM_TABLE}\` SET ${sets.join(", ")} WHERE id = ?`,
        values,
        (err, res) => {
          if (err) {
            logError("REPOSITORY.OFFERS_V3", "REPOSITORY.OFFERS_V3.UPDATE_ITEM_OFFER", err.toString(), { id });
            return reject(err);
          }
          resolve({ code: 200, affectedRows: res.affectedRows });
        }
      );
    });
  }

  // ---------------------------------------------------------------------
  // Batch-specific offers
  // ---------------------------------------------------------------------

  listBatchOffers({ status, item_code, outlet_id } = {}) {
    return new Promise((resolve, reject) => {
      const where = [];
      const params = [];
      if (status) {
        where.push("ob.status = ?");
        params.push(status);
      }
      if (item_code) {
        where.push("ob.item_code = ?");
        params.push(item_code);
      }
      if (outlet_id) {
        where.push("ob.outlet_id = ?");
        params.push(outlet_id);
      }
      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
      this.db.query(
        `SELECT ${BATCH_SELECT} FROM \`${BATCH_TABLE}\` ob ${BATCH_JOINS} ${whereSql} ORDER BY ob.id DESC`,
        params,
        (err, rows) => {
          if (err) {
            logError("REPOSITORY.OFFERS_V3", "REPOSITORY.OFFERS_V3.LIST_BATCH_OFFERS", err.toString());
            return reject(err);
          }
          resolve(rows || []);
        }
      );
    });
  }

  getBatchOfferById(id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT ${BATCH_SELECT} FROM \`${BATCH_TABLE}\` ob ${BATCH_JOINS} WHERE ob.id = ?`,
        [id],
        (err, rows) => {
          if (err) {
            logError("REPOSITORY.OFFERS_V3", "REPOSITORY.OFFERS_V3.GET_BATCH_OFFER", err.toString(), { id });
            return reject(err);
          }
          resolve(rows && rows[0] ? rows[0] : null);
        }
      );
    });
  }

  getActiveBatchOffersByItemCode(item_code) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT ${BATCH_SELECT} FROM \`${BATCH_TABLE}\` ob ${BATCH_JOINS}
         WHERE ob.item_code = ? AND ob.status IN (${BATCH_OCCUPYING_STATUSES.map(() => "?").join(",")})`,
        [item_code, ...BATCH_OCCUPYING_STATUSES],
        (err, rows) => {
          if (err) {
            logError(
              "REPOSITORY.OFFERS_V3",
              "REPOSITORY.OFFERS_V3.GET_ACTIVE_BATCH_OFFERS",
              err.toString(),
              { item_code }
            );
            return reject(err);
          }
          resolve(rows || []);
        }
      );
    });
  }

  findOccupyingBatchOffer(item_code, outlet_id, batch_no) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT ${BATCH_SELECT} FROM \`${BATCH_TABLE}\` ob ${BATCH_JOINS}
         WHERE ob.item_code = ? AND ob.outlet_id = ? AND ob.batch_no = ?
           AND ob.status IN (${BATCH_OCCUPYING_STATUSES.map(() => "?").join(",")})
         LIMIT 1`,
        [item_code, outlet_id, batch_no, ...BATCH_OCCUPYING_STATUSES],
        (err, rows) => {
          if (err) {
            logError(
              "REPOSITORY.OFFERS_V3",
              "REPOSITORY.OFFERS_V3.FIND_OCCUPYING_BATCH_OFFER",
              err.toString(),
              { item_code, outlet_id, batch_no }
            );
            return reject(err);
          }
          resolve(rows && rows[0] ? rows[0] : null);
        }
      );
    });
  }

  createBatchOffer(data) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `INSERT INTO \`${BATCH_TABLE}\` (item_code, outlet_id, batch_no, offer_type, value, status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          data.item_code,
          data.outlet_id,
          data.batch_no,
          data.offer_type,
          data.value,
          data.status || "active",
          data.created_by ?? null,
        ],
        (err, res) => {
          if (err) {
            logError("REPOSITORY.OFFERS_V3", "REPOSITORY.OFFERS_V3.CREATE_BATCH_OFFER", err.toString());
            return reject(err);
          }
          resolve({ code: 200, id: res.insertId });
        }
      );
    });
  }

  updateBatchOffer(id, data) {
    return new Promise((resolve, reject) => {
      const keys = ["offer_type", "value", "status"].filter((k) => data[k] !== undefined);
      if (keys.length === 0) {
        return resolve({ code: 200, affectedRows: 0 });
      }
      const sets = ["updated_at = CURRENT_TIMESTAMP", ...keys.map((k) => `\`${k}\` = ?`)];
      const values = [...keys.map((k) => data[k]), id];
      this.db.query(
        `UPDATE \`${BATCH_TABLE}\` SET ${sets.join(", ")} WHERE id = ?`,
        values,
        (err, res) => {
          if (err) {
            logError("REPOSITORY.OFFERS_V3", "REPOSITORY.OFFERS_V3.UPDATE_BATCH_OFFER", err.toString(), { id });
            return reject(err);
          }
          resolve({ code: 200, affectedRows: res.affectedRows });
        }
      );
    });
  }

  // ---------------------------------------------------------------------
  // Price lookups (price_checker_items — latest uploaded outlet/batch pricing)
  // ---------------------------------------------------------------------

  getMrpsForItem(item_code) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT DISTINCT COALESCE(new_mrp, old_mrp) AS mrp
         FROM \`${PRICE_TABLE}\`
         WHERE product_id = ? AND COALESCE(new_mrp, old_mrp) IS NOT NULL`,
        [item_code],
        (err, rows) => {
          if (err) {
            logError("REPOSITORY.OFFERS_V3", "REPOSITORY.OFFERS_V3.GET_MRPS_FOR_ITEM", err.toString(), { item_code });
            return reject(err);
          }
          resolve((rows || []).map((r) => Number(r.mrp)));
        }
      );
    });
  }

  getPriceForBatch(item_code, outlet_id, batch_no) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT product_id, outlet_id, batch_no,
                COALESCE(new_mrp, old_mrp) AS mrp,
                COALESCE(new_selling_price, old_selling_price) AS selling_price
         FROM \`${PRICE_TABLE}\`
         WHERE product_id = ? AND outlet_id = ? AND batch_no = ?
         ORDER BY id DESC LIMIT 1`,
        [item_code, outlet_id, batch_no],
        (err, rows) => {
          if (err) {
            logError(
              "REPOSITORY.OFFERS_V3",
              "REPOSITORY.OFFERS_V3.GET_PRICE_FOR_BATCH",
              err.toString(),
              { item_code, outlet_id, batch_no }
            );
            return reject(err);
          }
          resolve(rows && rows[0] ? rows[0] : null);
        }
      );
    });
  }

  getPricesForItem(item_code) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT pci.product_id, pci.outlet_id, o.outlet_name, pci.batch_no,
                COALESCE(pci.new_mrp, pci.old_mrp) AS mrp,
                COALESCE(pci.new_selling_price, pci.old_selling_price) AS selling_price
         FROM \`${PRICE_TABLE}\` pci
         LEFT JOIN outlets o ON o.outlet_id = pci.outlet_id
         WHERE pci.product_id = ?`,
        [item_code],
        (err, rows) => {
          if (err) {
            logError("REPOSITORY.OFFERS_V3", "REPOSITORY.OFFERS_V3.GET_PRICES_FOR_ITEM", err.toString(), { item_code });
            return reject(err);
          }
          resolve(rows || []);
        }
      );
    });
  }

  // ---------------------------------------------------------------------
  // Batch stock uploads
  // ---------------------------------------------------------------------

  upsertBatchStock(rows) {
    return new Promise((resolve, reject) => {
      if (!Array.isArray(rows) || rows.length === 0) {
        resolve({ code: 200, upserted: 0 });
        return;
      }
      const values = rows.map((r) => [r.item_code, r.outlet_id, r.batch_no, r.stock_qty]);
      const placeholders = values.map(() => "(?, ?, ?, ?)").join(", ");
      const flat = values.flat();
      const sql = `INSERT INTO \`${STOCK_TABLE}\` (item_code, outlet_id, batch_no, stock_qty) VALUES ${placeholders}
        ON DUPLICATE KEY UPDATE stock_qty = VALUES(stock_qty), uploaded_at = CURRENT_TIMESTAMP`;
      this.db.query(sql, flat, (err, res) => {
        if (err) {
          logError("REPOSITORY.OFFERS_V3", "REPOSITORY.OFFERS_V3.UPSERT_BATCH_STOCK", err.toString());
          return reject(err);
        }
        resolve({ code: 200, upserted: rows.length, affectedRows: res.affectedRows });
      });
    });
  }

  // ---------------------------------------------------------------------
  // Untagged-batch alerts
  // ---------------------------------------------------------------------

  listUntaggedBatches(status) {
    return new Promise((resolve, reject) => {
      const where = status ? "WHERE ub.status = ?" : "";
      const params = status ? [status] : [];
      this.db.query(
        `SELECT ub.id, ub.item_code, pt.de_name AS item_name, ub.outlet_id, o.outlet_name,
                ub.batch_no, ub.status, ub.detected_at
         FROM \`${UNTAGGED_TABLE}\` ub
         LEFT JOIN product_table pt ON pt.product_id = ub.item_code
         LEFT JOIN outlets o ON o.outlet_id = ub.outlet_id
         ${where}
         ORDER BY ub.detected_at DESC`,
        params,
        (err, rows) => {
          if (err) {
            logError("REPOSITORY.OFFERS_V3", "REPOSITORY.OFFERS_V3.LIST_UNTAGGED_BATCHES", err.toString());
            return reject(err);
          }
          resolve(rows || []);
        }
      );
    });
  }

  upsertUntaggedBatchAlert(item_code, outlet_id, batch_no) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `INSERT INTO \`${UNTAGGED_TABLE}\` (item_code, outlet_id, batch_no, status) VALUES (?, ?, ?, 'pending')
         ON DUPLICATE KEY UPDATE status = 'pending', detected_at = CURRENT_TIMESTAMP`,
        [item_code, outlet_id, batch_no],
        (err) => {
          if (err) {
            logError(
              "REPOSITORY.OFFERS_V3",
              "REPOSITORY.OFFERS_V3.UPSERT_UNTAGGED_BATCH_ALERT",
              err.toString(),
              { item_code, outlet_id, batch_no }
            );
            return reject(err);
          }
          resolve({ code: 200 });
        }
      );
    });
  }

  resolveUntaggedBatchAlertByKey(item_code, outlet_id, batch_no) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `DELETE FROM \`${UNTAGGED_TABLE}\` WHERE item_code = ? AND outlet_id = ? AND batch_no = ?`,
        [item_code, outlet_id, batch_no],
        (err, res) => {
          if (err) {
            logError(
              "REPOSITORY.OFFERS_V3",
              "REPOSITORY.OFFERS_V3.RESOLVE_UNTAGGED_BATCH_ALERT_BY_KEY",
              err.toString(),
              { item_code, outlet_id, batch_no }
            );
            return reject(err);
          }
          resolve({ code: 200, affectedRows: res.affectedRows });
        }
      );
    });
  }

  dismissUntaggedBatchAlert(id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `UPDATE \`${UNTAGGED_TABLE}\` SET status = 'dismissed' WHERE id = ?`,
        [id],
        (err, res) => {
          if (err) {
            logError("REPOSITORY.OFFERS_V3", "REPOSITORY.OFFERS_V3.DISMISS_UNTAGGED_BATCH_ALERT", err.toString(), { id });
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

module.exports.BATCH_OCCUPYING_STATUSES = BATCH_OCCUPYING_STATUSES;
