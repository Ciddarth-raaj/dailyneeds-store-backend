const logger = require("../utils/logger");

class AccountsRepository {
  constructor(db) {
    this.db = db;
  }

  create(account) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `INSERT INTO accounts (
          date, total_sales, cash_handover_1, cash_handover_2, cash_handover_5, 
          cash_handover_10, cash_handover_20, cash_handover_50, cash_handover_100, 
          cash_handover_200, cash_handover_500, card_sales, loyalty, sales_return, 
          cashier_id, user_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          account.date,
          account.total_sales,
          account.cash_handover_1,
          account.cash_handover_2,
          account.cash_handover_5,
          account.cash_handover_10,
          account.cash_handover_20,
          account.cash_handover_50,
          account.cash_handover_100,
          account.cash_handover_200,
          account.cash_handover_500,
          account.card_sales,
          account.loyalty,
          account.sales_return,
          account.cashier_id,
          account.user_id,
        ],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.ACCOUNTS",
              code: "REPOSITORY.ACCOUNTS.CREATE",
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

  createSale(sale) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `INSERT INTO accounts_sales (
          accounts_id, person_type, payment_type, person_id, 
          description, amount, receipt_path
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          sale.accounts_id,
          sale.person_type,
          sale.payment_type,
          sale.person_id,
          sale.description,
          sale.amount,
          sale.receipt_path,
        ],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.ACCOUNTS",
              code: "REPOSITORY.ACCOUNTS.CREATE-SALE",
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

