const logger = require("../utils/logger");

class DepartmentRepository {
  constructor(db) {
    this.db = db;
  }

  get() {
    return new Promise((resolve, reject) => {
      this.db.query(
        "SELECT * FROM DEPARTMENT",
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
  create(department) {
    return new Promise((resolve, reject) => {
        this.db.query(
          "INSERT INTO DEPARTMENT (status, department_name) VALUES (?, ?)",
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