const logger = require("../utils/logger");

class AccountsEbookRepository {
  constructor(db) {
    this.db = db;
  }

  create(ebook) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `INSERT INTO accounts_ebook (
          paytm_tid, hdur, hfpp, sedc, ppbl, store_id, date
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE 
          hdur = VALUES(hdur),
          hfpp = VALUES(hfpp),
          sedc = VALUES(sedc),
          ppbl = VALUES(ppbl)`,
        [
          ebook.paytm_tid,
          ebook.hdur,
          ebook.hfpp,
          ebook.sedc,
          ebook.ppbl,
          ebook.store_id,
          ebook.date,
        ],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.ACCOUNTS_EBOOK",
              code: "REPOSITORY.ACCOUNTS_EBOOK.CREATE",
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
            inserted: res.affectedRows - res.changedRows,
            updated: res.changedRows,
          });
        }
      );
    });
  }

  update(ebook) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `UPDATE accounts_ebook SET 
          paytm_tid = ?, hdur = ?, hfpp = ?, sedc = ?, 
          ppbl = ?, store_id = ?, date = ?
        WHERE ebook_id = ?`,
        [
          ebook.paytm_tid,
          ebook.hdur,
          ebook.hfpp,
          ebook.sedc,
          ebook.ppbl,
          ebook.store_id,
          ebook.date,
          ebook.ebook_id,
        ],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.ACCOUNTS_EBOOK",
              code: "REPOSITORY.ACCOUNTS_EBOOK.UPDATE",
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

  delete(ebookId) {
    return new Promise((resolve, reject) => {
      this.db.query(
        "DELETE FROM accounts_ebook WHERE ebook_id = ?",
        [ebookId],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.ACCOUNTS_EBOOK",
              code: "REPOSITORY.ACCOUNTS_EBOOK.DELETE",
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

  getAll(filters) {
    return new Promise((resolve, reject) => {
      let filterConditions = [];
      let filterValues = [];

      // Add date range filter if provided
      if (filters?.from_date) {
        filterConditions.push("DATE(ae.date) >= DATE(?)");
        filterValues.push(filters.from_date);
      }
      if (filters?.to_date) {
        filterConditions.push("DATE(ae.date) <= DATE(?)");
        filterValues.push(filters.to_date);
      }

      // Add store filter if provided
      if (filters?.store_id) {
        filterConditions.push("ae.store_id = ?");
        filterValues.push(filters.store_id);
      }

      // Combine filter conditions
      const whereClause =
        filterConditions.length > 0
          ? `WHERE ${filterConditions.join(" AND ")}`
          : "";

      this.db.query(
        `SELECT ae.*, o.outlet_name as store_name
         FROM accounts_ebook ae
         LEFT JOIN outlets o ON o.outlet_id = ae.store_id
         ${whereClause}
         ORDER BY ae.date DESC`,
        filterValues,
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.ACCOUNTS_EBOOK",
              code: "REPOSITORY.ACCOUNTS_EBOOK.GET-ALL",
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

  getById(ebookId) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT ae.*, o.outlet_name as store_name
         FROM accounts_ebook ae
         LEFT JOIN outlets o ON o.outlet_id = ae.store_id
         WHERE ae.ebook_id = ?`,
        [ebookId],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.ACCOUNTS_EBOOK",
              code: "REPOSITORY.ACCOUNTS_EBOOK.GET-BY-ID",
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

          resolve({ code: 200, data: docs[0] });
        }
      );
    });
  }

  bulkCreate(ebookList, store_id, date) {
    return new Promise((resolve, reject) => {
      // Prepare values array for bulk insert
      const values = ebookList.map((ebook) => [
        ebook.paytm_tid,
        ebook.hdur,
        ebook.hfpp,
        ebook.sedc,
        ebook.ppbl,
        store_id,
        date,
      ]);

      this.db.query(
        `INSERT INTO accounts_ebook (
          paytm_tid, hdur, hfpp, sedc, ppbl, store_id, date
        ) VALUES ? 
        ON DUPLICATE KEY UPDATE 
          hdur = VALUES(hdur),
          hfpp = VALUES(hfpp),
          sedc = VALUES(sedc),
          ppbl = VALUES(ppbl)`,
        [values],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.ACCOUNTS_EBOOK",
              code: "REPOSITORY.ACCOUNTS_EBOOK.BULK-CREATE",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve({
            code: 200,
            inserted: res.affectedRows - res.changedRows,
            updated: res.changedRows,
          });
        }
      );
    });
  }
}

module.exports = (db) => {
  return new AccountsEbookRepository(db);
};
