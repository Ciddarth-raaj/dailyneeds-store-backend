const logger = require("../utils/logger");

class CategoryRepository {
  constructor(db) {
    this.db = db;
  }

  getAll(limit, offset) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT categories.category_id, categories.category_name, department.department_name, categories.created_at FROM categories LEFT JOIN
        department on department.department_id = categories.department_id LIMIT ${offset}, ${limit}`,
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
  getCategoryCount() {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT count(category_id) AS catcount FROM categories`,
        [],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PRODUCT",
              code: "REPOSITORY.PRODUCT.GET-CATEGORY-COUNT",
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
  getByCategoryId(category_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT * FROM categories where category_id = ?`, [category_id],
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
