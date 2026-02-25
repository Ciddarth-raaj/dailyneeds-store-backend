const logger = require("../utils/logger");

const TABLE = "purchase_acknowledgement";
const DIST_MAST = "medishopdb_MED_DISTRIBUTOR_MAST";

class PurchaseAcknowledgementRepository {
  constructor(db, dbGofrugal) {
    this.db = db;
    this.dbGofrugal = dbGofrugal;
  }

  _getDistributorNameMap(distCodes) {
    if (!distCodes || distCodes.length === 0) return Promise.resolve({});
    const codes = [...new Set(distCodes.map((c) => String(c)).filter(Boolean))];
    if (codes.length === 0) return Promise.resolve({});
    return new Promise((resolve, reject) => {
      const placeholders = codes.map(() => "?").join(",");
      this.dbGofrugal.query(
        `SELECT MDM_DIST_CODE, MDM_DIST_NAME FROM ${DIST_MAST} WHERE MDM_DIST_CODE IN (${placeholders})`,
        codes,
        (err, rows) => {
          if (err) return reject(err);
          const map = {};
          (rows || []).forEach((r) => {
            map[String(r.MDM_DIST_CODE)] = r.MDM_DIST_NAME;
          });
          resolve(map);
        }
      );
    });
  }

  getAll() {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT purchase_acknowledgement_id, distributor_id, invoice_date, amount, created_by, created_at, updated_at
         FROM ${TABLE} ORDER BY invoice_date DESC, purchase_acknowledgement_id DESC`,
        (err, rows) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PURCHASE_ACKNOWLEDGEMENT",
              code: "REPOSITORY.PURCHASE_ACKNOWLEDGEMENT.GET_ALL",
              description: err.toString(),
              category: "",
              ref: {}
            });
            return reject(err);
          }
          const list = rows || [];
          const distCodes = [...new Set(list.map((r) => r.distributor_id).filter(Boolean))];
          this._getDistributorNameMap(distCodes).then((nameMap) => {
            const data = list.map((r) => ({
              purchase_acknowledgement_id: r.purchase_acknowledgement_id,
              distributor_id: r.distributor_id,
              distributor_name: nameMap[String(r.distributor_id)] || null,
              invoice_date: r.invoice_date,
              amount: r.amount,
              created_by: r.created_by,
              created_at: r.created_at,
              updated_at: r.updated_at
            }));
            resolve(data);
          }).catch(reject);
        }
      );
    });
  }

  getById(purchase_acknowledgement_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT purchase_acknowledgement_id, distributor_id, invoice_date, amount, created_by, created_at, updated_at
         FROM ${TABLE} WHERE purchase_acknowledgement_id = ?`,
        [purchase_acknowledgement_id],
        (err, rows) => {
          if (err) return reject(err);
          const row = rows && rows[0];
          if (!row) return resolve(null);
          this._getDistributorNameMap([row.distributor_id]).then((nameMap) => {
            resolve({
              purchase_acknowledgement_id: row.purchase_acknowledgement_id,
              distributor_id: row.distributor_id,
              distributor_name: nameMap[String(row.distributor_id)] || null,
              invoice_date: row.invoice_date,
              amount: row.amount,
              created_by: row.created_by,
              created_at: row.created_at,
              updated_at: row.updated_at
            });
          }).catch(reject);
        }
      );
    });
  }

  create(data) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `INSERT INTO ${TABLE} (distributor_id, invoice_date, amount, created_by)
         VALUES (?, ?, ?, ?)`,
        [
          data.distributor_id,
          data.invoice_date,
          data.amount ?? 0,
          data.created_by ?? null
        ],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PURCHASE_ACKNOWLEDGEMENT",
              code: "REPOSITORY.PURCHASE_ACKNOWLEDGEMENT.CREATE",
              description: err.toString(),
              category: "",
              ref: {}
            });
            return reject(err);
          }
          resolve({ code: 200, purchase_acknowledgement_id: res.insertId });
        }
      );
    });
  }

  update(purchase_acknowledgement_id, data) {
    return new Promise((resolve, reject) => {
      const sets = ["updated_at = CURRENT_TIMESTAMP"];
      const values = [];
      if (data.distributor_id !== undefined) {
        sets.push("distributor_id = ?");
        values.push(data.distributor_id);
      }
      if (data.invoice_date !== undefined) {
        sets.push("invoice_date = ?");
        values.push(data.invoice_date);
      }
      if (data.amount !== undefined) {
        sets.push("amount = ?");
        values.push(data.amount);
      }
      if (values.length === 0) return resolve({ code: 200, affectedRows: 0 });
      values.push(purchase_acknowledgement_id);
      this.db.query(
        `UPDATE ${TABLE} SET ${sets.join(", ")} WHERE purchase_acknowledgement_id = ?`,
        values,
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PURCHASE_ACKNOWLEDGEMENT",
              code: "REPOSITORY.PURCHASE_ACKNOWLEDGEMENT.UPDATE",
              description: err.toString(),
              category: "",
              ref: {}
            });
            return reject(err);
          }
          resolve({ code: 200, affectedRows: res.affectedRows });
        }
      );
    });
  }

  delete(purchase_acknowledgement_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `DELETE FROM ${TABLE} WHERE purchase_acknowledgement_id = ?`,
        [purchase_acknowledgement_id],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PURCHASE_ACKNOWLEDGEMENT",
              code: "REPOSITORY.PURCHASE_ACKNOWLEDGEMENT.DELETE",
              description: err.toString(),
              category: "",
              ref: {}
            });
            return reject(err);
          }
          resolve({ code: 200, affectedRows: res.affectedRows });
        }
      );
    });
  }
}

module.exports = (db, dbGofrugal) => {
  return new PurchaseAcknowledgementRepository(db, dbGofrugal);
};
