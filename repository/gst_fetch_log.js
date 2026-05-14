const logger = require("../utils/logger");

const TABLE = "gst_fetch_log";

class GstFetchLogRepository {
  constructor(db) {
    this.db = db;
  }

  /**
   * @param {{ type: string, year: number, month: number, created_by: number | null }} row
   */
  create(row) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `INSERT INTO ${TABLE} (\`type\`, \`year\`, \`month\`, created_by) VALUES (?, ?, ?, ?)`,
        [row.type, row.year, row.month, row.created_by],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.GST_FETCH_LOG",
              code: "REPOSITORY.GST_FETCH_LOG.CREATE",
              description: err.toString(),
              category: "",
              ref: { type: row.type, year: row.year, month: row.month },
            });
            return reject(err);
          }
          resolve({ code: 200, fetch_log_id: res.insertId });
        }
      );
    });
  }
}

module.exports = (db) => {
  return new GstFetchLogRepository(db);
};
