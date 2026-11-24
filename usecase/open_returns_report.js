const logger = require("../utils/logger");
const R = require("../utils/open_returns_report");

/**
 * The same group as the Invoice pipeline report: the one registered in
 * Master -> Telegram Groups whose "Used for" mentions one of these (a group
 * registered for "Open returns" wins), else the fixed Purchase group id.
 */
const REGISTRY_USED_FOR = ["open returns", "invoice pipeline eod"];
const SETUP_HINT =
  'Add the bot to the group, send /setup there, then in Master → Telegram Groups add the group with Detect and set "Used for" to "Invoice pipeline EOD".';

const istDayOf = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

/**
 * The 9:15 am Open returns message (utils/open_returns_report.js): open
 * returns read fresh from RetailPilot for all stores and sent as one text
 * message to the Purchase Telegram group.
 */
class OpenReturnsReport {
  /**
   * @param deps.dashboard  usecase/business_dashboard (getPurchaseReturns)
   * @param deps.telegram   services/telegram instance (sendMessage)
   * @param deps.chatId     fallback group id
   */
  constructor({ dashboard, telegram, chatId, registryRepo = null, now = () => Date.now() }) {
    this.dashboard = dashboard;
    this.telegram = telegram;
    this.chatId = chatId;
    this.registryRepo = registryRepo;
    this.now = now;
    this.running = false;
  }

  /** The message as of now: { code, text, summary } - nothing is sent. */
  async build() {
    const day = istDayOf(this.now());
    const r = await this.dashboard.getPurchaseReturns({ from_date: day, to_date: day, refresh: true, store_ids: null });
    if (!r || r.code !== 200) return { code: 502, msg: (r && r.msg) || "Could not read open returns" };
    if (!r.data.open.ok) return { code: 502, msg: `RetailPilot: ${r.data.open.error}` };
    const { text, summary } = R.buildMessage(r.data.open.rows, r.data.stores, this.now());
    return { code: 200, text, summary };
  }

  async destination() {
    if (this.registryRepo) {
      try {
        const rows = (await this.registryRepo.getAll({ is_active: true })) || [];
        for (const want of REGISTRY_USED_FOR) {
          const match = rows.find((g) => String(g.used_for || "").toLowerCase().includes(want));
          if (match && match.chat_id) return { chatId: match.chat_id, source: "registry", group_name: match.group_name };
        }
      } catch (err) {
        logger.Log({
          level: logger.LEVEL.ERROR,
          component: "USECASE.OPEN_RETURNS_REPORT",
          code: "USECASE.OPEN_RETURNS_REPORT.REGISTRY",
          description: err.toString(),
          category: "",
          ref: {},
        });
      }
    }
    return { chatId: this.chatId || null, source: "fallback", group_name: null };
  }

  async run({ trigger = "cron" } = {}) {
    if (this.running) return { code: 409, msg: "The open returns report is already being sent" };
    this.running = true;
    try {
      const dest = await this.destination();
      if (!dest.chatId) return { code: 400, msg: `No Telegram group is set for the open returns report. ${SETUP_HINT}` };
      const report = await this.build();
      if (report.code !== 200) return report;
      try {
        await this.telegram.sendMessage(dest.chatId, report.text, { parseMode: "HTML" });
      } catch (err) {
        const text = String((err && err.message) || err);
        const groupProblem = /chat not found|bot was kicked|not a member|group chat was upgraded|have no rights/i.test(text);
        return { code: 502, msg: groupProblem ? `Telegram: ${text}. ${SETUP_HINT}` : `Telegram: ${text}`, destination: dest };
      }
      return { code: 200, msg: dest.group_name ? `Sent to ${dest.group_name}` : "Sent", trigger, destination: dest, summary: report.summary };
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.OPEN_RETURNS_REPORT",
        code: "USECASE.OPEN_RETURNS_REPORT.RUN",
        description: err.toString(),
        category: "",
        ref: { trigger },
      });
      return { code: 500, msg: err.message };
    } finally {
      this.running = false;
    }
  }
}

module.exports = (deps) => new OpenReturnsReport(deps);
