const logger = require("../utils/logger");

const TABLE = "gst_tally_purchase";
const INTERNAL_TABLE = "gst_tally_purchase_internal";

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
