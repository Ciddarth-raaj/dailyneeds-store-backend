const W = require("../utils/wh_daily_reports");
const R = require("../utils/wh_rp_reports");
const logger = require("../utils/logger");
const { istToday } = require("../utils/istDate");

/** The widest range one analysis covers. */
const MAX_RANGE_DAYS = 92;
/** The most days one pull from RetailPilot covers. */
const MAX_PULL_DAYS = 31;
/** Box lines with these statuses are listed as issues on the page. */
const BOX_ISSUES = ["NOT_UNLOADED", "WRONG_STORE", "QTY_DIFF", "NOT_LOADED", "OPEN"];

const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const minOf = (a, b) => (a == null ? b : b == null ? a : a < b ? a : b);
const maxOf = (a, b) => (a == null ? b : b == null ? a : a > b ? a : b);

/**
 * Warehouse Daily Reports: the team uploads the five RetailPilot exports
 * every morning; this saves them and answers the analysis page.
 */
class WhDailyReports {
  constructor(repo, today = () => istToday(), spectra = null) {
    this.repo = repo;
    this.spectra = spectra;
    this.today = today;
  }

  _range(from, to) {
    const t = this.today();
    const f = from || to || t;
    const e = to || from || t;
    if (!W.validDate(f) || !W.validDate(e)) return { error: "Choose valid dates" };
    if (f > e) return { error: "From date is after To date" };
    if (daysBetween(f, e) + 1 > MAX_RANGE_DAYS) return { error: `Choose at most ${MAX_RANGE_DAYS} days` };
    return { from: f, to: e };
  }

  /** Save one file as one report for one day, replacing any earlier upload of it. */
  async upload({ report_type, report_date, file_name, headers, rows, allow_date_mismatch = false, employee_id = null }) {
    const type = String(report_type || "").toUpperCase();
    if (!W.REPORT_TYPES.includes(type)) return { code: 422, msg: "Choose which report this is" };
    if (!W.validDate(report_date)) return { code: 422, msg: "Choose the report date" };
    if (report_date > this.today()) return { code: 422, msg: "The report date cannot be in the future" };
    const nameType = W.typeFromFileName(file_name);
    if (nameType && nameType !== type) {
      return { code: 422, msg: `"${file_name}" is the ${W.LABELS[nameType]} report, not ${W.LABELS[type]}. Upload it in the ${W.LABELS[nameType]} slot.` };
    }
    const nameDate = W.dateFromFileName(file_name);
    if (nameDate && nameDate !== report_date && !allow_date_mismatch) {
      return { code: 409, msg: `"${file_name}" is dated ${nameDate}, but you are uploading it for ${report_date}.`, data: { file_date: nameDate } };
    }

    const parsed = W.parseRows(type, headers, rows);
    if (parsed.errors.length) return { code: 422, msg: parsed.errors[0], errors: parsed.errors };

    return this._save({ type, report_date, rows: parsed.rows, file_name, employee_id, source: "UPLOAD" });
  }

  /**
   * Save one report's rows for one day (an uploaded file's, or pulled from
   * RetailPilot): price them, replace that day's report, and send its
   * write-off to its Pick & Pack page. Answers the upload's result.
   */
  async _save({ type, report_date, rows, file_name, employee_id = null, source = "UPLOAD", other = {} }) {
    // Every value is NLC (net landing cost) from RetailPilot - never MRP, not even the file's.
    const shape = W.shapeOf(type);
    const prices = await this._nlc(rows.map((r) => r.article_id));
    const out = rows.map((r) => {
      const nlc = prices.has(r.article_id) ? prices.get(r.article_id) : null;
      return shape === "JOB" ? { ...r, nlc, nlc_source: nlc == null ? null : "RETAILPILOT" } : { ...r, nlc };
    });

    const before = await this.repo.uploads(report_date, report_date);
    const replaced = before.some((u) => u.report_type === type);
    // Write-off also goes to its Pick & Pack page: Verification report -> Verification, Picking report -> Write Off.
    const toPage = type === "VERIFICATION" ? W.verificationWriteOffs(out) : type === "PICKING" ? W.pickingWriteOffs(out) : null;
    const saved = await this.repo.replaceUpload({
      report_type: type,
      report_date,
      file_name: file_name ? String(file_name).slice(0, 255) : null,
      uploaded_by: employee_id,
      shape,
      rows: out,
      source,
      pageLines: toPage ? { page: type === "VERIFICATION" ? "VERIFICATION" : "WRITE_OFF", rows: toPage.rows } : null,
    });

    const summary = { rows: out.length, ...other };
    if (shape === "JOB") {
      const short = out.filter((r) => r.short_qty > 0);
      summary.short_lines = short.length;
      summary.short_qty = short.reduce((s, r) => s + r.short_qty, 0);
      summary.short_value = round2(short.reduce((s, r) => s + r.short_qty * (r.nlc || 0), 0));
      summary.short_unpriced_lines = short.filter((r) => r.nlc == null).length;
      summary.open_lines = out.filter((r) => (r.open_jobs || 0) > 0).length;
    } else {
      summary.boxes = new Set(out.map((r) => r.box_id)).size;
      summary.trucks = new Set(out.map((r) => r.truck_no).filter(Boolean)).size;
      summary.qty = out.reduce((s, r) => s + r.box_qty, 0);
    }
    if (saved.page && type === "VERIFICATION") summary.verification_page = { ...saved.page, other_job_type_lines: toPage.other_job_type_lines };
    if (saved.page && type === "PICKING") summary.write_off_page = saved.page;
    return { code: 200, data: { upload_id: saved.upload_id, report_type: type, report_date, replaced, source, summary } };
  }

