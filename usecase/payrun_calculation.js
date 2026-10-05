const { PERIOD_STATUS } = require("../constants/payrun");
const { ADJUSTMENT_STATE, COMPONENT_KEYS } = require("../constants/payrun_adjustments");
const {
  CALC_STATUS,
  CALC_CARD,
  CALCULATION_VERSION,
  ROW_RESULT,
  STORED_STATUS,
  RESET_REASON,
  RESET_MODE,
  RESETTABLE_STATUSES,
  RESET_REMARK_MAX,
  isLockedStatus,
  LIFECYCLE_ACTION,
  LIFECYCLE_REASON_MIN,
} = require("../constants/payrun_calculation");
const { monthWindow, statutorySetupComplete, statutorySetupGaps } = require("../utils/payrun_eligibility");
const { deriveState } = require("../utils/payrun_adjustments");
const calc = require("../utils/payrun_calculation");
const engine = require("../utils/salary_engine");
const { evaluatePayrollReadiness, statutoryHoldReason } = require("../utils/payroll_readiness");
const { latestClosableDate } = require("../utils/attendance_persist_guard");
const { istToday } = require("../utils/istDate");
const crypto = require("crypto");
const payslipSnapshot = require("../utils/payslip_snapshot");
const pfCeilingImpact = require("../utils/pf_ceiling_impact");
const epfoEcr = require("../utils/epfo_ecr");
const { resolvePayslipCompany, payslipCompanyStatus } = require("../utils/payslip_company");
const {
  SNAPSHOT_SCHEMA_VERSION,
  TEMPLATE_VERSION,
  NOTIFICATION_RESULT,
  NOTIFICATION_TRIGGER,
} = require("../constants/payslip");
const {
  validationError,
  normalizeMonth,
  normalizeEmployeeIds,
} = require("./payrun");

/**
 * Payrun Calculation & Review - the third stage.
 *
 *   Initialization -> Adjustments -> CALCULATION & REVIEW -> Approve & Lock
 *
 * WHAT THIS STAGE IS, IN ONE SENTENCE: it takes the snapshot the month was
 * initialized from, the attendance result the engine calculated, the OT
 * somebody approved and the adjustments somebody entered, and produces the one
 * set of figures a person can look at and sign off.
 *
 * IT CONSUMES EXISTING PAYROLL SOURCES AND RECREATES NONE OF THEM. There is no
 * attendance logic in this stage - no punch, no shift, no minute and no NRM
 * derived from a shift master. `usecase/attendance_calculation.js` owns that
 * and `utils/salary_engine.js` owns PF and ESI; this file fetches what
 * `utils/payrun_calculation.js` needs and performs what it permits, which is
 * the same division every payrun stage before it keeps.
 *
 * ================================ A SOURCE MAY NEVER SILENTLY MOVE A MONTH ==
 *
 * THE FAILURE THIS STAGE EXISTS TO PREVENT is a figure that changed after
 * somebody looked at it. So:
 *
 *   calculating STORES the figures, rather than a screen recomputing them from
 *   the sources on every read
 *
 *   every read compares the CURRENT sources against the ones the stored
 *   calculation consumed, and says RECALCULATION_REQUIRED when they differ -
 *   naming which source moved
 *
 *   nothing, anywhere, recalculates an employee because a source moved. A
 *   person does it, explicitly, and until they do the stored figures are
 *   exactly what they were
 *
 *   and an employee whose sources have moved CANNOT BE APPROVED
 *
 * ============================================= RECALCULATION PRESERVES ======
 *
 * A RECALCULATION REFRESHES THE SOURCES AND TOUCHES NOTHING THE PAYRUN OWNS.
 * The approved salary, the attendance result, the approved OT, the effective
 * NRM and the version markers are read afresh; the Incentive, Bonus, Arrears,
 * Advance Recovery, Shortage Recovery, Balance Advance, the no-adjustment
 * confirmation and the monthly BANK/CASH pay type are NOT written by any path
 * in this file. That is structural rather than careful: this usecase has no
 * reference to the adjustment write methods and its repository has no
 * statement that could touch `payrun_employee` or the adjustment tables.
 *
 * ============================================= APPROVAL LOCKS ONE PERSON ====
 *
 * APPROVAL IS PER EMPLOYEE AND SO IS THE LOCK. One employee may be approved
 * and frozen while the other five hundred and ninety-nine are still being
 * worked on; nothing here locks a month, and `payrun_period` is not written by
 * this stage at all. After the lock, recalculation, adjustment edits, pay type
 * changes and a second approval are all refused - the last three by the stages
 * that own them, which ask this one whether an employee is locked.
 */

/** Normalizes the `employee_ids` / `all_eligible` pair one bulk action takes. */
function normalizeSelection({ employee_ids, all_eligible }) {
  const wantsAll = all_eligible === true || all_eligible === "true";
  if (wantsAll) {
    if (employee_ids !== undefined && employee_ids !== null) {
      /*
       * BOTH AT ONCE IS AMBIGUOUS AND IS REFUSED RATHER THAN RESOLVED.
       * "Everybody, and also these forty" has two readings and the wrong one
       * calculates six hundred people somebody did not ask for.
       */
      throw validationError("Send either employee_ids or all_eligible, not both");
    }
    return { all: true, ids: null };
  }
  return { all: false, ids: normalizeEmployeeIds(employee_ids) };
}

class PayrunCalculationUsecase {
  /**
   * @param calculationRepo  this stage's own two tables
   * @param payrunRepo       the snapshot, the month's lock and the pending
   *                         attendance/OT counts. READ ONLY from here.
   * @param adjustmentRepo   the stored component amounts and the confirmation
   *                         state. READ ONLY from here - see the header.
   */
  constructor(calculationRepo, payrunRepo, adjustmentRepo) {
    this.repo = calculationRepo;
    this.payrunRepo = payrunRepo;
    this.adjustmentRepo = adjustmentRepo;
    this.attendanceProcessor = null;
    this.payslipRepo = null;
    this.notifier = null;
    this.companyEnv = () => ({});
    this.today = () => istToday();
  }

  /**
   * PAYSLIPS. `payslipRepo` (repository/payrun_payslip.js) reads and records
   * payslips and queues notification attempts; `notifier`
   * (usecase/payslip_notification.js) is the worker that sends the
   * figure-free "available" message - Publish only kicks it, never waits.
   * `companyEnv` returns the PAYSLIP_COMPANY_* overrides (utils/payslip_company.js);
   * the company itself comes from `company_details`.
   */
  setPayslipServices({ payslipRepo = null, notifier = null, companyEnv = null } = {}) {
    this.payslipRepo = payslipRepo;
    this.notifier = notifier;
    if (typeof companyEnv === "function") this.companyEnv = companyEnv;
  }

  /** The payslip issuer, frozen into each snapshot. Refuses rather than guesses. */
  async _payslipCompany() {
    const rows = await this.payslipRepo.listCompanies();
    return resolvePayslipCompany(rows, this.companyEnv() || {});
  }

  /**
   * CAN PAYSLIPS BE PUBLISHED - the same decision `_payslipCompany` makes at
   * Publish, as data, so the Payroll screen disables Publish and says why
   * instead of letting somebody press it to find out.
   */
  async getPayslipCompanyStatus() {
    if (!this.payslipRepo) {
      return { configured: false, reason: "NOT_AVAILABLE", message: "Payslip publishing is not configured on this server", company: null };
    }
    const rows = await this.payslipRepo.listCompanies();
    return payslipCompanyStatus(rows, this.companyEnv() || {});
  }

  /**
   * THE EXISTING ATTENDANCE ENGINE, for Process Attendance. Injected after
   * construction (the attendance usecase is built later in `server.js`), and
   * only its `calculateMonth({ persist: true })` is ever called - the same
   * month persist the Attendance screens run. Payroll has no attendance logic
   * of its own.
   */
  setAttendanceProcessor(attendanceCalculationUsecase) {
    this.attendanceProcessor = attendanceCalculationUsecase || null;
  }

  /* ==================================================================== */
  /*  reading the month                                                   */
  /* ==================================================================== */

  /**
   * EVERYTHING THE STAGE NEEDS ABOUT A MONTH, IN SEVEN BATCHED READS.
   *
   * Seven reads for six hundred employees, not seven times six hundred - the
   * rule `repository/payrun.js` sets out and every payrun stage keeps.
   *
   * THE SCOPE IS THE SERVER'S. `store_ids` arrives already resolved by the
   * employee branch scope: `null` is company-wide, a list is those branches,
   * and an EMPTY list is no branches at all rather than all of them.
   */
  async _assemble({ year, month, store_ids = null, employee_ids = null }) {
    const period = normalizeMonth(year, month);
    const { from, to } = monthWindow(period.year, period.month);

    const population = await this.repo.listInitialized({
      year: period.year,
      month: period.month,
      store_ids,
      employee_ids,
    });
    const ids = population.map((row) => row.employee_id);

    const [
      attendance,
      dayRows,
      nrmGroups,
      statutory,
      salaries,
      pending,
      amounts,
      states,
      calculations,
      periodRow,
    ] = await Promise.all([
      this.repo.listAttendanceMonths(ids, period.year, period.month),
      typeof this.repo.listAttendanceDayRows === "function"
        ? this.repo.listAttendanceDayRows(ids, from, to)
        : Promise.resolve(null),
      this.repo.listEffectiveNrm(ids, from, to),
      this.repo.listStatutoryContext(ids),
      /*
       * THE CURRENT APPROVED SALARY, READ AS A SOURCE RATHER THAN AS A VALUE.
       * The calculation is performed on the SNAPSHOT's gross - that is what
       * initialization froze - and this read exists so that a revision
       * approved since can be DETECTED. Nothing below prices a month from it.
       */
      this.payrunRepo.listApprovedSalaries(ids, to),
      this.payrunRepo.listPendingApprovals(ids, from, to),
      this.adjustmentRepo.listAmounts({ year: period.year, month: period.month, employee_ids: ids }),
      this.adjustmentRepo.listStates({ year: period.year, month: period.month, employee_ids: ids }),
      this.repo.listCalculations({ year: period.year, month: period.month, employee_ids: ids }),
      this.payrunRepo.getPeriod(period.year, period.month),
    ]);

    const index = (rows) => {
      const map = new Map();
      (rows || []).forEach((row) => {
        if (!map.has(Number(row.employee_id))) map.set(Number(row.employee_id), row);
      });
      return map;
    };

    /*
     * ===================== THE ESI CONTRIBUTION-PERIOD EVIDENCE, FETCHED ====
     *
     * ESI coverage is decided ONCE per contribution period and runs to the end
     * of it, so what decides it is the approved salary that was in force when
     * the period BEGAN - or when the employee joined, if they joined part-way
     * through. That is a different record from the one pricing this month, and
     * often a much older one.
     *
     * THE DATE IS THE ENGINE'S, NOT THIS LAYER'S.
     * `contributionPeriodEntryDate` derives it from the period and the date of
     * joining; nothing here invents one, and a request body cannot reach it.
     * This is the same call `usecase/employee_salary.js` makes for the Salary
     * Master, against the same resolver - one rule, two callers.
     *
     * READ ONCE PER DISTINCT DATE, NOT ONCE PER EMPLOYEE. A month has ONE
     * contribution period, so almost everybody shares the period's start date;
     * only employees who joined part-way through it have one of their own.
     * Six hundred employees therefore cost one read plus one per mid-period
     * joiner, rather than six hundred - the batching rule every payrun
     * repository keeps.
     */
    const asOf = to;
    const entryDateOf = new Map();
    population.forEach((employee) => {
      const entryDate = engine.contributionPeriodEntryDate({
        as_of: asOf,
        date_of_joining: employee.date_of_joining,
      });
      entryDateOf.set(Number(employee.employee_id), entryDate);
    });

    const idsByEntryDate = new Map();
    entryDateOf.forEach((entryDate, employeeId) => {
      if (!entryDate) return;
      if (!idsByEntryDate.has(entryDate)) idsByEntryDate.set(entryDate, []);
      idsByEntryDate.get(entryDate).push(employeeId);
    });

    const entrySalaryOf = new Map();
    await Promise.all(
      [...idsByEntryDate.entries()].map(async ([entryDate, employeeIds]) => {
        const rows = await this.payrunRepo.listApprovedSalaries(employeeIds, entryDate);
        (rows || []).forEach((row) => {
          const key = Number(row.employee_id);
          if (!entrySalaryOf.has(key)) entrySalaryOf.set(key, row);
        });
      })
    );
    const group = (rows) => {
      const map = new Map();
      (rows || []).forEach((row) => {
        const key = Number(row.employee_id);
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(row);
      });
      return map;
    };

    const amountsOf = new Map();
    (amounts || []).forEach((row) => {
      const key = Number(row.employee_id);
      if (!amountsOf.has(key)) amountsOf.set(key, {});
      amountsOf.get(key)[row.component] = row.amount;
    });

    return {
      period,
      window: { from, to },
      month_locked: Boolean(periodRow && periodRow.status === PERIOD_STATUS.LOCKED),
      population,
      attendanceOf: index(attendance),
      // null when the repository cannot read day rows: readiness is then not
      // evaluated and the older summary-flag rule applies.
      dayRowsOf: dayRows === null ? null : group(dayRows),
      latestClosedDate: latestClosableDate(this.today()),
      nrmOf: group(nrmGroups),
      statutoryOf: index(statutory),
      salaryOf: index(salaries),
      entryDateOf,
      entrySalaryOf,
      pendingOf: index(pending),
      amountsOf,
      stateOf: index(states),
      calculationOf: index(calculations),
    };
  }

