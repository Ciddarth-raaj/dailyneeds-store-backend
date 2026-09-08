const logger = require("../utils/logger");
const { EmployeeBankUsecase } = require("./employee_bank");

/**
 * Stage 0C / C3 — the bulk Aadhaar and bank status summary.
 *
 * WHY THIS EXISTS. The HR employee list shows ~630 people. Asking
 * `/hr/employee/:id/aadhaar` and `/hr/employee/:id/bank` for each of them is
 * 1,260 requests to draw one screen, so the list simply had no status
 * columns. This endpoint answers for the whole list at once.
 *
 * WHAT IT IS NOT. It is not a second opinion about anybody's status. Both
 * answers are produced by the same rules as the single-employee endpoints:
 *
 *   Aadhaar   an attached identity row means VERIFIED, its absence means
 *             PENDING - the same derivation `getAadhaarStatus` uses, which
 *             is why the 630 employees who predate C2 need no migration and
 *             no placeholder row.
 *
 *   bank      `EmployeeBankUsecase.resolveEffectiveStatus`, the very
 *             function `getStatus` calls. That matters most for
 *             DUPLICATE_ACCOUNT, which C2 resolves on READ: when the
 *             employee a duplicate clashed with has since left, the clash is
 *             over and the status is VERIFIED again. A summary that read the
 *             stored status instead would show a duplicate that no longer
 *             exists, and would need re-verifying - a paid call - to clear.
 *
 * THE VISIBILITY IS NOT REINTERPRETED EITHER. The employee population comes
 * from `employeeUsecase.get()`, the exact call behind `GET
 * /employee/employees`, so this endpoint can never show a status for
 * somebody the existing list would not show. It is a status column on an
 * existing list, not a new way to enumerate employees.
 *
 * QUERY COUNT IS BOUNDED at five, whatever the headcount:
 *
 *   1  the resigned-name exclusion list  } inside employeeUsecase.get()
 *   2  the employees themselves          }
 *   3  which of them have an Aadhaar identity
 *   4  their bank details
 *   5  their stored bank verifications
 *   6  the active-duplicate lookup - only when at least one employee is
 *      actually sitting on DUPLICATE_ACCOUNT, so usually not run at all
 *
 * WHAT IT RETURNS is four scalars per employee and nothing else. No Aadhaar
 * number or last four digits, no account number or last four, no IFSC, no
 * fingerprint, no ciphertext, no verification or session id, no provider
 * payload, no override reason. A list needs a badge.
 */
class EmployeeStatusSummaryUsecase {
  constructor(employeeUsecase, aadhaarRepo, bankRepo) {
    this.employees = employeeUsecase;
    this.aadhaarRepo = aadhaarRepo || null;
    this.bankRepo = bankRepo || null;
  }

  /**
   * @param filters the same `{ store_ids, designation_ids }` the employee
   *   list accepts, passed through unchanged.
   */
  async list(filters) {
    const employees = await this.employees.get(filters || {});

    const ids = [];
    for (const e of employees || []) {
      const id = Number(e.employee_id);
      if (Number.isInteger(id) && id > 0) ids.push(id);
    }
    if (ids.length === 0) return [];

    const [aadhaarIds, bank] = await Promise.all([
      this._aadhaarIds(ids),
      this._bankStatuses(ids),
    ]);

    return ids.map((employee_id) => {
      const b = bank.get(employee_id) || { status: "NOT_PROVIDED", bank_payroll_ready: false };
      return {
        employee_id,
        aadhaar_status: aadhaarIds.has(employee_id) ? "VERIFIED" : "PENDING",
        bank_status: b.status,
        bank_payroll_ready: b.bank_payroll_ready,
      };
    });
  }

  /**
   * An identity row means a verified Aadhaar is attached; nothing else does.
   * If the Aadhaar module is not wired, everybody is PENDING - which is what
   * `getAadhaarStatus` answers in that case too.
   */
  async _aadhaarIds(ids) {
    if (!this.aadhaarRepo) return new Set();
    const rows = await this.aadhaarRepo.findEmployeeIdsWithIdentity(ids);
    return new Set(rows.map((id) => Number(id)));
  }

