const fs = require("fs");
const path = require("path");
const logger = require("../utils/logger");
const H = require("../utils/warehouse_health");
const W = require("../utils/wh_daily_reports");
const { istToday } = require("../utils/istDate");
const P = require("../utils/warehouse_health_pdf");

const A4 = { format: "A4", printBackground: true, preferCSSPageSize: true, margin: { top: "10mm", bottom: "10mm", left: "10mm", right: "10mm" } };

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
 * Warehouse Health (utils/warehouse_health.js): the warehouse manager's
 * dashboard under Invoice Pipeline, for one day (default yesterday, IST),
 * and its 9 am Telegram summary about yesterday to everyone whose
 * designation holds receive_warehouse_health_summary.
 */
class WarehouseHealth {
  /**
   * @param repo            repository/wh_daily_reports
   * @param reports         usecase/wh_daily_reports (box matching, staff names)
   * @param summaryRepo     repository/warehouse_health_summary
   * @param telegramService services/telegram
   * @param dashboardUrl    the page the summary's button opens
   * @param pdf / s3        services/pdf (withBrowser) and services/s3 (uploadFile): the PDF sent after the message
   */
  constructor({ repo, reports, summaryRepo = null, telegramService = null, dashboardUrl = null, pdf = null, s3 = null, today = () => istToday(), now = () => Date.now() }) {
    this.pdf = pdf;
    this.s3 = s3;
    this.now = now;
    this.logo = pdf ? loadLogo() : null;
    this.repo = repo;
    this.reports = reports;
    this.summaryRepo = summaryRepo;
    this.telegram = telegramService;
    this.dashboardUrl = dashboardUrl;
    this.today = today;
  }

  yesterday() {
    return H.addDays(this.today(), -1);
  }

  async build(date) {
    const week = H.addDays(date, -6);
    const month = H.monthStart(date);
    const [uploads, summary, byJobType, byStore, yetToVerify, remarks, boxLines, repeats, trend, trendUploads, pickerWork, pickerMistakes, staffNames] = await Promise.all([
      this.repo.uploads(date, date),
      this.repo.jobBreakdown(date, date, ["report_type"]),
      this.repo.jobBreakdown(date, date, ["report_type", "job_type"]),
      this.repo.jobBreakdown(date, date, ["report_type", "to_store", "job_type"]),
      this.repo.jobRows(date, date, { only: "open", report_type: "VERIFICATION" }, 500),
      this.repo.remarksPending(date),
      this.reports._boxes(date, date, null),
      this.repo.shortArticles(week, date, { report_type: "PICKING" }, 50),
      this.repo.jobBreakdown(week, date, ["report_date", "report_type"]),
      this.repo.uploads(week, date),
      this.repo.jobBreakdown(month, date, ["worked_by"], { report_type: "PICKING" }),
      this.repo.pickerMistakes(month, date),
      this.reports._staffNames(),
    ]);
    return H.buildHealth({ date, uploads, summary, byJobType, byStore, yetToVerify, remarks, boxLines, repeats, trend, trendUploads, pickerWork, pickerMistakes, staffNames });
  }

  /** The dashboard for `date` (default yesterday). Not a day in the future. */
  async health({ date = null } = {}) {
    const d = date || this.yesterday();
    if (!W.validDate(d)) return { code: 422, msg: "Choose a valid date" };
    if (d > this.today()) return { code: 422, msg: "That day has not happened yet" };
    return { code: 200, data: { ...(await this.build(d)), today: this.today(), yesterday: this.yesterday() } };
  }

