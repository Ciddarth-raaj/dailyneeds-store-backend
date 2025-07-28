class PurchaseOrderUsecase {
  constructor(purchaseOrderRepo) {
    this.purchaseOrderRepo = purchaseOrderRepo;
  }

  // Create purchase order
  async createPurchaseOrder(purchaseOrder) {
    try {
      const result = await this.purchaseOrderRepo.createPurchaseOrder(
        purchaseOrder
      );
      return result;
    } catch (error) {
      throw error;
    }
  }

  // Get all purchase orders
  async getAllPurchaseOrders(filters) {
    try {
      const result = await this.purchaseOrderRepo.getAllPurchaseOrders(filters);
      return result;
    } catch (error) {
      throw error;
    }
  }

  // Get purchase order by ID
  async getPurchaseOrderById(purchaseOrderId) {
    try {
      const result = await this.purchaseOrderRepo.getPurchaseOrderById(
        purchaseOrderId
      );
      return result;
    } catch (error) {
      throw error;
    }
  }

  // Get purchase order with items
  async getPurchaseOrderWithItems(purchaseOrderId) {
    try {
      const result = await this.purchaseOrderRepo.getPurchaseOrderWithItems(
        purchaseOrderId
      );
      return result;
    } catch (error) {
      throw error;
    }
  }

  // Update purchase order
  async updatePurchaseOrder(purchaseOrderId, purchaseOrder) {
    try {
      const result = await this.purchaseOrderRepo.updatePurchaseOrder(
        purchaseOrderId,
        purchaseOrder
      );
      return result;
    } catch (error) {
      throw error;
    }
  }

  // Delete purchase order
  async deletePurchaseOrder(purchaseOrderId) {
    try {
      const result = await this.purchaseOrderRepo.deletePurchaseOrder(
        purchaseOrderId
      );
      return result;
    } catch (error) {
      throw error;
    }
  }

  // Create purchase order item
  async createPurchaseOrderItem(purchaseOrderItem) {
    try {
      const result = await this.purchaseOrderRepo.createPurchaseOrderItem(
        purchaseOrderItem
      );
      return result;
    } catch (error) {
      throw error;
    }
  }

  // Get purchase order items
  async getPurchaseOrderItems(purchaseOrderId) {
    try {
      const result = await this.purchaseOrderRepo.getPurchaseOrderItems(
        purchaseOrderId
      );
      return result;
    } catch (error) {
      throw error;
    }
  }

  // Update purchase order item
  async updatePurchaseOrderItem(itemId, purchaseOrderItem) {
    try {
      const result = await this.purchaseOrderRepo.updatePurchaseOrderItem(
        itemId,
        purchaseOrderItem
      );
      return result;
    } catch (error) {
      throw error;
    }
  }

  // Delete purchase order item
  async deletePurchaseOrderItem(itemId) {
    try {
      const result = await this.purchaseOrderRepo.deletePurchaseOrderItem(
        itemId
      );
      return result;
    } catch (error) {
      throw error;
    }
  }

  // Create purchase order with items
  async createPurchaseOrderWithItems(purchaseOrderData) {
    try {
      const { items, ...purchaseOrder } = purchaseOrderData;

      // Create the purchase order first
      const purchaseOrderResult =
        await this.purchaseOrderRepo.createPurchaseOrder(purchaseOrder);

      if (items && items.length > 0) {
        // Create items for the purchase order
        const itemPromises = items.map((item) => {
          return this.purchaseOrderRepo.createPurchaseOrderItem({
            ...item,
            purchase_order_id: purchaseOrderResult.id,
          });
        });

        await Promise.all(itemPromises);
      }

      return purchaseOrderResult;
    } catch (error) {
      throw error;
    }
  }

  // Update purchase order with items
  async updatePurchaseOrderWithItems(purchaseOrderId, purchaseOrderData) {
    try {
      const { items, ...purchaseOrder } = purchaseOrderData;

      // Update the purchase order
      await this.purchaseOrderRepo.updatePurchaseOrder(
        purchaseOrderId,
        purchaseOrder
      );

      if (items) {
        // Delete existing items
        const existingItems =
          await this.purchaseOrderRepo.getPurchaseOrderItems(purchaseOrderId);
        for (const item of existingItems) {
          await this.purchaseOrderRepo.deletePurchaseOrderItem(
            item.purchase_order_item_id
          );
        }

        // Create new items
        if (items.length > 0) {
          const itemPromises = items.map((item) => {
            return this.purchaseOrderRepo.createPurchaseOrderItem({
              ...item,
              purchase_order_id: purchaseOrderId,
            });
          });

          await Promise.all(itemPromises);
        }
      }

      return { code: 200, message: "Purchase order updated successfully" };
    } catch (error) {
      throw error;
    }
  }
}

module.exports = (purchaseOrderRepo) => {
  return new PurchaseOrderUsecase(purchaseOrderRepo);
};