  /**
   * ONE EMPLOYEE'S ROW: their current status, and their stored figures if they
   * have any.
   *
   * THE STATUS IS DECIDED HERE AND NOW, FROM THE WORLD AS IT IS. Nothing is
   * read from a stored status column except the two facts that cannot go stale
   * - a calculation exists, and somebody approved it. See
   * `constants/payrun_calculation.js#STORED_STATUS` for why the other three
   * states are computed rather than stored.
   */
  _present(context, employee) {
    const id = Number(employee.employee_id);
    const attendance = context.attendanceOf.get(id) || null;
    const nrm = calc.resolveEffectiveNrm(context.nrmOf.get(id) || []);
    const statutory = context.statutoryOf.get(id) || {};
    const salary = context.salaryOf.get(id) || null;
    const counts = context.pendingOf.get(id) || {};
    const amounts = context.amountsOf.get(id) || {};
    const state = context.stateOf.get(id) || null;
    const stored = context.calculationOf.get(id) || null;

    const adjustmentState = deriveState({
      amounts,
      confirmed_no_adjustment: Boolean(state && Number(state.confirmed_no_adjustment) === 1),
    });

    /*
     * THE CURRENT MARKERS ARE BUILT FROM THE LIVE SOURCES - the approved
     * salary effective for the month RIGHT NOW, the attendance row as it
     * stands, the approved OT minutes it carries, the NRM resolved from the
     * current day rows, and the live applicability flags. The stored
     * calculation's own markers are what they were when it ran. The comparison
     * between the two is the whole of source-change detection.
     */
    /*
     * THE COVERAGE EVIDENCE AS A SOURCE MARKER. The entry DATE, the record
     * found at it and that record's gross - because a revision back-dated into
     * the month the contribution period began changes whether this month is
     * covered, while `salary_id` and every other marker stay exactly as they
     * were. Without these three, that change would be invisible.
     */
    const entryDate = context.entryDateOf.get(id) || null;
    const entrySalary = context.entrySalaryOf.get(id) || null;

    /*
     * ========================== THE STATUTORY SETUP HOLD ==================
     *
     * Judged on the snapshot's applicability (what the month is calculated
     * on - changing it needs a Reset and re-initialisation) and on the LIVE
     * identifiers, so the hold lifts on the next read once HR records them.
     * Previous PF / EPS Member and DOB are not hold facts (see
     * `utils/payrun_eligibility.js#statutorySetupGaps`). A held employee is not calculable: Calculate refuses
     * them by name and approval is blocked; nothing is assumed for them.
     */
    const setupView = {
      ...employee,
      uan: statutory.uan !== undefined && statutory.uan !== null && String(statutory.uan).trim() !== "" ? statutory.uan : employee.uan,
      pf_number:
        statutory.pf_number !== undefined && statutory.pf_number !== null && String(statutory.pf_number).trim() !== ""
          ? statutory.pf_number
          : employee.pf_number,
      date_of_joining: employee.date_of_joining || statutory.date_of_joining || null,
    };
    const statutoryGaps = statutorySetupGaps(setupView, context.period);
    const statutoryHold = statutoryHoldReason(statutoryGaps);

    const currentMarkers = calc.sourceMarkers({
      salary: salary || {},
      attendance: attendance || {},
      nrm,
      statutory,
      coverage: {
        entry_date: entryDate,
        entry_salary_id: entrySalary ? entrySalary.salary_id : null,
        entry_gross: entrySalary ? entrySalary.monthly_gross : null,
      },
    });
    const currentSourceHash = calc.sourceHash(currentMarkers);
    const currentInputsHash = calc.inputsHash({ amounts, pay_type: employee.pay_type });

    /*
     * THE SHARED PAYROLL READINESS. A dry run of the very calculation
     * Calculate performs supplies its errors, so "calculable" here and
     * "accepted" there are one decision, not two.
     */
    let readiness = null;
    if (context.dayRowsOf !== null) {
      const dryRun = calc.computeCalculation({
        snapshot: employee,
        attendance: attendance || {},
        nrm,
        amounts,
        statutory,
        as_of: context.window.to,
        coverage_entry_salary: entrySalary,
        day_rows: context.dayRowsOf ? context.dayRowsOf.get(id) || [] : null,
      });
      readiness = evaluatePayrollReadiness({
        year: context.period.year,
        month: context.period.month,
        snapshot: employee,
        monthly: attendance,
        day_rows: context.dayRowsOf.get(id) || [],
        attendance_required: !(statutory && Number(statutory.attendance_required) === 0),
        pending: counts,
        closed_for_payroll: Number(employee.attendance_closed_for_payroll) === 1,
        latest_closed_date: context.latestClosedDate,
        calculation_errors: dryRun.errors,
        statutory_gaps: statutoryGaps,
      });
    }

    const verdict = calc.deriveStatus({
      calculation: stored
        ? {
            status: stored.status,
            source_hash: stored.source_hash,
            inputs_hash: stored.inputs_hash,
            is_complete: Number(stored.is_complete) === 1,
            published_at: stored.published_at || null,
          }
        : null,
      current_source_hash: currentSourceHash,
      current_inputs_hash: currentInputsHash,
      /*
       * THE STORED ROW IS TRANSLATED BACK INTO MARKERS BEFORE IT IS COMPARED -
       * see `storedMarkers`. The OT split is stored as the priced breakdown
       * and marked as the bare split, and comparing one against the other
       * would report every calculated employee as stale on every read.
       */
      change_reasons: stored ? calc.detectChanges(calc.storedMarkers(stored), currentMarkers) : [],
      attendance,
      pending_regularizations: Number(counts.pending_regularizations || 0),
      pending_ot: Number(counts.pending_ot || 0),
      adjustment_state: adjustmentState,
      statutory_setup_complete: statutorySetupComplete(employee) && statutoryGaps.length === 0,
      statutory_hold: statutoryHold,
      /*
       * THE ACCEPTED ATTENDANCE BASIS, read from the snapshot rather than
       * inferred from anything on this screen. It satisfies the attendance
       * part of approval readiness and nothing else - see `deriveStatus`.
       */
      attendance_closed_for_payroll:
        Number(employee.attendance_closed_for_payroll) === 1,
      readiness,
    });

    /**
     * ================== A PROVISIONAL FIGURE IS NOT A RESULT =============
     *
     * WHAT THIS SUPPRESSES AND WHY. Salary Days, Extra Days, the approved OT,
     * the PF, the ESI and the Net Pay are all arithmetic on the attendance
     * month. While that month is missing or not final, the engine's answer to
     * each of them is a PROVISIONAL figure - and a provisional figure of zero,
     * printed in the column a payroll is read from, is indistinguishable from
     * a calculated zero. "Nobody has settled this person's attendance yet" and
     * "this person earned nothing" are different statements about somebody's
     * pay, and the screen was making the second one.
     *
     * IT IS PRESENTATION AND NOTHING ELSE. The stored row is not touched, not
     * recomputed and not deleted; `internals.stored` below is the calculation
     * exactly as it was written, which is what `calculate`, `approve` and the
     * source-change comparison all go on working from. What changes is only
     * which of its figures this layer is willing to present as an answer.
     *
     * A GENUINE ZERO SURVIVES IT. The suppression is decided by whether the
     * ATTENDANCE IS FINAL, never by whether a figure is zero - so an employee
     * whose settled month really does come to zero salary days still reads 0,
     * which is a fact about them and has to be visible.
     */
    const attendanceDependent = (value) => (verdict.attendance_pending ? null : value);

    return {
      internals: {
        employee,
        attendance,
        nrm,
        statutory,
        amounts,
        entrySalary,
        currentMarkers,
        currentSourceHash,
        currentInputsHash,
        stored,
        readiness,
      },
      row: {
        employee_id: id,
        payrun_employee_id: employee.payrun_employee_id,
        employee_name: employee.employee_name,
        /**
         * THE STATUTORY SETUP HOLD, when there is one: the payroll user sees
         * why this employee cannot be calculated and exactly which fields HR
         * must complete. NULL when the setup is complete.
         */
        statutory_hold: statutoryHold
          ? {
              code: statutoryHold.code,
              label: statutoryHold.label,
              message: statutoryHold.message,
              missing_fields: statutoryHold.missing_fields || statutoryGaps.map((g) => g.field),
              missing_labels: statutoryGaps.map((g) => g.label),
            }
          : null,
        location: employee.store_name,
        store_id: employee.store_id,
        designation_name: employee.designation_name,

        status: verdict.status,
        status_label: verdict.status_label,
        blockers: verdict.blockers,
        recalculation_reasons: verdict.recalculation_reasons,
        /**
         * THE PAYSLIP ELIGIBILITY CONTRACT, for the stage after this one. True
         * for exactly the employees whose month is APPROVED_LOCKED, derived
         * rather than stored so no column can disagree with the lock it
         * describes, and PER EMPLOYEE - one approved employee is eligible
         * whether or not the rest of the month is finished.
         */
        payslip_eligible: verdict.payslip_eligible,
        adjustment_state: adjustmentState,
        /**
         * WHETHER CALCULATE WOULD ACCEPT THIS EMPLOYEE NOW - the same verdict
         * Calculate enforces, so Calculate All Eligible counts only these.
         */
        calculable: verdict.calculable !== false,
        /** Whether Process Attendance (the existing engine) can clear a blocker. */
        attendance_processable: Boolean(
          readiness && readiness.attendance_processable && !isLockedStatus(verdict.status)
        ),

        /**
         * WHETHER THE ATTENDANCE THESE FIGURES WERE PRICED FROM IS SETTLED.
         *
         * SENT AS A FACT ON THE ROW rather than left to a browser to infer
         * from the blocker list, so the rule that decides which figures may be
         * presented as results lives in one place and cannot be re-derived
         * slightly differently on a phone.
         */
        attendance_pending: verdict.attendance_pending,
        /*
         * WHETHER THE ATTENDANCE THIS MONTH IS (OR WOULD BE) PRICED FROM
         * STILL NEEDS SOMEBODY - the same gate as above, extended to the
         * not-calculated. The Attendance Needs Action card reads it, so it
         * overlaps the payroll status rather than replacing it.
         */
        attendance_needs_action: verdict.attendance_needs_action === true,
        /*
         * CLOSED IS NOT THE SAME AS SETTLED, and the row says which. An
         * employee whose attendance was accepted with known gaps must be
         * distinguishable from one whose month genuinely finished - the
         * figures are equally real, but only one of them was complete.
         */
        attendance_closed_for_payroll:
          Number(employee.attendance_closed_for_payroll) === 1,
        attendance_closed_by: employee.attendance_closed_by ?? null,
        attendance_closed_at: employee.attendance_closed_at ?? null,

        /*
         * The compact list's columns. Absent until there is a calculation -
         * AND ABSENT WHILE THE ATTENDANCE IS NOT SETTLED, which is what
         * `attendanceDependent` below is for.
         */
        salary_days: attendanceDependent(stored ? stored.salary_days : null),
        extra_days: attendanceDependent(stored ? stored.extra_days : null),
        approved_ot_hours: attendanceDependent(
          stored ? Number(stored.approved_ot_hours) : null
        ),
        /*
         * ADDITIONS AND DEDUCTIONS ARE NOT SUPPRESSED, and that is the point
         * of drawing the line where it is drawn. These six components are the
         * PAYRUN'S OWN inputs - somebody typed them into the adjustments
         * stage - and they are exactly as true while attendance is outstanding
         * as they will be afterwards. Blanking them would hide work that has
         * already been done.
         */
        additions: stored
          ? Number(stored.incentive) + Number(stored.bonus) + Number(stored.arrears)
          : null,
        deductions: stored
          ? Number(stored.advance_recovery) + Number(stored.shortage_recovery)
          : null,
        employee_pf: attendanceDependent(stored ? stored.employee_pf : null),
        employee_esi: attendanceDependent(stored ? stored.employee_esi : null),
        net_pay: attendanceDependent(stored ? stored.net_pay : null),
        /*
         * THE LIVE MONTHLY PAY TYPE, not the calculated one. They are the same
         * except in the window between somebody changing it and the employee
         * being recalculated - and in that window the row is
         * RECALCULATION_REQUIRED, which is what says so.
         */
        pay_type: employee.pay_type,
        calculated_pay_type: stored ? stored.pay_type : null,

        calculation_version: stored ? stored.calculation_version : null,
        calculation_revision: stored ? stored.calculation_revision : null,
        calculation_hash: stored ? stored.calculation_hash : null,
        calculated_at: stored ? stored.calculated_at : null,
        calculated_by: stored ? stored.calculated_by : null,
        approved_by: stored ? stored.approved_by : null,
        approved_at: stored ? stored.approved_at : null,
        locked_by: stored ? stored.locked_by : null,
        locked_at: stored ? stored.locked_at : null,
        published_by: stored ? stored.published_by ?? null : null,
        published_at: stored ? stored.published_at ?? null : null,
        unlocked_by: stored ? stored.unlocked_by ?? null : null,
        unlocked_at: stored ? stored.unlocked_at ?? null : null,
      },
    };
  }

