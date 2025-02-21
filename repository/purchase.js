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
        filterConditions.push("p.retail_outlet_id = ?");
        filterValues.push(filters.retail_outlet_id);
      }

      if (filters.from_date) {
        filterConditions.push("DATE(p.mmh_mrc_dt) >= ?");
        filterValues.push(filters.from_date);
      }

      if (filters.to_date) {
        filterConditions.push("DATE(p.mmh_mrc_dt) <= ?");
        filterValues.push(filters.to_date);
      }

      const whereClause =
        filterConditions.length > 0
          ? `WHERE ${filterConditions.join(" AND ")}`
          : "";

      this.db.query(
        `SELECT p.*, 
          pi.cash_discount,
          pi.scheme_difference,
          pi.cost_difference,
          pi.due,
          pi.freight_charges,
          pi.round_off,
          pi.jv_ledger,
          pi.narration
        FROM purchase p
        LEFT JOIN purchase_internal pi ON p.purchase_id = pi.purchase_id
        ${whereClause} 
        ORDER BY p.created_at DESC`,
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

          const parsedDocs = docs.map((doc) => ({
            ...doc,
            sgst: JSON.parse(doc.sgst),
            cgst: JSON.parse(doc.cgst),
            igst: JSON.parse(doc.igst),
            cess: JSON.parse(doc.cess),
            // Set default values for internal fields if they don't exist
            cash_discount: doc.cash_discount || 0.0,
            scheme_difference: doc.scheme_difference || 0.0,
            cost_difference: doc.cost_difference || 0.0,
            due: doc.due || 0.0,
            freight_charges: doc.freight_charges || 0.0,
            round_off: doc.round_off || 0.0,
            jv_ledger: doc.jv_ledger || 0.0,
            narration: doc.narration || "",
          }));

          resolve({ code: 200, data: parsedDocs });
        }
      );
    });
  }

  getById(purchaseId) {
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
          pi.narration
        FROM purchase p
        LEFT JOIN purchase_internal pi ON p.purchase_id = pi.purchase_id
        WHERE p.purchase_id = ?`,
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

          const doc = docs[0];
          const parsedDoc = {
            ...doc,
            sgst: JSON.parse(doc.sgst),
            cgst: JSON.parse(doc.cgst),
            igst: JSON.parse(doc.igst),
            cess: JSON.parse(doc.cess),
            // Set default values for internal fields if they don't exist
            cash_discount: doc.cash_discount || 0.0,
            scheme_difference: doc.scheme_difference || 0.0,
            cost_difference: doc.cost_difference || 0.0,
            due: doc.due || 0.0,
            freight_charges: doc.freight_charges || 0.0,
            round_off: doc.round_off || 0.0,
            jv_ledger: doc.jv_ledger || 0.0,
            narration: doc.narration || "",
          };

          resolve({ code: 200, data: parsedDoc });
        }
      );
    });
  }

  // Helper function to compare tax arrays
  compareTaxArrays = (existing, updated) => {
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

  async bulkCreate(purchaseList) {
    return new Promise(async (resolve, reject) => {
      try {
        let insertedCount = 0;
        let updatedCount = 0;
        let unchangedCount = 0;

        // Process each purchase one by one
        for (let purchase of purchaseList) {
          // Convert keys to lowercase
          purchase = Object.keys(purchase).reduce((newObj, key) => {
            const lowerKey =
              {
                STORE_ID: "retail_outlet_id",
                SUPPLIER_ID: "supplier_id",
                SUPPLIER_NAME: "supplier_name",
                SUPPLIER_GSTN: "supplier_gstn",
                MRC_NO: "mmh_mrc_no",
                MRC_DATE: "mmh_mrc_dt",
                MRC_AMT: "mmh_mrc_amt",
                DIST_BILL_DT: "mmh_dist_bill_dt",
                DIST_BILL_NO: "mmh_dist_bill_no",
                MRC_REF: "mmh_mrc_refno",
                MANUAL_DISC: "mmh_manual_disc",
                TOT_SGST_AMT: "tot_sgst_amt",
                TOT_CGST_AMT: "tot_cgst_amt",
                TOT_IGST_AMT: "tot_igst_amt",
                TOT_GST_CESS_AMT: "tot_gst_cess_amt",
                GOODS_TCS_AMT: "mmd_goods_tcs_amt",
                TS: "ts",
                SGST: "sgst",
                CGST: "cgst",
                IGST: "igst",
                CESS: "cess",
              }[key] || key.toLowerCase();

            newObj[lowerKey] = purchase[key];
            return newObj;
          }, {});

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
              !this.compareTaxArrays(
                JSON.parse(existing.sgst),
                formattedPurchase.sgst
              ) ||
              !this.compareTaxArrays(
                JSON.parse(existing.cgst),
                formattedPurchase.cgst
              ) ||
              !this.compareTaxArrays(
                JSON.parse(existing.igst),
                formattedPurchase.igst
              ) ||
              !this.compareTaxArrays(
                JSON.parse(existing.cess),
                formattedPurchase.cess
              );

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
                    cess = ?,
                    has_updated = 1
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

  async updatePurchaseWithInternal(purchase, purchaseInternal) {
    return new Promise(async (resolve, reject) => {
      try {
        // First check if purchase values have changed
        const [existingPurchase] = await new Promise((resolve, reject) => {
          this.db.query(
            `SELECT * FROM purchase WHERE purchase_id = ?`,
            [purchase.purchase_id],
            (err, result) => {
              if (err) reject(err);
              resolve([result[0]]);
            }
          );
        });

        if (!existingPurchase) {
          reject(new Error("Purchase not found"));
          return;
        }

        // Compare values to check if update is needed
        const hasChanges =
          existingPurchase.supplier_id != purchase.supplier_id ||
          existingPurchase.supplier_name != purchase.supplier_name ||
          existingPurchase.supplier_gstn != purchase.supplier_gstn ||
          existingPurchase.mmh_mrc_no != purchase.mmh_mrc_no ||
          moment(existingPurchase.mmh_mrc_dt).format("YYYY-MM-DD") !=
            moment(purchase.mmh_mrc_dt).format("YYYY-MM-DD") ||
          existingPurchase.mmh_mrc_amt != purchase.mmh_mrc_amt ||
          moment(existingPurchase.mmh_dist_bill_dt).format("YYYY-MM-DD") !=
            moment(purchase.mmh_dist_bill_dt).format("YYYY-MM-DD") ||
          existingPurchase.mmh_dist_bill_no != purchase.mmh_dist_bill_no ||
          existingPurchase.mmh_mrc_refno != purchase.mmh_mrc_refno ||
          existingPurchase.mmh_manual_disc != purchase.mmh_manual_disc ||
          existingPurchase.tot_sgst_amt != purchase.tot_sgst_amt ||
          existingPurchase.tot_cgst_amt != purchase.tot_cgst_amt ||
          existingPurchase.tot_igst_amt != purchase.tot_igst_amt ||
          existingPurchase.tot_gst_cess_amt != purchase.tot_gst_cess_amt ||
          existingPurchase.mmd_goods_tcs_amt != purchase.mmd_goods_tcs_amt ||
          !this.compareTaxArrays(
            JSON.parse(existingPurchase.sgst),
            purchase.sgst
          ) ||
          !this.compareTaxArrays(
            JSON.parse(existingPurchase.cgst),
            purchase.cgst
          ) ||
          !this.compareTaxArrays(
            JSON.parse(existingPurchase.igst),
            purchase.igst
          ) ||
          !this.compareTaxArrays(
            JSON.parse(existingPurchase.cess),
            purchase.cess
          );

        // Update purchase if values changed
        if (hasChanges) {
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
              WHERE purchase_id = ?`,
              [
                purchase.supplier_id,
                purchase.supplier_name,
                purchase.supplier_gstn,
                purchase.mmh_mrc_no,
                moment(purchase.mmh_mrc_dt).format("YYYY-MM-DD"),
                purchase.mmh_mrc_amt,
                moment(purchase.mmh_dist_bill_dt).format("YYYY-MM-DD"),
                purchase.mmh_dist_bill_no,
                purchase.mmh_mrc_refno,
                purchase.mmh_manual_disc,
                purchase.tot_sgst_amt,
                purchase.tot_cgst_amt,
                purchase.tot_igst_amt,
                purchase.tot_gst_cess_amt,
                purchase.mmd_goods_tcs_amt,
                JSON.stringify(purchase.sgst),
                JSON.stringify(purchase.cgst),
                JSON.stringify(purchase.igst),
                JSON.stringify(purchase.cess),
                purchase.purchase_id,
              ],
              (err, result) => {
                if (err) reject(err);
                resolve(result);
              }
            );
          });
        }

        // Handle purchase_internal
        if (purchaseInternal) {
          // Check if internal record exists
          const [existingInternal] = await new Promise((resolve, reject) => {
            this.db.query(
              `SELECT * FROM purchase_internal WHERE purchase_id = ?`,
              [purchase.purchase_id],
              (err, result) => {
                if (err) reject(err);
                resolve([result[0]]);
              }
            );
          });

          if (existingInternal) {
            // Update existing internal record
            await new Promise((resolve, reject) => {
              this.db.query(
                `UPDATE purchase_internal SET
                  cash_discount = ?,
                  scheme_difference = ?,
                  cost_difference = ?,
                  due = ?,
                  freight_charges = ?,
                  round_off = ?,
                  jv_ledger = ?,
                  narration = ?
                WHERE purchase_id = ?`,
                [
                  purchaseInternal.cash_discount || 0.0,
                  purchaseInternal.scheme_difference || 0.0,
                  purchaseInternal.cost_difference || 0.0,
                  purchaseInternal.due || 0.0,
                  purchaseInternal.freight_charges || 0.0,
                  purchaseInternal.round_off || 0.0,
                  purchaseInternal.jv_ledger || 0.0,
                  purchaseInternal.narration || "",
                  purchase.purchase_id,
                ],
                (err, result) => {
                  if (err) reject(err);
                  resolve(result);
                }
              );
            });
          } else {
            // Insert new internal record
            await new Promise((resolve, reject) => {
              this.db.query(
                `INSERT INTO purchase_internal (
                  purchase_id,
                  cash_discount,
                  scheme_difference,
                  cost_difference,
                  due,
                  freight_charges,
                  round_off,
                  jv_ledger,
                  narration
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                  purchase.purchase_id,
                  purchaseInternal.cash_discount || 0.0,
                  purchaseInternal.scheme_difference || 0.0,
                  purchaseInternal.cost_difference || 0.0,
                  purchaseInternal.due || 0.0,
                  purchaseInternal.freight_charges || 0.0,
                  purchaseInternal.round_off || 0.0,
                  purchaseInternal.jv_ledger || 0.0,
                  purchaseInternal.narration || "",
                ],
                (err, result) => {
                  if (err) reject(err);
                  resolve(result);
                }
              );
            });
          }
        }

        resolve({
          code: 200,
          purchaseUpdated: hasChanges,
          internalUpdated: !!purchaseInternal,
        });
      } catch (err) {
        logger.Log({
          level: logger.LEVEL.ERROR,
          component: "REPOSITORY.PURCHASE",
          code: "REPOSITORY.PURCHASE.UPDATE-WITH-INTERNAL",
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
