const logger = require("../utils/logger");
const { resolveByMedishopDistCodes } = require("./lib/distributor_master_lookup");

const TABLE = "purchase_acknowledgement";
const TABLE_INVOICE = "purchase_acknowledgement_invoice";
const TABLE_IMPORTED = "purchase_acknowledgement_imported";
const GOFRUGAL_MRC_MEMO = "medishopdb_med_mrc_memo";

function _normalizeMemoSno(mmm_sno) {
  if (mmm_sno == null || mmm_sno === "") {
    return 0;
  }
  const n = Number(mmm_sno);
  return Number.isFinite(n) ? n : 0;
}

function _memoImportKey(mmm_no, mmm_sno) {
  return `${mmm_no}:${_normalizeMemoSno(mmm_sno)}`;
}

/** One purchase_acknowledgement per mmm_refno; lines differ by mmm_sno. */
function _memoGroupKey(row) {
  if (row.mmm_refno != null && row.mmm_refno !== "") {
    return `ref:${row.mmm_refno}`;
  }
  // mmm_no is unique per row — no refno → single-line group
  return `noref:${row.mmm_no}`;
}

function _parseAmount(v) {
  if (v == null || v === "") {
    return 0;
  }
  const n = parseFloat(String(v).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : 0;
}

/** YYYY-MM-DD for purchase_acknowledgement_invoice.invoice_date */
function _invoiceDateFromMemoRow(row) {
  const raw = row.mmm_invoice_date != null ? row.mmm_invoice_date : row.mmm_date;
  if (raw == null) {
    return null;
  }
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) return null;
    const y = raw.getFullYear();
    const m = String(raw.getMonth() + 1).padStart(2, "0");
    const day = String(raw.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
  const s = String(raw);
  const dateMatch = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (dateMatch) {
    return dateMatch[1];
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    return null;
  }
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Value for purchase_acknowledgement.mmm_date (DATETIME); null if missing/invalid. */
function _mmmDateForDb(value) {
  if (value == null || value === "") {
    return null;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  return value;
}

/** Value for purchase_acknowledgement.mmm_mrc_no; null if missing. */
function _mmmMrcNoForDb(value) {
  if (value == null) {
    return null;
  }
  const s = String(value).trim();
  return s === "" ? null : s;
}

function _mmmRefnoForDb(row) {
  if (row.mmm_refno == null || row.mmm_refno === "") {
    return null;
  }
  const n = Number(row.mmm_refno);
  return Number.isFinite(n) ? n : null;
}

class PurchaseAcknowledgementRepository {
  constructor(db, dbGofrugal) {
    this.db = db;
    this.dbGofrugal = dbGofrugal;
  }

  _getDistributorNameMap(distCodes) {
    return resolveByMedishopDistCodes(
      this.dbGofrugal,
      this.db,
      distCodes
    ).then((map) => {
      const nameMap = {};
      Object.keys(map).forEach((code) => {
        nameMap[code] = map[code]?.MDM_DIST_NAME ?? null;
      });
      return nameMap;
    });
  }

  getAll() {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT pa.purchase_acknowledgement_id, pa.distributor_id, pa.mmm_refno, pa.mmm_date, pa.mmm_mrc_no, pa.created_by, pa.created_at, pa.updated_at,
                pai.purchase_acknowledgement_invoice_id, pai.invoice_no, pai.invoice_date, pai.amount
         FROM ${TABLE} pa
         LEFT JOIN ${TABLE_INVOICE} pai ON pai.purchase_acknowledgement_id = pa.purchase_acknowledgement_id
         ORDER BY pa.purchase_acknowledgement_id DESC, pai.purchase_acknowledgement_invoice_id DESC`,
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
                mmm_refno: r.mmm_refno,
                mmm_date: r.mmm_date,
                mmm_mrc_no: r.mmm_mrc_no,
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
        `SELECT pa.purchase_acknowledgement_id, pa.distributor_id, pa.mmm_refno, pa.mmm_date, pa.mmm_mrc_no, pa.created_by, pa.created_at, pa.updated_at,
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
              mmm_refno: row.mmm_refno,
              mmm_date: row.mmm_date,
              mmm_mrc_no: row.mmm_mrc_no,
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
        `INSERT INTO ${TABLE} (distributor_id, created_by, mmm_refno, mmm_date, mmm_mrc_no) VALUES (?, ?, ?, ?, ?)`,
        [
          data.distributor_id,
          data.created_by ?? null,
          _mmmRefnoForDb(data),
          _mmmDateForDb(data.mmm_date),
          _mmmMrcNoForDb(data.mmm_mrc_no)
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
      if (data.mmm_refno !== undefined) {
        sets.push("mmm_refno = ?");
        values.push(_mmmRefnoForDb(data));
      }
      if (data.mmm_date !== undefined) {
        sets.push("mmm_date = ?");
        values.push(_mmmDateForDb(data.mmm_date));
      }
      if (data.mmm_mrc_no !== undefined) {
        sets.push("mmm_mrc_no = ?");
        values.push(_mmmMrcNoForDb(data.mmm_mrc_no));
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

  _getImportedMemoKeySet() {
    return new Promise((resolve, reject) => {
      this.db.query(`SELECT mmm_no, mmm_sno FROM ${TABLE_IMPORTED}`, (err, rows) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.PURCHASE_ACKNOWLEDGEMENT",
            code: "REPOSITORY.PURCHASE_ACKNOWLEDGEMENT.IMPORTED_KEYS",
            description: err.toString(),
            category: "",
            ref: {}
          });
          return reject(err);
        }
        const set = new Set();
        (rows || []).forEach((r) => {
          set.add(_memoImportKey(r.mmm_no, r.mmm_sno));
        });
        resolve(set);
      });
    });
  }

  _fetchAllMrcMemoFromGofrugal() {
    const BASE_COLUMNS =
      "mmm_no, mmm_refno, mmm_sno, mmm_dist_code, mmm_invoice_no, mmm_invoice_date, mmm_invoice_amount, mmm_date";

    return new Promise((resolve, reject) => {
      if (!this.dbGofrugal) {
        return reject(new Error("Gofrugal DB connection is not configured"));
      }

      const run = (columns, onUnknownColumn) => {
        this.dbGofrugal.query(
          `SELECT ${columns} FROM ${GOFRUGAL_MRC_MEMO}`,
          (err, rows) => {
            if (err) {
              if (onUnknownColumn && err.code === "ER_BAD_FIELD_ERROR") {
                return onUnknownColumn(err);
              }
              logger.Log({
                level: logger.LEVEL.ERROR,
                component: "REPOSITORY.PURCHASE_ACKNOWLEDGEMENT",
                code: "REPOSITORY.PURCHASE_ACKNOWLEDGEMENT.GOFRUGAL_MEMO_FETCH",
                description: err.toString(),
                category: "",
                ref: {}
              });
              return reject(err);
            }
            resolve(rows || []);
          }
        );
      };

      // mmm_mrc_no was added later and is not guaranteed to exist on every
      // Gofrugal install. Falling back keeps the sync working - the memo
      // still imports, just without an MRC number.
      run(`${BASE_COLUMNS}, mmm_mrc_no`, (err) => {
        logger.Log({
          level: logger.LEVEL.WARN,
          component: "REPOSITORY.PURCHASE_ACKNOWLEDGEMENT",
          code: "REPOSITORY.PURCHASE_ACKNOWLEDGEMENT.GOFRUGAL_MEMO_NO_MRC_NO",
          description: `mmm_mrc_no unavailable on ${GOFRUGAL_MRC_MEMO}, syncing without it: ${err.toString()}`,
          category: "",
          ref: {}
        });
        run(BASE_COLUMNS, null);
      });
    });
  }

  async _importOneMemoGroupFromGofrugal(memoRows, createdBy) {
    memoRows.sort((a, b) => _normalizeMemoSno(a.mmm_sno) - _normalizeMemoSno(b.mmm_sno));
    const head = memoRows[0];
    const mmm_refno = _mmmRefnoForDb(head);
    const mmm_date = _mmmDateForDb(head.mmm_date);
    const mmm_mrc_no = _mmmMrcNoForDb(head.mmm_mrc_no);
    const dist = head.mmm_dist_code;
    if (dist == null || dist === "") {
      return { skipped: true, reason: "missing_distributor" };
    }
    const distributor_id = String(dist);

    const rowsWithDate = [];
    const invoices = [];
    memoRows.forEach((r) => {
      const invoice_date = _invoiceDateFromMemoRow(r);
      if (!invoice_date) {
        return;
      }
      rowsWithDate.push(r);
      invoices.push({
        invoice_no: r.mmm_invoice_no != null ? String(r.mmm_invoice_no) : null,
        invoice_date,
        amount: _parseAmount(r.mmm_invoice_amount)
      });
    });

    if (invoices.length === 0) {
      return { skipped: true, reason: "no_valid_invoice_date" };
    }

    const connection = await new Promise((resolve, reject) => {
      this.db.getConnection((err, conn) => {
        if (err) {
          reject(err);
        } else {
          resolve(conn);
        }
      });
    });

    let purchase_acknowledgement_id;
    try {
      await new Promise((resolve, reject) => {
        connection.beginTransaction((err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });

      const resPa = await new Promise((resolve, reject) => {
        connection.query(
          `INSERT INTO ${TABLE} (distributor_id, created_by, mmm_refno, mmm_date, mmm_mrc_no) VALUES (?, ?, ?, ?, ?)`,
          [distributor_id, createdBy ?? null, mmm_refno, mmm_date, mmm_mrc_no],
          (err, res) => {
            if (err) {
              reject(err);
            } else {
              resolve(res);
            }
          }
        );
      });
      purchase_acknowledgement_id = resPa.insertId;

      const placeholders = invoices.map(() => "(?, ?, ?, ?)").join(", ");
      const invValues = invoices.flatMap((inv) => [
        purchase_acknowledgement_id,
        inv.invoice_no ?? null,
        inv.invoice_date,
        inv.amount ?? 0
      ]);
      await new Promise((resolve, reject) => {
        connection.query(
          `INSERT INTO ${TABLE_INVOICE} (purchase_acknowledgement_id, invoice_no, invoice_date, amount) VALUES ${placeholders}`,
          invValues,
          (err) => {
            if (err) {
              reject(err);
            } else {
              resolve();
            }
          }
        );
      });

      const impPlaceholders = rowsWithDate.map(() => "(?, ?)").join(", ");
      const impValues = rowsWithDate.flatMap((r) => [r.mmm_no, _normalizeMemoSno(r.mmm_sno)]);
      await new Promise((resolve, reject) => {
        connection.query(
          `INSERT IGNORE INTO ${TABLE_IMPORTED} (mmm_no, mmm_sno) VALUES ${impPlaceholders}`,
          impValues,
          (err) => {
            if (err) {
              reject(err);
            } else {
              resolve();
            }
          }
        );
      });

      await new Promise((resolve, reject) => {
        connection.commit((err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
    } catch (err) {
      await new Promise((resolve) => {
        connection.rollback(() => resolve());
      });
      connection.release();
      throw err;
    }

    connection.release();
    return {
      skipped: false,
      purchase_acknowledgement_id,
      rows_marked: rowsWithDate.length
    };
  }

  /**
   * Pull new rows from gofrugal medishopdb_med_mrc_memo into purchase_acknowledgement (+ invoices).
   * Rows with the same mmm_refno are one memo (invoice lines = mmm_sno). mmm_no is unique per source row.
   * Tracks (mmm_no, mmm_sno) in purchase_acknowledgement_imported so imported rows are skipped.
   */
  async syncFromGofrugalMrcMemo(createdBy) {
    const importedKeys = await this._getImportedMemoKeySet();
    const rows = await this._fetchAllMrcMemoFromGofrugal();

    const pendingKeys = new Set();
    const pending = rows.filter((r) => {
      if (r.mmm_no == null) {
        return false;
      }
      const k = _memoImportKey(r.mmm_no, r.mmm_sno);
      if (importedKeys.has(k) || pendingKeys.has(k)) {
        return false;
      }
      pendingKeys.add(k);
      return true;
    });

    const byRefno = new Map();
    pending.forEach((r) => {
      const gk = _memoGroupKey(r);
      if (!byRefno.has(gk)) {
        byRefno.set(gk, []);
      }
      byRefno.get(gk).push(r);
    });

    const purchase_acknowledgement_ids = [];
    let groups_imported = 0;
    let rows_marked_imported = 0;

    for (const [, memoRows] of byRefno.entries()) {
      const result = await this._importOneMemoGroupFromGofrugal(memoRows, createdBy);
      if (!result.skipped) {
        groups_imported += 1;
        rows_marked_imported += result.rows_marked;
        purchase_acknowledgement_ids.push(result.purchase_acknowledgement_id);
      }
    }

    return {
      code: 200,
      groups_imported,
      rows_marked_imported,
      purchase_acknowledgement_ids
    };
  }
}

module.exports = (db, dbGofrugal) => {
  return new PurchaseAcknowledgementRepository(db, dbGofrugal);
};
