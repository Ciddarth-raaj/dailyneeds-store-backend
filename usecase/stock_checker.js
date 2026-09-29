const logger = require("../utils/logger");
const telegram = require("../services/telegram")();
const PDFService = require("../services/pdf");
const S3 = require("../services/s3");
const { STOCK_CHECKER_TELEGRAM_CHAT_ID } = require("../constants/telegram");
const { getSelectedExecutable, withTimeout } = require("../services/pdf_browser");

const PENDING_REPORT_JOB = "stock_checker_pending_daily_report";
const DEFAULT_PENDING_REPORT_TIMEOUT_MS = 10 * 60 * 1000;
/** After a job timeout, how long to wait for Chrome cleanup before returning. */
const PENDING_REPORT_CLEANUP_GRACE_MS = 15000;

function pendingReportTimeoutMs(env = process.env) {
  const n = Number(env.STOCK_CHECKER_REPORT_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_PENDING_REPORT_TIMEOUT_MS;
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) throw signal.reason;
}

function staged(stage, promise) {
  return Promise.resolve(promise).catch((err) => {
    const e = err instanceof Error ? err : new Error(String(err));
    if (!e.stage) e.stage = stage;
    throw e;
  });
}

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
    /** Single-flight guard for runDailyPendingStockCheckReport (cron + manual route). */
    this.pendingReportRunning = false;
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
      (header.product && (header.product.de_name || header.product.de_display_name)) ||
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
      (header.product && (header.product.de_name || header.product.de_display_name)) ||
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
      (header.product && (header.product.de_name || header.product.de_display_name)) ||
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
   * One PDF per branch with pending rows; each sent via Telegram to STOCK_CHECKER_TELEGRAM_CHAT_ID (cron 23:00 or manual).
   *
   * Guarantees (2026-09 orphaned-Chrome incident):
   *  - single flight: a call while a run is active returns `skipped: "already_running"`
   *    (in-process guard - the API is one PM2 fork instance);
   *  - ONE browser for all branches, closed (and its process group swept) in `finally`;
   *  - the whole run is limited to STOCK_CHECKER_REPORT_TIMEOUT_MS (default 10 min):
   *    on expiry Chrome is closed, the error is logged and thrown, and the guard clears.
   *
   * @param {{ trigger?: "cron" | "manual" }} [opts]
   * @returns {Promise<{ code: number, pending_count?: number, branch_reports?: number, skipped?: string, message?: string }>}
   */
  async runDailyPendingStockCheckReport({ trigger = "manual" } = {}) {
    if (this.pendingReportRunning) {
      logger.Log({
        level: "warn", // logger.LEVEL.WARN ("warning") is dropped by winston
        component: "USECASE.STOCK_CHECKER",
        code: "USECASE.STOCK_CHECKER.DAILY_PENDING_REPORT_SKIP",
        description: "Previous pending stock check report is still running; skipped",
        category: "",
        ref: { job: PENDING_REPORT_JOB, trigger, skipped: "already_running" },
      });
      return {
        code: 200,
        skipped: "already_running",
        message: "A pending stock check report is already running",
      };
    }
    this.pendingReportRunning = true;

    const startedAt = Date.now();
    const timeoutMs = pendingReportTimeoutMs();
    const controller = new AbortController();
    const progress = { stage: "query", pdfs_generated: 0, sent: 0, branch_reports: 0 };
    let timer;
    let timedOut = false;

    const run = this.runPendingStockCheckReportBody(controller.signal, progress, trigger);
    // If the timeout wins, `run` settles later on its own; never unhandled.
    run.catch(() => {});
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        const err = new Error(
          `${PENDING_REPORT_JOB} timed out after ${timeoutMs} ms (stage: ${progress.stage})`
        );
        err.name = "TimeoutError";
        err.stage = progress.stage;
        controller.abort(err); // closes Chrome via withBrowser's abort hook
        reject(err);
      }, timeoutMs);
    });

    try {
      const result = await Promise.race([run, timeout]);
      logger.Log({
        level: logger.LEVEL.INFO,
        component: "USECASE.STOCK_CHECKER",
        code: "USECASE.STOCK_CHECKER.DAILY_PENDING_REPORT_DONE",
        description: `${PENDING_REPORT_JOB} succeeded`,
        category: "",
        ref: {
          job: PENDING_REPORT_JOB,
          trigger,
          success: true,
          duration_ms: Date.now() - startedAt,
          branch_reports: progress.branch_reports,
          pdfs_generated: progress.pdfs_generated,
          sent: progress.sent,
          assets_degraded: !!progress.assets_degraded,
        },
      });
      return result;
    } catch (err) {
      if (timedOut) {
        // Let withBrowser's finally (close + process-group sweep) finish
        // before the guard clears, but never wait on it indefinitely.
        await withTimeout(run.catch(() => {}), PENDING_REPORT_CLEANUP_GRACE_MS, "cleanup").catch(
          () => {}
        );
      }
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.STOCK_CHECKER",
        code: "USECASE.STOCK_CHECKER.DAILY_PENDING_REPORT",
        description: err.toString(),
        category: "",
        ref: {
          job: PENDING_REPORT_JOB,
          trigger,
          success: false,
          stage: err.stage || progress.stage,
          timed_out: timedOut,
          duration_ms: Date.now() - startedAt,
          branch_reports: progress.branch_reports,
          pdfs_generated: progress.pdfs_generated,
          sent: progress.sent,
        },
      });
      throw err;
    } finally {
      clearTimeout(timer);
      if (!controller.signal.aborted) controller.abort(new Error("run finished"));
      this.pendingReportRunning = false;
    }
  }

  /** The report itself; see runDailyPendingStockCheckReport for the guarantees around it. */
  async runPendingStockCheckReportBody(signal, progress, trigger) {
    progress.stage = "query";
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
    throwIfAborted(signal);
    if (!pendingRows.length) {
      progress.stage = "telegram";
      await staged(
        "telegram",
        telegram.sendMessage(
          STOCK_CHECKER_TELEGRAM_CHAT_ID,
          "📋 *Daily pending stock checks* (20:00)\n\n" +
          "No pending stock checks - every open check has entries for all required branches."
        )
      );
      return {
        code: 200,
        pending_count: 0,
        message: "No pending stock checks; Telegram notification sent",
      };
    }

    const ids = pendingRows.map((r) => r.stock_checker_id);
    const itemsById = await this.stockCheckerRepo.getItemsByStockCheckerIds(ids);
    throwIfAborted(signal);

    // Build report grouped by branch: for each required outlet, list products not yet filled.
    const outletNameById = new Map(
      requiredOutlets.map((o) => [
        Number(o.outlet_id),
        (o.outlet_name && String(o.outlet_name).trim()) || `Branch ${Number(o.outlet_id)}`,
      ])
    );

    const missingByBranch = new Map(); // branch_id -> [{ product_id, product_name }]
    for (const r of pendingRows) {
      const productName =
        (r.product_de_name && String(r.product_de_name).trim()) ||
        (r.product_de_display_name && String(r.product_de_display_name).trim()) ||
        `Product ${r.product_id}`;
      const items =
        itemsById[r.stock_checker_id] ||
        itemsById[String(r.stock_checker_id)] ||
        [];
      const presentBranchIds = new Set(
        (items || []).map((it) => Number(it.branch_id)).filter((x) => Number.isFinite(x))
      );

      for (const o of requiredOutlets) {
        const bid = Number(o.outlet_id);
        if (!presentBranchIds.has(bid)) {
          const arr = missingByBranch.get(bid) || [];
          arr.push({ product_id: r.product_id, product_name: productName });
          missingByBranch.set(bid, arr);
        }
      }
    }

    const sections = requiredOutlets
      .map((o) => {
        const bid = Number(o.outlet_id);
        const rows = missingByBranch.get(bid) || [];
        return {
          branch_id: bid,
          branch_name: outletNameById.get(bid) || `Branch ${bid}`,
          rows,
        };
      })
      .filter((sec) => (sec.rows || []).length > 0);
    progress.branch_reports = sections.length;

    progress.stage = "launch";
    const executable = getSelectedExecutable();
    logger.Log({
      level: logger.LEVEL.INFO,
      component: "USECASE.STOCK_CHECKER",
      code: "USECASE.STOCK_CHECKER.DAILY_PENDING_REPORT_START",
      description: `${PENDING_REPORT_JOB} started`,
      category: "",
      ref: {
        job: PENDING_REPORT_JOB,
        trigger,
        branch_reports: sections.length,
        executable: executable.display,
        executable_source: executable.source,
      },
    });

    const generatedAt = new Date();
    const baseTs = Date.now();
    // One browser for every branch: page -> PDF -> upload -> Telegram per
    // branch, then close. Sending stays per branch so a later failure does
    // not hold back the reports already made.
    await PDFService.withBrowser(
      async (session) => {
        for (let i = 0; i < sections.length; i++) {
          const sec = sections[i];
          const pdfBuffer = await PDFService.renderStockCheckerPendingReportPDF(session, {
            generatedAt,
            sections: [sec],
          });
          progress.pdfs_generated += 1;
          if (session.assetsDegraded) progress.assets_degraded = true;
          throwIfAborted(signal);

          progress.stage = "upload";
          const fileName = `stock_checker/pending_report_branch_${sec.branch_id}_${baseTs}_${i}.pdf`;
          const s3Url = await staged(
            "upload",
            S3.uploadFile(undefined, fileName, "application/pdf", pdfBuffer)
          );
          throwIfAborted(signal);

          progress.stage = "telegram";
          const rowCount = (sec.rows || []).length;
          await staged(
            "telegram",
            telegram.sendDocument(
              STOCK_CHECKER_TELEGRAM_CHAT_ID,
              s3Url,
              `📋 Pending stock checks - ${sec.branch_name} (${rowCount} product(s)).`
            )
          );
          progress.sent += 1;
          throwIfAborted(signal);
        }
      },
      {
        signal,
        onStage: (stage) => {
          progress.stage = stage;
        },
      }
    );
    progress.stage = "done";

    return {
      code: 200,
      pending_count: pendingRows.length,
      branch_reports: sections.length,
      message: `${sections.length} PDF(s) generated and sent to Telegram`,
    };
  }
}

module.exports = (stockCheckerRepo, outletRepo) => {
  return new StockCheckerUsecase(stockCheckerRepo, outletRepo);
};
