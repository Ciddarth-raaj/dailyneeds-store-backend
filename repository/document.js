const logger = require("../utils/logger");

class DocumentRepository {
  constructor(db) {
    this.db = db;
  }

  get() {
    return new Promise((resolve, reject) => {
      this.db.query("SELECT * FROM doc_type", [], (err, docs) => {
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
    return new Promise((resolve, reject) => {
      this.db.query(
        "INSERT INTO emp_documents (employee_id, type, id_number, file, name) VALUES (?, ?, ?, ?, ?)", 
        [file.employee_id, file.id_card, file.id_card_no, file.name, file.file], 
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
