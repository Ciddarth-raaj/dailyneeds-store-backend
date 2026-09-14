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
 * QUERY COUNT IS BOUNDED at six, whatever the headcount:
 *
 *   1  the resigned-name exclusion list  } inside employeeUsecase.get()
 *   2  the employees themselves          }
 *   3  which of them have an Aadhaar identity
 *   4  their bank details
 *   5  their stored bank verifications
 *   6  whether the statutory decision has been recorded - see the
 *      HR-onboarding note below
 *   7  the active-duplicate lookup - only when at least one employee is
 *      actually sitting on DUPLICATE_ACCOUNT, so usually not run at all
 *
 * WHAT IT RETURNS is four scalars per employee, plus the two HR-onboarding
 * keys below, and nothing else. No Aadhaar number or last four digits, no
 * account number or last four, no IFSC, no fingerprint, no ciphertext, no
 * verification or session id, no provider payload, no override reason. A list
 * needs a badge.
 *
 * HR ONBOARDING PENDING - a DERIVED state, not a new one. A store manager
 * creates the employee record and their responsibility ends there; the
 * statutory and bank sections are HR's, and are completed afterwards on the
 * employee profile. "Still waiting on HR" is therefore not a status somebody
 * sets - it is the absence of those two sections, which this endpoint can
 * already see:
 *
 *   statutory   the PF and ESI applicability flags, which exist precisely to
 *               distinguish "decided" from "nobody has been asked yet"
 *   bank        NOT_PROVIDED, by the same rule as the bank badge beside it
 *
 * So no column, no enum value and no migration is added for it, nothing has
 * to be backfilled for the 630 employees already on file, and the flag cannot
 * drift out of step with the sections it describes. Aadhaar is deliberately
 * NOT part of it: Aadhaar Pending is a first-class outcome that holds up
 * nothing, and it has its own badge already.
 *
 * The two keys carry no value of any sensitive field - only whether a section
 * is outstanding, which is the same kind of fact `bank_status:
 * "NOT_PROVIDED"` has always carried on this endpoint, under the same
 * `view_employees` permission. They are omitted entirely, rather than guessed
 * at, on a server where the employee-master repository is not wired.
 *
 * PF AND ESI, SEPARATELY - for the Onboarding / Pending HR queue.
 *
 * `hr_onboarding_pending` answers "is anything outstanding", which is the
 * right question for a badge on a list and the wrong one for a work queue:
 * somebody chasing PF has no use for a flag that also goes up for a missing
 * bank account. So the same statutory read now also reports each scheme on
 * its own, as `pf_status` / `esi_status`, in three values:
 *
 *   COMPLETE        the decision has been recorded and the employee is in the
 *                   scheme
 *   PENDING         nobody has been asked yet (the flag is NULL)
 *   NOT_APPLICABLE  asked, and the employee is not in the scheme
 *
 * THE RULE IS THE EXISTING ONE, NOT A NEW DEFINITION OF COMPLIANCE. It is the
 * very `pf_applicable IS NOT NULL` test `hr_onboarding_pending` is already
 * built on, split per scheme; the UAN / PF number / ESI number are still NOT
 * part of it, exactly as the repository comment explains. So a queue built on
 * these can never disagree with the badge beside it, and `NOT_APPLICABLE` is
 * simply the "decided" half named.
 *
 * NOT_APPLICABLE IS ONLY TOLD TO A CALLER WHO MAY SEE THE COLUMN. Naming it
 * discloses WHICH answer was recorded, and `pf_applicable` / `esi_applicable`
 * are sensitive under B3. So it is sent only with `view_employee_sensitive`;
 * without that key the caller sees COMPLETE for any recorded decision - the
 * same "outstanding or not" they have always been told, and enough to run the
 * queue. `filterResponse` is not being routed around: these keys carry no
 * sensitive column name and no sensitive value, and the one inference that
 * would be sensitive is withheld here rather than stripped there.
 */

class EmployeeStatusSummaryUsecase {
  /**
   * `employeeMasterRepo` is optional and read-only here: it answers whether
   * the statutory decision has been recorded, never what it was.
   */
  constructor(employeeUsecase, aadhaarRepo, bankRepo, employeeMasterRepo) {
    this.employees = employeeUsecase;
    this.aadhaarRepo = aadhaarRepo || null;
    this.bankRepo = bankRepo || null;
    this.masterRepo = employeeMasterRepo || null;
  }

