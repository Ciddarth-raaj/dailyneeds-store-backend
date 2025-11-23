const logger = require("../utils/logger");

class TelegramDepartmentsRepository {
  constructor(db) {
    this.db = db;
  }

  create(department) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `INSERT INTO telegram_departments (department, telegram_chat_id, created_at) 
         VALUES (?, ?, NOW())`,
        [department.department, department.telegram_chat_id || null],
        (err, res) => {
          if (err) {
            if (err.code === "ER_DUP_ENTRY") {
              resolve({ code: 101, msg: "Department already exists" });
              return;
            }
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.TELEGRAM_DEPARTMENTS",
              code: "REPOSITORY.TELEGRAM_DEPARTMENTS.CREATE",
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

  getAll(limit, offset) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT * FROM telegram_departments 
         ORDER BY created_at DESC 
         LIMIT ${offset}, ${limit}`,
        [],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.TELEGRAM_DEPARTMENTS",
              code: "REPOSITORY.TELEGRAM_DEPARTMENTS.GETALL",
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

  getById(id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT * FROM telegram_departments WHERE id = ?`,
        [id],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.TELEGRAM_DEPARTMENTS",
              code: "REPOSITORY.TELEGRAM_DEPARTMENTS.GETBYID",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve(docs.length > 0 ? docs[0] : null);
        }
      );
    });
  }

  update(id, department) {
    return new Promise((resolve, reject) => {
      const updateFields = [];
      const params = [];

      if (department.department !== undefined) {
        updateFields.push(`department = ?`);
        params.push(department.department);
      }

      if (department.telegram_chat_id !== undefined) {
        updateFields.push(`telegram_chat_id = ?`);
        params.push(department.telegram_chat_id);
      }

      if (updateFields.length === 0) {
        resolve({ code: 200, affectedRows: 0 });
        return;
      }

      params.push(id);

      const query = `UPDATE telegram_departments SET ${updateFields.join(
        ", "
      )} WHERE id = ?`;

      this.db.query(query, params, (err, res) => {
        if (err) {
          if (err.code === "ER_DUP_ENTRY") {
            resolve({ code: 101, msg: "Department name already exists" });
            return;
          }
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.TELEGRAM_DEPARTMENTS",
            code: "REPOSITORY.TELEGRAM_DEPARTMENTS.UPDATE",
            description: err.toString(),
            category: "",
            ref: {},
          });
          reject(err);
          return;
        }
        resolve({ code: 200, affectedRows: res.affectedRows });
      });
    });
  }

  delete(id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `DELETE FROM telegram_departments WHERE id = ?`,
        [id],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.TELEGRAM_DEPARTMENTS",
              code: "REPOSITORY.TELEGRAM_DEPARTMENTS.DELETE",
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

  getCount() {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT COUNT(*) AS count FROM telegram_departments`,
        [],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.TELEGRAM_DEPARTMENTS",
              code: "REPOSITORY.TELEGRAM_DEPARTMENTS.GETCOUNT",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve(docs[0].count);
        }
      );
    });
  }
}

module.exports = (db) => {
  return new TelegramDepartmentsRepository(db);
};