  /**
   * Pull the five reports for each day from..to (at most 31) straight from
   * RetailPilot's pick & pack jobs (utils/wh_rp_reports.js), replacing what
   * was there - an upload included. A day RetailPilot cannot answer for is
   * left as it was and reported. Answers { days: [{ date, reports: [{ type,
   * ok, msg?, summary? }] }] }.
   */
  async pull({ from, to, types = R.PULL_TYPES, employee_id = null }) {
    if (!this.spectra || !this.spectra.isConfigured()) return { code: 502, msg: "RetailPilot is not configured" };
    const r = this._range(from, to);
    if (r.error) return { code: 422, msg: r.error };
    if (r.to > this.today()) return { code: 422, msg: "Cannot pull a day in the future" };
    if (daysBetween(r.from, r.to) + 1 > MAX_PULL_DAYS) return { code: 422, msg: `Pull at most ${MAX_PULL_DAYS} days at a time` };
    const wanted = R.PULL_TYPES.filter((t) => types.includes(t));

    let stores;
    try {
      stores = R.storeNames(await this.spectra.queryAll(R.STORES_QUERY));
    } catch (err) {
      return { code: 502, msg: `RetailPilot: ${err.message}` };
    }
    const days = [];
    for (let d = r.from; d <= r.to; d = W.addDays(d, 1)) {
      const reports = [];
      for (const type of wanted) {
        try {
          const job = Boolean(R.JOB_STAGES[type]);
          // eslint-disable-next-line no-await-in-loop
          const lines = await this.spectra.queryAll(job ? R.buildJobLinesQuery(type, d) : R.buildBoxLinesQuery(type, d));
          const mapped = job ? R.mapJobLines(type, lines, stores) : R.mapBoxLines(type, lines, stores);
          // eslint-disable-next-line no-await-in-loop
          const info = await this.repo.productInfo(mapped.rows.map((x) => x.article_id));
          const rows = mapped.rows.map((x) => ({ ...x, ...(info.get(x.article_id) || {}) }));
          // eslint-disable-next-line no-await-in-loop
          const saved = await this._save({
            type,
            report_date: d,
            rows,
            file_name: "RetailPilot",
            employee_id,
            source: "RETAILPILOT",
            other: mapped.skipped ? { skipped_lines: mapped.skipped } : {},
          });
          reports.push({ type, ok: true, summary: saved.data.summary });
        } catch (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "USECASE.WH_DAILY_REPORTS",
            code: "USECASE.WH_DAILY_REPORTS.PULL",
            description: err.toString(),
            category: "",
            ref: { type, date: d },
          });
          reports.push({ type, ok: false, msg: err.message });
        }
      }
      days.push({ date: d, reports });
    }
    return { code: 200, data: { from: r.from, to: r.to, days } };
  }

  /**
   * NLC of these articles from RetailPilot (utils/wh_rp_reports.nlcByArticle).
   * RetailPilot not configured or not answering: no prices - the rows are
   * saved unpriced and filled in later (fillNlc / the nightly pull).
   */
  async _nlc(articleIds) {
    const ids = [...new Set((articleIds || []).filter((x) => Number.isInteger(x) && x > 0))];
    if (!ids.length || !this.spectra || !this.spectra.isConfigured()) return new Map();
    const rows = [];
    try {
      for (let i = 0; i < ids.length; i += 500) {
        // eslint-disable-next-line no-await-in-loop
        rows.push(...(await this.spectra.queryAll(R.buildNlcQuery(ids.slice(i, i + 500)))));
      }
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.WH_DAILY_REPORTS",
        code: "USECASE.WH_DAILY_REPORTS.NLC",
        description: err.toString(),
        category: "",
        ref: { articles: ids.length },
      });
      return new Map();
    }
    return R.nlcByArticle(rows);
  }

  /** Fill in NLC from RetailPilot on rows in from..to that have none (at most MAX_RANGE_DAYS). */
  async fillNlc({ from, to }) {
    const r = this._range(from, to);
    if (r.error) return { code: 422, msg: r.error };
    if (!this.spectra || !this.spectra.isConfigured()) return { code: 502, msg: "RetailPilot is not configured" };
    const ids = await this.repo.unpricedArticles(r.from, r.to);
    const found = await this._nlc(ids);
    const prices = new Map(ids.filter((id) => found.has(id)).map((id) => [id, found.get(id)]));
    const updated = prices.size ? await this.repo.fillNlc(r.from, r.to, prices) : 0;
    return { code: 200, data: { from: r.from, to: r.to, articles: ids.length, priced: prices.size, still_unpriced: ids.length - prices.size, rows_updated: updated } };
  }

  /** RetailPilot user id -> employee name, for the mapped ids. */
  async _staffNames() {
    try {
      const map = await this.repo.staffMap();
      return Object.fromEntries(map.filter((m) => m.employee_id && m.employee_name).map((m) => [m.rp_user_id, m.employee_name]));
    } catch (err) {
      return {};
    }
  }

  /**
   * Staff Mapping: every RetailPilot user id the pulled reports name, with
   * what they did and where (stores, lines, first and last day), and the
   * employee it is mapped to; plus the active employees to choose from.
   */
  async staff() {
    const [work, map, employees] = await Promise.all([this.repo.staffWork(), this.repo.staffMap(), this.repo.employeeChoices()]);
    const byId = new Map();
    for (const w of work) {
      for (const id of String(w.worked_by).split(",").map((x) => x.trim()).filter(Boolean)) {
        const s = byId.get(id) || { rp_user_id: id, lines: 0, stages: {}, stores: {}, first_date: null, last_date: null };
        s.lines += w.lines;
        s.stages[w.report_type] = (s.stages[w.report_type] || 0) + w.lines;
        if (w.store) s.stores[w.store] = (s.stores[w.store] || 0) + w.lines;
        if (!s.first_date || w.first_date < s.first_date) s.first_date = w.first_date;
        if (!s.last_date || w.last_date > s.last_date) s.last_date = w.last_date;
        byId.set(id, s);
      }
    }
    for (const m of map) if (!byId.has(m.rp_user_id)) byId.set(m.rp_user_id, { rp_user_id: m.rp_user_id, lines: 0, stages: {}, stores: {}, first_date: null, last_date: null });
    const mapped = new Map(map.map((m) => [m.rp_user_id, m]));
    const staff = [...byId.values()]
      .map((s) => {
        const m = mapped.get(s.rp_user_id);
        return {
          ...s,
          main_store: Object.entries(s.stores).sort((a, b) => b[1] - a[1])[0]?.[0] || null,
          employee_id: (m && m.employee_id) || null,
          employee_name: (m && m.employee_name) || null,
          note: (m && m.note) || null,
          updated_by_name: (m && m.updated_by_name) || null,
          updated_at: m && m.updated_at ? new Date(m.updated_at).toISOString() : null,
        };
      })
      .sort((a, b) => Number(Boolean(a.employee_id)) - Number(Boolean(b.employee_id)) || b.lines - a.lines);
    return { code: 200, data: { staff, employees } };
  }

  async mapStaff({ rp_user_id, employee_id, note, updated_by }) {
    const id = String(rp_user_id || "").trim();
    if (!id || id.length > 100) return { code: 422, msg: "Invalid RetailPilot user" };
    const emp = employee_id == null || employee_id === "" ? null : Number(employee_id);
    if (emp !== null && (!Number.isInteger(emp) || emp <= 0)) return { code: 422, msg: "Choose an employee" };
    await this.repo.setStaffMap({ rp_user_id: id, employee_id: emp, note: note ? String(note).slice(0, 255) : null, updated_by: updated_by || null });
    return { code: 200, data: { rp_user_id: id, employee_id: emp } };
  }

  /** What was uploaded for each day in the range. */
  async status({ from, to }) {
    const r = this._range(from, to);
    if (r.error) return { code: 422, msg: r.error };
    return { code: 200, data: { from: r.from, to: r.to, today: this.today(), report_types: W.REPORT_TYPES, uploads: await this.repo.uploads(r.from, r.to) } };
  }

  async deleteUpload({ upload_id }) {
    const id = Number(upload_id);
    if (!Number.isInteger(id) || id <= 0) return { code: 422, msg: "Invalid upload" };
    const ok = await this.repo.deleteUpload(id);
    return ok ? { code: 200, data: { upload_id: id } } : { code: 404, msg: "Upload not found" };
  }

  /** Rows of Picking / Packing / Verification, for the downloads. */
  async rows({ from, to, report_type = null, only = "all", store = null }) {
    const r = this._range(from, to);
    if (r.error) return { code: 422, msg: r.error };
    const type = report_type ? String(report_type).toUpperCase() : null;
    if (type && !W.JOB_TYPES.includes(type)) return { code: 422, msg: "Rows are for Picking, Packing or Verification" };
    if (!["all", "short", "open", "returned"].includes(only)) return { code: 422, msg: "Invalid filter" };
    const rows = await this.repo.jobRows(r.from, r.to, { report_type: type, only, store: store || null });
    return { code: 200, data: { from: r.from, to: r.to, rows } };
  }

  /** Loading against Unloading for the range: every box line with its status. */
  async _boxes(from, to, store) {
    // Loaded the day before `from` can be unloaded on `from`; unloaded the day after `to` can close a box loaded on `to`.
    const [loaded, unloaded, lastUnload] = await Promise.all([
      this.repo.boxLines("LOADING", W.addDays(from, -1), to, { store }),
      this.repo.boxLines("UNLOADING", W.addDays(from, -1), W.addDays(to, 1), { store }),
      this.repo.lastUploadDate("UNLOADING", W.addDays(to, 1)),
    ]);
    return W.reconcileBoxes(loaded, unloaded, { lastUnloadDate: lastUnload }).filter((l) =>
      l.status === "NOT_LOADED" ? l.report_date >= from && l.report_date <= to : l.report_date >= from
    );
  }

  async analysis({ from, to, store = null }) {
    const r = this._range(from, to);
    if (r.error) return { code: 422, msg: r.error };
    const opts = { store: store || null };
    const [summary, byStore, storeJob, byDepartment, byJobType, daily, storeList, articles, uploads, lines, byWorker] = await Promise.all([
      this.repo.jobBreakdown(r.from, r.to, ["report_type"], opts),
      this.repo.jobBreakdown(r.from, r.to, ["report_type", "to_store"], opts),
      this.repo.jobBreakdown(r.from, r.to, ["report_type", "to_store", "job_type"], opts),
      this.repo.jobBreakdown(r.from, r.to, ["report_type", "department"], opts),
      this.repo.jobBreakdown(r.from, r.to, ["report_type", "job_type"], opts),
      this.repo.jobBreakdown(r.from, r.to, ["report_date", "report_type"], opts),
      this.repo.jobBreakdown(r.from, r.to, ["to_store"]),
      this.repo.shortArticles(r.from, r.to, opts, 500),
      this.repo.uploads(r.from, r.to),
      this._boxes(r.from, r.to, opts.store),
      this.repo.jobBreakdown(r.from, r.to, ["report_type", "worked_by"], opts),
    ]);
    const staffNames = await this._staffNames();

    // Box totals by status, per truck and day, and per day.
    const byStatus = {};
    for (const l of lines) {
      const s = (byStatus[l.status] = byStatus[l.status] || { status: l.status, lines: 0, boxes: new Set(), qty: 0, value: 0 });
      s.lines += 1;
      s.boxes.add(`${l.report_date}|${l.box_id}`);
      const q = l.loaded_qty == null ? l.unloaded_qty : l.loaded_qty;
      s.qty += q || 0;
      s.value += (q || 0) * (l.nlc || 0);
    }
    const trucks = new Map();
    const boxDaily = new Map();
    for (const l of lines) {
      const tk = `${l.report_date}|${l.truck_no || "-"}`;
      if (!trucks.has(tk)) {
        trucks.set(tk, {
          report_date: l.report_date, truck_no: l.truck_no || null, boxes: new Set(), stores: new Set(), lines: 0,
          loaded_qty: 0, unloaded_qty: 0, issues: 0, returns: 0, loaded_by: new Set(), unloaded_by: new Set(), first_loaded_at: null, last_loaded_at: null,
          first_unloaded_at: null, last_unloaded_at: null,
        });
      }
      const t = trucks.get(tk);
      t.boxes.add(l.box_id);
      if (l.planned_to_store && l.status !== "RETURN") t.stores.add(l.planned_to_store);
      t.lines += 1;
      for (const u of String(l.loaded_by || "").split(",").map((x) => x.trim()).filter(Boolean)) t.loaded_by.add(u);
      for (const u of String(l.unloaded_by || "").split(",").map((x) => x.trim()).filter(Boolean)) t.unloaded_by.add(u);
      t.loaded_qty += l.loaded_qty || 0;
      t.unloaded_qty += l.unloaded_qty || 0;
      if (BOX_ISSUES.includes(l.status) && l.status !== "OPEN") t.issues += 1;
      if (l.status === "RETURN") t.returns += 1;
      t.first_loaded_at = minOf(t.first_loaded_at, l.loaded_at);
      t.last_loaded_at = maxOf(t.last_loaded_at, l.loaded_at);
      t.first_unloaded_at = minOf(t.first_unloaded_at, l.unloaded_at);
      t.last_unloaded_at = maxOf(t.last_unloaded_at, l.unloaded_at);

      const d = boxDaily.get(l.report_date) || { report_date: l.report_date, boxes: new Set(), issue_lines: 0 };
      d.boxes.add(l.box_id);
      if (BOX_ISSUES.includes(l.status) && l.status !== "OPEN") d.issue_lines += 1;
      boxDaily.set(l.report_date, d);
    }

    // Store funnel: quantity through each step, per store and job type.
    const funnel = new Map();
    const cell = (s, j) => {
      const k = `${s || "-"}|${j || "-"}`;
      if (!funnel.has(k)) funnel.set(k, { store: s || null, job_type: j || null, picked: 0, packed: 0, loaded: 0, unloaded: 0, verified: 0, picking_short: 0, verification_short: 0 });
      return funnel.get(k);
    };
    for (const row of storeJob) {
      const c = cell(row.to_store, row.job_type);
      if (row.report_type === "PICKING") {
        c.picked += row.actual_qty;
        c.picking_short += row.short_qty;
      } else if (row.report_type === "PACKING") c.packed += row.actual_qty;
      else if (row.report_type === "VERIFICATION") {
        c.verified += row.actual_qty;
        c.verification_short += row.short_qty;
      }
    }
    for (const l of lines) {
      if (l.status === "RETURN") continue;
      if (l.loaded_qty != null) cell(l.planned_to_store, l.job_type).loaded += l.loaded_qty;
      if (l.unloaded_qty != null) cell(l.unloaded_store || l.planned_to_store, l.job_type).unloaded += l.unloaded_qty;
    }
    // A store filter keeps rows of other stores out of the funnel (a wrong-store box can name one).
    const funnelRows = [...funnel.values()].filter((f) => !opts.store || f.store === opts.store);

    return {
      code: 200,
      data: {
        from: r.from,
        to: r.to,
        store: opts.store,
        stores: storeList.map((s) => s.to_store).filter(Boolean),
        uploads,
        summary,
        by_store: byStore,
        by_department: byDepartment,
        by_job_type: byJobType,
        by_worker: byWorker,
        staff_names: staffNames,
        daily,
        short_articles: articles,
        funnel: funnelRows.sort((a, b) => String(a.store).localeCompare(String(b.store)) || String(a.job_type).localeCompare(String(b.job_type))),
        boxes: {
          by_status: Object.values(byStatus).map((s) => ({ ...s, boxes: s.boxes.size, qty: round2(s.qty), value: round2(s.value) })),
          trucks: [...trucks.values()]
            .map((t) => ({ ...t, boxes: t.boxes.size, stores: [...t.stores].sort().join(", "), loaded_by: [...t.loaded_by].sort().join(", "), unloaded_by: [...t.unloaded_by].sort().join(", ") }))
            .sort((a, b) => b.report_date.localeCompare(a.report_date) || String(a.truck_no).localeCompare(String(b.truck_no))),
          daily: [...boxDaily.values()].map((d) => ({ ...d, boxes: d.boxes.size })).sort((a, b) => a.report_date.localeCompare(b.report_date)),
          issues: lines.filter((l) => BOX_ISSUES.includes(l.status)).slice(0, 5000),
          returns: lines.filter((l) => l.status === "RETURN").slice(0, 5000),
        },
      },
    };
  }
}

module.exports = (repo, today, spectra) => new WhDailyReports(repo, today, spectra);
module.exports.MAX_RANGE_DAYS = MAX_RANGE_DAYS;