  /**
   * THE MONTH: the initialized population, each one's status, and the counts.
   *
   * THE SUMMARY COUNTS THE WHOLE MONTH, NEVER THE FILTERED VIEW, exactly as
   * the initialization stage's does: a status filter is a way of looking at
   * the month, not a different month. On this screen the numbers are "how many
   * still need calculating" and "how many are ready to approve", which are the
   * two things somebody will act on.
   */
  async getMonth({ year, month, store_ids = null, status = null, card = null, search = null }) {
    const context = await this._assemble({ year, month, store_ids });
    const presented = context.population.map((employee) => this._present(context, employee));
    const rows = presented.map((p) => p.row);
    await this._attachPayslipStatus(context.period, rows);

    const wantedStatus =
      status && Object.values(CALC_STATUS).includes(String(status).toUpperCase())
        ? String(status).toUpperCase()
        : null;
    const text = search === null || search === undefined ? "" : String(search).trim().toLowerCase();
    /* A SUMMARY CARD - decided by the same `inCard` the card's count uses. */
    const wantedCard =
      card && Object.values(CALC_CARD).includes(String(card).toUpperCase())
        ? String(card).toUpperCase()
        : null;

    const filtered = rows.filter((row) => {
      if (wantedStatus && row.status !== wantedStatus) return false;
      if (wantedCard && !calc.inCard(row, wantedCard)) return false;
      if (text !== "") {
        const haystack = `${row.employee_name || ""} ${row.employee_id}`.toLowerCase();
        if (!haystack.includes(text)) return false;
      }
      return true;
    });

    return {
      period_year: context.period.year,
      period_month: context.period.month,
      month_locked: context.month_locked,
      calculation_version: CALCULATION_VERSION,
      summary: calc.summarize(rows),
      rows: filtered,
    };
  }

  /**
   * THE PAYSLIP COLUMNS: whether a payslip is published, the latest Telegram
   * notification and whether the employee has opened it. A row with no
   * ACTIVE payslip carries nulls; a published payslip with no attempt row is
   * NOT_ATTEMPTED. Never a figure, never a chat id.
   */
  async _attachPayslipStatus(period, rows) {
    rows.forEach((row) => {
      row.payslip = null;
    });
    if (!this.payslipRepo || rows.length === 0) return;
    const ids = rows.map((r) => r.employee_id);
    const slips = await this.payslipRepo.listMonthStatus({ year: period.year, month: period.month, employee_ids: ids });
    const byEmployee = new Map(slips.map((p) => [Number(p.employee_id), p]));
    rows.forEach((row) => {
      const p = byEmployee.get(Number(row.employee_id));
      if (!p || row.status !== CALC_STATUS.PUBLISHED) return;
      row.payslip = {
        payslip_version: Number(p.payslip_version),
        published_at: p.payslip_published_at,
        notification_status: p.notification_result || NOTIFICATION_RESULT.NOT_ATTEMPTED,
        notification_attempts: Number(p.notification_attempts || 0),
        notification_failure_code: p.notification_failure_code || null,
        notification_attempted_at: p.notification_attempted_at || null,
        viewed: Boolean(p.first_viewed_at),
        first_viewed_at: p.first_viewed_at || null,
        last_viewed_at: p.last_viewed_at || null,
      };
    });
  }

  /**
   * ONE EMPLOYEE'S FULL BREAKUP - salary, OT, adjustments, statutory, final.
   *
   * IT IS THE STORED CALCULATION AND NOT A FRESH ONE. Opening somebody's
   * detail must show what was calculated, down to the rupee, including when a
   * source has moved since - that is the case where the difference matters
   * most, and a screen that quietly recomputed would hide exactly the thing
   * the RECALCULATION_REQUIRED badge beside it is warning about.
   */
  async getEmployee({ year, month, employee_id, store_ids = null }) {
    const period = normalizeMonth(year, month);
    const ids = normalizeEmployeeIds([employee_id]);
    const context = await this._assemble({
      year: period.year,
      month: period.month,
      store_ids,
      employee_ids: ids,
    });

    const employee = context.population[0];
    if (!employee) {
      const err = new Error(
        "This employee has no initialized payrun for the selected month, or is outside your branch scope"
      );
      err.name = "NotFoundError";
      throw err;
    }

    const presented = this._present(context, employee);
    const stored = presented.internals.stored;

    /**
     * THE DRAWER FOLLOWS THE LIST'S RULE, through the same flag.
     *
     * "Why is it that number" is the question this screen answers, and while
     * the attendance month is not settled the honest answer to most of it is
     * "it is not that number yet". So every figure below that is arithmetic on
     * attendance reads as absent rather than as a confident zero: the salary
     * days and what they earned, the missing hours and their deduction, the
     * extra days, the whole of the overtime, the statutory WAGES and
     * contributions computed on them, and the totals built out of all of it.
     *
     * WHAT IS NOT SUPPRESSED, AND EACH FOR A REASON. The Monthly Gross and the
     * Daily Rate come from the salary snapshot and are true whatever
     * attendance does. The six adjustment components are the payrun's own
     * inputs, already entered by somebody. The pay type is a decision, not a
     * computation. The PF and ESI STATUSES and the ESI contribution-period
     * evidence say how the statutory questions were answered rather than what
     * they came to, which is precisely what somebody needs to see while
     * waiting. And `unresolved`/`errors` are the engine's open questions -
     * hiding those would hide the reasons.
     */
    const pending = presented.row.attendance_pending === true;
    const provisional = (value) => (pending ? null : value);

    return {
      period_year: period.year,
      period_month: period.month,
      ...presented.row,
      /*
       * THE BREAKUP, GROUPED THE WAY THE REVIEW SCREEN READS IT. Grouped on
       * the server rather than in the browser because the grouping IS the
       * explanation - which figures belong to salary, which to OT, which are
       * adjustments and which are statutory - and a browser that regrouped
       * them would be a second opinion about what a payslip line is.
       */
      breakup: stored
        ? {
            salary: {
              monthly_gross: stored.monthly_gross,
              daily_rate: stored.daily_rate,
              salary_days: provisional(stored.salary_days),
              salary_earnings: provisional(stored.salary_earnings),
              missing_hours_minutes: provisional(stored.missing_hours_minutes),
              missing_hours: provisional(
                Math.round((Number(stored.missing_hours_minutes) / 60) * 100) / 100
              ),
              missing_hours_deduction: provisional(stored.missing_hours_deduction),
              extra_days: provisional(stored.extra_days),
              extra_day_amount: provisional(stored.extra_day_amount),
            },
            ot: {
              approved_ot_hours: provisional(Number(stored.approved_ot_hours)),
              effective_nrm_minutes: provisional(stored.effective_nrm_minutes),
              effective_nrm_source: provisional(stored.effective_nrm_source),
              ot_hourly_rate: provisional(stored.ot_hourly_rate),
              ot_amount: provisional(stored.ot_amount),
              /**
               * THE PER-NRM BREAKDOWN THAT PRODUCED THE AMOUNT. One entry is
               * the ordinary case and says the same thing as the two fields
               * above; more than one is a month whose overtime was worked
               * against different NRMs, where those two fields are null and
               * this is the only honest account of the figure.
               */
              ot_groups: pending ? [] : this._json(stored.ot_groups),
              attendance_ot_earnings: provisional(stored.attendance_ot_earnings),
            },
            adjustments: {
              incentive: stored.incentive,
              bonus: stored.bonus,
              arrears: stored.arrears,
              advance_recovery: stored.advance_recovery,
              shortage_recovery: stored.shortage_recovery,
              /** INFORMATIONAL. It moves no figure above or below it. */
              balance_advance: stored.balance_advance,
            },
            statutory: {
              pf_status: stored.pf_status,
              pf_wage: provisional(stored.pf_wage),
              employee_pf: provisional(stored.employee_pf),
              employer_epf: provisional(stored.employer_epf),
              employer_eps: provisional(stored.employer_eps),
              employer_pf_total: provisional(stored.employer_pf_total),
              /*
               * THE EFFECTIVE-DATED PF CEILING EVIDENCE. NULL / empty on a
               * row calculated before version 3. `pf_segments` has two entries
               * for September 2026 (01-16 on 15,000, 17-30 on 25,000).
               */
              eps_wage: provisional(stored.eps_wage === undefined ? null : stored.eps_wage),
              edli_wage: provisional(stored.edli_wage === undefined ? null : stored.edli_wage),
              edli: provisional(stored.edli === undefined ? null : stored.edli),
              pf_admin_charge: provisional(stored.pf_admin_charge === undefined ? null : stored.pf_admin_charge),
              ncp_days: stored.ncp_days === undefined ? null : stored.ncp_days,
              pf_ceiling_version: stored.pf_ceiling_version || null,
              statutory_config_version: stored.statutory_config_version || null,
              pf_segments: pending ? [] : this._json(stored.pf_segments),
              pf_scenario: stored.pf_scenario || null,
              pf_exact: pending || !stored.pf_exact ? null : typeof stored.pf_exact === "string" ? JSON.parse(stored.pf_exact) : stored.pf_exact,
              esi_status: stored.esi_status,
              esi_wage: provisional(stored.esi_wage),
              esi_wage_basis: stored.esi_wage_basis,
              employee_esi: provisional(stored.employee_esi),
              employer_esi: provisional(stored.employer_esi),
              /**
               * HOW THE CONTRIBUTION-PERIOD QUESTION WAS ANSWERED. A
               * contribution charged on a wage above the ceiling is correct
               * when coverage continues from the period's entry, and this is
               * what lets the screen say so instead of looking like an error.
               */
              esi_period_start: stored.esi_period_start,
              esi_period_end: stored.esi_period_end,
              esi_coverage_entry_date: stored.esi_coverage_entry_date,
              esi_coverage_basis: stored.esi_coverage_basis,
              esi_contribution_period_continues:
                stored.esi_contribution_period_continues === null ||
                stored.esi_contribution_period_continues === undefined
                  ? null
                  : Number(stored.esi_contribution_period_continues) === 1,
            },
            final: {
              total_earnings: provisional(stored.total_earnings),
              total_employee_deductions: provisional(stored.total_employee_deductions),
              net_pay: provisional(stored.net_pay),
              // earnings - deductions + rounding = Net Pay. NULL before v2.
              net_pay_rounding: provisional(
                stored.net_pay_rounding === undefined ? null : stored.net_pay_rounding
              ),
              pay_type: stored.pay_type,
            },
            unresolved: this._json(stored.unresolved),
            errors: this._json(stored.errors),
          }
        : null,
    };
  }

