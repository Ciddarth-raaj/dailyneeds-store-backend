/**
 * The local copy of the warehouse's RetailPilot GRNs (retailpilot_grn_headers
 * / retailpilot_grn_lines), written by usecase/retailpilot_grn_sync.js every
 * 15 minutes and read by the GRN pages (repository/stock_received.js).
 *
 * Readers return the same MMH_* / MMD_* row shapes the GoFrugal GRN queries
 * return, so the GRN row mappers work on both.
 */

const H = "retailpilot_grn_headers";
const L = "retailpilot_grn_lines";

const HEADER_COLS = ["invoice_slug", "refno", "fy", "store_id", "grn_date", "entered_at", "supplier_id", "supplier_name", "amount"];
const LINE_COLS = [
  "line_id", "invoice_slug", "line_no", "product_id", "recd_qty", "free_qty", "mrp", "pur_rate",
  "tax_per", "tax_amt", "pur_price", "sale_rate", "pur_amount", "disc_per", "disc_amt",
];
const CHUNK = 500;

const HEADER_SELECT = `
  h.invoice_slug AS mmh_mrc_no,
  h.refno AS mmh_mrc_refno,
  DATE_FORMAT(h.grn_date, '%Y-%m-%d') AS mmh_mrc_dt,
  h.supplier_id AS mmh_dist_code,
  h.amount AS mmh_mrc_amt,
  h.supplier_name`;

const LINE_SELECT = `
  l.line_id AS MMD_MRC_SL_NO,
  l.product_id AS MMD_ITEM_CODE,
  l.recd_qty AS MMD_RECD_QTY,
  l.free_qty AS MMD_FREE_QTY,
  l.mrp AS MMD_MAX_RATE,
  l.pur_rate AS MMD_PUR_RATE,
  l.tax_per AS MMD_PUR_TAX_PER,
  l.tax_amt AS MMD_PUR_TAX_AMT,
  l.pur_price AS MMD_PUR_PRICE,
  l.sale_rate AS MMD_SALE_RATE,
  l.pur_amount AS MMD_PUR_AMOUNT,
  l.disc_per AS MMD_DISC_PER,
  l.disc_amt AS MMD_DISC_AMT`;

const COUNT_JOIN = `LEFT JOIN (SELECT invoice_slug, COUNT(*) AS n FROM ${L} GROUP BY invoice_slug) c ON c.invoice_slug = h.invoice_slug`;

function chunks(arr, size = CHUNK) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

class RetailPilotGrnRepository {
  constructor(db) {
    this.db = db;
  }

  _q(sql, params = [], conn = this.db) {
    return new Promise((resolve, reject) => {
      conn.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
    });
  }

  async _withTransaction(fn) {
    const conn = await new Promise((resolve, reject) =>
      this.db.getConnection((err, c) => (err ? reject(err) : resolve(c)))
    );
    try {
      await this._q("START TRANSACTION", [], conn);
      const out = await fn(conn);
      await this._q("COMMIT", [], conn);
      return out;
    } catch (err) {
      await this._q("ROLLBACK", [], conn).catch(() => {});
      throw err;
    } finally {
      conn.release();
    }
  }

  // ---------------------------------------------------------------------
  // Sync writes
  // ---------------------------------------------------------------------

  async countLines() {
    const [row] = await this._q(`SELECT COUNT(*) AS n FROM ${L}`);
    return Number(row.n);
  }

  /**
   * Store the store's full header list: upsert every header and drop the ones
   * RetailPilot no longer has (with their lines). Returns { upserted, removed }.
   */
  async replaceHeaders(storeId, headers) {
    return this._withTransaction(async (conn) => {
      for (const part of chunks(headers)) {
        await this._q(
          `INSERT INTO ${H} (${HEADER_COLS.join(", ")}) VALUES ?
           ON DUPLICATE KEY UPDATE ${HEADER_COLS.slice(1).map((c) => `${c} = VALUES(${c})`).join(", ")}`,
          [part.map((h) => HEADER_COLS.map((c) => h[c]))],
          conn
        );
      }
      const keep = new Set(headers.map((h) => h.invoice_slug));
      const existing = await this._q(`SELECT invoice_slug FROM ${H} WHERE store_id = ?`, [storeId], conn);
      const gone = existing.map((r) => r.invoice_slug).filter((s) => !keep.has(s));
      for (const part of chunks(gone)) {
        await this._q(`DELETE FROM ${L} WHERE invoice_slug IN (?)`, [part], conn);
        await this._q(`DELETE FROM ${H} WHERE invoice_slug IN (?)`, [part], conn);
      }
      return { upserted: headers.length, removed: gone.length };
    });
  }

