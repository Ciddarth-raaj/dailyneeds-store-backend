const logger = require("../utils/logger");
const moment = require("moment");
const {
  purchaseOverlaySelectList,
  purchaseOverlayJoins,
  mergedDateExpr,
} = require("../utils/purchase_overlay_sql");
const { normalizePurchaseTaxArrays } = require("../utils/purchase_tax");
const { roundOffForRow } = require("../utils/retailpilot_purchase");
const {
  sourceOf,
  buildSource,
  mergeRetailPilotUpdate,
  roundOffIsSyncs,
  keptFields,
  seriesOf,
  parseSource,
} = require("../utils/retailpilot_merge");
const { purchaseDiscrepancies, asLegacy } = require("../utils/purchase_discrepancy");

const parseTaxList = (v) => {
  if (Array.isArray(v)) return v;
  if (v == null || v === "") return [];
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const seriesFor = (payload) => ({ fy: payload.FY || null, entered_at: payload.ENTERED_AT || null });

/** A stored purchase row with its tax columns parsed. */
const parsedRow = (row) => ({
  ...row,
  sgst: parseTaxList(row.sgst),
  cgst: parseTaxList(row.cgst),
  igst: parseTaxList(row.igst),
  cess: parseTaxList(row.cess),
});

const FIELD_LABELS = {
  supplier_id: "supplier id",
  supplier_name: "supplier name",
  supplier_gstn: "GSTIN",
  mmh_mrc_dt: "MRC date",
  mmh_mrc_amt: "bill amount",
  mmh_dist_bill_dt: "supplier bill date",
  mmh_dist_bill_no: "supplier bill no",
  mmh_manual_disc: "discount",
  mmd_goods_tcs_amt: "TCS",
  tax: "tax",
  mmh_mrc_refno: "MRC ref no",
};

/**
 * utils/purchase_discrepancy.js for a stored row, plus, for a RetailPilot
 * bill, the RetailPilot changes not applied because Accounts had corrected
 * those fields and a round-off Accounts have not confirmed yet. A GoFrugal
 * bill (no retailpilot_source) gets the same findings as review only, so
 * its approval behaviour is what it was.
 */
function discrepanciesFor(doc, retailpilotSource) {
  if (!retailpilotSource) return asLegacy(purchaseDiscrepancies(parsedRow(doc)));
  const series = seriesOf(retailpilotSource);
  const list = purchaseDiscrepancies({
    ...parsedRow(doc),
    voucher_fy: series.fy,
    entered_at: series.entered_at,
  });
  if (!Number(doc.is_approved) && roundOffIsSyncs(doc, retailpilotSource) && Number(doc.round_off)) {
    list.push({
      code: "ROUND_OFF_PREFILLED",
      severity: "info",
      message: `Round-off ${Number(doc.round_off).toFixed(2)} was pre-filled from RetailPilot's bill amount and is not confirmed yet: check it before approving.`,
    });
  }
  const kept = keptFields(retailpilotSource);
  if (kept.length) {
    list.push({
      code: "RETAILPILOT_CHANGE_NOT_APPLIED",
      severity: "review",
      message: `RetailPilot changed the ${kept.map((k) => FIELD_LABELS[k] || k).join(", ")} after Accounts corrected it; Accounts' value is kept. Check which is right.`,
    });
  }
  return list;
}

/**
 * For the Purchase screen's live check: the financial year a RetailPilot
 * bill's ref no is numbered in, and when it was entered (null for GoFrugal).
 */
function retailPilotSeries(retailpilotSource) {
  const series = seriesOf(retailpilotSource);
  return {
    retailpilot: !!retailpilotSource,
    voucher_fy: series.fy || null,
    entered_at: series.entered_at || null,
  };
}

/** The RetailPilot sync payload (uppercase keys) as purchase columns. */
function retailPilotRow(p) {
  return normalizePurchaseTaxArrays({
    retail_outlet_id: p.STORE_ID,
    supplier_id: p.SUPPLIER_ID,
    supplier_name: p.SUPPLIER_NAME,
    supplier_gstn: p.SUPPLIER_GSTN,
    mmh_mrc_no: String(p.MRC_NO),
    mmh_mrc_dt: moment(p.MRC_DATE).format("YYYY-MM-DD"),
    mmh_mrc_amt: p.MRC_AMT,
    mmh_dist_bill_dt: moment(p.DIST_BILL_DT).format("YYYY-MM-DD"),
    mmh_dist_bill_no: p.DIST_BILL_NO,
    mmh_mrc_refno: String(p.MRC_REF).trim(),
    mmh_manual_disc: p.MANUAL_DISC,
    tot_sgst_amt: p.TOT_SGST_AMT,
    tot_cgst_amt: p.TOT_CGST_AMT,
    tot_igst_amt: p.TOT_IGST_AMT,
    tot_gst_cess_amt: p.TOT_GST_CESS_AMT,
    mmd_goods_tcs_amt: p.GOODS_TCS_AMT,
    ts: p.TS,
    sgst: p.SGST,
    cgst: p.CGST,
    igst: p.IGST,
    cess: p.CESS,
  });
}

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
    const parsed = {
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

    return normalizePurchaseTaxArrays(parsed);
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
          p.is_new,
          p.retailpilot_source,
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

          const parsedDocs = docs.map(({ retailpilot_source, ...doc }) => ({
            ...this._parsePurchaseDoc(doc),
            ...retailPilotSeries(retailpilot_source),
            discrepancies: discrepanciesFor(doc, retailpilot_source),
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
          p.retailpilot_source,
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

          const { retailpilot_source, ...doc } = docs[0];
          const parsedDoc = {
            ...this._parsePurchaseDoc(doc),
            ...retailPilotSeries(retailpilot_source),
            discrepancies: discrepanciesFor(doc, retailpilot_source),
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

  getByMmhMrcRefno(mmh_mrc_refno, retail_outlet_id = null) {
    const conditions = ["TRIM(p.mmh_mrc_refno) = TRIM(?)"];
    const values = [mmh_mrc_refno];
    if (retail_outlet_id != null && retail_outlet_id !== "") {
      conditions.push("p.retail_outlet_id = ?");
      values.push(retail_outlet_id);
    }

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
        WHERE ${conditions.join(" AND ")}
        ORDER BY p.purchase_id DESC
        LIMIT 1`,
        values,
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PURCHASE",
              code: "REPOSITORY.PURCHASE.GET-BY-MMH-MRC-REFNO",
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
          const formattedPurchase = normalizePurchaseTaxArrays({
            ...purchase,
            mmh_mrc_dt: moment(purchase.mmh_mrc_dt).format("YYYY-MM-DD"),
            mmh_dist_bill_dt: moment(purchase.mmh_dist_bill_dt).format(
              "YYYY-MM-DD"
            ),
          });

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

  _q(sql, params) {
    return new Promise((resolve, reject) => {
      this.db.query(sql, params, (err, result) => (err ? reject(err) : resolve(result)));
    });
  }

  /**
   * What upsertRetailPilotPurchase WOULD do with this bill, for a dry run:
   * the same lookup and the same decision, and no write of any kind.
   *
   * @returns {{ action: "inserted"|"updated"|"unchanged"|"approved", purchase_id?: number }}
   */
  async previewRetailPilotPurchase(payload) {
    const row = retailPilotRow(payload);
    const [existing] = await this._q(
      `SELECT purchase_id, is_approved, ts FROM purchase
        WHERE mmh_mrc_no = ? AND retail_outlet_id = ? ORDER BY purchase_id DESC`,
      [row.mmh_mrc_no, row.retail_outlet_id]
    );
    if (!existing) return { action: "inserted" };
    if (Number(existing.is_approved)) return { action: "approved", purchase_id: existing.purchase_id };
    if (String(existing.ts) === String(row.ts)) return { action: "unchanged", purchase_id: existing.purchase_id };
    return { action: "updated", purchase_id: existing.purchase_id };
  }

  /**
   * Saves one RetailPilot bill (the uppercase sync payload), found by outlet
   * + mmh_mrc_no (the invoice slug - unique and stable, unlike the refno,
   * which restarts every financial year). Every write is by purchase_id.
   *
   * - new bill: inserted, with the round-off pre-filled into purchase_internal
   * - approved bill: never touched
   * - unapproved bill RetailPilot changed: merged field by field with
   *   Accounts' corrections (utils/retailpilot_merge.js) - a corrected field
   *   keeps Accounts' value; the pre-filled round-off is refreshed only while
   *   it is still the sync's own
   *
   * @returns {{ action: "inserted"|"updated"|"unchanged"|"approved",
   *   purchase_id, round_off?: number, kept: string[] }}
   */
  async upsertRetailPilotPurchase(payload) {
    const row = retailPilotRow(payload);
    const [existing] = await this._q(
      `SELECT * FROM purchase WHERE mmh_mrc_no = ? AND retail_outlet_id = ? ORDER BY purchase_id DESC`,
      [row.mmh_mrc_no, row.retail_outlet_id]
    );

    if (!existing) {
      const ro = roundOffForRow(row);
      const res = await this._q(
        `INSERT INTO purchase (
          retail_outlet_id, supplier_id, supplier_name, supplier_gstn,
          mmh_mrc_no, mmh_mrc_dt, mmh_mrc_amt, mmh_dist_bill_dt,
          mmh_dist_bill_no, mmh_mrc_refno, mmh_manual_disc,
          tot_sgst_amt, tot_cgst_amt, tot_igst_amt, tot_gst_cess_amt,
          mmd_goods_tcs_amt, ts, sgst, cgst, igst, cess, retailpilot_source
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.retail_outlet_id, row.supplier_id, row.supplier_name, row.supplier_gstn,
          row.mmh_mrc_no, row.mmh_mrc_dt, row.mmh_mrc_amt, row.mmh_dist_bill_dt,
          row.mmh_dist_bill_no, row.mmh_mrc_refno, row.mmh_manual_disc,
          row.tot_sgst_amt, row.tot_cgst_amt, row.tot_igst_amt, row.tot_gst_cess_amt,
          row.mmd_goods_tcs_amt, row.ts,
          JSON.stringify(row.sgst), JSON.stringify(row.cgst), JSON.stringify(row.igst), JSON.stringify(row.cess),
          buildSource(sourceOf(row), ro, [], seriesFor(payload)),
        ]
      );
      await this._insertRoundOff(res.insertId, ro);
      return { action: "inserted", purchase_id: res.insertId, round_off: ro.round_off, kept: [] };
    }

    if (Number(existing.is_approved)) {
      return { action: "approved", purchase_id: existing.purchase_id, kept: keptFields(existing.retailpilot_source) };
    }

    const [internal] = await this._q(`SELECT * FROM purchase_internal WHERE purchase_id = ?`, [existing.purchase_id]);

    if (String(existing.ts) === String(row.ts)) {
      // Nothing new from RetailPilot. A run that stopped between the two
      // writes left no round-off: add it now.
      if (!internal) {
        const ro = roundOffForRow(parsedRow(existing));
        await this._insertRoundOff(existing.purchase_id, ro);
      }
      return { action: "unchanged", purchase_id: existing.purchase_id, kept: keptFields(existing.retailpilot_source) };
    }

    const { changes, kept, fields } = mergeRetailPilotUpdate(existing, row);
    if (String(existing.mmh_mrc_refno).trim() !== row.mmh_mrc_refno) kept.push("mmh_mrc_refno");

    const ro = roundOffForRow({ ...parsedRow(existing), ...changes });
    const syncOwnsRoundOff = !internal || roundOffIsSyncs(internal, existing.retailpilot_source);

    const columns = Object.keys(changes);
    const values = columns.map((c) =>
      Array.isArray(changes[c]) ? JSON.stringify(changes[c]) : changes[c]
    );
    const res = await this._q(
      `UPDATE purchase SET ${columns.map((c) => `${c} = ?, `).join("")}ts = ?, retailpilot_source = ?
       WHERE purchase_id = ? AND is_approved = 0`,
      [...values, row.ts, buildSource(fields, syncOwnsRoundOff ? ro : null, kept, seriesFor(payload)), existing.purchase_id]
    );
    if (!res.affectedRows) {
      // Approved between the read and the write: frozen.
      return { action: "approved", purchase_id: existing.purchase_id, kept };
    }

    if (!internal) {
      await this._insertRoundOff(existing.purchase_id, ro);
    } else if (syncOwnsRoundOff) {
      // Compare-and-set on the values the sync wrote, so an Accounts save
      // landing in between is not overwritten.
      await this._q(
        `UPDATE purchase_internal pi
         INNER JOIN purchase p ON p.purchase_id = pi.purchase_id
         SET pi.round_off = ?, pi.total_amount = ?
         WHERE pi.purchase_id = ? AND p.is_approved = 0
           AND pi.round_off = ? AND pi.total_amount = ?`,
        [ro.round_off, ro.total_amount, existing.purchase_id, internal.round_off, internal.total_amount]
      );
    }

    return {
      action: "updated",
      purchase_id: existing.purchase_id,
      round_off: syncOwnsRoundOff ? ro.round_off : undefined,
      kept,
    };
  }

  /**
   * One audit entry for a purchase. actor: { user_id, employee_id } of the
   * session (null for the sync or an integration). Never throws: a failed
   * audit write is logged and the action it records stands.
   */
  async addAuditLog(purchaseId, action, actor, detail) {
    try {
      await this._q(
        `INSERT INTO purchase_audit_log (purchase_id, action, actor_user_id, actor_employee_id, detail)
         VALUES (?, ?, ?, ?, ?)`,
        [purchaseId, action, actor?.user_id ?? null, actor?.employee_id ?? null, detail == null ? null : JSON.stringify(detail)]
      );
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "REPOSITORY.PURCHASE",
        code: "REPOSITORY.PURCHASE.AUDIT-LOG",
        description: err.toString(),
        category: "",
        ref: { purchaseId, action },
      });
    }
  }

  /** A purchase's own row and its purchase_internal values, unmerged. */
  async getForAudit(purchaseId) {
    const [row] = await this._q(
      `SELECT p.*, pi.round_off, pi.total_amount, pi.cash_discount, pi.scheme_difference,
              pi.cost_difference, pi.due, pi.freight_charges, pi.supplier_credit_note
       FROM purchase p LEFT JOIN purchase_internal pi ON pi.purchase_id = p.purchase_id
       WHERE p.purchase_id = ?`,
      [purchaseId]
    );
    return row || null;
  }

  /**
   * Accounts saved a RetailPilot bill on the Purchase screen: its round-off
   * is theirs from now on, and the sync stops refreshing it.
   */
  async confirmRetailPilotRoundOff(purchaseId) {
    const [row] = await this._q(`SELECT retailpilot_source FROM purchase WHERE purchase_id = ?`, [purchaseId]);
    const source = row && parseSource(row.retailpilot_source);
    if (!source || source.round_off == null) return false;
    await this._q(`UPDATE purchase SET retailpilot_source = ? WHERE purchase_id = ?`, [
      JSON.stringify({ ...source, round_off: null }),
      purchaseId,
    ]);
    return true;
  }

  /**
   * Round-off into purchase_internal for an unapproved bill that has none.
   * invoice_amount (NOT NULL, no default) is 0, as an untouched Purchase
   * screen would save it - Accounts enter it.
   */
  _insertRoundOff(purchaseId, ro) {
    return this._q(
      `INSERT INTO purchase_internal (purchase_id, round_off, total_amount, supplier_credit_note, invoice_amount)
       SELECT p.purchase_id, ?, ?, 0, 0
       FROM purchase p
       WHERE p.purchase_id = ? AND p.is_approved = 0
         AND NOT EXISTS (SELECT 1 FROM purchase_internal pi WHERE pi.purchase_id = p.purchase_id)`,
      [ro.round_off, ro.total_amount, purchaseId]
    );
  }

  /**
   * Existing rows holding a reference at an outlet within one financial
   * year: keys are [retail_outlet_id, mmh_mrc_refno, fy_start, fy_end].
   * The refno restarts every April, so the same number in another year is
   * a different bill and is not returned.
   */
  findByOutletRefnos(keys) {
    if (!keys || keys.length === 0) return Promise.resolve([]);
    const where = keys
      .map(() => "(retail_outlet_id = ? AND mmh_mrc_refno = ? AND mmh_mrc_dt BETWEEN ? AND ?)")
      .join(" OR ");
    const values = keys.flatMap(([outletId, refno, start, end]) => [outletId, refno, start, end]);
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT purchase_id, retail_outlet_id, mmh_mrc_refno, mmh_mrc_no, mmh_mrc_dt,
                supplier_gstn, mmh_dist_bill_no
         FROM purchase WHERE ${where}`,
        values,
        (err, rows) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PURCHASE",
              code: "REPOSITORY.PURCHASE.FIND-BY-OUTLET-REFNOS",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve(rows || []);
        }
      );
    });
  }

  /**
   * Removes the Tally response of ONE purchase, by its id - the only key
   * that cannot reach another branch's or another year's bill.
   */
  async deleteTallyResponseForPurchase(purchaseId, actor = null) {
    try {
      const [existing] = await this._q(`SELECT * FROM purchase_tally_response WHERE purchase_id = ?`, [purchaseId]);
      if (!existing) return { code: 404, msg: "This purchase has no Tally response" };
      const result = await this._q(`DELETE FROM purchase_tally_response WHERE purchase_id = ?`, [purchaseId]);
      if (!result.affectedRows) return { code: 404, msg: "This purchase has no Tally response" };
      await this.addAuditLog(purchaseId, "tally_response_deleted", actor, {
        MasterID: existing.MasterID,
        VoucherNo: existing.VoucherNo,
        InvoiceValue: existing.InvoiceValue,
        CostCentre: existing.CostCentre,
        GSTIN: existing.GSTIN,
      });
      return { code: 200, msg: "Tally response deleted!", purchase_id: Number(purchaseId) };
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "REPOSITORY.PURCHASE",
        code: "REPOSITORY.PURCHASE.DELETE-TALLY",
        description: err.toString(),
        category: "",
        ref: { purchaseId },
      });
      throw err;
    }
  }

  /**
   * The old delete-by-voucher-number. The voucher number (mmh_mrc_refno)
   * repeats across branches and restarts every financial year, so this used
   * to delete the responses of every purchase carrying it. Now it deletes
   * only when exactly one purchase with that number has a response, and
   * otherwise refuses and points to the delete by purchase id.
   */
  async deleteTallyResponse(VoucherNo, actor = null) {
    const rows = await this._q(
      `SELECT p.purchase_id
       FROM purchase_tally_response tr
       INNER JOIN purchase p ON p.purchase_id = tr.purchase_id
       WHERE p.mmh_mrc_refno = ?`,
      [VoucherNo]
    );
    const ids = [...new Set(rows.map((r) => r.purchase_id))];
    if (ids.length === 0) return { code: 404, msg: "No Tally response for this voucher number" };
    if (ids.length > 1) {
      return {
        code: 409,
        msg: `Voucher number ${VoucherNo} has Tally responses on ${ids.length} purchases (different branches or years). Delete it from the purchase instead.`,
        purchase_ids: ids,
      };
    }
    return this.deleteTallyResponseForPurchase(ids[0], actor);
  }
}

module.exports = (db) => {
  return new PurchaseRepository(db);
};
