class InvoiceUsecase {
  constructor(invoiceRepo) {
    this.invoiceRepo = invoiceRepo;
  }

  // Create invoice with items in a single call
  createInvoiceWithItems(invoiceData) {
    return new Promise(async (resolve, reject) => {
      try {
        // Validate invoice data
        if (
          !invoiceData.invoice_items ||
          !Array.isArray(invoiceData.invoice_items)
        ) {
          resolve({ code: 400, msg: "Invoice items array is required" });
          return;
        }

        // Validate each invoice item
        for (const item of invoiceData.invoice_items) {
          if (!item.product_id) {
            resolve({
              code: 400,
              msg: "Product ID is required for all invoice items",
            });
            return;
          }
        }

        // Validate invoice_id if provided
        if (
          invoiceData.invoice_id &&
          (typeof invoiceData.invoice_id !== "string" ||
            invoiceData.invoice_id.trim() === "")
        ) {
          resolve({ code: 400, msg: "Invoice ID must be a non-empty string" });
          return;
        }

        const result = await this.invoiceRepo.createInvoiceWithItems(
          invoiceData
        );
        resolve(result);
      } catch (err) {
        reject(err);
      }
    });
  }

  // Get invoice with items by ID
  getInvoiceWithItems(invoiceId) {
    return new Promise(async (resolve, reject) => {
      try {
        if (!invoiceId || typeof invoiceId !== "string") {
          resolve({
            code: 400,
            msg: "Invoice ID is required and must be a string",
          });
          return;
        }

        const result = await this.invoiceRepo.getInvoiceWithItems(invoiceId);
        resolve(result);
      } catch (err) {
        reject(err);
      }
    });
  }

  // Get all invoices with pagination
  getAllInvoices(limit, offset) {
    return new Promise(async (resolve, reject) => {
      try {
        const limitValue = parseInt(limit) || 10;
        const offsetValue = parseInt(offset) || 0;

        const result = await this.invoiceRepo.getAllInvoices(
          limitValue,
          offsetValue
        );
        resolve(result);
      } catch (err) {
        reject(err);
      }
    });
  }

  // Get invoice count
  getInvoiceCount() {
    return new Promise(async (resolve, reject) => {
      try {
        const result = await this.invoiceRepo.getInvoiceCount();
        resolve(result);
      } catch (err) {
        reject(err);
      }
    });
  }

  // Update invoice with items
  updateInvoiceWithItems(invoiceId, invoiceData) {
    return new Promise(async (resolve, reject) => {
      try {
        if (!invoiceId || typeof invoiceId !== "string") {
          resolve({
            code: 400,
            msg: "Invoice ID is required and must be a string",
          });
          return;
        }

        // Validate invoice items if provided
        if (
          invoiceData.invoice_items &&
          Array.isArray(invoiceData.invoice_items)
        ) {
          for (const item of invoiceData.invoice_items) {
            if (!item.product_id) {
              resolve({
                code: 400,
                msg: "Product ID is required for all invoice items",
              });
              return;
            }
          }
        }

        const result = await this.invoiceRepo.updateInvoiceWithItems(
          invoiceId,
          invoiceData
        );
        resolve(result);
      } catch (err) {
        reject(err);
      }
    });
  }

  // Update invoice
  updateInvoice(invoiceId, invoiceData) {
    return new Promise(async (resolve, reject) => {
      try {
        if (!invoiceId || typeof invoiceId !== "string") {
          resolve({
            code: 400,
            msg: "Invoice ID is required and must be a string",
          });
          return;
        }

        const result = await this.invoiceRepo.updateInvoice(
          invoiceId,
          invoiceData
        );
        resolve(result);
      } catch (err) {
        reject(err);
      }
    });
  }

  // Update invoice item
  updateInvoiceItem(invoiceItemId, invoiceItemData) {
    return new Promise(async (resolve, reject) => {
      try {
        if (!invoiceItemId) {
          resolve({ code: 400, msg: "Invoice item ID is required" });
          return;
        }

        if (!invoiceItemData.product_id) {
          resolve({ code: 400, msg: "Product ID is required" });
          return;
        }

        const result = await this.invoiceRepo.updateInvoiceItem(
          invoiceItemId,
          invoiceItemData
        );
        resolve(result);
      } catch (err) {
        reject(err);
      }
    });
  }

  // Delete invoice
  deleteInvoice(invoiceId) {
    return new Promise(async (resolve, reject) => {
      try {
        if (!invoiceId || typeof invoiceId !== "string") {
          resolve({
            code: 400,
            msg: "Invoice ID is required and must be a string",
          });
          return;
        }

        const result = await this.invoiceRepo.deleteInvoice(invoiceId);
        resolve(result);
      } catch (err) {
        reject(err);
      }
    });
  }

  // Delete invoice item
  deleteInvoiceItem(invoiceItemId) {
    return new Promise(async (resolve, reject) => {
      try {
        if (!invoiceItemId) {
          resolve({ code: 400, msg: "Invoice item ID is required" });
          return;
        }

        const result = await this.invoiceRepo.deleteInvoiceItem(invoiceItemId);
        resolve(result);
      } catch (err) {
        reject(err);
      }
    });
  }

  // Add invoice item to existing invoice
  addInvoiceItem(invoiceId, invoiceItemData) {
    return new Promise(async (resolve, reject) => {
      try {
        if (!invoiceId || typeof invoiceId !== "string") {
          resolve({
            code: 400,
            msg: "Invoice ID is required and must be a string",
          });
          return;
        }

        if (!invoiceItemData.product_id) {
          resolve({ code: 400, msg: "Product ID is required" });
          return;
        }

        invoiceItemData.invoice_id = invoiceId;
        const result = await this.invoiceRepo.createInvoiceItem(
          invoiceItemData
        );
        resolve(result);
      } catch (err) {
        reject(err);
      }
    });
  }
}

module.exports = (invoiceRepo) => {
  return new InvoiceUsecase(invoiceRepo);
};
