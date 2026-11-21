const logger = require("../utils/logger");
const H = require("../utils/warehouse_health");
const W = require("../utils/wh_daily_reports");
const { istToday } = require("../utils/istDate");

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
   */
  constructor({ repo, reports, summaryRepo = null, telegramService = null, dashboardUrl = null, today = () => istToday() }) {
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
    const [uploads, summary, byStore, yetToVerify, remarks, boxLines, repeats, trend, trendUploads, pickerWork, pickerMistakes, staffNames] = await Promise.all([
      this.repo.uploads(date, date),
      this.repo.jobBreakdown(date, date, ["report_type"]),
      this.repo.jobBreakdown(date, date, ["report_type", "to_store"]),
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
    return H.buildHealth({ date, uploads, summary, byStore, yetToVerify, remarks, boxLines, repeats, trend, trendUploads, pickerWork, pickerMistakes, staffNames });
  }

  /** The dashboard for `date` (default yesterday). Not a day in the future. */
  async health({ date = null } = {}) {
    const d = date || this.yesterday();
    if (!W.validDate(d)) return { code: 422, msg: "Choose a valid date" };
    if (d > this.today()) return { code: 422, msg: "That day has not happened yet" };
    return { code: 200, data: { ...(await this.build(d)), today: this.today(), yesterday: this.yesterday() } };
  }

  /** The message about `date`, with a button to the dashboard. */
  async message(date) {
    let text;
    try {
      text = H.formatTelegram(await this.build(date));
    } catch (err) {
      text = `Warehouse Health - ${date}\nCould not be built: ${err.message}`;
    }
    const keyboard = this.dashboardUrl ? { inlineKeyboard: [[{ text: "Open Warehouse Health", url: this.dashboardUrl }]] } : null;
    return { text, options: keyboard ? { parseMode: null, replyMarkup: keyboard } : { parseMode: null } };
  }

  /** "Send me the summary": yesterday's, to the caller's own Telegram. Not recorded. */
  async sendToMe(employeeId) {
    if (!employeeId) return { code: 403, msg: "Only an employee login can receive the summary" };
    if (!this.summaryRepo || !this.telegram) return { code: 400, msg: "The summary is not set up" };
    const chat = await this.summaryRepo.chatOf(employeeId);
    if (!chat) return { code: 422, msg: "Your Telegram is not linked to the bot yet" };
    const { text, options } = await this.message(this.yesterday());
    try {
      await this.telegram.sendMessage(chat, text, options);
    } catch (err) {
      return { code: 502, msg: `Telegram: ${err.message}` };
    }
    return { code: 200, data: { text } };
  }

  /** The 9 am send: yesterday's summary to every recipient not yet sent it. */
  async run() {
    const day = this.yesterday();
    const outcome = { date: day, sent: 0, failed: 0, skipped: 0, already: 0 };
    const { text, options } = await this.message(day);
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
        await this.telegram.sendMessage(r.private_chat_id, text, options);
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
