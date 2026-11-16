const logger = require("../utils/logger");
const { istToday, istDateOf } = require("../utils/istDate");
const S = require("../utils/po_daily_summary");

/** The IST day `today` as [start, end) instants. */
const istDayBounds = (today) => {
  const start = new Date(`${today}T00:00:00+05:30`);
  return [start, new Date(start.getTime() + 24 * 60 * 60 * 1000)];
};

/**
 * The 7 pm PO follow-up summary on Telegram, Mon-Sat: a private message to
 * everyone whose designation holds receive_po_daily_summary and who has
 * linked Telegram. One send per person per day (po_daily_summary_sends);
 * one failure does not stop the rest.
 */
class PoDailySummary {
  constructor({ poTracker, followupRepo, summaryRepo, telegramService, trackerUrl, today = () => istToday() }) {
    this.poTracker = poTracker;
    this.followupRepo = followupRepo;
    this.summaryRepo = summaryRepo;
    this.telegram = telegramService;
    this.trackerUrl = trackerUrl;
    this.today = today;
  }

  /** The summary figures for today, or { error }. */
  async build(today) {
    const list = await this.poTracker.list({ refresh: true });
    if (list.code !== 200) return { error: list.msg || "PO Tracker could not be read" };
    if (list.data.followups_error) return { error: list.data.followups_error };
    const orders = list.data.orders;
    const [start, end] = istDayBounds(today);
    const chased = await this.followupRepo.chasedBetween(start, end);
    const onTracker = new Set(orders.map((o) => o.po_slug));
    const chasedOnTracker = chased.filter((s) => onTracker.has(s));
    const previous = await this.followupRepo.latestBefore(chasedOnTracker, start);
    const previousBySlug = new Map(
      previous.map((r) => [r.po_slug, { next_follow_up_date: r.next_follow_up_date || null, created_day: r.created_at ? istDateOf(new Date(r.created_at)) : null }])
    );
    return S.buildSummary({ orders, chasedToday: chasedOnTracker, previousBySlug, today });
  }

  /** Today's message text and keyboard (a failure note if it cannot be built). */
  async message(today) {
    let text;
    let summary = null;
    try {
      summary = await this.build(today);
      text = summary.error ? S.formatFailure(today, summary.error) : S.formatMessage(summary);
    } catch (err) {
      text = S.formatFailure(today, "an internal error");
      summary = { error: err.message };
    }
    const keyboard = this.trackerUrl ? { inlineKeyboard: [[{ text: "Open PO Tracker", url: this.trackerUrl }]] } : null;
    return { text, summary, options: keyboard ? { parseMode: null, replyMarkup: keyboard } : { parseMode: null } };
  }

  /**
   * "Send me today's summary": the summary so far, to the caller's own
   * Telegram only. Not recorded, so the 7 pm send still goes to them.
   */
  async sendToMe(employeeId) {
    if (!employeeId) return { code: 403, msg: "Only an employee login can receive the summary" };
    const chat = await this.summaryRepo.chatOf(employeeId);
    if (!chat) return { code: 422, msg: "Your Telegram is not linked to the bot yet" };
    const today = this.today();
    const { text, summary, options } = await this.message(today);
    try {
      await this.telegram.sendMessage(chat, text, options);
    } catch (err) {
      return { code: 502, msg: `Telegram: ${err.message}` };
    }
    return { code: 200, data: { summary, text } };
  }

  async run() {
    const today = this.today();
    const outcome = { date: today, sent: 0, failed: 0, skipped: 0, already: 0 };
    const { text, summary, options } = await this.message(today);
    outcome.summary = summary;

    const recipients = await this.summaryRepo.recipients(today);
    const done = await this.summaryRepo.sentOn(today);
    for (const r of recipients) {
      const employeeId = Number(r.employee_id);
      if (done.has(employeeId)) {
        outcome.already += 1;
        continue;
      }
      if (!r.private_chat_id) {
        outcome.skipped += 1;
        await this.summaryRepo.record({ day: today, employee_id: employeeId, status: "SKIPPED", reason: "Telegram not linked" });
        continue;
      }
      try {
        await this.telegram.sendMessage(r.private_chat_id, text, options);
        outcome.sent += 1;
        await this.summaryRepo.record({ day: today, employee_id: employeeId, status: "SENT", chat_id: r.private_chat_id });
      } catch (err) {
        outcome.failed += 1;
        logger.Log({
          level: logger.LEVEL.ERROR,
          component: "USECASE.PO_DAILY_SUMMARY",
          code: "USECASE.PO_DAILY_SUMMARY.SEND",
          description: err.toString(),
          category: "",
          ref: { employee_id: employeeId },
        });
        await this.summaryRepo.record({ day: today, employee_id: employeeId, status: "FAILED", reason: String(err.message || err).slice(0, 255), chat_id: r.private_chat_id });
      }
    }
    return outcome;
  }
}

module.exports = (deps) => new PoDailySummary(deps);
