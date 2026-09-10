const nodeCrypto = require("crypto");
const logger = require("../utils/logger");
const bankConfig = require("../config/bank");
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
 *   REJECTED       a human looked at that mismatch and turned the account
 *                  down, with a stated reason
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
  DUPLICATE_ACCOUNT: "DUPLICATE_ACCOUNT",
  // A reviewer looked at a name mismatch and turned the account down. Not
  // FAILED - the check completed and the bank answered; what was rejected is
  // the account, by a named human, with a stated reason.
  REJECTED: "REJECTED",
  FAILED: "FAILED",
};

/**
 * Every human decision recorded against a verification, as a block of nulls.
 *
 * A fresh provider check clears ALL of them, and they are listed in one place
 * so that adding a decision - as the name-mismatch review did - cannot leave
 * one of them standing against a result nobody has looked at yet. A name
 * accepted for last month's answer has not been accepted for this one, an
 * administrator who allowed a shared account has not allowed whatever this
 * check just found, and a reviewer who rejected the old account has not
 * rejected the new one.
 */
const CLEARED_DECISIONS = {
  confirmed_by_employee_id: null,
  confirmed_at: null,
  confirmation_note: null,
  override_by_employee_id: null,
  override_at: null,
  override_reason: null,
  override_kind: null,
  rejected_by_employee_id: null,
  rejected_at: null,
  rejection_reason: null,
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

/**
 * What may be said about the OTHER employee on a shared account: who they are,
 * so HR can resolve it, and nothing about the account beyond its last four -
 * which the caller already sees for their own employee anyway. No fingerprint,
 * no account number.
 */
const presentDuplicate = (row) => ({
  employee_id: row.employee_id,
  employee_name: row.employee_name,
  bank_verification_status: row.status,
  verified_on: row.verified_on || null,
});

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
   * The keyed fingerprint of one account.
   *
   * Keyed on `BANK_FINGERPRINT_KEY` and NOTHING ELSE: bank verification does
   * not depend on Aadhaar being configured, enabled, or present. A deployment
   * that never touches Aadhaar can still run Penny-Less.
   *
   * The `bank:` prefix keeps the input domain-separated, so this can never
   * collide with a fingerprint computed for anything else even if a key were
   * ever shared by accident.
   */
  static fingerprint(accountNumber, ifsc) {
    if (!bankConfig.enabled) {
      throw new ValidationError(
        "Bank verification is not configured on this server: BANK_FINGERPRINT_KEY is missing or " +
          `shorter than ${bankConfig.MIN_KEY_LENGTH} characters`,
        503
      );
    }
    return nodeCrypto
      .createHmac("sha256", bankConfig.fingerprintSecret)
      .update(`bank:${String(ifsc).toUpperCase()}:${String(accountNumber)}`, "utf8")
      .digest("hex");
  }

  /**
   * THE STATUS DECISION, as a pure function of what was read.
   *
   * Extracted so that `getStatus` below and the bulk status summary used by
   * the HR employee list cannot drift apart. Every rule C2 established lives
   * here and nowhere else:
   *
   *   no account on file                        NOT_PROVIDED
   *   no verification, or one run against a
   *     different account                       PENDING
   *   otherwise                                 whatever the bank said
   *   DUPLICATE_ACCOUNT whose clash has since
   *     gone (the other employee left)          VERIFIED, or NAME_MISMATCH
   *                                             if the name never matched
   *
   * The duplicate is resolved on READ rather than frozen at verification
   * time, because it is a fact about other employees and they change without
   * this row being touched. A bulk caller must therefore pass the CURRENT
   * count of active duplicates, not a stored one.
   *
   * `bank_payroll_ready` is deliberately not a separate rule: it is
   * VERIFIED and nothing else, so it can never disagree with the status
   * beside it.
   */
  static resolveEffectiveStatus({ hasAccount, stored, fingerprintMatches, activeDuplicateCount = 0 }) {
    if (!hasAccount) return { status: STATUS.NOT_PROVIDED, bank_payroll_ready: false };
    if (!stored || !fingerprintMatches) return { status: STATUS.PENDING, bank_payroll_ready: false };

    let status = stored.status;
    if (status === STATUS.DUPLICATE_ACCOUNT && activeDuplicateCount === 0) {
      status = stored.name_match_verdict === "MISMATCH" ? STATUS.NAME_MISMATCH : STATUS.VERIFIED;
    }
    return { status, bank_payroll_ready: status === STATUS.VERIFIED };
  }

  /** Whether an employee row carries a usable account at all. */
  static hasBankAccount(employee) {
    return Boolean(
      employee &&
        employee.account_no && String(employee.account_no).trim() !== "" &&
        employee.ifsc && String(employee.ifsc).trim() !== ""
    );
  }

  /** The fingerprint of the account currently on the employee row. */
  static currentFingerprintOf(employee) {
    return EmployeeBankUsecase.fingerprint(
      String(employee.account_no).replace(/[\s-]/g, ""),
      String(employee.ifsc).replace(/\s/g, "").toUpperCase()
    );
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

    const hasAccount = EmployeeBankUsecase.hasBankAccount(employee);
    const stored = await this.repo.getVerification(employeeId);

    if (!hasAccount) {
      return {
        employee_id: employeeId,
        ...EmployeeBankUsecase.resolveEffectiveStatus({ hasAccount: false }),
        masked_account: null,
        ifsc: null,
        bank_name: employee.bank_name || null,
        verification: stored || null,
        stale: false,
      };
    }

    const currentFingerprint = EmployeeBankUsecase.currentFingerprintOf(employee);

    // The heart of invalidation: a stored verification that was run against a
    // different account is not this account's verification.
    const stale = Boolean(stored && stored.account_fingerprint !== undefined
      ? stored.account_fingerprint !== currentFingerprint
      : false);
    const storedFp = await this.repo.getStoredFingerprint(employeeId);
    const matchesCurrent = Boolean(storedFp && storedFp.account_fingerprint === currentFingerprint);

    // A duplicate is a fact about OTHER employees, and other employees change
    // without this row being touched. So it is resolved on read, not frozen at
    // verification time: when the employee it clashed with has since left, the
    // clash is over and the provider's own result stands. Otherwise a
    // colleague's resignation would leave this employee permanently blocked
    // until somebody spent another paid call on an account nothing changed
    // about.
    let duplicateOf = null;
    if (matchesCurrent && stored && stored.status === STATUS.DUPLICATE_ACCOUNT) {
      duplicateOf = await this.repo.findActiveDuplicates(currentFingerprint, employeeId);
    }

    // The decision itself is the shared rule, so this and the bulk summary
    // cannot answer differently about the same employee.
    const { status: effectiveStatus, bank_payroll_ready } = EmployeeBankUsecase.resolveEffectiveStatus({
      hasAccount: true,
      stored,
      fingerprintMatches: matchesCurrent,
      activeDuplicateCount: duplicateOf ? duplicateOf.length : 0,
    });

    return {
      employee_id: employeeId,
      status: effectiveStatus,
      bank_payroll_ready,
      masked_account: maskAccount(String(employee.account_no).replace(/[\s-]/g, "")),
      ifsc: String(employee.ifsc).replace(/\s/g, "").toUpperCase(),
      bank_name: employee.bank_name || null,
      // The stored detail is returned as-is when it still applies, and marked
      // superseded when it does not, so a screen can explain WHY it is
      // pending again rather than just showing a bare status.
      verification: stored && matchesCurrent ? stored : null,
      superseded_verification: stored && !matchesCurrent ? { ...stored, applies_to_current_account: false } : null,
      stale: Boolean(stored) && !matchesCurrent,
      duplicate_of: duplicateOf && duplicateOf.length ? duplicateOf.map(presentDuplicate) : null,
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
        duplicate_of_employee_id: null,
        ...CLEARED_DECISIONS,
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
        duplicate_of_employee_id: null,
        ...CLEARED_DECISIONS,
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

    let status = comparison.verdict === "MATCH" ? STATUS.VERIFIED : STATUS.NAME_MISMATCH;

    // AND IS IT ALREADY SOMEBODY ELSE'S? A name matching is not sufficient to
    // be payroll-ready: two active employees on one account is either a
    // data-entry error or one person drawing two salaries, and paying both is
    // not recoverable by an apology. The clash does not overwrite either
    // employee's details and does not touch the other row at all - it only
    // stops THIS one short of VERIFIED until a human decides.
    const duplicates = status === STATUS.VERIFIED
      ? await this.repo.findActiveDuplicates(fingerprint, employeeId)
      : [];
    if (duplicates.length) status = STATUS.DUPLICATE_ACCOUNT;

    await this.repo.upsertVerification({
      ...base,
      duplicate_of_employee_id: duplicates.length ? duplicates[0].employee_id : null,
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
      // A fresh check clears every human decision recorded against the
      // previous one; see CLEARED_DECISIONS.
      ...CLEARED_DECISIONS,
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
      duplicate_of: duplicates.length ? duplicates.map(presentDuplicate) : null,
      requires_admin_override: status === STATUS.DUPLICATE_ACCOUNT,
      message:
        status === STATUS.DUPLICATE_ACCOUNT
          ? `The account exists and the name matches, but employee ${duplicates[0].employee_id} is currently ` +
            "employed and already verified against this same account. Check whether this is a data-entry " +
            "error before an administrator allows it."
          : status === STATUS.VERIFIED
          ? "The account exists and the name matches."
          : comparison.verdict === "MISMATCH"
          ? "The account exists, but the name at the bank does not match this employee. Check the account belongs to them."
          : "The account exists and the name is close but not identical. An authorised user must confirm it.",
    });
  }

  /**
   * An administrator allowing a genuinely shared account.
   *
   * Rare but real: a spouse's account, or a worker with no account of their
   * own. It is deliberately NOT available to HR, requires a stated reason,
   * and leaves both an updated row naming who allowed it and an append-only
   * attempt row. Neither employee's bank details are touched, and the other
   * employee's verification is not altered in any way.
   */
  async overrideDuplicate(employeeId, { actorEmployeeId = null, reason = null } = {}) {
    const stated = String(reason === null || reason === undefined ? "" : reason).trim();
    if (stated === "") {
      throw new ValidationError(
        "a reason is required to allow two active employees to share a bank account"
      );
    }

    const current = await this.getStatus(employeeId);
    if (current.status !== STATUS.DUPLICATE_ACCOUNT) {
      throw new ConflictError(
        `employee ${employeeId}'s bank verification is ${current.status}, not DUPLICATE_ACCOUNT; ` +
          "there is nothing to override"
      );
    }

    const employee = await this.repo.getBankDetails(employeeId);
    const fingerprint = EmployeeBankUsecase.fingerprint(
      String(employee.account_no).replace(/[\s-]/g, ""),
      String(employee.ifsc).replace(/\s/g, "").toUpperCase()
    );
    const affected = await this.repo.overrideDuplicate(employeeId, fingerprint, {
      actorEmployeeId,
      reason: stated,
    });
    if (affected === 0) {
      throw new ConflictError("the bank details or the verification changed; re-run the verification");
    }

    // The audit trail proper: append-only, and it survives a later
    // re-verification that clears the override columns on the current row.
    await this.repo.recordAttempt({
      employee_id: employeeId,
      account_fingerprint: fingerprint,
      account_last4: last4(String(employee.account_no).replace(/[\s-]/g, "")),
      ifsc: String(employee.ifsc).replace(/\s/g, "").toUpperCase(),
      outcome: "ADMIN_OVERRIDE",
      failure_category: null,
      provider: null,
      requested_by_employee_id: actorEmployeeId,
      override_reason: stated,
    });

    this._log(
      logger.LEVEL.INFO,
      "DUPLICATE-OVERRIDDEN",
      `employee ${employeeId}: shared bank account allowed by employee ${actorEmployeeId}`,
      { employeeId, actorEmployeeId, duplicate_of: (current.duplicate_of || []).map((d) => d.employee_id) }
    );

    return this.getStatus(employeeId);
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

  /**
   * THE NAME-MISMATCH REVIEW. One authorised human, looking at what the bank
   * actually returned, deciding what happens to this account.
   *
   * It exists because the previous behaviour was a dead end. A REVIEW verdict
   * could be confirmed; a MISMATCH verdict could not be confirmed by anybody,
   * and the screen said so - beside no action at all. That is a correct
   * statement of a rule and a useless thing to tell somebody whose employee
   * still cannot be paid. The bank returning a different spelling, a maiden
   * name, or a joint-account holder's name are all real and all end up as
   * MISMATCH, and a business has to be able to resolve them.
   *
   * So both verdicts are reviewable, and the review has the two outcomes the
   * old flow was missing a name for:
   *
   *   APPROVE_SAME_PERSON  the reviewer is satisfied the account is this
   *                        employee's. Recorded as a bank-name-mismatch
   *                        OVERRIDE - who, when, why - and not as a quiet
   *                        pass. It is a waived check, and it reads like one.
   *
   *   REJECT_ACCOUNT       the account is not usable. REJECTED, with the same
   *                        who/when/why, and still not payroll-ready - so a
   *                        bank transfer against it stays blocked rather than
   *                        being released.
   *
   * The third option HR has is not here because it already exists and is not
   * this decision: correcting the details re-fingerprints the account, which
   * drops it back to PENDING through `resolveEffectiveStatus` on its own.
   *
   * A REASON IS REQUIRED FOR BOTH, unlike the older confirmation's optional
   * note. This is the record payroll and an auditor read later, and "somebody
   * approved it" without a stated reason is not a record.
   *
   * NOTHING HERE DECIDES WHO MAY DO IT. The route holds the permission, as
   * everywhere else in this file.
   */
  async reviewNameMismatch(employeeId, { decision = null, reason = null, actorEmployeeId = null } = {}) {
    const choice = String(decision === null || decision === undefined ? "" : decision)
      .trim()
      .toUpperCase();
    if (choice !== "APPROVE_SAME_PERSON" && choice !== "REJECT_ACCOUNT") {
      throw new ValidationError(
        "a bank name review must be APPROVE_SAME_PERSON or REJECT_ACCOUNT"
      );
    }

    const stated = String(reason === null || reason === undefined ? "" : reason).trim();
    if (stated === "") {
      throw new ValidationError("a reason is required to review a bank name mismatch");
    }

    const current = await this.getStatus(employeeId);
    if (current.status !== STATUS.NAME_MISMATCH) {
      throw new ConflictError(
        `employee ${employeeId}'s bank verification is ${current.status}, not NAME_MISMATCH; ` +
          "there is nothing to review"
      );
    }

    const employee = await this.repo.getBankDetails(employeeId);
    const account = String(employee.account_no).replace(/[\s-]/g, "");
    const ifsc = String(employee.ifsc).replace(/\s/g, "").toUpperCase();
    const fingerprint = EmployeeBankUsecase.fingerprint(account, ifsc);
    const verdict = (current.verification && current.verification.name_match_verdict) || null;

    const approving = choice === "APPROVE_SAME_PERSON";
    const affected = approving
      ? await this.repo.approveNameMismatch(employeeId, fingerprint, {
          actorEmployeeId,
          reason: stated,
        })
      : await this.repo.rejectBankAccount(employeeId, fingerprint, {
          actorEmployeeId,
          reason: stated,
        });
    if (affected === 0) {
      throw new ConflictError("the bank details or the verification changed; re-run the verification");
    }

    // Append-only, and it outlives the row above: a later re-verification
    // clears the decision columns, and this is where the decision stays.
    await this.repo.recordAttempt({
      employee_id: employeeId,
      account_fingerprint: fingerprint,
      account_last4: last4(account),
      ifsc,
      outcome: approving ? "NAME_MISMATCH_OVERRIDE" : "BANK_ACCOUNT_REJECTED",
      name_at_bank: (current.verification && current.verification.name_at_bank) || null,
      name_match_verdict: verdict,
      failure_category: null,
      provider: null,
      requested_by_employee_id: actorEmployeeId,
      override_reason: stated,
    });

    this._log(
      logger.LEVEL.INFO,
      approving ? "NAME-MISMATCH-OVERRIDDEN" : "BANK-ACCOUNT-REJECTED",
      `employee ${employeeId}: name mismatch ${approving ? "approved" : "rejected"} by employee ${actorEmployeeId}`,
      { employeeId, actorEmployeeId, verdict }
    );

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
          ? "the name at the bank needs review"
          : status.status === STATUS.DUPLICATE_ACCOUNT
          ? "another active employee is already verified against this bank account"
          : status.status === STATUS.REJECTED
          ? "a reviewer rejected this bank account"
          : "the last verification failed",
      duplicate_of: status.duplicate_of || null,
    };
  }

  /** The verified Aadhaar name, when there is one. Never the number. */
  async _verifiedAadhaarName(employeeId) {
    if (!this.aadhaarRepo || !this.aadhaarRepo.getIdentity) return null;
    try {
      const identity = await this.aadhaarRepo.getIdentity(employeeId);
      if (!identity || !identity.verification_id) return null;
      // The demographics read, not the display read: `getVerification` is
      // deliberately narrow and does not select the payload, so asking it for
      // the name would silently always answer null.
      const verification = await this.aadhaarRepo.getVerificationDemographics(identity.verification_id);
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
