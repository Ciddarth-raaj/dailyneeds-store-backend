const logger = require("../utils/logger");

/**
 * Storage for PO Tracker follow-ups (po_followups): append-only - nothing
 * here UPDATEs or DELETEs a row. Dates come back as YYYY-MM-DD text and
 * created_at as an ISO string, so no server time zone shifts them.
 */
const COLUMNS = `
  f.po_followup_id, f.po_slug, f.po_ref, f.supplier_id, f.supplier_name, f.store_id,
  f.channel, f.remark,
  DATE_FORMAT(f.promised_delivery_date, '%Y-%m-%d') AS promised_delivery_date,
  DATE_FORMAT(f.next_follow_up_date, '%Y-%m-%d')    AS next_follow_up_date,
  f.created_by, e.employee_name AS created_by_name, f.created_at`;
const FROM = `
FROM po_followups f
LEFT JOIN new_employee e ON e.employee_id = f.created_by`;
const SELECT = `${COLUMNS}${FROM}`;

const placeholders = (list) => list.map(() => "?").join(", ");

class PoFollowupRepository {
  constructor(db) {
    this.db = db;
  }

  run(code, sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.query(sql, params, (err, result) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.PO_FOLLOWUP",
            code: `REPOSITORY.PO_FOLLOWUP.${code}`,
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

  async add(row) {
    const result = await this.run(
      "ADD",
      `INSERT INTO po_followups
         (po_slug, po_ref, supplier_id, supplier_name, store_id, channel, remark,
          promised_delivery_date, next_follow_up_date, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.po_slug,
        row.po_ref || null,
        row.supplier_id || null,
        row.supplier_name || null,
        row.store_id || null,
        row.channel,
        row.remark,
        row.promised_delivery_date || null,
        row.next_follow_up_date || null,
        row.created_by,
      ]
    );
    const [saved] = await this.run("GET", `SELECT ${SELECT} WHERE f.po_followup_id = ?`, [result.insertId]);
    return saved;
  }

  /** Every remark on one PO, newest first. */
  forPo(slug) {
    return this.run("FOR_PO", `SELECT ${SELECT} WHERE f.po_slug = ? ORDER BY f.po_followup_id DESC`, [slug]);
  }

  /** The supplier's remarks on its other POs, newest first. */
  forSupplier(supplierId, exceptSlug, limit = 50) {
    if (!supplierId) return Promise.resolve([]);
    return this.run(
      "FOR_SUPPLIER",
      `SELECT ${SELECT} WHERE f.supplier_id = ? AND f.po_slug <> ? ORDER BY f.po_followup_id DESC LIMIT ?`,
      [supplierId, exceptSlug, limit]
    );
  }

  /** The latest remark on each of `slugs`, with how many each PO has. */
  async latestFor(slugs) {
    if (!slugs || !slugs.length) return [];
    return this.run(
      "LATEST",
      `SELECT ${COLUMNS}, c.remark_count${FROM}
       JOIN (SELECT po_slug, MAX(po_followup_id) AS last_id, COUNT(*) AS remark_count
               FROM po_followups WHERE po_slug IN (${placeholders(slugs)}) GROUP BY po_slug) c
         ON c.last_id = f.po_followup_id`,
      slugs
    );
  }
}

module.exports = (db) => new PoFollowupRepository(db);
