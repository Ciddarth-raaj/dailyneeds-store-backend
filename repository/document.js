const logger = require("../utils/logger");

class DocumentRepository {
  constructor(db) {
    this.db = db;
  }

  get(employee_id) {
    return new Promise((resolve, reject) => {
      this.db.query("SELECT * FROM new_employee_documents where employee_id = ?", 
      [employee_id],
      (err, docs) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.DOCUMENT",
            code: "REPOSITORY.DOCUMENT.GET",
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
  getAdhaar() {
    return new Promise((resolve, reject) => {
      this.db.query(
        "select * from new_employee_documents LEFT JOIN new_employee ON new_employee_documents.employee_id = new_employee.employee_id WHERE card_type = 1",
        [],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.DOCUMENT",
              code: "REPOSITORY.DOCUMENT.GET-ADHAAR",
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
  update(file) {
    console.log({file: file});
    return new Promise((resolve, reject) => {
      this.db.query(
        "UPDATE new_employee_documents SET ? WHERE employee_id = ? AND card_type = ?", 
        [file.data, file.employee_id, file.card_type], 
        (err, docs) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.DOCUMENT",
            code: "REPOSITORY.DOCUMENT.UPDATE",
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
  create(file) {
    return new Promise((resolve, reject) => {
      this.db.query(
        "INSERT INTO new_employee_documents (employee_id, card_type, card_no, card_name, expiry_date, file) VALUES (?, ?, ?, ?, ?, ?)", 
        [file.employee_id, file.card_type, file.card_no, file.card_name, file.expiry_date, file.file], 
        (err, docs) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.DOCUMENT",
            code: "REPOSITORY.DOCUMENT.CREATE",
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
}

module.exports = (db) => {
  return new DocumentRepository(db);
};
