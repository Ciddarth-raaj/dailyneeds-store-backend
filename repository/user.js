const logger = require("../utils/logger");

class UserRepository {
	constructor(db) {
		this.db = db;
	}

	login(username, password) {
		return new Promise((resolve, reject) => {
			this.db.query(
				`SELECT user.user_id, user.employee_id, user.user_type, new_employee.store_id, new_employee.department_id, new_employee.designation_id FROM user, new_employee WHERE new_employee.employee_id = user.employee_id AND username = ? AND password = SHA1(?)`,
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
	createLogin(username, user_type, employee_id, password) {
		console.log({username: username});
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
