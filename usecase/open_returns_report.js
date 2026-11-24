const fs = require("fs");
const path = require("path");
const logger = require("../utils/logger");
const R = require("../utils/open_returns_report");

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
 * The same group as the Invoice pipeline report: the one registered in
 * Master -> Telegram Groups whose "Used for" mentions one of these (a group
 * registered for "Open returns" wins), else the fixed Purchase group id.
 */
const REGISTRY_USED_FOR = ["open returns", "invoice pipeline eod"];
const SETUP_HINT =
  'Add the bot to the group, send /setup there, then in Master → Telegram Groups add the group with Detect and set "Used for" to "Invoice pipeline EOD".';

const istDayOf = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

/**
 * The 9:15 am Open returns PDF (utils/open_returns_report.js): open returns
 * read fresh from RetailPilot for all stores, rendered to PDF, uploaded to S3
 * and sent as a document on its own, with no caption - the same route as the
 * Invoice pipeline report.
 */
class OpenReturnsReport {
  /**
   * @param deps.dashboard  usecase/business_dashboard (getPurchaseReturns)
   * @param deps.pdf        services/pdf (withBrowser)
   * @param deps.s3         services/s3 (uploadFile)
   * @param deps.telegram   services/telegram instance (sendDocument)
   * @param deps.chatId     fallback group id
   */
  constructor({ dashboard, pdf, s3, telegram, chatId, registryRepo = null, now = () => Date.now() }) {
    this.dashboard = dashboard;
    this.pdf = pdf;
    this.s3 = s3;
    this.logo = loadLogo();
    this.telegram = telegram;
    this.chatId = chatId;
    this.registryRepo = registryRepo;
    this.now = now;
    this.running = false;
  }

  /** The report as of now: { code, pdf, summary, nowMs } - nothing is sent. */
  async build() {
    const nowMs = this.now();
    const day = istDayOf(nowMs);
    const r = await this.dashboard.getPurchaseReturns({ from_date: day, to_date: day, refresh: true, store_ids: null });
    if (!r || r.code !== 200) return { code: 502, msg: (r && r.msg) || "Could not read open returns" };
    if (!r.data.open.ok) return { code: 502, msg: `RetailPilot: ${r.data.open.error}` };
    const { html, summary } = R.buildReport(r.data.open.rows, r.data.stores, { nowMs, logoDataUri: this.logo });
    const pdf = await this.pdf.withBrowser((session) => session.renderPdf(html, A4));
    return { code: 200, pdf, summary, nowMs };
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
      let timer;
      const work = (async () => {
        const report = await this.build();
        if (report.code !== 200) return report;
        const fileName = `open_returns/open_returns_${istDayOf(report.nowMs)}_${report.nowMs}.pdf`;
        const url = await this.s3.uploadFile(undefined, fileName, "application/pdf", report.pdf);
        try {
          // Just the PDF: no caption.
          await this.telegram.sendDocument(dest.chatId, url);
        } catch (err) {
          const text = String((err && err.message) || err);
          const groupProblem = /chat not found|bot was kicked|not a member|group chat was upgraded|have no rights/i.test(text);
          return { code: 502, msg: groupProblem ? `Telegram: ${text}. ${SETUP_HINT}` : `Telegram: ${text}`, destination: dest };
        }
        const { groups, ...headline } = report.summary;
        return { code: 200, msg: dest.group_name ? `Sent to ${dest.group_name}` : "Sent", trigger, url, destination: dest, summary: headline, lines: groups.length };
      })();
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out after ${RUN_TIMEOUT_MS / 1000}s`)), RUN_TIMEOUT_MS);
      });
      try {
        return await Promise.race([work, timeout]);
      } finally {
        clearTimeout(timer);
      }
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
