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
  getDocumentById(document_id) {
    return new Promise((resolve, reject) => {
      this.db.query("SELECT * FROM new_employee_documents WHERE document_id = ?",
        [document_id],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.DOCUMENT",
              code: "REPOSITORY.DOCUMENT.GET-BY-ID",
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
  /**
   * Stage 0B / B3 — the TYPE of one document, and nothing else.
   *
   * The write guard has to know whether a document_id names an Aadhaar or a
   * PAN record before it lets the request through, and it must learn that
   * without loading the row: `getDocumentById` returns the card number and
   * the S3 path, which is exactly what the caller may not have. One column,
   * no join, no contents.
   */
  getCardTypeById(document_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        "SELECT card_type FROM new_employee_documents WHERE document_id = ?",
        [document_id],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.DOCUMENT",
              code: "REPOSITORY.DOCUMENT.GET-CARD-TYPE",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve(docs && docs.length ? docs[0].card_type : null);
        });
    });
  }
  getDocumentsWithoutAdhaar() {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT new_employee_documents.employee_id, new_employee.employee_name, (JSON_ARRAYAGG(JSON_OBJECT("card_type", card_type, 
        "card_no", card_no))) AS files FROM new_employee_documents 
        LEFT JOIN new_employee ON new_employee_documents.employee_id = new_employee.employee_id 
        GROUP BY employee_id`,
        [],
        (err, docs) => {
          if (err) {
            logger.log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.DOCUMENT",
              code: "REPOSITORY.DOCUMENT.GET-DOCUMENTS-WITHOUT-ADHAAR",
              description: err.toString(),
              category: "",
              ref: {},
            });
            console.log(err);
            reject(err);
            return;
          }
          resolve(docs);
        }
      );
    });
  }
  getAllDocuments() {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT new_employee.employee_name, new_employee_documents.document_id, new_employee_documents.file ,new_employee_documents.card_type, new_employee_documents.card_no, 
         new_employee_documents.card_name, new_employee_documents.is_verified, new_employee_documents.status, new_employee_documents.created_at FROM new_employee_documents 
         LEFT JOIN new_employee ON new_employee_documents.employee_id = new_employee.employee_id`,
        [],
        (err, docs) => {
          if (err) {
            logger.log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.DOCUMENT",
              code: "REPOSITORY.DOCUMENT.GET-ALL",
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
  updateVerification(file) {
    return new Promise((resolve, reject) => {
      this.db.query(
        "UPDATE new_employee_documents SET is_verified = ? WHERE document_id = ?",
        [file.is_verified, file.document_id],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.DOCUMENT",
              code: "REPOSITORY.DOCUMENT.UPDATE-STATUS",
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
        "UPDATE new_employee_documents SET status = ? WHERE document_id = ?",
        [file.status, file.document_id],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.DOCUMENT",
              code: "REPOSITORY.DOCUMENT.UPDATE-STATUS",
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
  getQuery(option) {
    if(option !== '' ) {
      return  `INSERT INTO new_employee_documents (employee_id, card_type, card_no, card_name, file, expiry_date ) VALUES (?, ?, ?, ?, ?, ?)`
    }
    if(option === '') {
      return `INSERT INTO new_employee_documents (employee_id, card_type, card_no, card_name, file) VALUES (?, ?, ?, ?, ?)`
    }
  }
  create(file) {
    return new Promise((resolve, reject) => {
      this.db.query(
        this.getQuery(file.expiry_date),
        [file.employee_id, file.card_type, file.card_no, file.card_name, file.file, file.expiry_date],
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
