const logger = require("../utils/logger");

const TABLE = "gst_tally_purchase";
const INTERNAL_TABLE = "gst_tally_purchase_internal";

function parseTaxJson(val) {
  if (val == null || val === "") return [];
  if (typeof val === "object") return val;
  try {
    return JSON.parse(val);
  } catch {
    return [];
  }
}

class GstTallyPurchaseRepository {
  constructor(db) {
    this.db = db;
  }

  getSupplierIdByMasterId(master_id) {
    const id = String(master_id || "").trim();
    if (!id) {
      return Promise.resolve(null);
    }
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT supplier_id FROM ${TABLE}
         WHERE master_id = ?
           AND supplier_id IS NOT NULL
           AND TRIM(supplier_id) != ''
         LIMIT 1`,
        [id],
        (err, rows) => {
          if (err) return reject(err);
          const sid = rows && rows[0] ? rows[0].supplier_id : null;
          resolve(sid != null && String(sid).trim() !== "" ? String(sid) : null);
        }
      );
    });
  }

  /**
   * Snapshot purchase + purchase_internal into gst_tally_purchase when pushed to Tally.
   */
  copyFromPurchase(purchase_id, master_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT p.*,
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
                pi.invoice_amount
         FROM purchase p
         LEFT JOIN purchase_internal pi ON pi.purchase_id = p.purchase_id
         WHERE p.purchase_id = ?
         LIMIT 1`,
        [purchase_id],
        (err, rows) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.GST_TALLY_PURCHASE",
              code: "REPOSITORY.GST_TALLY_PURCHASE.COPY_FROM_PURCHASE",
              description: err.toString(),
              category: "",
              ref: { purchase_id, master_id },
            });
            return reject(err);
          }
          if (!rows || !rows.length) {
            return reject(
              Object.assign(new Error("Purchase not found"), { statusCode: 404 })
            );
          }

          const row = rows[0];
          const purchase = {
            master_id: String(master_id).trim(),
            retail_outlet_id: row.retail_outlet_id,
            supplier_id: row.supplier_id,
            supplier_name: row.supplier_name,
            supplier_gstn: row.supplier_gstn,
            mmh_mrc_no: row.mmh_mrc_no,
            mmh_mrc_dt: row.mmh_mrc_dt,
            mmh_mrc_amt: row.mmh_mrc_amt,
            mmh_dist_bill_dt: row.mmh_dist_bill_dt,
            mmh_dist_bill_no: row.mmh_dist_bill_no,
            mmh_mrc_refno: row.mmh_mrc_refno,
            mmh_manual_disc: row.mmh_manual_disc ?? 0,
            tot_sgst_amt: row.tot_sgst_amt ?? 0,
            tot_cgst_amt: row.tot_cgst_amt ?? 0,
            tot_igst_amt: row.tot_igst_amt ?? 0,
            tot_gst_cess_amt: row.tot_gst_cess_amt ?? 0,
            mmd_goods_tcs_amt: row.mmd_goods_tcs_amt ?? 0,
            ts: row.ts,
            sgst: parseTaxJson(row.sgst),
            cgst: parseTaxJson(row.cgst),
            igst: parseTaxJson(row.igst),
            cess: parseTaxJson(row.cess),
          };
          const internal = {
            cash_discount: row.cash_discount ?? 0,
            scheme_difference: row.scheme_difference ?? 0,
            cost_difference: row.cost_difference ?? 0,
            due: row.due ?? 0,
            freight_charges: row.freight_charges ?? 0,
            round_off: row.round_off ?? 0,
            jv_ledger: row.jv_ledger ?? null,
            narration: row.narration ?? "",
            supplier_credit_note: row.supplier_credit_note ?? 0,
            total_amount: row.total_amount ?? 0,
            invoice_amount: row.invoice_amount ?? 0,
          };

          this.upsertFromRows({ purchase, internal })
            .then(resolve)
            .catch(reject);
        }
      );
    });
  }

  upsertFromRows({ purchase, internal }) {
    return new Promise((resolve, reject) => {
      const p = purchase;
      this.db.query(
        `INSERT INTO ${TABLE} (
          master_id, retail_outlet_id, supplier_id, supplier_name, supplier_gstn,
          mmh_mrc_no, mmh_mrc_dt, mmh_mrc_amt, mmh_dist_bill_dt, mmh_dist_bill_no,
          mmh_mrc_refno, mmh_manual_disc, tot_sgst_amt, tot_cgst_amt, tot_igst_amt,
          tot_gst_cess_amt, mmd_goods_tcs_amt, ts, sgst, cgst, igst, cess
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          retail_outlet_id = VALUES(retail_outlet_id),
          supplier_id = VALUES(supplier_id),
          supplier_name = VALUES(supplier_name),
          supplier_gstn = VALUES(supplier_gstn),
          mmh_mrc_no = VALUES(mmh_mrc_no),
          mmh_mrc_dt = VALUES(mmh_mrc_dt),
          mmh_mrc_amt = VALUES(mmh_mrc_amt),
          mmh_dist_bill_dt = VALUES(mmh_dist_bill_dt),
          mmh_dist_bill_no = VALUES(mmh_dist_bill_no),
          mmh_mrc_refno = VALUES(mmh_mrc_refno),
          mmh_manual_disc = VALUES(mmh_manual_disc),
          tot_sgst_amt = VALUES(tot_sgst_amt),
          tot_cgst_amt = VALUES(tot_cgst_amt),
          tot_igst_amt = VALUES(tot_igst_amt),
          tot_gst_cess_amt = VALUES(tot_gst_cess_amt),
          mmd_goods_tcs_amt = VALUES(mmd_goods_tcs_amt),
          ts = VALUES(ts),
          sgst = VALUES(sgst),
          cgst = VALUES(cgst),
          igst = VALUES(igst),
          cess = VALUES(cess),
          updated_at = CURRENT_TIMESTAMP`,
        [
          p.master_id,
          p.retail_outlet_id,
          p.supplier_id,
          p.supplier_name,
          p.supplier_gstn,
          p.mmh_mrc_no,
          p.mmh_mrc_dt,
          p.mmh_mrc_amt,
          p.mmh_dist_bill_dt,
          p.mmh_dist_bill_no,
          p.mmh_mrc_refno,
          p.mmh_manual_disc,
          p.tot_sgst_amt,
          p.tot_cgst_amt,
          p.tot_igst_amt,
          p.tot_gst_cess_amt,
          p.mmd_goods_tcs_amt,
          p.ts,
          JSON.stringify(p.sgst || []),
          JSON.stringify(p.cgst || []),
          JSON.stringify(p.igst || []),
          JSON.stringify(p.cess || []),
        ],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.GST_TALLY_PURCHASE",
              code: "REPOSITORY.GST_TALLY_PURCHASE.UPSERT",
              description: err.toString(),
              category: "",
              ref: {},
            });
            return reject(err);
          }

          const loadId = (gstTallyPurchaseId) => {
            this._upsertInternal(gstTallyPurchaseId, internal)
              .then(() =>
                resolve({
                  code: 200,
                  gst_tally_purchase_id: gstTallyPurchaseId,
                  master_id: p.master_id,
                })
              )
              .catch(reject);
          };

          if (res.insertId) {
            loadId(res.insertId);
            return;
          }

          this.db.query(
            `SELECT gst_tally_purchase_id FROM ${TABLE} WHERE master_id = ?`,
            [p.master_id],
            (err2, rows) => {
              if (err2) {
                return reject(err2);
              }
              if (!rows || !rows.length) {
                return reject(new Error("GST tally purchase row not found after upsert"));
              }
              loadId(rows[0].gst_tally_purchase_id);
            }
          );
        }
      );
    });
  }

  _upsertInternal(gst_tally_purchase_id, internal) {
    return new Promise((resolve, reject) => {
      const i = internal;
      this.db.query(
        `INSERT INTO ${INTERNAL_TABLE} (
          gst_tally_purchase_id, cash_discount, scheme_difference, cost_difference,
          due, freight_charges, round_off, jv_ledger, narration,
          supplier_credit_note, total_amount, invoice_amount
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          cash_discount = VALUES(cash_discount),
          scheme_difference = VALUES(scheme_difference),
          cost_difference = VALUES(cost_difference),
          due = VALUES(due),
          freight_charges = VALUES(freight_charges),
          round_off = VALUES(round_off),
          jv_ledger = VALUES(jv_ledger),
          narration = VALUES(narration),
          supplier_credit_note = VALUES(supplier_credit_note),
          total_amount = VALUES(total_amount),
          invoice_amount = VALUES(invoice_amount)`,
        [
          gst_tally_purchase_id,
          i.cash_discount,
          i.scheme_difference,
          i.cost_difference,
          i.due,
          i.freight_charges,
          i.round_off,
          i.jv_ledger,
          i.narration,
          i.supplier_credit_note,
          i.total_amount,
          i.invoice_amount,
        ],
        (err) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.GST_TALLY_PURCHASE",
              code: "REPOSITORY.GST_TALLY_PURCHASE.UPSERT_INTERNAL",
              description: err.toString(),
              category: "",
              ref: {},
            });
            return reject(err);
          }
          resolve();
        }
      );
    });
  }

  deleteByMasterId(master_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `DELETE FROM ${TABLE} WHERE master_id = ?`,
        [master_id],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.GST_TALLY_PURCHASE",
              code: "REPOSITORY.GST_TALLY_PURCHASE.DELETE",
              description: err.toString(),
              category: "",
              ref: {},
            });
            return reject(err);
          }
          if (!res.affectedRows) {
            return resolve({
              code: 404,
              msg: "GST tally purchase entry not found",
            });
          }
          resolve({ code: 200, msg: "Deleted" });
        }
      );
    });
  }
}

module.exports = (db) => {
  return new GstTallyPurchaseRepository(db);
};