  /**
   * Which HR-owned sections are still outstanding for one employee.
   *
   * `statutory` is `{ pfDecided, esiDecided }`, or null when this server
   * cannot tell - in which case the caller omits the keys rather than
   * reporting a completeness it did not establish.
   */
  static hrOnboardingState({ statutory, bankStatus }) {
    if (!statutory) return null;
    const missing = [];
    if (!statutory.pfDecided || !statutory.esiDecided) missing.push("statutory");
    // The same rule the bank badge uses: an account nobody has entered is
    // HR's to chase. An account that IS on file and has not passed its check
    // is a different job, already shown by the bank badge, and is not counted
    // here twice.
    if (!bankStatus || bankStatus === "NOT_PROVIDED") missing.push("bank");
    return { pending: missing.length > 0, missing };
  }

  /**
   * One scheme's status, from the SAME decision the flag above is built on.
   *
   * `decided` false is PENDING - nobody has been asked. `decided` true is
   * COMPLETE, or NOT_APPLICABLE where the recorded answer was "no" AND the
   * caller may be told which answer it was. Collapsing NOT_APPLICABLE into
   * COMPLETE for everyone else is not a lie about completeness: both mean
   * "there is nothing outstanding here", which is the whole question the
   * queue asks.
   */
  static schemeStatus(decided, notApplicable, { disclose = false } = {}) {
    if (!decided) return "PENDING";
    if (disclose && notApplicable) return "NOT_APPLICABLE";
    return "COMPLETE";
  }

  /**
   * @param filters the same `{ store_ids, designation_ids }` the employee
   *   list accepts, passed through unchanged.
   * @param options `{ disclosePfEsiApplicability }` - true only for a caller
   *   holding `view_employee_sensitive`; see the NOT_APPLICABLE note above.
   */
  async list(filters, { disclosePfEsiApplicability = false } = {}) {
    const employees = await this.employees.get(filters || {});

    const ids = [];
    for (const e of employees || []) {
      const id = Number(e.employee_id);
      if (Number.isInteger(id) && id > 0) ids.push(id);
    }
    if (ids.length === 0) return [];

    const [aadhaarIds, bank, statutory] = await Promise.all([
      this._aadhaarIds(ids),
      this._bankStatuses(ids),
      this._statutoryDecisions(ids),
    ]);

    return ids.map((employee_id) => {
      const b = bank.get(employee_id) || { status: "NOT_PROVIDED", bank_payroll_ready: false };
      const decisions = statutory
        ? statutory.get(employee_id) || { pfDecided: false, esiDecided: false }
        : null;
      const onboarding = EmployeeStatusSummaryUsecase.hrOnboardingState({
        statutory: decisions,
        bankStatus: b.status,
      });
      const scheme = (decided, notApplicable) =>
        EmployeeStatusSummaryUsecase.schemeStatus(decided, notApplicable, {
          disclose: disclosePfEsiApplicability,
        });
      return {
        employee_id,
        aadhaar_status: aadhaarIds.has(employee_id) ? "VERIFIED" : "PENDING",
        bank_status: b.status,
        bank_payroll_ready: b.bank_payroll_ready,
        ...(onboarding
          ? {
              hr_onboarding_pending: onboarding.pending,
              hr_onboarding_missing: onboarding.missing,
            }
          : {}),
        // Omitted, never guessed, where the statutory read is not wired - the
        // same rule the two keys above follow.
        ...(decisions
          ? {
              pf_status: scheme(decisions.pfDecided, decisions.pfNotApplicable),
              esi_status: scheme(decisions.esiDecided, decisions.esiNotApplicable),
            }
          : {}),
      };
    });
  }

  /**
   * Whether the statutory decision has been recorded, per employee. One bulk
   * read, and null - not an empty map - where this server cannot answer, so
   * "not wired" never reads as "nothing is outstanding".
   */
  async _statutoryDecisions(ids) {
    if (!this.masterRepo || typeof this.masterRepo.getStatutoryDecisionsMany !== "function") return null;
    const rows = await this.masterRepo.getStatutoryDecisionsMany(ids);
    const out = new Map();
    for (const row of rows || []) {
      out.set(Number(row.employee_id), {
        pfDecided: Boolean(Number(row.pf_decided)),
        esiDecided: Boolean(Number(row.esi_decided)),
        pfNotApplicable: Boolean(Number(row.pf_not_applicable)),
        esiNotApplicable: Boolean(Number(row.esi_not_applicable)),
      });
    }
    return out;
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

module.exports = (employeeUsecase, aadhaarRepo, bankRepo, employeeMasterRepo) =>
  new EmployeeStatusSummaryUsecase(employeeUsecase, aadhaarRepo, bankRepo, employeeMasterRepo);
module.exports.EmployeeStatusSummaryUsecase = EmployeeStatusSummaryUsecase;
