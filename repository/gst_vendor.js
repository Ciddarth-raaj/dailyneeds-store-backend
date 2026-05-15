const logger = require("../utils/logger");

const TABLE = "gst_vendors";

function parseJsonColumn(value) {
  if (value == null) return null;
  if (typeof value === "object") {
    return value;
  }
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch (_) {
      return null;
    }
  }
  return null;
}

function mapRow(r, { includeSandboxPayload } = {}) {
  if (!r) return null;
  const row = {
    gst_vendor_id: r.gst_vendor_id,
    gstin: r.gstin,
    vendor_name: r.vendor_name,
    is_active: Boolean(r.is_active),
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
  if (includeSandboxPayload) {
    row.sandbox_search_response = parseJsonColumn(r.sandbox_search_response);
  }
  return row;
}

class GstVendorRepository {
  constructor(db) {
    this.db = db;
  }

  getAllWithLatestFilingDate() {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT v.gst_vendor_id, v.gstin, v.vendor_name, v.is_active, v.created_at, v.updated_at,
                lf.last_filing_date
         FROM ${TABLE} v
         LEFT JOIN (
           SELECT vfd.gst_vendor_id, vfd.last_filing_date
           FROM vendor_filing_date vfd
           INNER JOIN (
             SELECT gst_vendor_id, MAX(year * 100 + month) AS max_ym
             FROM vendor_filing_date
             GROUP BY gst_vendor_id
           ) t ON t.gst_vendor_id = vfd.gst_vendor_id
              AND (vfd.year * 100 + vfd.month) = t.max_ym
         ) lf ON lf.gst_vendor_id = v.gst_vendor_id
         ORDER BY v.gst_vendor_id ASC`,
        (err, rows) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.GST_VENDOR",
              code: "REPOSITORY.GST_VENDOR.GET_ALL_WITH_FILING",
              description: err.toString(),
              category: "",
              ref: {},
            });
            return reject(err);
          }
          resolve(
            (rows || []).map((r) => ({
              gst_vendor_id: r.gst_vendor_id,
              gstin: r.gstin,
              vendor_name: r.vendor_name,
              is_active: Boolean(r.is_active),
              created_at: r.created_at,
              updated_at: r.updated_at,
              last_filing_date: r.last_filing_date,
            }))
          );
        }
      );
    });
  }

  getAll() {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT gst_vendor_id, gstin, vendor_name, is_active, created_at, updated_at
         FROM ${TABLE}
         ORDER BY gst_vendor_id ASC`,
        (err, rows) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.GST_VENDOR",
              code: "REPOSITORY.GST_VENDOR.GET_ALL",
              description: err.toString(),
              category: "",
              ref: {},
            });
            return reject(err);
          }
          resolve((rows || []).map((r) => mapRow(r)));
        }
      );
    });
  }

  /**
   * @param {{ vendor_name?: string | null, sandbox_search_response?: object | string | null }} patch
   */
  updateVendorByGstin(gstin, patch) {
    const sets = [];
    const vals = [];
    if (patch.vendor_name !== undefined) {
      sets.push("vendor_name = ?");
      vals.push(patch.vendor_name);
    }
    if (patch.sandbox_search_response !== undefined) {
      sets.push("sandbox_search_response = ?");
      const c = patch.sandbox_search_response;
      vals.push(
        c == null
          ? null
          : typeof c === "string"
            ? c
            : JSON.stringify(c)
      );
    }
    if (sets.length === 0) {
      return Promise.resolve({ code: 200 });
    }
    vals.push(gstin);
    return new Promise((resolve, reject) => {
      this.db.query(
        `UPDATE ${TABLE} SET ${sets.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE gstin = ?`,
        vals,
        (err) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.GST_VENDOR",
              code: "REPOSITORY.GST_VENDOR.UPDATE_BY_GSTIN",
              description: err.toString(),
              category: "",
              ref: { gstin },
            });
            return reject(err);
          }
          resolve({ code: 200 });
        }
      );
    });
  }

  /**
   * @returns {Promise<number>} insertId (gst_vendor_id)
   */
  create({ gstin, vendor_name = null, sandbox_search_response = null, is_active = true }) {
    const cache =
      sandbox_search_response == null
        ? null
        : typeof sandbox_search_response === "string"
          ? sandbox_search_response
          : JSON.stringify(sandbox_search_response);
    return new Promise((resolve, reject) => {
      this.db.query(
        `INSERT INTO ${TABLE} (gstin, vendor_name, sandbox_search_response, is_active) VALUES (?, ?, ?, ?)`,
        [gstin, vendor_name, cache, is_active ? 1 : 0],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.GST_VENDOR",
              code: "REPOSITORY.GST_VENDOR.CREATE",
              description: err.toString(),
              category: "",
              ref: { gstin },
            });
            return reject(err);
          }
          resolve(res.insertId);
        }
      );
    });
  }

  getByGstin(gstin) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT gst_vendor_id, gstin, vendor_name, sandbox_search_response, is_active, created_at, updated_at
         FROM ${TABLE} WHERE gstin = ? LIMIT 1`,
        [gstin],
        (err, rows) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.GST_VENDOR",
              code: "REPOSITORY.GST_VENDOR.GET_BY_GSTIN",
              description: err.toString(),
              category: "",
              ref: { gstin },
            });
            return reject(err);
          }
          const row = rows && rows[0];
          resolve(row ? mapRow(row, { includeSandboxPayload: true }) : null);
        }
      );
    });
  }

  upsertSearchCache(gstin, vendorName, sandboxResponseBody) {
    const payload =
      typeof sandboxResponseBody === "string"
        ? sandboxResponseBody
        : JSON.stringify(sandboxResponseBody);
    const name = vendorName != null && String(vendorName).trim() !== "" ? String(vendorName).trim().slice(0, 512) : null;
    return new Promise((resolve, reject) => {
      this.db.query(
        `INSERT INTO ${TABLE} (gstin, vendor_name, sandbox_search_response)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE
           vendor_name = VALUES(vendor_name),
           sandbox_search_response = VALUES(sandbox_search_response),
           updated_at = CURRENT_TIMESTAMP`,
        [gstin, name, payload],
        (err) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.GST_VENDOR",
              code: "REPOSITORY.GST_VENDOR.UPSERT_SEARCH_CACHE",
              description: err.toString(),
              category: "",
              ref: { gstin },
            });
            return reject(err);
          }
          resolve({ code: 200 });
        }
      );
    });
  }
}

module.exports = (db) => {
  return new GstVendorRepository(db);
};
