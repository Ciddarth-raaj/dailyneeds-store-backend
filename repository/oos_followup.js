const {
  queryAsync,
  getConnectionAsync,
  beginTransactionAsync,
  commitAsync,
  rollbackAsync,
  insertRowsInBatches,
} = require("../utils/batchInsert");

const CASES = "oos_cases";
const EVENTS = "oos_case_events";
const UPLOADS = "oos_uploads";
const CHUNK = 1000;

const chunks = (list, size = CHUNK) => {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};
const marks = (n) => new Array(n).fill("?").join(",");

// The columns an upload writes on a case, in order.
const LINE_COLUMNS = [
  "article_id", "store", "article_name", "category", "class", "mrp", "cover_now", "planned", "pct", "stock", "value",
  "supplier_cid", "supplier_name", "buyer_id", "buyer_name", "cause", "cause_detail", "po_slug", "tier", "stores_out",
];
const lineValues = (l) => LINE_COLUMNS.map((c) => (l[c] === undefined ? null : l[c]));

/** Out-of-stock follow-up (utils/oos_followup.js): cases, answers, uploads. */
class OosFollowupRepository {
  constructor(db) {
    this.db = db;
  }

  q(sql, params = []) {
    return new Promise((resolve, reject) => this.db.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));
  }

  /** product id (= RetailPilot article id) -> supplier and buyer, from DNDS. */
  async enrichment(articleIds) {
    const out = new Map();
    for (const part of chunks([...new Set(articleIds)])) {
      const rows = await this.q(
        `SELECT pt.product_id, pt.distributor_id, pdm.mdm_dist_name AS supplier_name,
                pd.buyer_id, ne.employee_name AS buyer_name
           FROM product_table pt
           LEFT JOIN product_distributor_master pdm ON pdm.cid = pt.distributor_id
           LEFT JOIN product_distributor pd ON pd.cid = pt.distributor_id
           LEFT JOIN new_employee ne ON ne.employee_id = pd.buyer_id
          WHERE pt.product_id IN (${marks(part.length)})`,
        part
      );
      for (const r of rows) if (!out.has(Number(r.product_id))) out.set(Number(r.product_id), r);
    }
    return out;
  }

  /**
   * article id -> warehouse stock, from the latest RetailPilot stock sync
   * only (a batch that ran out keeps its last stock_qty, so older rows are
   * not trusted).
   */
  async warehouseStock(outletId) {
    const rows = await this.q(
      `SELECT b.item_code, SUM(b.stock_qty) AS qty
         FROM offers_v3_batch_data b
         JOIN (SELECT DATE(MAX(stock_uploaded_at)) AS d FROM offers_v3_batch_data WHERE outlet_id = ?) latest
           ON b.stock_uploaded_at >= latest.d
        WHERE b.outlet_id = ? AND b.stock_qty > 0
        GROUP BY b.item_code`,
      [outletId, outletId]
    );
    return new Map(rows.map((r) => [Number(r.item_code), Number(r.qty) || 0]));
  }

  outlets() {
    return this.q(`SELECT outlet_id, outlet_name, retailpilot_id FROM outlets`);
  }

  async latestReportDate() {
    const rows = await this.q(`SELECT DATE_FORMAT(MAX(report_date), '%Y-%m-%d') AS d FROM ${UPLOADS}`);
    return rows[0] ? rows[0].d : null;
  }

  async latestUpload() {
    const rows = await this.q(
      `SELECT u.*, DATE_FORMAT(u.report_date, '%Y-%m-%d') AS report_date, ne.employee_name AS uploaded_by_name
         FROM ${UPLOADS} u LEFT JOIN new_employee ne ON ne.employee_id = u.uploaded_by
        ORDER BY u.report_date DESC, u.oos_upload_id DESC LIMIT 1`
    );
    return rows[0] || null;
  }

  /**
   * One upload, in ONE transaction. `plan` is planCases()'s answer, made
   * from existingFor(reportDate) - re-read here under the transaction.
   */
  async applyUpload({ reportDate, fileName, plan, skipped, warnings, uploadedBy }) {
    const conn = await getConnectionAsync(this.db);
    try {
      await beginTransactionAsync(conn);
      const q = (sql, params) => queryAsync(conn, sql, params);

      if (plan.insert.length) {
        await insertRowsInBatches(
          conn,
          `INSERT INTO ${CASES} (${LINE_COLUMNS.join(", ")}, status, opened_on, last_seen_on) VALUES ?`,
          plan.insert.map((l) => [...lineValues(l), "open", reportDate, reportDate]),
          1000
        );
      }
      if (plan.update.length) {
        // Upsert by primary key: every row exists, so this only updates.
        const set = [...LINE_COLUMNS.filter((c) => c !== "article_id" && c !== "store"), "status", "last_seen_on", "closed_on"]
          .map((c) => `${c} = VALUES(${c})`)
          .join(", ");
        await insertRowsInBatches(
          conn,
          `INSERT INTO ${CASES} (oos_case_id, ${LINE_COLUMNS.join(", ")}, status, opened_on, last_seen_on, closed_on) VALUES ?
           ON DUPLICATE KEY UPDATE ${set}`,
          plan.update.map((u) => [u.id, ...lineValues(u.line), "open", reportDate, reportDate, null]),
          1000
        );
      }
      for (const part of chunks(plan.close)) {
        await q(`UPDATE ${CASES} SET status = 'closed', closed_on = ? WHERE oos_case_id IN (${marks(part.length)})`, [reportDate, ...part]);
      }
      const reopened = plan.update.filter((u) => u.reopen).length;
      const result = await q(
        `INSERT INTO ${UPLOADS} (report_date, file_name, total_rows, opened, still_out, closed, skipped, warnings, uploaded_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          reportDate,
          fileName || null,
          plan.insert.length + plan.update.length,
          plan.insert.length + reopened,
          plan.update.length - reopened,
          plan.close.length,
          skipped,
          warnings.length ? warnings.join("\n").slice(0, 60000) : null,
          uploadedBy || null,
        ]
      );
      await commitAsync(conn);
      return { upload_id: result.insertId };
    } catch (err) {
      await rollbackAsync(conn);
      throw err;
    } finally {
      conn.release();
    }
  }

  /** Cases an upload for reportDate can touch: open ones, and those it closed itself earlier that day. */
  existingFor(reportDate) {
    return this.q(
      `SELECT oos_case_id AS id, article_id, store, status, DATE_FORMAT(closed_on, '%Y-%m-%d') AS closed_on
         FROM ${CASES} WHERE status = 'open' OR closed_on = ?`,
      [reportDate]
    );
  }

  /**
   * Open cases for the lists. filters: buyerId (number, or "none" for
   * lines with no buyer), includeHidden (discontinued / ignore answers).
   */
  openCases({ buyerId, includeHidden = false, hiding = [] } = {}) {
    const where = ["c.status = 'open'"];
    const params = [];
    if (buyerId === "none") where.push("c.buyer_id IS NULL");
    else if (buyerId != null) {
      where.push("c.buyer_id = ?");
      params.push(buyerId);
    }
    if (!includeHidden && hiding.length) {
      where.push(`(c.reason IS NULL OR c.reason NOT IN (${marks(hiding.length)}))`);
      params.push(...hiding);
    }
    return this.q(
      `SELECT c.*, DATE_FORMAT(c.opened_on, '%Y-%m-%d') AS opened_on, DATE_FORMAT(c.last_seen_on, '%Y-%m-%d') AS last_seen_on,
              rb.employee_name AS reason_by_name, nb.employee_name AS last_note_by_name
         FROM ${CASES} c
         LEFT JOIN new_employee rb ON rb.employee_id = c.reason_by
         LEFT JOIN new_employee nb ON nb.employee_id = c.last_note_by
        WHERE ${where.join(" AND ")}
        ORDER BY c.tier, FIELD(c.class, 'A', 'B', 'C', 'X'), c.value DESC`,
      params
    );
  }

  /** Per buyer: cases closed (back in stock) on a report date. */
  closedOn(reportDate) {
    return this.q(
      `SELECT buyer_id, COUNT(*) AS n FROM ${CASES} WHERE status = 'closed' AND closed_on = ? GROUP BY buyer_id`,
      [reportDate]
    );
  }

  async getCase(id) {
    const rows = await this.q(`SELECT * FROM ${CASES} WHERE oos_case_id = ?`, [id]);
    return rows[0] || null;
  }

  /** A buyer's answer (reason) and/or a note, on the case and in its log. */
  async addEvent(id, { reason, note, employeeId }) {
    const conn = await getConnectionAsync(this.db);
    try {
      await beginTransactionAsync(conn);
      const q = (sql, params) => queryAsync(conn, sql, params);
      if (reason) {
        await q(`UPDATE ${CASES} SET reason = ?, reason_by = ?, reason_at = NOW() WHERE oos_case_id = ?`, [reason, employeeId, id]);
        await q(`INSERT INTO ${EVENTS} (oos_case_id, kind, reason, note, employee_id) VALUES (?, 'reason', ?, ?, ?)`, [id, reason, note || null, employeeId]);
      } else {
        await q(`INSERT INTO ${EVENTS} (oos_case_id, kind, note, employee_id) VALUES (?, 'note', ?, ?)`, [id, note, employeeId]);
      }
      if (note) {
        await q(`UPDATE ${CASES} SET last_note = ?, last_note_by = ?, last_note_at = NOW() WHERE oos_case_id = ?`, [note, employeeId, id]);
      }
      await commitAsync(conn);
    } catch (err) {
      await rollbackAsync(conn);
      throw err;
    } finally {
      conn.release();
    }
  }

  events(id) {
    return this.q(
      `SELECT e.oos_case_event_id, e.kind, e.reason, e.note, e.employee_id, ne.employee_name, e.created_at
         FROM ${EVENTS} e LEFT JOIN new_employee ne ON ne.employee_id = e.employee_id
        WHERE e.oos_case_id = ? ORDER BY e.oos_case_event_id`,
      [id]
    );
  }
}

module.exports = (db) => new OosFollowupRepository(db);
module.exports.LINE_COLUMNS = LINE_COLUMNS;
