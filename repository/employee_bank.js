const logger = require("../utils/logger");

/**
 * Stage 0C / C2 — bank verification storage.
 *
 * The account number and IFSC themselves stay where they already are, on
 * `new_employee`, where B3 already treats `account_no`, `ifsc` and
 * `bank_name` as sensitive. Moving them would be churn for no gain. What is
 * added here is the VERIFICATION METADATA beside them: what the bank said,
 * when, about which account, and whether anyone accepted a name that did not
 * quite match.
 *
 * `account_fingerprint` is the link between the two. It is a keyed HMAC of
 * the account number and IFSC the check was run against, so this table can
 * tell whether a stored VERIFIED still describes the account on file without
 * ever holding the account number itself. Change either, and the fingerprint
 * no longer matches - which is exactly how invalidation is detected rather
 * than remembered.
 *
 * No query here selects a full account number. The only account column is
 * `account_last4`.
 */

const PUBLIC_COLUMNS = `
  bank_verification_id, employee_id, status, account_last4, ifsc,
  name_at_bank, account_exists, name_match_verdict, name_match_reason,
  name_match_score, provider, provider_transaction_id, provider_status,
  failure_category, verified_at, last_attempted_at,
  confirmed_by_employee_id, confirmed_at, confirmation_note,
  created_at, updated_at`;

class EmployeeBankRepository {
  constructor(db) {
    this.db = db;
  }

  _log(code, err, ref = {}) {
    logger.Log({
      level: logger.LEVEL.ERROR,
      component: "REPOSITORY.EMPLOYEE_BANK",
      code: `REPOSITORY.EMPLOYEE_BANK.${code}`,
      description: err.toString(),
      category: "",
      ref,
    });
  }

  _query(code, sql, params) {
    return new Promise((resolve, reject) => {
      this.db.query(sql, params, (err, rows) => {
        if (err) {
          this._log(code, err);
          reject(err);
          return;
        }
        resolve(rows || []);
      });
    });
  }

  /**
   * The bank details on the employee master, for the verification to run
   * against. This is the one place C2 reads the full account number, and it
   * is handed straight to the provider service and never returned upward.
   */
  async getBankDetails(employeeId) {
    const rows = await this._query(
      "GET-BANK-DETAILS",
      `SELECT employee_id, employee_name, account_no, ifsc, bank_name
         FROM new_employee WHERE employee_id = ?`,
      [employeeId]
    );
    return rows[0] || null;
  }

  /** The current verification. Never a full account number. */
  async getVerification(employeeId) {
    const rows = await this._query(
      "GET-VERIFICATION",
      `SELECT ${PUBLIC_COLUMNS} FROM employee_bank_verification WHERE employee_id = ?`,
      [employeeId]
    );
    return rows[0] || null;
  }

  /**
   * The fingerprint the stored verification was performed against, so the
   * usecase can tell whether it still describes the current account.
   */
  async getStoredFingerprint(employeeId) {
    const rows = await this._query(
      "GET-STORED-FINGERPRINT",
      "SELECT account_fingerprint, status FROM employee_bank_verification WHERE employee_id = ?",
      [employeeId]
    );
    return rows[0] || null;
  }

  /** One row per employee: inserted the first time, replaced thereafter. */
  async upsertVerification(row) {
    const columns = Object.keys(row);
    const updatable = columns.filter((c) => c !== "employee_id");
    return this._query(
      "UPSERT-VERIFICATION",
      `INSERT INTO employee_bank_verification (${columns.map((c) => `\`${c}\``).join(", ")})
       VALUES (${columns.map(() => "?").join(", ")})
       ON DUPLICATE KEY UPDATE ${updatable.map((c) => `\`${c}\` = VALUES(\`${c}\`)`).join(", ")}`,
      columns.map((c) => row[c])
    );
  }

  /** Append-only: every attempt, including the failures. */
  async recordAttempt(row) {
    const columns = Object.keys(row);
    return this._query(
      "RECORD-ATTEMPT",
      `INSERT INTO employee_bank_verification_attempt (${columns.map((c) => `\`${c}\``).join(", ")})
       VALUES (${columns.map(() => "?").join(", ")})`,
      columns.map((c) => row[c])
    );
  }

  async listAttempts(employeeId, limit = 20) {
    return this._query(
      "LIST-ATTEMPTS",
      `SELECT attempt_id, outcome, account_last4, ifsc, account_exists, name_at_bank,
              name_match_verdict, failure_category, provider, provider_transaction_id,
              requested_by_employee_id, created_at
         FROM employee_bank_verification_attempt
        WHERE employee_id = ? ORDER BY attempt_id DESC LIMIT ?`,
      [employeeId, Number(limit)]
    );
  }

  /**
   * Confirms a REVIEW verdict. Guarded on the status so a race cannot turn a
   * FAILED or an already-VERIFIED row into a confirmed one, and on the
   * fingerprint so a confirmation cannot land on an account that has since
   * been changed.
   */
  async confirmNameMismatch(employeeId, fingerprint, { actorEmployeeId, note }) {
    const rows = await this._query(
      "CONFIRM-NAME-MISMATCH",
      `UPDATE employee_bank_verification
          SET status = 'VERIFIED', verified_at = NOW(),
              confirmed_by_employee_id = ?, confirmed_at = NOW(), confirmation_note = ?
        WHERE employee_id = ? AND status = 'NAME_MISMATCH' AND account_fingerprint = ?`,
      [actorEmployeeId, note || null, employeeId, fingerprint]
    );
    return rows.affectedRows;
  }
}

module.exports = (db) => new EmployeeBankRepository(db);
module.exports.EmployeeBankRepository = EmployeeBankRepository;
module.exports.PUBLIC_COLUMNS = PUBLIC_COLUMNS;
