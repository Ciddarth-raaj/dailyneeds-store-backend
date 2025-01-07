const logger = require("../utils/logger");

class BudgetRepository {
  constructor(db) {
    this.db = db;
  }

  get(limit, offset, store_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT * FROM budget where store_id = ${store_id} LIMIT ${offset},${limit}`,
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.BUDGET",
              code: "REPOSITORY.BUDGET.GET",
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
  getBudgetById(budget_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        "SELECT * FROM budget WHERE budget_id = ?",
        [budget_id],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.BUDGET",
              code: "REPOSITORY.BUDGET.GET-BUDGET-ID",
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
  getBudgetByStoreId(store_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        "SELECT * FROM budget WHERE store_id = ?",
        [store_id],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.BUDGET",
              code: "REPOSITORY.BUDGET.GET-STORE-ID",
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
  getBudgetByStore(store_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        "SELECT * FROM budget WHERE store_id = ? GROUP BY store_id",
        [store_id],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.BUDGET",
              code: "REPOSITORY.BUDGET.GET-ID",
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
  create(budget) {
    return new Promise((resolve, reject) => {
      this.db.query(
        "INSERT INTO budget (store_id, designation_name, designation_id, budget) VALUES (?, ?, ?, ?)",
        [
          budget.store_id,
          budget.designation_name,
          budget.designation_id,
          budget.budget,
        ],
        (err, res) => {
          if (err) {
            if (err.code === "ER_DUP_ENTRY") {
              resolve({ code: 101 });
              return;
            }
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.BUDGET",
              code: "REPOSITORY.BUDGET.CREATE",
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
  update(budget) {
    return new Promise((resolve, reject) => {
      this.db.query(
        "Update budget SET budget = ? AND designation_id = ? WHERE budget_id = ?",
        [budget.budget, budget.designation_id, budget.budget_id],
        (err, res) => {
          if (err) {
            if (err.code === "ER_DUP_ENTRY") {
              resolve({ code: 101 });
              return;
            }
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.BUDGET",
              code: "REPOSITORY.BUDGET.UPDATE",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve({ code: 200, message: "Budget updated" });
        }
      );
    });
  }
}

module.exports = (db) => {
  return new BudgetRepository(db);
};
