const logger = require("../utils/logger");
const telegram = require("../services/telegram")();
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

class ProductSalesUsecase {
  constructor(productSalesRepo, productOffersRepo) {
    this.productSalesRepo = productSalesRepo;
    this.productOffersRepo = productOffersRepo;
  }

  buildLowOfferStockMessage(row, remaining) {
    const name =
      row.gf_item_name && String(row.gf_item_name).trim()
        ? escapeMarkdown(String(row.gf_item_name))
        : escapeMarkdown(`Product ${row.product_id}`);
    const rem = formatQty(remaining);
    const sold = formatQty(row.stock_output);
    return (
      "🛒 *Product offers — running low*\n\n" +
      `📦 *Product:* ${name}\n` +
      `🆔 *Product ID:* ${escapeMarkdown(String(row.product_id))}\n\n` +
      `📉 *Remaining offer stock* (received − sold): *${rem}*\n` +
      `📊 *Total sold:* *${sold}*\n\n` +
      "Please review replenishment or offer settings for this item."
    );
  }

  notifyLowOfferStockForProductIds(product_ids) {
    if (!product_ids || product_ids.length === 0) {
      return Promise.resolve();
    }
    return this.productOffersRepo
      .listOffersStockByProductIds(product_ids)
      .then((rows) => {
        const tasks = (rows || []).map((row) => {
          const stockIn = Number(row.stock_input);
          const stockOut = Number(row.stock_output);
          if (!Number.isFinite(stockIn) || stockIn === 0) {
            return Promise.resolve();
          }
          if (!Number.isFinite(stockOut)) {
            return Promise.resolve();
          }
          if (!(stockIn - BUFFER_STOCK < stockOut)) {
            return Promise.resolve();
          }
          const remaining = stockIn - stockOut;
          const msg = this.buildLowOfferStockMessage(row, remaining);
          return telegram.sendMessage(PRODUCT_OFFERS_TELEGRAM_CHAT_ID, msg);
        });
        return Promise.all(tasks);
      });
  }

  async bulkCreate(rows) {
    try {
      const result = await this.productSalesRepo.bulkCreate(rows);
      if (result && result.code === 200 && Array.isArray(result.product_ids)) {
        const productIds = result.product_ids;
        delete result.product_ids;
        this.notifyLowOfferStockForProductIds(productIds).catch((err) =>
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "USECASE.PRODUCT_SALES",
            code: "USECASE.PRODUCT_SALES.TELEGRAM_LOW_OFFER_STOCK",
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
