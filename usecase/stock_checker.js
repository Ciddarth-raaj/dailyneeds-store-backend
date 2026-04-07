const logger = require("../utils/logger");
const telegram = require("../services/telegram")();
const PDFService = require("../services/pdf");
const S3 = require("../services/s3");
const { STOCK_CHECKER_TELEGRAM_CHAT_ID } = require("../constants/telegram");

function escapeMarkdown(text) {
  if (text == null || typeof text !== "string") return "";
  return String(text).replace(/\*/g, "\\*").replace(/_/g, "\\_").replace(/\[/g, "\\[");
}

function formatBranchSummaryLine(it) {
  const branchName =
    (it.branch && it.branch.outlet_name) || `Branch ${it.branch_id}`;
  const sys = Number(it.system_stock);
  const phy = Number(it.physical_stock);
  const diff = sys - phy;
  const diffEmoji = diff === 0 ? "✅" : diff > 0 ? "📈" : "📉";
  return (
    `🏪 ${escapeMarkdown(branchName)}\n` +
    `💻 Sys: ${sys}  •  📦 Phy: ${phy}  •  ${diffEmoji} Diff: ${diff}`
  );
}

function requiredOutletsForStockCheck(outlets) {
  return (outlets || [])
    .filter((o) => Number(o.outlet_id) !== 1 && Number(o.is_active) === 1)
    .sort((a, b) => Number(a.outlet_id) - Number(b.outlet_id));
}

/** One row per required outlet; missing item → null numerics (PDF shows "-"). */
function buildPendingReportRowsForStockCheck(requiredOutlets, items) {
  const byBranch = new Map();
  (items || []).forEach((it) => {
    byBranch.set(Number(it.branch_id), it);
  });
  return requiredOutlets.map((o) => {
    const oid = Number(o.outlet_id);
    const it = byBranch.get(oid);
    const branchName =
      (o.outlet_name && String(o.outlet_name).trim()) || `Branch ${oid}`;
    if (!it) {
      return {
        branch_name: branchName,
        system_stock: null,
        physical_stock: null,
        difference: null,
      };
    }
    const sys = Number(it.system_stock);
    const phy = Number(it.physical_stock);
    const s = Number.isFinite(sys) ? sys : null;
    const p = Number.isFinite(phy) ? phy : null;
    const diff = s !== null && p !== null ? s - p : null;
    const nameFromItem =
      it.branch && it.branch.outlet_name
        ? String(it.branch.outlet_name)
        : branchName;
    return {
      branch_name: nameFromItem,
      system_stock: s,
      physical_stock: p,
      difference: diff,
    };
  });
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
    const branchName =
      header.created_by_branch && header.created_by_branch.outlet_name
        ? escapeMarkdown(String(header.created_by_branch.outlet_name))
        : escapeMarkdown("-");
    const raisedMsg =
      "📋 *Stock check raised*\n\n" +
      "A new stock check has been raised for the below item\.\n\n" +
      "🆔 *Product ID:* " +
      escapeMarkdown(String(header.product_id)) +
      "\n" +
      "📦 *Product:* " +
      escapeMarkdown(productName) +
      "\n\n" +
      "🏪 *Created At Branch :* " +
      branchName;
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
      void this.handleUpsertTelegramNotifications(
        data.stock_checker_id,
        data.branch_id
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

  async handleUpsertTelegramNotifications(stock_checker_id, branch_id) {
    try {
      await this.notifyStockCheckBranchUpserted(stock_checker_id);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.STOCK_CHECKER",
        code: "USECASE.STOCK_CHECKER.TELEGRAM_BRANCH_UPSERT",
        description: err.toString(),
        category: "",
        ref: { stock_checker_id, branch_id }
      });
    }
    try {
      await this.notifyStockCheckDoneIfConditionMet(stock_checker_id);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.STOCK_CHECKER",
        code: "USECASE.STOCK_CHECKER.TELEGRAM_DONE",
        description: err.toString(),
        category: "",
        ref: { stock_checker_id }
      });
    }
  }

  async notifyStockCheckBranchUpserted(stock_checker_id) {
    const header = await this.stockCheckerRepo.getById(stock_checker_id);
    const items = await this.stockCheckerRepo.getItemsByStockCheckerId(
      stock_checker_id
    );
    if (!header || !items || items.length === 0) return;
    const productName =
      (header.product && (header.product.gf_item_name || header.product.de_display_name)) ||
      `Product ${header.product_id}`;
    const lines = items.map((it) => formatBranchSummaryLine(it));
    const msg =
      "📝 *Stock check updated*\n\n" +
      `🆔 *Product ID:* ${escapeMarkdown(String(header.product_id))}\n` +
      `📦 *Product:* ${escapeMarkdown(productName)}\n\n` +
      "📊 *Summary by branch:*\n\n" +
      (lines.length ? lines.join("\n\n") : "No branch entries");
    await telegram.sendMessage(STOCK_CHECKER_TELEGRAM_CHAT_ID, msg);
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
    const lines = (items || []).map((it) => formatBranchSummaryLine(it));
    const doneMsg =
      "✅ *Stock check complete*\n\n" +
      `🆔 *Product ID:* ${escapeMarkdown(String(header.product_id))}\n` +
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

  /**
   * Pending = missing item for any active outlet except outlet_id 1.
   * PDF + Telegram to STOCK_CHECKER_TELEGRAM_CHAT_ID (cron 20:00 or manual).
   * @returns {Promise<{ code: number, pending_count?: number, skipped?: string, message?: string }>}
   */
  async runDailyPendingStockCheckReport() {
    try {
      const outlets = await this.outletRepo.get();
      const requiredOutlets = requiredOutletsForStockCheck(outlets);
      if (requiredOutlets.length === 0) {
        logger.Log({
          level: logger.LEVEL.WARN,
          component: "USECASE.STOCK_CHECKER",
          code: "USECASE.STOCK_CHECKER.DAILY_PENDING_REPORT_SKIP",
          description: "No active outlets (excluding id 1) for stock check scope",
          category: "",
          ref: {},
        });
        return {
          code: 200,
          skipped: "no_outlets",
          message: "No active outlets (excluding id 1) for stock check scope",
          pending_count: 0,
        };
      }

      const pendingRows = await this.stockCheckerRepo.listPendingStockCheckerHeaders();
      if (!pendingRows.length) {
        await telegram.sendMessage(
          STOCK_CHECKER_TELEGRAM_CHAT_ID,
          "📋 *Daily pending stock checks* (20:00)\n\n" +
            "No pending stock checks - every open check has entries for all required branches."
        );
        return {
          code: 200,
          pending_count: 0,
          message: "No pending stock checks; Telegram notification sent",
        };
      }

      const ids = pendingRows.map((r) => r.stock_checker_id);
      const itemsById = await this.stockCheckerRepo.getItemsByStockCheckerIds(ids);

      const sections = pendingRows.map((r) => {
        const productName =
          (r.product_gf_item_name && String(r.product_gf_item_name).trim()) ||
          (r.product_de_display_name &&
            String(r.product_de_display_name).trim()) ||
          `Product ${r.product_id}`;
        const items =
          itemsById[r.stock_checker_id] ||
          itemsById[String(r.stock_checker_id)] ||
          [];
        return {
          stock_checker_id: r.stock_checker_id,
          product_id: r.product_id,
          product_name: productName,
          rows: buildPendingReportRowsForStockCheck(requiredOutlets, items),
        };
      });

      const pdfBuffer = await PDFService.generateStockCheckerPendingReportPDF({
        generatedAt: new Date(),
        sections,
      });
      const fileName = `stock_checker/pending_report_${Date.now()}.pdf`;
      const s3Url = await S3.uploadFile(
        undefined,
        fileName,
        "application/pdf",
        pdfBuffer
      );
      await telegram.sendDocument(
        STOCK_CHECKER_TELEGRAM_CHAT_ID,
        s3Url,
        `📋 Pending stock checks - ${pendingRows.length} product(s).`
      );
      return {
        code: 200,
        pending_count: pendingRows.length,
        message: "PDF generated and sent to Telegram",
      };
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.STOCK_CHECKER",
        code: "USECASE.STOCK_CHECKER.DAILY_PENDING_REPORT",
        description: err.toString(),
        category: "",
        ref: {},
      });
      throw err;
    }
  }
}

module.exports = (stockCheckerRepo, outletRepo) => {
  return new StockCheckerUsecase(stockCheckerRepo, outletRepo);
};
