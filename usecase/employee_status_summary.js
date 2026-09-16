const logger = require("../utils/logger");
const { EmployeeBankUsecase } = require("./employee_bank");
const { statusFromRows, isConnected } = require("../utils/employee_telegram_status");

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
 *   bank        the employee is paid BY BANK and the account is not payroll
 *               ready - see `bankState`
 *   payroll     no live salary, an uncosted one, or no recorded way to pay
 *               them - see `payrollState`
 *
 * CASH IS A ROUTE, NOT A FAILURE, AND IT IS NOT ONE OF THE FOUR. Cash is a
 * payment route payroll accepts today, so a cash-paid employee with a costed
 * salary is a FINISHED record: their bank section is Not Applicable rather
 * than pending, and nothing about being on cash makes them HR pending. The
 * migration onto bank accounts is real work somebody is running, so it is
 * counted - as `cash_to_bank_pending` - but as its own operational question.
 * An employee can be HR complete, payroll complete, and still on that list.
 * That is intended: the alternative parks every cash employee permanently in
 * the HR queue for work that is not the employee's record's fault.
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
 * THE PAYMENT ROUTE IS SENSITIVE, AND IS GATED LIKE ONE. `payment_type` is a
 * B3-sensitive column, and "this employee is paid in cash" is a value of it.
 * So `cash_to_bank_pending` is sent ONLY to a caller holding
 * `view_employee_sensitive` - the same key that unlocks NOT_APPLICABLE above,
 * and no new permission for it.
 *
 * IT IS OMITTED, NOT SENT AS FALSE. That distinction is the point rather than
 * a detail: a `false` would let a screen count zero employees on cash and
 * state, as a fact, that the migration is finished. A withheld key makes the
 * card impossible to draw, which is the honest outcome - no number beats a
 * wrong one.
 *
 * `bank_pending` IS NOT GATED, AND MUST NOT BE. It is the Bank card's count
 * and every caller has to see the same number; only the REASON behind it is
 * withheld, because NOT_APPLICABLE names the route in as many words. Without
 * the permission it reads UNKNOWN - "nothing outstanding here, no further
 * detail".
 *
 * WHAT STILL LEAKS, STATED PLAINLY RATHER THAN GLOSSED. A caller without the
 * permission can still narrow the route by inference: an employee whose
 * `bank_status` is NOT_PROVIDED and whose `bank_pending` is nonetheless false
 * is either paid in cash or has no recorded route, because a bank-paid
 * employee with no account would be pending. That residue is the price of
 * `bank_pending` being the same number for everybody, which is a requirement;
 * closing it entirely would mean giving the two callers different Bank counts.
 * It is one bit, narrowed to two possibilities, and nothing names cash.
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
  constructor(employeeUsecase, aadhaarRepo, bankRepo, employeeMasterRepo, salaryRepo, telegramRepo) {
    this.employees = employeeUsecase;
    this.aadhaarRepo = aadhaarRepo || null;
    this.bankRepo = bankRepo || null;
    this.masterRepo = employeeMasterRepo || null;
    this.salaryRepo = salaryRepo || null;
    /**
     * OPTIONAL AND READ-ONLY, like `masterRepo` above. Where it is not wired
     * the Telegram keys are OMITTED rather than guessed at - a `PENDING` this
     * endpoint did not establish would put every employee on a work queue for
     * a reason that was really "this server is not configured".
     */
    this.telegramRepo = telegramRepo || null;
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
   *   "bank"        the employee is paid BY BANK and the account is not
   *                 payroll ready - see `bankState`.
   *
   * BEING PAID IN CASH IS NOT ONE OF THE REASONS, and that is the whole of
   * the distinction this class now draws. Cash is a route payroll accepts
   * today, so a cash-paid employee with a costed salary is a FINISHED record;
   * moving them onto a bank account is an operational migration somebody is
   * running, reported separately as `cash_to_bank_pending`, and it must never
   * hold up an employee's HR completion. Counting it here would put every
   * cash employee permanently in the HR queue for work that is not theirs.
   *
   * `pending` is exactly `missing.length > 0`, so the flag and the reasons
   * can never contradict each other.
   */
  static hrOnboardingState({ aadhaarVerified, statutory, bank, payroll }) {
    if (!statutory || !payroll || !bank) return null;
    const missing = [];
    if (!aadhaarVerified) missing.push("aadhaar");
    if (!statutory.pfDecided || !statutory.esiDecided) missing.push("statutory");
    // Payroll ready, not merely on file, and only for somebody who is
    // actually paid by bank transfer: an account that has not passed its
    // check is an employee who cannot be paid, which is work rather than a
    // finished section. A cash employee has no account to finish.
    if (bank.pending) missing.push("bank");
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
   * THE BANK SECTION, AS THE DASHBOARD ASKS IT: is there an account that
   * still has to be finished for THIS employee?
   *
   * IT DEPENDS ON HOW THEY ARE PAID, which is the correction this makes. The
   * question "is the bank section outstanding" has no answer until somebody
   * has said the employee is paid by bank transfer at all:
   *
   *   BANK        `applicable` - pending until the account is payroll ready,
   *               exactly as before. This is the employee somebody has to
   *               chase.
   *   CASH        NOT APPLICABLE. There is no account to verify and nobody is
   *               ever going to verify one, so reporting them as Bank Pending
   *               is a chase that can never be closed. They appear on the
   *               separate cash-migration count instead.
   *   not recorded  UNKNOWN, and deliberately NOT pending. Until the payment
   *               type is recorded there is no way to say whether this
   *               employee needs an account - and the thing that IS
   *               outstanding for them, the unrecorded payment type itself,
   *               is already reported by `payrollState`. Reporting it twice
   *               under a second name would double-count one piece of work.
   *
   * `bank_status` and `bank_payroll_ready` are UNCHANGED and still reported:
   * they are the raw C2 answer about the account itself, which the employee's
   * profile and the employee list both render, and neither of them is asking
   * this question.
   */
  static bankState({ config, bankPayrollReady }) {
    if (!config) return null;
    if (!config.paymentTypeRecorded) {
      return { applicable: null, pending: false, status: "UNKNOWN" };
    }
    if (config.paysInCash) {
      return { applicable: false, pending: false, status: "NOT_APPLICABLE" };
    }
    return {
      applicable: true,
      pending: !bankPayrollReady,
      status: bankPayrollReady ? "COMPLETE" : "PENDING",
    };
  }

  /**
   * CASH -> BANK: is this employee still being paid in cash?
   *
   * AN OPERATIONAL MIGRATION, NOT A COMPLIANCE FAILURE. Cash is a payment
   * route the business accepts today, so an employee on it is not incomplete
   * and nothing about their record is wrong. What HR needs is a running count
   * of how many people are still to be moved onto a bank account, and a list
   * of who they are - which is a different question from every other status
   * on this endpoint, and is why it is a separate key rather than a flavour
   * of the bank one.
   *
   * IT IS DELIBERATELY ABSENT FROM `hr_onboarding_pending`. See the note
   * there: an employee can be HR complete, payroll complete, and still be on
   * this list. That is the intended outcome, not an inconsistency.
   *
   * An unrecorded payment type is NOT cash - nobody has said what it is - so
   * it is UNKNOWN and counts towards neither side.
   */
  static cashToBankState({ config }) {
    if (!config) return null;
    if (!config.paymentTypeRecorded) return { pending: false, status: "UNKNOWN" };
    return {
      pending: Boolean(config.paysInCash),
      status: config.paysInCash ? "PENDING" : "COMPLETE",
    };
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
   * @param options `{ disclosePfEsiApplicability, disclosePaymentRoute }` -
   *   both true only for a caller holding `view_employee_sensitive`; see the
   *   NOT_APPLICABLE note and the payment-route note above.
   */
  async list(filters, { disclosePfEsiApplicability = false, disclosePaymentRoute = false } = {}) {
    const employees = await this.employees.get(filters || {});

    const ids = [];
    for (const e of employees || []) {
      const id = Number(e.employee_id);
      if (Number.isInteger(id) && id > 0) ids.push(id);
    }
    if (ids.length === 0) return [];

    const [aadhaarIds, bank, statutory, salaries, payrollConfig, telegram] = await Promise.all([
      this._aadhaarIds(ids),
      this._bankStatuses(ids),
      this._statutoryDecisions(ids),
      this._liveSalaries(ids),
      this._payrollConfig(ids),
      this._telegramFacts(ids),
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
      const config = payrollConfig
        ? payrollConfig.get(employee_id) || { paymentTypeRecorded: false, paysInCash: false }
        : null;
      const payroll = EmployeeStatusSummaryUsecase.payrollState({
        salary: (salaries && salaries.get(employee_id)) || { hasLiveSalary: false, ctcApplied: false },
        config,
        bankPayrollReady: b.bank_payroll_ready,
      });
      // The bank SECTION (does this employee still need an account finished)
      // and the cash MIGRATION (are they still paid in cash) - two questions
      // off the one payment route, and only the first is HR completion.
      const bankSection = EmployeeStatusSummaryUsecase.bankState({
        config,
        bankPayrollReady: b.bank_payroll_ready,
      });
      const cashToBank = EmployeeStatusSummaryUsecase.cashToBankState({ config });
      const onboarding = EmployeeStatusSummaryUsecase.hrOnboardingState({
        aadhaarVerified,
        statutory: decisions,
        bank: bankSection,
        payroll,
      });
      const scheme = (decided, notApplicable) =>
        EmployeeStatusSummaryUsecase.schemeStatus(decided, notApplicable, {
          disclose: disclosePfEsiApplicability,
        });
      // TELEGRAM. Two scalars, derived by the SHARED precedence rule so this
      // badge and the employee's own Telegram screen cannot disagree - see
      // `utils/employee_telegram_status.js`. It carries no Telegram user id,
      // no chat id, no mobile and no token: the same kind of fact as
      // `aadhaar_status`, under the same `view_employees` permission.
      //
      // CONNECTED HERE IS NOT "TELEGRAM COMPLETE". Required-group membership
      // does not exist yet, so a connected employee still has work outstanding
      // and the screens say so. Nothing in this endpoint claims completion,
      // and `hr_onboarding_pending` is deliberately NOT changed - adding
      // Telegram to it today would mark all 630 employees incomplete for a
      // feature that has not shipped.
      const telegramFacts = telegram ? telegram.get(employee_id) : null;
      const telegramStatus = telegramFacts ? statusFromRows(telegramFacts) : null;
      return {
        employee_id,
        aadhaar_status: aadhaarVerified ? "VERIFIED" : "PENDING",
        ...(telegramStatus
          ? {
              telegram_status: telegramStatus,
              telegram_connected: isConnected(telegramStatus),
            }
          : {}),
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
        // The bank SECTION as the dashboard asks it - route-aware, and not to
        // be confused with `bank_status` above, which is the raw C2 answer
        // about the account itself and is unchanged.
        //
        // `bank_pending` IS TOLD TO EVERYONE - it is the Bank card's count and
        // it must be the same number for every caller, which is the whole
        // point of the route-aware rule. Only the REASON is withheld:
        // NOT_APPLICABLE names the payment route in as many words, so without
        // `view_employee_sensitive` it collapses to UNKNOWN - "nothing
        // outstanding, no further detail" - rather than "they are paid in
        // cash". COMPLETE and PENDING are unchanged for everybody.
        ...(bankSection
          ? {
              bank_pending: bankSection.pending,
              bank_section_status:
                !disclosePaymentRoute && bankSection.status === "NOT_APPLICABLE"
                  ? "UNKNOWN"
                  : bankSection.status,
            }
          : {}),
        // The cash migration. NOT part of `hr_onboarding_pending` - see
        // `cashToBankState` - and reported so the dashboard can count it
        // without inferring it from the absence of an account.
        //
        // SENSITIVE, AND SENT TO NOBODY ELSE. It is a value of `payment_type`,
        // so it goes only to a caller holding `view_employee_sensitive`. It is
        // OMITTED rather than sent as false for everybody else, which matters
        // more here than anywhere on this endpoint: a `false` would let a
        // screen count zero cash employees and state as a fact that nobody is
        // on cash, which is worse than showing no card at all.
        //
        // OMITTED TOO WHERE THE ROUTE WAS NEVER RECORDED, for the same reason
        // in a different direction: `false` is not "we do not know", and a
        // screen reading it would say this employee is paid by bank - a route
        // nobody has chosen for them.
        ...(disclosePaymentRoute && cashToBank && cashToBank.status !== "UNKNOWN"
          ? { cash_to_bank_pending: cashToBank.pending }
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
   * The Telegram facts for the whole list, in the repository's TWO queries.
   *
   * Returns null - not an empty map - where the repository is not wired, so
   * the caller OMITS the keys rather than reporting a Pending it did not
   * establish. That is the same distinction `_statutoryDecisions` draws, and
   * for the same reason.
   *
   * A REPOSITORY FAILURE IS ALSO null. A dashboard that silently showed every
   * employee as Telegram Pending because one query failed would send somebody
   * to chase 630 people; showing no Telegram column at all is the honest
   * outcome and is what the screen already does for a failed summary.
   */
  async _telegramFacts(ids) {
    if (!this.telegramRepo || typeof this.telegramRepo.getSummaryForEmployees !== "function") {
      return null;
    }
    try {
      return await this.telegramRepo.getSummaryForEmployees(ids);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.EMPLOYEE-STATUS-SUMMARY",
        code: "USECASE.EMPLOYEE-STATUS-SUMMARY.TELEGRAM",
        description: err.toString(),
        category: "",
        ref: {},
      });
      return null;
    }
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

module.exports = (employeeUsecase, aadhaarRepo, bankRepo, employeeMasterRepo, salaryRepo, telegramRepo) =>
  new EmployeeStatusSummaryUsecase(
    employeeUsecase,
    aadhaarRepo,
    bankRepo,
    employeeMasterRepo,
    salaryRepo,
    telegramRepo
  );
module.exports.EmployeeStatusSummaryUsecase = EmployeeStatusSummaryUsecase;
