const logger = require("../utils/logger");

class BrandRepository {
	constructor(db) {
		this.db = db;
	}

	getAll() {
		return new Promise((resolve, reject) => {
			this.db.query(`SELECT * FROM brands`, (err, docs) => {
				if (err) {
					logger.Log({
						level: logger.LEVEL.ERROR,
						component: "REPOSITORY.BRAND",
						code: "REPOSITORY.BRAND.GETALL",
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

	getByCategory(categoryId) {
		return new Promise((resolve, reject) => {
			this.db.query(
				`SELECT brands.brand_id, brand_name FROM products, brands WHERE products.category_id = ? AND products.brand_id = brands.brand_id AND products.is_online_allowed = 1 GROUP BY brands.brand_id`,
				[categoryId],
				(err, docs) => {
					if (err) {
						logger.Log({
							level: logger.LEVEL.ERROR,
							component: "REPOSITORY.BRAND",
							code: "REPOSITORY.BRAND.GETBYCATEGORY",
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

	getBySubCategory(categoryId) {
		return new Promise((resolve, reject) => {
			this.db.query(
				`SELECT brands.brand_id, brand_name FROM products, brands WHERE products.subcategory_id = ? AND products.brand_id = brands.brand_id AND products.is_online_allowed = 1 GROUP BY brands.brand_id`,
				[categoryId],
				(err, docs) => {
					if (err) {
						logger.Log({
							level: logger.LEVEL.ERROR,
							component: "REPOSITORY.BRAND",
							code: "REPOSITORY.BRAND.GETBYCATEGORY",
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

	getByDepartment(categoryId) {
		return new Promise((resolve, reject) => {
			this.db.query(
				`SELECT brands.brand_id, brand_name FROM products, brands WHERE department_id = ? AND products.brand_id = brands.brand_id AND products.is_online_allowed = 1 GROUP BY brands.brand_id`,
				[categoryId],
				(err, docs) => {
					if (err) {
						logger.Log({
							level: logger.LEVEL.ERROR,
							component: "REPOSITORY.BRAND",
							code: "REPOSITORY.BRAND.GETBYCATEGORY",
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

	getBySearch(search) {
		return new Promise((resolve, reject) => {
			this.db.query(
				`SELECT brands.brand_id, brand_name FROM products, brands WHERE name LIKE "%${search}%" AND products.brand_id = brands.brand_id AND products.is_online_allowed = 1 GROUP BY brands.brand_id`,
				(err, docs) => {
					if (err) {
						logger.Log({
							level: logger.LEVEL.ERROR,
							component: "REPOSITORY.BRAND",
							code: "REPOSITORY.BRAND.GETBYSEARCH",
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

	upsert(brand) {
		return new Promise((resolve, reject) => {
			this.db.query(
				`INSERT INTO brands (brand_id, brand_name, category_id) 
         VALUES (?, ?, ?) 
         ON DUPLICATE KEY UPDATE brand_name = ?, category_id = ?`,
				[
					brand.brand_id,
					brand.brand_name,
					brand.category_id,
					brand.brand_name,
					brand.category_id,
				],
				(err) => {
					if (err) {
						logger.Log({
							level: logger.LEVEL.ERROR,
							component: "REPOSITORY.BRAND",
							code: "REPOSITORY.BRAND.CREATE",
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
	return new BrandRepository(db);
};
