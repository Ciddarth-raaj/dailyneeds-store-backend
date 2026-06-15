const logger = require("../utils/logger");

const LOG_TABLE = "api_sync_log";
const CONFIG_TABLE = "api_sync_cron_config";

class ApiSyncLogRepository {
  constructor(db) {
    this.db = db;
  }

  create(row) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `INSERT INTO ${LOG_TABLE}
          (log_type, method, path, status, status_code, duration_ms, row_count, source, employee_id, metadata_json, error_message)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.log_type,
          row.method || "POST",
          row.path,
          row.status,
          row.status_code ?? null,
          row.duration_ms ?? null,
          row.row_count ?? null,
          row.source || "manual",
          row.employee_id ?? null,
          row.metadata_json ? JSON.stringify(row.metadata_json) : null,
          row.error_message ?? null,
        ],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.API_SYNC_LOG",
              code: "REPOSITORY.API_SYNC_LOG.CREATE",
              description: err.toString(),
              category: "",
              ref: { log_type: row.log_type },
            });
            return reject(err);
          }
          resolve({ code: 200, log_id: res.insertId });
        }
      );
    });
  }

  getLogs({ log_type, from_date, to_date, limit = 100, offset = 0 } = {}) {
    return new Promise((resolve, reject) => {
      const clauses = [];
      const params = [];

      if (log_type) {
        clauses.push("log_type = ?");
        params.push(log_type);
      }
      if (from_date) {
        clauses.push("created_at >= ?");
        params.push(from_date);
      }
      if (to_date) {
        clauses.push("created_at <= ?");
        params.push(to_date);
      }

      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      params.push(limit, offset);

      this.db.query(
        `SELECT log_id, log_type, method, path, status, status_code, duration_ms,
                row_count, source, employee_id, metadata_json, error_message, created_at
         FROM ${LOG_TABLE}
         ${where}
         ORDER BY created_at DESC, log_id DESC
         LIMIT ? OFFSET ?`,
        params,
        (err, rows) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.API_SYNC_LOG",
              code: "REPOSITORY.API_SYNC_LOG.GET_LOGS",
              description: err.toString(),
              category: "",
              ref: {},
            });
            return reject(err);
          }
          resolve(
            (rows || []).map((r) => ({
              ...r,
              metadata_json:
                typeof r.metadata_json === "string"
                  ? JSON.parse(r.metadata_json)
                  : r.metadata_json,
            }))
          );
        }
      );
    });
  }

  getRecentByTypes(logTypes, since) {
    return new Promise((resolve, reject) => {
      if (!logTypes?.length) return resolve([]);
      const placeholders = logTypes.map(() => "?").join(", ");
      this.db.query(
        `SELECT log_id, log_type, status, status_code, duration_ms, row_count, source,
                metadata_json, error_message, created_at
         FROM ${LOG_TABLE}
         WHERE log_type IN (${placeholders}) AND created_at >= ?
         ORDER BY created_at DESC`,
        [...logTypes, since],
        (err, rows) => {
          if (err) return reject(err);
          resolve(
            (rows || []).map((r) => ({
              ...r,
              metadata_json:
                typeof r.metadata_json === "string"
                  ? JSON.parse(r.metadata_json)
                  : r.metadata_json,
            }))
          );
        }
      );
    });
  }

  getAllCronConfigs() {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT config_id, log_type, label, category, cron_expression, is_enabled, updated_at
         FROM ${CONFIG_TABLE}
         ORDER BY category ASC, label ASC`,
        (err, rows) => {
          if (err) return reject(err);
          resolve(rows || []);
        }
      );
    });
  }

  upsertCronConfig({ log_type, label, category, cron_expression, is_enabled }) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `INSERT INTO ${CONFIG_TABLE} (log_type, label, category, cron_expression, is_enabled)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           label = VALUES(label),
           category = VALUES(category),
           cron_expression = VALUES(cron_expression),
           is_enabled = VALUES(is_enabled)`,
        [
          log_type,
          label,
          category || "sync",
          cron_expression ?? "",
          is_enabled ? 1 : 0,
        ],
        (err) => {
          if (err) return reject(err);
          resolve({ code: 200 });
        }
      );
    });
  }
}

module.exports = (db) => new ApiSyncLogRepository(db);
