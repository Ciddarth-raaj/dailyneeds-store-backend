const logger = require("../utils/logger");

class FamilyRepository {
  constructor(db) {
    this.db = db;
  }

  get() {
    return new Promise((resolve, reject) => {
      this.db.query(
        "SELECT * FROM employee_family",
        [],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.FAMILY",
              code: "REPOSITORY.FAMILY.GET",
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
  getFamilyByEmployee(employee_name) {
    return new Promise((resolve, reject) => {
      this.db.query("SELECT * FROM employee_family WHERE employee_name = ?",
      [employee_name], 
      (err, docs) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.FAMILY",
            code: "REPOSITORY.FAMILY.GET-EMPLOYEE-FAM",
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
  getFamilyById(family_id) {
    return new Promise((resolve, reject) => {
      this.db.query("SELECT * FROM employee_family where family_id = ?",
      [family_id], 
      (err, docs) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.FAMILY",
            code: "REPOSITORY.FAMILY.GET-FAMILY-ID",
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
  updateFamilyDetails(data, family_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `UPDATE employee_family SET ? WHERE family_id = ?`,
        [data, family_id],
        (err, res) => {
          if (err) {
              logger.Log({
                level: logger.LEVEL.ERROR,
                component: "REPOSITORY.FAMILY",
                code: "REPOSITORY.FAMILY.UPDATE-FAMILY-DETAILS",
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
  create(family) {
    return new Promise((resolve, reject) => {
        this.db.query(
          "INSERT INTO employee_family (name, dob, gender, blood_group, relation, employee_name, nationality, profession, remarks) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [
            family.name,
            family.dob,
            family.gender,
            family.blood_group,
            family.relation,
            family.employee_name,
            family.nationality,
            family.profession,
            family.remarks
          ],
          (err, res) => {
            if (err) {
              if (err.code === "ER_DUP_ENTRY") {
                resolve({ code: 101 });
                return;
              }
              logger.Log({
                level: logger.LEVEL.ERROR,
                component: "REPOSITORY.FAMILY",
                code: "REPOSITORY.FAMILY.CREATE",
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
  return new FamilyRepository(db);
};
