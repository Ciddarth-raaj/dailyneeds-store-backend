const logger = require("../utils/logger");
const {
  VERIFIED_MEMBERSHIP,
  GROUP_READINESS,
} = require("../constants/telegram_membership");

const TABLE = "employee_telegram_group_verification";

/**
 * The membership-verification cache - SQL only. Phase 3B.
 *
 * WHAT IT IS FOR. The employee dashboard cannot ask Telegram: completion
 * needs two calls per required group per employee, which is thousands of Bot
 * API calls per page load on a token shared with the three-second poller.
 * This holds the answer Telegram last gave, so the queue can be built from
 * the database alone.
 *
 * IT IS NEVER THE AUTHORITY. The detail screen asks Telegram every time and
 * fails closed when it cannot; nothing in the join or approval path reads
 * this table. It says who to go and look at, not what is true.
 *
 * KEYED BY THE IDENTITY ROW. A reconnect inserts a NEW identity row rather
 * than updating the old one, so a verification bound to the row stops
 * matching automatically the moment somebody connects a different Telegram
 * account - and the dashboard says VERIFICATION_PENDING, which is the truth.
 */
class EmployeeTelegramGroupVerificationRepository {
  constructor(db) {
    this.db = db;
  }

  _log(code, err) {
    logger.Log({
      level: logger.LEVEL.ERROR,
      component: "REPOSITORY.EMPLOYEE_TELEGRAM_GROUP_VERIFICATION",
      code: `REPOSITORY.EMPLOYEE_TELEGRAM_GROUP_VERIFICATION.${code}`,
      description: err.toString(),
      category: "",
      ref: {},
    });
  }

  _query(code, sql, params) {
    return new Promise((resolve, reject) => {
      this.db.query(sql, params, (err, rows) => {
        if (err) {
          this._log(code, err);
          return reject(err);
        }
        resolve(rows);
      });
    });
  }

  /**
   * THE DASHBOARD READ. One query for every employee on the page.
   *
   * JOINED TO THE ACTIVE IDENTITY, so a verification taken against an
   * account the employee has since replaced is not returned at all - it is
   * excluded by the join rather than filtered afterwards, which means no
   * caller can forget to.
   *
   * Returns `Map<employee_id, Map<telegram_group_id, {membership,
   * readiness_status, verified_at}>>`.
   */
  async getForEmployees(employeeIds) {
    const ids = [
      ...new Set(
        (Array.isArray(employeeIds) ? employeeIds : [])
          .map(Number)
          .filter((id) => Number.isInteger(id) && id > 0)
      ),
    ];
    if (ids.length === 0) return new Map();

    const rows = await this._query(
      "FOR_EMPLOYEES",
      `SELECT v.employee_id, v.telegram_group_id, v.membership, v.readiness_status,
              v.verified_at
         FROM ${TABLE} v
         JOIN employee_telegram_identity i
           ON i.employee_telegram_id = v.employee_telegram_id
          AND i.disconnected_at IS NULL
        WHERE v.employee_id IN (?)`,
      [ids]
    );

    const out = new Map();
    for (const row of rows || []) {
      const employeeId = Number(row.employee_id);
      if (!out.has(employeeId)) out.set(employeeId, new Map());
      out.get(employeeId).set(Number(row.telegram_group_id), {
        membership: row.membership,
        readiness_status: row.readiness_status,
        verified_at: row.verified_at,
      });
    }
    return out;
  }

  /**
   * RECORD WHAT TELEGRAM JUST SAID. Upsert on (identity, group).
   *
   * ONLY A DEFINITIVE ANSWER REACHES THIS METHOD - the caller does not pass
   * TELEGRAM_UNAVAILABLE, and this refuses it anyway. Writing "we could not
   * ask" would overwrite a real verification with the absence of one, and a
   * momentary network failure would knock an employee off the Complete list
   * for no reason connected to them.
   *
   * `ON DUPLICATE KEY UPDATE` rather than delete-then-insert: one statement,
   * no window in which the row does not exist, and two concurrent detail
   * screens for the same employee cannot interleave into a missing row.
   */
  async record({ employeeTelegramId, employeeId, telegramGroupId, membership, readinessStatus, verifiedAt }) {
    if (readinessStatus === GROUP_READINESS.TELEGRAM_UNAVAILABLE) {
      return { recorded: false, reason: "NOT_DEFINITIVE" };
    }
    if (
      membership !== VERIFIED_MEMBERSHIP.JOINED &&
      membership !== VERIFIED_MEMBERSHIP.NOT_JOINED
    ) {
      return { recorded: false, reason: "NOT_DEFINITIVE" };
    }

    await this._query(
      "RECORD",
      `INSERT INTO ${TABLE}
         (employee_telegram_id, employee_id, telegram_group_id, membership,
          readiness_status, verified_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         membership = VALUES(membership),
         readiness_status = VALUES(readiness_status),
         verified_at = VALUES(verified_at)`,
      [
        employeeTelegramId,
        employeeId,
        telegramGroupId,
        membership,
        readinessStatus,
        verifiedAt,
      ]
    );
    return { recorded: true };
  }
}

module.exports = (db) => new EmployeeTelegramGroupVerificationRepository(db);
module.exports.EmployeeTelegramGroupVerificationRepository =
  EmployeeTelegramGroupVerificationRepository;
module.exports.TABLE = TABLE;
