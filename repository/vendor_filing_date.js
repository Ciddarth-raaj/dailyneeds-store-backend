const logger = require("../utils/logger");

const TABLE = "vendor_filing_date";

class VendorFilingDateRepository {
  constructor(db) {
    this.db = db;
  }

  deleteByReturnPeriod(year, month) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `DELETE FROM ${TABLE} WHERE year = ? AND month = ?`,
        [year, month],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.VENDOR_FILING_DATE",
              code: "REPOSITORY.VENDOR_FILING_DATE.DELETE_BY_PERIOD",
              description: err.toString(),
              category: "",
              ref: { year, month },
            });
            return reject(err);
          }
          resolve({ affectedRows: res.affectedRows });
        }
      );
    });
  }

  insert(row) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `INSERT INTO ${TABLE} (gst_vendor_id, last_filing_date, year, month) VALUES (?, ?, ?, ?)`,
        [
          row.gst_vendor_id,
          row.last_filing_date ?? null,
          row.year,
          row.month,
        ],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.VENDOR_FILING_DATE",
              code: "REPOSITORY.VENDOR_FILING_DATE.INSERT",
              description: err.toString(),
              category: "",
              ref: { gst_vendor_id: row.gst_vendor_id, year: row.year },
            });
            return reject(err);
          }
          resolve(res.insertId);
        }
      );
    });
  }

  getAll() {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT vendor_filing_date_id, gst_vendor_id, last_filing_date, year, month, created_at
         FROM ${TABLE}
         ORDER BY year DESC, month DESC, gst_vendor_id ASC`,
        (err, rows) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.VENDOR_FILING_DATE",
              code: "REPOSITORY.VENDOR_FILING_DATE.GET_ALL",
              description: err.toString(),
              category: "",
              ref: {},
            });
            return reject(err);
          }
          resolve(
            (rows || []).map((r) => ({
              vendor_filing_date_id: r.vendor_filing_date_id,
              gst_vendor_id: r.gst_vendor_id,
              last_filing_date: r.last_filing_date,
              year: r.year,
              month: r.month,
              created_at: r.created_at,
            }))
          );
        }
      );
    });
  }
}

module.exports = (db) => new VendorFilingDateRepository(db);
