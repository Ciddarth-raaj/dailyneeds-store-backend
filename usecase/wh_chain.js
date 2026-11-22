const logger = require("../utils/logger");
const SC = require("../utils/wh_stage_chain");
const BC = require("../utils/wh_box_chain");
const W = require("../utils/wh_daily_reports");
const { istToday } = require("../utils/istDate");

const FROM = BC.BOX_CHAIN_FROM;
/** Days of earlier reports read with a day, to tell pick-packs and carton splits apart. */
const CONTEXT_DAYS = 7;
const LIST_CAP = 300;
/**
 * The matching rules' version. Raise it whenever the rules change: days
 * stored under an older version are all redone (in the background) on the
 * next start, so a fix reaches every day, not only new ones.
 */
const LOGIC = 3; // 3: the shortages each stage found, line by line

const n = (v) => Number(v) || 0;

/**
 * The stage chain and box chain, worked out ONE DAY AT A TIME and stored
 * (repository/wh_chain.js), so Warehouse Health only reads them. A day starts
 * from what was still waiting at the end of the day before (stored) and adds
 * that day's reports - never every report since FROM, which took the site
 * down. Days are worked out in the background, in date order, with a pause
 * between days; a pull, upload or removal marks its day and every later day
 * to redo.
 */
class WhChain {
  constructor({ chainRepo, repo, today = () => istToday(), pauseMs = 500 }) {
    this.chainRepo = chainRepo;
    this.repo = repo;
    this.today = today;
    this.pauseMs = pauseMs;
    this.running = null;
  }

  days(from, to) {
    const out = [];
    for (let d = from < FROM ? FROM : from; d <= to; d = W.addDays(d, 1)) out.push(d);
    return out;
  }

  /** Every day from FROM to today gets a row (new days become TODO); then work. */
  async ensure() {
    await this.chainRepo.addMissing(this.days(FROM, this.today()));
    const first = await this.chainRepo.getDay(FROM);
    let stored = null;
    try {
      stored = first && first.result ? JSON.parse(first.result).logic || 1 : null;
    } catch (err) {
      stored = 1;
    }
    if (stored !== null && stored !== LOGIC) await this.chainRepo.markTodo(this.days(FROM, this.today()));
    return this.kick();
  }

  /** A report of `day` changed: it and every later day are redone. */
  async markFrom(day) {
    if (!W.validDate(day) || day > this.today()) return;
    await this.chainRepo.markTodo(this.days(day, this.today()));
    this.kick();
  }

  /** Start working if not already (never two runs at once). */
  kick() {
    if (!this.running) {
      this.running = this.run()
        .catch((err) => this.log("RUN", err))
        .finally(() => {
          this.running = null;
        });
    }
    return this.running;
  }

  async run() {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (;;) {
      const day = await this.chainRepo.nextTodo(this.today());
      if (!day) return;
      try {
        await this.computeDay(day);
      } catch (err) {
        this.log("DAY", err, { day });
        await this.chainRepo.failDay(day, err.message);
        return; // later days start from this one: stop until it is redone
      }
      await sleep(this.pauseMs); // let the site breathe between days
    }
  }

