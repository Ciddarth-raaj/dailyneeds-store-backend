const logger = require("../utils/logger");

/**
 * Who gets the PO daily summary, and what was sent to whom each day
 * (po_daily_summary_sends, one row per employee per day).
 */
class PoDailySummaryRepository {
  constructor(db) {
    this.db = db;
  }

  run(code, sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.query(sql, params, (err, result) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.PO_DAILY_SUMMARY",
            code: `REPOSITORY.PO_DAILY_SUMMARY.${code}`,
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
   * Employees whose designation holds receive_po_daily_summary (switched on),
   * not resigned before `today`, with their active private chat with the
   * bot - null when they have not linked Telegram.
   */
  recipients(today) {
    return this.run(
      "RECIPIENTS",
      `SELECT DISTINCT ne.employee_id, ne.employee_name, i.private_chat_id
         FROM permissions p
         JOIN new_employee ne ON ne.designation_id = p.designation_id
         LEFT JOIN employee_telegram_identity i
                ON i.employee_id = ne.employee_id AND i.disconnected_at IS NULL
        WHERE p.permission_key = 'receive_po_daily_summary'
          AND p.is_active = 1
          AND (ne.resignation_date IS NULL OR ne.resignation_date >= ?)
        ORDER BY ne.employee_id`,
      [today]
    );
  }

  /** One employee's active private chat with the bot, or null. */
  async chatOf(employeeId) {
    const rows = await this.run(
      "CHAT_OF",
      "SELECT private_chat_id FROM employee_telegram_identity WHERE employee_id = ? AND disconnected_at IS NULL LIMIT 1",
      [employeeId]
    );
    return rows.length && rows[0].private_chat_id ? rows[0].private_chat_id : null;
  }

  /** Employee ids already SENT the summary for `day`. */
  async sentOn(day) {
    const rows = await this.run(
      "SENT_ON",
      "SELECT employee_id FROM po_daily_summary_sends WHERE summary_date = ? AND status = 'SENT'",
      [day]
    );
    return new Set(rows.map((r) => Number(r.employee_id)));
  }

  /** Record one outcome; a later SENT replaces an earlier FAILED or SKIPPED. */
  record({ day, employee_id, status, reason = null, chat_id = null }) {
    return this.run(
      "RECORD",
      `INSERT INTO po_daily_summary_sends (summary_date, employee_id, status, reason, telegram_chat_id)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE status = VALUES(status), reason = VALUES(reason), telegram_chat_id = VALUES(telegram_chat_id)`,
      [day, employee_id, status, reason, chat_id == null ? null : String(chat_id)]
    );
  }
}

module.exports = (db) => new PoDailySummaryRepository(db);
