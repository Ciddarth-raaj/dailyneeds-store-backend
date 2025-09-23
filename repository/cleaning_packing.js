const logger = require("../utils/logger");

class CleaningPackingRepository {
  constructor(db) {
    this.db = db;
  }

  create(purchaseItem) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `INSERT INTO purchase_item (
          purchase_item, purchase_item_name, article_id, article_name, 
          priority_score, repackage_conversion, planner, repack_quantity, 
          forecast_quantity, order_date, child_stock_in_hand, parent_stock, 
          store_uom, num_stores_oos, chain_bill_count_level
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          purchaseItem.purchase_item,
          purchaseItem.purchase_item_name,
          purchaseItem.article_id,
          purchaseItem.article_name,
          purchaseItem.priority_score,
          purchaseItem.repackage_conversion,
          purchaseItem.planner,
          purchaseItem.repack_quantity,
          purchaseItem.forecast_quantity,
          purchaseItem.order_date,
          purchaseItem.child_stock_in_hand,
          purchaseItem.parent_stock,
          purchaseItem.store_uom,
          purchaseItem.num_stores_oos,
          purchaseItem.chain_bill_count_level,
        ],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.CLEANING_PACKING",
              code: "REPOSITORY.CLEANING_PACKING.CREATE",
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

  getAll(filters = {}) {
    return new Promise((resolve, reject) => {
      let query = `
        SELECT 
          pi.*,
          rim.*,
          pi.created_at
        FROM purchase_item pi
        LEFT JOIN repack_items_master rim ON pi.article_id = rim.item_id
      `;

      const params = [];
      const whereConditions = [];

      // Date filter
      if (filters.date) {
        whereConditions.push(`DATE(pi.order_date) = ?`);
        params.push(filters.date);
      }

      // Cleaning filter
      if (filters.cleaning !== undefined && filters.cleaning !== null) {
        whereConditions.push(`rim.cleaning = ?`);
        params.push(filters.cleaning);
      }

      // Packing type filter
      if (filters.packing_type !== undefined && filters.packing_type !== null) {
        whereConditions.push(`rim.packing_type = ?`);
        params.push(filters.packing_type);
      }

      // Packing material filter
      if (
        filters.packing_material !== undefined &&
        filters.packing_material !== null
      ) {
        whereConditions.push(`rim.packing_material = ?`);
        params.push(filters.packing_material);
      }

      // Packing material size filter
      if (
        filters.packing_material_size !== undefined &&
        filters.packing_material_size !== null
      ) {
        whereConditions.push(`rim.packing_material_size = ?`);
        params.push(filters.packing_material_size);
      }

      // Sticker filter
      if (filters.sticker !== undefined && filters.sticker !== null) {
        whereConditions.push(`rim.sticker = ?`);
        params.push(filters.sticker);
      }

      if (whereConditions.length > 0) {
        query += ` WHERE ${whereConditions.join(" AND ")}`;
      }

      query += ` ORDER BY 
          pi.num_stores_oos DESC,
          pi.chain_bill_count_level ASC,
          pi.priority_score DESC,
          CASE 
            WHEN pi.planner = 'mass' THEN 1
            WHEN pi.planner = 'jit' THEN 2
            ELSE 3
          END`;

      this.db.query(query, params, (err, docs) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.CLEANING_PACKING",
            code: "REPOSITORY.CLEANING_PACKING.GETALL",
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

  deleteAll() {
    return new Promise((resolve, reject) => {
      this.db.query(`TRUNCATE TABLE purchase_item`, [], (err, docs) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.CLEANING_PACKING",
            code: "REPOSITORY.CLEANING_PACKING.DELETEALL",
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
}

module.exports = (db) => {
  return new CleaningPackingRepository(db);
};