  /** Work out and store one day. */
  async computeDay(day) {
    const row = await this.chainRepo.getDay(day);
    const gen = row ? n(row.gen) : 0;
    const prev = W.addDays(day, -1);
    const [open, openBoxes] = day > FROM ? await Promise.all([this.chainRepo.loadOpen(prev), this.chainRepo.loadOpenBoxes(prev)]) : [[], []];
    const carried = { to_pack: [], to_load: [], to_verify: [] };
    for (const o of open) {
      if (!carried[o.gap]) continue;
      carried[o.gap].push({ report_date: o.since, stage_id: o.stage_id, article_id: o.article_id, article_name: o.article_name, from_store: o.from_store, to_store: o.to_store, link: o.links ? o.links.split(",") : [], qty: o.qty, nlc: o.nlc });
    }
    const from = W.addDays(day, -CONTEXT_DAYS) < FROM ? FROM : W.addDays(day, -CONTEXT_DAYS);
    const [{ jobs, boxes }, loads, unloads, ups] = await Promise.all([
      this.repo.stageFlows(from, day),
      this.repo.boxSummary("LOADING", day, day),
      this.repo.boxSummary("UNLOADING", day, day),
      this.repo.uploads(FROM, day),
    ]);

    // Stage chain
    const sc = SC.buildStageChain({ jobs, boxes, date: day, carried });
    const openRows = [];
    for (const g of sc.gaps) {
      for (const w of g.open) {
        openRows.push({ gap: g.key, since: w.report_date, stage_id: w.stage_id, article_id: w.article_id, article_name: w.article_name, from_store: w.from_store, to_store: w.to_store, links: (w.link || []).join(","), qty: w.qty, nlc: w.nlc });
      }
      delete g.open;
    }

    // Box chain: the box trips still open last night + today's loads, paired with today's unloads.
    const carriedLoads = openBoxes.map((b) => ({ report_date: b.loaded_on, box_id: b.box_id, planned_to_store: b.to_store, from_store: b.from_store, job_type: b.job_type, truck_no: b.truck_no, articles: b.articles, qty: b.qty, value: b.value, finished_at: b.loaded_at, job_id: b.job_id, stage_id: b.stage_id }));
    const bc = BC.buildChain({ loads: [...carriedLoads, ...loads], unloads, date: day });
    const stillOpen = bc.lists.still_open.map((b) => ({ loaded_on: b.loaded_on, box_id: b.box_id, job_id: b.job_id, stage_id: b.stage_id, from_store: b.from_store, to_store: b.to_store, job_type: b.job_type, truck_no: b.truck_no, articles: b.articles, qty: b.qty, value: b.value, loaded_at: b.loaded_at }));
    for (const k of Object.keys(bc.lists)) bc.lists[k] = bc.lists[k].slice(0, LIST_CAP);
    await this.attachItems(bc, day);
    const have = { LOADING: new Set(), UNLOADING: new Set() };
    for (const u of ups) if (have[u.report_type]) have[u.report_type].add(u.report_date);
    bc.missing_days = this.days(FROM, day)
      .map((d) => ({ date: d, reports: ["LOADING", "UNLOADING"].filter((t) => !have[t].has(d)).map((t) => (t === "LOADING" ? "Loading" : "Unloading")) }))
      .filter((m) => m.reports.length);

    const noLinks = sc.days_without_state.includes(day);
    await this.chainRepo.saveDay(day, { open: openRows, boxes: stillOpen, result: { stage: sc, box: bc, computed_at: new Date().toISOString(), logic: LOGIC }, noLinks, gen });
    return { day, open: openRows.length, boxes: stillOpen.length };
  }

  /** The articles of the box trips listed (still open, closed late, wrong store, not loaded). */
  async attachItems(bc, day) {
    const loaded = [...bc.lists.still_open, ...bc.lists.closed_old, ...bc.lists.wrong_store];
    const keys = loaded.map((b) => ({ report_date: b.loaded_on, box_id: b.box_id, planned_to_store: b.to_store, job_id: b.job_id }));
    const ukeys = bc.lists.not_loaded.map((b) => ({ report_date: day, box_id: b.box_id, planned_to_store: b.to_store, job_id: b.job_id }));
    const [la, ua] = await Promise.all([this.repo.boxArticles("LOADING", keys), this.repo.boxArticles("UNLOADING", ukeys)]);
    const items = (rows) => {
      const m = new Map();
      for (const r of rows) {
        const k = `${r.report_date}|${r.box_id}|${r.planned_to_store || ""}|${r.job_id || ""}`;
        if (!m.has(k)) m.set(k, []);
        m.get(k).push({ article_id: r.article_id, article_name: r.article_name || null, qty: n(r.qty), value: Math.round(n(r.value) * 100) / 100 });
      }
      return m;
    };
    const li = items(la);
    const ui = items(ua);
    for (const b of loaded) b.items = li.get(`${b.loaded_on}|${b.box_id}|${b.to_store || ""}|${b.job_id || ""}`) || [];
    for (const b of bc.lists.not_loaded) b.items = ui.get(`${day}|${b.box_id}|${b.to_store || ""}|${b.job_id || ""}`) || [];
  }

  /**
   * What Warehouse Health shows for `day`: the stored result (if any), whether
   * it is final, when it was worked out, and how far the redo is.
   */
  async read(day) {
    const [row, progress, noLinkDays] = await Promise.all([this.chainRepo.getDay(day), this.chainRepo.progress(this.today()), this.chainRepo.noLinkDays(day)]);
    let result = null;
    try {
      result = row && row.result ? JSON.parse(row.result) : null;
    } catch (err) {
      result = null;
    }
    return {
      result,
      final: Boolean(row && row.status === "DONE"),
      status: row ? row.status : null,
      error: row ? row.error : null,
      computed_at: (result && result.computed_at) || null, // ISO, from the app's clock
      progress,
      days_without_state: noLinkDays,
    };
  }

  version() {
    return this.chainRepo.version();
  }

  log(code, err, ref = {}) {
    logger.Log({ level: logger.LEVEL.ERROR, component: "USECASE.WH_CHAIN", code: `USECASE.WH_CHAIN.${code}`, description: String(err && err.stack ? err.stack : err).slice(0, 2000), category: "", ref });
  }
}

module.exports = (deps) => new WhChain(deps);
module.exports.FROM = FROM;
module.exports.LOGIC = LOGIC;
