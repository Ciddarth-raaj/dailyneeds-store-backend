const logger = require("../utils/logger");

/**
 * Stage 0C / C2 — Aadhaar verification and identity storage.
 *
 * Every statement here is against `employee_aadhaar_verification` and
 * `employee_aadhaar_identity`. Neither table is joined into any employee
 * list, the lifecycle history or `/employee/directory`, and this repository
 * is the only code that reads them.
 *
 * NO QUERY IN THIS FILE SELECTS THE CIPHERTEXT except `getIdentityForDecrypt`,
 * which exists for the one entitled path. Every other read returns the last
 * four digits and the fingerprint at most, and a test pins that.
 */

/** The safe projection: enough to display and to match, never to reconstruct. */
const IDENTITY_PUBLIC_COLUMNS = `
  aadhaar_identity_id, employee_id, aadhaar_last4, key_version,
  verification_id, verified_at, created_at, updated_at`;

class EmployeeAadhaarRepository {
  constructor(db) {
    this.db = db;
  }

  _log(code, err, ref = {}) {
    logger.Log({
      level: logger.LEVEL.ERROR,
      component: "REPOSITORY.EMPLOYEE_AADHAAR",
      code: `REPOSITORY.EMPLOYEE_AADHAAR.${code}`,
      description: err.toString(),
      category: "",
      ref,
    });
  }

