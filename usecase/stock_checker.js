const logger = require("../utils/logger");
const telegram = require("../services/telegram")();
const { STOCK_CHECKER_TELEGRAM_CHAT_ID } = require("../constants/telegram");

function escapeMarkdown(text) {
  if (text == null || typeof text !== "string") return "";
  return String(text).replace(/\*/g, "\\*").replace(/_/g, "\\_").replace(/\[/g, "\\[");
}

class StockCheckerUsecase {
  constructor(stockCheckerRepo, outletRepo) {
    this.stockCheckerRepo = stockCheckerRepo;
    this.outletRepo = outletRepo;
  }

  async getAll() {
    try {
      return await this.stockCheckerRepo.getAll();
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.STOCK_CHECKER",
        code: "USECASE.STOCK_CHECKER.GET_ALL",
        description: err.toString(),
        category: "",
        ref: {}
      });
      throw err;
    }
  }

  async getById(stock_checker_id) {
    try {
      return await this.stockCheckerRepo.getById(stock_checker_id);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.STOCK_CHECKER",
        code: "USECASE.STOCK_CHECKER.GET_BY_ID",
        description: err.toString(),
        category: "",
        ref: {}
      });
      throw err;
    }
  }

  async create(data) {
    try {
      const result = await this.stockCheckerRepo.create(data);
      const stock_checker_id = result && result.stock_checker_id;
      if (stock_checker_id) {
        this.notifyStockCheckerRaised(stock_checker_id).catch((err) =>
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "USECASE.STOCK_CHECKER",
            code: "USECASE.STOCK_CHECKER.TELEGRAM_RAISED",
            description: err.toString(),
            category: "",
            ref: { stock_checker_id }
          })
        );
      }
      return result;
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.STOCK_CHECKER",
        code: "USECASE.STOCK_CHECKER.CREATE",
        description: err.toString(),
        category: "",
        ref: {}
      });
      throw err;
    }
  }

  async notifyStockCheckerRaised(stock_checker_id) {
    const header = await this.stockCheckerRepo.getById(stock_checker_id);
    if (!header) return;
    const productName =
      (header.product && (header.product.gf_item_name || header.product.de_display_name)) ||
      `Product ${header.product_id}`;
    const raisedMsg =
      "📋 *Stock check raised*\n\n" +
      "A new stock check has been raised for the below item\.\n\n" +
      "🆔 *Product ID:* " +
      escapeMarkdown(String(header.product_id)) +
      "\n" +
      "📦 *Product:* " +
      escapeMarkdown(productName);
    await telegram.sendMessage(STOCK_CHECKER_TELEGRAM_CHAT_ID, raisedMsg);
  }

  async update(stock_checker_id, data) {
    try {
      return await this.stockCheckerRepo.update(stock_checker_id, data);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.STOCK_CHECKER",
        code: "USECASE.STOCK_CHECKER.UPDATE",
        description: err.toString(),
        category: "",
        ref: {}
      });
      throw err;
    }
  }

  async delete(stock_checker_id) {
    try {
      return await this.stockCheckerRepo.delete(stock_checker_id);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.STOCK_CHECKER",
        code: "USECASE.STOCK_CHECKER.DELETE",
        description: err.toString(),
        category: "",
        ref: {}
      });
      throw err;
    }
  }

  // --- stock_checker_items ---

  async getItemsByStockCheckerId(stock_checker_id) {
    try {
      return await this.stockCheckerRepo.getItemsByStockCheckerId(
        stock_checker_id
      );
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.STOCK_CHECKER",
        code: "USECASE.STOCK_CHECKER.GET_ITEMS",
        description: err.toString(),
        category: "",
        ref: {}
      });
      throw err;
    }
  }

  async getItemByStockCheckerIdAndBranchId(stock_checker_id, branch_id) {
    try {
      return await this.stockCheckerRepo.getItemByStockCheckerIdAndBranchId(
        stock_checker_id,
        branch_id
      );
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.STOCK_CHECKER",
        code: "USECASE.STOCK_CHECKER.GET_ITEM",
        description: err.toString(),
        category: "",
        ref: {}
      });
      throw err;
    }
  }

  async upsertItem(data) {
    try {
      const result = await this.stockCheckerRepo.upsertItem(data);
      this.notifyStockCheckDoneIfConditionMet(data.stock_checker_id).catch((err) =>
        logger.Log({
          level: logger.LEVEL.ERROR,
          component: "USECASE.STOCK_CHECKER",
          code: "USECASE.STOCK_CHECKER.TELEGRAM_DONE",
          description: err.toString(),
          category: "",
          ref: { stock_checker_id: data.stock_checker_id }
        })
      );
      return result;
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.STOCK_CHECKER",
        code: "USECASE.STOCK_CHECKER.UPSERT_ITEM",
        description: err.toString(),
        category: "",
        ref: {}
      });
      throw err;
    }
  }

  async notifyStockCheckDoneIfConditionMet(stock_checker_id) {
    const itemCount = await this.stockCheckerRepo.getItemCountByStockCheckerId(
      stock_checker_id
    );
    const outlets = await this.outletRepo.get();
    const totalBranches = Array.isArray(outlets) ? outlets.length : 0;
    if (totalBranches === 0 || itemCount !== totalBranches - 1) return;

    const header = await this.stockCheckerRepo.getById(stock_checker_id);
    if (!header) return;
    const productName =
      (header.product && (header.product.gf_item_name || header.product.de_display_name)) ||
      `Product ${header.product_id}`;
    const items = await this.stockCheckerRepo.getItemsByStockCheckerId(
      stock_checker_id
    );
    const lines = (items || []).map((it) => {
      const branchName = (it.branch && it.branch.outlet_name) || `Branch ${it.branch_id}`;
      const sys = Number(it.system_stock);
      const phy = Number(it.physical_stock);
      const diff = sys - phy;
      const diffEmoji = diff === 0 ? "✅" : diff > 0 ? "📈" : "📉";
      return (
        `🏪 ${escapeMarkdown(branchName)}\n` +
        `💻 Sys: ${sys}  •  📦 Phy: ${phy}  •  ${diffEmoji} Diff: ${diff}`
      );
    });
    const doneMsg =
      "✅ *Stock check complete*\n\n" +
      `📦 *Product:* ${escapeMarkdown(productName)}\n\n` +
      "📊 *Summary by branch:*\n\n" +
      (lines.length ? lines.join("\n\n") : "No branch entries");
    await telegram.sendMessage(STOCK_CHECKER_TELEGRAM_CHAT_ID, doneMsg);
  }

  async upsertItemsBatch(items) {
    try {
      return await this.stockCheckerRepo.upsertItemsBatch(items);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.STOCK_CHECKER",
        code: "USECASE.STOCK_CHECKER.UPSERT_ITEMS_BATCH",
        description: err.toString(),
        category: "",
        ref: {}
      });
      throw err;
    }
  }

  async deleteItem(stock_checker_id, branch_id) {
    try {
      return await this.stockCheckerRepo.deleteItem(
        stock_checker_id,
        branch_id
      );
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.STOCK_CHECKER",
        code: "USECASE.STOCK_CHECKER.DELETE_ITEM",
        description: err.toString(),
        category: "",
        ref: {}
      });
      throw err;
    }
  }
}

module.exports = (stockCheckerRepo, outletRepo) => {
  return new StockCheckerUsecase(stockCheckerRepo, outletRepo);
};
