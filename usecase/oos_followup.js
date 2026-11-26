const logger = require("../utils/logger");
const O = require("../utils/oos_followup");
const { istToday } = require("../utils/istDate");

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Out-of-stock follow-up (utils/oos_followup.js).
 *
 *   upload   the morning report -> cases (supplier and buyer from DNDS,
 *            warehouse stock from the latest RetailPilot stock sync, PO status
 *            from the PO Tracker)
 *   view     the chaser's scoreboard and lines, or a buyer's own lines
 *   answer   a buyer's reason and/or a note on a line
 *
 * Lists: "chase" = tier 1, and tier 2 once out AGEING_DAYS days; "waiting" =
 * tier 2 not yet that old; "review" = tier 3 (slow moving).
 */
class OosFollowup {
  /**
   * @param repo        repository/oos_followup.js
   * @param poTracker   usecase/po_tracker.js (list())
   * @param options.warehouseOutletId  DNDS outlet of the warehouse
   */
  constructor(repo, poTracker, { warehouseOutletId = 2, today = () => istToday() } = {}) {
    this.repo = repo;
    this.poTracker = poTracker;
    this.warehouseOutletId = warehouseOutletId;
    this.today = today;
    this.uploading = false;
  }

  async upload({ rows, fileName, reportDate, employeeId }) {
    if (this.uploading) return { code: 409, msg: "An out-of-stock upload is already running" };
    this.uploading = true;
    try {
      const date = reportDate || O.reportDateFromFileName(fileName) || this.today();
      if (!DAY.test(date)) return { code: 422, msg: "Report date must be YYYY-MM-DD" };
      if (date > this.today()) return { code: 422, msg: `Report date ${date} is in the future` };
      const latest = await this.repo.latestReportDate();
      if (latest && date < latest) {
        return { code: 409, msg: `The ${latest} report is already uploaded; an older report (${date}) cannot replace it` };
      }

      const { rows: clean, skipped } = O.cleanRows(rows);
      if (!clean.length) return { code: 422, msg: "No usable lines in the file (each needs an Article ID and a Store)" };

      const warnings = [];
      const [enrichment, warehouseStock, outlets] = await Promise.all([
        this.repo.enrichment(clean.map((r) => r.article_id)),
        this.repo.warehouseStock(this.warehouseOutletId),
        this.repo.outlets(),
      ]);
      const storeKeyOfSlug = new Map(
        outlets.filter((o) => o.retailpilot_id).map((o) => [String(o.retailpilot_id).trim(), O.storeKeyOfOutlet(o, this.warehouseOutletId)])
      );
      let poByStoreSupplier = new Map();
      try {
        const po = this.poTracker ? await this.poTracker.list({ refresh: true }) : { code: 503, msg: "not wired" };
        if (po.code === 200) poByStoreSupplier = O.poByStoreSupplier(po.data.orders, storeKeyOfSlug);
        else warnings.push(`PO Tracker unavailable (${po.msg}) - PO status not checked`);
      } catch (err) {
        warnings.push(`PO Tracker unavailable (${err.message}) - PO status not checked`);
      }
      const unknownStores = [...new Set(clean.map((r) => r.store))].filter((s) => ![...storeKeyOfSlug.values()].includes(s));
      if (unknownStores.length) warnings.push(`Store(s) not matched to a DNDS outlet, so no PO status for them: ${unknownStores.join(", ")}`);
      const noProduct = clean.filter((r) => !enrichment.has(r.article_id)).length;
      if (noProduct) warnings.push(`${noProduct} line(s) whose article is not in DNDS products - no supplier or buyer`);

      const lines = O.buildLines(clean, { reportDate: date, enrichment, warehouseStock, poByStoreSupplier });
      const plan = O.planCases(lines, await this.repo.existingFor(date), date);
      const saved = await this.repo.applyUpload({
        reportDate: date,
        fileName,
        plan,
        skipped: skipped.length,
        warnings,
        uploadedBy: employeeId,
      });

      const count = (f) => lines.filter(f).length;
      return {
        code: 200,
        upload_id: saved.upload_id,
        report_date: date,
        lines: lines.length,
        opened: plan.insert.length + plan.update.filter((u) => u.reopen).length,
        still_out: plan.update.filter((u) => !u.reopen).length,
        back_in_stock: plan.close.length,
        tiers: { daily: count((l) => l.tier === 1), ageing: count((l) => l.tier === 2), review: count((l) => l.tier === 3) },
        causes: Object.fromEntries(["warehouse_stock", "po_pending", "no_po", "no_supplier"].map((c) => [c, count((l) => l.cause === c)])),
        no_buyer: count((l) => l.buyer_id == null),
        skipped: skipped.slice(0, 50),
        skipped_count: skipped.length,
        warnings,
      };
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.OOS_FOLLOWUP",
        code: "USECASE.OOS_FOLLOWUP.UPLOAD",
        description: err.toString(),
        category: "",
        ref: {},
      });
      return { code: 500, msg: err.message };
    } finally {
      this.uploading = false;
    }
  }

  /** A case as the lists show it, with its list, days out and flags. */
  _out(c, reportDate) {
    const daysOut = (O.daysBetween(c.opened_on, reportDate) ?? 0) + 1;
    const list = c.tier === 1 ? "chase" : c.tier === 3 ? "review" : daysOut >= O.AGEING_DAYS ? "chase" : "waiting";
    return {
      id: c.oos_case_id,
      article_id: c.article_id,
      article_name: c.article_name,
      category: c.category,
      class: c.class,
      store: c.store,
      mrp: c.mrp == null ? null : Number(c.mrp),
      planned: c.planned == null ? null : Number(c.planned),
      value: c.value == null ? 0 : Number(c.value),
      supplier_cid: c.supplier_cid,
      supplier_name: c.supplier_name,
      buyer_id: c.buyer_id,
      buyer_name: c.buyer_name,
      cause: c.cause,
      cause_detail: c.cause_detail,
      po_slug: c.po_slug,
      tier: c.tier,
      stores_out: c.stores_out,
      opened_on: c.opened_on,
      days_out: daysOut,
      is_new: c.opened_on === reportDate,
      list,
      reason: c.reason,
      reason_by_name: c.reason_by_name,
      reason_at: c.reason_at,
      last_note: c.last_note,
      last_note_by_name: c.last_note_by_name,
      last_note_at: c.last_note_at,
      needs_update: list === "chase" && !c.reason,
    };
  }

  /**
   * @param canChase  the chaser: every buyer (buyerId narrows to one, "none" =
   *                  lines with no buyer) and the scoreboard
   * otherwise       the logged-in buyer's own lines
   */
  async view({ employeeId, canChase, buyerId = null, includeHidden = false }) {
    const upload = await this.repo.latestUpload();
    if (!upload) return { code: 200, data: { upload: null, report_date: null, cases: [], scoreboard: null } };
    const reportDate = upload.report_date;
    if (!canChase && !employeeId) return { code: 403, msg: "Only an employee login has its own out-of-stock list" };

    const scope = canChase ? buyerId : employeeId;
    const rows = await this.repo.openCases({ buyerId: scope, includeHidden, hiding: O.HIDING_REASONS });
    const cases = rows.map((c) => this._out(c, reportDate));

    let scoreboard = null;
    if (canChase) {
      const all = buyerId == null ? cases : (await this.repo.openCases({ hiding: O.HIDING_REASONS })).map((c) => this._out(c, reportDate));
      const back = new Map((await this.repo.closedOn(reportDate)).map((r) => [r.buyer_id == null ? "none" : Number(r.buyer_id), Number(r.n)]));
      scoreboard = this._scoreboard(all, back);
    }
    return {
      code: 200,
      data: {
        upload: {
          report_date: reportDate,
          file_name: upload.file_name,
          uploaded_at: upload.created_at,
          uploaded_by: upload.uploaded_by_name,
          warnings: upload.warnings ? String(upload.warnings).split("\n") : [],
        },
        report_date: reportDate,
        ageing_days: O.AGEING_DAYS,
        cases,
        scoreboard,
      },
    };
  }

  /** One row per buyer (and one for lines with no buyer). */
  _scoreboard(cases, backInStock) {
    const rows = new Map();
    for (const c of cases) {
      const key = c.buyer_id == null ? "none" : c.buyer_id;
      if (!rows.has(key)) {
        rows.set(key, {
          buyer_id: c.buyer_id,
          buyer_name: c.buyer_id == null ? "No buyer" : c.buyer_name || `Employee ${c.buyer_id}`,
          to_chase: 0,
          class_a: 0,
          value_to_chase: 0,
          not_updated: 0,
          new_today: 0,
          oldest_days: 0,
          review: 0,
          open: 0,
          back_in_stock: 0,
        });
      }
      const r = rows.get(key);
      r.open += 1;
      if (c.list === "chase") {
        r.to_chase += 1;
        r.value_to_chase += c.value;
        if (c.class === "A") r.class_a += 1;
        if (c.needs_update) r.not_updated += 1;
        r.oldest_days = Math.max(r.oldest_days, c.days_out);
      }
      if (c.list === "review") r.review += 1;
      if (c.is_new) r.new_today += 1;
    }
    for (const [key, n] of backInStock) {
      if (rows.has(key)) rows.get(key).back_in_stock = n;
    }
    return [...rows.values()]
      .map((r) => ({ ...r, value_to_chase: Math.round(r.value_to_chase) }))
      .sort((a, b) => (a.buyer_id == null) - (b.buyer_id == null) || b.value_to_chase - a.value_to_chase);
  }

  async _allowed(id, employeeId, canChase) {
    const c = await this.repo.getCase(id);
    if (!c) return { error: { code: 404, msg: "This line no longer exists" } };
    if (!canChase && (employeeId == null || Number(c.buyer_id) !== Number(employeeId))) {
      return { error: { code: 403, msg: "This line belongs to another buyer" } };
    }
    return { c };
  }

  async answer({ id, reason, note, employeeId, canChase }) {
    const text = note == null ? "" : String(note).trim();
    if (reason && !O.REASONS.includes(reason)) return { code: 422, msg: "Unknown reason" };
    if (!reason && !text) return { code: 422, msg: "Choose a reason or write a note" };
    if (!employeeId) return { code: 403, msg: "Only an employee login can update a line" };
    const { c, error } = await this._allowed(id, employeeId, canChase);
    if (error) return error;
    if (c.status !== "open") return { code: 409, msg: "This item is back in stock; the line is closed" };
    await this.repo.addEvent(id, { reason: reason || null, note: text ? text.slice(0, 500) : null, employeeId });
    return { code: 200, msg: "Saved" };
  }

  /**
   * One answer for several lines - an item out in several stores is answered
   * once. Every line is checked first; nothing is saved unless all may be.
   */
  async answerMany({ ids, reason, note, employeeId, canChase }) {
    const list = [...new Set((ids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (!list.length) return { code: 422, msg: "No lines chosen" };
    const text = note == null ? "" : String(note).trim();
    if (reason && !O.REASONS.includes(reason)) return { code: 422, msg: "Unknown reason" };
    if (!reason && !text) return { code: 422, msg: "Choose a reason or write a note" };
    if (!employeeId) return { code: 403, msg: "Only an employee login can update a line" };
    for (const id of list) {
      const { c, error } = await this._allowed(id, employeeId, canChase);
      if (error) return error;
      if (c.status !== "open") return { code: 409, msg: "One of these stores is back in stock; refresh and try again" };
    }
    for (const id of list) {
      await this.repo.addEvent(id, { reason: reason || null, note: text ? text.slice(0, 500) : null, employeeId });
    }
    return { code: 200, msg: "Saved", saved: list.length };
  }

  async events({ id, employeeId, canChase }) {
    const { error } = await this._allowed(id, employeeId, canChase);
    if (error) return error;
    return { code: 200, data: await this.repo.events(id) };
  }
}

module.exports = (repo, poTracker, options) => new OosFollowup(repo, poTracker, options);
