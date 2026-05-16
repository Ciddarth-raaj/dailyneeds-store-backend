const logger = require("../utils/logger");

const TABLE = "gst_tally_purchase";
const INTERNAL_TABLE = "gst_tally_purchase_internal";

class GstTallyPurchaseRepository {
  constructor(db) {
    this.db = db;
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
