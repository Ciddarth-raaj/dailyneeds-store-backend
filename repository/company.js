const logger = require("../utils/logger");

class CompanyRepository {
  constructor(db) {
    this.db = db;
  }

  get(company_id) {
    return new Promise((resolve, reject) => {
      this.db.query("SELECT * FROM company_details where company_id = ?",
        [company_id],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.COMPANY",
              code: "REPOSITORY.COMPANY.GET",
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
        "UPDATE company_details SET status = ? WHERE company_id = ?",
        [file.status, file.company_id],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.COMPANY",
              code: "REPOSITORY.COMPANY.UPDATE-STATUS",
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
        "INSERT INTO company_details (company_name, reg_address, contact_number, gst_number, pan_number, tan_number, pf_number, esi_number, logo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [file.company_name, file.reg_address, file.contact_number, file.gst_number, file.pan_number, file.tan_number, file.pf_number, file.esi_number, file.logo],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.COMPANY",
              code: "REPOSITORY.COMPANY.CREATE",
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
  return new CompanyRepository(db);
};
