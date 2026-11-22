const fs = require("fs");
const path = require("path");
const logger = require("../utils/logger");
const H = require("../utils/warehouse_health");
const W = require("../utils/wh_daily_reports");
const { istToday } = require("../utils/istDate");
const P = require("../utils/warehouse_health_pdf");
const C = require("../utils/wh_box_chain");

/**
 * The stage chain and box chain are worked out once per day and stored
 * (usecase/wh_chain.js); this page only reads them. WAREHOUSE_HEALTH_CHAINS
 * = "off" hides them (a switch, should they ever need to be turned off).
 */
const chainsOn = () => String(process.env.WAREHOUSE_HEALTH_CHAINS || "").toLowerCase() !== "off";

/** How long a built day is reused when no report changed (the build reads every report since BOX_CHAIN_FROM). */
const BUILD_TTL_MS = 10 * 60 * 1000;

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
  constructor({ chain = null, repo, reports, summaryRepo = null, telegramService = null, dashboardUrl = null, pdf = null, s3 = null, today = () => istToday(), now = () => Date.now() }) {
    this.pdf = pdf;
    this.s3 = s3;
    this.now = now;
    this.logo = pdf ? loadLogo() : null;
    this.repo = repo;
    this.reports = reports;
    this.summaryRepo = summaryRepo;
    this.chain = chain; // usecase/wh_chain.js: the stored chains
    this.telegram = telegramService;
    this.dashboardUrl = dashboardUrl;
    this.today = today;
  }

  yesterday() {
    return H.addDays(this.today(), -1);
  }

  /**
   * What the dashboard, the PDF and the 9 am message show for `date`. Built
   * from every report since BOX_CHAIN_FROM, which takes the server a while,
   * so it is kept for BUILD_TTL_MS and shared by everyone asking meanwhile -
   * unless a report was pulled, uploaded or removed since (dataVersion).
   */
  async build(date) {
    const now = Date.now();
    let version = null;
    try {
      version = typeof this.repo.dataVersion === "function" ? await this.repo.dataVersion() : null;
      // ... and changes as the stored chain is worked out
      if (version !== null && this.chain && typeof this.chain.version === "function") version = `${version}|${await this.chain.version()}`;
    } catch (err) {
      version = null;
    }
    if (!this.built) this.built = new Map();
    const hit = this.built.get(date);
    if (hit && version !== null && hit.version === version && now - hit.at < BUILD_TTL_MS) return hit.promise;
    const promise = this._build(date);
    this.built.set(date, { at: now, version, promise });
    promise.catch(() => this.built.delete(date));
    // Keep the last few days only.
    while (this.built.size > 8) this.built.delete(this.built.keys().next().value);
    return promise;
  }

  async _build(date) {
    const week = H.addDays(date, -6);
    const month = H.monthStart(date);
    const [uploads, summary, byJobType, byStore, yetToVerify, remarks, boxLines, repeats, trend, trendUploads, pickerWork, pickerMistakes, staffNames, writeoffLines] = await Promise.all([
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
      // Every picking write-off line of the day: what, where, who, when.
      this.repo.jobRows(date, date, { only: "short", report_type: "PICKING" }, 3000),
    ]);
    const [chain, stuckCartons] = await Promise.all([this.chainFor(date), typeof this.reports.stuckCartons === "function" ? this.reports.stuckCartons() : null]);
    const boxChain = chain && chain.result ? chain.result.box : null;
    const stageChain = chain && chain.result ? { ...chain.result.stage, days_without_state: chain.days_without_state } : null;
    const chainStatus = chain ? { final: chain.final, status: chain.status, computed_at: chain.computed_at, progress: chain.progress, error: chain.error } : null;
    return H.buildHealth({ chainStatus, boxChain, stageChain, stuckCartons, date, uploads, summary, byJobType, byStore, yetToVerify, remarks, boxLines, repeats, trend, trendUploads, pickerWork, pickerMistakes, staffNames, writeoffLines });
  }

  /**
   * The stage chain and box chain for `date`, as STORED by usecase/wh_chain.js
   * (worked out once per day, in the background) - only read here, never
   * worked out on a page view. WAREHOUSE_HEALTH_CHAINS=off hides them.
   */
  async chainFor(date) {
    if (!chainsOn() || !this.chain || date < C.BOX_CHAIN_FROM) return null;
    try {
      return await this.chain.read(date);
    } catch (err) {
      logger.Log({ level: logger.LEVEL.ERROR, component: "USECASE.WAREHOUSE_HEALTH", code: "USECASE.WAREHOUSE_HEALTH.CHAIN", description: err.toString(), category: "", ref: { date } });
      return null;
    }
  }

  /**
   * Trace one waiting line - document (stage_id, optional) + article + store -
   * through every stage since BOX_CHAIN_FROM: what we hold at each stage, how
   * the rows link by job, and which reports were pulled on those days.
   */
  async trace({ stage_id = null, article_id, to_store }) {
    const article = Number(article_id);
    if (!Number.isInteger(article) || article <= 0) return { code: 422, msg: "Choose an article" };
    if (!to_store) return { code: 422, msg: "Choose the store" };
    const { jobs, boxes } = await this.repo.trace({ article_id: article, to_store: String(to_store), stage_id: stage_id ? String(stage_id) : null, from: C.BOX_CHAIN_FROM });
    // Boxes: keep those linked to one of the document's jobs, plus (cartons without a link) those within the document's days.
    const jobIds = new Set(jobs.map((j) => j.job_id).filter(Boolean));
    const split = (v) => String(v || "").split(",").map((x) => x.trim()).filter(Boolean);
    const days = jobs.map((j) => j.report_date).sort();
    const first = days[0] || C.BOX_CHAIN_FROM;
    const last = H.addDays(days[days.length - 1] || this.today(), 10);
    const unloadingJobs = new Set(jobs.map((j) => j.unloading_job).filter(Boolean));
    const marked = boxes
      .map((b) => {
        const links = [...split(b.packing_jobs), ...split(b.picking_job)];
        const linked = links.some((x) => jobIds.has(x)) || (b.report_type === "UNLOADING" && unloadingJobs.has(b.job_id));
        return { ...b, links, linked };
      })
      .filter((b) => b.linked || (!stage_id ? true : b.report_date >= first && b.report_date <= last));
    const all = [...new Set([...jobs.map((j) => j.report_date), ...marked.map((b) => b.report_date)])].sort();
    const ups = all.length ? await this.repo.uploads(all[0], all[all.length - 1]) : [];
    const pulled = {};
    for (const d of all) pulled[d] = [];
    for (const u of ups) if (pulled[u.report_date]) pulled[u.report_date].push(u.report_type);
    const names = await this.reports._staffNames();
    return {
      code: 200,
      data: {
        stage_id,
        article_id: article,
        to_store,
        stages: {
          PICKING: jobs.filter((j) => j.report_type === "PICKING").map((j) => ({ ...j, worker_name: names[j.worked_by] || null })),
          PACKING: jobs.filter((j) => j.report_type === "PACKING").map((j) => ({ ...j, worker_name: names[j.worked_by] || null })),
          LOADING: marked.filter((b) => b.report_type === "LOADING"),
          UNLOADING: marked.filter((b) => b.report_type === "UNLOADING"),
          VERIFICATION: jobs.filter((j) => j.report_type === "VERIFICATION").map((j) => ({ ...j, worker_name: names[j.worked_by] || null })),
        },
        pulled,
      },
    };
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
