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
                u.allowed_ips AS allowed_ips,
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
  /**
   * The IP allow-list for one user, or null when there is no such row.
   *
   * Deliberately not filtered by status: a deactivated account still holds a
   * valid token until it expires, and its allow-list must keep applying.
   */
  getAllowedIps(userId) {
    return new Promise((resolve, reject) => {
      this.db.query(
        "SELECT `allowed_ips` FROM `user` WHERE `user_id` = ?",
        [userId],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.USER",
              code: "REPOSITORY.USER.GET-ALLOWED-IPS",
              description: err.toString(),
              category: "",
              ref: { userId },
            });
            reject(err);
            return;
          }
          resolve(docs.length === 0 ? null : docs[0].allowed_ips);
        }
      );
    });
  }

  /** Every active login with the employee details an admin needs to pick one. */
  getIpRestrictions() {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT u.user_id AS user_id,
                u.username AS username,
                u.user_type AS user_type,
                u.allowed_ips AS allowed_ips,
                u.employee_id AS employee_id,
                ne.employee_name AS employee_name,
                ne.store_id AS store_id,
                s.store_name AS store_name,
                d.designation_name AS designation_name
         FROM \`user\` u
         LEFT JOIN new_employee ne ON ne.employee_id = u.employee_id
         LEFT JOIN store s ON s.store_id = ne.store_id
         LEFT JOIN designation d ON d.designation_id = ne.designation_id
         WHERE u.status = 1
         ORDER BY ne.employee_name ASC, u.username ASC`,
        [],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.USER",
              code: "REPOSITORY.USER.GET-IP-RESTRICTIONS",
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

  /** Replace a user's allow-list. `null` clears the restriction. */
  updateAllowedIps(userId, allowedIps) {
    return new Promise((resolve, reject) => {
      this.db.query(
        "UPDATE `user` SET `allowed_ips` = ? WHERE `user_id` = ?",
        [allowedIps, userId],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.USER",
              code: "REPOSITORY.USER.UPDATE-ALLOWED-IPS",
              description: err.toString(),
              category: "",
              ref: { userId },
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
