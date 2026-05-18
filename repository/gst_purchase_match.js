const logger = require("../utils/logger");
const { mergedDateExpr } = require("../utils/purchase_overlay_sql");

const TABLE = "gst_purchase_match";

class GstPurchaseMatchRepository {
  constructor(db) {
    this.db = db;
  }

  _selectFromJoin() {
    return `FROM ${TABLE} m
      LEFT JOIN purchase p ON p.purchase_id = m.purchase_id
      LEFT JOIN updated_purchase up ON up.purchase_id = p.purchase_id
      LEFT JOIN gst_tally_purchase g ON g.gst_tally_purchase_id = m.gst_tally_purchase_id
      LEFT JOIN gst_b2b_invoices bi ON bi.gst_b2b_invoice_id = m.gst_b2b_invoice_id`;
  }

  /**
   * Date window: include a match if purchase OR gst_tally row (when linked) falls in range.
   * Linked rows do not need matching refno/amounts — only ids are stored on the match.
   */
  _buildListFilterConditions(filters) {
    const conditions = [];
    const values = [];

    if (filters.purchase_id != null) {
      conditions.push("m.purchase_id = ?");
      values.push(filters.purchase_id);
    }

    if (filters.gst_tally_purchase_id != null) {
      conditions.push("m.gst_tally_purchase_id = ?");
      values.push(filters.gst_tally_purchase_id);
    }

    if (filters.gst_b2b_invoice_id != null) {
      conditions.push("m.gst_b2b_invoice_id = ?");
      values.push(filters.gst_b2b_invoice_id);
    }

    if (filters.year != null && filters.month != null) {
      conditions.push(`EXISTS (
        SELECT 1 FROM gst_b2b_invoices bi
        INNER JOIN gst_b2b b ON b.gst_b2b_id = bi.gst_b2b_id
        WHERE bi.gst_b2b_invoice_id = m.gst_b2b_invoice_id
          AND b.year = ?
          AND b.month = ?
      )`);
      values.push(filters.year, filters.month);
    }

    if (filters.from_date && filters.to_date) {
      conditions.push(`(
        (m.purchase_id IS NOT NULL AND ${mergedDateExpr("mmh_mrc_dt")} >= ? AND ${mergedDateExpr("mmh_mrc_dt")} <= ?)
        OR (m.gst_tally_purchase_id IS NOT NULL AND DATE(g.mmh_mrc_dt) >= ? AND DATE(g.mmh_mrc_dt) <= ?)
      )`);
      values.push(
        filters.from_date,
        filters.to_date,
        filters.from_date,
        filters.to_date
      );
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    return { whereClause, values };
  }

  hasMatchedInvoicesForB2bId(gst_b2b_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT 1 AS ok
         FROM ${TABLE} m
         INNER JOIN gst_b2b_invoices bi ON bi.gst_b2b_invoice_id = m.gst_b2b_invoice_id
         WHERE bi.gst_b2b_id = ?
         LIMIT 1`,
        [gst_b2b_id],
        (err, rows) => {
          if (err) return reject(err);
          resolve(Boolean(rows && rows.length > 0));
        }
      );
    });
  }

  listMatchedInvoiceIdsByReturnPeriod(year, month) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT DISTINCT m.gst_b2b_invoice_id
         FROM ${TABLE} m
         INNER JOIN gst_b2b_invoices bi ON bi.gst_b2b_invoice_id = m.gst_b2b_invoice_id
         INNER JOIN gst_b2b b ON b.gst_b2b_id = bi.gst_b2b_id
         WHERE b.year = ? AND b.month = ?`,
        [year, month],
        (err, rows) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.GST_PURCHASE_MATCH",
              code: "REPOSITORY.GST_PURCHASE_MATCH.LIST_MATCHED_BY_PERIOD",
              description: err.toString(),
              category: "",
              ref: { year, month },
            });
            return reject(err);
          }
          resolve((rows || []).map((r) => r.gst_b2b_invoice_id));
        }
      );
    });
  }

  getAll(filters = {}) {
    return new Promise((resolve, reject) => {
      const { whereClause, values } = this._buildListFilterConditions(filters);

      this.db.query(
        `SELECT m.gst_purchase_match_id,
                m.gst_b2b_invoice_id,
                m.gst_tally_purchase_id,
                m.purchase_id,
                m.matched_by,
                m.created_at,
                m.updated_at
         ${this._selectFromJoin()}
         ${whereClause}
         ORDER BY m.created_at DESC`,
        values,
        (err, rows) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.GST_PURCHASE_MATCH",
              code: "REPOSITORY.GST_PURCHASE_MATCH.GET_ALL",
              description: err.toString(),
              category: "",
              ref: {},
            });
            return reject(err);
          }
          resolve({ code: 200, data: rows || [] });
        }
      );
    });
  }

  findByB2bInvoiceId(gst_b2b_invoice_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT gst_purchase_match_id FROM ${TABLE} WHERE gst_b2b_invoice_id = ?`,
        [gst_b2b_invoice_id],
        (err, rows) => {
          if (err) return reject(err);
          resolve(rows && rows[0] ? rows[0].gst_purchase_match_id : null);
        }
      );
    });
  }

  upsert(row) {
    return new Promise(async (resolve, reject) => {
      try {
        let id = row.gst_purchase_match_id;

        if (!id) {
          id = await this.findByB2bInvoiceId(row.gst_b2b_invoice_id);
        }

        if (id) {
          await new Promise((res, rej) => {
            this.db.query(
              `UPDATE ${TABLE} SET
                gst_b2b_invoice_id = ?,
                gst_tally_purchase_id = ?,
                purchase_id = ?,
                matched_by = ?
              WHERE gst_purchase_match_id = ?`,
              [
                row.gst_b2b_invoice_id,
                row.gst_tally_purchase_id ?? null,
                row.purchase_id ?? null,
                row.matched_by,
                id,
              ],
              (err, result) => {
                if (err) return rej(err);
                if (!result.affectedRows) {
                  return rej(new Error("GST purchase match not found"));
                }
                res();
              }
            );
          });
          return resolve({ code: 200, gst_purchase_match_id: id, updated: true });
        }

        const insertId = await new Promise((res, rej) => {
          this.db.query(
            `INSERT INTO ${TABLE} (gst_b2b_invoice_id, gst_tally_purchase_id, purchase_id, matched_by)
             VALUES (?, ?, ?, ?)`,
            [
              row.gst_b2b_invoice_id,
              row.gst_tally_purchase_id ?? null,
              row.purchase_id ?? null,
              row.matched_by,
            ],
            (err, result) => {
              if (err) return rej(err);
              res(result.insertId);
            }
          );
        });

        resolve({
          code: 200,
          gst_purchase_match_id: insertId,
          updated: false,
        });
      } catch (err) {
        logger.Log({
          level: logger.LEVEL.ERROR,
          component: "REPOSITORY.GST_PURCHASE_MATCH",
          code: "REPOSITORY.GST_PURCHASE_MATCH.UPSERT",
          description: err.toString(),
          category: "",
          ref: {},
        });
        reject(err);
      }
    });
  }

  delete(gst_purchase_match_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `DELETE FROM ${TABLE} WHERE gst_purchase_match_id = ?`,
        [gst_purchase_match_id],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.GST_PURCHASE_MATCH",
              code: "REPOSITORY.GST_PURCHASE_MATCH.DELETE",
              description: err.toString(),
              category: "",
              ref: {},
            });
            return reject(err);
          }
          if (!res.affectedRows) {
            return resolve({ code: 404, msg: "GST purchase match not found" });
          }
          resolve({ code: 200, msg: "Deleted" });
        }
      );
    });
  }
}

module.exports = (db) => {
  return new GstPurchaseMatchRepository(db);
};
