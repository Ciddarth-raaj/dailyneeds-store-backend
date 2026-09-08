const nodeCrypto = require("crypto");
const logger = require("../utils/logger");
const aadhaarConfig = require("../config/aadhaar");
const { compareNameAtBank } = require("../utils/name_match");
const { SandboxError, FAILURE } = require("../services/sandbox_client");

/**
 * Stage 0C / C2 — Penny-Less bank verification.
 *
 * Bank details are OPTIONAL at onboarding. An employee can be created,
 * resign and rejoin without a bank account ever being entered; nothing in the
 * lifecycle depends on this file. What it produces is a status that payroll
 * will later read before paying anybody by bank transfer.
 *
 * THE STATUS IS NOT A BOOLEAN, because the interesting case is neither true
 * nor false:
 *
 *   NOT_PROVIDED   no account on file
 *   PENDING        an account is on file that has not been verified against
 *                  this bank, including one whose details just changed
 *   VERIFIED       the account exists and the name is acceptable
 *   NAME_MISMATCH  the account exists, but the name needs a human
 *   FAILED         the bank says no such account, or the check could not be
 *                  completed
 *
 * A "verified" flag would have to lie about NAME_MISMATCH, which is the row
 * somebody actually has to look at.
 *
 * VERIFICATION IS TIED TO THE ACCOUNT IT WAS RUN AGAINST. The account number
 * and IFSC are fingerprinted, and every read compares that fingerprint with
 * the details currently on the employee. Change either and the stored
 * VERIFIED stops applying - not because something remembered to clear it, but
 * because it no longer describes the account on file.
 */

const STATUS = {
  NOT_PROVIDED: "NOT_PROVIDED",
  PENDING: "PENDING",
  VERIFIED: "VERIFIED",
  NAME_MISMATCH: "NAME_MISMATCH",
  FAILED: "FAILED",
};

class ValidationError extends Error {
  constructor(message, httpCode = 422) {
    super(message);
    this.name = "ValidationError";
    this.httpCode = httpCode;
  }
}
class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = "NotFoundError";
    this.httpCode = 404;
  }
}
class ConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConflictError";
    this.httpCode = 409;
  }
}

const last4 = (account) => String(account).slice(-4);
/** What any screen or log may show. */
const maskAccount = (account) => {
  const a = String(account);
  return a.length <= 4 ? "****" : `${"*".repeat(a.length - 4)}${a.slice(-4)}`;
};

class EmployeeBankUsecase {
  /**
   * `aadhaarRepo` is optional and read-only: when an employee has a verified
   * Aadhaar, the name on it is a second, more authoritative thing to compare
   * the bank's name against. Its absence never blocks a bank verification.
   */
  constructor(bankRepo, sandboxBank, aadhaarRepo) {
    this.repo = bankRepo;
    this.provider = sandboxBank || null;
    this.aadhaarRepo = aadhaarRepo || null;
  }

  _log(level, code, description, ref = {}) {
    logger.Log({
      level,
      component: "USECASE.EMPLOYEE_BANK",
      code: `USECASE.EMPLOYEE_BANK.${code}`,
      description,
      category: "",
      ref,
    });
  }

  /**
   * The keyed fingerprint of one account. Reuses the Aadhaar fingerprint key
   * rather than adding a third secret to manage: it is used the same way, to
   * make a value comparable without being readable, and one fewer key is one
   * fewer key to lose. Domain-separated by a prefix so a bank fingerprint can
   * never collide with an Aadhaar one.
   */
  static fingerprint(accountNumber, ifsc) {
    if (!aadhaarConfig.enabled) {
      throw new ValidationError(
        "Bank verification is not configured on this server (AADHAAR_FINGERPRINT_KEY)",
        503
      );
    }
    return nodeCrypto
      .createHmac("sha256", aadhaarConfig.fingerprintSecret)
      .update(`bank:${String(ifsc).toUpperCase()}:${String(accountNumber)}`, "utf8")
      .digest("hex");
  }

