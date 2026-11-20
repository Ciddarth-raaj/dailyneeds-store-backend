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
  "returned_qty", "jobs", "open_jobs", "mrp", "mrp_source", "job_id", "worked_by",
];
const BOX_COLS = [
  "upload_id", "report_type", "report_date", "job_type", "from_store", "planned_to_store", "unloaded_store",
  "box_id", "box_kind", "truck_no", "article_id", "article_name", "department", "category", "mrp", "box_qty",
  "box_status", "finished_at", "job_id", "worked_by",
];
/** The Pick & Pack pages a report's write-off goes to. */
const PAGES = {
  VERIFICATION: { table: "pick_pack_verifications", id: "pick_pack_verification_id", jobType: true },
  WRITE_OFF: { table: "pick_pack_write_off", id: "pick_pack_write_off_id", jobType: false },
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
  COALESCE(SUM(r.short_qty * r.mrp), 0) AS short_value,
  SUM(r.short_qty > 0 AND r.mrp IS NULL) AS short_unpriced_lines,
  SUM(COALESCE(r.returned_qty, 0) > 0) AS returned_lines,
  COALESCE(SUM(r.returned_qty), 0) AS returned_qty,
  SUM(COALESCE(r.open_jobs, 0) > 0) AS open_lines,
  COALESCE(SUM(r.open_jobs), 0) AS open_jobs`;
const JOB_METRIC_KEYS = [
  "lines", "articles", "days", "planned_qty", "actual_qty", "short_lines", "short_qty", "short_value",
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

  /**
   * The latest MRP each article was received at, from the warehouse's
   * RetailPilot GRN copy. Used to price rows whose file has no MRP (an
   * article fully short has an empty MRP Split). Never throws: no prices
   * is an answer.
   */
  async latestMrp(articleIds) {
    const ids = [...new Set((articleIds || []).map(Number).filter((x) => Number.isInteger(x) && x > 0))];
    const prices = new Map();
    if (!ids.length) return prices;
    try {
      for (let i = 0; i < ids.length; i += 1000) {
        const rows = await this.run(
          "LATEST_MRP",
          `SELECT l.product_id, l.mrp
             FROM retailpilot_grn_lines l
             JOIN retailpilot_grn_headers h ON h.invoice_slug = l.invoice_slug
            WHERE l.product_id IN (?) AND l.mrp > 0
            ORDER BY l.product_id, h.entered_at DESC`,
          [ids.slice(i, i + 1000)]
        );
        for (const r of rows) if (!prices.has(Number(r.product_id))) prices.set(Number(r.product_id), Number(r.mrp));
      }
    } catch (err) {
      // Logged by run(); the upload goes ahead unpriced.
    }
    return prices;
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
   *   - otherwise a new line is added.
   *
   * Articles not in product_table cannot be added (foreign key) and are counted.
   */
  async _syncPageLines(conn, page, date, writeOffs) {
    const cfg = PAGES[page];
    const out = { added: 0, updated: 0, unchanged: 0, kept_verified: 0, unknown_articles: 0 };
    if (!writeOffs.length) return out;
    const ids = [...new Set(writeOffs.map((w) => w.product_id))];
    const known = new Set((await queryAsync(conn, "SELECT product_id FROM product_table WHERE product_id IN (?)", [ids])).map((r) => Number(r.product_id)));
    const existing = await queryAsync(
      conn,
      `SELECT ${cfg.id} AS id, product_id, ${cfg.jobType ? "job_type" : "NULL AS job_type"}, store, mismatch_qty, is_verified
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
              COALESCE(SUM(r.short_qty), 0) AS short_qty, COALESCE(SUM(r.short_qty * r.mrp), 0) AS short_value,
              MAX(r.mrp) AS mrp, DATE_FORMAT(MAX(r.report_date), '%Y-%m-%d') AS last_short_date
         FROM wh_report_job_rows r
        WHERE ${where} AND r.short_qty > 0
        GROUP BY r.report_type, r.article_id
        ORDER BY days_short DESC, short_value DESC, short_qty DESC
        LIMIT ?`,
      [...params, limit]
    );
    return toNumbers(rows, ["days_short", "lines", "short_qty", "short_value", "mrp"]);
  }

  /** Rows of the job reports: every row, only write-offs (short), or only rows with open jobs. */
  async jobRows(from, to, { only = "all", ...opts } = {}, limit = 50000) {
    const { where, params } = this._jobWhere(from, to, opts);
    const extra = only === "short" ? " AND r.short_qty > 0" : only === "open" ? " AND COALESCE(r.open_jobs, 0) > 0" : only === "returned" ? " AND COALESCE(r.returned_qty, 0) > 0" : "";
    const rows = await this.run(
      "JOB_ROWS",
      `SELECT r.report_type, DATE_FORMAT(r.report_date, '%Y-%m-%d') AS report_date, r.job_type, r.from_store, r.to_store,
              r.article_id, r.article_name, r.department, r.category, r.recommended_qty, r.planned_qty, r.advised_qty,
              r.actual_qty, r.short_qty, r.returned_qty, r.jobs, r.open_jobs, r.mrp, r.mrp_source,
              r.short_qty * r.mrp AS short_value, r.job_id, r.worked_by
         FROM wh_report_job_rows r
        WHERE ${where}${extra}
        ORDER BY r.report_date DESC, r.report_type, r.to_store, short_value DESC, r.article_id
        LIMIT ?`,
      [...params, limit]
    );
    return toNumbers(rows, ["recommended_qty", "planned_qty", "advised_qty", "actual_qty", "short_qty", "returned_qty", "jobs", "open_jobs", "mrp", "short_value"]);
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
              SUM(r.box_qty) AS box_qty, SUM(r.box_qty * r.mrp) / NULLIF(SUM(CASE WHEN r.mrp IS NULL THEN 0 ELSE r.box_qty END), 0) AS mrp,
              DATE_FORMAT(MAX(r.finished_at), '%Y-%m-%d %H:%i:%s') AS finished_at, MAX(r.worked_by) AS worked_by
         FROM wh_report_box_rows r
        WHERE r.report_type = ? AND r.report_date BETWEEN ? AND ?${storeSql}
        GROUP BY r.report_date, r.box_id, r.article_id
        ORDER BY r.report_date, r.box_id, r.article_id`,
      params
    );
    return toNumbers(rows, ["box_qty", "mrp"]);
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
