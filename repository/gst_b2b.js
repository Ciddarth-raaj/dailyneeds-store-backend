const logger = require("../utils/logger");

const TABLE = "gst_b2b";

class GstB2bRepository {
  constructor(db) {
    this.db = db;
  }

  findByPeriodAndB2bIndex(year, month, b2b_index) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT gst_b2b_id, year, month, b2b_index, gst_vendor_id, ctin, cfs, created_at
         FROM ${TABLE}
         WHERE year = ? AND month = ? AND b2b_index = ?
         LIMIT 1`,
        [year, month, b2b_index],
        (err, rows) => {
          if (err) return reject(err);
          resolve(rows && rows[0] ? rows[0] : null);
        }
      );
    });
  }

  getMaxB2bIndex(year, month) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT COALESCE(MAX(b2b_index), -1) AS max_index
         FROM ${TABLE}
         WHERE year = ? AND month = ?`,
        [year, month],
        (err, rows) => {
          if (err) return reject(err);
          resolve(rows && rows[0] ? Number(rows[0].max_index) : -1);
        }
      );
    });
  }

  updateBlock(gst_b2b_id, { gst_vendor_id, ctin, cfs }) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `UPDATE ${TABLE}
         SET gst_vendor_id = ?, ctin = ?, cfs = ?
         WHERE gst_b2b_id = ?`,
        [gst_vendor_id ?? null, ctin, cfs ?? null, gst_b2b_id],
        (err) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.GST_B2B",
              code: "REPOSITORY.GST_B2B.UPDATE_BLOCK",
              description: err.toString(),
              category: "",
              ref: { gst_b2b_id },
            });
            return reject(err);
          }
          resolve();
        }
      );
    });
  }

  findByPeriodAndCtin(year, month, ctin) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT gst_b2b_id, year, month, b2b_index, gst_vendor_id, ctin, cfs, created_at
         FROM ${TABLE}
         WHERE year = ? AND month = ? AND ctin = ?
         ORDER BY gst_b2b_id ASC
         LIMIT 1`,
        [year, month, ctin],
        (err, rows) => {
          if (err) return reject(err);
          resolve(rows && rows[0] ? rows[0] : null);
        }
      );
    });
  }

  deleteOrphansForReturnPeriod(year, month) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `DELETE b FROM ${TABLE} b
         WHERE b.year = ? AND b.month = ?
           AND NOT EXISTS (
             SELECT 1 FROM gst_b2b_invoices bi WHERE bi.gst_b2b_id = b.gst_b2b_id
           )`,
        [year, month],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.GST_B2B",
              code: "REPOSITORY.GST_B2B.DELETE_ORPHANS",
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

  /**
   * B2B blocks for an inclusive range of return periods.
   * Periods are compared as year*100 + month so a range spanning a year end
   * (e.g. 2025-11 to 2026-02) stays a single ordered comparison.
   */
  getByReturnPeriodRange(fromYear, fromMonth, toYear, toMonth) {
    const from = Number(fromYear) * 100 + Number(fromMonth);
    const to = Number(toYear) * 100 + Number(toMonth);
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT gst_b2b_id, year, month, b2b_index, gst_vendor_id, ctin, cfs, created_at
         FROM ${TABLE}
         WHERE (year * 100 + month) BETWEEN ? AND ?
         ORDER BY year ASC, month ASC, b2b_index ASC`,
        [from, to],
        (err, rows) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.GST_B2B",
              code: "REPOSITORY.GST_B2B.GET_BY_PERIOD_RANGE",
              description: err.toString(),
              category: "",
              ref: { fromYear, fromMonth, toYear, toMonth },
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
        async (err, res) => {
          if (err) {
            if (err.code === "ER_DUP_ENTRY") {
              try {
                const existing = await this.findByPeriodAndB2bIndex(
                  row.year,
                  row.month,
                  row.b2b_index
                );
                if (existing) {
                  return resolve(existing.gst_b2b_id);
                }
              } catch (_) {
                /* fall through */
              }
            }
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.GST_B2B",
              code: "REPOSITORY.GST_B2B.INSERT",
              description: err.toString(),
              category: "",
              ref: { year: row.year, month: row.month, b2b_index: row.b2b_index },
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
