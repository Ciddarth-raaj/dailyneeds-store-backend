const logger = require("../utils/logger");

const TABLE = "sto_check";

class StoCheckRepository {
  constructor(db) {
    this.db = db;
  }

  getAll() {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT sc.dn_ref_no, sc.product_id, sc.file_qty, sc.created_at, sc.updated_at,
                pt.gf_item_name AS product_name
         FROM \`${TABLE}\` sc
         LEFT JOIN product_table pt ON pt.product_id = sc.product_id
         ORDER BY sc.dn_ref_no DESC, sc.product_id ASC`,
        [],
        (err, rows) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.STO_CHECK",
              code: "REPOSITORY.STO_CHECK.GET_ALL",
              description: err.toString(),
              category: "",
              ref: {},
            });
            return reject(err);
          }
          resolve(rows || []);
        }
      );
    });
  }

  getByDnRefNo(dn_ref_no) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT sc.dn_ref_no, sc.product_id, sc.file_qty, sc.created_at, sc.updated_at,
                pt.gf_item_name
         FROM \`${TABLE}\` sc
         LEFT JOIN product_table pt ON pt.product_id = sc.product_id
         WHERE sc.dn_ref_no = ? ORDER BY sc.product_id ASC`,
        [dn_ref_no],
        (err, rows) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.STO_CHECK",
              code: "REPOSITORY.STO_CHECK.GET_BY_DN_REF_NO",
              description: err.toString(),
              category: "",
              ref: { dn_ref_no },
            });
            return reject(err);
          }
          resolve(rows || []);
        }
      );
    });
  }

  getOne(dn_ref_no, product_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT sc.dn_ref_no, sc.product_id, sc.file_qty, sc.created_at, sc.updated_at,
                pt.gf_item_name AS product_name
         FROM \`${TABLE}\` sc
         LEFT JOIN product_table pt ON pt.product_id = sc.product_id
         WHERE sc.dn_ref_no = ? AND sc.product_id = ?`,
        [dn_ref_no, product_id],
        (err, rows) => {
          if (err) return reject(err);
          resolve(rows && rows[0] ? rows[0] : null);
        }
      );
    });
  }

  deleteByDnRefNo(dn_ref_no) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `DELETE FROM \`${TABLE}\` WHERE dn_ref_no = ?`,
        [dn_ref_no],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.STO_CHECK",
              code: "REPOSITORY.STO_CHECK.DELETE_BY_DN_REF_NO",
              description: err.toString(),
              category: "",
              ref: { dn_ref_no },
            });
            return reject(err);
          }
          resolve({ affectedRows: res.affectedRows });
        }
      );
    });
  }

  insertMany(rows) {
    return new Promise((resolve, reject) => {
      if (!Array.isArray(rows) || rows.length === 0) {
        resolve({ affectedRows: 0 });
        return;
      }
      const values = rows.map((r) => [
        r.dn_ref_no,
        r.product_id,
        r.file_qty !== undefined && r.file_qty !== null ? r.file_qty : null,
      ]);
      const placeholders = values.map(() => "(?, ?, ?)").join(", ");
      const flat = values.flat();
      this.db.query(
        `INSERT INTO \`${TABLE}\` (dn_ref_no, product_id, file_qty) VALUES ${placeholders}`,
        flat,
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.STO_CHECK",
              code: "REPOSITORY.STO_CHECK.INSERT_MANY",
              description: err.toString(),
              category: "",
              ref: {},
            });
            return reject(err);
          }
          resolve({ affectedRows: res.affectedRows });
        }
      );
    });
  }

  replaceByDnRefNo(dn_ref_no, items) {
    return new Promise((resolve, reject) => {
      this.deleteByDnRefNo(dn_ref_no)
        .then(() => {
          if (!Array.isArray(items) || items.length === 0) {
            resolve({ code: 200, dn_ref_no: dn_ref_no, inserted: 0 });
            return;
          }
          const rows = items.map((it) => ({
            dn_ref_no,
            product_id: it.product_id,
            file_qty: it.file_qty !== undefined && it.file_qty !== null ? it.file_qty : null,
          }));
          return this.insertMany(rows).then((result) => {
            resolve({ code: 200, dn_ref_no, inserted: result.affectedRows });
          });
        })
        .catch(reject);
    });
  }
}

module.exports = (db) => {
  return new StoCheckRepository(db);
};