  /**
   * The current status, recomputed against the details on file.
   *
   * This NEVER calls the provider. Displaying an employee, or polling this
   * endpoint, must not spend a verification; an external call happens only
   * when somebody explicitly asks for one.
   */
  async getStatus(employeeId) {
    const employee = await this.repo.getBankDetails(employeeId);
    if (!employee) throw new NotFoundError(`employee ${employeeId} does not exist`);

    const hasAccount = Boolean(
      employee.account_no && String(employee.account_no).trim() !== "" &&
      employee.ifsc && String(employee.ifsc).trim() !== ""
    );
    const stored = await this.repo.getVerification(employeeId);

    if (!hasAccount) {
      return {
        employee_id: employeeId,
        status: STATUS.NOT_PROVIDED,
        bank_payroll_ready: false,
        masked_account: null,
        ifsc: null,
        bank_name: employee.bank_name || null,
        verification: stored || null,
        stale: false,
      };
    }

    const currentFingerprint = EmployeeBankUsecase.fingerprint(
      String(employee.account_no).replace(/[\s-]/g, ""),
      String(employee.ifsc).replace(/\s/g, "").toUpperCase()
    );

    // The heart of invalidation: a stored verification that was run against a
    // different account is not this account's verification.
    const stale = Boolean(stored && stored.account_fingerprint !== undefined
      ? stored.account_fingerprint !== currentFingerprint
      : false);
    const storedFp = await this.repo.getStoredFingerprint(employeeId);
    const matchesCurrent = Boolean(storedFp && storedFp.account_fingerprint === currentFingerprint);

    const effectiveStatus = !stored || !matchesCurrent ? STATUS.PENDING : stored.status;

    return {
      employee_id: employeeId,
      status: effectiveStatus,
      bank_payroll_ready: effectiveStatus === STATUS.VERIFIED,
      masked_account: maskAccount(String(employee.account_no).replace(/[\s-]/g, "")),
      ifsc: String(employee.ifsc).replace(/\s/g, "").toUpperCase(),
      bank_name: employee.bank_name || null,
      // The stored detail is returned as-is when it still applies, and marked
      // superseded when it does not, so a screen can explain WHY it is
      // pending again rather than just showing a bare status.
      verification: stored && matchesCurrent ? stored : null,
      superseded_verification: stored && !matchesCurrent ? { ...stored, applies_to_current_account: false } : null,
      stale: Boolean(stored) && !matchesCurrent,
    };
  }

