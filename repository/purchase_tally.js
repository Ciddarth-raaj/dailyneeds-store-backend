const logger = require("../utils/logger");

class PurchaseTallyRepository {
  constructor(db) {
    this.db = db;
  }

  create(data) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `INSERT INTO purchase_tally_response 
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

  getAll() {
    return new Promise((resolve, reject) => {
      this.db.query(
        "SELECT * FROM purchase_tally_response ORDER BY created_at DESC",
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
