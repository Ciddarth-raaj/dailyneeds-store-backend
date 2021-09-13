const logger = require("../utils/logger");

class DepartmentRepository {
  constructor(db) {
    this.db = db;
  }

  get() {
    return new Promise((resolve, reject) => {
      this.db.query(
        "SELECT * FROM department",
        [],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.DEPARTMENT",
              code: "REPOSITORY.DEPARTMENT.GET",
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
  getById(department_id) {
    return new Promise((resolve, reject) => {
      this.db.query("SELECT * FROM department where department_id = ?",
      [department_id], 
      (err, docs) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.DEPARTMENT",
            code: "REPOSITORY.DEPARTMENT.GET-ID",
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
  updateDepartmentDetails(data, department_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `UPDATE department SET ? WHERE department_id = ?`,
        [data, department_id],
        (err, res) => {
          if (err) {
              logger.Log({
                level: logger.LEVEL.ERROR,
                component: "REPOSITORY.DEPARTMENT",
                code: "REPOSITORY.DEPARTMENT.UPDATE-DEPARTMENT-DETAILS",
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
  create(department) {
    return new Promise((resolve, reject) => {
        this.db.query(
          "INSERT INTO department (status, department_name) VALUES (?, ?)",
          [
            department.status,
            department.department_name
          ],
          (err, res) => {
            if (err) {
              if (err.code === "ER_DUP_ENTRY") {
                resolve({ code: 101 });
                return;
              }
              logger.Log({
                level: logger.LEVEL.ERROR,
                component: "REPOSITORY.DEPARTMENT",
                code: "REPOSITORY.DEPARTMENT.CREATE",
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
  return new DepartmentRepository(db);
};
