const logger = require("../utils/logger");
const { WAREHOUSE_OUTLET_ID } = require("../constants/outlets");

const TABLE = "gst_tally_purchase";
const INTERNAL_TABLE = "gst_tally_purchase_internal";
const SOURCE_SYSTEM = "system";
const SOURCE_TALLY = "tally";

function parseTaxJson(val) {
  if (val == null) return [];
  if (typeof val === "object") return val;
  try {
    return JSON.parse(val);
  } catch {
    return [];
  }
}

function mapRow(doc) {
  return {
    ...doc,
    sgst: parseTaxJson(doc.sgst),
    cgst: parseTaxJson(doc.cgst),
    igst: parseTaxJson(doc.igst),
    cess: parseTaxJson(doc.cess),
    cash_discount: doc.cash_discount ?? 0,
    scheme_difference: doc.scheme_difference ?? 0,
    cost_difference: doc.cost_difference ?? 0,
    due: doc.due ?? 0,
    freight_charges: doc.freight_charges ?? 0,
    round_off: doc.round_off ?? 0,
    jv_ledger: doc.jv_ledger ?? 0,
    narration: doc.narration ?? "",
    supplier_credit_note: doc.supplier_credit_note ?? 0,
    total_amount: doc.total_amount ?? 0,
    invoice_amount: doc.invoice_amount ?? 0,
    mmh_dist_bill_no: doc.mmh_dist_bill_no ?? null,
  };
}

class PurchaseGstRepository {
  constructor(db) {
    this.db = db;
  }

  _selectJoin() {
    return `SELECT p.*,
      pi.cash_discount,
      pi.scheme_difference,
      pi.cost_difference,
      pi.due,
      pi.freight_charges,
      pi.round_off,
      pi.jv_ledger,
      pi.narration,
      pi.supplier_credit_note,
      pi.total_amount,
      pi.invoice_amount,
      o.outlet_name
    FROM ${TABLE} p
    LEFT JOIN ${INTERNAL_TABLE} pi ON pi.gst_tally_purchase_id = p.gst_tally_purchase_id
    LEFT JOIN outlets o ON o.outlet_id = p.retail_outlet_id`;
  }

