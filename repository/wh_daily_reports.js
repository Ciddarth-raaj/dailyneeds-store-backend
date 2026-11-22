const logger = require("../utils/logger");
const {
  queryAsync,
  getConnectionAsync,
  beginTransactionAsync,
  commitAsync,
  rollbackAsync,
  insertRowsInBatches,
} = require("../utils/batchInsert");

/**
 * Storage for Warehouse Daily Reports (wh_report_uploads, wh_report_job_rows,
 * wh_report_box_rows). One upload per report per day; saving it again
 * replaces the old one and its rows in one transaction.
 *
 * Dates come back as YYYY-MM-DD text and times as "YYYY-MM-DD HH:MM:SS"
 * text (IST, as RetailPilot wrote them), so no server time zone shifts them.
 * Sums come back as numbers.
 */
const JOB_COLS = [
  "upload_id", "report_type", "report_date", "job_type", "from_store", "to_store", "article_id", "article_name",
  "department", "category", "recommended_qty", "planned_qty", "advised_qty", "actual_qty", "short_qty",
  "returned_qty", "jobs", "open_jobs", "nlc", "nlc_source", "job_id", "worked_by", "stage_id", "picking_job", "packing_job", "loading_job", "unloading_job", "job_state", "finished_at",
];
const BOX_COLS = [
  "upload_id", "report_type", "report_date", "job_type", "from_store", "planned_to_store", "unloaded_store",
  "box_id", "box_kind", "truck_no", "article_id", "article_name", "department", "category", "nlc", "box_qty",
  "box_status", "finished_at", "job_id", "stage_id", "picking_job", "packing_job", "packing_jobs", "worked_by",
];
/** The Pick & Pack pages a report's write-off goes to. */
const PAGES = {
  VERIFICATION: { table: "pick_pack_verifications", id: "pick_pack_verification_id", jobType: true, employee: false },
  WRITE_OFF: { table: "pick_pack_write_off", id: "pick_pack_write_off_id", jobType: false, employee: true },
};
/** Columns a job breakdown may group by. */
const JOB_DIMS = ["report_type", "report_date", "to_store", "job_type", "department", "category", "worked_by"];

const n = (v) => (v == null ? null : Number(v));
const toNumbers = (rows, keys) =>
  rows.map((r) => {
    const out = { ...r };
    for (const k of keys) if (k in out) out[k] = n(out[k]);
    return out;
  });

const JOB_METRICS = `
  COUNT(*) AS \`lines\`,
  COUNT(DISTINCT r.article_id) AS articles,
  COUNT(DISTINCT r.report_date) AS days,
  COALESCE(SUM(r.planned_qty), 0) AS planned_qty,
  COALESCE(SUM(r.actual_qty), 0) AS actual_qty,
  SUM(r.short_qty > 0) AS short_lines,
  COALESCE(SUM(r.short_qty), 0) AS short_qty,
  COALESCE(SUM(r.short_qty * r.nlc), 0) AS short_value,
  COALESCE(SUM(r.actual_qty * r.nlc), 0) AS actual_value,
  SUM(COALESCE(r.open_jobs, 0) = 0) AS done_lines,
  SUM(r.short_qty > 0 AND r.nlc IS NULL) AS short_unpriced_lines,
  SUM(COALESCE(r.returned_qty, 0) > 0) AS returned_lines,
  COALESCE(SUM(r.returned_qty), 0) AS returned_qty,
  SUM(COALESCE(r.open_jobs, 0) > 0) AS open_lines,
  COALESCE(SUM(r.open_jobs), 0) AS open_jobs`;
const JOB_METRIC_KEYS = [
  "lines", "articles", "days", "planned_qty", "actual_qty", "short_lines", "short_qty", "short_value", "actual_value", "done_lines",
  "short_unpriced_lines", "returned_lines", "returned_qty", "open_lines", "open_jobs",
];

class WhDailyReportsRepository {
  constructor(db) {
    this.db = db;
  }

