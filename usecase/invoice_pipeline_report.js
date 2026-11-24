const fs = require("fs");
const path = require("path");
const logger = require("../utils/logger");
const R = require("../utils/invoice_pipeline_report");

const A4 = { format: "A4", printBackground: true, preferCSSPageSize: true, margin: { top: "10mm", bottom: "10mm", left: "10mm", right: "10mm" } };
const RUN_TIMEOUT_MS = 4 * 60 * 1000;

/**
 * The group is the one registered in Master -> Telegram Groups whose "Used
 * for" mentions this text (any case), so it can be set or changed there -
 * with Detect, which takes the id Telegram reports - without a deploy. With
 * none registered, the fixed Purchase group id is the fallback.
 */
const REGISTRY_USED_FOR = "invoice pipeline eod";
const SETUP_HINT =
  'Add the bot to the group, send /setup there, then in Master → Telegram Groups add the group with Detect and set "Used for" to "Invoice pipeline EOD".';

/** The Daily Needs logo as a data URI (the payslip's copy), or null without it. */
function loadLogo() {
  try {
    const file = path.join(__dirname, "..", "assets", "payslip", "dnds-logo.png");
    return `data:image/png;base64,${fs.readFileSync(file).toString("base64")}`;
  } catch (err) {
    return null;
  }
}

/**
 * The 9:10 am Invoice pipeline PDF (utils/invoice_pipeline_report.js),
 * sent to the Telegram group registered for it (see REGISTRY_USED_FOR): the pipeline is read fresh from
 * RetailPilot for all stores, rendered to PDF, uploaded to S3, and sent as a
 * document with the headline numbers as its caption - the same route the
 * stock-checker pending report takes.
 *
 * One run at a time; a run that takes longer than RUN_TIMEOUT_MS fails rather
 * than hangs.
 */
class InvoicePipelineReport {
  /**
   * @param deps.flow      usecase/warehouse_flow (getFlow)
   * @param deps.pdf       services/pdf (withBrowser)
   * @param deps.s3        services/s3 (uploadFile)
   * @param deps.telegram  services/telegram instance (sendDocument)
   * @param deps.chatId    the Telegram group to send to
   */
  constructor({ flow, pdf, s3, telegram, chatId, registryRepo = null, now = () => Date.now() }) {
    this.registryRepo = registryRepo;
    this.flow = flow;
    this.pdf = pdf;
    this.s3 = s3;
    this.telegram = telegram;
    this.chatId = chatId;
    this.now = now;
    this.running = false;
    this.logo = loadLogo();
  }

  /** The report as of now: { code, pdf, summary, nowMs } - nothing is sent. */
  async build() {
    const flow = await this.flow.getFlow({ refresh: true, store_ids: null });
    if (!flow || flow.code !== 200) return { code: 502, msg: (flow && flow.msg) || "Could not read the pipeline" };
    const nowMs = this.now();
    const { html, summary } = R.buildReport(flow.data, { nowMs, logoDataUri: this.logo });
    const pdf = await this.pdf.withBrowser((session) => session.renderPdf(html, A4));
    return { code: 200, pdf, summary, nowMs };
  }

  /**
   * Where to send: { chatId, source, group_name }. The active registered group
   * for "Invoice pipeline EOD" (the newest, if more than one), else the fixed
   * fallback id.
   */
  async destination() {
    if (this.registryRepo) {
      try {
        const rows = await this.registryRepo.getAll({ is_active: true });
        const match = (rows || []).find((g) => String(g.used_for || "").toLowerCase().includes(REGISTRY_USED_FOR));
        if (match && match.chat_id) return { chatId: match.chat_id, source: "registry", group_name: match.group_name };
      } catch (err) {
        logger.Log({
          level: logger.LEVEL.ERROR,
          component: "USECASE.INVOICE_PIPELINE_REPORT",
          code: "USECASE.INVOICE_PIPELINE_REPORT.REGISTRY",
          description: err.toString(),
          category: "",
          ref: {},
        });
      }
    }
    return { chatId: this.chatId || null, source: "fallback", group_name: null };
  }

  /** Build, upload and send to the group. */
  async run({ trigger = "cron" } = {}) {
    if (this.running) return { code: 409, msg: "The end-of-day pipeline report is already being sent" };
    // Marked running BEFORE the first await, so a second click cannot slip in
    // while the group is being looked up and send the report twice.
    this.running = true;
    let timer;
    let work = null;
    try {
      const dest = await this.destination();
      if (!dest.chatId) return { code: 400, msg: `No Telegram group is set for the end-of-day pipeline report. ${SETUP_HINT}` };
      work = (async () => {
        const report = await this.build();
        if (report.code !== 200) return report;
        const day = new Date(report.nowMs).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
        const fileName = `invoice_pipeline/eod_${day}_${report.nowMs}.pdf`;
        const url = await this.s3.uploadFile(undefined, fileName, "application/pdf", report.pdf);
        try {
          await this.telegram.sendDocument(dest.chatId, url, R.captionText(report.summary, report.nowMs));
        } catch (err) {
          // "chat not found" / "bot was kicked": the group id is wrong or the
          // bot is not in it - say how to fix it, not just what Telegram said.
          const text = String((err && err.message) || err);
          const groupProblem = /chat not found|bot was kicked|not a member|group chat was upgraded|have no rights/i.test(text);
          return { code: 502, msg: groupProblem ? `Telegram: ${text}. ${SETUP_HINT}` : `Telegram: ${text}`, destination: dest };
        }
        return {
          code: 200,
          msg: dest.group_name ? `Sent to ${dest.group_name}` : "Sent",
          trigger,
          url,
          destination: dest,
          summary: report.summary,
          row_count: report.summary.grn.count + report.summary.allocation.count,
        };
      })();
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out after ${RUN_TIMEOUT_MS / 1000}s`)), RUN_TIMEOUT_MS);
      });
      return await Promise.race([work, timeout]);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.INVOICE_PIPELINE_REPORT",
        code: "USECASE.INVOICE_PIPELINE_REPORT.RUN",
        description: err.toString(),
        category: "",
        ref: { trigger },
      });
      return { code: 500, msg: err.message };
    } finally {
      clearTimeout(timer);
      // A timed-out run may still be finishing: stay "running" until it has,
      // so a second run cannot send the report twice.
      if (work) work.catch(() => {}).finally(() => (this.running = false));
      else this.running = false;
    }
  }
}

module.exports = (deps) => new InvoicePipelineReport(deps);
