const logger = require("../utils/logger");

class CategoryRepository {
  constructor(db) {
    this.db = db;
  }

  getAll() {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT * FROM categories`,
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.CATEGORY",
              code: "REPOSITORY.CATEGORY.GETALL",
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

  update(category) {
    return new Promise((resolve, reject) => {

      const categoryId = category.category_id;
      delete category.category_id;

      this.db.query(
        `UPDATE categories SET ? WHERE category_id = ?`,
        [category, categoryId],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.CATEGORY",
              code: "REPOSITORY.CATEGORY.UPDATE",
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

  upsert(category) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `INSERT INTO categories (category_id, category_name, department_id) 
         VALUES (?, ?, ?) 
         ON DUPLICATE KEY UPDATE category_name = ?, department_id = ?`,
        [category.category_id, category.category_name, category.department_id, category.category_name, category.department_id],
        (err) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.CATEGORY",
              code: "REPOSITORY.CATEGORY.CREATE",
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
  return new CategoryRepository(db);
};