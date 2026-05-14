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
    return new Promise((resolve, reject) => {
      this.db.query(
        `INSERT INTO ${TABLE} (gstin, vendor_name, sandbox_search_response)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE
           vendor_name = VALUES(vendor_name),
           sandbox_search_response = VALUES(sandbox_search_response),
           updated_at = CURRENT_TIMESTAMP`,
        [gstin, vendorName, payload],
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
