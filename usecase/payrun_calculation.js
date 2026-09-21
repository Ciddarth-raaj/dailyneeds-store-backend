const { PERIOD_STATUS } = require("../constants/payrun");
const { ADJUSTMENT_STATE, COMPONENT_KEYS } = require("../constants/payrun_adjustments");
const {
  CALC_STATUS,
  CALCULATION_VERSION,
  ROW_RESULT,
  STORED_STATUS,
} = require("../constants/payrun_calculation");
const { monthWindow, statutorySetupComplete } = require("../utils/payrun_eligibility");
const { deriveState } = require("../utils/payrun_adjustments");
const calc = require("../utils/payrun_calculation");
const engine = require("../utils/salary_engine");
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

    const verdict = calc.deriveStatus({
      calculation: stored
        ? {
            status: stored.status,
            source_hash: stored.source_hash,
            inputs_hash: stored.inputs_hash,
            is_complete: Number(stored.is_complete) === 1,
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
      statutory_setup_complete: statutorySetupComplete(employee),
      /*
       * THE ACCEPTED ATTENDANCE BASIS, read from the snapshot rather than
       * inferred from anything on this screen. It satisfies the attendance
       * part of approval readiness and nothing else - see `deriveStatus`.
       */
      attendance_closed_for_payroll:
        Number(employee.attendance_closed_for_payroll) === 1,
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
      },
      row: {
        employee_id: id,
        payrun_employee_id: employee.payrun_employee_id,
        employee_name: employee.employee_name,
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
         * WHETHER THE ATTENDANCE THESE FIGURES WERE PRICED FROM IS SETTLED.
         *
         * SENT AS A FACT ON THE ROW rather than left to a browser to infer
         * from the blocker list, so the rule that decides which figures may be
         * presented as results lives in one place and cannot be re-derived
         * slightly differently on a phone.
         */
        attendance_pending: verdict.attendance_pending,
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
  async getMonth({ year, month, store_ids = null, status = null, search = null }) {
    const context = await this._assemble({ year, month, store_ids });
    const presented = context.population.map((employee) => this._present(context, employee));
    const rows = presented.map((p) => p.row);

    const wantedStatus =
      status && Object.values(CALC_STATUS).includes(String(status).toUpperCase())
        ? String(status).toUpperCase()
        : null;
    const text = search === null || search === undefined ? "" : String(search).trim().toLowerCase();

    const filtered = rows.filter((row) => {
      if (wantedStatus && row.status !== wantedStatus) return false;
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
          .filter(([, p]) =>
            recalculating
              ? p.row.status === CALC_STATUS.RECALCULATION_REQUIRED
              : p.row.status === CALC_STATUS.NOT_CALCULATED
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

      if (presented.row.status === CALC_STATUS.APPROVED_LOCKED) {
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
      failed_count: counted(ROW_RESULT.FAILED),
      not_in_scope_count: counted(ROW_RESULT.NOT_IN_SCOPE),
      results: targetIds.map((id) => results.find((r) => Number(r.employee_id) === Number(id))),
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
  async approve({ year, month, employee_ids, all_ready = false, store_ids = null, actor = {} }) {
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
      if (presented.row.status === CALC_STATUS.APPROVED_LOCKED) {
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
