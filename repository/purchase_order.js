const logger = require("../utils/logger");

class PurchaseOrderRepository {
  constructor(db) {
    this.db = db;
  }

  // Create purchase order
  createPurchaseOrder(purchaseOrder) {
    return new Promise((resolve, reject) => {
      let query, params;

      if (purchaseOrder.purchase_order_id) {
        // If purchase_order_id is provided, include it in the INSERT
        query = `INSERT INTO purchase_order (
          purchase_order_id, purchase_order_ref, vendor_id, date, delivery_date, discount, adjustment, tax, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        params = [
          purchaseOrder.purchase_order_id,
          purchaseOrder.purchase_order_ref,
          purchaseOrder.vendor_id,
          purchaseOrder.date,
          purchaseOrder.delivery_date,
          purchaseOrder.discount || 0.0,
          purchaseOrder.adjustment || 0.0,
          purchaseOrder.tax || 0.0,
          purchaseOrder.status || "active",
        ];
      } else {
        // If purchase_order_id is not provided, let MySQL auto-generate
        query = `INSERT INTO purchase_order (
          purchase_order_ref, vendor_id, date, delivery_date, discount, adjustment, tax, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
        params = [
          purchaseOrder.purchase_order_ref,
          purchaseOrder.vendor_id,
          purchaseOrder.date,
          purchaseOrder.delivery_date,
          purchaseOrder.discount || 0.0,
          purchaseOrder.adjustment || 0.0,
          purchaseOrder.tax || 0.0,
          purchaseOrder.status || "active",
        ];
      }

      this.db.query(query, params, (err, res) => {
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
          id: purchaseOrder.purchase_order_id || res.insertId,
        });
      });
    });
  }

  // Helper functions for calculations
  calculateSubTotal(items = []) {
    return items.reduce(
      (sum, item) =>
        sum + parseFloat(item.quantity || 0) * parseFloat(item.rate || 0),
      0
    );
  }

  calculateDiscountAmount(subTotal, discountPercent) {
    return subTotal * (parseFloat(discountPercent || 0) / 100);
  }

  calculateTaxAmount(subTotal, taxPercent) {
    return subTotal * (parseFloat(taxPercent || 0) / 100);
  }

  calculateAdjustment(adjustment) {
    return parseFloat(adjustment || 0);
  }

  calculateTotal(subTotal, discount, tax, adjustment) {
    return subTotal - discount + tax + adjustment;
  }

  // Get all purchase orders with optional filters
  getAllPurchaseOrders(filters = {}) {
    return new Promise((resolve, reject) => {
      let query = `
        SELECT po.*, 
               COUNT(poi.purchase_order_item_id) as item_count,
               pl.name as vendor_name,
               pl.primary_phone as vendor_phone
        FROM purchase_order po
        LEFT JOIN purchase_order_items poi ON po.purchase_order_id = poi.purchase_order_id
        LEFT JOIN people_list pl ON po.vendor_id = pl.person_id
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

        // Calculate totals using JavaScript for each purchase order
        const calculateTotalsForPurchaseOrder = async (po) => {
          try {
            // Fetch items for this purchase order
            const items = await this.getPurchaseOrderItems(
              po.purchase_order_id
            );

            const subTotal = this.calculateSubTotal(items);
            const discountAmount = this.calculateDiscountAmount(
              subTotal,
              po.discount
            );
            const taxAmount = this.calculateTaxAmount(subTotal, po.tax);
            const adjustment = this.calculateAdjustment(po.adjustment);
            const total = this.calculateTotal(
              subTotal,
              discountAmount,
              taxAmount,
              adjustment
            );

            return {
              ...po,
              subtotal: subTotal,
              discount_amount: discountAmount,
              tax_amount: taxAmount,
              adjustment_amount: adjustment,
              total_amount: total,
              item_count: items.length,
            };
          } catch (error) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PURCHASE_ORDER",
              code: "REPOSITORY.PURCHASE_ORDER.GET_ALL.CALCULATE_TOTALS",
              description: error.toString(),
              category: "",
              ref: { purchase_order_id: po.purchase_order_id },
            });
            // Return purchase order without calculated totals if there's an error
            return {
              ...po,
              subtotal: 0,
              discount_amount: 0,
              tax_amount: 0,
              adjustment_amount: 0,
              total_amount: 0,
              item_count: 0,
            };
          }
        };

        // Process all purchase orders with their totals
        Promise.all(docs.map(calculateTotalsForPurchaseOrder))
          .then((purchaseOrdersWithTotals) => {
            resolve(purchaseOrdersWithTotals);
          })
          .catch((error) => {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PURCHASE_ORDER",
              code: "REPOSITORY.PURCHASE_ORDER.GET_ALL",
              description: error.toString(),
              category: "",
              ref: {},
            });
            reject(error);
          });
      });
    });
  }

  // Get purchase order by ID
  getPurchaseOrderById(purchaseOrderId) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT po.*, 
               pl.name as vendor_name,
               pl.primary_phone as vendor_phone
         FROM purchase_order po
         LEFT JOIN people_list pl ON po.vendor_id = pl.person_id
         WHERE po.purchase_order_id = ?`,
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
          purchase_order_ref = ?, vendor_id = ?, date = ?, delivery_date = ?, 
          discount = ?, adjustment = ?, tax = ?, status = ?
        WHERE purchase_order_id = ?`,
        [
          purchaseOrder.purchase_order_ref,
          purchaseOrder.vendor_id,
          purchaseOrder.date,
          purchaseOrder.delivery_date,
          purchaseOrder.discount || 0.0,
          purchaseOrder.adjustment || 0.0,
          purchaseOrder.tax || 0.0,
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
          purchase_order_id, material_id, quantity, rate, stock
        ) VALUES (?, ?, ?, ?, ?)`,
        [
          purchaseOrderItem.purchase_order_id,
          purchaseOrderItem.material_id,
          purchaseOrderItem.quantity,
          purchaseOrderItem.rate,
          purchaseOrderItem.stock || 0,
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
          material_id = ?, quantity = ?, rate = ?, stock = ?
        WHERE purchase_order_item_id = ?`,
        [
          purchaseOrderItem.material_id,
          purchaseOrderItem.quantity,
          purchaseOrderItem.rate,
          purchaseOrderItem.stock || 0,
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
               poi.stock,
               m.name as material_name,
               m.description as material_description,
               pl.name as vendor_name,
               pl.primary_phone as vendor_phone
         FROM purchase_order po
         LEFT JOIN purchase_order_items poi ON po.purchase_order_id = poi.purchase_order_id
         LEFT JOIN materials_latest m ON poi.material_id = m.material_id
         LEFT JOIN people_list pl ON po.vendor_id = pl.person_id
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
            vendor_id: docs[0].vendor_id,
            date: docs[0].date,
            delivery_date: docs[0].delivery_date,
            discount: docs[0].discount,
            adjustment: docs[0].adjustment,
            tax: docs[0].tax,
            status: docs[0].status,
            created_at: docs[0].created_at,
            updated_at: docs[0].updated_at,
            vendor_name: docs[0].vendor_name,
            vendor_phone: docs[0].vendor_phone,
            items: [],
          };

          docs.forEach((row) => {
            if (row.purchase_order_item_id) {
              purchaseOrder.items.push({
                purchase_order_item_id: row.purchase_order_item_id,
                material_id: row.material_id,
                quantity: row.quantity,
                rate: row.rate,
                stock: row.stock,
                material_name: row.material_name,
                material_description: row.material_description,
              });
            }
          });

          // Calculate totals using JavaScript
          const subTotal = this.calculateSubTotal(purchaseOrder.items);
          const discountAmount = this.calculateDiscountAmount(
            subTotal,
            purchaseOrder.discount
          );
          const taxAmount = this.calculateTaxAmount(
            subTotal,
            purchaseOrder.tax
          );
          const adjustment = this.calculateAdjustment(purchaseOrder.adjustment);
          const total = this.calculateTotal(
            subTotal,
            discountAmount,
            taxAmount,
            adjustment
          );

          // Add calculated fields to the purchase order
          purchaseOrder.subtotal = subTotal;
          purchaseOrder.discount_amount = discountAmount;
          purchaseOrder.tax_amount = taxAmount;
          purchaseOrder.adjustment_amount = adjustment;
          purchaseOrder.total_amount = total;

          resolve(purchaseOrder);
        }
      );
    });
  }
}

module.exports = (db) => {
  return new PurchaseOrderRepository(db);
};