  getAll(filters = {}) {
    return new Promise((resolve, reject) => {
      const conditions = [];
      const values = [];

      // An invoice reaches this table twice: once as `system` when the purchase is
      // pushed to Tally (master_id `<purchase_id>-purchase-entry`) and again as
      // `tally` when Tally syncs it back under its own MasterID, so master_id never
      // dedupes the pair. Outside the warehouse the Tally row is the record of
      // truth, so drop the `system` copy for every other outlet.
      conditions.push(`(p.source != ? OR p.retail_outlet_id = ?)`);
      values.push(SOURCE_SYSTEM, WAREHOUSE_OUTLET_ID);

      if (filters.retail_outlet_id) {
        conditions.push("p.retail_outlet_id = ?");
        values.push(filters.retail_outlet_id);
      }
      if (filters.from_date) {
        conditions.push("DATE(p.mmh_mrc_dt) >= ?");
        values.push(filters.from_date);
      }
      if (filters.to_date) {
        conditions.push("DATE(p.mmh_mrc_dt) <= ?");
        values.push(filters.to_date);
      }
      if (filters.dist_bill_from_date) {
        conditions.push("DATE(p.mmh_dist_bill_dt) >= ?");
        values.push(filters.dist_bill_from_date);
      }
      if (filters.dist_bill_to_date) {
        conditions.push("DATE(p.mmh_dist_bill_dt) <= ?");
        values.push(filters.dist_bill_to_date);
      }
      if (filters.mmh_mrc_refno) {
        conditions.push("p.mmh_mrc_refno = ?");
        values.push(filters.mmh_mrc_refno);
      }
      if (filters.master_id) {
        conditions.push("p.master_id = ?");
        values.push(filters.master_id);
      }

      const whereClause =
        conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      this.db.query(
        `${this._selectJoin()} ${whereClause} ORDER BY p.created_at DESC`,
        values,
        (err, rows) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PURCHASE_GST",
              code: "REPOSITORY.PURCHASE_GST.GET_ALL",
              description: err.toString(),
              category: "",
              ref: {},
            });
            return reject(err);
          }
          resolve({ code: 200, data: (rows || []).map(mapRow) });
        }
      );
    });
  }

  /**
   * Remove a purchase that no longer exists in Tally.
   *
   * Only a row Tally owns can go: a `system` row is the snapshot of a purchase
   * in our own system, and deleting it here would leave that purchase pushed to
   * Tally with nothing recording it.
   *
   * Its GSTR-2A match goes with it. The foreign key is ON DELETE SET NULL, so
   * leaving the match behind would strand a 2A document reading as matched
   * against a purchase that is gone.
   */
  deleteTallyRow(gst_tally_purchase_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT source FROM ${TABLE} WHERE gst_tally_purchase_id = ?`,
        [gst_tally_purchase_id],
        (err, rows) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PURCHASE_GST",
              code: "REPOSITORY.PURCHASE_GST.DELETE_LOOKUP",
              description: err.toString(),
              category: "",
              ref: { gst_tally_purchase_id },
            });
            return reject(err);
          }
          if (!rows || !rows.length) {
            return resolve({ code: 404, msg: "Purchase not found" });
          }
          if (rows[0].source !== SOURCE_TALLY) {
            return resolve({
              code: 409,
              msg: "Only purchases synced from Tally can be deleted here",
            });
          }

          this.db.query(
            `DELETE FROM gst_purchase_match WHERE gst_tally_purchase_id = ?`,
            [gst_tally_purchase_id],
            (matchErr, matchRes) => {
              if (matchErr) {
                logger.Log({
                  level: logger.LEVEL.ERROR,
                  component: "REPOSITORY.PURCHASE_GST",
                  code: "REPOSITORY.PURCHASE_GST.DELETE_MATCH",
                  description: matchErr.toString(),
                  category: "",
                  ref: { gst_tally_purchase_id },
                });
                return reject(matchErr);
              }

              this.db.query(
                `DELETE FROM ${TABLE} WHERE gst_tally_purchase_id = ?`,
                [gst_tally_purchase_id],
                (delErr, delRes) => {
                  if (delErr) {
                    logger.Log({
                      level: logger.LEVEL.ERROR,
                      component: "REPOSITORY.PURCHASE_GST",
                      code: "REPOSITORY.PURCHASE_GST.DELETE",
                      description: delErr.toString(),
                      category: "",
                      ref: { gst_tally_purchase_id },
                    });
                    return reject(delErr);
                  }
                  if (!delRes.affectedRows) {
                    return resolve({ code: 404, msg: "Purchase not found" });
                  }
                  resolve({
                    code: 200,
                    msg: "Deleted",
                    matches_removed: matchRes ? matchRes.affectedRows : 0,
                  });
                }
              );
            }
          );
        }
      );
    });
  }

  /**
   * Delete several at once. Same rule as one: only rows Tally owns go, and
   * their matches go with them. Ids that are not deletable are reported back
   * rather than failing the batch - one system row in a selection should not
   * stop the rest.
   */
  deleteTallyRows(ids) {
    const list = [
      ...new Set(
        (ids || []).map((id) => Number(id)).filter((id) => Number.isFinite(id))
      ),
    ];
    if (!list.length) {
      return Promise.resolve({ code: 422, msg: "No purchases given" });
    }

    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT gst_tally_purchase_id, source
         FROM ${TABLE}
         WHERE gst_tally_purchase_id IN (?)`,
        [list],
        (err, rows) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PURCHASE_GST",
              code: "REPOSITORY.PURCHASE_GST.BULK_DELETE_LOOKUP",
              description: err.toString(),
              category: "",
              ref: {},
            });
            return reject(err);
          }

          const found = new Map(
            (rows || []).map((r) => [Number(r.gst_tally_purchase_id), r.source])
          );
          const deletable = list.filter((id) => found.get(id) === SOURCE_TALLY);
          const skipped = list.filter((id) => found.get(id) !== SOURCE_TALLY);

          if (!deletable.length) {
            return resolve({
              code: 200,
              deleted: 0,
              matches_removed: 0,
              skipped,
            });
          }

          this.db.query(
            `DELETE FROM gst_purchase_match WHERE gst_tally_purchase_id IN (?)`,
            [deletable],
            (matchErr, matchRes) => {
              if (matchErr) {
                logger.Log({
                  level: logger.LEVEL.ERROR,
                  component: "REPOSITORY.PURCHASE_GST",
                  code: "REPOSITORY.PURCHASE_GST.BULK_DELETE_MATCH",
                  description: matchErr.toString(),
                  category: "",
                  ref: {},
                });
                return reject(matchErr);
              }

              this.db.query(
                `DELETE FROM ${TABLE} WHERE gst_tally_purchase_id IN (?)`,
                [deletable],
                (delErr, delRes) => {
                  if (delErr) {
                    logger.Log({
                      level: logger.LEVEL.ERROR,
                      component: "REPOSITORY.PURCHASE_GST",
                      code: "REPOSITORY.PURCHASE_GST.BULK_DELETE",
                      description: delErr.toString(),
                      category: "",
                      ref: {},
                    });
                    return reject(delErr);
                  }
                  resolve({
                    code: 200,
                    deleted: delRes ? delRes.affectedRows : 0,
                    matches_removed: matchRes ? matchRes.affectedRows : 0,
                    skipped,
                  });
                }
              );
            }
          );
        }
      );
    });
  }

  getById(gst_tally_purchase_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `${this._selectJoin()} WHERE p.gst_tally_purchase_id = ?`,
        [gst_tally_purchase_id],
        (err, rows) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PURCHASE_GST",
              code: "REPOSITORY.PURCHASE_GST.GET_BY_ID",
              description: err.toString(),
              category: "",
              ref: {},
            });
            return reject(err);
          }
          if (!rows || !rows.length) {
            return resolve({ code: 404 });
          }
          resolve({ code: 200, data: mapRow(rows[0]) });
        }
      );
    });
  }
}

module.exports = (db) => {
  return new PurchaseGstRepository(db);
};
