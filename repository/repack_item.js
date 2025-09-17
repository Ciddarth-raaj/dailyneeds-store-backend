const logger = require("../utils/logger");

class RepackItemRepository {
  constructor(db) {
    this.db = db;
  }

  create(repackItem) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `INSERT INTO repack_items_master (item_id, cleaning, packing_type, packing_material, packing_material_size, sticker, created_at, updated_at) 
         VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())
         ON DUPLICATE KEY UPDATE 
         cleaning = VALUES(cleaning),
         packing_type = VALUES(packing_type),
         packing_material = VALUES(packing_material),
         packing_material_size = VALUES(packing_material_size),
         sticker = VALUES(sticker),
         updated_at = NOW()`,
        [
          repackItem.item_id,
          repackItem.cleaning,
          repackItem.packing_type,
          repackItem.packing_material,
          repackItem.packing_material_size,
          repackItem.sticker
        ],
        (err, result) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPACK_ITEM_REPOSITORY",
              code: "REPACK_ITEM.CREATE.ERROR",
              description: err.message,
              category: "",
              ref: repackItem,
            });
            reject(err);
          } else {
            resolve({ code: 200, msg: "Repack item created/updated successfully", item_id: repackItem.item_id });
          }
        }
      );
    });
  }

  getByItemId(item_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT rim.*, pt.product_id as item_id, pt.de_display_name, pt.measure 
         FROM repack_items_master rim
         RIGHT JOIN product_table pt ON pt.product_id = rim.item_id
         WHERE rim.item_id = ? AND pt.de_preparation_type = 'R' AND pt.gf_status = 'R'`,
        [item_id],
        (err, result) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPACK_ITEM_REPOSITORY",
              code: "REPACK_ITEM.GET_BY_ITEM_ID.ERROR",
              description: err.message,
              category: "",
              ref: { item_id },
            });
            reject(err);
          } else {
            resolve(result[0] || null);
          }
        }
      );
    });
  }

  getAll(limit = 100, offset = 0) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT rim.*, pt.product_id as item_id, pt.de_display_name, pt.measure 
         FROM repack_items_master rim
         RIGHT JOIN product_table pt ON pt.product_id = rim.item_id
         WHERE pt.de_preparation_type = 'R' AND pt.gf_status = 'R'
         ORDER BY rim.created_at DESC LIMIT ? OFFSET ?`,
        [limit, offset],
        (err, result) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPACK_ITEM_REPOSITORY",
              code: "REPACK_ITEM.GET_ALL.ERROR",
              description: err.message,
              category: "",
              ref: { limit, offset },
            });
            reject(err);
          } else {
            resolve(result);
          }
        }
      );
    });
  }

  update(item_id, repackItem) {
    return new Promise((resolve, reject) => {
      const updateFields = [];
      const values = [];

      if (repackItem.cleaning !== undefined) {
        updateFields.push("cleaning = ?");
        values.push(repackItem.cleaning);
      }
      if (repackItem.packing_type !== undefined) {
        updateFields.push("packing_type = ?");
        values.push(repackItem.packing_type);
      }
      if (repackItem.packing_material !== undefined) {
        updateFields.push("packing_material = ?");
        values.push(repackItem.packing_material);
      }
      if (repackItem.packing_material_size !== undefined) {
        updateFields.push("packing_material_size = ?");
        values.push(repackItem.packing_material_size);
      }
      if (repackItem.sticker !== undefined) {
        updateFields.push("sticker = ?");
        values.push(repackItem.sticker);
      }

      if (updateFields.length === 0) {
        resolve({ code: 400, msg: "No fields to update" });
        return;
      }

      updateFields.push("updated_at = NOW()");
      values.push(item_id);

      this.db.query(
        `UPDATE repack_items_master SET ${updateFields.join(", ")} WHERE item_id = ?`,
        values,
        (err, result) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPACK_ITEM_REPOSITORY",
              code: "REPACK_ITEM.UPDATE.ERROR",
              description: err.message,
              category: "",
              ref: { item_id, repackItem },
            });
            reject(err);
          } else {
            if (result.affectedRows === 0) {
              resolve({ code: 404, msg: "Repack item not found" });
            } else {
              resolve({ code: 200, msg: "Repack item updated successfully" });
            }
          }
        }
      );
    });
  }

  delete(item_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `DELETE FROM repack_items_master WHERE item_id = ?`,
        [item_id],
        (err, result) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPACK_ITEM_REPOSITORY",
              code: "REPACK_ITEM.DELETE.ERROR",
              description: err.message,
              category: "",
              ref: { item_id },
            });
            reject(err);
          } else {
            if (result.affectedRows === 0) {
              resolve({ code: 404, msg: "Repack item not found" });
            } else {
              resolve({ code: 200, msg: "Repack item deleted successfully" });
            }
          }
        }
      );
    });
  }

  getCount() {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT COUNT(*) as count 
         FROM repack_items_master rim
         RIGHT JOIN product_table pt ON pt.product_id = rim.item_id
         WHERE pt.de_preparation_type = 'R' AND pt.gf_status = 'R'`,
        [],
        (err, result) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPACK_ITEM_REPOSITORY",
              code: "REPACK_ITEM.GET_COUNT.ERROR",
              description: err.message,
              category: "",
              ref: {},
            });
            reject(err);
          } else {
            resolve(result[0].count);
          }
        }
      );
    });
  }
}

module.exports = (db) => new RepackItemRepository(db);
