const logger = require("../utils/logger");
const { insertRowsInBatches } = require("../utils/batchInsert");

/**
 * The stored stage chain (usecase/wh_chain.js): one row per day in
 * wh_chain_days (TODO / DONE / FAILED, with the day's result as JSON), and
 * what was still waiting at the end of each day (wh_chain_open,
 * wh_chain_open_boxes) for the next day to start from.
 */
class WhChainRepository {
  constructor(db) {
    this.db = db;
  }

  run(code, sql, params = [], conn = this.db) {
    return new Promise((resolve, reject) => {
      conn.query(sql, params, (err, result) => {
        if (err) {
          logger.Log({ level: logger.LEVEL.ERROR, component: "REPOSITORY.WH_CHAIN", code: `REPOSITORY.WH_CHAIN.${code}`, description: err.toString(), category: "", ref: {} });
          reject(err);
          return;
        }
        resolve(result);
      });
    });
  }

  /** Every day from..to that has no row yet becomes TODO. */
  async addMissing(days) {
    if (!days.length) return;
    await this.run("ADD_MISSING", "INSERT IGNORE INTO wh_chain_days (chain_date, status) VALUES ?", [days.map((d) => [d, "TODO"])]);
  }

  /** These days must be worked out again (their stored result stays readable meanwhile). */
  async markTodo(days) {
    if (!days.length) return;
    await this.run(
      "MARK_TODO",
      "INSERT INTO wh_chain_days (chain_date, status) VALUES ? ON DUPLICATE KEY UPDATE status = 'TODO', gen = gen + 1, error = NULL",
      [days.map((d) => [d, "TODO"])]
    );
  }

  async nextTodo(upTo) {
    const rows = await this.run(
      "NEXT_TODO",
      "SELECT DATE_FORMAT(chain_date, '%Y-%m-%d') AS d FROM wh_chain_days WHERE status = 'TODO' AND chain_date <= ? ORDER BY chain_date LIMIT 1",
      [upTo]
    );
    return rows.length ? rows[0].d : null;
  }

  async getDay(day) {
    const rows = await this.run(
      "GET_DAY",
      `SELECT DATE_FORMAT(chain_date, '%Y-%m-%d') AS chain_date, status, gen, result, no_links, error,
              DATE_FORMAT(computed_at, '%Y-%m-%d %H:%i:%s') AS computed_at
         FROM wh_chain_days WHERE chain_date = ?`,
      [day]
    );
    return rows[0] || null;
  }

  /** How far the work is: days to do, the first of them, days done, days failed. */
  async progress(upTo) {
    const [row] = await this.run(
      "PROGRESS",
      `SELECT SUM(status = 'TODO') AS todo, SUM(status = 'DONE') AS done, SUM(status = 'FAILED') AS failed,
              DATE_FORMAT(MIN(CASE WHEN status <> 'DONE' THEN chain_date END), '%Y-%m-%d') AS first_todo
         FROM wh_chain_days WHERE chain_date <= ?`,
      [upTo]
    );
    return { todo: Number(row.todo) || 0, done: Number(row.done) || 0, failed: Number(row.failed) || 0, first_todo: row.first_todo || null };
  }

  /** Changes whenever a day is worked out or marked to redo. */
  async version() {
    const [row] = await this.run("VERSION", "SELECT DATE_FORMAT(MAX(computed_at), '%Y-%m-%d %H:%i:%s') AS at, SUM(status <> 'DONE') AS open, SUM(gen) AS gens FROM wh_chain_days");
    return row ? `${row.at}|${row.open}|${row.gens}` : "";
  }

  /** Days up to `upTo` with lines pulled before job states / links were kept. */
  async noLinkDays(upTo) {
    const rows = await this.run("NO_LINK_DAYS", "SELECT DATE_FORMAT(chain_date, '%Y-%m-%d') AS d FROM wh_chain_days WHERE no_links = 1 AND chain_date <= ? ORDER BY chain_date", [upTo]);
    return rows.map((r) => r.d);
  }

  async loadOpen(day) {
    const rows = await this.run(
      "LOAD_OPEN",
      `SELECT view_key, gap, DATE_FORMAT(since, '%Y-%m-%d') AS since, stage_id, article_id, article_name, from_store, to_store, links, qty, nlc
         FROM wh_chain_open WHERE chain_date = ?`,
      [day]
    );
    return rows.map((r) => ({ ...r, qty: Number(r.qty) || 0, nlc: r.nlc == null ? null : Number(r.nlc) }));
  }

