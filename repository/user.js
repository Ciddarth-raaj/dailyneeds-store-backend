const logger = require("../utils/logger");

class UserRepository {
  constructor(db) {
    this.db = db;
  }

  login(username, password) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT u.user_id AS user_id,
                u.employee_id AS employee_id,
                u.user_type AS user_type,
                ne.store_id AS store_id,
                ne.department_id AS department_id,
                ne.designation_id AS designation_id
         FROM \`user\` u
         LEFT JOIN new_employee ne ON ne.employee_id = u.employee_id
         WHERE u.status = 1 AND ne.status = 1 AND u.username = ? AND u.password = SHA1(?)`,
        [username, password],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.USER",
              code: "REPOSITORY.USER.LOGIN",
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
  updateStatus(employee) {
    return new Promise((resolve, reject) => {
      this.db.query(
        "UPDATE `user` SET `status` = ? WHERE `employee_id` = ?",
        [employee.status, employee.employee_id],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.USER",
              code: "REPOSITORY.USER.UPDATE-STATUS",
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
  createLogin(username, user_type, employee_id, password) {
    return new Promise((resolve, reject) => {
      this.db.query(
        "INSERT INTO `user` (`username`, `user_type`, `employee_id`, `password`) VALUES (?, ?, ?, SHA1(?))",
        [username, user_type, employee_id, password],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.USER",
              code: "REPOSITORY.USER.CREATE",
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

  createLoginIfNeeded(username, user_type, employee_id, password) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `INSERT INTO user (username, user_type, employee_id, password)
		 SELECT ?, ?, ?, SHA1(?)
		 WHERE NOT EXISTS (
  			SELECT 1
  			FROM user
  			WHERE employee_id = ?
		 );`,
        [username, user_type, employee_id, password, employee_id],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.USER",
              code: "REPOSITORY.USER.CREATE",
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
}

module.exports = (db) => {
  return new UserRepository(db);
};
