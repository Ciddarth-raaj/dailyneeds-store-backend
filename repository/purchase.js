const logger = require("../utils/logger");
const moment = require("moment");
const {
  purchaseOverlaySelectList,
  purchaseOverlayJoins,
  mergedDateExpr,
} = require("../utils/purchase_overlay_sql");

class PurchaseRepository {
  constructor(db) {
    this.db = db;
  }

  _parsePurchaseDoc(doc) {
    const parseJson = (val) => {
      if (val == null || val === "") return [];
      if (typeof val === "object") return val;
      try {
        return JSON.parse(val);
      } catch {
        return [];
      }
    };
    return {
      ...doc,
      sgst: parseJson(doc.sgst),
      cgst: parseJson(doc.cgst),
      igst: parseJson(doc.igst),
      cess: parseJson(doc.cess),
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
        filterConditions.push(
          "COALESCE(g.retail_outlet_id, p.retail_outlet_id) = ?"
        );
        filterValues.push(filters.retail_outlet_id);
      }

      if (filters.from_date) {
        filterConditions.push(`${mergedDateExpr("mmh_mrc_dt")} >= ?`);
        filterValues.push(filters.from_date);
      }

      if (filters.to_date) {
        filterConditions.push(`${mergedDateExpr("mmh_mrc_dt")} <= ?`);
        filterValues.push(filters.to_date);
      }

      if (filters.dist_bill_from_date) {
        filterConditions.push(`${mergedDateExpr("mmh_dist_bill_dt")} >= ?`);
        filterValues.push(filters.dist_bill_from_date);
      }

      if (filters.dist_bill_to_date) {
        filterConditions.push(`${mergedDateExpr("mmh_dist_bill_dt")} <= ?`);
        filterValues.push(filters.dist_bill_to_date);
      }

      if (filters.has_updated !== undefined) {
        if (filters.has_updated) {
          filterConditions.push(
            "(p.has_updated = 1 OR g.gst_tally_purchase_id IS NOT NULL)"
          );
        } else {
          filterConditions.push(
            "(p.has_updated = 0 AND g.gst_tally_purchase_id IS NULL)"
          );
        }
      }

      if (filters.is_approved !== undefined) {
        const conditionString = filters.is_approved
          ? "p.is_approved = ? AND tr.VoucherNo IS NULL"
          : "p.is_approved = ?";
        filterConditions.push(conditionString);
        filterValues.push(filters.is_approved);
      }

      if (filters.is_pushed === true) {
        filterConditions.push("tr.VoucherNo IS NOT NULL");
      } else if (filters.is_pushed === false) {
        filterConditions.push("tr.VoucherNo IS NULL");
      }

      const whereClause =
        filterConditions.length > 0
          ? `WHERE ${filterConditions.join(" AND ")}`
          : "";

      this.db.query(
        `SELECT
          ${purchaseOverlaySelectList()},
          tr.VoucherNo,
          tr.InvoiceValue,
          tr.SupplierName,
          tr.CostCentre,
          o.outlet_name,
          o.outlet_id
        FROM purchase p
        ${purchaseOverlayJoins()}
        LEFT JOIN outlets o ON o.outlet_id = COALESCE(g.retail_outlet_id, p.retail_outlet_id)
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
            ...this._parsePurchaseDoc(doc),
            tally_response: {
              voucher_no: doc.VoucherNo || null,
              invoice_value: doc.InvoiceValue || null,
              supplier_name: doc.SupplierName || null,
              cost_centre: doc.CostCentre || null,
            },
          }));

          resolve({ code: 200, data: parsedDocs });
        }
      );
    });
  }

  getById(purchaseId) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT
          ${purchaseOverlaySelectList()},
          tr.VoucherNo,
          tr.InvoiceValue,
          tr.SupplierName,
          tr.CostCentre
        FROM purchase p
        ${purchaseOverlayJoins()}
        LEFT JOIN outlets o ON o.outlet_id = COALESCE(g.retail_outlet_id, p.retail_outlet_id)
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
            ...this._parsePurchaseDoc(doc),
            voucher_no: doc.VoucherNo || null,
            invoice_value: doc.InvoiceValue || null,
            supplier_name: doc.SupplierName || null,
            cost_centre: doc.CostCentre || null,
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
        existingItem.value === updatedItem.value &&
        existingItem.TAXABLE === updatedItem.TAXABLE
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
              `SELECT * FROM purchase WHERE mmh_mrc_refno = ? AND retail_outlet_id = ?`,
              [
                formattedPurchase.mmh_mrc_refno,
                formattedPurchase.retail_outlet_id,
              ],
              (err, result) => {
                if (err) reject(err);
                resolve([result]);
              }
            );
          });

          if (existingRows.length > 0) {
            const existing = existingRows[0];

            const hasChanges = existing.ts != formattedPurchase.ts;
            const has_updated = existing.is_approved == 0 ? false : true;
            const is_approved = false;

            if (hasChanges && !existing.is_approved) {
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
                    ts = ?,
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
                    has_updated = ?,
                    is_approved = ?
                  WHERE mmh_mrc_refno = ? AND retail_outlet_id = ?`,
                  [
                    formattedPurchase.supplier_id,
                    formattedPurchase.supplier_name,
                    formattedPurchase.supplier_gstn,
                    formattedPurchase.mmh_mrc_no,
                    formattedPurchase.mmh_mrc_dt,
                    formattedPurchase.mmh_mrc_amt,
                    formattedPurchase.mmh_dist_bill_dt,
                    formattedPurchase.mmh_dist_bill_no,
                    formattedPurchase.ts,
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
                    has_updated,
                    is_approved,
                    formattedPurchase.mmh_mrc_refno,
                    formattedPurchase.retail_outlet_id,
                  ],
                  (err, result) => {
                    if (err) {
                      reject(err);
                    }

                    console.log(result);
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
                  narration = ?,
                  supplier_credit_note = ?,
                  total_amount = ?,
                  invoice_amount = ?
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
                  purchaseInternal.supplier_credit_note || 0.0,
                  purchaseInternal.total_amount || 0.0,
                  purchaseInternal.invoice_amount || 0.0,
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
                  narration,
                  supplier_credit_note,
                  total_amount,
                  invoice_amount
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
                  purchaseInternal.supplier_credit_note || 0.0,
                  purchaseInternal.total_amount || 0.0,
                  purchaseInternal.invoice_amount || 0.0,
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

  async updateFlags(purchaseId, flags) {
    return new Promise(async (resolve, reject) => {
      try {
        // Build update query dynamically based on provided flags
        const updates = [];
        const values = [];

        if (flags.has_updated !== undefined) {
          updates.push("has_updated = ?");
          values.push(flags.has_updated);
        }

        if (flags.is_approved !== undefined) {
          updates.push("is_approved = ?");
          values.push(flags.is_approved);
        }

        if (updates.length === 0) {
          resolve({ code: 400, msg: "No flags to update" });
          return;
        }

        values.push(purchaseId);

        this.db.query(
          `UPDATE purchase SET ${updates.join(", ")} WHERE purchase_id = ?`,
          values,
          (err, result) => {
            if (err) {
              logger.Log({
                level: logger.LEVEL.ERROR,
                component: "REPOSITORY.PURCHASE",
                code: "REPOSITORY.PURCHASE.UPDATE-FLAGS",
                description: err.toString(),
                category: "",
                ref: {},
              });
              reject(err);
              return;
            }

            if (result.affectedRows === 0) {
              resolve({ code: 404, msg: "Purchase not found" });
              return;
            }

            resolve({
              code: 200,
              msg: "Flags updated successfully",
              updatedFlags: flags,
            });
          }
        );
      } catch (err) {
        logger.Log({
          level: logger.LEVEL.ERROR,
          component: "REPOSITORY.PURCHASE",
          code: "REPOSITORY.PURCHASE.UPDATE-FLAGS",
          description: err.toString(),
          category: "",
          ref: {},
        });
        reject(err);
      }
    });
  }

  _findPurchaseIdByTallyMasterId(masterId) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT purchase_id
         FROM purchase_tally_response
         WHERE MasterID = ?
         LIMIT 1`,
        [String(masterId).trim()],
        (err, rows) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PURCHASE",
              code: "REPOSITORY.PURCHASE.FIND_BY_TALLY_MASTER_ID",
              description: err.toString(),
              category: "",
              ref: { masterId },
            });
            return reject(err);
          }
          resolve(rows && rows[0] ? rows[0].purchase_id : null);
        }
      );
    });
  }

  existsByTallyMasterId(masterId) {
    return this._findPurchaseIdByTallyMasterId(masterId).then(Boolean);
  }

  /**
   * Linked purchase supplier_id for a Tally MasterID (non-empty only).
   * @returns {Promise<string|null>}
   */
  getSupplierIdByTallyMasterId(masterId) {
    const id = String(masterId || "").trim();
    if (!id) {
      return Promise.resolve(null);
    }
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT p.supplier_id
         FROM purchase_tally_response tr
         INNER JOIN purchase p ON p.purchase_id = tr.purchase_id
         WHERE tr.MasterID = ?
           AND p.supplier_id IS NOT NULL
           AND TRIM(p.supplier_id) != ''
         LIMIT 1`,
        [id],
        (err, rows) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PURCHASE",
              code: "REPOSITORY.PURCHASE.SUPPLIER_ID_BY_MASTER_ID",
              description: err.toString(),
              category: "",
              ref: { masterId: id },
            });
            return reject(err);
          }
          const sid = rows && rows[0] ? rows[0].supplier_id : null;
          resolve(sid != null && String(sid).trim() !== "" ? String(sid) : null);
        }
      );
    });
  }

  /**
   * Most recent non-empty supplier_id on purchase for a supplier GSTIN.
   * @returns {Promise<string|null>}
   */
  findSupplierIdBySupplierGstn(supplierGstn) {
    const gstn =
      supplierGstn != null ? String(supplierGstn).trim().toUpperCase() : "";
    if (!gstn) {
      return Promise.resolve(null);
    }
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT supplier_id
         FROM purchase
         WHERE UPPER(TRIM(supplier_gstn)) = ?
           AND supplier_id IS NOT NULL
           AND TRIM(supplier_id) != ''
         ORDER BY purchase_id DESC
         LIMIT 1`,
        [gstn],
        (err, rows) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PURCHASE",
              code: "REPOSITORY.PURCHASE.SUPPLIER_ID_BY_GSTN",
              description: err.toString(),
              category: "",
              ref: { supplierGstn: gstn },
            });
            return reject(err);
          }
          const sid = rows && rows[0] ? rows[0].supplier_id : null;
          resolve(sid != null && String(sid).trim() !== "" ? String(sid) : null);
        }
      );
    });
  }

  /**
   * Most recent non-empty supplier_id on purchase for a supplier name.
   * @returns {Promise<string|null>}
   */
  findSupplierIdBySupplierName(supplierName) {
    const name = supplierName != null ? String(supplierName).trim() : "";
    if (!name) {
      return Promise.resolve(null);
    }
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT supplier_id
         FROM purchase
         WHERE LOWER(TRIM(supplier_name)) = LOWER(?)
           AND supplier_id IS NOT NULL
           AND TRIM(supplier_id) != ''
         ORDER BY purchase_id DESC
         LIMIT 1`,
        [name],
        (err, rows) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PURCHASE",
              code: "REPOSITORY.PURCHASE.SUPPLIER_ID_BY_NAME",
              description: err.toString(),
              category: "",
              ref: { supplierName: name },
            });
            return reject(err);
          }
          const sid = rows && rows[0] ? rows[0].supplier_id : null;
          resolve(sid != null && String(sid).trim() !== "" ? String(sid) : null);
        }
      );
    });
  }

  async deleteTallyResponse(VoucherNo) {
    return new Promise((resolve, reject) => {
      try {
        this.db.query(
          `DELETE tr FROM purchase_tally_response tr
           INNER JOIN purchase p ON p.purchase_id = tr.purchase_id
           WHERE p.mmh_mrc_refno = ?`,
          [VoucherNo],
          (err, result) => {
            if (err) {
              logger.Log({
                level: logger.LEVEL.ERROR,
                component: "REPOSITORY.PURCHASE",
                code: "REPOSITORY.PURCHASE.DELETE-TALLY",
                description: err.toString(),
                category: "",
                ref: {},
              });
              reject(err);
              return;
            }

            resolve({
              code: 200,
              msg: "Tally response deleted!",
            });
          }
        );
      } catch (err) {
        logger.Log({
          level: logger.LEVEL.ERROR,
          component: "REPOSITORY.PURCHASE",
          code: "REPOSITORY.PURCHASE.DELETE-TALLY",
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
