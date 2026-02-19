const logger = require("../utils/logger");

class JobWorksheetRepository {
  constructor(db) {
    this.db = db;
  }

  createJobWorksheet(data) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `INSERT INTO job_worksheet (grn_no, date, supplier_id)
         VALUES (?, ?, ?)`,
        [data.grn_no, data.date, data.supplier_id],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.JOB_WORKSHEET",
              code: "REPOSITORY.JOB_WORKSHEET.CREATE",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve({ code: 200, id: res.insertId });
        }
      );
    });
  }

  getJobWorksheetById(jobWorksheetId) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT jw.* FROM job_worksheet jw WHERE jw.job_worksheet_id = ?`,
        [jobWorksheetId],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.JOB_WORKSHEET",
              code: "REPOSITORY.JOB_WORKSHEET.GET_BY_ID",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve(docs[0] || null);
        }
      );
    });
  }

  getAllJobWorksheets(filters = {}) {
    return new Promise((resolve, reject) => {
      let query = `
        SELECT jw.*,
               (SELECT COUNT(*) FROM job_worksheet_item WHERE job_worksheet_id = jw.job_worksheet_id) as item_count,
               (SELECT COUNT(*) FROM job_worksheet_item WHERE job_worksheet_id = jw.job_worksheet_id AND status = 'open') as open_count,
               (SELECT COUNT(*) FROM job_worksheet_item WHERE job_worksheet_id = jw.job_worksheet_id AND status = 'done') as done_count
        FROM job_worksheet jw
      `;
      const conditions = [];
      const params = [];

      if (filters.grn_no) {
        conditions.push("jw.grn_no LIKE ?");
        params.push(`%${filters.grn_no}%`);
      }
      if (filters.supplier_id) {
        conditions.push("jw.supplier_id = ?");
        params.push(filters.supplier_id);
      }
      if (filters.date_from) {
        conditions.push("jw.date >= ?");
        params.push(filters.date_from);
      }
      if (filters.date_to) {
        conditions.push("jw.date <= ?");
        params.push(filters.date_to);
      }

      if (conditions.length > 0) {
        query += " WHERE " + conditions.join(" AND ");
      }
      query += " ORDER BY jw.created_at DESC";

      if (filters.limit) {
        query += " LIMIT ?";
        params.push(filters.limit);
      }
      if (filters.offset) {
        query += " OFFSET ?";
        params.push(filters.offset);
      }

      this.db.query(query, params, (err, docs) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.JOB_WORKSHEET",
            code: "REPOSITORY.JOB_WORKSHEET.GET_ALL",
            description: err.toString(),
            category: "",
            ref: {},
          });
          reject(err);
          return;
        }
        const formatted = docs.map((row) => {
          const { open_count, done_count, ...rest } = row;
          return {
            ...rest,
            status_count: {
              open: parseInt(open_count, 10) || 0,
              done: parseInt(done_count, 10) || 0,
            },
          };
        });
        resolve(formatted);
      });
    });
  }

  updateJobWorksheet(jobWorksheetId, data) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `UPDATE job_worksheet SET grn_no = ?, date = ?, supplier_id = ?
         WHERE job_worksheet_id = ?`,
        [data.grn_no, data.date, data.supplier_id, jobWorksheetId],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.JOB_WORKSHEET",
              code: "REPOSITORY.JOB_WORKSHEET.UPDATE",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve({ code: 200, affectedRows: res.affectedRows });
        }
      );
    });
  }

  deleteJobWorksheet(jobWorksheetId) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `DELETE FROM job_worksheet WHERE job_worksheet_id = ?`,
        [jobWorksheetId],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.JOB_WORKSHEET",
              code: "REPOSITORY.JOB_WORKSHEET.DELETE",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve({ code: 200, affectedRows: res.affectedRows });
        }
      );
    });
  }

  createJobWorksheetItem(item) {
    return new Promise((resolve, reject) => {
      const status = item.status === "done" ? "done" : "open";
      this.db.query(
        `INSERT INTO job_worksheet_item (job_worksheet_id, product_id, qty, mrp, material_type, sticker_type_1, sticker_type_2, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          item.job_worksheet_id,
          item.product_id,
          item.qty,
          item.mrp,
          item.material_type ?? null,
          item.sticker_type_1 ?? null,
          item.sticker_type_2 ?? null,
          status,
        ],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.JOB_WORKSHEET",
              code: "REPOSITORY.JOB_WORKSHEET.CREATE_ITEM",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve({ code: 200, id: res.insertId });
        }
      );
    });
  }

  getJobWorksheetItems(jobWorksheetId) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT jwi.*, pt.gf_item_name as product_name,
                st1.label as sticker_type_1_label,
                st2.label as sticker_type_2_label
         FROM job_worksheet_item jwi
         LEFT JOIN product_table pt ON jwi.product_id = pt.product_id
         LEFT JOIN sticker_types st1 ON jwi.sticker_type_1 = st1.sticker_id
         LEFT JOIN sticker_types st2 ON jwi.sticker_type_2 = st2.sticker_id
         WHERE jwi.job_worksheet_id = ?`,
        [jobWorksheetId],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.JOB_WORKSHEET",
              code: "REPOSITORY.JOB_WORKSHEET.GET_ITEMS",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve(docs);
        }
      );
    });
  }

  getJobWorksheetWithItems(jobWorksheetId) {
    return new Promise((resolve, reject) => {
      this.getJobWorksheetById(jobWorksheetId).then((worksheet) => {
        if (!worksheet) {
          resolve(null);
          return;
        }
        this.getJobWorksheetItems(jobWorksheetId).then((items) => {
          const openCount = items.filter((i) => i.status === "open").length;
          const doneCount = items.filter((i) => i.status === "done").length;
          resolve({
            ...worksheet,
            items,
            status_count: { open: openCount, done: doneCount },
          });
        }).catch(reject);
      }).catch(reject);
    });
  }

  updateJobWorksheetItem(itemId, item) {
    return new Promise((resolve, reject) => {
      const status = item.status === "done" ? "done" : (item.status === "open" ? "open" : undefined);
      const updates = [
        item.product_id,
        item.qty,
        item.mrp,
        item.material_type ?? null,
        item.sticker_type_1 ?? null,
        item.sticker_type_2 ?? null,
      ];
      let query = `UPDATE job_worksheet_item SET product_id = ?, qty = ?, mrp = ?, material_type = ?, sticker_type_1 = ?, sticker_type_2 = ?`;
      if (status !== undefined) {
        query += `, status = ?`;
        updates.push(status);
      }
      query += ` WHERE job_worksheet_item_id = ?`;
      updates.push(itemId);
      this.db.query(query, updates,
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.JOB_WORKSHEET",
              code: "REPOSITORY.JOB_WORKSHEET.UPDATE_ITEM",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve({ code: 200, affectedRows: res.affectedRows });
        }
      );
    });
  }

  deleteJobWorksheetItem(itemId) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `DELETE FROM job_worksheet_item WHERE job_worksheet_item_id = ?`,
        [itemId],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.JOB_WORKSHEET",
              code: "REPOSITORY.JOB_WORKSHEET.DELETE_ITEM",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve({ code: 200, affectedRows: res.affectedRows });
        }
      );
    });
  }
}

module.exports = (db) => {
  return new JobWorksheetRepository(db);
};
