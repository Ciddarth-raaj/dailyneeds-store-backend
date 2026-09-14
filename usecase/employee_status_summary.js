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
 * HR ONBOARDING PENDING - a DERIVED state, not a new one. "Still waiting on
 * HR" is not a status somebody sets: it is the absence of the sections HR
 * follows up, which this endpoint can already see. It is true when ANY of
 * FOUR things is outstanding:
 *
 *   aadhaar     no verified Aadhaar identity is attached
 *   statutory   the PF and ESI applicability flags, which exist precisely to
 *               distinguish "decided" from "nobody has been asked yet"
 *   bank        not payroll ready - see below
 *   payroll     no live salary, an uncosted one, or no recorded way to pay
 *               them - see `payrollState`
 *
 * PAYROLL IS THE FOURTH ITEM, AND IT IS NOT THE BANK COLUMN AGAIN. The bank
 * column asks whether an account can receive a transfer; payroll asks whether
 * there is anything to transfer - an agreed, costed salary in effect today.
 * An employee can have a verified account and no salary, or a salary and no
 * account, and both are unfinished records. The rule is read from the payroll
 * module's own definitions (`repository/employee_salary.js#getCurrentSalary`
 * and `utils/salary_engine.js`) rather than restated here, so this endpoint
 * cannot drift from what payroll itself believes.
 *
 * So no column, no enum value and no migration is added for it, nothing has
 * to be backfilled for the 630 employees already on file, and the flag cannot
 * drift out of step with the sections it describes.
 *
 * AADHAAR IS PART OF IT, and this is the business rule rather than a
 * technical choice. THE STORE MANAGER OWNS THE FIRST ATTEMPT: stage 1 of the
 * Add Employee wizard is where an Aadhaar is verified, or explicitly skipped.
 * HR OWNS EVERY UNRESOLVED CASE AFTER THAT. It does not matter why it is
 * unresolved - a failed check, a mismatch, a technical problem, a manager who
 * skipped it or never finished it - once onboarding has moved on, getting the
 * Aadhaar verified is HR's follow-up like the other two. It used to be
 * excluded here on the grounds that Aadhaar Pending "holds up nothing", which
 * described the payroll consequence correctly and the OWNERSHIP wrongly: it
 * left the employee list showing HR Complete for a record with no verified
 * identity, and nobody chasing it.
 *
 * BANK MEANS PAYROLL READY, not merely entered. `bank_payroll_ready` is true
 * for VERIFIED and nothing else, so an account awaiting its check, or one
 * that came back NAME_MISMATCH, FAILED or DUPLICATE_ACCOUNT, is an employee
 * who cannot be paid - which is outstanding work, not a finished section.
 * This used to count only NOT_PROVIDED.
 *
 * THE FLAG IS THE ONE DEFINITION OF HR COMPLETION. Both changes were made
 * here, at the source both screens read, rather than in a screen: the
 * employee list's HR column and the Onboarding / Pending HR queue now agree
 * by construction, and there is no second opinion to drift.
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
 * somebody chasing PF has no use for a flag that also goes up for an
 * unverified Aadhaar. So the same statutory read now also reports each scheme
 * on its own, as `pf_status` / `esi_status`, in three values:
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
  constructor(employeeUsecase, aadhaarRepo, bankRepo, employeeMasterRepo, salaryRepo) {
    this.employees = employeeUsecase;
    this.aadhaarRepo = aadhaarRepo || null;
    this.bankRepo = bankRepo || null;
    this.masterRepo = employeeMasterRepo || null;
    this.salaryRepo = salaryRepo || null;
  }

  /**
   * Which HR follow-up items are still outstanding for one employee.
   *
   * `statutory` is `{ pfDecided, esiDecided }`, or null when this server
   * cannot tell - in which case the caller omits the keys rather than
   * reporting a completeness it did not establish.
   *
   * THE REASONS, in this order, and each one appearing at most once:
   *
   *   "aadhaar"     no verified Aadhaar identity is attached. HR's to chase
   *                 whatever left it unverified - see the note above.
   *   "statutory"   the PF or the ESI decision has not been recorded. ONE
   *                 reason for both schemes, which is the existing naming and
   *                 is kept: they are one section of the profile, completed
   *                 in one edit.
   *   "bank"        the account is not payroll ready.
   *
   * `pending` is exactly `missing.length > 0`, so the flag and the reasons
   * can never contradict each other.
   */
  static hrOnboardingState({ aadhaarVerified, statutory, bankPayrollReady, payroll }) {
    if (!statutory || !payroll) return null;
    const missing = [];
    if (!aadhaarVerified) missing.push("aadhaar");
    if (!statutory.pfDecided || !statutory.esiDecided) missing.push("statutory");
    // Payroll ready, not merely on file: an account that has not passed its
    // check is an employee who cannot be paid, which is work rather than a
    // finished section.
    if (!bankPayrollReady) missing.push("bank");
    // THE FOURTH ITEM. A record with a verified identity, a recorded statutory
    // decision and a payable account is still not a finished record if nobody
    // has put the employee on payroll - they will not be paid this month
    // either way, which is the whole thing this queue exists to prevent.
    // `payroll.missing` names which part; one reason is added here, exactly as
    // "statutory" covers PF and ESI together.
    if (payroll.pending) missing.push("payroll");
    return { pending: missing.length > 0, missing };
  }

  /**
   * IS THIS EMPLOYEE SET UP TO BE PAID? - derived from the payroll module's
   * own rules, not from a second opinion about them.
   *
   * THREE THINGS HAVE TO BE TRUE, and each one is somebody's outstanding work
   * when it is not:
   *
   *   "salary"        a LIVE salary exists. `repository/employee_salary.js`
   *                   defines that and this reads its answer: the latest
   *                   APPROVED revision effective on or before today. A
   *                   PENDING proposal is not a salary - it has not been
   *                   agreed - and a REJECTED one never was, so an employee
   *                   whose only revision is awaiting approval is payroll
   *                   pending, which is precisely the state somebody needs to
   *                   see.
   *
   *   "salary_ctc"    that salary's `ctc_status` is APPLIED. The engine writes
   *                   PENDING when an employer cost could not be resolved -
   *                   an unrecorded PF applicability, an unanswered EPS
   *                   membership - and `utils/salary_engine.js` is explicit
   *                   that a CTC with an unresolved component in it is not a
   *                   CTC. A salary that cannot be costed is not a finished
   *                   payroll setup.
   *
   *   "payment_type"  somebody has said HOW the employee is paid, and if that
   *                   is Bank, the account has passed its check. Cash needs no
   *                   account, so a cash-paid employee is not held up by one -
   *                   requiring it would be work nobody will ever do.
   *
   * RESIGNED AND INACTIVE EMPLOYEES NEVER REACH THIS. The queue filters to
   * active employees before any of it is counted, and this usecase is only
   * ever asked about the population `GET /employee/employees` returns.
   *
   * `null` - not "complete" - where this server cannot answer, following the
   * rule the statutory read above already follows: a payroll module that is
   * not wired must never read as "nothing outstanding".
   */
  static payrollState({ salary, config, bankPayrollReady }) {
    if (!config) return null;
    const missing = [];
    if (!salary || !salary.hasLiveSalary) missing.push("salary");
    else if (!salary.ctcApplied) missing.push("salary_ctc");

    if (!config.paymentTypeRecorded) missing.push("payment_type");
    else if (!config.paysInCash && !bankPayrollReady) missing.push("payment_account");

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

    const [aadhaarIds, bank, statutory, salaries, payrollConfig] = await Promise.all([
      this._aadhaarIds(ids),
      this._bankStatuses(ids),
      this._statutoryDecisions(ids),
      this._liveSalaries(ids),
      this._payrollConfig(ids),
    ]);

    return ids.map((employee_id) => {
      const b = bank.get(employee_id) || { status: "NOT_PROVIDED", bank_payroll_ready: false };
      const decisions = statutory
        ? statutory.get(employee_id) || { pfDecided: false, esiDecided: false }
        : null;
      const aadhaarVerified = aadhaarIds.has(employee_id);
      // An employee with no salary row at all is not missing from the answer -
      // they are the commonest case of "payroll not set up yet", so the
      // absence IS the answer rather than a gap in it.
      const payroll = EmployeeStatusSummaryUsecase.payrollState({
        salary: (salaries && salaries.get(employee_id)) || { hasLiveSalary: false, ctcApplied: false },
        config: payrollConfig ? payrollConfig.get(employee_id) || { paymentTypeRecorded: false, paysInCash: false } : null,
        bankPayrollReady: b.bank_payroll_ready,
      });
      const onboarding = EmployeeStatusSummaryUsecase.hrOnboardingState({
        aadhaarVerified,
        statutory: decisions,
        bankPayrollReady: b.bank_payroll_ready,
        payroll,
      });
      const scheme = (decided, notApplicable) =>
        EmployeeStatusSummaryUsecase.schemeStatus(decided, notApplicable, {
          disclose: disclosePfEsiApplicability,
        });
      return {
        employee_id,
        aadhaar_status: aadhaarVerified ? "VERIFIED" : "PENDING",
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
              // THE TWO SCHEMES AS ONE SECTION, which is how they are asked
              // and how they are now counted. Derived here, from the same two
              // decisions, so the Statutory card and the PF / ESI values it
              // replaces cannot drift apart - and NOT_APPLICABLE is not
              // pending, because the decision has been recorded.
              statutory_pending: !decisions.pfDecided || !decisions.esiDecided,
            }
          : {}),
        // Payroll, on the same terms as every key above: derived, carrying no
        // amount, and omitted rather than guessed where it cannot be answered.
        ...(payroll
          ? { payroll_pending: payroll.pending, payroll_missing: payroll.missing }
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
   * The live salary per employee, as two booleans. One bulk read, and null -
   * not an empty map - where this server has no salary module, so "not wired"
   * never reads as "payroll is set up".
   *
   * TODAY is the as-of date, the same one `getCurrentSalary` is asked for
   * elsewhere: a revision approved for next month is genuinely not this
   * employee's salary yet.
   */
  async _liveSalaries(ids) {
    if (!this.salaryRepo || typeof this.salaryRepo.getCurrentSalaryStatusMany !== "function") {
      return null;
    }
    const rows = await this.salaryRepo.getCurrentSalaryStatusMany(ids, EmployeeStatusSummaryUsecase.today());
    const out = new Map();
    for (const row of rows || []) {
      out.set(Number(row.employee_id), {
        hasLiveSalary: true,
        ctcApplied: String(row.ctc_status) === "APPLIED",
      });
    }
    return out;
  }

  /**
   * How each employee is paid, per employee. Same rule as every other bulk
   * read here: null where the repository cannot answer.
   */
  async _payrollConfig(ids) {
    if (!this.masterRepo || typeof this.masterRepo.getPayrollConfigMany !== "function") return null;
    const rows = await this.masterRepo.getPayrollConfigMany(ids);
    const out = new Map();
    for (const row of rows || []) {
      out.set(Number(row.employee_id), {
        paymentTypeRecorded: Boolean(Number(row.payment_type_recorded)),
        paysInCash: Boolean(Number(row.pays_in_cash)),
      });
    }
    return out;
  }

  /** YYYY-MM-DD, as the salary repository's as-of date. */
  static today() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
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

module.exports = (employeeUsecase, aadhaarRepo, bankRepo, employeeMasterRepo, salaryRepo) =>
  new EmployeeStatusSummaryUsecase(employeeUsecase, aadhaarRepo, bankRepo, employeeMasterRepo, salaryRepo);
module.exports.EmployeeStatusSummaryUsecase = EmployeeStatusSummaryUsecase;
