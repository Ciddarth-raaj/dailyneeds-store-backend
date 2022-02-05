const logger = require("../utils/logger");

class UserRepository {
	constructor(db) {
		this.db = db;
	}

	login(username, password) {
		return new Promise((resolve, reject) => {
			this.db.query(
				"SELECT user.user_id AS `user_id`, user.employee_id AS `employee_id`, user.user_type AS `user_type`, (SELECT new_employee.store_id FROM new_employee WHERE new_employee.employee_id = user.employee_id) AS `store_id`, (SELECT new_employee.department_id FROM new_employee WHERE new_employee.employee_id = user.employee_id) AS `department_id`, (SELECT new_employee.designation_id FROM new_employee WHERE new_employee.employee_id = user.employee_id) AS `designation_id` FROM user WHERE status = 1 AND username = ? AND password = SHA1(?) group by user.user_id",
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
				'INSERT INTO `user` (`username`, `user_type`, `employee_id`, `password`) VALUES (?, ?, ?, SHA1(?))',
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
}

module.exports = (db) => {
	return new UserRepository(db);
};