  async loadOpenBoxes(day) {
    const rows = await this.run(
      "LOAD_OPEN_BOXES",
      `SELECT view_key, DATE_FORMAT(loaded_on, '%Y-%m-%d') AS loaded_on, box_id, job_id, stage_id, from_store, to_store, job_type, truck_no,
              articles, qty, value, loaded_at
         FROM wh_chain_open_boxes WHERE chain_date = ?`,
      [day]
    );
    return rows.map((r) => ({ ...r, articles: Number(r.articles) || 0, qty: Number(r.qty) || 0, value: Number(r.value) || 0 }));
  }

  /** One site's stored result for `day` (JSON text), or null. */
  async getView(day, view) {
    const rows = await this.run("GET_VIEW", "SELECT result FROM wh_chain_results WHERE chain_date = ? AND view_key = ?", [day, view]);
    return rows.length ? rows[0].result : null;
  }

  /** The sites with a stored result on `day`. */
  async viewsOn(day) {
    const rows = await this.run("VIEWS_ON", "SELECT view_key FROM wh_chain_results WHERE chain_date = ? ORDER BY view_key", [day]);
    return rows.map((r) => r.view_key);
  }

  /**
   * Store a worked-out day: what is still open tonight (per view), each
   * view's result, and the day's own row (`result`: when and under which
   * rules it was worked out).
   */
  async saveDay(day, { open, boxes, result, views = {}, noLinks, gen = 0 }) {
    const conn = await new Promise((resolve, reject) => this.db.getConnection((err, c) => (err ? reject(err) : resolve(c))));
    const q = (code, sql, params) => this.run(code, sql, params, conn);
    try {
      await q("BEGIN", "START TRANSACTION");
      await q("CLEAR_OPEN", "DELETE FROM wh_chain_open WHERE chain_date = ?", [day]);
      await q("CLEAR_BOXES", "DELETE FROM wh_chain_open_boxes WHERE chain_date = ?", [day]);
      await q("CLEAR_VIEWS", "DELETE FROM wh_chain_results WHERE chain_date = ?", [day]);
      const viewRows = Object.entries(views).map(([v, r]) => [day, v, JSON.stringify(r)]);
      for (let i = 0; i < viewRows.length; i += 20) {
        // eslint-disable-next-line no-await-in-loop
        await q("SAVE_VIEWS", "INSERT INTO wh_chain_results (chain_date, view_key, result) VALUES ?", [viewRows.slice(i, i + 20)]);
      }
      if (open.length) {
        await insertRowsInBatches(
          conn,
          "INSERT INTO wh_chain_open (chain_date, view_key, gap, since, stage_id, article_id, article_name, from_store, to_store, links, qty, nlc) VALUES ?",
          open.map((o) => [day, o.view || "all", o.gap, o.since, o.stage_id, o.article_id, o.article_name ? String(o.article_name).slice(0, 255) : null, o.from_store, o.to_store, o.links ? String(o.links).slice(0, 1000) : null, o.qty, o.nlc]),
          2000
        );
      }
      if (boxes.length) {
        await insertRowsInBatches(
          conn,
          "INSERT INTO wh_chain_open_boxes (chain_date, view_key, loaded_on, box_id, job_id, stage_id, from_store, to_store, job_type, truck_no, articles, qty, value, loaded_at) VALUES ?",
          boxes.map((b) => [day, b.view || "all", b.loaded_on, b.box_id, b.job_id, b.stage_id, b.from_store, b.to_store, b.job_type, b.truck_no, b.articles, b.qty, b.value, b.loaded_at]),
          2000
        );
      }
      // DONE only if nobody marked the day to redo while it was worked out (gen unchanged).
      await q(
        "DONE",
        `INSERT INTO wh_chain_days (chain_date, status, gen, result, no_links, error, computed_at) VALUES (?, 'DONE', ?, ?, ?, NULL, NOW())
         ON DUPLICATE KEY UPDATE status = IF(gen = VALUES(gen), 'DONE', 'TODO'), result = VALUES(result),
           no_links = VALUES(no_links), error = NULL, computed_at = NOW()`,
        [day, gen, JSON.stringify(result), noLinks ? 1 : 0]
      );
      await q("COMMIT", "COMMIT");
    } catch (err) {
      await new Promise((r) => conn.query("ROLLBACK", () => r()));
      throw err;
    } finally {
      conn.release();
    }
  }

  async failDay(day, message) {
    await this.run(
      "FAIL",
      "INSERT INTO wh_chain_days (chain_date, status, error) VALUES (?, 'FAILED', ?) ON DUPLICATE KEY UPDATE status = 'FAILED', error = VALUES(error)",
      [day, String(message || "").slice(0, 500)]
    );
  }
}

module.exports = (db) => new WhChainRepository(db);
