const logger = require("../utils/logger");

const STATE_TABLE = "rp_sync_state";
const CHUNK = 1000;

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Writes for the rp_* RetailPilot mirror tables (utils/retailpilot_mirror.js). */
class RetailPilotMirrorRepository {
  constructor(db) {
    this.db = db;
  }

  _query(sql, params = [], code = "QUERY") {
    return new Promise((resolve, reject) => {
      this.db.query(sql, params, (err, res) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.RETAILPILOT_MIRROR",
            code: `REPOSITORY.RETAILPILOT_MIRROR.${code}`,
            description: err.toString(),
            category: "",
            ref: {},
          });
          reject(err);
        } else resolve(res);
      });
    });
  }

  /**
   * Upsert rows into spec.table, stamping each with runId.
   * @param spec a TABLES entry (table, key, columns)
   */
  async upsert(spec, rows, runId) {
    if (!rows.length) return 0;
    const cols = [...spec.columns, "sync_run"];
    const updates = cols.filter((c) => !spec.key.includes(c)).map((c) => `\`${c}\` = VALUES(\`${c}\`)`);
    let affected = 0;
    for (const batch of chunk(rows, CHUNK)) {
      const res = await this._query(
        `INSERT INTO \`${spec.table}\` (${cols.map((c) => `\`${c}\``).join(", ")})
         VALUES ${batch.map(() => `(${cols.map(() => "?").join(", ")})`).join(", ")}
         ON DUPLICATE KEY UPDATE ${updates.join(", ")}`,
        batch.flatMap((r) => [...spec.columns.map((c) => (r[c] === undefined ? null : r[c])), runId]),
        "UPSERT"
      );
      affected += res.affectedRows || 0;
    }
    return affected;
  }

  /** Delete the rows of a full-refresh table that run runId did not see. */
  async deleteNotInRun(table, runId) {
    let removed = 0;
    for (;;) {
      const res = await this._query(
        `DELETE FROM \`${table}\` WHERE sync_run IS NULL OR sync_run <> ? LIMIT 5000`,
        [runId],
        "DELETE_STALE"
      );
      removed += res.affectedRows || 0;
      if ((res.affectedRows || 0) < 5000) return removed;
    }
  }

  /** { [table]: { last_run_at, last_full_at, last_rows, last_error } } */
  async getState() {
    const rows = await this._query(`SELECT * FROM \`${STATE_TABLE}\``, [], "GET_STATE");
    return Object.fromEntries(rows.map((r) => [r.table_name, r]));
  }

  async saveState(table, { rows = null, full = false, error = null }) {
    await this._query(
      `INSERT INTO \`${STATE_TABLE}\` (table_name, last_run_at, last_full_at, last_rows, last_error)
       VALUES (?, NOW(), ${full ? "NOW()" : "NULL"}, ?, ?)
       ON DUPLICATE KEY UPDATE last_run_at = NOW(), last_rows = VALUES(last_rows), last_error = VALUES(last_error)
         ${full ? ", last_full_at = NOW()" : ""}`,
      [table, rows, error],
      "SAVE_STATE"
    );
  }
}

module.exports = (db) => new RetailPilotMirrorRepository(db);
