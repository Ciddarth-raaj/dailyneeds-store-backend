const logger = require("../utils/logger");
const { purchaseIdFromMasterId } = require("../utils/tally_master_id");

class PurchaseTallyRepository {
  constructor(db) {
    this.db = db;
  }

  _q(sql, params) {
    return new Promise((resolve, reject) => {
      this.db.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
    });
  }

  /**
   * The debit note a Tally response belongs to - as
   * PurchaseTallyRepository.resolvePurchaseForTallyResponse does for
   * purchases. The voucher number repeats (across outlets, financial years,
   * and between old GoFrugal and RetailPilot debit notes), so it is never
   * trusted alone:
   *  1. the MasterID the export sent (debitNoteEntryMasterId: plain, or
   *     encrypted for older records) carries the debit note id - used when
   *     that debit note has the response's voucher number and outlet;
   *  2. otherwise voucher number + outlet + GSTIN, narrowed to approved
   *     debit notes (only those are exported) and to ones without a
   *     response yet. More than one left: ambiguous, nothing is linked.
   *
   * @returns {Promise<{ debitNoteId: number|null, ambiguous?: number[] }>}
   */
  async resolveDebitNoteForTallyResponse({ MasterID, VoucherNo, GSTIN, CostCentre }) {
    const match = `TRIM(dn.mprh_pr_refno) = TRIM(?) AND TRIM(o.outlet_name) = TRIM(?)`;
    const fromMaster = purchaseIdFromMasterId(MasterID);
    if (fromMaster) {
      const rows = await this._q(
        `SELECT dn.debit_note_id FROM debit_note dn
         INNER JOIN outlets o ON o.outlet_id = dn.store_id
         WHERE dn.debit_note_id = ? AND ${match}`,
        [fromMaster, VoucherNo, CostCentre]
      );
      if (rows.length) return { debitNoteId: Number(rows[0].debit_note_id) };
    }

    const rows = await this._q(
      `SELECT dn.debit_note_id, dn.is_approved, tr.debit_note_id AS has_response
       FROM debit_note dn
       INNER JOIN outlets o ON o.outlet_id = dn.store_id
       LEFT JOIN debit_note_tally_response tr ON tr.debit_note_id = dn.debit_note_id
       WHERE ${match} AND UPPER(TRIM(dn.supplier_gstn)) = UPPER(TRIM(?))
       ORDER BY dn.debit_note_id DESC`,
      [VoucherNo, CostCentre, GSTIN]
    );
    if (!rows.length) return { debitNoteId: null };
    const approved = rows.filter((r) => Number(r.is_approved) === 1);
    const pool = approved.length ? approved : rows;
    const open = pool.filter((r) => r.has_response == null);
    const pick = open.length ? open : pool;
    if (pick.length === 1) return { debitNoteId: Number(pick[0].debit_note_id) };
    return { debitNoteId: null, ambiguous: pick.map((r) => Number(r.debit_note_id)) };
  }

  create(data) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `INSERT INTO debit_note_tally_response 
        (MasterID, debit_note_id, VoucherNo, InvoiceValue, SupplierName, CostCentre, GSTIN) 
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
        debit_note_id = COALESCE(VALUES(debit_note_id), debit_note_id),
        VoucherNo = VALUES(VoucherNo),
        InvoiceValue = VALUES(InvoiceValue),
        SupplierName = VALUES(SupplierName),
        GSTIN = VALUES(GSTIN),
        CostCentre = VALUES(CostCentre)`,
        [
          data.MasterID,
          data.debit_note_id ?? null,
          data.VoucherNo,
          data.InvoiceValue,
          data.SupplierName,
          data.CostCentre,
          data.GSTIN,
        ],
        (err, result) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PURCHASE_TALLY",
              code: "REPOSITORY.PURCHASE_TALLY.CREATE",
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
              ? "Inserted successfully"
              : "Updated successfully",
          });
        }
      );
    });
  }

  getAll(filters = {}) {
    return new Promise((resolve, reject) => {
      let filterConditions = [];
      let filterValues = [];

      // Filter by outlet_id
      if (filters.outlet_id) {
        filterConditions.push("o.outlet_id = ?");
        filterValues.push(filters.outlet_id);
      }

      // Filter by date range
      if (filters.from_date) {
        filterConditions.push("p.mprh_pr_dt >= ?");
        filterValues.push(filters.from_date);
      }

      if (filters.to_date) {
        filterConditions.push("p.mprh_pr_dt <= ?");
        filterValues.push(filters.to_date);
      }

      const whereClause =
        filterConditions.length > 0
          ? `WHERE ${filterConditions.join(" AND ")}`
          : "";

      this.db.query(
        `SELECT tr.*,
               pi.total_amount,
               p.debit_note_id,
               p.supplier_name,
               p.supplier_gstn,
               p.mprh_pr_dt,
               p.tot_item_value
         FROM debit_note_tally_response tr
         JOIN outlets o ON tr.CostCentre = o.outlet_name
         -- The debit note the response was linked to when it came in
         -- (resolveDebitNoteForTallyResponse); a response stored before that
         -- link existed by voucher number + outlet, to GoFrugal debit notes
         -- only - a RetailPilot one (REC-...) can share its number.
         LEFT JOIN debit_note p_link ON p_link.debit_note_id = tr.debit_note_id
         LEFT JOIN debit_note p_old ON tr.debit_note_id IS NULL
           AND tr.VoucherNo = p_old.mprh_pr_refno
           AND p_old.store_id = o.outlet_id
           AND p_old.mprh_pr_no NOT LIKE 'REC-%'
         LEFT JOIN debit_note p ON p.debit_note_id = COALESCE(p_link.debit_note_id, p_old.debit_note_id)
         LEFT JOIN debit_note_internal pi ON p.debit_note_id = pi.debit_note_id
         ${whereClause}
         ORDER BY tr.created_at DESC`,
        filterValues,
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PURCHASE_TALLY",
              code: "REPOSITORY.PURCHASE_TALLY.GET-ALL",
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

  getById(id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        "SELECT * FROM purchase_tally_response WHERE MasterID = ?",
        [id],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PURCHASE_TALLY",
              code: "REPOSITORY.PURCHASE_TALLY.GET-BY-ID",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }

          if (docs.length === 0) {
            resolve({ code: 404, msg: "Entry not found" });
            return;
          }

          resolve({ code: 200, data: docs[0] });
        }
      );
    });
  }

  delete(id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        "DELETE FROM purchase_tally_response WHERE MasterID = ?",
        [id],
        (err, result) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PURCHASE_TALLY",
              code: "REPOSITORY.PURCHASE_TALLY.DELETE",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }

          if (result.affectedRows === 0) {
            resolve({ code: 404, msg: "Entry not found" });
            return;
          }

          resolve({ code: 200, msg: "Deleted successfully" });
        }
      );
    });
  }
}

module.exports = (db) => {
  return new PurchaseTallyRepository(db);
};
