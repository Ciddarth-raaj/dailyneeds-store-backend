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

  create(file) {
    console.log({file: file});
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