  /**
   * Runs a Penny-Less check. The only method here that calls the provider,
   * and it is only ever reached from an explicit request.
   */
  async verify(employeeId, { actorEmployeeId = null } = {}) {
    if (!this.provider || !this.provider.isEnabled()) {
      throw new SandboxError(
        FAILURE.NOT_CONFIGURED,
        "Bank verification is not available: the Sandbox provider is not configured on this server",
        503
      );
    }

    const employee = await this.repo.getBankDetails(employeeId);
    if (!employee) throw new NotFoundError(`employee ${employeeId} does not exist`);
    if (!employee.account_no || String(employee.account_no).trim() === "") {
      throw new ValidationError(
        `employee ${employeeId} has no bank account on file; add the account number and IFSC first`
      );
    }
    if (!employee.ifsc || String(employee.ifsc).trim() === "") {
      throw new ValidationError(`employee ${employeeId} has no IFSC on file; add it before verifying`);
    }

    // Locally checkable problems are caught before a paid call is spent, and
    // the error names the field, never the account.
    const clean = this.provider.constructor.normalise({
      account_number: employee.account_no,
      ifsc: employee.ifsc,
    });
    const fingerprint = EmployeeBankUsecase.fingerprint(clean.account_number, clean.ifsc);
    const accountLast4 = last4(clean.account_number);

    const base = {
      employee_id: employeeId,
      account_fingerprint: fingerprint,
      account_last4: accountLast4,
      ifsc: clean.ifsc,
      provider: "sandbox",
      last_attempted_at: new Date(),
    };

    let result;
    try {
      result = await this.provider.pennyLessVerify(clean);
    } catch (err) {
      const category = err instanceof SandboxError ? err.category : "provider_error";
      // A provider failure NEVER marks an account verified, and never leaves
      // a previous VERIFIED standing for an account it did not describe.
      await this.repo.upsertVerification({
        ...base,
        status: STATUS.FAILED,
        account_exists: null,
        name_at_bank: null,
        name_match_verdict: null,
        name_match_reason: null,
        name_match_score: null,
        provider_transaction_id: null,
        provider_status: null,
        failure_category: category,
        verified_at: null,
        confirmed_by_employee_id: null,
        confirmed_at: null,
        confirmation_note: null,
      });
      await this.repo.recordAttempt({
        employee_id: employeeId,
        account_fingerprint: fingerprint,
        account_last4: accountLast4,
        ifsc: clean.ifsc,
        outcome: STATUS.FAILED,
        failure_category: category,
        provider: "sandbox",
        requested_by_employee_id: actorEmployeeId,
      });
      this._log(logger.LEVEL.ERROR, "VERIFY-FAILED", `employee ${employeeId}: ${category}`, {
        employeeId,
        category,
        actorEmployeeId,
      });
      throw err;
    }

    // The bank answering "no such account" is a RESULT, not a fault.
    if (!result.account_exists) {
      const row = {
        ...base,
        status: STATUS.FAILED,
        account_exists: 0,
        name_at_bank: null,
        name_match_verdict: null,
        name_match_reason: null,
        name_match_score: null,
        provider_transaction_id: result.transaction_id || null,
        provider_status: result.provider_status || null,
        failure_category: "account_not_found",
        verified_at: null,
        confirmed_by_employee_id: null,
        confirmed_at: null,
        confirmation_note: null,
      };
      await this.repo.upsertVerification(row);
      await this.repo.recordAttempt({
        employee_id: employeeId,
        account_fingerprint: fingerprint,
        account_last4: accountLast4,
        ifsc: clean.ifsc,
        outcome: STATUS.FAILED,
        account_exists: 0,
        failure_category: "account_not_found",
        provider: "sandbox",
        provider_transaction_id: result.transaction_id || null,
        requested_by_employee_id: actorEmployeeId,
      });
      return this._present(employeeId, STATUS.FAILED, {
        account_last4: accountLast4,
        ifsc: clean.ifsc,
        account_exists: false,
        failure_category: "account_not_found",
        message: "The bank reports no such account. Check the account number and IFSC.",
      });
    }

    // The account exists. Now: is it the right person's?
    const aadhaarName = await this._verifiedAadhaarName(employeeId);
    const comparison = compareNameAtBank(result.name_at_bank, {
      employeeName: employee.employee_name,
      aadhaarName,
    });

    const status = comparison.verdict === "MATCH" ? STATUS.VERIFIED : STATUS.NAME_MISMATCH;

    await this.repo.upsertVerification({
      ...base,
      status,
      account_exists: 1,
      name_at_bank: result.name_at_bank,
      name_match_verdict: comparison.verdict,
      name_match_reason: comparison.reason,
      name_match_score: Number(comparison.score.toFixed(3)),
      provider_transaction_id: result.transaction_id || null,
      provider_status: result.provider_status || null,
      failure_category: null,
      verified_at: status === STATUS.VERIFIED ? new Date() : null,
      // A fresh check clears any previous confirmation: a name accepted for
      // the old result has not been accepted for this one.
      confirmed_by_employee_id: null,
      confirmed_at: null,
      confirmation_note: null,
    });
    await this.repo.recordAttempt({
      employee_id: employeeId,
      account_fingerprint: fingerprint,
      account_last4: accountLast4,
      ifsc: clean.ifsc,
      outcome: status,
      account_exists: 1,
      name_at_bank: result.name_at_bank,
      name_match_verdict: comparison.verdict,
      provider: "sandbox",
      provider_transaction_id: result.transaction_id || null,
      requested_by_employee_id: actorEmployeeId,
    });

    this._log(logger.LEVEL.INFO, "VERIFIED", `employee ${employeeId}: ${status} (${comparison.verdict})`, {
      employeeId,
      status,
      verdict: comparison.verdict,
      account_last4: accountLast4,
      actorEmployeeId,
    });

    return this._present(employeeId, status, {
      account_last4: accountLast4,
      ifsc: clean.ifsc,
      account_exists: true,
      name_at_bank: result.name_at_bank,
      name_match: comparison,
      message:
        status === STATUS.VERIFIED
          ? "The account exists and the name matches."
          : comparison.verdict === "MISMATCH"
          ? "The account exists, but the name at the bank does not match this employee. Check the account belongs to them."
          : "The account exists and the name is close but not identical. An authorised user must confirm it.",
    });
  }

