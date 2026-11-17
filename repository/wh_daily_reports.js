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
  "returned_qty", "jobs", "open_jobs", "mrp", "mrp_source",
];
const BOX_COLS = [
  "upload_id", "report_type", "report_date", "job_type", "from_store", "planned_to_store", "unloaded_store",
  "box_id", "box_kind", "truck_no", "article_id", "article_name", "department", "category", "mrp", "box_qty",
  "box_status", "finished_at",
];
/** Columns a job breakdown may group by. */
const JOB_DIMS = ["report_type", "report_date", "to_store", "job_type", "department", "category"];

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

  /** Save one report for one day, replacing what was there. Answers the new upload_id. */
  async replaceUpload({ report_type, report_date, file_name, uploaded_by, shape, rows }) {
    const conn = await getConnectionAsync(this.db);
    try {
      await beginTransactionAsync(conn);
      await queryAsync(conn, "DELETE FROM wh_report_uploads WHERE report_type = ? AND report_date = ?", [report_type, report_date]);
      const res = await queryAsync(
        conn,
        `INSERT INTO wh_report_uploads (report_type, report_date, file_name, row_count, uploaded_by) VALUES (?, ?, ?, ?, ?)`,
        [report_type, report_date, file_name || null, rows.length, uploaded_by || null]
      );
      const uploadId = res.insertId;
      const cols = shape === "JOB" ? JOB_COLS : BOX_COLS;
      const table = shape === "JOB" ? "wh_report_job_rows" : "wh_report_box_rows";
      const values = rows.map((r) => cols.map((c) => (c === "upload_id" ? uploadId : c === "report_date" ? report_date : r[c] === undefined ? null : r[c])));
      await insertRowsInBatches(conn, `INSERT INTO ${table} (${cols.join(", ")}) VALUES ?`, values, 2000);
      await commitAsync(conn);
      return uploadId;
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
      `SELECT u.upload_id, u.report_type, DATE_FORMAT(u.report_date, '%Y-%m-%d') AS report_date, u.file_name, u.row_count,
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
              r.short_qty * r.mrp AS short_value
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
              DATE_FORMAT(MAX(r.finished_at), '%Y-%m-%d %H:%i:%s') AS finished_at
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
