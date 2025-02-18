const logger = require("../utils/logger");
const moment = require("moment");

class PurchaseRepository {
  constructor(db) {
    this.db = db;
  }

  create(purchase) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `INSERT INTO purchase (
          retail_outlet_id, supplier_id, supplier_name, supplier_gstn,
          mmh_mrc_no, mmh_mrc_dt, mmh_mrc_amt, mmh_dist_bill_dt,
          mmh_dist_bill_no, mmh_mrc_refno, mmh_manual_disc,
          tot_sgst_amt, tot_cgst_amt, tot_igst_amt, tot_gst_cess_amt,
          mmd_goods_tcs_amt, ts, sgst, cgst, igst, cess
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          purchase.retail_outlet_id,
          purchase.supplier_id,
          purchase.supplier_name,
          purchase.supplier_gstn,
          purchase.mmh_mrc_no,
          purchase.mmh_mrc_dt,
          purchase.mmh_mrc_amt,
          purchase.mmh_dist_bill_dt,
          purchase.mmh_dist_bill_no,
          purchase.mmh_mrc_refno,
          purchase.mmh_manual_disc,
          purchase.tot_sgst_amt,
          purchase.tot_cgst_amt,
          purchase.tot_igst_amt,
          purchase.tot_gst_cess_amt,
          purchase.mmd_goods_tcs_amt,
          purchase.ts,
          JSON.stringify(purchase.sgst),
          JSON.stringify(purchase.cgst),
          JSON.stringify(purchase.igst),
          JSON.stringify(purchase.cess),
        ],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PURCHASE",
              code: "REPOSITORY.PURCHASE.CREATE",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve({
            code: 200,
            id: res.insertId,
          });
        }
      );
    });
  }

  update(purchase) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `UPDATE purchase SET
          retail_outlet_id = ?, supplier_id = ?, supplier_name = ?, 
          supplier_gstn = ?, mmh_mrc_no = ?, mmh_mrc_dt = ?,
          mmh_mrc_amt = ?, mmh_dist_bill_dt = ?, mmh_dist_bill_no = ?,
          mmh_mrc_refno = ?, mmh_manual_disc = ?, tot_sgst_amt = ?,
          tot_cgst_amt = ?, tot_igst_amt = ?, tot_gst_cess_amt = ?,
          mmd_goods_tcs_amt = ?, ts = ?, sgst = ?, cgst = ?, igst = ?,
          cess = ?
        WHERE purchase_id = ?`,
        [
          purchase.retail_outlet_id,
          purchase.supplier_id,
          purchase.supplier_name,
          purchase.supplier_gstn,
          purchase.mmh_mrc_no,
          purchase.mmh_mrc_dt,
          purchase.mmh_mrc_amt,
          purchase.mmh_dist_bill_dt,
          purchase.mmh_dist_bill_no,
          purchase.mmh_mrc_refno,
          purchase.mmh_manual_disc,
          purchase.tot_sgst_amt,
          purchase.tot_cgst_amt,
          purchase.tot_igst_amt,
          purchase.tot_gst_cess_amt,
          purchase.mmd_goods_tcs_amt,
          purchase.ts,
          JSON.stringify(purchase.sgst),
          JSON.stringify(purchase.cgst),
          JSON.stringify(purchase.igst),
          JSON.stringify(purchase.cess),
          purchase.purchase_id,
        ],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PURCHASE",
              code: "REPOSITORY.PURCHASE.UPDATE",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve({ code: 200 });
        }
      );
    });
  }

  delete(purchaseId) {
    return new Promise((resolve, reject) => {
      this.db.query(
        "DELETE FROM purchase WHERE purchase_id = ?",
        [purchaseId],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PURCHASE",
              code: "REPOSITORY.PURCHASE.DELETE",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve({ code: 200 });
        }
      );
    });
  }

  getAll(filters = {}) {
    return new Promise((resolve, reject) => {
      let filterConditions = [];
      let filterValues = [];

      if (filters.retail_outlet_id) {
        filterConditions.push("retail_outlet_id = ?");
        filterValues.push(filters.retail_outlet_id);
      }

      if (filters.from_date) {
        filterConditions.push("DATE(mmh_mrc_dt) >= ?");
        filterValues.push(filters.from_date);
      }

      if (filters.to_date) {
        filterConditions.push("DATE(mmh_mrc_dt) <= ?");
        filterValues.push(filters.to_date);
      }

      const whereClause =
        filterConditions.length > 0
          ? `WHERE ${filterConditions.join(" AND ")}`
          : "";

      this.db.query(
        `SELECT * FROM purchase ${whereClause} ORDER BY created_at DESC`,
        filterValues,
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PURCHASE",
              code: "REPOSITORY.PURCHASE.GET-ALL",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve({ code: 200, data: docs });
        }
      );
    });
  }

  getById(purchaseId) {
    return new Promise((resolve, reject) => {
      this.db.query(
        "SELECT * FROM purchase WHERE purchase_id = ?",
        [purchaseId],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PURCHASE",
              code: "REPOSITORY.PURCHASE.GET-BY-ID",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }

          if (docs.length === 0) {
            resolve({ code: 404 });
            return;
          }

          resolve({ code: 200, data: docs[0] });
        }
      );
    });
  }

  async bulkCreate(purchaseList) {
    return new Promise(async (resolve, reject) => {
      try {
        let insertedCount = 0;
        let updatedCount = 0;
        let unchangedCount = 0;

        // Process each purchase one by one
        for (const purchase of purchaseList) {
          // Format dates using moment
          const formattedPurchase = {
            ...purchase,
            mmh_mrc_dt: moment(purchase.mmh_mrc_dt).format("YYYY-MM-DD"),
            mmh_dist_bill_dt: moment(purchase.mmh_dist_bill_dt).format(
              "YYYY-MM-DD"
            ),
          };

          // Check if record exists
          const [existingRows] = await new Promise((resolve, reject) => {
            this.db.query(
              `SELECT * FROM purchase WHERE ts = ? AND retail_outlet_id = ?`,
              [formattedPurchase.ts, formattedPurchase.retail_outlet_id],
              (err, result) => {
                if (err) reject(err);
                resolve([result]);
              }
            );
          });

          if (existingRows.length > 0) {
            const existing = existingRows[0];

            // Helper function to compare tax arrays
            const compareTaxArrays = (existing, updated) => {
              if (!Array.isArray(existing) || !Array.isArray(updated)) {
                return false;
              }
              if (existing.length !== updated.length) {
                return false;
              }

              // Sort arrays by perc to ensure consistent comparison
              const sortedExisting = existing.sort((a, b) => a.perc - b.perc);
              const sortedUpdated = updated.sort((a, b) => a.perc - b.perc);

              // Compare each item in the arrays
              return sortedExisting.every((existingItem, index) => {
                const updatedItem = sortedUpdated[index];
                return (
                  existingItem.perc === updatedItem.perc &&
                  existingItem.value === updatedItem.value
                );
              });
            };

            const hasChanges =
              existing.supplier_id != formattedPurchase.supplier_id ||
              existing.supplier_name != formattedPurchase.supplier_name ||
              existing.supplier_gstn != formattedPurchase.supplier_gstn ||
              existing.mmh_mrc_no != formattedPurchase.mmh_mrc_no ||
              moment(existing.mmh_mrc_dt).format("YYYY-MM-DD") !=
                formattedPurchase.mmh_mrc_dt ||
              existing.mmh_mrc_amt != formattedPurchase.mmh_mrc_amt ||
              moment(existing.mmh_dist_bill_dt).format("YYYY-MM-DD") !=
                formattedPurchase.mmh_dist_bill_dt ||
              existing.mmh_dist_bill_no != formattedPurchase.mmh_dist_bill_no ||
              existing.mmh_mrc_refno != formattedPurchase.mmh_mrc_refno ||
              existing.mmh_manual_disc != formattedPurchase.mmh_manual_disc ||
              existing.tot_sgst_amt != formattedPurchase.tot_sgst_amt ||
              existing.tot_cgst_amt != formattedPurchase.tot_cgst_amt ||
              existing.tot_igst_amt != formattedPurchase.tot_igst_amt ||
              existing.tot_gst_cess_amt != formattedPurchase.tot_gst_cess_amt ||
              existing.mmd_goods_tcs_amt !=
                formattedPurchase.mmd_goods_tcs_amt ||
              !compareTaxArrays(
                JSON.parse(existing.sgst),
                formattedPurchase.sgst
              ) ||
              !compareTaxArrays(
                JSON.parse(existing.cgst),
                formattedPurchase.cgst
              ) ||
              !compareTaxArrays(
                JSON.parse(existing.igst),
                formattedPurchase.igst
              ) ||
              !compareTaxArrays(
                JSON.parse(existing.cess),
                formattedPurchase.cess
              );

            console.log(hasChanges);

            if (hasChanges) {
              // Update if values are different
              await new Promise((resolve, reject) => {
                this.db.query(
                  `UPDATE purchase SET
                    supplier_id = ?,
                    supplier_name = ?,
                    supplier_gstn = ?,
                    mmh_mrc_no = ?,
                    mmh_mrc_dt = ?,
                    mmh_mrc_amt = ?,
                    mmh_dist_bill_dt = ?,
                    mmh_dist_bill_no = ?,
                    mmh_mrc_refno = ?,
                    mmh_manual_disc = ?,
                    tot_sgst_amt = ?,
                    tot_cgst_amt = ?,
                    tot_igst_amt = ?,
                    tot_gst_cess_amt = ?,
                    mmd_goods_tcs_amt = ?,
                    sgst = ?,
                    cgst = ?,
                    igst = ?,
                    cess = ?
                  WHERE ts = ? AND retail_outlet_id = ?`,
                  [
                    formattedPurchase.supplier_id,
                    formattedPurchase.supplier_name,
                    formattedPurchase.supplier_gstn,
                    formattedPurchase.mmh_mrc_no,
                    formattedPurchase.mmh_mrc_dt,
                    formattedPurchase.mmh_mrc_amt,
                    formattedPurchase.mmh_dist_bill_dt,
                    formattedPurchase.mmh_dist_bill_no,
                    formattedPurchase.mmh_mrc_refno,
                    formattedPurchase.mmh_manual_disc,
                    formattedPurchase.tot_sgst_amt,
                    formattedPurchase.tot_cgst_amt,
                    formattedPurchase.tot_igst_amt,
                    formattedPurchase.tot_gst_cess_amt,
                    formattedPurchase.mmd_goods_tcs_amt,
                    JSON.stringify(formattedPurchase.sgst),
                    JSON.stringify(formattedPurchase.cgst),
                    JSON.stringify(formattedPurchase.igst),
                    JSON.stringify(formattedPurchase.cess),
                    formattedPurchase.ts,
                    formattedPurchase.retail_outlet_id,
                  ],
                  (err, result) => {
                    if (err) reject(err);
                    resolve(result);
                  }
                );
              });
              updatedCount++;
            } else {
              unchangedCount++;
            }
          } else {
            // Insert new record
            await new Promise((resolve, reject) => {
              this.db.query(
                `INSERT INTO purchase (
                  retail_outlet_id, supplier_id, supplier_name, supplier_gstn,
                  mmh_mrc_no, mmh_mrc_dt, mmh_mrc_amt, mmh_dist_bill_dt,
                  mmh_dist_bill_no, mmh_mrc_refno, mmh_manual_disc,
                  tot_sgst_amt, tot_cgst_amt, tot_igst_amt, tot_gst_cess_amt,
                  mmd_goods_tcs_amt, ts, sgst, cgst, igst, cess
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                  formattedPurchase.retail_outlet_id,
                  formattedPurchase.supplier_id,
                  formattedPurchase.supplier_name,
                  formattedPurchase.supplier_gstn,
                  formattedPurchase.mmh_mrc_no,
                  formattedPurchase.mmh_mrc_dt,
                  formattedPurchase.mmh_mrc_amt,
                  formattedPurchase.mmh_dist_bill_dt,
                  formattedPurchase.mmh_dist_bill_no,
                  formattedPurchase.mmh_mrc_refno,
                  formattedPurchase.mmh_manual_disc,
                  formattedPurchase.tot_sgst_amt,
                  formattedPurchase.tot_cgst_amt,
                  formattedPurchase.tot_igst_amt,
                  formattedPurchase.tot_gst_cess_amt,
                  formattedPurchase.mmd_goods_tcs_amt,
                  formattedPurchase.ts,
                  JSON.stringify(formattedPurchase.sgst),
                  JSON.stringify(formattedPurchase.cgst),
                  JSON.stringify(formattedPurchase.igst),
                  JSON.stringify(formattedPurchase.cess),
                ],
                (err, result) => {
                  if (err) reject(err);
                  resolve(result);
                }
              );
            });
            insertedCount++;
          }
        }

        resolve({
          code: 200,
          insertedCount,
          updatedCount,
          unchangedCount,
        });
      } catch (err) {
        logger.Log({
          level: logger.LEVEL.ERROR,
          component: "REPOSITORY.PURCHASE",
          code: "REPOSITORY.PURCHASE.BULK-CREATE",
          description: err.toString(),
          category: "",
          ref: {},
        });
        reject(err);
      }
    });
  }
}

module.exports = (db) => {
  return new PurchaseRepository(db);
};
