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

/** The site the page opens on, and the warehouse's name in the reports. */
const WAREHOUSE = "warehouse";
/** A site name as the reports have it (lower case), the warehouse when none; null when not a name. */
function cleanSite(v) {
  const s = String(v == null ? "" : v).trim().toLowerCase();
  if (!s) return WAREHOUSE;
  return /^[a-z0-9 ._&()'-]{1,100}$/.test(s) ? s : null;
}

/** The dashboard link opened on a site (the warehouse needs no parameter). */
function siteUrl(url, site) {
  if (!site || site === WAREHOUSE) return url;
  const [base, hash] = String(url).split("#");
  return `${base}${base.includes("?") ? "&" : "?"}site=${encodeURIComponent(site)}${hash ? `#${hash}` : ""}`;
}

/** The reports' site for an employee's store name ("Vallalar Salai" -> "vallalar salai"), or null. */
function siteForOutlet(outletName, sites) {
  const norm = (v) => String(v || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const o = norm(outletName);
  if (!o) return null;
  return sites.find((x) => norm(x) === o) || sites.find((x) => norm(x) && (o.includes(norm(x)) || norm(x).includes(o))) || null;
}

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
  async build(date, site = WAREHOUSE) {
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
    const key = `${date}|${site}`;
    const hit = this.built.get(key);
    if (hit && version !== null && hit.version === version && now - hit.at < BUILD_TTL_MS) return hit.promise;
    const promise = this._build(date, site);
    this.built.set(key, { at: now, version, promise });
    promise.catch(() => this.built.delete(key));
    // Keep the last few days / sites only.
    while (this.built.size > 24) this.built.delete(this.built.keys().next().value);
    return promise;
  }

  /**
   * One site's day. The warehouse: what it SENT (picked, packed, loaded there,
   * and how the stores found it), with what was sent TO it (store returns)
   * below. A store: what was sent TO it (unloading, verification there), with
   * what it SENT (its own picking, pickers) below.
   */
  async _build(date, site = WAREHOUSE) {
    const week = H.addDays(date, -6);
    const month = H.monthStart(date);
    const isWh = site === WAREHOUSE;
    const sent = { from_store: site };
    // Verification: of the warehouse's goods at the stores; at a store, of the goods it received.
    const checked = isWh ? { from_store: site } : { to_store: site };
    const [uploads, pickSummary, checkSummary, byJobType, byStore, yetToVerify, remarks, boxLinesAll, repeats, trend, trendUploads, pickerWork, pickerMistakes, staffNames, writeoffLines, sites] = await Promise.all([
      this.repo.uploads(date, date),
      this.repo.jobBreakdown(date, date, ["report_type"], sent),
      this.repo.jobBreakdown(date, date, ["report_type"], { ...checked, report_type: "VERIFICATION" }),
      this.repo.jobBreakdown(date, date, ["report_type", "job_type"], sent),
      this.repo.jobBreakdown(date, date, ["report_type", "to_store", "job_type"], sent),
      this.repo.jobRows(date, date, { only: "open", report_type: "VERIFICATION", ...checked }, 500),
      this.repo.remarksPending(date),
      this.reports._boxes(date, date, null),
      this.repo.shortArticles(week, date, { report_type: "PICKING", ...sent }, 50),
      this.repo.jobBreakdown(week, date, ["report_date", "report_type"], sent),
      this.repo.uploads(week, date),
      this.repo.jobBreakdown(month, date, ["worked_by", "job_type"], { report_type: "PICKING", ...sent }),
      this.repo.pickerMistakes(month, date, { site }),
      this.reports._staffNames(),
      // Every picking write-off line of the day: what, where, who, when.
      this.repo.jobRows(date, date, { only: "short", report_type: "PICKING", ...sent }, 3000),
      this.sitesOn(date),
    ]);
    const summary = [...pickSummary.filter((r) => r.report_type !== "VERIFICATION"), ...checkSummary];
    const boxLines = boxLinesAll.filter((l) => (l.from_store || WAREHOUSE) === site);
    // Stuck cartons are not shown on their own: the same cartons are "Packed, not yet loaded" in the chain.
    const mainView = isWh ? `from:${site}` : `to:${site}`;
    const otherView = isWh ? `to:${site}` : `from:${site}`;
    const [chain, other] = await Promise.all([this.chainFor(date, mainView), this.chainFor(date, otherView)]);
    const boxChain = chain && chain.result ? chain.result.box : null;
    const stageChain = chain && chain.result ? { ...chain.result.stage, days_without_state: chain.days_without_state } : null;
    const chainStatus = chain ? { final: chain.final, status: chain.status, computed_at: chain.computed_at, progress: chain.progress, error: chain.error } : null;
    const h = H.buildHealth({ chainStatus, boxChain, stageChain, date, uploads, summary, byJobType, byStore, yetToVerify, remarks, boxLines, repeats, trend, trendUploads, pickerWork, pickerMistakes, staffNames, writeoffLines });
    const title = isWh ? "Received at the warehouse" : `Sent from ${H.title(site)}`;
    H.withSecondChain(h, other && other.result ? other.result : null, { title, direction: isWh ? "to" : "from", staffNames });
    await this.addPickers(h, staffNames);
    // At a store it is the store itself that found the shortage.
    if (!isWh) for (const i of h.need_you) i.text = i.text.replace(/^Stores found /, "Found ");
    h.site = site;
    h.site_name = H.title(site);
    h.main_title = isWh ? "Sent from the warehouse" : `Received at ${H.title(site)}`;
    h.sites = sites;
    return h;
  }

  /** The lines found short at verification, with who picked them (names as HR mapped them). */
  async addPickers(h, staffNames) {
    const lists = [h.stage_chain, h.second && h.second.stage_chain]
      .filter(Boolean)
      .map((sc) => ((sc.gaps || []).find((g) => g.key === "to_verify") || {}).lost)
      .filter((l) => l && l.list && l.list.length)
      .map((l) => l.list);
    if (!lists.length || typeof this.repo.pickersOfVerified !== "function") return;
    let rows = [];
    try {
      rows = await this.repo.pickersOfVerified(lists.flat());
    } catch (err) {
      return; // the lines still show, without the picker
    }
    const by = new Map(rows.map((r) => [`${r.job_id}|${r.article_id}`, String(r.pickers || "").split(",").filter(Boolean)]));
    for (const list of lists) {
      for (const l of list) {
        const ids = by.get(`${l.job_id}|${l.article_id}`) || [];
        l.picked_by = ids.length ? ids.map((id) => H.staffLabel(id, staffNames)).join(", ") : null;
      }
    }
  }

  /** Every site with a stored chain on `date` (the warehouse first). */
  async sitesOn(date) {
    let list = [];
    try {
      list = this.chain && typeof this.chain.sites === "function" && chainsOn() ? await this.chain.sites(date) : [];
    } catch (err) {
      list = [];
    }
    return [WAREHOUSE, ...list.filter((x) => x !== WAREHOUSE)].map((x) => ({ site: x, name: H.title(x) }));
  }

  /**
   * The stage chain and box chain for `date`, as STORED by usecase/wh_chain.js
   * (worked out once per day, in the background) - only read here, never
   * worked out on a page view. WAREHOUSE_HEALTH_CHAINS=off hides them.
   */
  async chainFor(date, view = `from:${WAREHOUSE}`) {
    if (!chainsOn() || !this.chain || date < C.BOX_CHAIN_FROM) return null;
    try {
      return await this.chain.read(date, view);
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
    const t = await this.repo.trace({ article_id: article, to_store: String(to_store), stage_id: stage_id ? String(stage_id) : null, from: C.BOX_CHAIN_FROM });
    const boxes = t.boxes;
    // The line's own jobs: picking / packing / verification of the document.
    const jobIds = new Set(t.jobs.map((j) => j.job_id).filter(Boolean));
    const split = (v) => String(v || "").split(",").map((x) => x.trim()).filter(Boolean);
    const days = t.jobs.map((j) => j.report_date).sort();
    const first = days[0] || C.BOX_CHAIN_FROM;
    const last = H.addDays(days[days.length - 1] || this.today(), 10);
    const withLinks = boxes.map((b) => {
      const links = [...split(b.packing_jobs), ...split(b.picking_job)];
      return { ...b, links, linked: links.some((x) => jobIds.has(x)) };
    });
    // Carton ids are reused on every delivery: when the line's boxes are linked by job, show only those;
    // boxes pulled before job links are shown by the document's days instead.
    const anyLinked = withLinks.some((b) => b.linked);
    const marked = withLinks.filter((b) => (anyLinked ? b.linked : !stage_id || (b.report_date >= first && b.report_date <= last)));
    const unloadingJobs = new Set(marked.filter((b) => b.report_type === "UNLOADING").map((b) => b.job_id).filter(Boolean));
    // Verification: the document's lines, plus lines that name one of the line's unloading jobs.
    const jobs = [...t.jobs, ...(t.verifs || []).filter((v) => v.unloading_job && unloadingJobs.has(v.unloading_job))];
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
  async health({ date = null, site = null } = {}) {
    const d = date || this.yesterday();
    if (!W.validDate(d)) return { code: 422, msg: "Choose a valid date" };
    if (d > this.today()) return { code: 422, msg: "That day has not happened yet" };
    const st = cleanSite(site);
    if (st === null) return { code: 422, msg: "Choose a valid store" };
    return { code: 200, data: { ...(await this.build(d, st)), today: this.today(), yesterday: this.yesterday() } };
  }

  /**
   * What is sent about `date`: the message (with a button to the dashboard)
   * and, when PDFs are set up, the PDF's link. A PDF that fails is logged and
   * left out - the message still goes.
   */
  async message(date, site = WAREHOUSE) {
    let text;
    let h = null;
    const name = H.reportName(site, H.title(site));
    try {
      h = await this.build(date, site);
      text = H.formatTelegram(h);
    } catch (err) {
      text = `${name} · ${date}\nCould not be built: ${err.message}`;
    }
    const keyboard = this.dashboardUrl ? { inlineKeyboard: [[{ text: "Open Pick Pack Daily Report", url: siteUrl(this.dashboardUrl, site) }]] } : null;
    const options = keyboard ? { parseMode: null, replyMarkup: keyboard } : { parseMode: null };
    let pdfUrl = null;
    if (h && this.pdf && this.s3) {
      try {
        const nowMs = this.now();
        const html = P.buildHtml(h, { nowMs, logoDataUri: this.logo });
        const file = await this.pdf.withBrowser((session) => session.renderPdf(html, A4));
        const tag = site === WAREHOUSE ? "" : `_${site.replace(/[^a-z0-9]+/g, "-")}`;
        pdfUrl = await this.s3.uploadFile(undefined, `warehouse_health/${date}${tag}_${nowMs}.pdf`, "application/pdf", file);
      } catch (err) {
        logger.Log({
          level: logger.LEVEL.ERROR,
          component: "USECASE.WAREHOUSE_HEALTH",
          code: "USECASE.WAREHOUSE_HEALTH.PDF",
          description: err.toString(),
          category: "",
          ref: { date, site },
        });
      }
    }
    return { text, options, pdfUrl, caption: `${name} · ${date} (PDF)` };
  }

  /** The message, then the PDF when there is one. */
  async _send(chat, m) {
    await this.telegram.sendMessage(chat, m.text, m.options);
    if (m.pdfUrl) await this.telegram.sendDocument(chat, m.pdfUrl, m.caption);
  }

  /** "Send me the summary": yesterday's, to the caller's own Telegram. Not recorded. */
  async sendToMe(employeeId, site = null) {
    if (!employeeId) return { code: 403, msg: "Only an employee login can receive the summary" };
    if (!this.summaryRepo || !this.telegram) return { code: 400, msg: "The summary is not set up" };
    const st = cleanSite(site);
    if (st === null) return { code: 422, msg: "Choose a valid store" };
    const chat = await this.summaryRepo.chatOf(employeeId);
    if (!chat) return { code: 422, msg: "Your Telegram is not linked to the bot yet" };
    const m = await this.message(this.yesterday(), st);
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
        await this.summaryRepo.record({ day, employee_id: employeeId, site: WAREHOUSE, status: "SKIPPED", reason: "Telegram not linked" });
        continue;
      }
      try {
        // eslint-disable-next-line no-await-in-loop
        await this._send(r.private_chat_id, m);
        outcome.sent += 1;
        await this.summaryRepo.record({ day, employee_id: employeeId, site: WAREHOUSE, status: "SENT", chat_id: r.private_chat_id });
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
        await this.summaryRepo.record({ day, employee_id: employeeId, site: WAREHOUSE, status: "FAILED", reason: String(err.message || err).slice(0, 255), chat_id: r.private_chat_id });
      }
    }
    if (typeof this.summaryRepo.storeRecipients === "function") await this.runStores(day, done, outcome);
    return outcome;
  }

  /**
   * Store managers (receive_store_health_summary): each gets their own
   * store's summary, the store found by the name of the employee's store
   * among the sites in the reports.
   */
  async runStores(day, done, outcome) {
    const recipients = await this.summaryRepo.storeRecipients(this.today());
    if (!recipients.length) return;
    const sites = (await this.sitesOn(day)).map((x) => x.site);
    const messages = new Map();
    outcome.stores = {};
    for (const r of recipients) {
      const employeeId = Number(r.employee_id);
      if (done.has(employeeId)) {
        outcome.already += 1;
        continue;
      }
      const site = siteForOutlet(r.outlet_name, sites);
      const skip = (reason) => this.summaryRepo.record({ day, employee_id: employeeId, site, status: "SKIPPED", reason });
      if (!site) {
        outcome.skipped += 1;
        // eslint-disable-next-line no-await-in-loop
        await skip(r.outlet_name ? `Store "${r.outlet_name}" not found in the reports` : "No store set for the employee");
        continue;
      }
      if (!r.private_chat_id) {
        outcome.skipped += 1;
        // eslint-disable-next-line no-await-in-loop
        await skip("Telegram not linked");
        continue;
      }
      try {
        // eslint-disable-next-line no-await-in-loop
        if (!messages.has(site)) messages.set(site, await this.message(day, site));
        // eslint-disable-next-line no-await-in-loop
        await this._send(r.private_chat_id, messages.get(site));
        outcome.sent += 1;
        outcome.stores[site] = (outcome.stores[site] || 0) + 1;
        // eslint-disable-next-line no-await-in-loop
        await this.summaryRepo.record({ day, employee_id: employeeId, site, status: "SENT", chat_id: r.private_chat_id });
      } catch (err) {
        outcome.failed += 1;
        logger.Log({ level: logger.LEVEL.ERROR, component: "USECASE.WAREHOUSE_HEALTH", code: "USECASE.WAREHOUSE_HEALTH.SEND_STORE", description: err.toString(), category: "", ref: { employee_id: employeeId, site } });
        // eslint-disable-next-line no-await-in-loop
        await this.summaryRepo.record({ day, employee_id: employeeId, site, status: "FAILED", reason: String(err.message || err).slice(0, 255), chat_id: r.private_chat_id });
      }
    }
  }
}

module.exports = (deps) => new WarehouseHealth(deps);
module.exports.cleanSite = cleanSite;
module.exports.siteForOutlet = siteForOutlet;
module.exports.siteUrl = siteUrl;
module.exports.WAREHOUSE = WAREHOUSE;