  /**
   * What is sent about `date`: the message (with a button to the dashboard)
   * and, when PDFs are set up, the PDF's link. A PDF that fails is logged and
   * left out - the message still goes.
   */
  async message(date) {
    let text;
    let h = null;
    try {
      h = await this.build(date);
      text = H.formatTelegram(h);
    } catch (err) {
      text = `Warehouse Health - ${date}\nCould not be built: ${err.message}`;
    }
    const keyboard = this.dashboardUrl ? { inlineKeyboard: [[{ text: "Open Warehouse Health", url: this.dashboardUrl }]] } : null;
    const options = keyboard ? { parseMode: null, replyMarkup: keyboard } : { parseMode: null };
    let pdfUrl = null;
    if (h && this.pdf && this.s3) {
      try {
        const nowMs = this.now();
        const html = P.buildHtml(h, { nowMs, logoDataUri: this.logo });
        const file = await this.pdf.withBrowser((session) => session.renderPdf(html, A4));
        pdfUrl = await this.s3.uploadFile(undefined, `warehouse_health/${date}_${nowMs}.pdf`, "application/pdf", file);
      } catch (err) {
        logger.Log({
          level: logger.LEVEL.ERROR,
          component: "USECASE.WAREHOUSE_HEALTH",
          code: "USECASE.WAREHOUSE_HEALTH.PDF",
          description: err.toString(),
          category: "",
          ref: { date },
        });
      }
    }
    return { text, options, pdfUrl, caption: `Warehouse Health - ${date} (PDF)` };
  }

  /** The message, then the PDF when there is one. */
  async _send(chat, m) {
    await this.telegram.sendMessage(chat, m.text, m.options);
    if (m.pdfUrl) await this.telegram.sendDocument(chat, m.pdfUrl, m.caption);
  }

  /** "Send me the summary": yesterday's, to the caller's own Telegram. Not recorded. */
  async sendToMe(employeeId) {
    if (!employeeId) return { code: 403, msg: "Only an employee login can receive the summary" };
    if (!this.summaryRepo || !this.telegram) return { code: 400, msg: "The summary is not set up" };
    const chat = await this.summaryRepo.chatOf(employeeId);
    if (!chat) return { code: 422, msg: "Your Telegram is not linked to the bot yet" };
    const m = await this.message(this.yesterday());
    try {
      await this._send(chat, m);
    } catch (err) {
      return { code: 502, msg: `Telegram: ${err.message}` };
    }
    return { code: 200, data: { text: m.text, pdf: Boolean(m.pdfUrl) } };
  }

  /** The 9 am send: yesterday's summary to every recipient not yet sent it. */
  async run() {
    const day = this.yesterday();
    const outcome = { date: day, sent: 0, failed: 0, skipped: 0, already: 0 };
    const m = await this.message(day);
    outcome.pdf = Boolean(m.pdfUrl);
    const recipients = await this.summaryRepo.recipients(this.today());
    const done = await this.summaryRepo.sentOn(day);
    for (const r of recipients) {
      const employeeId = Number(r.employee_id);
      if (done.has(employeeId)) {
        outcome.already += 1;
        continue;
      }
      if (!r.private_chat_id) {
        outcome.skipped += 1;
        await this.summaryRepo.record({ day, employee_id: employeeId, status: "SKIPPED", reason: "Telegram not linked" });
        continue;
      }
      try {
        // eslint-disable-next-line no-await-in-loop
        await this._send(r.private_chat_id, m);
        outcome.sent += 1;
        await this.summaryRepo.record({ day, employee_id: employeeId, status: "SENT", chat_id: r.private_chat_id });
      } catch (err) {
        outcome.failed += 1;
        logger.Log({
          level: logger.LEVEL.ERROR,
          component: "USECASE.WAREHOUSE_HEALTH",
          code: "USECASE.WAREHOUSE_HEALTH.SEND",
          description: err.toString(),
          category: "",
          ref: { employee_id: employeeId },
        });
        await this.summaryRepo.record({ day, employee_id: employeeId, status: "FAILED", reason: String(err.message || err).slice(0, 255), chat_id: r.private_chat_id });
      }
    }
    return outcome;
  }
}

module.exports = (deps) => new WarehouseHealth(deps);
