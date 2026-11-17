const fs = require("fs");
const path = require("path");
const logger = require("../utils/logger");
const R = require("../utils/invoice_pipeline_report");

const A4 = { format: "A4", printBackground: true, preferCSSPageSize: true, margin: { top: "10mm", bottom: "10mm", left: "10mm", right: "10mm" } };
const RUN_TIMEOUT_MS = 4 * 60 * 1000;

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
 * The 9 pm end-of-day Invoice pipeline PDF (utils/invoice_pipeline_report.js),
 * sent to the Purchase Telegram group: the pipeline is read fresh from
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
  constructor({ flow, pdf, s3, telegram, chatId, now = () => Date.now() }) {
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

  /** Build, upload and send to the group. */
  async run({ trigger = "cron" } = {}) {
    if (this.running) return { code: 409, msg: "The end-of-day pipeline report is already being sent" };
    if (!this.chatId) return { code: 400, msg: "No Telegram group is set for the end-of-day pipeline report" };
    this.running = true;
    let timer;
    let work = null;
    try {
      work = (async () => {
        const report = await this.build();
        if (report.code !== 200) return report;
        const day = new Date(report.nowMs).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
        const fileName = `invoice_pipeline/eod_${day}_${report.nowMs}.pdf`;
        const url = await this.s3.uploadFile(undefined, fileName, "application/pdf", report.pdf);
        await this.telegram.sendDocument(this.chatId, url, R.captionText(report.summary, report.nowMs));
        return { code: 200, msg: "Sent", trigger, url, summary: report.summary, row_count: report.summary.grn.count + report.summary.allocation.count };
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