  /**
   * The bank status for every employee in `ids`, by the shared C2 rule.
   *
   * Three bulk reads and one merge in memory. The fingerprints are computed
   * here rather than read, exactly as the single-employee path computes them,
   * so an account edited on `new_employee` invalidates its stored
   * verification here as well - the invalidation is detected, never
   * remembered.
   */
  async _bankStatuses(ids) {
    const out = new Map();
    if (!this.bankRepo) return out;

    const [details, verifications] = await Promise.all([
      this.bankRepo.getBankDetailsMany(ids),
      this.bankRepo.getVerificationsMany(ids),
    ]);

    const storedByEmployee = new Map();
    for (const v of verifications) storedByEmployee.set(Number(v.employee_id), v);

    // Pass one: fingerprint each account, and note who is sitting on a stored
    // duplicate. Their clash has to be re-checked against who is still
    // employed TODAY before any of them can be answered.
    const fingerprintOf = new Map();
    const duplicateCandidates = [];
    for (const row of details) {
      const employeeId = Number(row.employee_id);
      if (!EmployeeBankUsecase.hasBankAccount(row)) continue;
      let fingerprint;
      try {
        fingerprint = EmployeeBankUsecase.currentFingerprintOf(row);
      } catch (err) {
        // Bank verification is not configured on this server. That is the
        // same 503 the single-employee endpoint raises, and it is a server
        // condition, not this employee's - so it propagates rather than
        // being flattened into a wrong status for 630 people.
        this._log("FINGERPRINT", err);
        throw err;
      }
      fingerprintOf.set(employeeId, fingerprint);

      const stored = storedByEmployee.get(employeeId);
      if (stored && stored.account_fingerprint === fingerprint && stored.status === "DUPLICATE_ACCOUNT") {
        duplicateCandidates.push(fingerprint);
      }
    }

    // Pass two: one query for every clashing fingerprint at once, and only
    // when there is at least one.
    const activeVerifiedByFingerprint = new Map();
    if (duplicateCandidates.length) {
      const rows = await this.bankRepo.findActiveVerifiedByFingerprints([...new Set(duplicateCandidates)]);
      for (const r of rows) {
        if (!activeVerifiedByFingerprint.has(r.account_fingerprint)) {
          activeVerifiedByFingerprint.set(r.account_fingerprint, []);
        }
        activeVerifiedByFingerprint.get(r.account_fingerprint).push(Number(r.employee_id));
      }
    }

    // Pass three: the shared decision, per employee.
    for (const row of details) {
      const employeeId = Number(row.employee_id);
      const fingerprint = fingerprintOf.get(employeeId);
      const stored = storedByEmployee.get(employeeId) || null;
      const fingerprintMatches = Boolean(
        fingerprint && stored && stored.account_fingerprint === fingerprint
      );

      // The single-employee query excludes the employee being judged in SQL;
      // this excludes them here, on the same set of rows.
      const others = (activeVerifiedByFingerprint.get(fingerprint) || []).filter(
        (id) => id !== employeeId
      );

      out.set(
        employeeId,
        EmployeeBankUsecase.resolveEffectiveStatus({
          hasAccount: Boolean(fingerprint),
          stored,
          fingerprintMatches,
          activeDuplicateCount: others.length,
        })
      );
    }
    return out;
  }

  _log(code, err) {
    logger.Log({
      level: logger.LEVEL.ERROR,
      component: "USECASE.EMPLOYEE_STATUS_SUMMARY",
      code: `USECASE.EMPLOYEE_STATUS_SUMMARY.${code}`,
      description: err.toString(),
      category: "",
      ref: {},
    });
  }
}

module.exports = (employeeUsecase, aadhaarRepo, bankRepo) =>
  new EmployeeStatusSummaryUsecase(employeeUsecase, aadhaarRepo, bankRepo);
module.exports.EmployeeStatusSummaryUsecase = EmployeeStatusSummaryUsecase;
