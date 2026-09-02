const logger = require("../utils/logger");

const ITEM_TABLE = "offers_v3_item";
const BATCH_TABLE = "offers_v3_batch";
const DATA_TABLE = "offers_v3_batch_data";
const UNTAGGED_TABLE = "offers_v3_untagged_batches";
const LOW_STOCK_TABLE = "offers_v3_low_stock_warnings";
const UPLOAD_META_TABLE = "offers_v3_upload_meta";

const ITEM_SELECT = `oi.id, oi.item_code, pt.de_name AS item_name, oi.offer_type, oi.value,
                oi.threshold_qty, oi.status, oi.created_by, COALESCE(ne.employee_name, '') AS created_by_name,
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

// Large uploads (tens of thousands of rows) are processed in chunks so no
// single query's parameter list / statement size can grow unbounded.
const BULK_CHUNK_SIZE = 1000;

function chunk(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

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

  // Bulk variant for stock-upload low-stock detection: returns a Map of
  // item_code -> threshold_qty for items (from the given list) that
  // currently have an active item-level offer.
  async getActiveItemOfferThresholds(itemCodes) {
    const uniqueCodes = [...new Set(itemCodes)];
    if (uniqueCodes.length === 0) return new Map();
    const map = new Map();
    for (const batch of chunk(uniqueCodes, BULK_CHUNK_SIZE)) {
      const placeholders = batch.map(() => "?").join(",");
      try {
        const rows = await this._queryAsync(
          `SELECT item_code, threshold_qty FROM \`${ITEM_TABLE}\` WHERE item_code IN (${placeholders}) AND status IN (${ITEM_ACTIVE_STATUSES.map(() => "?").join(",")})`,
          [...batch, ...ITEM_ACTIVE_STATUSES]
        );
        (rows || []).forEach((r) => map.set(r.item_code, r.threshold_qty));
      } catch (err) {
        logError("REPOSITORY.OFFERS_V3", "REPOSITORY.OFFERS_V3.GET_ACTIVE_ITEM_OFFER_THRESHOLDS", err.toString());
        throw err;
      }
    }
    return map;
  }

  createItemOffer(data) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `INSERT INTO \`${ITEM_TABLE}\` (item_code, offer_type, value, threshold_qty, status, created_by) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          data.item_code,
          data.offer_type,
          data.value,
          data.threshold_qty,
          data.status || "active",
          data.created_by ?? null,
        ],
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
      const keys = ["offer_type", "value", "threshold_qty", "status"].filter((k) => data[k] !== undefined);
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

  _queryAsync(sql, params) {
    return new Promise((resolve, reject) => {
      this.db.query(sql, params, (err, res) => (err ? reject(err) : resolve(res)));
    });
  }

  // Bulk variant of findOccupyingBatchOffer for large uploads: a handful of
  // chunked queries instead of one per row. Returns a Map keyed by
  // "item_code|outlet_id|batch_no".
  async findOccupyingBatchOffersByKeys(keys) {
    if (!Array.isArray(keys) || keys.length === 0) return new Map();
    const map = new Map();
    const statusPlaceholders = BATCH_OCCUPYING_STATUSES.map(() => "?").join(",");
    for (const batch of chunk(keys, BULK_CHUNK_SIZE)) {
      const tuplePlaceholders = batch.map(() => "(?, ?, ?)").join(", ");
      const tupleParams = batch.flatMap((k) => [k.item_code, k.outlet_id, k.batch_no]);
      try {
        const rows = await this._queryAsync(
          `SELECT ${BATCH_SELECT} FROM \`${BATCH_TABLE}\` ob ${BATCH_JOINS}
           WHERE (ob.item_code, ob.outlet_id, ob.batch_no) IN (${tuplePlaceholders})
             AND ob.status IN (${statusPlaceholders})`,
          [...tupleParams, ...BATCH_OCCUPYING_STATUSES]
        );
        (rows || []).forEach((r) => map.set(`${r.item_code}|${r.outlet_id}|${r.batch_no}`, r));
      } catch (err) {
        logError("REPOSITORY.OFFERS_V3", "REPOSITORY.OFFERS_V3.FIND_OCCUPYING_BATCH_OFFERS_BY_KEYS", err.toString());
        throw err;
      }
    }
    return map;
  }

  // Bulk variant of getActiveBatchOffersByItemCode: returns the Set of
  // item_codes (from the given list) that currently have at least one
  // occupying batch-specific offer.
  async getItemCodesWithActiveBatchOffers(itemCodes) {
    const uniqueCodes = [...new Set(itemCodes)];
    if (uniqueCodes.length === 0) return new Set();
    const set = new Set();
    for (const batch of chunk(uniqueCodes, BULK_CHUNK_SIZE)) {
      const placeholders = batch.map(() => "?").join(",");
      try {
        const rows = await this._queryAsync(
          `SELECT DISTINCT item_code FROM \`${BATCH_TABLE}\` WHERE item_code IN (${placeholders}) AND status IN (${BATCH_OCCUPYING_STATUSES.map(() => "?").join(",")})`,
          [...batch, ...BATCH_OCCUPYING_STATUSES]
        );
        (rows || []).forEach((r) => set.add(r.item_code));
      } catch (err) {
        logError("REPOSITORY.OFFERS_V3", "REPOSITORY.OFFERS_V3.GET_ITEM_CODES_WITH_ACTIVE_BATCH_OFFERS", err.toString());
        throw err;
      }
    }
    return set;
  }

  // Union of item_codes (from the given list) that currently have an active
  // item-level offer or an occupying batch-specific offer. Used by other
  // features (e.g. Price Checker export) to mark items as carrying an
  // Offers V3 offer, without needing to know which scope it's in.
  async getItemCodesWithAnyActiveOffer(itemCodes) {
    const uniqueCodes = [...new Set(itemCodes)];
    if (uniqueCodes.length === 0) return new Set();
    const set = new Set();
    for (const batch of chunk(uniqueCodes, BULK_CHUNK_SIZE)) {
      const placeholders = batch.map(() => "?").join(",");
      try {
        const rows = await this._queryAsync(
          `SELECT item_code FROM \`${ITEM_TABLE}\` WHERE item_code IN (${placeholders}) AND status = 'active'
           UNION
           SELECT item_code FROM \`${BATCH_TABLE}\` WHERE item_code IN (${placeholders}) AND status IN (${BATCH_OCCUPYING_STATUSES.map(() => "?").join(",")})`,
          [...batch, ...batch, ...BATCH_OCCUPYING_STATUSES]
        );
        (rows || []).forEach((r) => set.add(r.item_code));
      } catch (err) {
        logError("REPOSITORY.OFFERS_V3", "REPOSITORY.OFFERS_V3.GET_ITEM_CODES_WITH_ANY_ACTIVE_OFFER", err.toString());
        throw err;
      }
    }
    return set;
  }

  // Bulk variant returning the offer_type/value of each active item-level
  // or occupying batch-specific offer (from the given item codes), for a
  // hover-tooltip summary alongside the Offer badge.
  async listActiveOfferDetailsForItemCodes(itemCodes) {
    const uniqueCodes = [...new Set(itemCodes)];
    if (uniqueCodes.length === 0) return [];
    const details = [];
    for (const batch of chunk(uniqueCodes, BULK_CHUNK_SIZE)) {
      const placeholders = batch.map(() => "?").join(",");
      try {
        const itemRows = await this._queryAsync(
          `SELECT item_code, offer_type, value FROM \`${ITEM_TABLE}\`
           WHERE item_code IN (${placeholders}) AND status IN (${ITEM_ACTIVE_STATUSES.map(() => "?").join(",")})`,
          [...batch, ...ITEM_ACTIVE_STATUSES]
        );
        (itemRows || []).forEach((r) =>
          details.push({
            item_code: r.item_code,
            scope: "item",
            offer_type: r.offer_type,
            value: r.value,
          })
        );

        const batchRows = await this._queryAsync(
          `SELECT item_code, offer_type, value FROM \`${BATCH_TABLE}\`
           WHERE item_code IN (${placeholders}) AND status IN (${BATCH_OCCUPYING_STATUSES.map(() => "?").join(",")})`,
          [...batch, ...BATCH_OCCUPYING_STATUSES]
        );
        (batchRows || []).forEach((r) =>
          details.push({
            item_code: r.item_code,
            scope: "batch",
            offer_type: r.offer_type,
            value: r.value,
          })
        );
      } catch (err) {
        logError("REPOSITORY.OFFERS_V3", "REPOSITORY.OFFERS_V3.LIST_ACTIVE_OFFER_DETAILS_FOR_ITEM_CODES", err.toString());
        throw err;
      }
    }
    return details;
  }

  // Bulk upsert of untagged-batch alerts (used after a large upload instead
  // of one INSERT per detected batch).
  async upsertUntaggedBatchAlerts(keys) {
    if (!Array.isArray(keys) || keys.length === 0) return { code: 200, upserted: 0 };
    for (const batch of chunk(keys, BULK_CHUNK_SIZE)) {
      const placeholders = batch.map(() => "(?, ?, ?, 'pending')").join(", ");
      const params = batch.flatMap((k) => [k.item_code, k.outlet_id, k.batch_no]);
      try {
        await this._queryAsync(
          `INSERT INTO \`${UNTAGGED_TABLE}\` (item_code, outlet_id, batch_no, status) VALUES ${placeholders}
           ON DUPLICATE KEY UPDATE status = 'pending', detected_at = CURRENT_TIMESTAMP`,
          params
        );
      } catch (err) {
        logError("REPOSITORY.OFFERS_V3", "REPOSITORY.OFFERS_V3.UPSERT_UNTAGGED_BATCH_ALERTS", err.toString());
        throw err;
      }
    }
    return { code: 200, upserted: keys.length };
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

  // Bulk status update (used to flag/revert many batch offers from one
  // stock upload in chunked queries instead of one UPDATE per offer).
  async updateBatchOffersStatusByIds(ids, status) {
    if (!Array.isArray(ids) || ids.length === 0) return { code: 200, affectedRows: 0 };
    let affectedRows = 0;
    for (const idsBatch of chunk(ids, BULK_CHUNK_SIZE)) {
      const placeholders = idsBatch.map(() => "?").join(",");
      try {
        const res = await this._queryAsync(
          `UPDATE \`${BATCH_TABLE}\` SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`,
          [status, ...idsBatch]
        );
        affectedRows += res.affectedRows;
      } catch (err) {
        logError("REPOSITORY.OFFERS_V3", "REPOSITORY.OFFERS_V3.UPDATE_BATCH_OFFERS_STATUS_BY_IDS", err.toString());
        throw err;
      }
    }
    return { code: 200, affectedRows };
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
  // Price lookups (offers_v3_batch_data — latest uploaded outlet/batch pricing)
  // ---------------------------------------------------------------------

  getMrpsForItem(item_code) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT DISTINCT mrp
         FROM \`${DATA_TABLE}\`
         WHERE item_code = ? AND mrp IS NOT NULL`,
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
        `SELECT item_code, outlet_id, batch_no, mrp, selling_price, landing_cost, stock_qty
         FROM \`${DATA_TABLE}\`
         WHERE item_code = ? AND outlet_id = ? AND batch_no = ?`,
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
        `SELECT bd.item_code, bd.outlet_id, o.outlet_name, bd.batch_no, bd.mrp, bd.selling_price, bd.landing_cost, bd.stock_qty
         FROM \`${DATA_TABLE}\` bd
         LEFT JOIN outlets o ON o.outlet_id = bd.outlet_id
         WHERE bd.item_code = ?`,
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

  // Stock upload: touches only stock_qty/stock_uploaded_at. Inserts a new row
  // (price columns left NULL) if this item/outlet/batch has never been seen.
  async upsertBatchStock(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return { code: 200, upserted: 0 };
    for (const batch of chunk(rows, BULK_CHUNK_SIZE)) {
      const values = batch.map((r) => [r.item_code, r.outlet_id, r.batch_no, r.stock_qty]);
      const placeholders = values.map(() => "(?, ?, ?, ?, CURRENT_TIMESTAMP)").join(", ");
      const flat = values.flat();
      try {
        await this._queryAsync(
          `INSERT INTO \`${DATA_TABLE}\` (item_code, outlet_id, batch_no, stock_qty, stock_uploaded_at) VALUES ${placeholders}
           ON DUPLICATE KEY UPDATE stock_qty = VALUES(stock_qty), stock_uploaded_at = VALUES(stock_uploaded_at)`,
          flat
        );
      } catch (err) {
        logError("REPOSITORY.OFFERS_V3", "REPOSITORY.OFFERS_V3.UPSERT_BATCH_STOCK", err.toString());
        throw err;
      }
    }
    return { code: 200, upserted: rows.length };
  }

  // Price upload: touches only mrp/selling_price/price_uploaded_at. Inserts a
  // new row (stock columns left NULL) if this item/outlet/batch has never been
  // seen; never touches stock_qty on an existing row.
  // landing_cost is optional per row; when a row omits it (null), the
  // existing stored value is kept rather than being wiped out by a re-upload
  // that doesn't carry that column.
  async upsertBatchPrice(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return { code: 200, upserted: 0 };
    for (const batch of chunk(rows, BULK_CHUNK_SIZE)) {
      const values = batch.map((r) => [
        r.item_code,
        r.outlet_id,
        r.batch_no,
        r.mrp,
        r.selling_price,
        r.landing_cost ?? null,
      ]);
      const placeholders = values.map(() => "(?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)").join(", ");
      const flat = values.flat();
      try {
        await this._queryAsync(
          `INSERT INTO \`${DATA_TABLE}\` (item_code, outlet_id, batch_no, mrp, selling_price, landing_cost, price_uploaded_at) VALUES ${placeholders}
           ON DUPLICATE KEY UPDATE mrp = VALUES(mrp), selling_price = VALUES(selling_price),
             landing_cost = IFNULL(VALUES(landing_cost), landing_cost), price_uploaded_at = VALUES(price_uploaded_at)`,
          flat
        );
      } catch (err) {
        logError("REPOSITORY.OFFERS_V3", "REPOSITORY.OFFERS_V3.UPSERT_BATCH_PRICE", err.toString());
        throw err;
      }
    }
    return { code: 200, upserted: rows.length };
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

  dismissAllUntaggedBatches() {
    return new Promise((resolve, reject) => {
      this.db.query(
        `UPDATE \`${UNTAGGED_TABLE}\` SET status = 'dismissed' WHERE status = 'pending'`,
        [],
        (err, res) => {
          if (err) {
            logError("REPOSITORY.OFFERS_V3", "REPOSITORY.OFFERS_V3.DISMISS_ALL_UNTAGGED_BATCHES", err.toString());
            return reject(err);
          }
          resolve({ code: 200, affectedRows: res.affectedRows });
        }
      );
    });
  }

  // ---------------------------------------------------------------------
  // Low-stock warnings (item-level offers only)
  // ---------------------------------------------------------------------

  listLowStockWarnings(status) {
    return new Promise((resolve, reject) => {
      const where = status ? "WHERE lw.status = ?" : "";
      const params = status ? [status] : [];
      this.db.query(
        `SELECT lw.id, lw.item_code, pt.de_name AS item_name,
                lw.total_stock_qty, lw.threshold_qty, lw.status, lw.detected_at
         FROM \`${LOW_STOCK_TABLE}\` lw
         LEFT JOIN product_table pt ON pt.product_id = lw.item_code
         ${where}
         ORDER BY lw.detected_at DESC`,
        params,
        (err, rows) => {
          if (err) {
            logError("REPOSITORY.OFFERS_V3", "REPOSITORY.OFFERS_V3.LIST_LOW_STOCK_WARNINGS", err.toString());
            return reject(err);
          }
          resolve(rows || []);
        }
      );
    });
  }

  // Bulk upsert: one row per item whose stock, summed across every outlet
  // and batch, is at/under that item's threshold. Resurfaces a
  // previously-dismissed warning if the item's total drops low again.
  async upsertLowStockWarnings(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return { code: 200, upserted: 0 };
    for (const batch of chunk(rows, BULK_CHUNK_SIZE)) {
      const placeholders = batch.map(() => "(?, ?, ?, 'pending', CURRENT_TIMESTAMP)").join(", ");
      const params = batch.flatMap((r) => [r.item_code, r.total_stock_qty, r.threshold_qty]);
      try {
        await this._queryAsync(
          `INSERT INTO \`${LOW_STOCK_TABLE}\` (item_code, total_stock_qty, threshold_qty, status, detected_at) VALUES ${placeholders}
           ON DUPLICATE KEY UPDATE total_stock_qty = VALUES(total_stock_qty), threshold_qty = VALUES(threshold_qty), status = 'pending', detected_at = VALUES(detected_at)`,
          params
        );
      } catch (err) {
        logError("REPOSITORY.OFFERS_V3", "REPOSITORY.OFFERS_V3.UPSERT_LOW_STOCK_WARNINGS", err.toString());
        throw err;
      }
    }
    return { code: 200, upserted: rows.length };
  }

  // Bulk clear: an item's total stock (across all outlets/batches) is back
  // above threshold, or the offer is no longer active, so the warning no
  // longer applies.
  async clearLowStockWarningsByItemCodes(itemCodes) {
    if (!Array.isArray(itemCodes) || itemCodes.length === 0) return { code: 200, affectedRows: 0 };
    let affectedRows = 0;
    for (const batch of chunk(itemCodes, BULK_CHUNK_SIZE)) {
      const placeholders = batch.map(() => "?").join(",");
      try {
        const res = await this._queryAsync(
          `DELETE FROM \`${LOW_STOCK_TABLE}\` WHERE item_code IN (${placeholders})`,
          batch
        );
        affectedRows += res.affectedRows;
      } catch (err) {
        logError("REPOSITORY.OFFERS_V3", "REPOSITORY.OFFERS_V3.CLEAR_LOW_STOCK_WARNINGS_BY_ITEM_CODES", err.toString());
        throw err;
      }
    }
    return { code: 200, affectedRows };
  }

  // Sum of current stock_qty (from the latest stock upload) across every
  // outlet/batch of each item, for the given item_codes.
  async getTotalStockByItemCodes(itemCodes) {
    const uniqueCodes = [...new Set(itemCodes)];
    if (uniqueCodes.length === 0) return new Map();
    const map = new Map();
    for (const batch of chunk(uniqueCodes, BULK_CHUNK_SIZE)) {
      const placeholders = batch.map(() => "?").join(",");
      try {
        const rows = await this._queryAsync(
          `SELECT item_code, SUM(stock_qty) AS total_stock_qty FROM \`${DATA_TABLE}\`
           WHERE item_code IN (${placeholders}) AND stock_qty IS NOT NULL
           GROUP BY item_code`,
          batch
        );
        (rows || []).forEach((r) => map.set(r.item_code, Number(r.total_stock_qty)));
      } catch (err) {
        logError("REPOSITORY.OFFERS_V3", "REPOSITORY.OFFERS_V3.GET_TOTAL_STOCK_BY_ITEM_CODES", err.toString());
        throw err;
      }
    }
    return map;
  }

  dismissLowStockWarning(id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `UPDATE \`${LOW_STOCK_TABLE}\` SET status = 'dismissed' WHERE id = ?`,
        [id],
        (err, res) => {
          if (err) {
            logError("REPOSITORY.OFFERS_V3", "REPOSITORY.OFFERS_V3.DISMISS_LOW_STOCK_WARNING", err.toString(), { id });
            return reject(err);
          }
          resolve({ code: 200, affectedRows: res.affectedRows });
        }
      );
    });
  }

  // Used when an item-level offer is made inactive: its low-stock warnings
  // no longer apply to anything.
  clearLowStockWarningsByItemCode(item_code) {
    return new Promise((resolve, reject) => {
      this.db.query(`DELETE FROM \`${LOW_STOCK_TABLE}\` WHERE item_code = ?`, [item_code], (err, res) => {
        if (err) {
          logError(
            "REPOSITORY.OFFERS_V3",
            "REPOSITORY.OFFERS_V3.CLEAR_LOW_STOCK_WARNINGS_BY_ITEM_CODE",
            err.toString(),
            { item_code }
          );
          return reject(err);
        }
        resolve({ code: 200, affectedRows: res.affectedRows });
      });
    });
  }

  // ---------------------------------------------------------------------
  // Upload meta (rows/products/last-uploaded-at summary shown per upload type)
  // ---------------------------------------------------------------------

  async getUploadMeta() {
    const rows = await this._queryAsync(
      `SELECT upload_type, total_rows, total_products, uploaded_at, uploaded_by FROM \`${UPLOAD_META_TABLE}\``
    );
    const map = {};
    (rows || []).forEach((r) => {
      map[r.upload_type] = r;
    });
    return map;
  }

  async upsertUploadMeta(uploadType, { total_rows, total_products, uploaded_by }) {
    await this._queryAsync(
      `INSERT INTO \`${UPLOAD_META_TABLE}\` (upload_type, total_rows, total_products, uploaded_at, uploaded_by) VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?)
       ON DUPLICATE KEY UPDATE total_rows = VALUES(total_rows), total_products = VALUES(total_products),
         uploaded_at = VALUES(uploaded_at), uploaded_by = VALUES(uploaded_by)`,
      [uploadType, total_rows, total_products, uploaded_by ?? null]
    );
    return { code: 200 };
  }
}

module.exports = (db) => {
  return new OffersV3Repository(db);
};

module.exports.BATCH_OCCUPYING_STATUSES = BATCH_OCCUPYING_STATUSES;
