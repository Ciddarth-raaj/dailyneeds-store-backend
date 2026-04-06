const logger = require("../utils/logger");
const telegram = require("../services/telegram")();
const PDFService = require("../services/pdf");
const S3 = require("../services/s3");
const { BUFFER_STOCK } = require("../constants/product_offers");
const { PRODUCT_OFFERS_TELEGRAM_CHAT_ID } = require("../constants/telegram");

function escapeMarkdown(text) {
  if (text == null || typeof text !== "string") return "";
  return String(text).replace(/\*/g, "\\*").replace(/_/g, "\\_").replace(/\[/g, "\\[");
}

function formatQty(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "—";
  if (Math.abs(x - Math.round(x)) < 1e-9) return String(Math.round(x));
  return String(x);
}

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
      (row.gf_item_name && String(row.gf_item_name).trim()) ||
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

  buildLowOfferStockMessage(row) {
    const purchased = effectivePurchasedStock(row);
    const stockOut = Number(row.stock_output);
    const so = Number.isFinite(stockOut) ? stockOut : 0;
    const remaining = purchased - so;
    const name =
      row.gf_item_name && String(row.gf_item_name).trim()
        ? escapeMarkdown(String(row.gf_item_name))
        : escapeMarkdown(`Product ${row.product_id}`);
    return (
      "🛒 *Product offers — running low*\n\n" +
      `📦 *Product:* ${name}\n` +
      `🆔 *Product ID:* ${escapeMarkdown(String(row.product_id))}\n\n` +
      `📥 *Purchased stock* (opening + received): *${formatQty(purchased)}*\n` +
      `📉 *Remaining* (purchased − sold): *${formatQty(remaining)}*\n` +
      `📊 *Total sold:* *${formatQty(so)}*\n\n` +
      "Please review replenishment or offer settings for this item."
    );
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

    const telegramTasks = offerRows.map((row) => {
      const purchased = effectivePurchasedStock(row);
      const stockOut = Number(row.stock_output);
      if (!Number.isFinite(stockOut)) {
        return Promise.resolve();
      }
      if (purchased === 0) {
        return Promise.resolve();
      }
      const newRemaining = purchased - stockOut;
      if (!(newRemaining < BUFFER_STOCK)) {
        return Promise.resolve();
      }
      const msg = this.buildLowOfferStockMessage(row);
      return telegram
        .sendMessage(PRODUCT_OFFERS_TELEGRAM_CHAT_ID, msg)
        .catch((err) => {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "USECASE.PRODUCT_SALES",
            code: "USECASE.PRODUCT_SALES.TELEGRAM_LOW_OFFER_STOCK",
            description: err.toString(),
            category: "",
            ref: { product_id: row.product_id },
          });
        });
    });
    await Promise.all(telegramTasks);

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
