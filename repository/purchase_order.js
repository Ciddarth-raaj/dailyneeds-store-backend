const logger = require("../utils/logger");

class PurchaseOrderRepository {
  constructor(db) {
    this.db = db;
  }

  // Create purchase order
  createPurchaseOrder(purchaseOrder) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `INSERT INTO purchase_order (
          purchase_order_ref, date, delivery_date, discount, adjustment, status
        ) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          purchaseOrder.purchase_order_ref,
          purchaseOrder.date,
          purchaseOrder.delivery_date,
          purchaseOrder.discount || 0.0,
          purchaseOrder.adjustment || 0.0,
          purchaseOrder.status || "active",
        ],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PURCHASE_ORDER",
              code: "REPOSITORY.PURCHASE_ORDER.CREATE",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve({
            code: 200,
            id: res.insertId,
          });
        }
      );
    });
  }

  // Get all purchase orders with optional filters
  getAllPurchaseOrders(filters = {}) {
    return new Promise((resolve, reject) => {
      let query = `
        SELECT po.*, 
               COUNT(poi.purchase_order_item_id) as item_count,
               SUM(poi.quantity * poi.rate) as total_amount
        FROM purchase_order po
        LEFT JOIN purchase_order_items poi ON po.purchase_order_id = poi.purchase_order_id
      `;

      const conditions = [];
      const params = [];

      if (filters.status) {
        conditions.push("po.status = ?");
        params.push(filters.status);
      }

      if (filters.date_from) {
        conditions.push("po.date >= ?");
        params.push(filters.date_from);
      }

      if (filters.date_to) {
        conditions.push("po.date <= ?");
        params.push(filters.date_to);
      }

      if (filters.purchase_order_ref) {
        conditions.push("po.purchase_order_ref LIKE ?");
        params.push(`%${filters.purchase_order_ref}%`);
      }

      if (conditions.length > 0) {
        query += " WHERE " + conditions.join(" AND ");
      }

      query += " GROUP BY po.purchase_order_id ORDER BY po.created_at DESC";

      if (filters.limit) {
        query += " LIMIT ?";
        params.push(filters.limit);
      }

      if (filters.offset) {
        query += " OFFSET ?";
        params.push(filters.offset);
      }

      this.db.query(query, params, (err, docs) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.PURCHASE_ORDER",
            code: "REPOSITORY.PURCHASE_ORDER.GET_ALL",
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

  // Get purchase order by ID
  getPurchaseOrderById(purchaseOrderId) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT * FROM purchase_order WHERE purchase_order_id = ?`,
        [purchaseOrderId],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PURCHASE_ORDER",
              code: "REPOSITORY.PURCHASE_ORDER.GET_BY_ID",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve(docs[0]);
        }
      );
    });
  }

  // Update purchase order
  updatePurchaseOrder(purchaseOrderId, purchaseOrder) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `UPDATE purchase_order SET
          purchase_order_ref = ?, date = ?, delivery_date = ?, 
          discount = ?, adjustment = ?, status = ?
        WHERE purchase_order_id = ?`,
        [
          purchaseOrder.purchase_order_ref,
          purchaseOrder.date,
          purchaseOrder.delivery_date,
          purchaseOrder.discount || 0.0,
          purchaseOrder.adjustment || 0.0,
          purchaseOrder.status || "active",
          purchaseOrderId,
        ],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PURCHASE_ORDER",
              code: "REPOSITORY.PURCHASE_ORDER.UPDATE",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve({
            code: 200,
            affectedRows: res.affectedRows,
          });
        }
      );
    });
  }

  // Delete purchase order
  deletePurchaseOrder(purchaseOrderId) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `DELETE FROM purchase_order WHERE purchase_order_id = ?`,
        [purchaseOrderId],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PURCHASE_ORDER",
              code: "REPOSITORY.PURCHASE_ORDER.DELETE",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve({
            code: 200,
            affectedRows: res.affectedRows,
          });
        }
      );
    });
  }

  // Create purchase order item
  createPurchaseOrderItem(purchaseOrderItem) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `INSERT INTO purchase_order_items (
          purchase_order_id, material_id, quantity, rate
        ) VALUES (?, ?, ?, ?)`,
        [
          purchaseOrderItem.purchase_order_id,
          purchaseOrderItem.material_id,
          purchaseOrderItem.quantity,
          purchaseOrderItem.rate,
        ],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PURCHASE_ORDER",
              code: "REPOSITORY.PURCHASE_ORDER.CREATE_ITEM",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve({
            code: 200,
            id: res.insertId,
          });
        }
      );
    });
  }

  // Get purchase order items by purchase order ID
  getPurchaseOrderItems(purchaseOrderId) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT poi.*, m.name as material_name, m.description as material_description 
         FROM purchase_order_items poi
         LEFT JOIN materials_latest m ON poi.material_id = m.material_id
         WHERE poi.purchase_order_id = ?`,
        [purchaseOrderId],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PURCHASE_ORDER",
              code: "REPOSITORY.PURCHASE_ORDER.GET_ITEMS",
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

  // Update purchase order item
  updatePurchaseOrderItem(itemId, purchaseOrderItem) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `UPDATE purchase_order_items SET
          material_id = ?, quantity = ?, rate = ?
        WHERE purchase_order_item_id = ?`,
        [
          purchaseOrderItem.material_id,
          purchaseOrderItem.quantity,
          purchaseOrderItem.rate,
          itemId,
        ],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PURCHASE_ORDER",
              code: "REPOSITORY.PURCHASE_ORDER.UPDATE_ITEM",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve({
            code: 200,
            affectedRows: res.affectedRows,
          });
        }
      );
    });
  }

  // Delete purchase order item
  deletePurchaseOrderItem(itemId) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `DELETE FROM purchase_order_items WHERE purchase_order_item_id = ?`,
        [itemId],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PURCHASE_ORDER",
              code: "REPOSITORY.PURCHASE_ORDER.DELETE_ITEM",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve({
            code: 200,
            affectedRows: res.affectedRows,
          });
        }
      );
    });
  }

  // Get purchase order with items
  getPurchaseOrderWithItems(purchaseOrderId) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT po.*, 
               poi.purchase_order_item_id,
               poi.material_id,
               poi.quantity,
               poi.rate,
               m.name as material_name,
               m.description as material_description
         FROM purchase_order po
         LEFT JOIN purchase_order_items poi ON po.purchase_order_id = poi.purchase_order_id
         LEFT JOIN materials_latest m ON poi.material_id = m.material_id
         WHERE po.purchase_order_id = ?`,
        [purchaseOrderId],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PURCHASE_ORDER",
              code: "REPOSITORY.PURCHASE_ORDER.GET_WITH_ITEMS",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }

          if (docs.length === 0) {
            resolve(null);
            return;
          }

          const purchaseOrder = {
            purchase_order_id: docs[0].purchase_order_id,
            purchase_order_ref: docs[0].purchase_order_ref,
            date: docs[0].date,
            delivery_date: docs[0].delivery_date,
            discount: docs[0].discount,
            adjustment: docs[0].adjustment,
            status: docs[0].status,
            created_at: docs[0].created_at,
            updated_at: docs[0].updated_at,
            items: [],
          };

          docs.forEach((row) => {
            if (row.purchase_order_item_id) {
              purchaseOrder.items.push({
                purchase_order_item_id: row.purchase_order_item_id,
                material_id: row.material_id,
                quantity: row.quantity,
                rate: row.rate,
                material_name: row.material_name,
                material_description: row.material_description,
              });
            }
          });

          resolve(purchaseOrder);
        }
      );
    });
  }
}

module.exports = (db) => {
  return new PurchaseOrderRepository(db);
};
