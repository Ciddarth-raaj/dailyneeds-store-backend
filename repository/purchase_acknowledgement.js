const logger = require("../utils/logger");

const TABLE = "purchase_acknowledgement";
const TABLE_INVOICE = "purchase_acknowledgement_invoice";
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
        `SELECT pa.purchase_acknowledgement_id, pa.distributor_id, pa.created_by, pa.created_at, pa.updated_at,
                pai.purchase_acknowledgement_invoice_id, pai.invoice_no, pai.invoice_date, pai.amount
         FROM ${TABLE} pa
         LEFT JOIN ${TABLE_INVOICE} pai ON pai.purchase_acknowledgement_id = pa.purchase_acknowledgement_id
         ORDER BY pa.purchase_acknowledgement_id DESC, pai.purchase_acknowledgement_invoice_id ASC`,
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
          const byId = {};
          (rows || []).forEach((r) => {
            const id = r.purchase_acknowledgement_id;
            if (!byId[id]) {
              byId[id] = {
                purchase_acknowledgement_id: id,
                distributor_id: r.distributor_id,
                distributor_name: null,
                invoices: [],
                created_by: r.created_by,
                created_at: r.created_at,
                updated_at: r.updated_at
              };
            }
            if (r.purchase_acknowledgement_invoice_id != null) {
              byId[id].invoices.push({
                purchase_acknowledgement_invoice_id: r.purchase_acknowledgement_invoice_id,
                invoice_no: r.invoice_no,
                invoice_date: r.invoice_date,
                amount: r.amount
              });
            }
          });
          const list = Object.values(byId);
          const distCodes = [...new Set(list.map((l) => l.distributor_id).filter(Boolean))];
          this._getDistributorNameMap(distCodes).then((nameMap) => {
            list.forEach((l) => {
              l.distributor_name = nameMap[String(l.distributor_id)] || null;
            });
            resolve(list);
          }).catch(reject);
        }
      );
    });
  }

  getById(purchase_acknowledgement_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT pa.purchase_acknowledgement_id, pa.distributor_id, pa.created_by, pa.created_at, pa.updated_at,
                pai.purchase_acknowledgement_invoice_id, pai.invoice_no, pai.invoice_date, pai.amount
         FROM ${TABLE} pa
         LEFT JOIN ${TABLE_INVOICE} pai ON pai.purchase_acknowledgement_id = pa.purchase_acknowledgement_id
         WHERE pa.purchase_acknowledgement_id = ?`,
        [purchase_acknowledgement_id],
        (err, rows) => {
          if (err) return reject(err);
          const row = rows && rows[0];
          if (!row) return resolve(null);
          const invoices = (rows || [])
            .filter((r) => r.purchase_acknowledgement_invoice_id != null)
            .map((r) => ({
              purchase_acknowledgement_invoice_id: r.purchase_acknowledgement_invoice_id,
              invoice_no: r.invoice_no,
              invoice_date: r.invoice_date,
              amount: r.amount
            }));
          this._getDistributorNameMap([row.distributor_id]).then((nameMap) => {
            resolve({
              purchase_acknowledgement_id: row.purchase_acknowledgement_id,
              distributor_id: row.distributor_id,
              distributor_name: nameMap[String(row.distributor_id)] || null,
              invoices,
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
    const invoices = data.invoices || [];
    return new Promise((resolve, reject) => {
      this.db.query(
        `INSERT INTO ${TABLE} (distributor_id, created_by) VALUES (?, ?)`,
        [data.distributor_id, data.created_by ?? null],
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
          const purchase_acknowledgement_id = res.insertId;
          if (invoices.length === 0) {
            return resolve({ code: 200, purchase_acknowledgement_id });
          }
          const placeholders = invoices.map(() => "(?, ?, ?, ?)").join(", ");
          const values = invoices.flatMap((inv) => [
            purchase_acknowledgement_id,
            inv.invoice_no ?? null,
            inv.invoice_date,
            inv.amount ?? 0
          ]);
          this.db.query(
            `INSERT INTO ${TABLE_INVOICE} (purchase_acknowledgement_id, invoice_no, invoice_date, amount) VALUES ${placeholders}`,
            values,
            (errInv) => {
              if (errInv) {
                logger.Log({
                  level: logger.LEVEL.ERROR,
                  component: "REPOSITORY.PURCHASE_ACKNOWLEDGEMENT",
                  code: "REPOSITORY.PURCHASE_ACKNOWLEDGEMENT.CREATE_INVOICES",
                  description: errInv.toString(),
                  category: "",
                  ref: {}
                });
                return reject(errInv);
              }
              resolve({ code: 200, purchase_acknowledgement_id });
            }
          );
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
      const hasMainUpdate = values.length > 0;

      const finish = (err, res) => {
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
        resolve({ code: 200, affectedRows: res ? res.affectedRows : 0 });
      };

      const runInvoiceReplace = (cb) => {
        const invoices = data.invoices || [];
        this.db.query(
          `DELETE FROM ${TABLE_INVOICE} WHERE purchase_acknowledgement_id = ?`,
          [purchase_acknowledgement_id],
          (errDel) => {
            if (errDel) return cb(errDel);
            if (invoices.length === 0) return cb(null, { affectedRows: 0 });
            const placeholders = invoices.map(() => "(?, ?, ?, ?)").join(", ");
            const invValues = invoices.flatMap((inv) => [
              purchase_acknowledgement_id,
              inv.invoice_no ?? null,
              inv.invoice_date,
              inv.amount ?? 0
            ]);
            this.db.query(
              `INSERT INTO ${TABLE_INVOICE} (purchase_acknowledgement_id, invoice_no, invoice_date, amount) VALUES ${placeholders}`,
              invValues,
              (errIns) => cb(errIns, errIns ? null : { affectedRows: 1 })
            );
          }
        );
      };

      if (data.invoices !== undefined) {
        if (hasMainUpdate) {
          values.push(purchase_acknowledgement_id);
          this.db.query(
            `UPDATE ${TABLE} SET ${sets.join(", ")} WHERE purchase_acknowledgement_id = ?`,
            values,
            (err, res) => {
              if (err) return finish(err);
              runInvoiceReplace((errInv) => finish(errInv, res));
            }
          );
        } else {
          runInvoiceReplace(finish);
        }
      } else if (hasMainUpdate) {
        values.push(purchase_acknowledgement_id);
        this.db.query(
          `UPDATE ${TABLE} SET ${sets.join(", ")} WHERE purchase_acknowledgement_id = ?`,
          values,
          (err, res) => finish(err, res)
        );
      } else {
        return resolve({ code: 200, affectedRows: 0 });
      }
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
