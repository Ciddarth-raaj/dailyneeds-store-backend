const logger = require("../utils/logger");

const TABLE = "updated_purchase";
const INTERNAL_TABLE = "updated_purchase_internal";

const FIELDS_FROM_PURCHASE = [
  "retail_outlet_id",
  "supplier_id",
  "supplier_name",
  "supplier_gstn",
];

class UpdatedPurchaseRepository {
  constructor(db) {
    this.db = db;
  }

  deleteByPurchaseId(purchase_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `DELETE FROM ${INTERNAL_TABLE} WHERE purchase_id = ?`,
        [purchase_id],
        (err) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.UPDATED_PURCHASE",
              code: "REPOSITORY.UPDATED_PURCHASE.DELETE",
              description: err.toString(),
              category: "",
              ref: { purchase_id },
            });
            return reject(err);
          }
          this.db.query(
            `DELETE FROM ${TABLE} WHERE purchase_id = ?`,
            [purchase_id],
            (err2) => {
              if (err2) {
                logger.Log({
                  level: logger.LEVEL.ERROR,
                  component: "REPOSITORY.UPDATED_PURCHASE",
                  code: "REPOSITORY.UPDATED_PURCHASE.DELETE",
                  description: err2.toString(),
                  category: "",
                  ref: { purchase_id },
                });
                return reject(err2);
              }
              resolve();
            }
          );
        }
      );
    });
  }

  _loadSupplierFromPurchase(purchase_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT retail_outlet_id, supplier_id, supplier_name, supplier_gstn
         FROM purchase
         WHERE purchase_id = ?`,
        [purchase_id],
        (err, rows) => {
          if (err) return reject(err);
          resolve(rows && rows[0] ? rows[0] : {});
        }
      );
    });
  }

  _applySupplierFromPurchase(purchase, fromPurchase) {
    const merged = { ...purchase };
    for (const key of FIELDS_FROM_PURCHASE) {
      if (fromPurchase[key] !== undefined) {
        merged[key] = fromPurchase[key];
      }
    }
    return merged;
  }

  upsertFromTally(purchase_id, { purchase = {}, internal = {} }) {
    return new Promise(async (resolve, reject) => {
      try {
        const fromPurchase = await this._loadSupplierFromPurchase(purchase_id);
        const purchaseRow = this._applySupplierFromPurchase(
          purchase,
          fromPurchase
        );

        const purchaseFields = Object.keys(purchaseRow).filter(
          (k) => purchaseRow[k] !== undefined
        );
        if (purchaseFields.length > 0) {
          const cols = ["purchase_id", ...purchaseFields];
          const placeholders = cols.map(() => "?").join(", ");
          const updates = purchaseFields.map((k) => `${k} = VALUES(${k})`).join(", ");
          const values = [purchase_id, ...purchaseFields.map((k) => purchaseRow[k])];
          await new Promise((res, rej) => {
            this.db.query(
              `INSERT INTO ${TABLE} (${cols.join(", ")})
               VALUES (${placeholders})
               ON DUPLICATE KEY UPDATE ${updates}, updated_at = CURRENT_TIMESTAMP`,
              values,
              (e) => (e ? rej(e) : res())
            );
          });
        } else {
          const cols = ["purchase_id", "retail_outlet_id"];
          const values = [
            purchase_id,
            fromPurchase.retail_outlet_id ?? null,
          ];
          await new Promise((res, rej) => {
            this.db.query(
              `INSERT INTO ${TABLE} (${cols.join(", ")})
               VALUES (?, ?)
               ON DUPLICATE KEY UPDATE
                 retail_outlet_id = COALESCE(VALUES(retail_outlet_id), retail_outlet_id),
                 updated_at = CURRENT_TIMESTAMP`,
              values,
              (e) => (e ? rej(e) : res())
            );
          });
        }

        const internalFields = Object.keys(internal).filter(
          (k) => internal[k] !== undefined
        );
        if (internalFields.length > 0) {
          const cols = ["purchase_id", ...internalFields];
          const placeholders = cols.map(() => "?").join(", ");
          const updates = internalFields.map((k) => `${k} = VALUES(${k})`).join(", ");
          const values = [purchase_id, ...internalFields.map((k) => internal[k])];
          await new Promise((res, rej) => {
            this.db.query(
              `INSERT INTO ${INTERNAL_TABLE} (${cols.join(", ")})
               VALUES (${placeholders})
               ON DUPLICATE KEY UPDATE ${updates}, updated_at = CURRENT_TIMESTAMP`,
              values,
              (e) => (e ? rej(e) : res())
            );
          });
        }

        resolve({ code: 200, purchase_id });
      } catch (err) {
        logger.Log({
          level: logger.LEVEL.ERROR,
          component: "REPOSITORY.UPDATED_PURCHASE",
          code: "REPOSITORY.UPDATED_PURCHASE.UPSERT_FROM_TALLY",
          description: err.toString(),
          category: "",
          ref: { purchase_id },
        });
        reject(err);
      }
    });
  }
}

module.exports = (db) => new UpdatedPurchaseRepository(db);
