const logger = require("../utils/logger");

class SubCategoryRepository {
	constructor(db) {
		this.db = db;
	}

	getAll() {
		return new Promise((resolve, reject) => {
			this.db.query(`SELECT * FROM subcategories`, (err, docs) => {
				if (err) {
					logger.Log({
						level: logger.LEVEL.ERROR,
						component: "REPOSITORY.SUBCATEGORY",
						code: "REPOSITORY.SUBCATEGORY.GETALL",
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

	upsert(subCategory) {
		return new Promise((resolve, reject) => {
			this.db.query(
				`INSERT INTO subcategories (subcategory_id, subcategory_name, category_id) 
         VALUES (?, ?, ?) 
         ON DUPLICATE KEY UPDATE subcategory_name = ?, category_id = ?`,
				[
					subCategory.subcategory_id,
					subCategory.subcategory_name,
					subCategory.category_id,
					subCategory.subcategory_name,
					subCategory.category_id,
				],
				(err) => {
					if (err) {
						logger.Log({
							level: logger.LEVEL.ERROR,
							component: "REPOSITORY.SUBCATEGORY",
							code: "REPOSITORY.SUBCATEGORY.CREATE",
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

	update(subcategory) {
		return new Promise((resolve, reject) => {
			const subcategoryId = subcategory.subcategory_id;
			delete subcategory.subcategory_id;

			this.db.query(
				`UPDATE subcategories SET ? WHERE subcategory_id = ?`,
				[subcategory, subcategoryId],
				(err, docs) => {
					if (err) {
						logger.Log({
							level: logger.LEVEL.ERROR,
							component: "REPOSITORY.SUBCATEGORY",
							code: "REPOSITORY.SUBCATEGORY.UPDATE",
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
	return new SubCategoryRepository(db);
};
