const logger = require("../utils/logger");

const TABLE = "gst_b2b";

class GstB2bRepository {
  constructor(db) {
    this.db = db;
  }

  /**
   * Removes all B2B rows for a return period (CASCADE deletes invoices and line items).
   */
  deleteByReturnPeriod(year, month) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `DELETE FROM ${TABLE} WHERE year = ? AND month = ?`,
        [year, month],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.GST_B2B",
              code: "REPOSITORY.GST_B2B.DELETE_BY_PERIOD",
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

  getByReturnPeriod(year, month) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT gst_b2b_id, year, month, b2b_index, gst_vendor_id, ctin, cfs, created_at
         FROM ${TABLE}
         WHERE year = ? AND month = ?
         ORDER BY b2b_index ASC`,
        [year, month],
        (err, rows) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.GST_B2B",
              code: "REPOSITORY.GST_B2B.GET_BY_PERIOD",
              description: err.toString(),
              category: "",
              ref: { year, month },
            });
            return reject(err);
          }
          resolve(rows || []);
        }
      );
    });
  }

  insert(row) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `INSERT INTO ${TABLE} (year, month, b2b_index, gst_vendor_id, ctin, cfs) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          row.year,
          row.month,
          row.b2b_index,
          row.gst_vendor_id ?? null,
          row.ctin,
          row.cfs ?? null,
        ],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.GST_B2B",
              code: "REPOSITORY.GST_B2B.INSERT",
              description: err.toString(),
              category: "",
              ref: { year: row.year, month: row.month },
            });
            return reject(err);
          }
          resolve(res.insertId);
        }
      );
    });
  }
}

module.exports = (db) => new GstB2bRepository(db);
