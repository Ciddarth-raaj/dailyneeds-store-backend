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
  duplicate_of_employee_id,
  override_by_employee_id, override_at, override_reason, override_kind,
  rejected_by_employee_id, rejected_at, rejection_reason,
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

  /**
   * Other employees whose VERIFIED bank verification was run against this
   * exact account, and who are STILL EMPLOYED.
   *
   * Two active employees sharing one account is the case worth catching: it
   * is either a data-entry error or one person collecting two salaries. A
   * former employee sharing it is not - a spouse taking over an account, or
   * the same person rejoining, are ordinary - so `new_employee.status = 1`
   * is part of the query rather than something the caller filters afterwards.
   *
   * Returns the other employee's id and name so authorised HR can resolve it.
   * NO ACCOUNT COLUMN IS SELECTED: the fingerprint is the only thing compared,
   * and it is not returned either.
   */
  async findActiveDuplicates(fingerprint, exceptEmployeeId) {
    return this._query(
      "FIND-ACTIVE-DUPLICATES",
      `SELECT v.employee_id, ne.employee_name, v.status, v.account_last4,
              DATE_FORMAT(v.verified_at, '%Y-%m-%d') AS verified_on
         FROM employee_bank_verification v
         JOIN new_employee ne ON ne.employee_id = v.employee_id
        WHERE v.account_fingerprint = ?
          AND v.employee_id <> ?
          AND ne.status = 1
          AND v.status = 'VERIFIED'
        ORDER BY v.employee_id`,
      [fingerprint, exceptEmployeeId]
    );
  }

  /**
   * The bank details for MANY employees, for the status summary the HR list
   * needs. The single-employee `getBankDetails` above cannot be looped 630
   * times, which is the whole reason this exists.
   *
   * It selects the full account number for the same reason that one does:
   * the fingerprint of the current account can only be computed from it. It
   * is compared in memory and discarded - no caller of this method returns
   * an account number, and the summary endpoint returns a status and nothing
   * else.
   */
  async getBankDetailsMany(employeeIds) {
    if (!Array.isArray(employeeIds) || employeeIds.length === 0) return [];
    return this._query(
      "GET-BANK-DETAILS-MANY",
      `SELECT employee_id, account_no, ifsc
         FROM new_employee WHERE employee_id IN (?)`,
      [employeeIds]
    );
  }

  /**
   * The stored verifications for MANY employees. `account_fingerprint` is
   * included - it is not returned anywhere, it is what decides whether a
   * stored VERIFIED still describes the account on file.
   */
  async getVerificationsMany(employeeIds) {
    if (!Array.isArray(employeeIds) || employeeIds.length === 0) return [];
    return this._query(
      "GET-VERIFICATIONS-MANY",
      `SELECT employee_id, status, account_fingerprint, name_match_verdict
         FROM employee_bank_verification WHERE employee_id IN (?)`,
      [employeeIds]
    );
  }

  /**
   * For each of these fingerprints, which STILL-EMPLOYED employees are
   * verified against it. The bulk form of `findActiveDuplicates`, and it
   * applies the same three conditions - active employee, VERIFIED
   * verification, matching fingerprint - so the summary resolves a stale
   * duplicate exactly as the single-employee read does.
   *
   * Returns `{ account_fingerprint, employee_id }` pairs so the caller can
   * exclude the employee being judged, as the single-employee query does in
   * SQL. No account column is selected.
   */
  async findActiveVerifiedByFingerprints(fingerprints) {
    if (!Array.isArray(fingerprints) || fingerprints.length === 0) return [];
    return this._query(
      "FIND-ACTIVE-VERIFIED-BY-FINGERPRINTS",
      `SELECT v.account_fingerprint, v.employee_id
         FROM employee_bank_verification v
         JOIN new_employee ne ON ne.employee_id = v.employee_id
        WHERE v.account_fingerprint IN (?)
          AND ne.status = 1
          AND v.status = 'VERIFIED'`,
      [fingerprints]
    );
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

  /**
   * An administrator accepting a shared account. Guarded on the status AND
   * the fingerprint, so an override cannot land on a different account or on
   * a row that has since stopped being a duplicate.
   *
   * The reason is stored, not optional: an override nobody can be named for,
   * with no stated reason, is not an audit trail. `override_kind` says WHICH
   * check was waived, so this can never be read back as a name-mismatch
   * override.
   */
  async overrideDuplicate(employeeId, fingerprint, { actorEmployeeId, reason }) {
    const rows = await this._query(
      "OVERRIDE-DUPLICATE",
      `UPDATE employee_bank_verification
          SET status = 'VERIFIED', verified_at = NOW(),
              override_by_employee_id = ?, override_at = NOW(), override_reason = ?,
              override_kind = 'DUPLICATE_ACCOUNT'
        WHERE employee_id = ? AND status = 'DUPLICATE_ACCOUNT' AND account_fingerprint = ?`,
      [actorEmployeeId, reason, employeeId, fingerprint]
    );
    return rows.affectedRows;
  }

  /**
   * A reviewer accepting that the name at the bank IS this employee.
   *
   * Distinct from `confirmNameMismatch` above in two ways that matter. It
   * records the decision in the OVERRIDE columns rather than the confirmation
   * ones, stamped `override_kind = 'NAME_MISMATCH'`, because that is what it
   * is: a check the bank did not pass, waived by a named human. And the
   * reason is required rather than an optional note - the usecase refuses an
   * empty one before this is reached.
   *
   * Guarded on the status and the fingerprint like every other write here, so
   * an approval cannot land on an account that has since been changed or on a
   * row that has stopped being a mismatch.
   *
   * The verdict is deliberately NOT part of the guard: a REVIEW and a
   * MISMATCH are both reviewable, and which of them this was is already
   * recorded in `name_match_verdict` on the same row.
   */
  async approveNameMismatch(employeeId, fingerprint, { actorEmployeeId, reason }) {
    const rows = await this._query(
      "APPROVE-NAME-MISMATCH",
      `UPDATE employee_bank_verification
          SET status = 'VERIFIED', verified_at = NOW(),
              override_by_employee_id = ?, override_at = NOW(), override_reason = ?,
              override_kind = 'NAME_MISMATCH'
        WHERE employee_id = ? AND status = 'NAME_MISMATCH' AND account_fingerprint = ?`,
      [actorEmployeeId, reason, employeeId, fingerprint]
    );
    return rows.affectedRows;
  }

  /**
   * A reviewer turning the account down. The third outcome of a review, and
   * the one that had nowhere to go before: the details are not obviously
   * wrong to re-type, and the account is not this employee's.
   *
   * REJECTED is not payroll-ready, so this keeps the payout blocked rather
   * than releasing it. `verified_at` is deliberately untouched - the bank's
   * own answer, and when it was given, are not altered by a human disagreeing
   * with what it means.
   */
  async rejectBankAccount(employeeId, fingerprint, { actorEmployeeId, reason }) {
    const rows = await this._query(
      "REJECT-BANK-ACCOUNT",
      `UPDATE employee_bank_verification
          SET status = 'REJECTED',
              rejected_by_employee_id = ?, rejected_at = NOW(), rejection_reason = ?
        WHERE employee_id = ? AND status = 'NAME_MISMATCH' AND account_fingerprint = ?`,
      [actorEmployeeId, reason, employeeId, fingerprint]
    );
    return rows.affectedRows;
  }
}

module.exports = (db) => new EmployeeBankRepository(db);
module.exports.EmployeeBankRepository = EmployeeBankRepository;
module.exports.PUBLIC_COLUMNS = PUBLIC_COLUMNS;