  /**
   * Accepts a REVIEW verdict. Only REVIEW - a MISMATCH is not confirmable,
   * because if the bank says the account belongs to somebody else entirely,
   * confirming it would be recording a fact nobody checked.
   */
  async confirmNameMismatch(employeeId, { actorEmployeeId = null, note = null } = {}) {
    const current = await this.getStatus(employeeId);
    if (current.status !== STATUS.NAME_MISMATCH) {
      throw new ConflictError(
        `employee ${employeeId}'s bank verification is ${current.status}, not NAME_MISMATCH; there is nothing to confirm`
      );
    }
    const stored = current.verification;
    if (stored && stored.name_match_verdict === "MISMATCH") {
      throw new ValidationError(
        "the name at the bank does not match this employee at all; it cannot be confirmed. " +
          "Correct the account details, or verify that the account really belongs to them."
      );
    }

    const employee = await this.repo.getBankDetails(employeeId);
    const fingerprint = EmployeeBankUsecase.fingerprint(
      String(employee.account_no).replace(/[\s-]/g, ""),
      String(employee.ifsc).replace(/\s/g, "").toUpperCase()
    );
    const affected = await this.repo.confirmNameMismatch(employeeId, fingerprint, { actorEmployeeId, note });
    if (affected === 0) {
      throw new ConflictError("the bank details or the verification changed; re-run the verification");
    }

    this._log(logger.LEVEL.INFO, "NAME-CONFIRMED", `employee ${employeeId}: name mismatch confirmed`, {
      employeeId,
      actorEmployeeId,
    });
    return this.getStatus(employeeId);
  }

  async listAttempts(employeeId, limit) {
    return this.repo.listAttempts(employeeId, limit);
  }

  /**
   * Payroll readiness. Deliberately a thin helper and not a payroll rule: it
   * answers "may this employee be paid by bank transfer", and says nothing
   * about whether they should be paid some other way.
   */
  async isBankPayrollReady(employeeId) {
    const status = await this.getStatus(employeeId);
    return {
      employee_id: employeeId,
      bank_payroll_ready: status.status === STATUS.VERIFIED,
      status: status.status,
      reason:
        status.status === STATUS.VERIFIED
          ? null
          : status.status === STATUS.NOT_PROVIDED
          ? "no bank account on file"
          : status.status === STATUS.PENDING
          ? "the bank account has not been verified since it was last changed"
          : status.status === STATUS.NAME_MISMATCH
          ? "the name at the bank needs confirmation"
          : "the last verification failed",
    };
  }

  /** The verified Aadhaar name, when there is one. Never the number. */
  async _verifiedAadhaarName(employeeId) {
    if (!this.aadhaarRepo || !this.aadhaarRepo.getIdentity) return null;
    try {
      const identity = await this.aadhaarRepo.getIdentity(employeeId);
      if (!identity || !identity.verification_id) return null;
      const verification = await this.aadhaarRepo.getVerification(identity.verification_id);
      if (!verification) return null;
      let demographics = verification.demographics_json;
      if (typeof demographics === "string") {
        try {
          demographics = JSON.parse(demographics);
        } catch (err) {
          return null;
        }
      }
      return demographics && demographics.name ? String(demographics.name) : null;
    } catch (err) {
      // A missing Aadhaar must never block a bank verification.
      return null;
    }
  }

  _present(employeeId, status, extra) {
    return {
      code: 200,
      employee_id: employeeId,
      status,
      bank_payroll_ready: status === STATUS.VERIFIED,
      ...extra,
    };
  }
}

module.exports = (bankRepo, sandboxBank, aadhaarRepo) =>
  new EmployeeBankUsecase(bankRepo, sandboxBank, aadhaarRepo);
module.exports.EmployeeBankUsecase = EmployeeBankUsecase;
module.exports.STATUS = STATUS;
module.exports.maskAccount = maskAccount;
module.exports.ValidationError = ValidationError;
module.exports.NotFoundError = NotFoundError;
module.exports.ConflictError = ConflictError;