  /**
   * Replace the lines of each of `invoiceSlugs` with `lines` (those GRNs'
   * complete current lines), so edits and removed lines carry over.
   */
  async replaceLines(invoiceSlugs, lines) {
    if (!invoiceSlugs.length) return 0;
    return this._withTransaction(async (conn) => {
      for (const part of chunks(invoiceSlugs)) {
        await this._q(`DELETE FROM ${L} WHERE invoice_slug IN (?)`, [part], conn);
      }
      for (const part of chunks(lines)) {
        await this._q(
          `INSERT INTO ${L} (${LINE_COLS.join(", ")}) VALUES ?
           ON DUPLICATE KEY UPDATE ${LINE_COLS.slice(1).map((c) => `${c} = VALUES(${c})`).join(", ")}`,
          [part.map((l) => LINE_COLS.map((c) => l[c]))],
          conn
        );
      }
      return lines.length;
    });
  }

  // ---------------------------------------------------------------------
  // GRN page reads
  // ---------------------------------------------------------------------

  /** GRN headers entered in [from, to] (either may be null), newest first. */
  listHeaders(storeId, from, to) {
    const conds = ["h.store_id = ?"];
    const params = [storeId];
    if (from) { conds.push("h.grn_date >= ?"); params.push(from); }
    if (to) { conds.push("h.grn_date <= ?"); params.push(to); }
    return this._q(
      `SELECT ${HEADER_SELECT}, COALESCE(c.n, 0) AS product_count
       FROM ${H} h ${COUNT_JOIN}
       WHERE ${conds.join(" AND ")}
       ORDER BY h.entered_at DESC, h.invoice_slug DESC`,
      params
    );
  }

  /** GRN headers whose GRN No starts with `digits`. */
  searchHeaders(storeId, digits) {
    if (!/^\d{1,18}$/.test(String(digits || ""))) return Promise.resolve([]);
    return this._q(
      `SELECT ${HEADER_SELECT}, COALESCE(c.n, 0) AS product_count
       FROM ${H} h ${COUNT_JOIN}
       WHERE h.store_id = ? AND h.refno LIKE ?
       ORDER BY h.entered_at DESC, h.invoice_slug DESC`,
      [storeId, `${digits}%`]
    );
  }

  /** One GRN header by GRN No; the newest financial year wins. */
  async headerByRefno(storeId, refno) {
    if (!/^\d{1,18}$/.test(String(refno || ""))) return null;
    const [row] = await this._q(
      `SELECT ${HEADER_SELECT}, DATE_FORMAT(h.entered_at, '%Y-%m-%d %H:%i:%s') AS entered_at
       FROM ${H} h
       WHERE h.store_id = ? AND h.refno = ?
       ORDER BY h.fy DESC, h.entered_at DESC
       LIMIT 1`,
      [storeId, String(refno)]
    );
    return row || null;
  }

  linesOf(invoiceSlug) {
    return this._q(`SELECT ${LINE_SELECT} FROM ${L} l WHERE l.invoice_slug = ? ORDER BY l.line_no`, [invoiceSlug]);
  }

  /** Every GRN line entered in [from, to], with its header fields. */
  linesByRange(storeId, from, to) {
    const conds = ["h.store_id = ?"];
    const params = [storeId];
    if (from) { conds.push("h.grn_date >= ?"); params.push(from); }
    if (to) { conds.push("h.grn_date <= ?"); params.push(to); }
    return this._q(
      `SELECT h.refno AS mmh_mrc_refno, DATE_FORMAT(h.grn_date, '%Y-%m-%d') AS mmh_mrc_dt, h.supplier_name,
              ${LINE_SELECT}
       FROM ${L} l JOIN ${H} h ON h.invoice_slug = l.invoice_slug
       WHERE ${conds.join(" AND ")}
       ORDER BY h.entered_at DESC, h.invoice_slug DESC, l.line_no`,
      params
    );
  }

  /**
   * Earlier GRN lines of these products at the store, newest first, in the
   * shape utils/retailpilot_grn.previousByArticle reads.
   */
  previousLines(storeId, productIds, before) {
    const ids = [...new Set((productIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (!ids.length || !before) return Promise.resolve([]);
    return this._q(
      `SELECT l.product_id AS article_id, l.pur_rate AS basic_cost, l.pur_price AS landing_cost,
              l.sale_rate AS selling_price, h.entered_at
       FROM ${L} l JOIN ${H} h ON h.invoice_slug = l.invoice_slug
       WHERE h.store_id = ? AND l.product_id IN (?) AND h.entered_at < ?
       ORDER BY l.product_id, h.entered_at DESC`,
      [storeId, ids, before]
    );
  }
}

module.exports = (db) => new RetailPilotGrnRepository(db);