  updateSale(sale) {
    return new Promise((resolve, reject) => {
      if (!sale.sales_id) {
        return this.createSale(sale);
      }

      this.db.query(
        `UPDATE accounts_sales 
        SET person_type = ?, 
            payment_type = ?, 
            person_id = ?, 
            description = ?, 
            amount = ?, 
            receipt_path = ?
        WHERE sales_id = ? AND accounts_id = ?`,
        [
          sale.person_type,
          sale.payment_type,
          sale.person_id,
          sale.description,
          sale.amount,
          sale.receipt_path,
          sale.sales_id,
          sale.accounts_id,
        ],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.ACCOUNTS",
              code: "REPOSITORY.ACCOUNTS.UPDATE-SALE",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve({ code: 200, id: sale.sales_id });
        }
      );
    });
  }

  update(account) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `UPDATE accounts SET 
          date = ?, total_sales = ?, cash_handover_1 = ?, cash_handover_2 = ?, 
          cash_handover_5 = ?, cash_handover_10 = ?, cash_handover_20 = ?, 
          cash_handover_50 = ?, cash_handover_100 = ?, cash_handover_200 = ?, 
          cash_handover_500 = ?, card_sales = ?, loyalty = ?, sales_return = ?, 
          cashier_id = ?, user_id = ?
        WHERE accounts_id = ?`,
        [
          account.date,
          account.total_sales,
          account.cash_handover_1,
          account.cash_handover_2,
          account.cash_handover_5,
          account.cash_handover_10,
          account.cash_handover_20,
          account.cash_handover_50,
          account.cash_handover_100,
          account.cash_handover_200,
          account.cash_handover_500,
          account.card_sales,
          account.loyalty,
          account.sales_return,
          account.cashier_id,
          account.user_id,
          account.accounts_id,
        ],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.ACCOUNTS",
              code: "REPOSITORY.ACCOUNTS.UPDATE",
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

  delete(accountId) {
    return new Promise((resolve, reject) => {
      this.db.query(
        "DELETE FROM accounts WHERE accounts_id = ?",
        [accountId],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.ACCOUNTS",
              code: "REPOSITORY.ACCOUNTS.DELETE",
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

  getAll(filters) {
    return new Promise((resolve, reject) => {
      let filterConditions = [];
      let filterValues = [];

      // Add date range filter if provided
      if (filters?.from_date) {
        filterConditions.push("DATE(a.date) >= ?");
        filterValues.push(filters.from_date);
      }
      if (filters?.to_date) {
        filterConditions.push("DATE(a.date) <= ?");
        filterValues.push(filters.to_date);
      }

      // Add store filter if provided
      if (filters?.store_id) {
        filterConditions.push("ne.store_id = ?");
        filterValues.push(filters.store_id);
      }

      // Combine filter conditions
      const whereClause =
        filterConditions.length > 0
          ? `WHERE ${filterConditions.join(" AND ")}`
          : "";

      this.db.query(
        `SELECT a.*, 
         ne.employee_name as cashier_name,
         ne.store_id,
         (
           SELECT JSON_ARRAYAGG(
             JSON_OBJECT(
               'sales_id', s2.sales_id,
               'person_type', s2.person_type,
               'payment_type', s2.payment_type,
               'person_id', s2.person_id,
               'person_name', pl.name,
               'description', s2.description,
               'amount', s2.amount,
               'receipt_path', s2.receipt_path
             )
           )
           FROM accounts_sales s2 
           LEFT JOIN people_list pl ON pl.person_id = s2.person_id
           WHERE s2.accounts_id = a.accounts_id
         ) as sales,
         EXISTS(
           SELECT 1 FROM accounts_saved acs 
           WHERE DATE(acs.sheet_date) = DATE(a.date)
           AND acs.store_id = ne.store_id
         ) as is_saved
         FROM accounts a
         LEFT JOIN new_employee ne ON ne.employee_id = a.cashier_id
         ${whereClause}
         ORDER BY a.date DESC`,
        filterValues,
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.ACCOUNTS",
              code: "REPOSITORY.ACCOUNTS.GET-ALL",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }

          // Parse the sales JSON string into an array or set to null
          const accounts = docs.map((account) => ({
            ...account,
            is_saved: account.is_saved === 1,
            sales: account.sales ? JSON.parse(account.sales) : null,
          }));

          // Get is_saved from first record if exists
          const is_saved = docs.length > 0 ? docs[0].is_saved === 1 : false;

          resolve({
            code: 200,
            is_saved,
            data: accounts.map(({ is_saved, ...account }) => account), // Remove is_saved from individual records
          });
        }
      );
    });
  }

  getById(accountId) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT a.*, 
         ne.employee_name as cashier_name,
         ne.store_id,
         (
           SELECT JSON_ARRAYAGG(
             JSON_OBJECT(
               'sales_id', s2.sales_id,
               'person_type', s2.person_type,
               'payment_type', s2.payment_type,
               'person_id', s2.person_id,
               'person_name', pl.name,
               'description', s2.description,
               'amount', s2.amount,
               'receipt_path', s2.receipt_path
             )
           )
           FROM accounts_sales s2 
           LEFT JOIN people_list pl ON pl.person_id = s2.person_id
           WHERE s2.accounts_id = a.accounts_id
         ) as sales,
         EXISTS(
           SELECT 1 FROM accounts_saved acs 
           WHERE DATE(acs.sheet_date) = DATE(a.date)
           AND acs.store_id = ne.store_id
         ) as is_saved
         FROM accounts a
         LEFT JOIN new_employee ne ON ne.employee_id = a.cashier_id
         WHERE a.accounts_id = ?`,
        [accountId],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.ACCOUNTS",
              code: "REPOSITORY.ACCOUNTS.GET-BY-ID",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }

          if (docs.length === 0) {
            resolve({ code: 404 });
            return;
          }

          const account = {
            ...docs[0],
            sales: docs[0].sales ? JSON.parse(docs[0].sales) : null,
          };

          // Get is_saved value
          const is_saved = docs[0].is_saved == 1;

          // Remove is_saved from account object
          const { is_saved: _, ...accountWithoutIsSaved } = account;

          resolve({
            code: 200,
            is_saved,
            data: accountWithoutIsSaved,
          });
        }
      );
    });
  }

  saveAccount(sheetData) {
    return new Promise((resolve, reject) => {
      this.db.query(
        "INSERT INTO accounts_saved (sheet_date, store_id) VALUES (?, ?)",
        [sheetData.sheet_date, sheetData.store_id],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.ACCOUNTS",
              code: "REPOSITORY.ACCOUNTS.SAVE-SHEET",
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

  deleteSavedAccount(sheetData) {
    return new Promise((resolve, reject) => {
      this.db.query(
        "DELETE FROM accounts_saved WHERE sheet_date = ? AND store_id = ?",
        [sheetData.sheet_date, sheetData.store_id],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.ACCOUNTS",
              code: "REPOSITORY.ACCOUNTS.DELETE-SAVED-SHEET",
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

  checkSheetSaved(date, store_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT COUNT(*) as exists_count 
         FROM accounts_saved 
         WHERE DATE(sheet_date) = DATE(?) 
         AND store_id = ?`,
        [date, store_id],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.ACCOUNTS",
              code: "REPOSITORY.ACCOUNTS.CHECK-SAVED",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve({
            code: 200,
            is_saved: docs[0].exists_count > 0,
          });
        }
      );
    });
  }
}

module.exports = (db) => {
  return new AccountsRepository(db);
};
