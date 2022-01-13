const logger = require("../utils/logger");

class IndentRepository {
  constructor(db) {
    this.db = db;
  }

  get(limit, offset) {
    return new Promise((resolve, reject) => {
      this.db.query(`select n.indent_id, n.indent_number, s.store_name as 'from', y.store_name as 'to', n.bags, 
        n.boxes, n.crates, n.taken_by as 'taken_by', n.checked_by as 'checked_by', n.delivery_status
        from new_indents n LEFT JOIN store s ON s.store_id = n.store_id LEFT JOIN store y ON 
        y.store_id = n.store_to LEFT JOIN new_employee e1 ON e1.employee_id = n.taken_by
        LEFT JOIN new_employee e2 ON e2.employee_id = n.checked_by LIMIT 
        ${offset}, ${limit}`, [], (err, docs) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.INDENT",
            code: "REPOSITORY.INDENT.GET",
            description: err.toString(),
            category: "",
            ref: {},
          });
          reject(err);
          return;
        }
        resolve(docs);
      });
    });
  }
  getIndentByStoreId(store_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `select n.indent_id, n.indent_number, s.store_name as 'from', y.store_name as 'to', n.bags, 
        n.boxes, n.crates, n.taken_by as 'taken_by', n.checked_by as 'checked_by', n.delivery_status
        from new_indents n LEFT JOIN store s ON s.store_id = n.store_id LEFT JOIN store y ON 
        y.store_id = n.store_to LEFT JOIN employee e1 ON e1.employee_id = n.taken_by
        LEFT JOIN employee e2 ON e2.employee_id = n.checked_by WHERE s.store_id = ${store_id}`,
        [store_id],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.INDENT",
              code: "REPOSITORY.INDENT.GET-BY-STORE-ID",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve(docs)
        }
      );
    });
  }
  getIndentFromStoreId(store_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `select n.indent_id, n.indent_number, s.store_name as 'from', y.store_name as 'to', n.bags, 
        n.boxes, n.crates, n.taken_by as 'taken_by', n.checked_by as 'checked_by', n.delivery_status
        from new_indents n LEFT JOIN store s ON s.store_id = n.store_id LEFT JOIN store y ON 
        y.store_id = n.store_to LEFT JOIN employee e1 ON e1.employee_id = n.taken_by
        LEFT JOIN employee e2 ON e2.employee_id = n.checked_by WHERE y.store_id = ${store_id}`,
        [store_id],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.INDENT",
              code: "REPOSITORY.INDENT.GET-FROM-STORE-ID",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve(docs)
        }
      );
    });
  }
  getDespatch(limit, offset, delivery_status) {
    return new Promise((resolve, reject) => {
      this.db.query(`select n.indent_id, n.indent_number, s.store_name as 'from', y.store_name as 'to', n.bags, 
        n.boxes, n.crates, e1.employee_name as 'taken_by', e2.employee_name as 'checked_by', n.delivery_status
        from new_indents n LEFT JOIN store s ON s.store_id = n.store_id LEFT JOIN store y ON 
        y.store_id = n.store_to LEFT JOIN employee e1 ON e1.employee_id = n.taken_by
        LEFT JOIN employee e2 ON e2.employee_id = n.checked_by WHERE delivery_status = ${delivery_status} LIMIT 
        ${offset}, ${limit}`, [], (err, docs) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.INDENT",
            code: "REPOSITORY.INDENT.GET-DESPATCH",
            description: err.toString(),
            category: "",
            ref: {},
          });
          reject(err);
          return;
        }
        resolve(docs);
      });
    });
  }
  updateDeliveryStatus(indent_id) {
    return new Promise((resolve, reject) => {
      this.db.query(`UPDATE new_indents SET delivery_status = 1 WHERE indent_id IN (${indent_id})`,
      [indent_id], (err, docs) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.INDENT",
            code: "REPOSITORY.INDENT.UPDATE-STATUS",
            description: err.toString(),
            category: "",
            ref: {},
          });
          reject(err);
          return;
        }
        resolve(docs);
      });
    });
  }
  updateIssueDeliveryStatus(indent_id) {
    return new Promise((resolve, reject) => {
      this.db.query(`UPDATE new_indents SET delivery_status = 5 WHERE indent_id IN (${indent_id})`,
      [indent_id], (err, docs) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.INDENT",
            code: "REPOSITORY.INDENT.UPDATE-ISSUE-STATUS",
            description: err.toString(),
            category: "",
            ref: {},
          });
          reject(err);
          return;
        }
        resolve(docs);
      });
    });
  }
  getIndentById(indent_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
      `SELECT n.indent_id, n.indent_number, s.store_name as 'from', y.store_name as 'to', n.bags, 
			n.boxes, n.crates, n.taken_by as 'taken_by', n.checked_by as 'checked_by', n.delivery_status
			from new_indents n LEFT JOIN store s ON s.store_id = n.store_id LEFT JOIN store y ON 
			y.store_id = n.store_to LEFT JOIN new_employee e1 ON e1.employee_id = n.indent_id
			LEFT JOIN new_employee e2 ON e2.employee_id = n.indent_id  WHERE indent_id IN (?) AND delivery_status = 1`,
      [indent_id], 
      (err, docs) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.INDENTS",
            code: "REPOSITORY.INDENTS.GET-INDENT-ID",
            description: err.toString(),
            category: "",
            ref: {},
          });
          reject(err);
          return;
        }
        resolve(docs);
      });
    });
  }
  createIndent(indent) {
    return new Promise((resolve, reject) => {
      this.db.query(
        "INSERT INTO new_indents (indent_number, store_id, store_to, bags, boxes, crates, taken_by, checked_by) VALUES ( ?, ?, ?, ?, ?, ?, ?, ?)",
        [
            indent.indent_number,
            indent.store_id,
            indent.store_to,
            indent.bags,
            indent.boxes,
            indent.crates,
            indent.taken_by,
            indent.checked_by,
        ],
        (err, res) => {
          if (err) {
            if (err.code === "ER_DUP_ENTRY") {
              resolve({ code: 101 });
              return;
            }
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.INDENT",
              code: "REPOSITORY.INDENT.CREATE",
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
  getIndentCount() {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT count(indent_id) AS indentcount FROM new_indents`,
        [],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.INDENT",
              code: "REPOSITORY.INDENT.GET-INDENT-COUNT",
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
}

module.exports = (db) => {
  return new IndentRepository(db);
};
