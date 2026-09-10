const logger = require("../utils/logger");

const TABLE = "gst_purchase_no_2a_accept";
const PURCHASE_TABLE = "gst_tally_purchase";

/**
 * Total tax on a purchase, as the page computes it: IGST for an interstate
 * supplier, CGST + SGST otherwise. Mirrors shouldShowIGST in the frontend's
 * util/purchase.js — a GSTIN that is missing, "0", or starts with 34 (the
 * home state) is local. Kept in SQL so acceptance is gated on the same figure
 * the reviewer saw, rather than on a number the client sent.
 */
const TOTAL_TAX_SQL = `
  CASE
    WHEN p.supplier_gstn IS NULL
      OR TRIM(p.supplier_gstn) = ''
      OR TRIM(p.supplier_gstn) = '0'
      OR TRIM(p.supplier_gstn) LIKE '34%'
    THEN COALESCE(p.tot_cgst_amt, 0) + COALESCE(p.tot_sgst_amt, 0)
    ELSE COALESCE(p.tot_igst_amt, 0)
  END`;

class GstPurchaseNo2aRepository {
  constructor(db) {
    this.db = db;
  }

  _log(code, err, ref = {}) {
    logger.Log({
      level: logger.LEVEL.ERROR,
      component: "REPOSITORY.GST_PURCHASE_NO_2A",
      code: `REPOSITORY.GST_PURCHASE_NO_2A.${code}`,
      description: err.toString(),
      category: "",
      ref,
    });
  }

  /** Acceptances for purchases whose distributor bill date falls in the window. */
  getAll(filters = {}) {
    return new Promise((resolve, reject) => {
      const conditions = [];
      const values = [];

      if (filters.dist_bill_from_date) {
        conditions.push("DATE(p.mmh_dist_bill_dt) >= ?");
        values.push(filters.dist_bill_from_date);
      }
      if (filters.dist_bill_to_date) {
        conditions.push("DATE(p.mmh_dist_bill_dt) <= ?");
        values.push(filters.dist_bill_to_date);
      }
      if (filters.gst_tally_purchase_id != null) {
        conditions.push("a.gst_tally_purchase_id = ?");
        values.push(filters.gst_tally_purchase_id);
      }

      const whereClause =
        conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      this.db.query(
        `SELECT a.gst_purchase_no_2a_accept_id,
                a.gst_tally_purchase_id,
                a.accepted_by,
                a.created_at,
                e.employee_name AS accepted_by_name
         FROM ${TABLE} a
         INNER JOIN ${PURCHASE_TABLE} p
           ON p.gst_tally_purchase_id = a.gst_tally_purchase_id
         LEFT JOIN new_employee e ON e.employee_id = a.accepted_by
         ${whereClause}
         ORDER BY a.created_at DESC`,
        values,
        (err, rows) => {
          if (err) {
            this._log("GET_ALL", err);
            return reject(err);
          }
          resolve({ code: 200, data: rows || [] });
        }
      );
    });
  }

  /**
   * The subset of the given purchase ids that exist and carry no tax.
   * Anything else is not acceptable as "no 2A expected".
   */
  filterZeroTaxPurchaseIds(ids) {
    const list = (ids || [])
      .map((id) => Number(id))
      .filter((id) => Number.isFinite(id));
    if (!list.length) {
      return Promise.resolve([]);
    }
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT p.gst_tally_purchase_id
         FROM ${PURCHASE_TABLE} p
         WHERE p.gst_tally_purchase_id IN (?)
           AND ${TOTAL_TAX_SQL} = 0`,
        [list],
        (err, rows) => {
          if (err) {
            this._log("FILTER_ZERO_TAX", err);
            return reject(err);
          }
          resolve((rows || []).map((r) => Number(r.gst_tally_purchase_id)));
        }
      );
    });
  }

  /** Insert acceptances, ignoring ids already accepted. */
  acceptMany(ids, accepted_by) {
    const list = (ids || [])
      .map((id) => Number(id))
      .filter((id) => Number.isFinite(id));
    if (!list.length) {
      return Promise.resolve(0);
    }
    return new Promise((resolve, reject) => {
      this.db.query(
        `INSERT INTO ${TABLE} (gst_tally_purchase_id, accepted_by)
         VALUES ?
         ON DUPLICATE KEY UPDATE accepted_by = VALUES(accepted_by)`,
        [list.map((id) => [id, accepted_by])],
        (err, res) => {
          if (err) {
            this._log("ACCEPT_MANY", err, { accepted_by });
            return reject(err);
          }
          resolve(res && res.affectedRows ? res.affectedRows : 0);
        }
      );
    });
  }

  /** Un-accept: the purchase goes back to being an unmatched exception. */
  deleteByPurchaseId(gst_tally_purchase_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `DELETE FROM ${TABLE} WHERE gst_tally_purchase_id = ?`,
        [gst_tally_purchase_id],
        (err, res) => {
          if (err) {
            this._log("DELETE", err, { gst_tally_purchase_id });
            return reject(err);
          }
          resolve(res.affectedRows ? { code: 200, msg: "Removed" } : {
            code: 404,
            msg: "Acceptance not found",
          });
        }
      );
    });
  }
}

module.exports = (db) => {
  return new GstPurchaseNo2aRepository(db);
};
