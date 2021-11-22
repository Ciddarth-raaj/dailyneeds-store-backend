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

  getProductDepartment() {
    return new Promise((resolve, reject) => {
      this.db.query(
        "SELECT * FROM department_table",
        [],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.DEPARTMENT",
              code: "REPOSITORY.DEPARTMENT.GET-DEPARTMENT-TABLE",
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

  uploadDepartmentImage(image_url, department_id) {
		return new Promise((resolve, reject) => {
			this.db.query("UPDATE department_table SET image_url = ? WHERE department_id = ?", 
			[image_url, department_id],
			(err, res) => {
				if (err) {
					logger.Log({
						level: logger.LEVEL.ERROR,
						component: "REPOSITORY.DEPARTMENT",
						code: "REPOSITORY.DEPARTMENT.UPLOAD-IMAGE",
						description: err.toString(),
						category: "",
						ref: {},
					});
					reject(err);
					return;
				}
				resolve({ code: 200, id: res.insertId });
			});
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
  updateStatus(file) {
    return new Promise((resolve, reject) => {
      this.db.query(
        "UPDATE department SET status = ? WHERE department_id = ?",
        [file.status, file.department_id],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.DEPARTMENT",
              code: "REPOSITORY.DEPARTMENT.UPDATE-STATUS",
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
  updateProductDepartmentStatus(file) {
    return new Promise((resolve, reject) => {
      this.db.query(
        "UPDATE department_table SET status = ? WHERE department_id = ?",
        [file.status, file.department_id],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.DEPARTMENT",
              code: "REPOSITORY.DEPARTMENT.UPDATE-DEPARTMENT-STATUS",
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

  upsert(department) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `INSERT INTO department (department_id, department_name) 
           VALUES (?, ?) 
           ON DUPLICATE KEY UPDATE department_name = ?`,
        [
          department.department_id,
          department.department_name,
          department.department_name,
        ],
        (err) => {
          if (err) {
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
          resolve();
        }
      );
    });
  }
}

module.exports = (db) => {
  return new DepartmentRepository(db);
};