  run(code, sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.query(sql, params, (err, result) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.WH_DAILY_REPORTS",
            code: `REPOSITORY.WH_DAILY_REPORTS.${code}`,
            description: err.toString(),
            category: "",
            ref: {},
          });
          reject(err);
          return;
        }
        resolve(result);
      });
    });
  }

  /** Articles in from..to whose rows have no NLC yet (both report shapes). */
  async unpricedArticles(from, to) {
    const rows = await this.run(
      "UNPRICED_ARTICLES",
      `SELECT DISTINCT article_id FROM wh_report_job_rows WHERE report_date BETWEEN ? AND ? AND nlc IS NULL
       UNION SELECT DISTINCT article_id FROM wh_report_box_rows WHERE report_date BETWEEN ? AND ? AND nlc IS NULL`,
      [from, to, from, to]
    );
    return rows.map((r) => Number(r.article_id));
  }

  /** Fill in NLC on rows in from..to that have none, from `prices` (article id -> NLC). Answers rows updated. */
  async fillNlc(from, to, prices) {
    let updated = 0;
    const entries = [...prices.entries()];
    for (let i = 0; i < entries.length; i += 500) {
      const chunk = entries.slice(i, i + 500);
      const cases = chunk.map(() => "WHEN ? THEN ?").join(" ");
      const params = chunk.flat();
      const ids = chunk.map(([id]) => id);
      const job = await this.run(
        "FILL_NLC_JOB",
        `UPDATE wh_report_job_rows SET nlc = CASE article_id ${cases} END, nlc_source = 'RETAILPILOT'
          WHERE report_date BETWEEN ? AND ? AND nlc IS NULL AND article_id IN (?)`,
        [...params, from, to, ids]
      );
      const box = await this.run(
        "FILL_NLC_BOX",
        `UPDATE wh_report_box_rows SET nlc = CASE article_id ${cases} END
          WHERE report_date BETWEEN ? AND ? AND nlc IS NULL AND article_id IN (?)`,
        [...params, from, to, ids]
      );
      updated += job.affectedRows + box.affectedRows;
    }
    return updated;
  }

  /**
   * Put a report's write-off on its Pick & Pack page for the day, one line
   * per article (and job type, on Verification) and store, inside the
   * upload's transaction:
   *
   *   VERIFICATION report -> pick_pack_verifications (Pick & Pack > Verification)
   *   PICKING report      -> pick_pack_write_off     (Pick & Pack > Write Off)
   *
   * The team's work is kept:
   *   - a line already there for the same article (job type) and store: an
   *     unverified one takes the new quantity and keeps its remark, a
   *     verified one is left alone;
   *   - a line from before stores were kept (store NULL, stores summed) for
   *     the same article (job type): an unverified one becomes the first
   *     store's line, keeping its remark; a verified one stands for all the
   *     article's stores, and none are added;
   *   - otherwise a new line is added;
   *   - a line this sync wrote earlier (it has a store) that is no longer in
   *     the report is removed - but only if nobody has touched it: no remark,
   *     no staff member, not verified. A corrected report so takes its wrong
   *     lines away, and the team's work stays.
   *
   * Articles not in product_table cannot be added (foreign key) and are counted.
   */
  async _syncPageLines(conn, page, date, writeOffs) {
    const cfg = PAGES[page];
    const out = { added: 0, updated: 0, unchanged: 0, kept_verified: 0, unknown_articles: 0, removed: 0 };
    const ids = [...new Set(writeOffs.map((w) => w.product_id))];
    const known = ids.length
      ? new Set((await queryAsync(conn, "SELECT product_id FROM product_table WHERE product_id IN (?)", [ids])).map((r) => Number(r.product_id)))
      : new Set();
    const existing = await queryAsync(
      conn,
      `SELECT ${cfg.id} AS id, product_id, ${cfg.jobType ? "job_type" : "NULL AS job_type"}, store, mismatch_qty, is_verified,
              remark_id, remark_str, ${cfg.employee ? "reason_employee_id" : "NULL AS reason_employee_id"}
         FROM ${cfg.table} WHERE date = ? ORDER BY ${cfg.id}`,
      [date]
    );
    const artKey = (r) => (cfg.jobType ? `${Number(r.product_id)}|${r.job_type}` : `${Number(r.product_id)}`);
    const byStore = new Map();
    const legacy = new Map();
    for (const e of existing) {
      const isLegacy = e.store == null || e.store === "";
      const map = isLegacy ? legacy : byStore;
      const k = isLegacy ? artKey(e) : `${artKey(e)}|${e.store}`;
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(e);
    }
    const inserts = [];
    const setQty = async (row, qty, store) => {
      if (Number(row.mismatch_qty) === qty && (store === undefined || row.store === store)) {
        out.unchanged += 1;
        return;
      }
      await queryAsync(
        conn,
        `UPDATE ${cfg.table} SET mismatch_qty = ?${store === undefined ? "" : ", store = ?"}, updated_at = CURRENT_TIMESTAMP WHERE ${cfg.id} = ?`,
        store === undefined ? [qty, row.id] : [qty, store, row.id]
      );
      out.updated += 1;
    };
    for (const w of writeOffs) {
      if (!known.has(Number(w.product_id))) {
        out.unknown_articles += 1;
        continue;
      }
      const art = artKey(w);
      const same = (byStore.get(`${art}|${w.store}`) || []).filter((e) => !e.claimed);
      if (same.length) {
        same[0].claimed = true;
        const open = same.find((e) => !Number(e.is_verified));
        if (!open) out.kept_verified += 1;
        else await setQty(open, w.mismatch_qty);
        continue;
      }
      const old = legacy.get(art) || [];
      if (old.some((e) => Number(e.is_verified))) {
        out.kept_verified += 1;
        continue;
      }
      const reuse = old.find((e) => !e.claimed);
      if (reuse) {
        reuse.claimed = true;
        await setQty(reuse, w.mismatch_qty, w.store);
        continue;
      }
      inserts.push(cfg.jobType ? [w.product_id, w.mismatch_qty, date, w.job_type, w.store, 0] : [w.product_id, w.mismatch_qty, date, w.store, 0]);
    }
    // Lines this sync wrote that the report no longer has, untouched by the team.
    const untouched = (e) =>
      !e.claimed && !Number(e.is_verified) && e.remark_id == null && !String(e.remark_str || "").trim() && e.reason_employee_id == null;
    const gone = [...byStore.values()].flat().filter(untouched).map((e) => e.id);
    if (gone.length) {
      await queryAsync(conn, `DELETE FROM ${cfg.table} WHERE ${cfg.id} IN (?)`, [gone]);
      out.removed = gone.length;
    }
    if (inserts.length) {
      const cols = cfg.jobType ? "product_id, mismatch_qty, date, job_type, store, is_verified" : "product_id, mismatch_qty, date, store, is_verified";
      await queryAsync(conn, `INSERT INTO ${cfg.table} (${cols}) VALUES ?`, [inserts]);
      out.added = inserts.length;
    }
    return out;
  }

  /**
   * Article name, department and category from the product master, for
   * reports pulled from RetailPilot (an uploaded file carries its own).
   */
  async productInfo(articleIds) {
    const ids = [...new Set((articleIds || []).map(Number).filter((x) => Number.isInteger(x) && x > 0))];
    const info = new Map();
    for (let i = 0; i < ids.length; i += 1000) {
      const rows = await this.run(
        "PRODUCT_INFO",
        `SELECT p.product_id, COALESCE(NULLIF(p.de_name, ''), p.gf_item_name) AS article_name,
                d.department_name AS department, c.category_name AS category
           FROM product_table p
           LEFT JOIN department d ON d.department_id = p.department_id
           LEFT JOIN categories c ON c.category_id = p.category_id
          WHERE p.product_id IN (?)`,
        [ids.slice(i, i + 1000)]
      );
      for (const r of rows) info.set(Number(r.product_id), { article_name: r.article_name || null, department: r.department || null, category: r.category || null });
    }
    return info;
  }

  /**
   * Save one report for one day, replacing what was there. With `pageLines`
   * ({ page: "VERIFICATION" | "WRITE_OFF", rows }) its write-off also goes to
   * that Pick & Pack page. Answers { upload_id, page }.
   */
  async replaceUpload({ report_type, report_date, file_name, uploaded_by, shape, rows, pageLines = null, source = "UPLOAD" }) {
    const conn = await getConnectionAsync(this.db);
    try {
      await beginTransactionAsync(conn);
      await queryAsync(conn, "DELETE FROM wh_report_uploads WHERE report_type = ? AND report_date = ?", [report_type, report_date]);
      const res = await queryAsync(
        conn,
        `INSERT INTO wh_report_uploads (report_type, report_date, source, file_name, row_count, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)`,
        [report_type, report_date, source, file_name || null, rows.length, uploaded_by || null]
      );
      const uploadId = res.insertId;
      const cols = shape === "JOB" ? JOB_COLS : BOX_COLS;
      const table = shape === "JOB" ? "wh_report_job_rows" : "wh_report_box_rows";
      const values = rows.map((r) => cols.map((c) => (c === "upload_id" ? uploadId : c === "report_date" ? report_date : r[c] === undefined ? null : r[c])));
      await insertRowsInBatches(conn, `INSERT INTO ${table} (${cols.join(", ")}) VALUES ?`, values, 2000);
      const page = pageLines ? await this._syncPageLines(conn, pageLines.page, report_date, pageLines.rows) : null;
      await commitAsync(conn);
      return { upload_id: uploadId, page };
    } catch (err) {
      await rollbackAsync(conn);
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "REPOSITORY.WH_DAILY_REPORTS",
        code: "REPOSITORY.WH_DAILY_REPORTS.REPLACE_UPLOAD",
        description: err.toString(),
        category: "",
        ref: { report_type, report_date },
      });
      throw err;
    } finally {
      conn.release();
    }
  }

  async uploads(from, to) {
    const rows = await this.run(
      "UPLOADS",
      `SELECT u.upload_id, u.report_type, DATE_FORMAT(u.report_date, '%Y-%m-%d') AS report_date, u.source, u.file_name, u.row_count,
              u.uploaded_by, e.employee_name AS uploaded_by_name, u.uploaded_at
         FROM wh_report_uploads u
         LEFT JOIN new_employee e ON e.employee_id = u.uploaded_by
        WHERE u.report_date BETWEEN ? AND ?
        ORDER BY u.report_date DESC, u.report_type`,
      [from, to]
    );
    return rows.map((r) => ({ ...r, row_count: n(r.row_count), uploaded_at: r.uploaded_at ? new Date(r.uploaded_at).toISOString() : null }));
  }

  async deleteUpload(uploadId) {
    const res = await this.run("DELETE_UPLOAD", "DELETE FROM wh_report_uploads WHERE upload_id = ?", [uploadId]);
    return res.affectedRows > 0;
  }

  _jobWhere(from, to, { store = null, report_type = null } = {}) {
    const where = ["r.report_date BETWEEN ? AND ?"];
    const params = [from, to];
    if (store) {
      where.push("r.to_store = ?");
      params.push(store);
    }
    if (report_type) {
      where.push("r.report_type = ?");
      params.push(report_type);
    }
    return { where: where.join(" AND "), params };
  }

  /** Picking / Packing / Verification totals grouped by `dims` (from JOB_DIMS). */
  async jobBreakdown(from, to, dims, opts = {}) {
    const by = (dims || []).filter((d) => JOB_DIMS.includes(d));
    const { where, params } = this._jobWhere(from, to, opts);
    const select = by.map((d) => (d === "report_date" ? "DATE_FORMAT(r.report_date, '%Y-%m-%d') AS report_date" : `r.${d}`));
    const rows = await this.run(
      "JOB_BREAKDOWN",
      `SELECT ${[...select, JOB_METRICS].join(", ")}
         FROM wh_report_job_rows r
        WHERE ${where}
        ${by.length ? `GROUP BY ${by.map((d) => `r.${d}`).join(", ")}` : ""}`,
      params
    );
    return toNumbers(rows, JOB_METRIC_KEYS);
  }

  /** Articles written off (Short Qty > 0), per report, worst first. */
  async shortArticles(from, to, opts = {}, limit = 1000) {
    const { where, params } = this._jobWhere(from, to, opts);
    const rows = await this.run(
      "SHORT_ARTICLES",
      `SELECT r.report_type, r.article_id, MAX(r.article_name) AS article_name, MAX(r.department) AS department,
              MAX(r.category) AS category,
              COUNT(DISTINCT r.report_date) AS days_short, COUNT(*) AS \`lines\`,
              GROUP_CONCAT(DISTINCT r.to_store ORDER BY r.to_store SEPARATOR ', ') AS stores,
              COALESCE(SUM(r.short_qty), 0) AS short_qty, COALESCE(SUM(r.short_qty * r.nlc), 0) AS short_value,
              MAX(r.nlc) AS nlc, DATE_FORMAT(MAX(r.report_date), '%Y-%m-%d') AS last_short_date
         FROM wh_report_job_rows r
        WHERE ${where} AND r.short_qty > 0
        GROUP BY r.report_type, r.article_id
        ORDER BY days_short DESC, short_value DESC, short_qty DESC
        LIMIT ?`,
      [...params, limit]
    );
    return toNumbers(rows, ["days_short", "lines", "short_qty", "short_value", "nlc"]);
  }

  /** Rows of the job reports: every row, only write-offs (short), or only rows with open jobs. */
  async jobRows(from, to, { only = "all", ...opts } = {}, limit = 50000) {
    const { where, params } = this._jobWhere(from, to, opts);
    const extra = only === "short" ? " AND r.short_qty > 0" : only === "open" ? " AND COALESCE(r.open_jobs, 0) > 0" : only === "returned" ? " AND COALESCE(r.returned_qty, 0) > 0" : "";
    const rows = await this.run(
      "JOB_ROWS",
      `SELECT r.report_type, DATE_FORMAT(r.report_date, '%Y-%m-%d') AS report_date, r.job_type, r.from_store, r.to_store,
              r.article_id, r.article_name, r.department, r.category, r.recommended_qty, r.planned_qty, r.advised_qty,
              r.actual_qty, r.short_qty, r.returned_qty, r.jobs, r.open_jobs, r.nlc, r.nlc_source,
              r.short_qty * r.nlc AS short_value, r.job_id, r.worked_by, r.stage_id,
              DATE_FORMAT(r.finished_at, '%Y-%m-%d %H:%i') AS finished_at
         FROM wh_report_job_rows r
        WHERE ${where}${extra}
        ORDER BY r.report_date DESC, r.report_type, r.to_store, short_value DESC, r.article_id
        LIMIT ?`,
      [...params, limit]
    );
    return toNumbers(rows, ["recommended_qty", "planned_qty", "advised_qty", "actual_qty", "short_qty", "returned_qty", "jobs", "open_jobs", "nlc", "short_value"]);
  }

  /**
   * Loading or Unloading, one row per (day, box, article) with the quantity
   * summed (an article can sit in one box at several MRPs).
   */
  async boxLines(reportType, from, to, { store = null } = {}) {
    const params = [reportType, from, to];
    let storeSql = "";
    if (store) {
      storeSql = " AND (r.planned_to_store = ? OR r.unloaded_store = ?)";
      params.push(store, store);
    }
    const rows = await this.run(
      "BOX_LINES",
      `SELECT DATE_FORMAT(r.report_date, '%Y-%m-%d') AS report_date, r.box_id, r.article_id,
              MAX(r.article_name) AS article_name, MAX(r.box_kind) AS box_kind, MAX(r.job_type) AS job_type,
              MAX(r.from_store) AS from_store, MAX(r.planned_to_store) AS planned_to_store,
              MAX(r.unloaded_store) AS unloaded_store, MAX(r.truck_no) AS truck_no,
              SUM(r.box_qty) AS box_qty, SUM(r.box_qty * r.nlc) / NULLIF(SUM(CASE WHEN r.nlc IS NULL THEN 0 ELSE r.box_qty END), 0) AS nlc,
              DATE_FORMAT(MAX(r.finished_at), '%Y-%m-%d %H:%i:%s') AS finished_at, MAX(r.worked_by) AS worked_by
         FROM wh_report_box_rows r
        WHERE r.report_type = ? AND r.report_date BETWEEN ? AND ?${storeSql}
        GROUP BY r.report_date, r.box_id, r.article_id
        ORDER BY r.report_date, r.box_id, r.article_id`,
      params
    );
    return toNumbers(rows, ["box_qty", "nlc"]);
  }

  /**
   * The box chain (utils/wh_box_chain.js): Loading or Unloading from..to, one
   * row per box trip - per RetailPilot job (one box per loading / unloading
   * job), or for uploaded files (no job) per day, box id and store - with its
   * source document (stage_id), articles, qty and NLC value.
   */
  async boxSummary(reportType, from, to) {
    const rows = await this.run(
      "BOX_SUMMARY",
      `SELECT DATE_FORMAT(r.report_date, '%Y-%m-%d') AS report_date, r.box_id, r.planned_to_store, r.job_id,
              MAX(r.stage_id) AS stage_id, MAX(r.unloaded_store) AS unloaded_store, MAX(r.from_store) AS from_store, MAX(r.job_type) AS job_type,
              MAX(r.truck_no) AS truck_no, COUNT(DISTINCT r.article_id) AS articles, SUM(r.box_qty) AS qty,
              SUM(r.box_qty * COALESCE(r.nlc, 0)) AS value, DATE_FORMAT(MAX(r.finished_at), '%Y-%m-%d %H:%i:%s') AS finished_at
         FROM wh_report_box_rows r
        WHERE r.report_type = ? AND r.report_date BETWEEN ? AND ?
        GROUP BY r.report_date, r.box_id, r.planned_to_store, r.job_id`,
      [reportType, from, to]
    );
    return toNumbers(rows, ["articles", "qty", "value"]);
  }

  /**
   * The stage chain (utils/wh_stage_chain.js), from..to: what each stage
   * moved, per day, document (stage_id), article and lane, finished work
   * only. Jobs: Picking (pick_pack = picked and packed in one job), Packing,
   * Verification - done qty and short qty. Boxes: Loading and Unloading -
   * the qty in the boxes, the box's document where it has one.
   */
  async stageFlows(from, to) {
    const [jobs, boxes] = await Promise.all([
      this.run(
        "STAGE_FLOWS_JOBS",
        `SELECT r.report_type, DATE_FORMAT(r.report_date, '%Y-%m-%d') AS report_date, r.stage_id, r.article_id,
                MAX(r.article_name) AS article_name, r.from_store, r.to_store, r.job_id, r.picking_job, r.unloading_job,
                MAX(r.job_state = 'PICKED_PACKED') AS pick_pack,
                SUM(COALESCE(r.actual_qty, 0)) AS qty, SUM(COALESCE(r.short_qty, 0)) AS short_qty, MAX(r.nlc) AS nlc,
                SUM(r.job_state IS NULL) AS no_state
           FROM wh_report_job_rows r
          WHERE r.report_date BETWEEN ? AND ? AND COALESCE(r.open_jobs, 0) = 0
          GROUP BY r.report_type, r.report_date, r.stage_id, r.article_id, r.from_store, r.to_store, r.job_id, r.picking_job, r.unloading_job, (r.job_state = 'PICKED_PACKED')`,
        [from, to]
      ),
      this.run(
        "STAGE_FLOWS_BOXES",
        `SELECT r.report_type, DATE_FORMAT(r.report_date, '%Y-%m-%d') AS report_date, r.stage_id, r.article_id,
                MAX(r.article_name) AS article_name, r.from_store, r.planned_to_store AS to_store,
                r.job_id, r.picking_job, r.packing_jobs, SUM(r.box_qty) AS qty, MAX(r.nlc) AS nlc,
                SUM(r.packing_jobs IS NULL AND r.picking_job IS NULL) AS no_link
           FROM wh_report_box_rows r
          WHERE r.report_date BETWEEN ? AND ?
          GROUP BY r.report_type, r.report_date, r.stage_id, r.article_id, r.from_store, r.planned_to_store, r.job_id, r.picking_job, r.packing_jobs`,
        [from, to]
      ),
    ]);
    return { jobs: toNumbers(jobs, ["qty", "short_qty", "nlc", "pick_pack", "no_state"]), boxes: toNumbers(boxes, ["qty", "nlc", "no_link"]) };
  }

  /**
   * Trace one line through the chain: every Picking / Packing / Verification
   * line and every Loading / Unloading box row of `article_id` going to
   * `to_store` from `from`, with job ids, states, links, qty and times; job
   * lines narrowed to the document when one is given (boxes are kept by
   * article and store - cartons carry no document - and marked when they
   * link to one of the document's jobs). Plus which reports exist per day.
   */
  async trace({ article_id, to_store, stage_id = null, from }) {
    const [jobs, boxes] = await Promise.all([
      this.run(
        "TRACE_JOBS",
        `SELECT r.report_type, DATE_FORMAT(r.report_date, '%Y-%m-%d') AS report_date, r.job_id, r.job_state, r.stage_id,
                r.from_store, r.to_store, r.advised_qty, r.actual_qty, r.short_qty, r.open_jobs, r.worked_by,
                DATE_FORMAT(r.finished_at, '%Y-%m-%d %H:%i') AS finished_at,
                r.picking_job, r.packing_job, r.loading_job, r.unloading_job
           FROM wh_report_job_rows r
          WHERE r.article_id = ? AND r.to_store <=> ? AND r.report_date >= ? AND (? IS NULL OR r.stage_id = ?)
          ORDER BY r.report_date, FIELD(r.report_type, 'PICKING', 'PACKING', 'VERIFICATION'), r.job_id`,
        [article_id, to_store, from, stage_id, stage_id]
      ),
      this.run(
        "TRACE_BOXES",
        `SELECT r.report_type, DATE_FORMAT(r.report_date, '%Y-%m-%d') AS report_date, r.job_id, r.box_id, r.stage_id,
                MAX(r.from_store) AS from_store, r.planned_to_store, MAX(r.unloaded_store) AS unloaded_store,
                MAX(r.truck_no) AS truck_no, SUM(r.box_qty) AS qty, r.packing_jobs, r.picking_job,
                DATE_FORMAT(MAX(r.finished_at), '%Y-%m-%d %H:%i') AS finished_at
           FROM wh_report_box_rows r
          WHERE r.article_id = ? AND r.planned_to_store <=> ? AND r.report_date >= ?
          GROUP BY r.report_type, r.report_date, r.job_id, r.box_id, r.stage_id, r.planned_to_store, r.packing_jobs, r.picking_job
          ORDER BY r.report_date, FIELD(r.report_type, 'LOADING', 'UNLOADING'), r.job_id`,
        [article_id, to_store, from]
      ),
    ]);
    return {
      jobs: toNumbers(jobs, ["advised_qty", "actual_qty", "short_qty", "open_jobs"]),
      boxes: toNumbers(boxes, ["qty"]),
    };
  }

  /** The articles in some box trips: keys [{ report_date, box_id, planned_to_store, job_id }]. */
  async boxArticles(reportType, keys) {
    if (!keys || !keys.length) return [];
    const some = keys.slice(0, 500);
    const params = [reportType];
    for (const k of some) params.push(k.report_date, k.box_id, k.planned_to_store || null, k.job_id || null);
    const rows = await this.run(
      "BOX_ARTICLES",
      `SELECT DATE_FORMAT(r.report_date, '%Y-%m-%d') AS report_date, r.box_id, r.planned_to_store, r.job_id, r.article_id,
              MAX(r.article_name) AS article_name, SUM(r.box_qty) AS qty, SUM(r.box_qty * COALESCE(r.nlc, 0)) AS value
         FROM wh_report_box_rows r
        WHERE r.report_type = ? AND (${some.map(() => "(r.report_date = ? AND r.box_id = ? AND r.planned_to_store <=> ? AND r.job_id <=> ?)").join(" OR ")})
        GROUP BY r.report_date, r.box_id, r.planned_to_store, r.job_id, r.article_id
        ORDER BY r.box_id, r.article_id`,
      params
    );
    return toNumbers(rows, ["qty", "value"]);
  }

  /**
   * Who worked, from the reports pulled from RetailPilot: per report, user
   * (as recorded - loading / unloading hold several, comma-separated) and the
   * store they worked at (picking, packing, loading: where the goods left;
   * verification: the store that verified; unloading: where it unloaded).
   */
  async staffWork() {
    const rows = await this.run(
      "STAFF_WORK",
      `SELECT report_type, worked_by,
              CASE WHEN report_type = 'VERIFICATION' THEN to_store ELSE from_store END AS store,
              COUNT(*) AS \`lines\`, DATE_FORMAT(MIN(report_date), '%Y-%m-%d') AS first_date, DATE_FORMAT(MAX(report_date), '%Y-%m-%d') AS last_date
         FROM wh_report_job_rows WHERE worked_by IS NOT NULL AND worked_by <> ''
        GROUP BY report_type, worked_by, store
       UNION ALL
       SELECT report_type, worked_by,
              CASE WHEN report_type = 'UNLOADING' THEN unloaded_store ELSE from_store END AS store,
              COUNT(*) AS \`lines\`, DATE_FORMAT(MIN(report_date), '%Y-%m-%d'), DATE_FORMAT(MAX(report_date), '%Y-%m-%d')
         FROM wh_report_box_rows WHERE worked_by IS NOT NULL AND worked_by <> ''
        GROUP BY report_type, worked_by, store`
    );
    return toNumbers(rows, ["lines"]);
  }

  /**
   * Remarks on the Write Off and Verification pages for `date`: lines, those
   * still without a remark (or staff member) and not verified, and how many
   * such lines are waiting from the 30 days before it.
   */
  async remarksPending(date) {
    const pendingWo = "ppwo.remark_id IS NULL AND COALESCE(TRIM(ppwo.remark_str), '') = '' AND ppwo.reason_employee_id IS NULL AND ppwo.is_verified = 0";
    const pendingV = "v.remark_id IS NULL AND COALESCE(TRIM(v.remark_str), '') = '' AND v.is_verified = 0";
    const rows = await this.run(
      "REMARKS_PENDING",
      `SELECT 'WRITE_OFF' AS page,
              SUM(ppwo.date = ?) AS total,
              SUM(ppwo.date = ? AND ${pendingWo}) AS pending,
              SUM(ppwo.date < ? AND ${pendingWo}) AS backlog
         FROM pick_pack_write_off ppwo WHERE ppwo.date BETWEEN DATE_SUB(?, INTERVAL 30 DAY) AND ?
       UNION ALL
       SELECT 'VERIFICATION',
              SUM(v.date = ?),
              SUM(v.date = ? AND ${pendingV}),
              SUM(v.date < ? AND ${pendingV})
         FROM pick_pack_verifications v WHERE v.date BETWEEN DATE_SUB(?, INTERVAL 30 DAY) AND ?`,
      [date, date, date, date, date, date, date, date, date, date]
    );
    return toNumbers(rows, ["total", "pending", "backlog"]);
  }

  /**
   * Shortages stores found at verification in from..to, each with the picker
   * of the goods: through the line's picking job, or - where RetailPilot gave
   * none - the picking line of the same document, article and store.
   */
  async pickerMistakes(from, to) {
    const cols = `DATE_FORMAT(v.report_date, '%Y-%m-%d') AS report_date, v.to_store, v.article_id, v.article_name,
                  v.short_qty, v.nlc, p.worked_by`;
    const byJob = await this.run(
      "PICKER_MISTAKES_JOB",
      `SELECT ${cols}
         FROM wh_report_job_rows v
         JOIN (SELECT DISTINCT job_id, worked_by FROM wh_report_job_rows
                WHERE report_type = 'PICKING' AND job_id IS NOT NULL AND worked_by IS NOT NULL) p
           ON p.job_id = v.picking_job
        WHERE v.report_type = 'VERIFICATION' AND v.report_date BETWEEN ? AND ? AND v.short_qty > 0`,
      [from, to]
    );
    const byDoc = await this.run(
      "PICKER_MISTAKES_DOC",
      `SELECT ${cols}
         FROM wh_report_job_rows v
         JOIN (SELECT DISTINCT stage_id, article_id, to_store, worked_by FROM wh_report_job_rows
                WHERE report_type = 'PICKING' AND stage_id IS NOT NULL AND worked_by IS NOT NULL) p
           ON p.stage_id = v.stage_id AND p.article_id = v.article_id AND p.to_store = v.to_store
        WHERE v.report_type = 'VERIFICATION' AND v.report_date BETWEEN ? AND ? AND v.short_qty > 0
          AND v.picking_job IS NULL`,
      [from, to]
    );
    return toNumbers([...byJob, ...byDoc], ["short_qty", "nlc"]);
  }

  /** The mapping, with each mapped employee's name. */
  async staffMap() {
    return this.run(
      "STAFF_MAP",
      `SELECT m.rp_user_id, m.employee_id, e.employee_name, m.note, m.updated_at, u.employee_name AS updated_by_name
         FROM wh_rp_staff_map m
         LEFT JOIN new_employee e ON e.employee_id = m.employee_id
         LEFT JOIN new_employee u ON u.employee_id = m.updated_by`
    );
  }

  /** Map (or unmap, employee_id null) one RetailPilot user id. */
  async setStaffMap({ rp_user_id, employee_id, note, updated_by }) {
    await this.run(
      "SET_STAFF_MAP",
      `INSERT INTO wh_rp_staff_map (rp_user_id, employee_id, note, updated_by) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE employee_id = VALUES(employee_id), note = VALUES(note), updated_by = VALUES(updated_by)`,
      [rp_user_id, employee_id, note, updated_by]
    );
  }

  /** Active employees to choose from, with store and designation. */
  async employeeChoices() {
    return this.run(
      "EMPLOYEE_CHOICES",
      `SELECT e.employee_id, e.employee_name, o.outlet_name AS store, d.designation_name AS designation
         FROM new_employee e
         LEFT JOIN outlets o ON o.outlet_id = e.store_id
         LEFT JOIN designation d ON d.designation_id = e.designation_id
        WHERE e.status = 1
        ORDER BY e.employee_name, e.employee_id`
    );
  }

  /** The last day there is an Unloading report for, on or before `to`. */
  async lastUploadDate(reportType, to) {
    const [row] = await this.run(
      "LAST_UPLOAD_DATE",
      "SELECT DATE_FORMAT(MAX(report_date), '%Y-%m-%d') AS d FROM wh_report_uploads WHERE report_type = ? AND report_date <= ?",
      [reportType, to]
    );
    return (row && row.d) || null;
  }
}

module.exports = (db) => new WhDailyReportsRepository(db);
module.exports.JOB_DIMS = JOB_DIMS;
