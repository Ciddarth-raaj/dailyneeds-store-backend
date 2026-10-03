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

  _read(code, sql, params, conn = null, { quiet = [] } = {}) {
    return new Promise((resolve, reject) => {
      (conn || this.db).query(sql, params, (err, rows) => {
        if (err && quiet.includes(err.code)) {
          reject(err);
          return;
        }
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

  /**
   * The outbox's single-statement writes (claim, complete, recover) run in
   * autocommit and are safe to repeat. Concurrent ones can still deadlock on
   * the pending-marker unique index; InnoDB rolls one back, and it is simply
   * run again - a bounded number of times.
   */
  async _outboxWrite(code, sql, params) {
    for (let tries = 0; ; tries += 1) {
      try {
        // eslint-disable-next-line no-await-in-loop
        return await this._read(code, sql, params, null, { quiet: tries < 4 ? ["ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT"] : [] });
      } catch (err) {
        if (err && (err.code === "ER_LOCK_DEADLOCK" || err.code === "ER_LOCK_WAIT_TIMEOUT") && tries < 4) {
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, 10 + Math.floor(Math.random() * 40)));
          continue;
        }
        throw err;
      }
    }
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
              DATE_FORMAT(COALESCE(n.completed_at, n.attempted_at, n.queued_at), '%Y-%m-%d %H:%i:%s') AS notification_attempted_at
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
              DATE_FORMAT(queued_at, '%Y-%m-%d %H:%i:%s') AS queued_at,
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
   * RETRY NOTIFICATION: queue one more attempt (trigger RETRY). The attempt
   * number is the next for the payslip; the unique pending marker refuses a
   * second QUEUED / SENDING attempt for the same payslip, which is how two
   * Retry clicks never become two sends.
   * @returns {{ queued: boolean, reason?: string }}
   */
  async enqueueRetry({ payslip_id, employee_id, requested_by = null, requested_by_user = null }) {
    for (let tries = 0; ; tries += 1) {
      // eslint-disable-next-line no-await-in-loop
      const [last] = await this._read(
        "NEXT-NOTIFICATION-ATTEMPT",
        "SELECT COALESCE(MAX(attempt_no), 0) AS n FROM payrun_payslip_notification WHERE payslip_id = ?",
        [payslip_id]
      );
      try {
        // eslint-disable-next-line no-await-in-loop
        await this._read(
          "QUEUE-RETRY-NOTIFICATION",
          `INSERT INTO payrun_payslip_notification
                  (payslip_id, employee_id, attempt_no, trigger_type, result, requested_by, requested_by_user)
           VALUES (?, ?, ?, 'RETRY', 'QUEUED', ?, ?)`,
          [payslip_id, employee_id, Number(last.n) + 1, requested_by, requested_by_user],
          null,
          { quiet: ["ER_DUP_ENTRY", "ER_LOCK_DEADLOCK"] }
        );
        return { queued: true };
      } catch (err) {
        if (err && err.code === "ER_DUP_ENTRY") {
          if (/uq_payslip_notification_pending/.test(String(err.message))) return { queued: false, reason: "ALREADY_PENDING" };
          if (tries < 4) continue;
        }
        if (err && err.code === "ER_LOCK_DEADLOCK" && tries < 4) continue;
        throw err;
      }
    }
  }

  /**
   * CLAIM up to `limit` QUEUED attempts for one worker pass. The UPDATE is
   * the claim - atomic, so two passes (or two processes) can never take the
   * same row - and the rows are then read back by the claim token, with
   * whether their payslip is still ACTIVE and published.
   */
  async claimQueued({ limit, token }) {
    await this._outboxWrite(
      "CLAIM-QUEUED",
      `UPDATE payrun_payslip_notification
          SET result = 'SENDING', claim_token = ?, attempted_at = CURRENT_TIMESTAMP(3)
        WHERE result = 'QUEUED'
        ORDER BY notification_id
        LIMIT ?`,
      [token, limit]
    );
    return this._read(
      "READ-CLAIMED",
      `SELECT n.notification_id, n.payslip_id, n.employee_id, n.attempt_no, n.trigger_type,
              p.period_year, p.period_month,
              (p.status = 'ACTIVE' AND c.payrun_calculation_id IS NOT NULL) AS deliverable
         FROM payrun_payslip_notification n
         JOIN payrun_payslip p ON p.payslip_id = n.payslip_id
         LEFT JOIN payrun_employee_calculation c
           ON c.payrun_employee_id = p.payrun_employee_id
          AND c.payrun_calculation_id = p.payrun_calculation_id
          AND c.status = 'APPROVED_LOCKED'
          AND c.published_at IS NOT NULL
        WHERE n.claim_token = ? AND n.result = 'SENDING'
        ORDER BY n.notification_id`,
      [token]
    );
  }

  /** Record a claimed attempt's outcome - only by the pass that claimed it. */
  async completeNotification({
    notification_id, claim_token, result,
    employee_telegram_id = null, private_chat_id = null, telegram_message_id = null,
    failure_code = null, failure_reason = null,
  }) {
    const res = await this._outboxWrite(
      "COMPLETE-NOTIFICATION",
      `UPDATE payrun_payslip_notification
          SET result = ?, employee_telegram_id = ?, private_chat_id = ?, telegram_message_id = ?,
              failure_code = ?, failure_reason = ?, completed_at = CURRENT_TIMESTAMP(3)
        WHERE notification_id = ? AND claim_token = ? AND result = 'SENDING'`,
      [
        result, employee_telegram_id, private_chat_id, telegram_message_id,
        failure_code, failure_reason ? String(failure_reason).slice(0, 255) : null,
        notification_id, claim_token,
      ]
    );
    return Number(res.affectedRows || 0) === 1;
  }

  /**
   * AFTER A RESTART: an attempt left SENDING longer than any send can take
   * belonged to a process that died mid-send. Whether Telegram delivered it
   * is unknowable, so it is NOT re-sent (that could notify twice): it is
   * closed as FAILED / INTERRUPTED, and Retry Notification is offered.
   * QUEUED attempts need no recovery - the next pass simply claims them.
   */
  async recoverInterrupted({ olderThanSeconds }) {
    const res = await this._outboxWrite(
      "RECOVER-INTERRUPTED",
      `UPDATE payrun_payslip_notification
          SET result = 'FAILED', failure_code = 'INTERRUPTED',
              failure_reason = 'The server stopped while sending; delivery is unknown. Use Retry Notification.',
              completed_at = CURRENT_TIMESTAMP(3)
        WHERE result = 'SENDING'
          AND attempted_at < (CURRENT_TIMESTAMP(3) - INTERVAL ? SECOND)`,
      [olderThanSeconds]
    );
    return Number(res.affectedRows || 0);
  }

  /** The company records Publish chooses the payslip issuer from (utils/payslip_company.js). */
  async listCompanies() {
    return this._read(
      "LIST-COMPANIES",
      "SELECT company_id, company_name, reg_address, pf_number, esi_number, status FROM company_details ORDER BY company_id",
      []
    );
  }
}

module.exports = (db) => new PayrunPayslipRepository(db);
module.exports.PayrunPayslipRepository = PayrunPayslipRepository;
module.exports.PUBLISHED_JOIN = PUBLISHED_JOIN;
