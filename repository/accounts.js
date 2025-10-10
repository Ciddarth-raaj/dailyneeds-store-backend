const logger = require("../utils/logger");

class AccountsRepository {
  constructor(db) {
    this.db = db;
  }

  create(account) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `INSERT INTO accounts (
          date, no_of_bills, total_sales, cash_handover_1, cash_handover_2, cash_handover_5, 
          cash_handover_10, cash_handover_20, cash_handover_50, cash_handover_100, 
          cash_handover_200, cash_handover_500, card_sales, loyalty, sales_return, 
          cashier_id, user_id, store_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          account.date,
          account.no_of_bills,
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
          account.store_id,
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

      let updateFields = [];
      let queryParams = [];

      // Only add fields that are provided
      if (sale.person_type !== undefined) {
        updateFields.push("person_type = ?");
        queryParams.push(sale.person_type);
      }
      if (sale.payment_type !== undefined) {
        updateFields.push("payment_type = ?");
        queryParams.push(sale.payment_type);
      }
      if (sale.person_id !== undefined) {
        updateFields.push("person_id = ?");
        queryParams.push(sale.person_id);
      }
      if (sale.description !== undefined) {
        updateFields.push("description = ?");
        queryParams.push(sale.description);
      }
      if (sale.amount !== undefined) {
        updateFields.push("amount = ?");
        queryParams.push(sale.amount);
      }
      if (sale.receipt_path !== undefined) {
        updateFields.push("receipt_path = ?");
        queryParams.push(sale.receipt_path);
      }
      if (sale.is_checked !== undefined) {
        updateFields.push("is_checked = ?");
        queryParams.push(sale.is_checked);
      }

      // If no fields to update, return success
      if (updateFields.length === 0) {
        resolve({ code: 200, id: sale.sales_id });
        return;
      }

      // Add WHERE clause parameter
      queryParams.push(sale.sales_id);

      const whereClause =
        sale.accounts_id !== undefined
          ? "WHERE sales_id = ? AND accounts_id = ?"
          : "WHERE sales_id = ?";

      // Add accounts_id to params if provided
      if (sale.accounts_id !== undefined) {
        queryParams.push(sale.accounts_id);
      }

      this.db.query(
        `UPDATE accounts_sales 
        SET ${updateFields.join(", ")}
        ${whereClause}`,
        queryParams,
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
          date = ?, no_of_bills = ?, total_sales = ?, cash_handover_1 = ?, cash_handover_2 = ?, 
          cash_handover_5 = ?, cash_handover_10 = ?, cash_handover_20 = ?, 
          cash_handover_50 = ?, cash_handover_100 = ?, cash_handover_200 = ?, 
          cash_handover_500 = ?, card_sales = ?, loyalty = ?, sales_return = ?, 
          cashier_id = ?, user_id = ?
        WHERE accounts_id = ?`,
        [
          account.date,
          account.no_of_bills,
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
        filterConditions.push("a.store_id = ?");
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
         o.outlet_name,
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
               'receipt_path', s2.receipt_path,
               'is_checked', s2.is_checked
             )
           )
           FROM accounts_sales s2 
           LEFT JOIN people_list pl ON pl.person_id = s2.person_id
           WHERE s2.accounts_id = a.accounts_id
         ) as sales
         FROM accounts a
         LEFT JOIN new_employee ne ON ne.employee_id = a.cashier_id
         LEFT JOIN outlets o ON o.outlet_id = a.store_id
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

          const accounts = docs.map((account) => ({
            ...account,
            sales: account.sales ? JSON.parse(account.sales) : null,
          }));

          resolve({
            code: 200,
            data: accounts,
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
               'receipt_path', s2.receipt_path,
               'is_checked', s2.is_checked
             )
           )
           FROM accounts_sales s2 
           LEFT JOIN people_list pl ON pl.person_id = s2.person_id
           WHERE s2.accounts_id = a.accounts_id
         ) as sales,
         EXISTS(
           SELECT 1 FROM accounts_saved acs 
           WHERE DATE(acs.sheet_date) = DATE(a.date)
           AND acs.store_id = a.store_id
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

  getSavedAccount(date, store_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT * FROM accounts_saved 
         WHERE DATE(sheet_date) = DATE(?) 
         AND store_id = ?`,
        [new Date(date), store_id],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.ACCOUNTS",
              code: "REPOSITORY.ACCOUNTS.GET-SAVED-ACCOUNT",
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
          resolve({
            code: 200,
            data: {
              ...docs[0],
              sheet_date: docs[0].sheet_date.toISOString().split("T")[0],
            },
          });
        }
      );
    });
  }

  getStandaloneSaleById(saleId) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT s.*, pl.name as person_name
         FROM accounts_sales s
         LEFT JOIN people_list pl ON pl.person_id = s.person_id
         WHERE s.sales_id = ? AND s.accounts_id IS NULL`,
        [saleId],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.ACCOUNTS",
              code: "REPOSITORY.ACCOUNTS.GET-STANDALONE-SALE-BY-ID",
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
          resolve({ code: 200, data: docs[0] });
        }
      );
    });
  }

  createWarehouseSale(sale) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `INSERT INTO accounts_warehouse_sales (
          person_type, payment_type, person_id, 
          description, amount, receipt_path, date
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          sale.person_type,
          sale.payment_type,
          sale.person_id,
          sale.description,
          sale.amount,
          sale.receipt_path,
          sale.date,
        ],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.ACCOUNTS",
              code: "REPOSITORY.ACCOUNTS.CREATE-WAREHOUSE-SALE",
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

  updateWarehouseSale(sale) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `UPDATE accounts_warehouse_sales 
        SET person_type = ?, 
            payment_type = ?, 
            person_id = ?, 
            description = ?, 
            amount = ?, 
            receipt_path = ?,
            date = ?
        WHERE sales_id = ?`,
        [
          sale.person_type,
          sale.payment_type,
          sale.person_id,
          sale.description,
          sale.amount,
          sale.receipt_path,
          sale.date,
          sale.sales_id,
        ],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.ACCOUNTS",
              code: "REPOSITORY.ACCOUNTS.UPDATE-WAREHOUSE-SALE",
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

  deleteWarehouseSale(saleId) {
    return new Promise((resolve, reject) => {
      this.db.query(
        "DELETE FROM accounts_warehouse_sales WHERE sales_id = ?",
        [saleId],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.ACCOUNTS",
              code: "REPOSITORY.ACCOUNTS.DELETE-WAREHOUSE-SALE",
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

  getWarehouseSales(filters = {}) {
    return new Promise((resolve, reject) => {
      let filterConditions = [];
      let filterValues = [];

      if (filters.from_date) {
        filterConditions.push("DATE(s.date) >= ?");
        filterValues.push(filters.from_date);
      }
      if (filters.to_date) {
        filterConditions.push("DATE(s.date) <= ?");
        filterValues.push(filters.to_date);
      }

      const whereClause =
        filterConditions.length > 0
          ? `WHERE ${filterConditions.join(" AND ")}`
          : "";

      this.db.query(
        `SELECT s.*, pl.name as person_name
         FROM accounts_warehouse_sales s
         LEFT JOIN people_list pl ON pl.person_id = s.person_id
         ${whereClause}
         ORDER BY s.date DESC, s.sales_id DESC`,
        filterValues,
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.ACCOUNTS",
              code: "REPOSITORY.ACCOUNTS.GET-WAREHOUSE-SALES",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve({ code: 200, data: docs });
        }
      );
    });
  }

  getWarehouseSaleById(saleId) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT s.*, pl.name as person_name
         FROM accounts_warehouse_sales s
         LEFT JOIN people_list pl ON pl.person_id = s.person_id
         WHERE s.sales_id = ?`,
        [saleId],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.ACCOUNTS",
              code: "REPOSITORY.ACCOUNTS.GET-WAREHOUSE-SALE-BY-ID",
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
          resolve({ code: 200, data: docs[0] });
        }
      );
    });
  }

  createWarehouseCashDenomination(denomination) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `INSERT INTO accounts_warehouse_cash_denomination (
          cash_handover_1, cash_handover_2, cash_handover_5, 
          cash_handover_10, cash_handover_20, cash_handover_50,
          cash_handover_100, cash_handover_200, cash_handover_500,
          date
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          denomination.cash_handover_1,
          denomination.cash_handover_2,
          denomination.cash_handover_5,
          denomination.cash_handover_10,
          denomination.cash_handover_20,
          denomination.cash_handover_50,
          denomination.cash_handover_100,
          denomination.cash_handover_200,
          denomination.cash_handover_500,
          denomination.date,
        ],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.ACCOUNTS",
              code: "REPOSITORY.ACCOUNTS.CREATE-WAREHOUSE-CASH-DENOMINATION",
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

  updateWarehouseCashDenomination(denomination) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `UPDATE accounts_warehouse_cash_denomination 
        SET cash_handover_1 = ?, 
            cash_handover_2 = ?, 
            cash_handover_5 = ?, 
            cash_handover_10 = ?,
            cash_handover_20 = ?,
            cash_handover_50 = ?,
            cash_handover_100 = ?,
            cash_handover_200 = ?,
            cash_handover_500 = ?,
            date = ?
        WHERE cash_denomination_id = ?`,
        [
          denomination.cash_handover_1,
          denomination.cash_handover_2,
          denomination.cash_handover_5,
          denomination.cash_handover_10,
          denomination.cash_handover_20,
          denomination.cash_handover_50,
          denomination.cash_handover_100,
          denomination.cash_handover_200,
          denomination.cash_handover_500,
          denomination.date,
          denomination.cash_denomination_id,
        ],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.ACCOUNTS",
              code: "REPOSITORY.ACCOUNTS.UPDATE-WAREHOUSE-CASH-DENOMINATION",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve({ code: 200, id: denomination.cash_denomination_id });
        }
      );
    });
  }

  deleteWarehouseCashDenomination(denominationId) {
    return new Promise((resolve, reject) => {
      this.db.query(
        "DELETE FROM accounts_warehouse_cash_denomination WHERE cash_denomination_id = ?",
        [denominationId],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.ACCOUNTS",
              code: "REPOSITORY.ACCOUNTS.DELETE-WAREHOUSE-CASH-DENOMINATION",
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

  getWarehouseCashDenominations(filters = {}) {
    return new Promise((resolve, reject) => {
      let filterConditions = [];
      let filterValues = [];

      if (filters.from_date) {
        filterConditions.push("DATE(date) >= ?");
        filterValues.push(filters.from_date);
      }
      if (filters.to_date) {
        filterConditions.push("DATE(date) <= ?");
        filterValues.push(filters.to_date);
      }

      const whereClause =
        filterConditions.length > 0
          ? `WHERE ${filterConditions.join(" AND ")}`
          : "";

      this.db.query(
        `SELECT * FROM accounts_warehouse_cash_denomination
         ${whereClause}
         ORDER BY date DESC, cash_denomination_id DESC`,
        filterValues,
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.ACCOUNTS",
              code: "REPOSITORY.ACCOUNTS.GET-WAREHOUSE-CASH-DENOMINATIONS",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve({ code: 200, data: docs });
        }
      );
    });
  }

  getWarehouseCashDenominationById(denominationId) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT * FROM accounts_warehouse_cash_denomination
         WHERE cash_denomination_id = ?`,
        [denominationId],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.ACCOUNTS",
              code: "REPOSITORY.ACCOUNTS.GET-WAREHOUSE-CASH-DENOMINATION-BY-ID",
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
          resolve({ code: 200, data: docs[0] });
        }
      );
    });
  }

  getAllOutletsCashHandover(filters = {}) {
    return new Promise((resolve, reject) => {
      let filterConditions = [];
      let filterValues = [];

      if (filters.from_date) {
        filterConditions.push("DATE(a.date) >= ?");
        filterValues.push(filters.from_date);
      }
      if (filters.to_date) {
        filterConditions.push("DATE(a.date) <= ?");
        filterValues.push(filters.to_date);
      }

      const whereClause =
        filterConditions.length > 0
          ? `WHERE ${filterConditions.join(" AND ")}`
          : "";

      this.db.query(
        `SELECT 
          a.date,
          a.store_id,
          o.outlet_name,
          a.cash_handover_1,
          a.cash_handover_2,
          a.cash_handover_5,
          a.cash_handover_10,
          a.cash_handover_20,
          a.cash_handover_50,
          a.cash_handover_100,
          a.cash_handover_200,
          a.cash_handover_500
         FROM accounts a
         LEFT JOIN new_employee ne ON ne.employee_id = a.cashier_id
         LEFT JOIN outlets o ON o.outlet_id = a.store_id
         ${whereClause}
         ORDER BY a.date DESC, a.store_id`,
        filterValues,
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.ACCOUNTS",
              code: "REPOSITORY.ACCOUNTS.GET-ALL-OUTLETS-CASH-HANDOVER",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve({
            code: 200,
            data: docs.map((row) => ({
              ...row,
              date: row.date.toISOString().split("T")[0],
            })),
          });
        }
      );
    });
  }

  addStartingCash(params) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `INSERT INTO accounts_warehouse_starting_cash (starting_cash, date, can_carry_forward)
        VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE starting_cash = VALUES(starting_cash), can_carry_forward = VALUES(can_carry_forward)`,
        [
          params.starting_cash,
          new Date(params.date),
          params.can_carry_forward ?? false,
        ],
        (err, res) => {
          if (err) {
            reject(err);
            return;
          }
          resolve({ code: 200, id: res.insertId });
        }
      );
    });
  }

  getStartingCash(date) {
    return new Promise((resolve, reject) => {
      // First try to get the previous day's date
      this.db.query(
        `SELECT * FROM accounts_warehouse_starting_cash 
         WHERE DATE(date) = DATE_SUB(DATE(?), INTERVAL 1 DAY)`,
        [date],
        (err, previousDayDocs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.ACCOUNTS",
              code: "REPOSITORY.ACCOUNTS.GET-STARTING-CASH",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }

          // If we found a previous day match, return it
          if (previousDayDocs.length > 0) {
            resolve({
              code: 200,
              data: {
                ...previousDayDocs[0],
                is_carried_forward: false,
              },
            });
            return;
          }

          // If no previous day match, look for the latest date with can_carry_forward = true
          this.db.query(
            `SELECT * FROM accounts_warehouse_starting_cash 
             WHERE DATE(date) < DATE(?) 
             ORDER BY date DESC 
             LIMIT 1`,
            [date],
            (err, carriedForwardDocs) => {
              if (err) {
                logger.Log({
                  level: logger.LEVEL.ERROR,
                  component: "REPOSITORY.ACCOUNTS",
                  code: "REPOSITORY.ACCOUNTS.GET-STARTING-CASH-CARRIED-FORWARD",
                  description: err.toString(),
                  category: "",
                  ref: {},
                });
                reject(err);
                return;
              }

              if (
                carriedForwardDocs.length > 0 &&
                carriedForwardDocs[0].can_carry_forward
              ) {
                resolve({
                  code: 200,
                  data: {
                    ...carriedForwardDocs[0],
                    is_carried_forward: true,
                  },
                });
              } else {
                resolve({ code: 200, data: null });
              }
            }
          );
        }
      );
    });
  }

  getSalesByOutlet(filters = {}) {
    return new Promise((resolve, reject) => {
      let filterConditions = [];
      let filterValues = [];

      if (filters.from_date) {
        filterConditions.push("DATE(a.date) >= ?");
        filterValues.push(filters.from_date);
      }
      if (filters.to_date) {
        filterConditions.push("DATE(a.date) <= ?");
        filterValues.push(filters.to_date);
      }

      const whereClause =
        filterConditions.length > 0
          ? `WHERE ${filterConditions.join(" AND ")}`
          : "";

      this.db.query(
        `SELECT 
          a.store_id,
          o.outlet_name,
          JSON_ARRAYAGG(
            JSON_OBJECT(
              'accounts_id', IFNULL(a.accounts_id, ''),
              'date', DATE_FORMAT(a.date, '%Y-%m-%d'),
              'no_of_bills', IFNULL(a.no_of_bills, 0),
              'total_sales', IFNULL(a.total_sales, 0),
              'card_sales', IFNULL(a.card_sales, 0),
              'loyalty', IFNULL(a.loyalty, 0),
              'sales_return', IFNULL(a.sales_return, 0),
              'cashier_name', IFNULL(ne.employee_name, ''),
              'sales', IFNULL(
                (
                  SELECT JSON_ARRAYAGG(
                    JSON_OBJECT(
                      'sales_id', s.sales_id,
                      'person_type', s.person_type,
                      'payment_type', s.payment_type,
                      'person_id', s.person_id,
                      'person_name', IFNULL(pl.name, ''),
                      'description', IFNULL(s.description, ''),
                      'amount', IFNULL(s.amount, 0),
                      'receipt_path', IFNULL(s.receipt_path, ''),
                      'is_checked', s.is_checked
                    )
                  )
                  FROM accounts_sales s
                  LEFT JOIN people_list pl ON pl.person_id = s.person_id
                  WHERE s.accounts_id = a.accounts_id
                ),
                JSON_ARRAY()
              )
            )
          ) as accounts
         FROM accounts a
         LEFT JOIN new_employee ne ON ne.employee_id = a.cashier_id
         LEFT JOIN outlets o ON o.outlet_id = a.store_id
         ${whereClause}
         GROUP BY a.store_id, o.outlet_name
         ORDER BY a.store_id`,
        filterValues,
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.ACCOUNTS",
              code: "REPOSITORY.ACCOUNTS.GET-SALES-BY-OUTLET",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }

          // Parse the JSON strings and handle null values
          const formattedDocs = docs.map((doc) => ({
            store_id: doc.store_id || null,
            outlet_name: doc.outlet_name || "",
            accounts: doc.accounts ? JSON.parse(doc.accounts) : [],
          }));

          resolve({
            code: 200,
            data: formattedDocs,
          });
        }
      );
    });
  }
}

module.exports = (db) => {
  return new AccountsRepository(db);
};
