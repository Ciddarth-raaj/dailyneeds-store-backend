const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");
const logger = require("../utils/logger");
const { MASTERHUB_QUERIES, RUNWAY_QUERIES, buildReport } = require("../utils/article_store_master");

const DEFAULT_DIR = path.join(__dirname, "..", "tmp", "reports", "article-store-master");
const KEEP_FILES = 7;
const FILE_PATTERN = /^article-store-master-(\d{4}-\d{2}-\d{2})\.xlsx$/;

/** YYYY-MM-DD of `date` in India time. */
function istDay(date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

/**
 * The Article Store Master report (utils/article_store_master.js): built once
 * a morning by the cron and on demand by "Refresh now", kept as an .xlsx on
 * disk so a download is instant. Read-only towards RetailPilot and the
 * database - it writes nothing but its own files.
 */
class ArticleStoreMaster {
  /**
   * @param masterhub SPECTRA client for masterhub (catalogue)
   * @param runway    SPECTRA client for runway (stock)
   */
  constructor(masterhub, runway, { dir = DEFAULT_DIR, now = () => new Date() } = {}) {
    this.masterhub = masterhub;
    this.runway = runway;
    this.dir = dir;
    this.now = now;
    this.running = null;
    this.lastError = null;
    this.lastErrorAt = null;
  }

  _files() {
    let names = [];
    try {
      names = fs.readdirSync(this.dir);
    } catch (e) {
      return [];
    }
    return names.filter((n) => FILE_PATTERN.test(n)).sort().reverse();
  }

  /** The newest report on disk: { file, path, day, built_at, size } or null. */
  latest() {
    const [name] = this._files();
    if (!name) return null;
    const full = path.join(this.dir, name);
    const stat = fs.statSync(full);
    return { file: name, path: full, day: name.match(FILE_PATTERN)[1], built_at: stat.mtime.toISOString(), size: stat.size };
  }

  status() {
    const latest = this.latest();
    return {
      code: 200,
      running: !!this.running,
      latest: latest ? { file: latest.file, day: latest.day, built_at: latest.built_at, size: latest.size } : null,
      last_error: this.lastError,
      last_error_at: this.lastErrorAt,
    };
  }

  /** Build today's file. A build already running is joined, not repeated. */
  build() {
    if (!this.running) {
      this.running = this._build().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  async _build() {
    const started = Date.now();
    try {
      for (const [name, client] of [["masterhub", this.masterhub], ["runway", this.runway]]) {
        if (!client.isConfigured()) throw new Error(`RetailPilot ${name} is not configured (RETAILPILOT_SPECTRA_URL / RETAILPILOT_SPECTRA_KEY)`);
      }
      const data = {};
      for (const [key, query] of Object.entries(MASTERHUB_QUERIES)) {
        data[key] = await this.masterhub.queryAll(query, 2000);
      }
      data.stock = await this.runway.queryAll(RUNWAY_QUERIES.stock, 2000);
      if (!data.articles.length) throw new Error("masterhub returned no articles - report not replaced");

      const report = buildReport(data);
      const day = istDay(this.now());
      const file = await this._write(report, day);
      this.lastError = null;
      this.lastErrorAt = null;
      return { code: 200, file, day, rows: report.rows.length, stores: report.stores.map((s) => s.header), seconds: Math.round((Date.now() - started) / 1000) };
    } catch (err) {
      this.lastError = err.message;
      this.lastErrorAt = this.now().toISOString();
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.ARTICLE_STORE_MASTER",
        code: "USECASE.ARTICLE_STORE_MASTER.BUILD",
        description: err.toString(),
        category: "",
        ref: {},
      });
      return { code: 502, msg: err.message };
    }
  }

  async _write(report, day) {
    fs.mkdirSync(this.dir, { recursive: true });
    const name = `article-store-master-${day}.xlsx`;
    const final = path.join(this.dir, name);
    const temp = `${final}.${process.pid}.tmp`;

    const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: temp, useStyles: true });
    const ws = wb.addWorksheet(`Article Store Master ${day}`.slice(0, 31), { views: [{ state: "frozen", ySplit: 1 }] });
    ws.columns = report.columns.map((c) => ({ header: c.header, key: c.key, width: c.width }));
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).commit();
    for (const row of report.rows) ws.addRow(row).commit();
    ws.commit();
    await wb.commit();

    // Swap in whole: a download never sees a half-written file.
    fs.renameSync(temp, final);
    for (const old of this._files().slice(KEEP_FILES)) {
      try {
        fs.unlinkSync(path.join(this.dir, old));
      } catch (e) {
        /* an old copy that will not go is no reason to fail today's */
      }
    }
    return name;
  }
}

module.exports = (masterhub, runway, options) => new ArticleStoreMaster(masterhub, runway, options);
module.exports.istDay = istDay;
