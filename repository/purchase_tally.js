const logger = require("../utils/logger");
const { purchaseIdFromMasterId } = require("../utils/tally_master_id");
const {
  mergedCol,
  mergedDateExpr,
  purchaseOverlayJoins,
} = require("../utils/purchase_overlay_sql");

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
   * The purchase a Tally response belongs to.
   *
   * The voucher number (mmh_mrc_refno) repeats across branches and restarts
   * every financial year, so it is never trusted alone:
   *  1. the MasterID the export sent carries the purchase id - used when it
   *     decodes AND that purchase has the response's voucher number, branch
   *     (cost centre) and GSTIN;
   *  2. otherwise voucher number + branch + GSTIN, narrowed to approved bills
   *     (only those are exported) and to bills without a response yet. If
   *     more than one remains it is ambiguous and nothing is linked.
   *
   * @returns {Promise<{ purchaseId: number|null, ambiguous?: number[] }>}
   */
  async resolvePurchaseForTallyResponse({ MasterID, VoucherNo, GSTIN, CostCentre }) {
    try {
      const match = `TRIM(p.mmh_mrc_refno) = TRIM(?)
           AND TRIM(o.outlet_name) = TRIM(?)
           AND UPPER(TRIM(p.supplier_gstn)) = UPPER(TRIM(?))`;

      const fromMaster = purchaseIdFromMasterId(MasterID);
      if (fromMaster) {
        const rows = await this._q(
          `SELECT p.purchase_id FROM purchase p
           INNER JOIN outlets o ON o.outlet_id = p.retail_outlet_id
           WHERE p.purchase_id = ? AND ${match}`,
          [fromMaster, VoucherNo, CostCentre, GSTIN]
        );
        if (rows.length) return { purchaseId: rows[0].purchase_id };
      }

      const rows = await this._q(
        `SELECT p.purchase_id, p.is_approved, tr.purchase_id AS has_response
         FROM purchase p
         INNER JOIN outlets o ON o.outlet_id = p.retail_outlet_id
         LEFT JOIN purchase_tally_response tr ON tr.purchase_id = p.purchase_id
         WHERE ${match}
         ORDER BY p.purchase_id DESC`,
        [VoucherNo, CostCentre, GSTIN]
      );
      if (!rows.length) return { purchaseId: null };

      const approved = rows.filter((r) => Number(r.is_approved) === 1);
      const pool = approved.length ? approved : rows;
      const open = pool.filter((r) => r.has_response == null);
      const pick = open.length ? open : pool;
      if (pick.length === 1) return { purchaseId: pick[0].purchase_id };
      return { purchaseId: null, ambiguous: pick.map((r) => r.purchase_id) };
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "REPOSITORY.PURCHASE_TALLY",
        code: "REPOSITORY.PURCHASE_TALLY.FIND-PURCHASE-ID",
        description: err.toString(),
        category: "",
        ref: {},
      });
      throw err;
    }
  }

  findByPurchaseId(purchaseId) {
    return new Promise((resolve, reject) => {
      this.db.query(
        "SELECT * FROM purchase_tally_response WHERE purchase_id = ? LIMIT 1",
        [purchaseId],
        (err, rows) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PURCHASE_TALLY",
              code: "REPOSITORY.PURCHASE_TALLY.FIND-BY-PURCHASE-ID",
              description: err.toString(),
              category: "",
              ref: { purchaseId },
            });
            reject(err);
            return;
          }
          resolve(rows && rows[0] ? rows[0] : null);
        }
      );
    });
  }

  findByMasterId(masterId) {
    return new Promise((resolve, reject) => {
      this.db.query(
        "SELECT * FROM purchase_tally_response WHERE MasterID = ? LIMIT 1",
        [masterId],
        (err, rows) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PURCHASE_TALLY",
              code: "REPOSITORY.PURCHASE_TALLY.FIND-BY-MASTER-ID",
              description: err.toString(),
              category: "",
              ref: { masterId },
            });
            reject(err);
            return;
          }
          resolve(rows && rows[0] ? rows[0] : null);
        }
      );
    });
  }

  create(data) {
    const purchaseId = data.purchase_id;
    if (purchaseId == null || purchaseId === "") {
      const err = new Error(
        "Purchase does not exist for the provided voucher number, supplier name, GSTIN, and cost centre"
      );
      err.statusCode = 404;
      return Promise.reject(err);
    }

    return new Promise((resolve, reject) => {
      this.db.query(
        `INSERT INTO purchase_tally_response
        (purchase_id, MasterID, VoucherNo, InvoiceValue, SupplierName, CostCentre, GSTIN)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
        MasterID = VALUES(MasterID),
        VoucherNo = VALUES(VoucherNo),
        InvoiceValue = VALUES(InvoiceValue),
        SupplierName = VALUES(SupplierName),
        GSTIN = VALUES(GSTIN),
        CostCentre = VALUES(CostCentre)`,
        [
          data.purchase_id,
          data.MasterID,
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
            purchase_id: data.purchase_id,
          });
        }
      );
    });
  }

  getAll(filters = {}) {
    return new Promise((resolve, reject) => {
      let filterConditions = [];
      let filterValues = [];

      if (filters.outlet_id) {
        filterConditions.push("o.outlet_id = ?");
        filterValues.push(filters.outlet_id);
      }

      if (filters.from_date) {
        filterConditions.push(`${mergedDateExpr("mmh_mrc_dt")} >= ?`);
        filterValues.push(filters.from_date);
      }

      if (filters.to_date) {
        filterConditions.push(`${mergedDateExpr("mmh_mrc_dt")} <= ?`);
        filterValues.push(filters.to_date);
      }

      const whereClause =
        filterConditions.length > 0
          ? `WHERE ${filterConditions.join(" AND ")}`
          : "";

      this.db.query(
        `SELECT tr.*,
               COALESCE(gi.total_amount, pi.total_amount) AS total_amount,
               p.purchase_id,
               ${mergedCol("supplier_name")} AS supplier_name,
               ${mergedCol("supplier_gstn")} AS supplier_gstn,
               ${mergedCol("mmh_mrc_dt")} AS mmh_mrc_dt,
               ${mergedCol("mmh_mrc_amt")} AS mmh_mrc_amt
         FROM purchase_tally_response tr
         INNER JOIN purchase p ON p.purchase_id = tr.purchase_id
         INNER JOIN outlets o ON o.outlet_id = p.retail_outlet_id
         ${purchaseOverlayJoins("p")}
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

  update(id, data) {
    return new Promise((resolve, reject) => {
      const updates = [];
      const values = [];

      if (data.VoucherNo !== undefined) {
        updates.push("VoucherNo = ?");
        values.push(data.VoucherNo);
      }

      if (data.InvoiceValue !== undefined) {
        updates.push("InvoiceValue = ?");
        values.push(data.InvoiceValue);
      }

      if (data.SupplierName !== undefined) {
        updates.push("SupplierName = ?");
        values.push(data.SupplierName);
      }

      if (data.CostCentre !== undefined) {
        updates.push("CostCentre = ?");
        values.push(data.CostCentre);
      }

      if (data.GSTIN !== undefined) {
        updates.push("GSTIN = ?");
        values.push(data.GSTIN);
      }

      if (updates.length === 0) {
        resolve({ code: 400, msg: "No fields to update" });
        return;
      }

      values.push(id);

      this.db.query(
        `UPDATE purchase_tally_response SET ${updates.join(
          ", "
        )} WHERE MasterID = ?`,
        values,
        (err, result) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PURCHASE_TALLY",
              code: "REPOSITORY.PURCHASE_TALLY.UPDATE",
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

          resolve({ code: 200, msg: "Updated successfully" });
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
