const logger = require("../utils/logger");

/**
 * PAYSLIPS - the frozen snapshots Publish creates, the Mini App reads, and
 * the notification attempts made about them.
 *
 * THE SNAPSHOT IS NEVER UPDATED. There is no UPDATE of `snapshot_json`,
 * `snapshot_sha256`, `template_version` or any figure column anywhere in this
 * codebase; the only UPDATEs of `payrun_payslip` set view tracking (here) and
 * the ARCHIVED status (in the Unpublish transaction,
 * `repository/payrun_calculation.js#lifecycle`). A test pins that.
 *
 * EVERY SELF-SERVICE READ IS PINNED TO ONE EMPLOYEE. `employee_id` is an
 * argument the caller takes from the verified Telegram session, and every
 * statement below that serves the Mini App names it in its WHERE clause -
 * together with `status = 'ACTIVE'` AND the calculation row still being
 * published for the same calculation. A payslip that is archived, belongs to
 * somebody else, or whose month was unpublished is simply not a row.
 *
 * NO SALARY FIGURE IS LOGGED. Errors log a code and ids only.
 */
const PUBLISHED_JOIN = `
  JOIN payrun_employee_calculation c
    ON c.payrun_employee_id = p.payrun_employee_id
   AND c.payrun_calculation_id = p.payrun_calculation_id
   AND c.status = 'APPROVED_LOCKED'
   AND c.published_at IS NOT NULL`;

class PayrunPayslipRepository {
  constructor(db) {
    this.db = db;
  }

