const PDFService = require("../services/pdf");
const S3 = require("../services/s3");
const logger = require("../utils/logger");
const Telegram = require("../services/telegram")();
const { ALERTS_TELEGRAM_CHAT_ID } = require("../constants/telegram");

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

  // Generate PDF for purchase order
  async generatePurchaseOrderPDF(purchaseOrderId, telegramOptions = {}) {
    try {
      // Get purchase order with items
      const purchaseOrder =
        await this.purchaseOrderRepo.getPurchaseOrderWithItems(purchaseOrderId);

      if (!purchaseOrder) {
        throw new Error("Purchase order not found");
      }

      // Generate PDF
      const pdfBuffer = await PDFService.generatePurchaseOrderPDF(
        purchaseOrder
      );

      // Upload to S3
      const fileName = `purchase_orders/PO_${purchaseOrderId}_${Date.now()}.pdf`;
      const s3Url = await S3.uploadFile(
        undefined,
        fileName,
        "application/pdf",
        pdfBuffer
      );

      // Update purchase order with PDF URL
      await this.purchaseOrderRepo.updatePurchaseOrderPDF(
        purchaseOrderId,
        s3Url
      );

      // Send to Telegram if requested
      const chat_id = telegramOptions.chat_id || ALERTS_TELEGRAM_CHAT_ID;
      if (telegramOptions.send_to_telegram) {
        try {
          await Telegram.sendDocument(chat_id, s3Url);
          const detailsMessage = `Purchase Order #${purchaseOrderId}\nVendor: ${
            purchaseOrder.vendor_name || "N/A"
          }\nTotal: ₹${(purchaseOrder.total_amount || 0).toFixed(2)}`;
          await Telegram.sendMessage(chat_id, detailsMessage);
          await Telegram.sendMessage(chat_id, "Approve this order?", {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: "Approve",
                    callback_data: `approve_po_${purchaseOrderId}`,
                  },
                  {
                    text: "View",
                    url: `http://dnds.co.in/purchase-order/view?id=${purchaseOrderId}`,
                  },
                ],
              ],
            },
          });
        } catch (err) {
          logger.Log({
            level: logger.LEVEL.WARN,
            component: "USECASE.PURCHASE_ORDER",
            code: "USECASE.PURCHASE_ORDER.SEND_TELEGRAM",
            description: `Telegram send failed: ${err.toString()}`,
            category: "",
            ref: { purchase_order_id: purchaseOrderId, chat_id },
          });
        }
      }

      return {
        code: 200,
        message: "PDF generated and uploaded successfully",
        pdf_url: s3Url,
      };
    } catch (error) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.PURCHASE_ORDER",
        code: "USECASE.PURCHASE_ORDER.GENERATE_PDF",
        description: error.toString(),
        category: "",
        ref: { purchase_order_id: purchaseOrderId },
      });
      throw error;
    }
  }

  // Create purchase order with PDF generation
  async createPurchaseOrderWithPDF(purchaseOrderData) {
    try {
      const { should_generate_pdf, ...purchaseOrder } = purchaseOrderData;

      // Create the purchase order
      const result = await this.createPurchaseOrderWithItems(purchaseOrder);

      // Generate PDF if requested
      if (should_generate_pdf && result.id) {
        try {
          await this.generatePurchaseOrderPDF(result.id, {
            send_to_telegram: true,
          });
        } catch (pdfError) {
          logger.Log({
            level: logger.LEVEL.WARN,
            component: "USECASE.PURCHASE_ORDER",
            code: "USECASE.PURCHASE_ORDER.CREATE_WITH_PDF",
            description: `PDF generation failed: ${pdfError.toString()}`,
            category: "",
            ref: { purchase_order_id: result.id },
          });
          // Don't fail the entire operation if PDF generation fails
        }
      }

      return result;
    } catch (error) {
      throw error;
    }
  }

  // Update purchase order with PDF generation
  async updatePurchaseOrderWithPDF(purchaseOrderId, purchaseOrderData) {
    try {
      const { should_generate_pdf, ...purchaseOrder } = purchaseOrderData;

      // Update the purchase order
      const result = await this.updatePurchaseOrderWithItems(
        purchaseOrderId,
        purchaseOrder
      );

      // Generate PDF if requested
      if (should_generate_pdf) {
        try {
          await this.generatePurchaseOrderPDF(purchaseOrderId, {
            send_to_telegram: true,
          });
        } catch (pdfError) {
          logger.Log({
            level: logger.LEVEL.WARN,
            component: "USECASE.PURCHASE_ORDER",
            code: "USECASE.PURCHASE_ORDER.UPDATE_WITH_PDF",
            description: `PDF generation failed: ${pdfError.toString()}`,
            category: "",
            ref: { purchase_order_id: purchaseOrderId },
          });
          // Don't fail the entire operation if PDF generation fails
        }
      }

      return result;
    } catch (error) {
      throw error;
    }
  }
}

module.exports = (purchaseOrderRepo) => {
  return new PurchaseOrderUsecase(purchaseOrderRepo);
};
