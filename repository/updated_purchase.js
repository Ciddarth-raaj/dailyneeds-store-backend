const logger = require("../utils/logger");

const TABLE = "updated_purchase";
const INTERNAL_TABLE = "updated_purchase_internal";

class UpdatedPurchaseRepository {
  constructor(db) {
    this.db = db;
  }

  upsertFromTally(purchase_id, { purchase = {}, internal = {} }) {
    return new Promise(async (resolve, reject) => {
      try {
        const purchaseFields = Object.keys(purchase).filter(
          (k) => purchase[k] !== undefined
        );
        if (purchaseFields.length > 0) {
          const cols = ["purchase_id", ...purchaseFields];
          const placeholders = cols.map(() => "?").join(", ");
          const updates = purchaseFields.map((k) => `${k} = VALUES(${k})`).join(", ");
          const values = [purchase_id, ...purchaseFields.map((k) => purchase[k])];
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
          await new Promise((res, rej) => {
            this.db.query(
              `INSERT IGNORE INTO ${TABLE} (purchase_id) VALUES (?)`,
              [purchase_id],
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