  _read(code, sql, params) {
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

  /* ------------------------------------------------------- verification -- */

  /** A session by its opaque token; the numeric id is never the client's handle. */
  async findVerificationByToken(sessionToken) {
    const rows = await this._read(
      "FIND-VERIFICATION-BY-TOKEN",
      `SELECT verification_id, aadhaar_fingerprint, aadhaar_last4,
              aadhaar_ciphertext, aadhaar_iv, aadhaar_auth_tag, key_version,
              status, provider, provider_reference_id, provider_transaction_id,
              verified_at, consent_given, demographics_json, employee_id,
              otp_attempts, initiated_by_employee_id, expires_at
         FROM employee_aadhaar_verification WHERE session_token = ?`,
      [sessionToken]
    );
    return rows[0] || null;
  }

  /** Records the outcome of an OTP exchange. Guarded on the state it expects. */
  async updateVerification(verificationId, expectedStatus, patch) {
    const columns = Object.keys(patch);
    const rows = await this._read(
      "UPDATE-VERIFICATION",
      `UPDATE employee_aadhaar_verification
          SET ${columns.map((c) => `\`${c}\` = ?`).join(", ")}
        WHERE verification_id = ? AND status = ?`,
      [...columns.map((c) => patch[c]), verificationId, expectedStatus]
    );
    return rows.affectedRows;
  }

  async incrementOtpAttempts(verificationId) {
    const rows = await this._read(
      "INCREMENT-OTP-ATTEMPTS",
      "UPDATE employee_aadhaar_verification SET otp_attempts = otp_attempts + 1 WHERE verification_id = ?",
      [verificationId]
    );
    return rows.affectedRows;
  }

  async createVerification(row) {
    const columns = Object.keys(row);
    const rows = await this._read(
      "CREATE-VERIFICATION",
      `INSERT INTO employee_aadhaar_verification (${columns.map((c) => `\`${c}\``).join(", ")})
       VALUES (${columns.map(() => "?").join(", ")})`,
      columns.map((c) => row[c])
    );
    return rows.insertId;
  }

  /**
   * A verification ready to be consumed by a create: still `verified`, not
   * expired, and not already attached to an employee. Read inside the
   * caller's transaction and locked, so two concurrent creates cannot both
   * consume the same one.
   */
  async lockVerificationForUse(tx, verificationId) {
    const rows = await tx.query(
      `SELECT verification_id, aadhaar_fingerprint, aadhaar_last4,
              aadhaar_ciphertext, aadhaar_iv, aadhaar_auth_tag, key_version,
              status, provider, provider_reference, verified_at,
              consent_given, demographics_json, employee_id, expires_at
         FROM employee_aadhaar_verification
        WHERE verification_id = ?
        FOR UPDATE`,
      [verificationId]
    );
    return rows && rows[0] ? rows[0] : null;
  }

  /**
   * Marks the verification used and CLEARS the ciphertext from it: once the
   * identity row holds the number, a second copy on the verification is only
   * a second thing to leak.
   */
  async consumeVerification(tx, verificationId, employeeId) {
    const res = await tx.query(
      `UPDATE employee_aadhaar_verification
          SET status = 'consumed', employee_id = ?, consumed_at = NOW(),
              aadhaar_ciphertext = NULL, aadhaar_iv = NULL, aadhaar_auth_tag = NULL
        WHERE verification_id = ? AND status = 'verified'`,
      [employeeId, verificationId]
    );
    return res.affectedRows;
  }

  /** The audit view. No ciphertext, no fingerprint - last four only. */
  /**
   * Just the verified demographic payload, for Create Employee's pre-fill.
   *
   * `getVerification` above is the DISPLAY read and deliberately does not
   * select this column - a status screen has no business carrying somebody's
   * address. Keeping the two apart is why this is its own query rather than
   * one more column on that one.
   */
  async getVerificationDemographics(verificationId) {
    const rows = await this._read(
      "GET-VERIFICATION-DEMOGRAPHICS",
      `SELECT verification_id, status, demographics_json
         FROM employee_aadhaar_verification WHERE verification_id = ?`,
      [verificationId]
    );
    return rows[0] || null;
  }

  async getVerification(verificationId) {
    const rows = await this._read(
      "GET-VERIFICATION",
      `SELECT verification_id, aadhaar_last4, status, provider, provider_reference,
              failure_reason, verified_at, consent_given, consent_version,
              consent_actor_employee_id, consent_at, employee_id, consumed_at,
              expires_at, created_at
         FROM employee_aadhaar_verification WHERE verification_id = ?`,
      [verificationId]
    );
    return rows[0] || null;
  }

  /* ----------------------------------------------------------- identity -- */

  /**
   * Who, if anyone, already holds this Aadhaar - with the employment state
   * needed to tell HR whether to rejoin them or that they are already here.
   * Returns no ciphertext.
   */
  async findByFingerprint(fingerprint, tx = null) {
    const sql = `
      SELECT i.employee_id, i.aadhaar_last4, i.verified_at,
             ne.status AS employee_status,
             cur.period_no, cur.period_state,
             DATE_FORMAT(cur.ended_on, '%Y-%m-%d') AS last_ended_on
        FROM employee_aadhaar_identity i
        JOIN new_employee ne ON ne.employee_id = i.employee_id
        LEFT JOIN (
          SELECT p.employee_id, p.period_no, p.period_state, p.ended_on
            FROM employee_employment_period p
            JOIN ( SELECT employee_id, MAX(period_no) AS period_no
                     FROM employee_employment_period GROUP BY employee_id ) l
              ON l.employee_id = p.employee_id AND l.period_no = p.period_no
        ) cur ON cur.employee_id = i.employee_id
       WHERE i.aadhaar_fingerprint = ?`;
    const rows = tx ? await tx.query(sql, [fingerprint]) : await this._read("FIND-BY-FINGERPRINT", sql, [fingerprint]);
    return rows && rows[0] ? rows[0] : null;
  }

  async createIdentity(tx, row) {
    const columns = Object.keys(row);
    const res = await tx.query(
      `INSERT INTO employee_aadhaar_identity (${columns.map((c) => `\`${c}\``).join(", ")})
       VALUES (${columns.map(() => "?").join(", ")})`,
      columns.map((c) => row[c])
    );
    return res.insertId;
  }

  /** The display record for one employee. Never the number. */
  async getIdentity(employeeId) {
    const rows = await this._read(
      "GET-IDENTITY",
      `SELECT ${IDENTITY_PUBLIC_COLUMNS} FROM employee_aadhaar_identity WHERE employee_id = ?`,
      [employeeId]
    );
    return rows[0] || null;
  }

  /**
   * The ONE query that returns ciphertext, for the one caller entitled to
   * decrypt - PF and ESI filing, behind `view_aadhaar_full`. Named so that a
   * reviewer grepping for the ciphertext finds exactly this.
   */
  async getIdentityForDecrypt(employeeId) {
    const rows = await this._read(
      "GET-IDENTITY-FOR-DECRYPT",
      `SELECT employee_id, aadhaar_ciphertext, aadhaar_iv, aadhaar_auth_tag, key_version, aadhaar_last4
         FROM employee_aadhaar_identity WHERE employee_id = ?`,
      [employeeId]
    );
    return rows[0] || null;
  }
}

module.exports = (db) => new EmployeeAadhaarRepository(db);
module.exports.EmployeeAadhaarRepository = EmployeeAadhaarRepository;
module.exports.IDENTITY_PUBLIC_COLUMNS = IDENTITY_PUBLIC_COLUMNS;