  _read(code, sql, params, conn = null) {
    return new Promise((resolve, reject) => {
      (conn || this.db).query(sql, params, (err, rows) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.PAYRUN_PAYSLIP",
            code: `REPOSITORY.PAYRUN_PAYSLIP.${code}`,
            description: err.toString(),
            category: "",
            ref: {},
          });
          reject(err);
          return;
        }
        resolve(rows || []);
      });
    });
  }

  /* ------------------------------------------------------- self-service */

  /** The employee's own published payslips, newest month first. No figures. */
  async listPublishedForEmployee(employeeId) {
    return this._read(
      "LIST-FOR-EMPLOYEE",
      `SELECT p.payslip_ref, p.period_year, p.period_month, p.payslip_version,
              DATE_FORMAT(p.published_at, '%Y-%m-%d %H:%i:%s') AS published_at,
              DATE_FORMAT(p.first_viewed_at, '%Y-%m-%d %H:%i:%s') AS first_viewed_at
         FROM payrun_payslip p ${PUBLISHED_JOIN}
        WHERE p.employee_id = ? AND p.status = 'ACTIVE'
        ORDER BY p.period_year DESC, p.period_month DESC`,
      [employeeId]
    );
  }

  /** One of the employee's own ACTIVE published payslips, by its random ref. */
  async getPublishedForEmployee(employeeId, payslipRef) {
    const rows = await this._read(
      "GET-FOR-EMPLOYEE",
      `SELECT p.payslip_id, p.payslip_ref, p.employee_id, p.period_year, p.period_month,
              p.payslip_version, p.template_version, p.snapshot_json, p.snapshot_sha256,
              DATE_FORMAT(p.published_at, '%Y-%m-%d %H:%i:%s') AS published_at
         FROM payrun_payslip p ${PUBLISHED_JOIN}
        WHERE p.employee_id = ? AND p.payslip_ref = ? AND p.status = 'ACTIVE'`,
      [employeeId, payslipRef]
    );
    return rows.length === 0 ? null : rows[0];
  }

  /**
   * PROOF OF ACCESS. The first successful open sets `first_viewed_at` and no
   * later open moves it; `last_viewed_at` and the count follow every open.
   * Pinned to the employee and to ACTIVE - nothing else on the row is named.
   */
  async recordView(payslipId, employeeId) {
    const res = await this._read(
      "RECORD-VIEW",
      `UPDATE payrun_payslip
          SET first_viewed_at = COALESCE(first_viewed_at, CURRENT_TIMESTAMP),
              last_viewed_at = CURRENT_TIMESTAMP,
              view_count = view_count + 1
        WHERE payslip_id = ? AND employee_id = ? AND status = 'ACTIVE'`,
      [payslipId, employeeId]
    );
    return Number(res.affectedRows || 0) === 1;
  }

  /* ------------------------------------------------------------- admin */

  /**
   * The month's ACTIVE payslips with view tracking and the LATEST
   * notification attempt - the payroll screen's columns. No snapshot text.
   */
  async listMonthStatus({ year, month, employee_ids = null }) {
    const params = [year, month];
    let clause = "";
    if (Array.isArray(employee_ids)) {
      if (employee_ids.length === 0) return [];
      clause = " AND p.employee_id IN (?)";
      params.push(employee_ids);
    }
    return this._read(
      "LIST-MONTH-STATUS",
      `SELECT p.payslip_id, p.employee_id, p.payslip_version,
              DATE_FORMAT(p.published_at, '%Y-%m-%d %H:%i:%s') AS payslip_published_at,
              DATE_FORMAT(p.first_viewed_at, '%Y-%m-%d %H:%i:%s') AS first_viewed_at,
              DATE_FORMAT(p.last_viewed_at, '%Y-%m-%d %H:%i:%s') AS last_viewed_at,
              p.view_count,
              n.result AS notification_result, n.attempt_no AS notification_attempts,
              n.failure_code AS notification_failure_code,
              DATE_FORMAT(n.attempted_at, '%Y-%m-%d %H:%i:%s') AS notification_attempted_at
         FROM payrun_payslip p
         LEFT JOIN payrun_payslip_notification n
           ON n.payslip_id = p.payslip_id
          AND n.attempt_no = (SELECT MAX(n2.attempt_no) FROM payrun_payslip_notification n2
                               WHERE n2.payslip_id = p.payslip_id)
        WHERE p.period_year = ? AND p.period_month = ? AND p.status = 'ACTIVE'${clause}`,
      params
    );
  }

  /** One employee month's ACTIVE payslip for the admin viewer, or null. */
  async getActiveForMonth({ year, month, employee_id }) {
    const rows = await this._read(
      "GET-ACTIVE-FOR-MONTH",
      `SELECT payslip_id, payslip_ref, employee_id, period_year, period_month, payslip_version,
              template_version, snapshot_schema_version, snapshot_json, snapshot_sha256,
              calculation_version, calculation_revision, calculation_hash,
              published_by, DATE_FORMAT(published_at, '%Y-%m-%d %H:%i:%s') AS published_at,
              DATE_FORMAT(first_viewed_at, '%Y-%m-%d %H:%i:%s') AS first_viewed_at,
              DATE_FORMAT(last_viewed_at, '%Y-%m-%d %H:%i:%s') AS last_viewed_at,
              view_count
         FROM payrun_payslip
        WHERE period_year = ? AND period_month = ? AND employee_id = ? AND status = 'ACTIVE'`,
      [year, month, employee_id]
    );
    return rows.length === 0 ? null : rows[0];
  }

  /** Every version of one employee month, newest first - history, no snapshot text. */
  async listVersions({ year, month, employee_id }) {
    return this._read(
      "LIST-VERSIONS",
      `SELECT payslip_id, payslip_version, status, calculation_revision, calculation_hash,
              template_version, snapshot_sha256,
              published_by, DATE_FORMAT(published_at, '%Y-%m-%d %H:%i:%s') AS published_at,
              archived_by, DATE_FORMAT(archived_at, '%Y-%m-%d %H:%i:%s') AS archived_at, archive_reason,
              DATE_FORMAT(first_viewed_at, '%Y-%m-%d %H:%i:%s') AS first_viewed_at
         FROM payrun_payslip
        WHERE period_year = ? AND period_month = ? AND employee_id = ?
        ORDER BY payslip_version DESC`,
      [year, month, employee_id]
    );
  }

  /** One payslip's notification attempts, newest first. No chat id leaves here. */
  async listNotifications(payslipId) {
    return this._read(
      "LIST-NOTIFICATIONS",
      `SELECT attempt_no, trigger_type, result, telegram_message_id, failure_code, failure_reason,
              requested_by,
              DATE_FORMAT(attempted_at, '%Y-%m-%d %H:%i:%s') AS attempted_at,
              DATE_FORMAT(completed_at, '%Y-%m-%d %H:%i:%s') AS completed_at
         FROM payrun_payslip_notification
        WHERE payslip_id = ?
        ORDER BY attempt_no DESC`,
      [payslipId]
    );
  }

  /**
   * What the snapshot needs that the payrun snapshot does not freeze: the
   * department NAME and the bank / PAN identifiers. Read once at Publish and
   * masked before they are stored - the full values never leave the usecase.
   */
  async listEmployeeExtras(employeeIds) {
    if (!Array.isArray(employeeIds) || employeeIds.length === 0) return [];
    return this._read(
      "LIST-EMPLOYEE-EXTRAS",
      `SELECT ne.employee_id, ne.bank_name, ne.account_no, ne.pan_no, dp.department_name
         FROM new_employee ne
         LEFT JOIN department dp ON dp.department_id = ne.department_id
        WHERE ne.employee_id IN (?)`,
      [employeeIds]
    );
  }

  /* ------------------------------------------------------ notifications */

  /**
   * One finished attempt, append-only. The attempt number is the next one for
   * the payslip: read without a locking read (an `INSERT ... SELECT MAX`
   * takes gap locks and deadlocks when a bulk publish notifies several
   * employees at once), then inserted; the unique (payslip_id, attempt_no)
   * key refuses a concurrent duplicate, and the attempt is renumbered.
   */
  async insertNotification({
    payslip_id, employee_id, trigger_type, result,
    employee_telegram_id = null, private_chat_id = null, telegram_message_id = null,
    failure_code = null, failure_reason = null, requested_by = null, requested_by_user = null,
    attempted_at,
  }) {
    for (let tries = 0; ; tries += 1) {
      // eslint-disable-next-line no-await-in-loop
      const [last] = await this._read(
        "NEXT-NOTIFICATION-ATTEMPT",
        "SELECT COALESCE(MAX(attempt_no), 0) AS n FROM payrun_payslip_notification WHERE payslip_id = ?",
        [payslip_id]
      );
      try {
        // eslint-disable-next-line no-await-in-loop
        const res = await this._read(
          "INSERT-NOTIFICATION",
          `INSERT INTO payrun_payslip_notification
                  (payslip_id, employee_id, attempt_no, trigger_type, result,
                   employee_telegram_id, private_chat_id, telegram_message_id,
                   failure_code, failure_reason, requested_by, requested_by_user,
                   attempted_at, completed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP(3))`,
          [
            payslip_id, employee_id, Number(last.n) + 1, trigger_type, result,
            employee_telegram_id, private_chat_id, telegram_message_id,
            failure_code, failure_reason ? String(failure_reason).slice(0, 255) : null,
            requested_by, requested_by_user, attempted_at,
          ]
        );
        return Number(res.insertId || 0);
      } catch (err) {
        if (err && err.code === "ER_DUP_ENTRY" && tries < 4) continue;
        throw err;
      }
    }
  }
}

module.exports = (db) => new PayrunPayslipRepository(db);
module.exports.PayrunPayslipRepository = PayrunPayslipRepository;
module.exports.PUBLISHED_JOIN = PUBLISHED_JOIN;
