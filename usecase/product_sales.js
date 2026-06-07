const logger = require("../utils/logger");
const telegram = require("../services/telegram")();
const PDFService = require("../services/pdf");
const S3 = require("../services/s3");
const { BUFFER_STOCK } = require("../constants/product_offers");
const { PRODUCT_OFFERS_TELEGRAM_CHAT_ID } = require("../constants/telegram");

/** Purchased basis for buffer / remaining: stock_input + opening_stock (product_offers). */
function effectivePurchasedStock(row) {
  const si = Number(row.stock_input);
  const op = Number(row.opening_stock);
  const a = Number.isFinite(si) ? si : 0;
  const b = Number.isFinite(op) ? op : 0;
  return a + b;
}

function rowToPdfShape(row) {
  const purchased = effectivePurchasedStock(row);
  const so = Number(row.stock_output);
  return {
    item_code:
      row.product_id != null && row.product_id !== ""
        ? String(row.product_id)
        : "—",
    product_name:
      (row.de_name && String(row.de_name).trim()) ||
      `Product ${row.product_id}`,
    purchased_stock: purchased,
    stock_output: Number.isFinite(so) ? so : 0,
    remaining: purchased - (Number.isFinite(so) ? so : 0),
  };
}

/** Split offer rows for PDF: below buffer vs rest (this bulk / offers only). */
function splitRowsForPdf(offerRows) {
  const belowBufferRows = [];
  const otherRows = [];
  for (const row of offerRows) {
    const purchased = effectivePurchasedStock(row);
    const stockOut = Number(row.stock_output);
    if (!Number.isFinite(stockOut)) {
      continue;
    }
    const newRemaining = purchased - stockOut;
    const meetsBufferConcern =
      purchased !== 0 && newRemaining < BUFFER_STOCK;
    const shape = rowToPdfShape(row);
    if (meetsBufferConcern) {
      belowBufferRows.push(shape);
    } else {
      otherRows.push(shape);
    }
  }
  return { belowBufferRows, otherRows };
}

class ProductSalesUsecase {
  constructor(productSalesRepo, productOffersRepo) {
    this.productSalesRepo = productSalesRepo;
    this.productOffersRepo = productOffersRepo;
  }

  async runPostBulkNotifications(productIds) {
    if (!productIds || productIds.length === 0) {
      return;
    }
    const offerRows = await this.productOffersRepo.listOffersStockByProductIds(
      productIds
    );
    if (!offerRows || offerRows.length === 0) {
      return;
    }

    const { belowBufferRows, otherRows } = splitRowsForPdf(offerRows);

    try {
      const pdfBuffer = await PDFService.generateProductSalesOffersBulkPDF({
        generatedAt: new Date(),
        belowBufferRows,
        otherRows,
      });
      const fileName = `product_sales/offers_bulk_${Date.now()}.pdf`;
      const s3Url = await S3.uploadFile(
        undefined,
        fileName,
        "application/pdf",
        pdfBuffer
      );
      await telegram.sendDocument(
        PRODUCT_OFFERS_TELEGRAM_CHAT_ID,
        s3Url,
        "📄 Product offers — bulk sales summary (see PDF for purchased / sold / remaining by product)."
      );
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.PRODUCT_SALES",
        code: "USECASE.PRODUCT_SALES.PDF_OR_TELEGRAM_DOC",
        description: err.toString(),
        category: "",
        ref: {},
      });
    }
  }

  async bulkCreate(rows) {
    try {
      const result = await this.productSalesRepo.bulkCreate(rows);
      if (result && result.code === 200 && Array.isArray(result.product_ids)) {
        const productIds = result.product_ids;
        delete result.product_ids;
        this.runPostBulkNotifications(productIds).catch((err) =>
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "USECASE.PRODUCT_SALES",
            code: "USECASE.PRODUCT_SALES.POST_BULK_NOTIFICATIONS",
            description: err.toString(),
            category: "",
            ref: {},
          })
        );
      }
      return result;
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.PRODUCT_SALES",
        code: "USECASE.PRODUCT_SALES.BULK_CREATE",
        description: err.toString(),
        category: "",
        ref: {},
      });
      throw err;
    }
  }
}

module.exports = (productSalesRepo, productOffersRepo) => {
  return new ProductSalesUsecase(productSalesRepo, productOffersRepo);
};
