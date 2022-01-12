const logger = require("../utils/logger");

class IssueRepository {
  constructor(db) {
    this.db = db;
  }

  get() {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT n.indent_id, n.indent_number, s.store_name as 'from', y.store_name as 'to', i.product_id 
        , product_table.de_name, i.sent, i.received, i.difference, n.delivery_status
        from new_indents n LEFT JOIN store s ON s.store_id = n.store_id LEFT JOIN store y ON y.store_id = 
        n.store_to LEFT JOIN new_employee e1 ON e1.employee_id = n.indent_id LEFT JOIN new_employee 
        e2 ON e2.employee_id = n.indent_id LEFT JOIN issue i ON i.indent_id = n.indent_id LEFT JOIN
        product_table ON product_table.product_id = i.product_id WHERE i.sent IS NOT NULL`,
        [],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.ISSUE",
              code: "REPOSITORY.ISSUE.GET",
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
  getIssueFromStoreId(store_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT n.indent_id, n.indent_number, s.store_name as 'from', y.store_name as 'to', i.product_id 
        , product_table.de_name, i.sent, i.received, i.difference, n.delivery_status
        from new_indents n LEFT JOIN store s ON s.store_id = n.store_id LEFT JOIN store y ON y.store_id = 
        n.store_to LEFT JOIN new_employee e1 ON e1.employee_id = n.indent_id LEFT JOIN new_employee 
        e2 ON e2.employee_id = n.indent_id LEFT JOIN issue i ON i.indent_id = n.indent_id LEFT JOIN
        product_table ON product_table.product_id = i.product_id WHERE i.sent IS NOT NULL AND s.store_id=${store_id}`,
        [store_id],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.ISSUE",
              code: "REPOSITORY.ISSUE.GET-BY-STORE-ID",
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
  getIssueByStoreId(store_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT n.indent_id, n.indent_number, s.store_name as 'from', y.store_name as 'to', i.product_id 
        , product_table.de_name, i.sent, i.received, i.difference, n.delivery_status
        from new_indents n LEFT JOIN store s ON s.store_id = n.store_id LEFT JOIN store y ON y.store_id = 
        n.store_to LEFT JOIN new_employee e1 ON e1.employee_id = n.indent_id LEFT JOIN new_employee 
        e2 ON e2.employee_id = n.indent_id LEFT JOIN issue i ON i.indent_id = n.indent_id LEFT JOIN
        product_table ON product_table.product_id = i.product_id WHERE i.sent IS NOT NULL AND y.store_id=${store_id}`,
        [store_id],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.ISSUE",
              code: "REPOSITORY.ISSUE.GET-BY-STORE-ID",
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
  getById(issue_id) {
    return new Promise((resolve, reject) => {
      this.db.query("SELECT * FROM issue where issue_id = ?",
        [issue_id],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.ISSUE",
              code: "REPOSITORY.ISSUE.GET-ID",
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
  updateStatus(file) {
    return new Promise((resolve, reject) => {
      this.db.query(
        "UPDATE issue SET status = ? WHERE issue_id = ?",
        [file.status, file.issue_id],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.ISSUE",
              code: "REPOSITORY.ISSUE.UPDATE-STATUS",
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
  create(issue) {
    return new Promise((resolve, reject) => {
      this.db.query(
        "INSERT INTO issue ( indent_id, product_id, sent, received, difference ) VALUES (?, ?, ?, ?, ?)",
        [
          issue.indent_id,
          issue.product_id,
          issue.sent,
          issue.received,
          issue.difference
        ],
        (err, res) => {
          if (err) {
            if (err.code === "ER_DUP_ENTRY") {
              resolve({ code: 101 });
              return;
            }
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.ISSUE",
              code: "REPOSITORY.ISSUE.CREATE",
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
}

module.exports = (db) => {
  return new IssueRepository(db);
};
