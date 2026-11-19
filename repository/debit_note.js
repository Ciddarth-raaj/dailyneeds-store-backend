const logger = require("../utils/logger");
const {
  mergedCol,
  purchaseOverlayJoins,
} = require("../utils/purchase_overlay_sql");
const moment = require("moment");

/**
 * Tally's response to a debit note. A RetailPilot debit note (mprh_pr_no
 * REC-...) can share its number with an older GoFrugal one at the same
 * outlet - RetailPilot numbers continue into GoFrugal's - so it is matched
 * on the MasterID the export sent for it (debitNoteEntryMasterId: always
 * plain for these new rows). GoFrugal debit notes keep the voucher number
 * + outlet match they always had, less any response whose plain MasterID
 * names another debit note (one that shares the number).
 */
const RETAILPILOT_DN = "(dn.mprh_pr_no LIKE 'REC-%')";
const TALLY_VOUCHER = "COALESCE(dntr.VoucherNo, dntr_rp.VoucherNo)";

class DebitNoteRepository {
  constructor(db) {
    this.db = db;
  }

  create(data) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `INSERT INTO debit_note (
          store_id, mprh_pr_no, mprh_pr_refno, mprh_pr_dt,
          mprh_dist_code, supplier_id, supplier_name, supplier_gstn,
          tot_sgst_amt, tot_cgst_amt, tot_igst_amt, tot_gst_cess_amt,
          tot_item_qty, tot_item_value, ts, sgst, cgst, igst, cess
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          store_id = VALUES(store_id),
          mprh_pr_no = VALUES(mprh_pr_no),
          mprh_pr_dt = VALUES(mprh_pr_dt),
          mprh_dist_code = VALUES(mprh_dist_code),
          supplier_id = VALUES(supplier_id),
          supplier_name = VALUES(supplier_name),
          supplier_gstn = VALUES(supplier_gstn),
          tot_sgst_amt = VALUES(tot_sgst_amt),
          tot_cgst_amt = VALUES(tot_cgst_amt),
          tot_igst_amt = VALUES(tot_igst_amt),
          tot_gst_cess_amt = VALUES(tot_gst_cess_amt),
          tot_item_qty = VALUES(tot_item_qty),
          tot_item_value = VALUES(tot_item_value),
          ts = VALUES(ts),
          sgst = VALUES(sgst),
          cgst = VALUES(cgst),
          igst = VALUES(igst),
          cess = VALUES(cess)`,
        [
          data.STORE_ID,
          data.MPRH_PR_NO,
          data.MPRH_PR_REFNO,
          data.MPRH_PR_DT,
          data.MPRH_DIST_CODE,
          data.SUPPLIER_ID,
          data.SUPPLIER_NAME,
          data.SUPPLIER_GSTN,
          data.TOT_SGST_AMT,
          data.TOT_CGST_AMT,
          data.TOT_IGST_AMT,
          data.TOT_GST_CESS_AMT,
          data.TOT_ITEM_QTY,
          data.TOT_ITEM_VALUE,
          data.TS,
          JSON.stringify(data.SGST),
          JSON.stringify(data.CGST),
          JSON.stringify(data.IGST),
          JSON.stringify(data.CESS),
        ],
        (err, result) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.DEBIT_NOTE",
              code: "REPOSITORY.DEBIT_NOTE.CREATE",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve({
            code: 200,
            message: result.insertId
              ? "Created successfully"
              : "Updated successfully",
            data: result,
          });
        }
      );
    });
  }

  getAll(filters = {}) {
    return new Promise((resolve, reject) => {
      let filterConditions = [];
      let filterValues = [];

      if (filters.store_id) {
        filterConditions.push("store_id = ?");
        filterValues.push(filters.store_id);
      }

      if (filters.from_date) {
        filterConditions.push("DATE(mprh_pr_dt) >= ?");
        filterValues.push(filters.from_date);
      }

      if (filters.to_date) {
        filterConditions.push("DATE(mprh_pr_dt) <= ?");
        filterValues.push(filters.to_date);
      }

      if (filters.has_updated !== undefined) {
        filterConditions.push("dn.has_updated = ?");
        filterValues.push(filters.has_updated);
      }

      if (filters.is_approved !== undefined) {
        const conditionString = filters.is_approved
          ? `dn.is_approved = ? AND ${TALLY_VOUCHER} IS NULL`
          : "dn.is_approved = ?";
        filterConditions.push(conditionString);
        filterValues.push(filters.is_approved);
      }

      if (filters.is_pushed === true) {
        filterConditions.push(`${TALLY_VOUCHER} IS NOT NULL`);
      } else if (filters.is_pushed === false) {
        filterConditions.push(`${TALLY_VOUCHER} IS NULL`);
      }

      const whereClause =
        filterConditions.length > 0
          ? `WHERE ${filterConditions.join(" AND ")}`
          : "";

      this.db.query(
        `SELECT dn.*,
          dni.scheme_difference,
          dni.narration,
          dni.tcs_value,
          dni.total_amount,
          dni.round_off,
          dni.mmh_mrc_refno,
          ${TALLY_VOUCHER} AS VoucherNo,
          COALESCE(dntr.InvoiceValue, dntr_rp.InvoiceValue) AS InvoiceValue,
          COALESCE(dntr.SupplierName, dntr_rp.SupplierName) AS SupplierName,
          COALESCE(dntr.CostCentre, dntr_rp.CostCentre) AS CostCentre,
          o.outlet_name,
          o.outlet_id,
          ${mergedCol("mmh_dist_bill_dt")} AS mmh_dist_bill_dt,
          ${mergedCol("mmh_dist_bill_no")} AS mmh_dist_bill_no
        FROM debit_note dn
        LEFT JOIN debit_note_internal dni ON dn.debit_note_id = dni.debit_note_id
        LEFT JOIN outlets o ON dn.store_id = o.outlet_id
        LEFT JOIN debit_note_tally_response dntr ON ${RETAILPILOT_DN} = 0
          AND dntr.VoucherNo = dn.mprh_pr_refno AND dntr.CostCentre = o.outlet_name
          AND NOT (dntr.MasterID REGEXP '^[0-9]+-purchase-entry$'
                   AND dntr.MasterID <> CONCAT(dn.debit_note_id, '-purchase-entry'))
        LEFT JOIN debit_note_tally_response dntr_rp ON ${RETAILPILOT_DN} = 1
          AND dntr_rp.MasterID = CONCAT(dn.debit_note_id, '-purchase-entry')
        LEFT JOIN purchase p ON p.mmh_mrc_refno = dni.mmh_mrc_refno AND p.retail_outlet_id = o.outlet_id
        ${purchaseOverlayJoins("p")}
        ${whereClause}
        ORDER BY created_at DESC`,
        filterValues,
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.DEBIT_NOTE",
              code: "REPOSITORY.DEBIT_NOTE.GET-ALL",
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
            // Set default values for internal fields
            scheme_difference: doc.scheme_difference || 0.0,
            narration: doc.narration || "",
            tcs_value: doc.tcs_value || 0.0,
            total_amount: doc.total_amount || 0.0,
            round_off: doc.round_off || 0.0,
            // Add fields from purchase_tally_response
            tally_response: {
              voucher_no: doc.VoucherNo || null,
              invoice_value: doc.InvoiceValue || null,
              supplier_name: doc.SupplierName || null,
              cost_centre: doc.CostCentre || null,
            },
            mmh_dist_bill_no: doc.mmh_dist_bill_no || null,
            mmh_dist_bill_dt: doc.mmh_dist_bill_dt || null,
          }));

          resolve({ code: 200, data: parsedDocs });
        }
      );
    });
  }

  bulkCreate(dataList) {
    return new Promise((resolve, reject) => {
      const values = dataList
        .map((data) => [
          data.STORE_ID,
          data.MPRH_PR_NO,
          data.MPRH_PR_REFNO,
          data.MPRH_PR_DT,
          data.MPRH_DIST_CODE,
          data.SUPPLIER_ID,
          data.SUPPLIER_NAME,
          data.SUPPLIER_GSTN,
          data.TOT_SGST_AMT,
          data.TOT_CGST_AMT,
          data.TOT_IGST_AMT,
          data.TOT_GST_CESS_AMT,
          data.TOT_ITEM_QTY,
          data.TOT_ITEM_VALUE,
          data.TS,
          JSON.stringify(data.SGST),
          JSON.stringify(data.CGST),
          JSON.stringify(data.IGST),
          JSON.stringify(data.CESS),
        ])
        .flat();

      const placeholders = dataList
        .map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .join(", ");

      this.db.query(
        `INSERT INTO debit_note (
          store_id, mprh_pr_no, mprh_pr_refno, mprh_pr_dt,
          mprh_dist_code, supplier_id, supplier_name, supplier_gstn,
          tot_sgst_amt, tot_cgst_amt, tot_igst_amt, tot_gst_cess_amt,
          tot_item_qty, tot_item_value, ts, sgst, cgst, igst, cess
      ) VALUES ${placeholders}
      ON DUPLICATE KEY UPDATE
          store_id = CASE WHEN is_approved = 1  THEN store_id ELSE VALUES(store_id) END,
          mprh_pr_no = CASE WHEN is_approved = 1  THEN mprh_pr_no ELSE VALUES(mprh_pr_no) END,
          mprh_pr_dt = CASE WHEN is_approved = 1  THEN mprh_pr_dt ELSE VALUES(mprh_pr_dt) END,
          mprh_dist_code = CASE WHEN is_approved = 1  THEN mprh_dist_code ELSE VALUES(mprh_dist_code) END,
          supplier_id = CASE WHEN is_approved = 1  THEN supplier_id ELSE VALUES(supplier_id) END,
          supplier_name = CASE WHEN is_approved = 1  THEN supplier_name ELSE VALUES(supplier_name) END,
          supplier_gstn = CASE WHEN is_approved = 1  THEN supplier_gstn ELSE VALUES(supplier_gstn) END,
          tot_sgst_amt = CASE WHEN is_approved = 1  THEN tot_sgst_amt ELSE VALUES(tot_sgst_amt) END,
          tot_cgst_amt = CASE WHEN is_approved = 1  THEN tot_cgst_amt ELSE VALUES(tot_cgst_amt) END,
          tot_igst_amt = CASE WHEN is_approved = 1  THEN tot_igst_amt ELSE VALUES(tot_igst_amt) END,
          tot_gst_cess_amt = CASE WHEN is_approved = 1  THEN tot_gst_cess_amt ELSE VALUES(tot_gst_cess_amt) END,
          tot_item_qty = CASE WHEN is_approved = 1  THEN tot_item_qty ELSE VALUES(tot_item_qty) END,
          tot_item_value = CASE WHEN is_approved = 1  THEN tot_item_value ELSE VALUES(tot_item_value) END,
          ts = CASE WHEN is_approved = 1  THEN ts ELSE VALUES(ts) END,
          sgst = CASE WHEN is_approved = 1  THEN sgst ELSE VALUES(sgst) END,
          cgst = CASE WHEN is_approved = 1  THEN cgst ELSE VALUES(cgst) END,
          igst = CASE WHEN is_approved = 1  THEN igst ELSE VALUES(igst) END,
          cess = CASE WHEN is_approved = 1  THEN cess ELSE VALUES(cess) END;

`,
        values,
        (err, result) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.DEBIT_NOTE",
              code: "REPOSITORY.DEBIT_NOTE.BULK-CREATE",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve({
            code: 200,
            message: `Successfully processed ${dataList.length} records (${result.affectedRows} inserted/updated)`,
          });
        }
      );
    });
  }

  async updateFlags(purchaseId, flags) {
    return new Promise((resolve, reject) => {
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
          `UPDATE debit_note SET ${updates.join(", ")} WHERE debit_note_id = ?`,
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
          component: "REPOSITORY.DEBIT-NOTE",
          code: "REPOSITORY.DEBIT-NOTE.UPDATE-FLAGS",
          description: err.toString(),
          category: "",
          ref: {},
        });
        reject(err);
      }
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

  async updateDebitNoteWithInternal(debitNote, debitNoteInternal) {
    return new Promise(async (resolve, reject) => {
      try {
        // Check if debit note exists
        const [existingDebitNote] = await new Promise((resolve, reject) => {
          this.db.query(
            `SELECT * FROM debit_note WHERE debit_note_id = ?`,
            [debitNote.id],
            (err, result) => {
              if (err) reject(err);
              resolve([result[0]]);
            }
          );
        });

        if (!existingDebitNote) {
          reject(new Error("Debit Note not found"));
          return;
        }

        // Compare values to check if update is needed
        const hasChanges =
          existingDebitNote.store_id != debitNote.store_id ||
          existingDebitNote.mprh_pr_no != debitNote.mprh_pr_no ||
          existingDebitNote.mprh_pr_refno != debitNote.mprh_pr_refno ||
          moment(existingDebitNote.mprh_pr_dt).format("YYYY-MM-DD") !=
            moment(debitNote.mprh_pr_dt).format("YYYY-MM-DD") ||
          existingDebitNote.mprh_dist_code != debitNote.mprh_dist_code ||
          existingDebitNote.supplier_id != debitNote.supplier_id ||
          existingDebitNote.supplier_name != debitNote.supplier_name ||
          existingDebitNote.supplier_gstn != debitNote.supplier_gstn ||
          existingDebitNote.tot_sgst_amt != debitNote.tot_sgst_amt ||
          existingDebitNote.tot_cgst_amt != debitNote.tot_cgst_amt ||
          existingDebitNote.tot_igst_amt != debitNote.tot_igst_amt ||
          existingDebitNote.tot_gst_cess_amt != debitNote.tot_gst_cess_amt ||
          existingDebitNote.tot_item_qty != debitNote.tot_item_qty ||
          existingDebitNote.tot_item_value != debitNote.tot_item_value ||
          !this.compareTaxArrays(
            JSON.parse(existingDebitNote.sgst),
            debitNote.sgst
          ) ||
          !this.compareTaxArrays(
            JSON.parse(existingDebitNote.cgst),
            debitNote.cgst
          ) ||
          !this.compareTaxArrays(
            JSON.parse(existingDebitNote.igst),
            debitNote.igst
          ) ||
          !this.compareTaxArrays(
            JSON.parse(existingDebitNote.cess),
            debitNote.cess
          );

        if (hasChanges) {
          await new Promise((resolve, reject) => {
            this.db.query(
              `UPDATE debit_note SET
                store_id = ?,
                mprh_pr_no = ?,
                mprh_pr_refno = ?,
                mprh_pr_dt = ?,
                mprh_dist_code = ?,
                supplier_id = ?,
                supplier_name = ?,
                supplier_gstn = ?,
                tot_sgst_amt = ?,
                tot_cgst_amt = ?,
                tot_igst_amt = ?,
                tot_gst_cess_amt = ?,
                tot_item_qty = ?,
                tot_item_value = ?,
                sgst = ?,
                cgst = ?,
                igst = ?,
                cess = ?
              WHERE debit_note_id = ?`,
              [
                debitNote.store_id,
                debitNote.mprh_pr_no,
                debitNote.mprh_pr_refno,
                moment(debitNote.mprh_pr_dt).format("YYYY-MM-DD"),
                debitNote.mprh_dist_code,
                debitNote.supplier_id,
                debitNote.supplier_name,
                debitNote.supplier_gstn,
                debitNote.tot_sgst_amt,
                debitNote.tot_cgst_amt,
                debitNote.tot_igst_amt,
                debitNote.tot_gst_cess_amt,
                debitNote.tot_item_qty,
                debitNote.tot_item_value,
                JSON.stringify(debitNote.sgst),
                JSON.stringify(debitNote.cgst),
                JSON.stringify(debitNote.igst),
                JSON.stringify(debitNote.cess),
                debitNote.id,
              ],
              (err, result) => {
                if (err) reject(err);
                resolve(result);
              }
            );
          });
        }

        // Handle debit_note_internal
        if (debitNoteInternal) {
          const [existingInternal] = await new Promise((resolve, reject) => {
            this.db.query(
              `SELECT * FROM debit_note_internal WHERE debit_note_id = ?`,
              [debitNote.id],
              (err, result) => {
                if (err) reject(err);
                resolve([result[0]]);
              }
            );
          });

          if (existingInternal) {
            await new Promise((resolve, reject) => {
              this.db.query(
                `UPDATE debit_note_internal SET
                  scheme_difference = ?,
                  narration = ?,
                  tcs_value = ?,
                  total_amount = ?,
                  mmh_mrc_refno = ?,
                  round_off = ?,
                  filled_by_sync = 0
                WHERE debit_note_id = ?`,
                [
                  debitNoteInternal.scheme_difference || 0.0,
                  debitNoteInternal.narration || "",
                  debitNoteInternal.tcs_value || 0.0,
                  debitNoteInternal.total_amount || 0.0,
                  debitNoteInternal.mmh_mrc_refno || "",
                  debitNoteInternal.round_off || 0.0,
                  debitNote.id,
                ],
                (err, result) => {
                  if (err) reject(err);
                  resolve(result);
                }
              );
            });
          } else {
            await new Promise((resolve, reject) => {
              this.db.query(
                `INSERT INTO debit_note_internal (
                  debit_note_id,
                  scheme_difference,
                  narration,
                  tcs_value,
                  total_amount,
                  mmh_mrc_refno,
                  round_off
                ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [
                  debitNote.id,
                  debitNoteInternal.scheme_difference || 0.0,
                  debitNoteInternal.narration || "",
                  debitNoteInternal.tcs_value || 0.0,
                  debitNoteInternal.total_amount || 0.0,
                  debitNoteInternal.mmh_mrc_refno || "",
                  debitNoteInternal.round_off || 0.0,
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
          debitNoteUpdated: hasChanges,
          internalUpdated: !!debitNoteInternal,
        });
      } catch (err) {
        logger.Log({
          level: logger.LEVEL.ERROR,
          component: "REPOSITORY.DEBIT_NOTE",
          code: "REPOSITORY.DEBIT_NOTE.UPDATE-WITH-INTERNAL",
          description: err.toString(),
          category: "",
          ref: {},
        });
        reject(err);
      }
    });
  }

  _query(sql, params) {
    return new Promise((resolve, reject) => {
      this.db.query(sql, params, (err, result) => (err ? reject(err) : resolve(result)));
    });
  }

  /**
   * Debit notes at these outlets with these references in these financial
   * years, for the RetailPilot sync's clash check.
   * @param keys [[store_id, refno, fy_start, fy_end], ...]
   */
  async findByOutletRefnos(keys) {
    if (!keys.length) return [];
    return this._query(
      `SELECT debit_note_id, store_id, mprh_pr_no, mprh_pr_refno, mprh_pr_dt
         FROM debit_note
        WHERE ${keys.map(() => "(store_id = ? AND mprh_pr_refno = ? AND mprh_pr_dt BETWEEN ? AND ?)").join(" OR ")}`,
      keys.flat()
    );
  }

  /**
   * What the RetailPilot sync does with one debit note (the uppercase sync
   * payload), found by outlet + reconciliation slug (mprh_pr_no):
   * - not there: inserted
   * - approved: never touched
   * - saved by Accounts on the Debit Note screen (has a debit_note_internal
   *   row): not touched, so their corrections stay - reported as kept when
   *   RetailPilot has changed it since
   * - otherwise: updated when RetailPilot changed it (TS is a content hash)
   */
  async _retailPilotDecision(payload) {
    const [existing] = await this._query(
      `SELECT dn.debit_note_id, dn.is_approved, dn.ts, dni.debit_note_id AS internal_id,
              dni.filled_by_sync
         FROM debit_note dn
         LEFT JOIN debit_note_internal dni ON dni.debit_note_id = dn.debit_note_id
        WHERE dn.store_id = ? AND CAST(dn.mprh_pr_no AS CHAR) = ?
        ORDER BY dn.debit_note_id
        LIMIT 1`,
      [payload.STORE_ID, payload.MPRH_PR_NO]
    );
    if (!existing) return { action: "inserted" };
    const id = existing.debit_note_id;
    // The sync's own pre-filled internal row (filled_by_sync = 1) is not a
    // save by Accounts.
    const savedByAccounts = existing.internal_id != null && !Number(existing.filled_by_sync);
    const internal = savedByAccounts ? "accounts" : existing.internal_id != null ? "sync" : "none";
    if (Number(existing.is_approved)) return { action: "approved", debit_note_id: id, internal };
    if (String(existing.ts) === String(payload.TS)) return { action: "unchanged", debit_note_id: id, internal };
    if (savedByAccounts) return { action: "kept", debit_note_id: id, internal };
    return { action: "updated", debit_note_id: id, internal };
  }

  /**
   * How many of these RetailPilot debit notes (REC-... slugs) are in the
   * table, compared as text: the sync's check that what it wrote stuck.
   */
  async countRetailPilotSlugs(slugs) {
    if (!slugs.length) return 0;
    const [row] = await this._query(
      "SELECT COUNT(DISTINCT CAST(mprh_pr_no AS CHAR)) AS n FROM debit_note WHERE CAST(mprh_pr_no AS CHAR) IN (?)",
      [slugs]
    );
    return Number(row && row.n) || 0;
  }

  /**
   * The debit_note columns and unique keys the sync depends on, as this
   * database has them - reported when the sync's writes did not stick, since
   * environments differ from the migrations.
   */
  async describeForRetailPilot() {
    const cols = await this._query(
      `SELECT column_name AS name, column_type AS type FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'debit_note'
          AND column_name IN ('store_id', 'mprh_pr_no', 'mprh_pr_refno', 'supplier_id', 'mprh_dist_code', 'supplier_gstn')`
    );
    const keys = await this._query(
      `SELECT index_name AS name, GROUP_CONCAT(column_name ORDER BY seq_in_index) AS cols FROM information_schema.statistics
        WHERE table_schema = DATABASE() AND table_name = 'debit_note' AND non_unique = 0
        GROUP BY index_name`
    );
    const [mode] = await this._query("SELECT @@SESSION.sql_mode AS m");
    return [
      `columns: ${cols.map((c) => `${c.name} ${c.type}`).join(", ")}`,
      `unique keys: ${keys.map((k) => `${k.name}(${k.cols})`).join(", ") || "none"}`,
      `sql_mode: ${(mode && mode.m) || "(empty)"}`,
    ].join("; ");
  }

  /** Whether mprh_pr_no can hold a RetailPilot slug (REC-...): a text column. */
  async prNoHoldsText() {
    const [col] = await this._query(
      `SELECT data_type AS t FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'debit_note' AND column_name = 'mprh_pr_no'`
    );
    return !!col && ["char", "varchar", "tinytext", "text", "mediumtext", "longtext"].includes(String(col.t).toLowerCase());
  }

  /**
   * Pre-fills the Debit Note screen's internal fields for a RetailPilot debit
   * note - round-off, total amount and the purchase's MRC ref no - marked
   * filled_by_sync, until Accounts saves it on the screen
   * (updateDebitNoteWithInternal clears the mark). An unapproved debit note
   * written before these were filled gets them on the next run.
   */
  async _fillInternal(debitNoteId, payload, internal) {
    const params = [payload.TOTAL_AMOUNT || 0, payload.PURCHASE_REF || "", payload.ROUND_OFF || 0];
    if (internal === "none") {
      await this._query(
        `INSERT INTO debit_note_internal
           (debit_note_id, scheme_difference, narration, tcs_value, total_amount, mmh_mrc_refno, round_off, filled_by_sync)
         VALUES (?, 0, '', 0, ?, ?, ?, 1)`,
        [debitNoteId, ...params]
      );
    } else if (internal === "sync") {
      await this._query(
        `UPDATE debit_note_internal SET total_amount = ?, mmh_mrc_refno = ?, round_off = ?
          WHERE debit_note_id = ? AND filled_by_sync = 1`,
        [...params, debitNoteId]
      );
    }
  }

  /** What upsertRetailPilotDebitNote WOULD do, for a dry run. */
  previewRetailPilotDebitNote(payload) {
    return this._retailPilotDecision(payload);
  }

  async upsertRetailPilotDebitNote(payload) {
    const decision = await this._retailPilotDecision(payload);
    const values = [
      payload.STORE_ID,
      payload.MPRH_PR_NO,
      payload.MPRH_PR_REFNO,
      payload.MPRH_PR_DT,
      payload.MPRH_DIST_CODE,
      payload.SUPPLIER_ID,
      payload.SUPPLIER_NAME,
      payload.SUPPLIER_GSTN,
      payload.TOT_SGST_AMT,
      payload.TOT_CGST_AMT,
      payload.TOT_IGST_AMT,
      payload.TOT_GST_CESS_AMT,
      payload.TOT_ITEM_QTY,
      payload.TOT_ITEM_VALUE,
      payload.TS,
      JSON.stringify(payload.SGST),
      JSON.stringify(payload.CGST),
      JSON.stringify(payload.IGST),
      JSON.stringify(payload.CESS),
    ];
    try {
      if (decision.action === "inserted") {
        const result = await this._query(
          `INSERT INTO debit_note (
            store_id, mprh_pr_no, mprh_pr_refno, mprh_pr_dt,
            mprh_dist_code, supplier_id, supplier_name, supplier_gstn,
            tot_sgst_amt, tot_cgst_amt, tot_igst_amt, tot_gst_cess_amt,
            tot_item_qty, tot_item_value, ts, sgst, cgst, igst, cess
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          values
        );
        await this._fillInternal(result.insertId, payload, "none");
        return { action: "inserted", debit_note_id: result.insertId };
      }
      if (decision.action === "updated") {
        // is_approved = 0 again here: an approval between the read and this
        // write still wins.
        await this._query(
          `UPDATE debit_note SET
            store_id = ?, mprh_pr_no = ?, mprh_pr_refno = ?, mprh_pr_dt = ?,
            mprh_dist_code = ?, supplier_id = ?, supplier_name = ?, supplier_gstn = ?,
            tot_sgst_amt = ?, tot_cgst_amt = ?, tot_igst_amt = ?, tot_gst_cess_amt = ?,
            tot_item_qty = ?, tot_item_value = ?, ts = ?, sgst = ?, cgst = ?, igst = ?, cess = ?
          WHERE debit_note_id = ? AND is_approved = 0`,
          [...values, decision.debit_note_id]
        );
      }
      if (decision.action === "updated" || decision.action === "unchanged") {
        await this._fillInternal(decision.debit_note_id, payload, decision.internal);
      }
      return decision;
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "REPOSITORY.DEBIT_NOTE",
        code: "REPOSITORY.DEBIT_NOTE.UPSERT-RETAILPILOT",
        description: err.toString(),
        category: "",
        ref: { mprh_pr_no: payload.MPRH_PR_NO },
      });
      throw err;
    }
  }

  async deleteTallyResponse(VoucherNo) {
    return new Promise((resolve, reject) => {
      try {
        this.db.query(
          `DELETE FROM debit_note_tally_response WHERE VoucherNo = ?`,
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
  return new DebitNoteRepository(db);
};