  /** A JSON column, whichever way the driver handed it over. */
  _json(value) {
    if (value === null || value === undefined) return [];
    if (Array.isArray(value)) return value;
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      return [];
    }
  }

  /* ==================================================================== */
  /*  calculating                                                         */
  /* ==================================================================== */

  /**
   * CALCULATE OR RECALCULATE - one employee, a selection, or everybody
   * eligible, BY THE SAME PATH.
   *
   * THERE IS ONE IMPLEMENTATION AND `mode` ONLY DECIDES WHO IS IN SCOPE, for
   * the reason `usecase/payrun.js#initialize` gives about its own single/bulk
   * pair: two code paths doing the same thing is how one of them ends up
   * skipping a check. A first calculation and a recalculation produce the same
   * row from the same reads; what differs is that the second bumps the
   * revision, which the DATABASE does.
   *
   *   CALCULATE    the rows with no calculation yet. Already-calculated
   *                employees come back SKIPPED rather than being silently
   *                recomputed - "Calculate All Eligible" must not quietly
   *                redo two hundred employees somebody has already reviewed.
   *   RECALCULATE  the rows that HAVE one. It is the explicit act that a
   *                RECALCULATION_REQUIRED row is waiting for, and it is also
   *                allowed on a row that is merely stale in nobody's eyes -
   *                refreshing a calculation that has not drifted is harmless
   *                and produces the same figures.
   *
   * A LOCKED EMPLOYEE IS REFUSED, BY NAME, IN BOTH MODES. That is the first
   * thing the lock has to stop.
   *
   * ROW-LEVEL FAILURES ARE REPORTED, NEVER THROWN, and the rows that PASSED
   * are written in ONE transaction - the same pairing initialization uses. A
   * month always has somebody outstanding, so failing the batch would make
   * bulk calculation unusable on any real month.
   */
  async calculate({
    year,
    month,
    employee_ids,
    all_eligible = false,
    mode = "CALCULATE",
    store_ids = null,
    actor = {},
  }) {
    const period = normalizeMonth(year, month);
    const wanted = normalizeSelection({ employee_ids, all_eligible });
    const recalculating = String(mode).toUpperCase() === "RECALCULATE";

    const context = await this._assemble({
      year: period.year,
      month: period.month,
      store_ids,
      employee_ids: wanted.all ? null : wanted.ids,
    });

    if (context.month_locked) {
      throw validationError(
        `Payroll month ${period.year}-${String(period.month).padStart(2, "0")} is locked and cannot be calculated`
      );
    }

    const presentedById = new Map(
      context.population.map((employee) => {
        const p = this._present(context, employee);
        return [Number(employee.employee_id), p];
      })
    );

    /*
     * "ALL ELIGIBLE" IS DECIDED ON THE SERVER, FROM THE SERVER'S OWN READS,
     * and it means what the button says: in CALCULATE mode, everybody
     * initialized who has no calculation yet; in RECALCULATE mode, everybody
     * whose calculation a source has moved under. What a browser last saw may
     * be minutes old.
     */
    const targetIds = wanted.all
      ? [...presentedById.entries()]
          .filter(
            ([, p]) =>
              p.row.calculable &&
              (recalculating
                ? p.row.status === CALC_STATUS.RECALCULATION_REQUIRED
                : p.row.status === CALC_STATUS.NOT_CALCULATED)
          )
          .map(([id]) => id)
      : wanted.ids;

    const results = [];
    const toWrite = [];

    targetIds.forEach((employeeId) => {
      const presented = presentedById.get(Number(employeeId));
      if (!presented) {
        /*
         * NOT INITIALIZED FOR THIS MONTH, OR OUTSIDE THIS CALLER'S BRANCHES -
         * and the two are ONE outcome deliberately, for the reason
         * `usecase/payrun.js` records: telling a caller which of the two it
         * was would confirm the existence of an employee they may not see.
         */
        results.push({
          employee_id: employeeId,
          result: ROW_RESULT.NOT_IN_SCOPE,
          message:
            "This employee is not initialized for the selected month, or is outside your branch scope",
        });
        return;
      }

      if (isLockedStatus(presented.row.status)) {
        results.push({
          employee_id: employeeId,
          result: ROW_RESULT.LOCKED,
          message:
            "This employee's month is approved and locked. It cannot be recalculated.",
        });
        return;
      }

      const hasCalculation = presented.internals.stored !== null;
      if (!recalculating && hasCalculation) {
        results.push({
          employee_id: employeeId,
          result: ROW_RESULT.SKIPPED,
          message: "Already calculated. Use Recalculate to refresh it.",
        });
        return;
      }
      if (recalculating && !hasCalculation) {
        results.push({
          employee_id: employeeId,
          result: ROW_RESULT.SKIPPED,
          message: "Not calculated yet. Use Calculate first.",
        });
        return;
      }

      /*
       * THE SAME READINESS THE LIST SHOWED. An employee it does not pass is
       * refused here, by name and with the reasons, rather than counted as
       * eligible and then failing inside the calculation.
       */
      if (!presented.row.calculable) {
        const reasons =
          (presented.internals.readiness && presented.internals.readiness.reasons) ||
          (presented.row.statutory_hold ? [presented.row.statutory_hold] : []);
        results.push({
          employee_id: employeeId,
          result: ROW_RESULT.BLOCKED,
          blockers: reasons,
          message:
            reasons.map((r) => r.message).join("; ") ||
            "This employee's month cannot be calculated yet.",
        });
        return;
      }

      const built = this._buildRow(context, presented, actor);
      if (built.errors.length > 0 && built.fatal) {
        results.push({
          employee_id: employeeId,
          result: ROW_RESULT.FAILED,
          message: built.errors.join("; "),
        });
        return;
      }

      toWrite.push(built.row);
      results.push({
        employee_id: employeeId,
        result: recalculating ? ROW_RESULT.RECALCULATED : ROW_RESULT.CALCULATED,
        net_pay: built.result.net_pay,
        is_complete: built.result.is_complete,
        message: built.result.is_complete
          ? "Calculated"
          : "Calculated, with statutory questions left open. See the employee's detail.",
      });
    });

    if (toWrite.length > 0) await this.repo.saveCalculations(toWrite);

    const counted = (code) => results.filter((r) => r.result === code).length;
    return {
      period_year: period.year,
      period_month: period.month,
      mode: recalculating ? "RECALCULATE" : "CALCULATE",
      calculated_count: counted(ROW_RESULT.CALCULATED),
      recalculated_count: counted(ROW_RESULT.RECALCULATED),
      skipped_count: counted(ROW_RESULT.SKIPPED),
      locked_count: counted(ROW_RESULT.LOCKED),
      blocked_count: counted(ROW_RESULT.BLOCKED),
      failed_count: counted(ROW_RESULT.FAILED),
      not_in_scope_count: counted(ROW_RESULT.NOT_IN_SCOPE),
      results: targetIds.map((id) => results.find((r) => Number(r.employee_id) === Number(id))),
    };
  }

  /**
   * PROCESS ATTENDANCE - re-run the EXISTING attendance month persist for the
   * selected employees, from Payroll, where readiness says it would help.
   *
   * WHAT IT CALLS. `attendanceCalculationUsecase.calculateMonth({ persist:
   * true })` - the same call as Attendance > Recalculate for a month. It
   * recalculates the closed days from punches, approvals and shifts as they
   * stand, writes the derived day rows and the monthly summary with a fresh
   * fingerprint, and refuses a payroll-locked month itself. It reads OT and
   * attendance approvals; it decides, creates and changes none of them, and it
   * does not touch the salary, the payrun snapshot or any calculation.
   *
   * ONLY WHERE IT CAN HELP. An employee whose blockers are all ones processing
   * cannot clear (an undecided request, OT on a day with no NRM) is SKIPPED
   * with those reasons, not processed for show. Approved & Locked employees and
   * a locked month are refused before the engine is called.
   *
   * AFTERWARDS each processed employee's readiness is re-read, so the answer
   * says what (if anything) still stands in the way.
   */
  async processAttendance({ year, month, employee_ids, store_ids = null }) {
    const period = normalizeMonth(year, month);
    const ids = normalizeEmployeeIds(employee_ids);
    if (!this.attendanceProcessor || typeof this.attendanceProcessor.calculateMonth !== "function") {
      throw new Error("Attendance processing is not available");
    }

    const context = await this._assemble({
      year: period.year,
      month: period.month,
      store_ids,
      employee_ids: ids,
    });
    const presentedById = new Map(
      context.population.map((e) => [Number(e.employee_id), this._present(context, e)])
    );
    const monthLabel = `${period.year}-${String(period.month).padStart(2, "0")}`;

    const results = [];
    const processed = [];
    for (const employeeId of ids) {
      const presented = presentedById.get(employeeId);
      if (!presented) {
        results.push({
          employee_id: employeeId,
          result: ROW_RESULT.NOT_IN_SCOPE,
          message:
            "This employee is not initialized for the selected month, or is outside your branch scope",
        });
        continue;
      }
      const name = presented.row.employee_name;
      if (context.month_locked) {
        results.push({
          employee_id: employeeId,
          employee_name: name,
          result: ROW_RESULT.LOCKED,
          message: `Payroll month ${monthLabel} is locked. Its attendance cannot be reprocessed.`,
        });
        continue;
      }
      if (isLockedStatus(presented.row.status)) {
        results.push({
          employee_id: employeeId,
          employee_name: name,
          result: ROW_RESULT.LOCKED,
          message: "Payroll is Approved & Locked for this employee. Attendance cannot be reprocessed.",
        });
        continue;
      }
      const readiness = presented.internals.readiness;
      if (!readiness || !readiness.attendance_processable) {
        const remaining = readiness ? readiness.reasons.filter((r) => !r.processable) : [];
        results.push({
          employee_id: employeeId,
          employee_name: name,
          result: ROW_RESULT.SKIPPED,
          blockers: remaining,
          message:
            remaining.length > 0
              ? `Processing attendance would not clear this: ${remaining.map((r) => r.message).join("; ")}`
              : "Attendance is already processed and current.",
        });
        continue;
      }
      /* eslint-disable no-await-in-loop */
      try {
        await this.attendanceProcessor.calculateMonth({
          employee_id: employeeId,
          year: period.year,
          month: period.month,
          persist: true,
        });
        processed.push(employeeId);
        results.push({ employee_id: employeeId, employee_name: name, result: ROW_RESULT.PROCESSED });
      } catch (err) {
        results.push({
          employee_id: employeeId,
          employee_name: name,
          result: ROW_RESULT.FAILED,
          message: `Attendance could not be processed: ${err && err.message ? err.message : String(err)}`,
        });
      }
      /* eslint-enable no-await-in-loop */
    }

    if (processed.length > 0) {
      const after = await this._assemble({
        year: period.year,
        month: period.month,
        store_ids,
        employee_ids: processed,
      });
      after.population.forEach((e) => {
        const p = this._present(after, e);
        const entry = results.find((r) => r.employee_id === Number(e.employee_id));
        const reasons = (p.internals.readiness && p.internals.readiness.reasons) || [];
        entry.status = p.row.status;
        entry.calculable = p.row.calculable;
        entry.blockers = reasons;
        entry.message =
          reasons.length === 0
            ? "Attendance processed. Nothing in attendance now blocks payroll for this employee."
            : `Attendance processed. Still outstanding: ${reasons.map((r) => r.message).join("; ")}`;
      });
    }

    const counted = (code) => results.filter((r) => r.result === code).length;
    return {
      period_year: period.year,
      period_month: period.month,
      processed_count: counted(ROW_RESULT.PROCESSED),
      cleared_count: results.filter(
        (r) => r.result === ROW_RESULT.PROCESSED && (r.blockers || []).length === 0
      ).length,
      skipped_count: counted(ROW_RESULT.SKIPPED),
      locked_count: counted(ROW_RESULT.LOCKED),
      failed_count: counted(ROW_RESULT.FAILED),
      not_in_scope_count: counted(ROW_RESULT.NOT_IN_SCOPE),
      results,
    };
  }


  /**
   * ONE CALCULATION ROW, built key by key from the SERVER's own reads.
   *
   * Built key by key rather than spread from anything, for the same reason
   * `usecase/payrun.js#_snapshotRow` is: a spread carries whatever it was
   * handed, and the day something hands it a request body, a client-supplied
   * net pay is in the database. There is no key below that a client could
   * reach - not a figure, not a hash, not the actor.
   *
   * A RECALCULATION READS THE SOURCES AFRESH AND THE ADJUSTMENTS AS THEY
   * STAND. The six component amounts and the pay type come out of the LIVE
   * tables, not out of the previous calculation, which is how a recalculation
   * preserves them: it does not copy them forward and it does not clear them,
   * it simply reads the values the adjustments stage and the pay type stage
   * own. Nothing here writes either.
   */
  _buildRow(context, presented, actor) {
    const { employee, attendance, nrm, statutory, amounts, entrySalary } = presented.internals;

    const result = calc.computeCalculation({
      snapshot: employee,
      attendance: attendance || {},
      nrm,
      amounts,
      statutory,
      as_of: context.window.to,
      /*
       * THE APPROVED SALARY IN FORCE AT THE CONTRIBUTION PERIOD'S ENTRY DATE.
       * The server's own read, from the employee's own salary history, at a
       * date the salary engine named. The coverage rule itself is the engine's
       * and runs inside `computeCalculation`.
       */
      coverage_entry_salary: entrySalary,
      /*
       * THE DAY ROWS, so a month cut by a PF ceiling change places loss-of-pay
       * days in the period they fell in. Read in `_assemble` with everything
       * else; null when the repository cannot read them.
       */
      day_rows: context.dayRowsOf ? context.dayRowsOf.get(Number(employee.employee_id)) || [] : null,
    });

    const hash = calc.calculationHash(result);
    const markers = presented.internals.currentMarkers;

    return {
      result,
      errors: result.errors,
      /*
       * WHAT MAKES A FAILURE FATAL. A month with no gross and no basic cannot
       * be calculated at all and storing a row of nulls would put a zero net
       * pay on a screen; an approved OT that could not be priced is the same
       * class of error. An UNRESOLVED statutory question is NOT fatal - the
       * engine deliberately answers those with a named question rather than a
       * number, the row is stored carrying it, and the READY rules refuse to
       * let it be approved.
       */
      fatal: result.errors.length > 0,
      row: {
        payrun_employee_id: employee.payrun_employee_id,
        period_year: context.period.year,
        period_month: context.period.month,
        employee_id: Number(employee.employee_id),

        salary_id: markers.salary_id,
        salary_effective_from: markers.salary_effective_from,
        monthly_gross: result.monthly_gross,
        attendance_monthly_payroll_id: markers.attendance_monthly_payroll_id,
        attendance_payroll_version: markers.attendance_payroll_version,
        attendance_calculated_at: markers.attendance_calculated_at,
        effective_nrm_minutes: result.effective_nrm_minutes,
        effective_nrm_source: result.effective_nrm_source,
        pf_applicable: markers.pf_applicable,
        esi_applicable: markers.esi_applicable,

        source_hash: presented.internals.currentSourceHash,
        inputs_hash: presented.internals.currentInputsHash,

        daily_rate: result.daily_rate,
        salary_days: result.salary_days,
        salary_earnings: result.salary_earnings,
        missing_hours_minutes: result.missing_hours_minutes,
        missing_hours_deduction: result.missing_hours_deduction,
        extra_days: result.extra_days,
        extra_day_amount: result.extra_day_amount,

        approved_ot_minutes: result.approved_ot_minutes,
        approved_ot_hours: result.approved_ot_hours,
        ot_hourly_rate: result.ot_hourly_rate,
        ot_amount: result.ot_amount,
        ot_groups: JSON.stringify(result.ot_groups || []),
        attendance_ot_earnings: result.attendance_ot_earnings,

        incentive: result.incentive,
        bonus: result.bonus,
        arrears: result.arrears,
        advance_recovery: result.advance_recovery,
        shortage_recovery: result.shortage_recovery,
        balance_advance: result.balance_advance,

        pf_status: result.pf_status,
        pf_wage: result.pf_wage,
        employee_pf: result.employee_pf,
        employer_pf_total: result.employer_pf_total,
        employer_epf: result.employer_epf,
        employer_eps: result.employer_eps,
        eps_wage: result.eps_wage,
        edli_wage: result.edli_wage,
        edli: result.edli,
        pf_admin_charge: result.pf_admin_charge,
        ncp_days: result.ncp_days,
        pf_ceiling_version: result.pf_ceiling_version,
        statutory_config_version: result.statutory_config_version,
        pf_segments: JSON.stringify(result.pf_segments || []),
        pf_scenario: result.pf_scenario,
        statutory_setup_marker: markers.statutory_setup_marker,
        pf_exact: result.pf_exact ? JSON.stringify(result.pf_exact) : null,

        esi_status: result.esi_status,
        esi_wage: result.esi_wage,
        esi_wage_basis: result.esi_wage_basis,
        employee_esi: result.employee_esi,
        employer_esi: result.employer_esi,
        esi_period_start: result.esi_period_start,
        esi_period_end: result.esi_period_end,
        esi_coverage_entry_date: result.esi_coverage_entry_date,
        /*
         * THE RECORD COVERAGE WAS DECIDED FROM. `resolveContributionPeriodCoverage`
         * returns null for it in the opening-salary case - where the salary
         * being calculated IS the one in force at entry - which cannot arise
         * in a payrun, since a payrun always prices an already-approved
         * record. It is stored as it comes back either way.
         */
        esi_coverage_entry_salary_id: result.esi_coverage_entry_salary_id,
        /*
         * THE ENTRY RECORD'S GROSS, STORED BECAUSE IT IS A SOURCE MARKER AND
         * FOR NO OTHER REASON. It is taken from the marker set rather than
         * from the engine's answer, so the value compared on the next read is
         * byte for byte the value that was compared on this one - which is the
         * whole mechanism of stale detection, and the place where a value
         * marked but never stored would make every calculation read as stale
         * forever.
         */
        esi_coverage_entry_gross: markers.esi_coverage_entry_gross,
        esi_coverage_basis: result.esi_coverage_basis,
        esi_contribution_period_continues:
          result.esi_contribution_period_continues === null ||
          result.esi_contribution_period_continues === undefined
            ? null
            : result.esi_contribution_period_continues
            ? 1
            : 0,

        total_earnings: result.total_earnings,
        total_employee_deductions: result.total_employee_deductions,
        net_pay: result.net_pay,
        net_pay_rounding: result.net_pay_rounding,
        pay_type: result.pay_type,

        unresolved: JSON.stringify(result.unresolved || []),
        errors: JSON.stringify(result.errors || []),
        is_complete: result.is_complete ? 1 : 0,

        calculation_version: result.calculation_version,
        calculation_hash: hash,
        calculated_by: actor && actor.employeeId !== undefined ? actor.employeeId : null,
      },
    };
  }

  /* ==================================================================== */
  /*  approving and locking                                               */
  /* ==================================================================== */

  /**
   * APPROVE & LOCK - one employee, a selection, or everybody ready.
   *
   * THE READY RULE IS RE-DECIDED HERE, ON THE SERVER, FROM THE SERVER'S OWN
   * READS, never from what a browser last saw: initialized, calculated, no
   * source moved since, attendance complete, no pending regularization, no
   * pending OT, the adjustment stage complete for this employee, statutory
   * setup complete, the calculation itself complete, and not already locked.
   * An approval is the one act in this feature that cannot be taken back.
   *
   * BUT THAT VERDICT IS REACHED BEFORE THE ROW LOCK, and is therefore a
   * PRE-CHECK, not the final word. `_assemble` and `_present` run outside the
   * approval's transaction, so between them and the lock a source can still
   * move - in particular attendance, which an attendance write may rewrite
   * without touching this stage's row or its `calculation_hash` at all.
   *
   * THE FINAL VERIFICATION IS IN THE REPOSITORY, AFTER THE LOCK.
   * `repository/payrun_calculation.js#approve` re-reads the payrun row
   * `FOR UPDATE`, then RE-READS THE ATTENDANCE SOURCES on that same connection
   * inside that same transaction and compares them with the markers the stored
   * calculation carries. Only then does the status change. An employee whose
   * attendance moved in that window comes back `SOURCE_MOVED` and is reported
   * as BLOCKED with "recalculate, then approve" - never approved against
   * figures that no longer describe the month.
   *
   * The other clauses above remain pre-lock checks, which is sound because
   * each of them either cannot change without recalculating this row (whose
   * hash is compared under the lock) or is checked again by the guarded UPDATE
   * itself. Attendance is the one source another transaction can move
   * underneath a prepared approval, and it is the one re-read here.
   *
   * THE LOCK IS TAKEN ROW BY ROW IN THE DATABASE, under `FOR UPDATE` and a
   * guarded UPDATE - see `repository/payrun_calculation.js#approve`. Two
   * people approving at once produce one approval. Attendance writers take the
   * SAME row lock before modifying attendance, so the two stages serialize on
   * one key rather than racing.
   *
   * IT LOCKS EMPLOYEES, NOT THE MONTH. Everybody not in this call is exactly
   * as editable afterwards as before it.
   */
  async approve({ year, month, employee_ids, all_ready = false, mode = null, store_ids = null, actor = {} }) {
    const period = normalizeMonth(year, month);
    const wanted = normalizeSelection({ employee_ids, all_eligible: all_ready });

    const context = await this._assemble({
      year: period.year,
      month: period.month,
      store_ids,
      employee_ids: wanted.all ? null : wanted.ids,
    });

    const presentedById = new Map(
      context.population.map((employee) => [
        Number(employee.employee_id),
        this._present(context, employee),
      ])
    );

    const targetIds = wanted.all
      ? [...presentedById.entries()]
          .filter(([, p]) => p.row.status === CALC_STATUS.READY_FOR_APPROVAL)
          .map(([id]) => id)
      : wanted.ids;

    const results = [];
    const toApprove = [];

    targetIds.forEach((employeeId) => {
      const presented = presentedById.get(Number(employeeId));
      if (!presented) {
        results.push({
          employee_id: employeeId,
          result: ROW_RESULT.NOT_IN_SCOPE,
          message:
            "This employee is not initialized for the selected month, or is outside your branch scope",
        });
        return;
      }
      if (isLockedStatus(presented.row.status)) {
        results.push({
          employee_id: employeeId,
          result: ROW_RESULT.LOCKED,
          message: "Already approved and locked. Nothing was changed.",
        });
        return;
      }
      if (presented.row.status !== CALC_STATUS.READY_FOR_APPROVAL) {
        results.push({
          employee_id: employeeId,
          result: ROW_RESULT.BLOCKED,
          blockers: presented.row.blockers,
          recalculation_reasons: presented.row.recalculation_reasons,
          message: [...presented.row.blockers, ...presented.row.recalculation_reasons]
            .map((b) => b.message)
            .join("; "),
        });
        return;
      }
      toApprove.push({
        employee_id: Number(employeeId),
        /*
         * THE APPROVAL IS RECORDED AGAINST **THESE FIGURES**. The repository
         * refuses the approval if the row has been recalculated since this
         * request read it, rather than applying it to figures nobody looked
         * at.
         */
        calculation_hash: presented.row.calculation_hash,
      });
    });

    if (toApprove.length > 0) {
      const applied = await this.repo.approve({
        year: period.year,
        month: period.month,
        employees: toApprove,
        approved_by: actor && actor.employeeId !== undefined ? actor.employeeId : null,
        approved_by_user: actor && actor.userId !== undefined ? actor.userId : null,
        // Recorded on the lifecycle log: a row's own button, or a selection.
        mode:
          mode === "INDIVIDUAL" || mode === "BULK"
            ? mode
            : wanted.all || targetIds.length > 1
            ? "BULK"
            : "INDIVIDUAL",
      });
      applied.forEach((entry) => {
        if (entry.outcome === "APPROVED") {
          results.push({
            employee_id: entry.employee_id,
            result: ROW_RESULT.APPROVED,
            net_pay: entry.net_pay,
            calculation_hash: entry.calculation_hash,
            message: "Approved and locked",
          });
          return;
        }
        if (entry.outcome === "ALREADY_LOCKED") {
          results.push({
            employee_id: entry.employee_id,
            result: ROW_RESULT.LOCKED,
            message: "Already approved and locked. Nothing was changed.",
          });
          return;
        }
        if (entry.outcome === "SOURCE_MOVED") {
          /*
           * THE SOURCE MOVED WHILE THE APPROVAL WAS BEING MADE, and the
           * repository found it AFTER taking the row lock - which is the only
           * moment the answer is trustworthy. The calculation is stale: it
           * prices attendance that has since been rewritten, so it is not
           * approved and the month must be recalculated first.
           *
           * It is reported as BLOCKED, like every other "not approvable right
           * now" verdict, so no screen needs a new result code to render it.
           * The changed markers travel with it for the support case that asks
           * WHICH source moved.
           */
          results.push({
            employee_id: entry.employee_id,
            result: ROW_RESULT.BLOCKED,
            source_changed: entry.changed || [],
            message:
              "This employee's attendance changed after this calculation was prepared, so the figures are stale. " +
              "Recalculate this employee for the month, then approve.",
          });
          return;
        }
        if (entry.outcome === "ATTENDANCE_STALE") {
          /*
           * THE MONTHLY ATTENDANCE SUMMARY IS OLDER THAN ITS DAYS. A day was
           * rewritten after the month was last persisted - a permission
           * granted, approved or revoked, a correction or OT approval, a
           * voided punch, the daily recalculation - so the summary this
           * calculation priced still carries the old shortage or OT. Locking
           * it would pay figures the days no longer support, and a locked
           * month cannot be revisited. BLOCKED, with what to do.
           */
          results.push({
            employee_id: entry.employee_id,
            result: ROW_RESULT.BLOCKED,
            attendance_stale: entry.reason || "DAYS_CHANGED",
            message:
              entry.reason === "UNTRACKED"
                ? /*
                   * THE UPGRADE CONDITION, said as one. A summary stored before
                   * the fingerprint existed, or fingerprinted under an earlier
                   * FINGERPRINT_VERSION, is never trusted; storing the month
                   * once through the normal path gives it a current one.
                   */
                  "Attendance for this employee/month was calculated before attendance freshness tracking was " +
                  "introduced (or under an earlier tracking definition). Recalculate Attendance once (store this month's attendance), then recalculate Payroll " +
                  "before approving and locking."
                : "This employee's attendance days changed after the monthly attendance was calculated (for example a " +
                  "permission, correction or OT decision). Recalculate Attendance for this employee and month, " +
                  "recalculate payroll, then approve.",
          });
          return;
        }
        if (entry.outcome === "RECALCULATION_PENDING") {
          /*
           * A WORK SHIFT RULE CHANGED WHILE THIS MONTH WAS STILL OPEN, and
           * the recalculation it owes this employee has not finished. Locking
           * now would settle the month on figures the rule change supersedes,
           * and a locked month cannot be revisited - so the approval waits
           * for the recalculation instead, which is minutes at most.
           *
           * BLOCKED, like every other "not approvable right now" verdict, so
           * no screen needs a new result code. The run ids travel with it:
           * they are what the Recalculate Attendance screen shows, and a run
           * that FAILED is retried from there.
           */
          const runs = entry.pending_recalculations || [];
          const failed = runs.filter((r) => r.status === "FAILED" || r.status === "COMPLETED_WITH_ERRORS");
          results.push({
            employee_id: entry.employee_id,
            result: ROW_RESULT.BLOCKED,
            pending_recalculations: runs,
            message:
              failed.length > 0
                ? "A work shift rule changed and its attendance recalculation did not finish " +
                  `(run #${failed[0].run_id}). Retry it on Recalculate Attendance, then approve.`
                : "A work shift rule changed while this month was open and the attendance " +
                  `recalculation is still running (run #${runs[0] ? runs[0].run_id : "?"}). ` +
                  "Approve once it has completed.",
          });
          return;
        }
        results.push({
          employee_id: entry.employee_id,
          result: ROW_RESULT.BLOCKED,
          message:
            entry.outcome === "CALCULATION_MOVED"
              ? "This employee was recalculated while you were reviewing them. Re-read the month and approve again."
              : "This employee has no calculation for this month.",
        });
      });
    }

    const counted = (code) => results.filter((r) => r.result === code).length;
    return {
      period_year: period.year,
      period_month: period.month,
      approved_count: counted(ROW_RESULT.APPROVED),
      already_locked_count: counted(ROW_RESULT.LOCKED),
      blocked_count: counted(ROW_RESULT.BLOCKED),
      not_in_scope_count: counted(ROW_RESULT.NOT_IN_SCOPE),
      results: targetIds.map((id) => results.find((r) => Number(r.employee_id) === Number(id))),
    };
  }

  /** One employee's calculation and approval history for the month. */
  /**
   * RESET CALCULATION - return the selected employees to NOT CALCULATED.
   *
   * WHAT IT REMOVES: the employee's generated `payrun_employee_calculation`
   * row for THIS month, and nothing else. The snapshot, the adjustments, the
   * no-adjustment confirmation, the monthly pay type, the attendance close and
   * every source - salary, attendance, OT, requests, the master - stay exactly
   * as they are, so the next Calculate produces the month afresh from them.
   * That is structural: the repository method has no statement naming any of
   * those tables.
   *
   * EXPLICIT IDS ONLY. There is no "reset everybody" flag: a reset discards
   * somebody's reviewed figures, and it is done to the people somebody chose.
   *
   * THE SCOPE IS THE SERVER'S. The population is read through the caller's
   * branch scope, so an id outside it is NOT_IN_SCOPE whatever the body says,
   * and the month is the one in the request - every write names it.
   *
   * A MIXED BATCH IS NOT A FAILED BATCH. Each employee is decided and written
   * on their own; locked, not-calculated and out-of-scope employees are
   * reported beside the ones that were reset, and an unexpected failure on one
   * employee is reported as FAILED for that employee alone.
   */
  async reset({
    year,
    month,
    employee_ids,
    reason,
    remark = null,
    mode,
    store_ids = null,
    actor = {},
  }) {
    const period = normalizeMonth(year, month);
    const ids = normalizeEmployeeIds(employee_ids);

    const reasonCode = String(reason === null || reason === undefined ? "" : reason)
      .trim()
      .toUpperCase();
    if (!Object.values(RESET_REASON).includes(reasonCode)) {
      throw validationError(
        `A reset reason is required: one of ${Object.values(RESET_REASON).join(", ")}`
      );
    }
    const remarkText =
      remark === null || remark === undefined ? "" : String(remark).trim();
    if (reasonCode === RESET_REASON.OTHER && remarkText === "") {
      throw validationError("A remark is required when the reset reason is Other");
    }
    if (remarkText.length > RESET_REMARK_MAX) {
      throw validationError(`The remark must be at most ${RESET_REMARK_MAX} characters`);
    }

    const modeCode = String(mode === null || mode === undefined ? "" : mode)
      .trim()
      .toUpperCase();
    if (!Object.values(RESET_MODE).includes(modeCode)) {
      throw validationError(`mode must be one of ${Object.values(RESET_MODE).join(", ")}`);
    }
    if (modeCode === RESET_MODE.INDIVIDUAL && ids.length !== 1) {
      throw validationError("An individual reset names exactly one employee");
    }

    const context = await this._assemble({
      year: period.year,
      month: period.month,
      store_ids,
      employee_ids: ids,
    });
    const presentedById = new Map(
      context.population.map((employee) => [
        Number(employee.employee_id),
        this._present(context, employee),
      ])
    );
    const resetBy = actor && actor.employeeId !== undefined ? actor.employeeId : null;
    const monthLabel = `${period.year}-${String(period.month).padStart(2, "0")}`;

    const results = [];
    for (const employeeId of ids) {
      const presented = presentedById.get(employeeId);
      if (!presented) {
        results.push({
          employee_id: employeeId,
          result: ROW_RESULT.NOT_IN_SCOPE,
          message:
            "This employee is not initialized for the selected month, or is outside your branch scope",
        });
        continue;
      }
      const name = presented.row.employee_name;
      if (context.month_locked) {
        results.push({
          employee_id: employeeId,
          employee_name: name,
          result: ROW_RESULT.LOCKED,
          message: `Payroll month ${monthLabel} is locked. Its calculations cannot be reset.`,
        });
        continue;
      }
      if (isLockedStatus(presented.row.status)) {
        results.push({
          employee_id: employeeId,
          employee_name: name,
          result: ROW_RESULT.LOCKED,
          message: "Payroll is Approved & Locked for this employee. It cannot be reset.",
        });
        continue;
      }
      if (!RESETTABLE_STATUSES.includes(presented.row.status)) {
        results.push({
          employee_id: employeeId,
          employee_name: name,
          result: ROW_RESULT.SKIPPED,
          message: "Not calculated for this month. There is nothing to reset.",
        });
        continue;
      }

      /* eslint-disable no-await-in-loop */
      let applied;
      try {
        applied = await this.repo.resetCalculation({
          year: period.year,
          month: period.month,
          employee_id: employeeId,
          previous_status: presented.row.status,
          reason: reasonCode,
          remark: remarkText === "" ? null : remarkText,
          mode: modeCode,
          reset_by: resetBy,
        });
      } catch (err) {
        results.push({
          employee_id: employeeId,
          employee_name: name,
          result: ROW_RESULT.FAILED,
          message: "The reset could not be completed for this employee. Nothing was changed.",
        });
        continue;
      }
      /* eslint-enable no-await-in-loop */

      if (applied.outcome === "RESET") {
        results.push({
          employee_id: employeeId,
          employee_name: name,
          result: ROW_RESULT.RESET,
          previous_status: presented.row.status,
          message: "Calculation reset. The employee is ready to calculate again.",
        });
      } else if (applied.outcome === "NOT_CALCULATED") {
        results.push({
          employee_id: employeeId,
          employee_name: name,
          result: ROW_RESULT.SKIPPED,
          message: "Not calculated for this month. There is nothing to reset.",
        });
      } else if (applied.outcome === "MONTH_LOCKED") {
        results.push({
          employee_id: employeeId,
          employee_name: name,
          result: ROW_RESULT.LOCKED,
          message: `Payroll month ${monthLabel} is locked. Its calculations cannot be reset.`,
        });
      } else {
        results.push({
          employee_id: employeeId,
          employee_name: name,
          result: ROW_RESULT.LOCKED,
          message: "Payroll is Approved & Locked for this employee. It cannot be reset.",
        });
      }
    }

    const counted = (code) => results.filter((r) => r.result === code).length;
    return {
      period_year: period.year,
      period_month: period.month,
      mode: modeCode,
      reason: reasonCode,
      reset_count: counted(ROW_RESULT.RESET),
      skipped_count: counted(ROW_RESULT.SKIPPED),
      locked_count: counted(ROW_RESULT.LOCKED),
      failed_count: counted(ROW_RESULT.FAILED),
      not_in_scope_count: counted(ROW_RESULT.NOT_IN_SCOPE),
      results,
    };
  }

  /**
   * UNLOCK, PUBLISH, UNPUBLISH - one employee or a selection, each employee on
   * their own (a mixed selection is never a failed batch).
   *
   *   UNLOCK     Approved & Locked, not published -> back to calculated, with
   *              every figure kept until somebody recalculates. Published
   *              payroll is refused: Unpublish first. Reason required.
   *   PUBLISH    Approved & Locked -> Published: released for payslip / bank /
   *              downstream use. REFUSED when any source (salary, attendance,
   *              OT, NRM, statutory flags, adjustments, pay type) has moved
   *              since the month was calculated - a known outdated figure is
   *              never released; Unlock, recalculate and approve again.
   *   UNPUBLISH  Published -> Approved & Locked. Reason required.
   *
   * None of them writes a figure, a source, the snapshot or another employee:
   * the repository's single UPDATE per employee names only status, approval,
   * lock, unlock and publish columns of that employee's row. The branch scope
   * is the server's; the month is the request's and every write names it.
   */
  async lifecycle({ action, year, month, employee_ids, reason = null, remark = null, mode, store_ids = null, actor = {} }) {
    const period = normalizeMonth(year, month);
    const ids = normalizeEmployeeIds(employee_ids);
    if (![LIFECYCLE_ACTION.UNLOCK, LIFECYCLE_ACTION.PUBLISH, LIFECYCLE_ACTION.UNPUBLISH].includes(action)) {
      throw validationError("action must be UNLOCK, PUBLISH or UNPUBLISH");
    }
    const why = reason === null || reason === undefined ? "" : String(reason).trim();
    const note = remark === null || remark === undefined ? "" : String(remark).trim();
    if (action !== LIFECYCLE_ACTION.PUBLISH && why.length < LIFECYCLE_REASON_MIN) {
      throw validationError(`A reason of at least ${LIFECYCLE_REASON_MIN} characters is required`);
    }
    if (why.length > RESET_REMARK_MAX || note.length > RESET_REMARK_MAX) {
      throw validationError(`The reason and remark may be at most ${RESET_REMARK_MAX} characters each`);
    }
    const modeCode = String(mode || "").trim().toUpperCase();
    if (!Object.values(RESET_MODE).includes(modeCode)) {
      throw validationError(`mode must be one of ${Object.values(RESET_MODE).join(", ")}`);
    }
    if (modeCode === RESET_MODE.INDIVIDUAL && ids.length !== 1) {
      throw validationError("An individual action names exactly one employee");
    }

    const context = await this._assemble({ year: period.year, month: period.month, store_ids, employee_ids: ids });
    const presentedById = new Map(
      context.population.map((e) => [Number(e.employee_id), this._present(context, e)])
    );
    const monthLabel = `${period.year}-${String(period.month).padStart(2, "0")}`;
    if (action === LIFECYCLE_ACTION.PUBLISH && !this.payslipRepo) {
      throw new Error("Payslip publishing is not configured on this server");
    }
    // What the payslip needs beyond the payrun snapshot - read once, masked
    // inside the snapshot builder, and never returned to the caller.
    const extrasOf = new Map();
    let company = null;
    if (action === LIFECYCLE_ACTION.PUBLISH && presentedById.size > 0) {
      company = await this._payslipCompany();
      const extras = await this.payslipRepo.listEmployeeExtras([...presentedById.keys()]);
      extras.forEach((x) => extrasOf.set(Number(x.employee_id), x));
    }
    const DONE = {
      [LIFECYCLE_ACTION.UNLOCK]: [ROW_RESULT.UNLOCKED, "Unlocked. The figures are kept until the employee is recalculated."],
      [LIFECYCLE_ACTION.PUBLISH]: [ROW_RESULT.PUBLISHED, "Payslip published."],
      [LIFECYCLE_ACTION.UNPUBLISH]: [ROW_RESULT.UNPUBLISHED, "Payslip unpublished. It is no longer visible to the employee; the month is Approved & Locked again."],
    };
    const SKIP = {
      PUBLISHED: [ROW_RESULT.SKIPPED, "Skipped — already published. Unpublish it before unlocking."],
      ALREADY_PUBLISHED: [ROW_RESULT.SKIPPED, "Skipped — already published."],
      NOT_LOCKED: [ROW_RESULT.SKIPPED, "Skipped — not approved & locked."],
      NOT_PUBLISHED: [ROW_RESULT.SKIPPED, "Skipped — not published."],
      NOT_CALCULATED: [ROW_RESULT.SKIPPED, "Skipped — not calculated."],
      MONTH_LOCKED: [ROW_RESULT.LOCKED, `Payroll month ${monthLabel} is locked.`],
      SOURCE_MOVED: [ROW_RESULT.BLOCKED, "Not published — the attendance changed after this month was calculated. Unlock, recalculate and approve again."],
      CALCULATION_CHANGED: [ROW_RESULT.BLOCKED, "Not published — the calculation changed while publishing. Reload and try again."],
      ATTENDANCE_STALE: [ROW_RESULT.BLOCKED, "Not published — the attendance summary is not current with its days. Unlock, process attendance, recalculate and approve again."],
    };

    const results = [];
    for (const employeeId of ids) {
      const presented = presentedById.get(employeeId);
      if (!presented) {
        results.push({
          employee_id: employeeId,
          result: ROW_RESULT.NOT_IN_SCOPE,
          message: "This employee is not initialized for the selected month, or is outside your branch scope",
        });
        continue;
      }
      const name = presented.row.employee_name;
      const push = ([result, message], extra = {}) =>
        results.push({ employee_id: employeeId, employee_name: name, result, message, ...extra });
      if (context.month_locked) {
        push(SKIP.MONTH_LOCKED);
        continue;
      }
      const status = presented.row.status;
      if (action === LIFECYCLE_ACTION.UNLOCK && status === CALC_STATUS.PUBLISHED) {
        push(SKIP.PUBLISHED);
        continue;
      }
      if (action === LIFECYCLE_ACTION.UNPUBLISH && status !== CALC_STATUS.PUBLISHED) {
        push(isLockedStatus(status) ? SKIP.NOT_PUBLISHED : SKIP.NOT_LOCKED);
        continue;
      }
      if (action === LIFECYCLE_ACTION.PUBLISH && status === CALC_STATUS.PUBLISHED) {
        push(SKIP.ALREADY_PUBLISHED);
        continue;
      }
      if (action !== LIFECYCLE_ACTION.UNPUBLISH && status !== CALC_STATUS.APPROVED_LOCKED) {
        push(SKIP.NOT_LOCKED);
        continue;
      }
      if (action === LIFECYCLE_ACTION.PUBLISH) {
        /*
         * NEVER RELEASE A KNOWN OUTDATED FIGURE. A locked month's status does
         * not show staleness (nothing could be done about it while locked), so
         * Publish compares the stored markers with the sources as they are now.
         */
        const { stored, currentSourceHash, currentInputsHash, currentMarkers } = presented.internals;
        if (stored.source_hash !== currentSourceHash || stored.inputs_hash !== currentInputsHash) {
          const reasons = calc
            .detectChanges(calc.storedMarkers(stored), currentMarkers)
            .map((code) => calc.recalcReasonOf(code));
          push(
            [
              ROW_RESULT.BLOCKED,
              `Not published — ${
                reasons.map((r) => r.label.toLowerCase()).join(", ") ||
                (stored.inputs_hash !== currentInputsHash ? "adjustments or pay type changed" : "a source changed")
              } since this month was calculated. Unlock, recalculate and approve again.`,
            ],
            { recalculation_reasons: reasons }
          );
          continue;
        }
      }

      /*
       * THE PAYSLIP SNAPSHOT, FROM THE STORED APPROVED ROW. Nothing is
       * recalculated: `internals.stored` is the calculation exactly as it was
       * written. The repository re-checks the calculation id and hash under
       * the row lock, so this can only be published against those figures.
       */
      let payslip = null;
      if (action === LIFECYCLE_ACTION.PUBLISH) {
        try {
          const snapshot = payslipSnapshot.buildPayslipSnapshot({
            period,
            calculation: presented.internals.stored,
            employee: presented.internals.employee,
            extras: extrasOf.get(employeeId) || {},
            company,
          });
          const frozen = payslipSnapshot.freezeSnapshot(snapshot);
          payslip = {
            payslip_ref: crypto.randomBytes(16).toString("hex"),
            payrun_calculation_id: presented.internals.stored.payrun_calculation_id,
            calculation_hash: presented.internals.stored.calculation_hash,
            schema_version: SNAPSHOT_SCHEMA_VERSION,
            template_version: TEMPLATE_VERSION,
            text: frozen.text,
            sha256: frozen.sha256,
          };
        } catch (err) {
          if (err && err.name === "PayslipSnapshotError") {
            // A missing company detail is fixed in Company Details, not by
            // recalculating the employee.
            const fix = /^SNAPSHOT_COMPANY_/.test(err.code || "")
              ? "Add it in Master → Company Details and publish again."
              : "Unlock, recalculate and approve again.";
            push([ROW_RESULT.BLOCKED, `Not published — ${err.message}. ${fix}`], {
              error_code: err.code,
            });
            continue;
          }
          throw err;
        }
      }

      /* eslint-disable no-await-in-loop */
      try {
        const applied = await this.repo.lifecycle({
          action,
          year: period.year,
          month: period.month,
          employee_id: employeeId,
          reason: why || null,
          remark: note || null,
          mode: modeCode,
          actor,
          payslip,
        });
        if (applied.outcome === action) {
          push(DONE[action], {
            previous_status: applied.previous_status,
            new_status: applied.new_status,
            payslip_id: applied.payslip_id || null,
          });
        }
        else push(SKIP[applied.outcome] || [ROW_RESULT.BLOCKED, `Not changed (${applied.outcome}).`]);
      } catch (err) {
        push([ROW_RESULT.FAILED, "This employee could not be changed. Nothing was changed for them."]);
      }
      /* eslint-enable no-await-in-loop */
    }

    /*
     * THE NOTIFICATIONS ARE ALREADY QUEUED - attempt 1 was inserted in each
     * publishing transaction. The worker is kicked and NOT awaited: one slow
     * or failed Telegram send can neither hold up nor roll back a
     * publication, and this request returns with publication results only.
     */
    const notification = { queued: 0 };
    if (action === LIFECYCLE_ACTION.PUBLISH) {
      results.forEach((r) => {
        if (r.result === ROW_RESULT.PUBLISHED && r.payslip_id) {
          r.notification_status = NOTIFICATION_RESULT.QUEUED;
          notification.queued += 1;
        }
      });
      if (notification.queued > 0 && this.notifier) this.notifier.kick();
    }

    const counted = (code) => results.filter((r) => r.result === code).length;
    return {
      period_year: period.year,
      period_month: period.month,
      action,
      mode: modeCode,
      notification,
      done_count: counted(DONE[action][0]),
      unlocked_count: counted(ROW_RESULT.UNLOCKED),
      published_count: counted(ROW_RESULT.PUBLISHED),
      unpublished_count: counted(ROW_RESULT.UNPUBLISHED),
      skipped_count: counted(ROW_RESULT.SKIPPED),
      blocked_count: counted(ROW_RESULT.BLOCKED),
      locked_count: counted(ROW_RESULT.LOCKED),
      failed_count: counted(ROW_RESULT.FAILED),
      not_in_scope_count: counted(ROW_RESULT.NOT_IN_SCOPE),
      results,
    };
  }

  /**
   * PUBLISH ALL APPROVED PAYSLIPS. Who is approved and not yet published is
   * decided here, from the server's own read of the month inside the caller's
   * branch scope - never from a list a browser sent. Each employee is then
   * published on their own, exactly as a selection would be.
   */
  async publishAllApproved({ year, month, store_ids = null, actor = {} }) {
    const period = normalizeMonth(year, month);
    const context = await this._assemble({ year: period.year, month: period.month, store_ids });
    const ids = context.population
      .map((e) => this._present(context, e).row)
      .filter((row) => row.status === CALC_STATUS.APPROVED_LOCKED)
      .map((row) => Number(row.employee_id));
    if (ids.length === 0) {
      return {
        period_year: period.year,
        period_month: period.month,
        action: LIFECYCLE_ACTION.PUBLISH,
        mode: RESET_MODE.BULK,
        notification: { queued: 0 },
        done_count: 0,
        published_count: 0,
        skipped_count: 0,
        blocked_count: 0,
        locked_count: 0,
        failed_count: 0,
        not_in_scope_count: 0,
        results: [],
      };
    }
    return this.lifecycle({
      action: LIFECYCLE_ACTION.PUBLISH,
      year: period.year,
      month: period.month,
      employee_ids: ids,
      mode: RESET_MODE.BULK,
      store_ids,
      actor,
    });
  }

  /**
   * RETRY NOTIFICATION - queue the "payslip available" message again for
   * published payslips whose last attempt did not reach the employee.
   *
   * IT NEVER REPUBLISHES. No payroll row, no payslip and no snapshot is
   * written: each retry queues one more append-only attempt (trigger RETRY)
   * for the worker. Skipped: already notified, a notification already queued
   * or sending, not published, outside the caller's branch scope.
   */
  async retryNotification({ year, month, employee_ids, store_ids = null, actor = {} }) {
    const period = normalizeMonth(year, month);
    const ids = normalizeEmployeeIds(employee_ids);
    if (!this.payslipRepo || !this.notifier) {
      throw new Error("Payslip notifications are not configured on this server");
    }
    const context = await this._assemble({ year: period.year, month: period.month, store_ids, employee_ids: ids });
    const presentedById = new Map(
      context.population.map((e) => [Number(e.employee_id), this._present(context, e).row])
    );
    const slips = await this.payslipRepo.listMonthStatus({
      year: period.year,
      month: period.month,
      employee_ids: [...presentedById.keys()],
    });
    const slipOf = new Map(slips.map((p) => [Number(p.employee_id), p]));
    const PENDING = [NOTIFICATION_RESULT.QUEUED, NOTIFICATION_RESULT.SENDING];

    const results = [];
    for (const employeeId of ids) {
      const row = presentedById.get(employeeId);
      if (!row) {
        results.push({
          employee_id: employeeId,
          result: ROW_RESULT.NOT_IN_SCOPE,
          message: "This employee is not initialized for the selected month, or is outside your branch scope",
        });
        continue;
      }
      const slip = slipOf.get(employeeId);
      const base = { employee_id: employeeId, employee_name: row.employee_name };
      if (row.status !== CALC_STATUS.PUBLISHED || !slip) {
        results.push({ ...base, result: ROW_RESULT.SKIPPED, message: "Skipped — payslip not published." });
        continue;
      }
      if (slip.notification_result === NOTIFICATION_RESULT.SENT) {
        results.push({ ...base, result: ROW_RESULT.SKIPPED, message: "Skipped — already notified." });
        continue;
      }
      if (PENDING.includes(slip.notification_result)) {
        results.push({ ...base, result: ROW_RESULT.SKIPPED, message: "Skipped — a notification is already queued." });
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const queued = await this.payslipRepo.enqueueRetry({
        payslip_id: slip.payslip_id,
        employee_id: employeeId,
        requested_by: actor.employeeId === undefined ? null : actor.employeeId,
        requested_by_user: actor.userId === undefined ? null : actor.userId,
      });
      if (queued.queued) {
        results.push({ ...base, result: ROW_RESULT.QUEUED, notification_status: NOTIFICATION_RESULT.QUEUED, message: "Notification queued." });
      } else {
        results.push({ ...base, result: ROW_RESULT.SKIPPED, message: "Skipped — a notification is already queued." });
      }
    }
    const counted = (code) => results.filter((r) => r.result === code).length;
    if (counted(ROW_RESULT.QUEUED) > 0) this.notifier.kick();
    return {
      period_year: period.year,
      period_month: period.month,
      queued_count: counted(ROW_RESULT.QUEUED),
      skipped_count: counted(ROW_RESULT.SKIPPED),
      not_in_scope_count: counted(ROW_RESULT.NOT_IN_SCOPE),
      results,
    };
  }

  /**
   * ADMIN VIEW PAYSLIP - the ACTIVE frozen snapshot of one employee month,
   * its version history and its notification attempts. Branch scope first:
   * an employee outside the caller's branches is a 404 like a missing one.
   * The snapshot's integrity hash is verified before it is returned.
   */
  async getPayslip({ year, month, employee_id, store_ids = null }) {
    const period = normalizeMonth(year, month);
    const ids = normalizeEmployeeIds([employee_id]);
    const notFound = (msg) => {
      const err = new Error(msg);
      err.name = "NotFoundError";
      return err;
    };
    if (!this.payslipRepo) throw notFound("Payslips are not configured on this server");
    const inScope = await this.repo.listInitialized({
      year: period.year,
      month: period.month,
      store_ids,
      employee_ids: ids,
    });
    if (inScope.length === 0) {
      throw notFound("This employee has no initialized payrun for the selected month, or is outside your branch scope");
    }
    const versions = await this.payslipRepo.listVersions({ year: period.year, month: period.month, employee_id: ids[0] });
    const active = await this.payslipRepo.getActiveForMonth({ year: period.year, month: period.month, employee_id: ids[0] });
    if (!active) {
      return { period_year: period.year, period_month: period.month, employee_id: ids[0], payslip: null, versions };
    }
    const snapshot = payslipSnapshot.readFrozenSnapshot(active.snapshot_json, active.snapshot_sha256);
    const notifications = await this.payslipRepo.listNotifications(active.payslip_id);
    return {
      period_year: period.year,
      period_month: period.month,
      employee_id: ids[0],
      payslip: {
        payslip_version: Number(active.payslip_version),
        template_version: active.template_version,
        snapshot_sha256: active.snapshot_sha256,
        published_by: active.published_by,
        published_at: active.published_at,
        first_viewed_at: active.first_viewed_at,
        last_viewed_at: active.last_viewed_at,
        view_count: Number(active.view_count || 0),
        snapshot,
      },
      notifications,
      versions,
    };
  }

  /**
   * THE EPFO 2026 WAGE CEILING REVISION - THE AFFECTED-EMPLOYEE REPORT.
   *
   * READ-ONLY. Three SELECTs - the September 2026 population, the approved
   * salary in force on 30-09-2026 and the statutory context - and a pure
   * classification (`utils/pf_ceiling_impact.js`). Nothing is written, no
   * employee is enrolled and no flag is changed: it is the list a person
   * reviews BEFORE September's payroll is run.
   */
  async getPfCeilingImpact({ store_ids = null } = {}) {
    const population = await this.payrunRepo.listPopulation({ year: 2026, month: 9, store_ids });
    const ids = population.map((r) => Number(r.employee_id));
    const [salaries, statutory] = await Promise.all([
      this.payrunRepo.listApprovedSalaries(ids, "2026-09-30"),
      this.repo.listStatutoryContext(ids),
    ]);
    const first = (rows) => {
      const map = new Map();
      (rows || []).forEach((r) => {
        if (!map.has(Number(r.employee_id))) map.set(Number(r.employee_id), r);
      });
      return map;
    };
    const salaryOf = first(salaries);
    const statutoryOf = first(statutory);
    const rows = population.map((p) => {
      const id = Number(p.employee_id);
      const sal = salaryOf.get(id) || {};
      const st = statutoryOf.get(id) || {};
      return {
        employee_id: id,
        employee_name: p.employee_name,
        store_name: p.store_name,
        date_of_joining: p.date_of_joining,
        resignation_date: p.resignation_date,
        dob: st.dob || null,
        monthly_gross: sal.monthly_gross === undefined ? null : sal.monthly_gross,
        basic: sal.basic === undefined ? null : sal.basic,
        pf_applicable: p.pf_applicable,
        pf_applicable_from: st.pf_applicable_from || null,
        pf_contribution_basis: st.pf_contribution_basis || null,
        uan: p.uan,
        previous_pf_member: st.previous_pf_member === undefined ? null : st.previous_pf_member,
        previous_eps_member: st.previous_eps_member === undefined ? null : st.previous_eps_member,
      };
    });
    return pfCeilingImpact.assessPopulation(rows);
  }

  /**
   * THE ECR FOR ONE MONTH, FROM THE STORED CALCULATIONS. READ-ONLY.
   *
   * One line per member; September 2026 is one ECR with each member's two
   * periods already summed in the stored calculation. Members that cannot be
   * filed (pending PF, missing UAN, incomplete, not approved) are returned in
   * `errors` and left out of the file - see `utils/epfo_ecr.js`.
   */
  async getEcr({ year, month, store_ids = null }) {
    const period = normalizeMonth(year, month);
    const population = await this.repo.listInitialized({ year: period.year, month: period.month, store_ids });
    const ids = population.map((r) => Number(r.employee_id));
    const [calculations, statutory] = await Promise.all([
      this.repo.listCalculations({ year: period.year, month: period.month, employee_ids: ids }),
      this.repo.listStatutoryContext(ids),
    ]);
    const calcOf = new Map((calculations || []).map((c) => [Number(c.employee_id), c]));
    /*
     * THE UAN IS THE MEMBER'S CURRENT ONE. The month's snapshot froze the
     * UAN at initialization; one HR records afterwards (an existing member
     * whose UAN was missing in DNDS) is the same member's identity, so the
     * live value is used when the snapshot has none. Figures are never taken
     * from anywhere but the stored, APPROVED calculation.
     */
    const liveUan = new Map((statutory || []).map((r) => [Number(r.employee_id), r.uan]));
    const ecr = epfoEcr.buildEcr({
      rows: population.map((employee) => {
        const snap = String(employee.uan || "").trim();
        const uan = snap !== "" ? employee.uan : liveUan.get(Number(employee.employee_id)) || null;
        return { employee: { ...employee, uan }, calculation: calcOf.get(Number(employee.employee_id)) || null };
      }),
      // APPROVED PAYROLL ONLY - there is no preview of an unapproved month.
      require_approved: true,
    });
    const validation = ecr.members
      .map((m) => ({ employee_id: m.employee_id, problems: epfoEcr.validateEcrMember(m) }))
      .filter((v) => v.problems.length > 0);
    return { period, ...ecr, validation };
  }

  async getHistory({ year, month, employee_id }) {
    const period = normalizeMonth(year, month);
    const ids = normalizeEmployeeIds([employee_id]);
    return this.repo.listAudit({
      year: period.year,
      month: period.month,
      employee_id: ids[0],
    });
  }

  /**
   * WHICH OF THESE EMPLOYEES' MONTHS ARE LOCKED - the question the OTHER
   * stages ask this one.
   *
   * IT LIVES HERE BECAUSE THE LOCK DOES. The adjustments stage and the pay
   * type change both have to refuse a locked employee, and the alternative -
   * each of them reading `payrun_employee_calculation` itself - would be three
   * places that know what locked means and three chances for one of them to
   * check the wrong column.
   */
  async listLockedEmployeeIds({ year, month, employee_ids = null }) {
    const period = normalizeMonth(year, month);
    return this.repo.listLockedEmployeeIds({
      year: period.year,
      month: period.month,
      employee_ids,
    });
  }
}

module.exports = (calculationRepo, payrunRepo, adjustmentRepo) =>
  new PayrunCalculationUsecase(calculationRepo, payrunRepo, adjustmentRepo);
module.exports.PayrunCalculationUsecase = PayrunCalculationUsecase;
module.exports.normalizeSelection = normalizeSelection;
module.exports.CALC_STATUS = CALC_STATUS;
module.exports.ROW_RESULT = ROW_RESULT;
module.exports.STORED_STATUS = STORED_STATUS;
module.exports.ADJUSTMENT_STATE = ADJUSTMENT_STATE;
module.exports.COMPONENT_KEYS = COMPONENT_KEYS;
