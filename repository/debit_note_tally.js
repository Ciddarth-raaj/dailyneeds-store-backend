const logger = require("../utils/logger");

class PurchaseTallyRepository {
  constructor(db) {
    this.db = db;
  }

  create(data) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `INSERT INTO debit_note_tally_response 
        (MasterID, VoucherNo, InvoiceValue, SupplierName, CostCentre) 
        VALUES (?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
        VoucherNo = VALUES(VoucherNo),
        InvoiceValue = VALUES(InvoiceValue),
        SupplierName = VALUES(SupplierName),
        CostCentre = VALUES(CostCentre)`,
        [
          data.MasterID,
          data.VoucherNo,
          data.InvoiceValue,
          data.SupplierName,
          data.CostCentre,
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
        filterConditions.push("p.mmh_mrc_dt >= ?");
        filterValues.push(filters.from_date);
      }

      if (filters.to_date) {
        filterConditions.push("p.mmh_mrc_dt <= ?");
        filterValues.push(filters.to_date);
      }

      const whereClause =
        filterConditions.length > 0
          ? `WHERE ${filterConditions.join(" AND ")}`
          : "";

      this.db.query(
        `SELECT tr.*,
               pi.total_amount,
               p.purchase_id,
               p.supplier_name,
               p.mmh_mrc_dt,
               p.mmh_mrc_amt
         FROM purchase_tally_response tr
         JOIN outlets o ON tr.CostCentre = o.outlet_name
         LEFT JOIN purchase p ON tr.VoucherNo = p.mmh_mrc_refno 
           AND p.retail_outlet_id = o.outlet_id
         LEFT JOIN purchase_internal pi ON p.purchase_id = pi.purchase_id
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
