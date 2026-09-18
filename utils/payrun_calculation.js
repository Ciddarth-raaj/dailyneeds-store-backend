const crypto = require("crypto");

const CONFIG = require("../config/statutory");
const engine = require("../utils/salary_engine");
const { computeContract } = require("./payrun_adjustments");
const { COMPONENT } = require("../constants/payrun_adjustments");
const { ADJUSTMENT_STATE } = require("../constants/payrun_adjustments");
const {
  CALCULATION_VERSION,
  CALC_STATUS,
  CALC_STATUS_LABEL,
  RECALC_REASON,
  RECALC_REASON_LABEL,
  RECALC_REASON_MESSAGE,
  READY_BLOCKER,
  READY_BLOCKER_LABEL,
  READY_BLOCKER_MESSAGE,
  NRM_SOURCE,
} = require("../constants/payrun_calculation");

/**
 * Payrun Calculation & Review - every rule, and all of them pure.
 *
 * THE SAME DIVISION `utils/payrun_eligibility.js` AND
 * `utils/payrun_adjustments.js` KEEP. Nothing in this file touches a database,
 * a request or a clock. It takes plain objects and returns plain objects, so
 * every rule below is provable by `node --test` without a MySQL connection -
 * and a rule that needs a database to be exercised is a rule that gets
 * exercised once, by hand, in a browser.
 *
 * ============================================================ WHAT IT DOES
 *
 * IT CONSUMES; IT DOES NOT RE-DERIVE. This is the rule the whole stage is
 * built on, and it is worth stating as a list of what this file will NOT do:
 *
 *   it does not read a punch, a shift or a minute of attendance. Salary Days,
 *   Extra Days, Missing Hours and the Missing Hours Deduction arrive already
 *   computed by `utils/attendance_payroll.js` and stored in
 *   `attendance_monthly_payroll`, and they are USED as they arrive
 *
 *   it does not decide which OT is approved. Only `approved_ot_minutes` -
 *   the one column the attendance engine says payroll may read - reaches it
 *
 *   it does not resolve an NRM from the shift master. Attendance has already
 *   resolved the employee-specific value, override and all, and this file
 *   consumes that answer
 *
 *   it does not implement PF or ESI. `utils/salary_engine.js` is the statutory
 *   authority and is called, unchanged, for both
 *
 *   it does not decide what an adjustment does. `computeContract` in
 *   `utils/payrun_adjustments.js` is the V1 calculation contract and is called
 *
 * WHAT IS GENUINELY THIS FILE'S OWN, then, is small and is exactly what the
 * payrun was missing: the OT price, the statutory BASES (which of the
 * components the earned month is charged on), the net pay identity, and the
 * two hashes that let a stored calculation notice that the world moved.
 *
 * MONEY IS HELD IN INTEGER PAISE, for the reason every money module in this
 * repository gives: adding 0.1 and 0.2 in floating point gives
 * 0.30000000000000004, and a month built by adding a dozen such numbers across
 * six hundred employees drifts by rupees.
 */

/* ------------------------------------------------------------------ money */

/** Rupees (or a numeric string) to integer paise. NULL stays NULL, never 0. */
function toPaise(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/** Integer paise back to a rupee number with two decimals. */
function toRupees(paise) {
  return paise === null || paise === undefined ? null : Math.round(paise) / 100;
}

/** Paise, or zero. For the places where an absent figure genuinely IS nothing. */
const paiseOr0 = (value) => {
  const p = toPaise(value);
  return p === null ? 0 : p;
};

const intOr0 = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
};

/* ------------------------------------------------------- the effective NRM */

/**
 * THE EMPLOYEE'S EFFECTIVE NRM FOR THE MONTH, AND WHERE IT CAME FROM.
 *
 * WHAT IS BEING ANSWERED. OT is priced per HOUR, so the month needs one hourly
 * rate, so it needs one NRM. Attendance resolves an NRM per DATE - it has to,
 * because a shortage on a 12-hour day is worth less per minute than one on an
 * 8-hour day - and this rolls those per-date answers up into the one figure
 * the OT rate is built from.
 *
 * THE INPUT IS ALREADY-GROUPED ATTENDANCE, never a shift row. Each group is
 * `{ nrm_minutes, break_allowance_source, day_count, approved_ot_minutes }` as
 * the repository read them out of `attendance_day_calculation`. THE SHIFT
 * MASTER IS NOT CONSULTED ANYWHERE IN THIS STAGE: attendance has already
 * applied the employee's lunch/break override (`special_break_override_minutes`)
 * and reading the master again would be a second answer that disagrees with
 * the one the month was actually calculated on.
 *
 * WHICH GROUP WINS, and the order is the rule:
 *
 *   1. the group carrying the most APPROVED OT MINUTES. This is the NRM that
 *      the overtime was actually worked against, and overtime is the only
 *      thing the monthly NRM is used to price. Pricing a month's OT on an NRM
 *      from days that carry no OT would be arithmetic about the wrong days.
 *   2. failing that - nobody has any approved OT - the group covering the most
 *      DAYS, which is the employee's ordinary working pattern for the month.
 *   3. ties break towards the LARGER NRM, deliberately. A larger NRM is a
 *      lower hourly rate; where the month is genuinely ambiguous, the payrun
 *      does not resolve the ambiguity in the direction of paying more.
 *
 * THE SOURCE IS THE WINNING GROUP'S OWN, so an employee whose override applies
 * to the days their OT was worked on reports EMPLOYEE_OVERRIDE and everybody
 * else reports SHIFT. That is what makes two employees on one shift able to
 * have different OT rates, and makes the row say why.
 *
 * ZERO-NRM GROUPS ARE DROPPED. An NRM of zero is a rest day or a
 * misconfigured schedule; it cannot price an hour and dividing by it is how a
 * payroll screen ends up showing Infinity.
 */
function resolveEffectiveNrm(groups = []) {
  const usable = (groups || [])
    .map((g) => ({
      nrm_minutes: intOr0(g.nrm_minutes),
      source:
        String(g.break_allowance_source || NRM_SOURCE.SHIFT).toUpperCase() ===
        NRM_SOURCE.EMPLOYEE_OVERRIDE
          ? NRM_SOURCE.EMPLOYEE_OVERRIDE
          : NRM_SOURCE.SHIFT,
      day_count: intOr0(g.day_count),
      approved_ot_minutes: intOr0(g.approved_ot_minutes),
    }))
    .filter((g) => g.nrm_minutes > 0);

  if (usable.length === 0) {
    return { nrm_minutes: null, nrm_source: null };
  }

  const anyOt = usable.some((g) => g.approved_ot_minutes > 0);
  const weight = (g) => (anyOt ? g.approved_ot_minutes : g.day_count);

  const winner = usable.reduce((best, g) => {
    if (best === null) return g;
    if (weight(g) !== weight(best)) return weight(g) > weight(best) ? g : best;
    // The tie-break: the larger NRM, which is the lower hourly rate.
    return g.nrm_minutes > best.nrm_minutes ? g : best;
  }, null);

  return {
    nrm_minutes: winner.nrm_minutes,
    nrm_source: winner.source,
    /*
     * REPORTED SO A SCREEN CAN SAY THE MONTH WAS NOT UNIFORM. It changes no
     * figure - the winning NRM above is what prices the OT - but "this
     * employee worked two different shift lengths this month" is the first
     * thing somebody asks when an OT rate looks unfamiliar.
     */
    nrm_is_mixed: usable.length > 1,
  };
}

/* ------------------------------------------------- the source fingerprints */

/** A stable string for a value, so two equal inputs hash equal. */
const mark = (value) =>
  value === null || value === undefined || value === "" ? "" : String(value);

/**
 * THE SOURCE MARKERS - the identity of everything OUTSIDE the payrun that this
 * calculation consumed.
 *
 * IDS AND VERSIONS RATHER THAN AMOUNTS, wherever the source has one. The
 * salary is identified by `salary_id` because an approved `employee_salary`
 * row is immutable; the attendance month by its id, its `payroll_version` and
 * its `calculated_at`, because those are exactly what the engine bumps when it
 * re-runs. `monthly_gross` is carried as well - not because the id is
 * insufficient, but because a marker set that a human cannot read is a marker
 * set nobody can debug.
 *
 * `approved_ot_minutes` AND THE EFFECTIVE NRM ARE MARKERS IN THEIR OWN RIGHT,
 * even though both come from attendance. An OT approval granted after the
 * month was calculated changes the minutes without necessarily re-running the
 * monthly roll-up, and an NRM that moved because somebody set a break override
 * changes the OT rate with no other visible effect. Both are things the
 * specification names as sources, so both are watched by name.
 */
function sourceMarkers({
  salary = {},
  attendance = {},
  nrm = {},
  statutory = {},
} = {}) {
  return {
    salary_id: salary.salary_id ?? null,
    salary_effective_from: salary.effective_from ?? salary.salary_effective_from ?? null,
    monthly_gross: salary.monthly_gross ?? null,

    attendance_monthly_payroll_id: attendance.attendance_monthly_payroll_id ?? null,
    attendance_payroll_version: attendance.payroll_version ?? null,
    attendance_calculated_at: attendance.calculated_at ?? null,

    approved_ot_minutes: attendance.approved_ot_minutes ?? null,

    effective_nrm_minutes: nrm.nrm_minutes ?? null,
    effective_nrm_source: nrm.nrm_source ?? null,

    pf_applicable: statutory.pf_applicable ?? null,
    esi_applicable: statutory.esi_applicable ?? null,
  };
}

/** An md5 over the markers, in a fixed key order. The order is the contract. */
function hashOf(parts) {
  const text = parts.map(mark).join("|");
  return crypto.createHash("md5").update(text).digest("hex");
}

const SOURCE_KEYS = [
  "salary_id",
  "salary_effective_from",
  "monthly_gross",
  "attendance_monthly_payroll_id",
  "attendance_payroll_version",
  "attendance_calculated_at",
  "approved_ot_minutes",
  "effective_nrm_minutes",
  "effective_nrm_source",
  "pf_applicable",
  "esi_applicable",
];

function sourceHash(markers = {}) {
  return hashOf(SOURCE_KEYS.map((key) => markers[key]));
}

/**
 * THE PAYRUN'S OWN INPUTS, HASHED SEPARATELY FROM THE SOURCES.
 *
 * TWO HASHES AND NOT ONE, and the separation is the point. A salary revision
 * moving under a frozen month is a SOURCE changing; an incentive being entered
 * is somebody deliberately working this payrun. Both make the stored net pay
 * stale and both must stop an approval - but they are different events, they
 * are reported with different reason codes, and merging them into one hash
 * would make every screen say "a source changed" when what actually happened
 * is that a colleague typed a bonus.
 *
 * THE PAY TYPE IS IN HERE because the calculation stores it: the approved,
 * locked record has to say how the money was to travel, and a pay type changed
 * after calculation would otherwise be a locked record that disagrees with the
 * month beside it.
 */
function inputsHash({ amounts = {}, pay_type = null } = {}) {
  const contract = computeContract(amounts);
  return hashOf([
    contract.by_component[COMPONENT.INCENTIVE],
    contract.by_component[COMPONENT.BONUS],
    contract.by_component[COMPONENT.ARREARS],
    contract.by_component[COMPONENT.ADVANCE_RECOVERY],
    contract.by_component[COMPONENT.SHORTAGE_RECOVERY],
    contract.by_component[COMPONENT.BALANCE_ADVANCE],
    pay_type,
  ]);
}

/**
 * HAS ANYTHING THIS CALCULATION CONSUMED MOVED SINCE?
 *
 * MARKER BY MARKER, NOT HASH AGAINST HASH, and that is deliberate even though
 * the hashes alone would answer the yes/no. "Something changed" is not
 * actionable: somebody looking at forty stale employees needs to know whether
 * a salary revision landed, attendance was re-run, or OT approvals came
 * through overnight, because those are three different conversations with
 * three different people. The hash is what the DATABASE stores and compares
 * cheaply; this is what the SCREEN says.
 *
 * A MISSING STORED CALCULATION IS NOT A CHANGE. It is "not calculated", which
 * is a different status entirely - see `deriveStatus`.
 */
function detectChanges(stored = {}, current = {}) {
  const reasons = [];
  const differs = (key) => mark(stored[key]) !== mark(current[key]);

  if (differs("salary_id") || differs("salary_effective_from") || differs("monthly_gross")) {
    reasons.push(RECALC_REASON.SALARY_CHANGED);
  }
  if (
    differs("attendance_monthly_payroll_id") ||
    differs("attendance_payroll_version") ||
    differs("attendance_calculated_at")
  ) {
    reasons.push(RECALC_REASON.ATTENDANCE_CHANGED);
  }
  if (differs("approved_ot_minutes")) reasons.push(RECALC_REASON.APPROVED_OT_CHANGED);
  if (differs("effective_nrm_minutes") || differs("effective_nrm_source")) {
    reasons.push(RECALC_REASON.EFFECTIVE_NRM_CHANGED);
  }
  if (differs("pf_applicable") || differs("esi_applicable")) {
    reasons.push(RECALC_REASON.STATUTORY_CONTEXT_CHANGED);
  }
  return reasons;
}

/** A reason, in the three lengths the screens need. See `constants/payrun.js`. */
function recalcReasonOf(code) {
  return {
    code,
    label: RECALC_REASON_LABEL[code] || code,
    message: RECALC_REASON_MESSAGE[code] || code,
  };
}

function blockerOf(code) {
  return {
    code,
    label: READY_BLOCKER_LABEL[code] || code,
    message: READY_BLOCKER_MESSAGE[code] || code,
  };
}

/* ==================================================== THE CALCULATION ITSELF */

/**
 * ONE EMPLOYEE'S MONTH, CALCULATED.
 *
 * @param {object} input
 * @param {object} input.snapshot     the `payrun_employee` row - the month's salary
 *                                    structure, the statutory flags and the
 *                                    pay type FROZEN at initialization
 * @param {object} input.attendance   the stored `attendance_monthly_payroll`
 *                                    row. CONSUMED, never re-derived
 * @param {object} input.nrm          `resolveEffectiveNrm`'s answer
 * @param {object} input.amounts      the six adjustment component amounts
 * @param {object} input.statutory    dob / previous_eps_member / applicability,
 *                                    as `repository/employee_salary.js#getStatutoryContext`
 *                                    returns them
 * @param {string} input.as_of        the month end, for the age and period rules
 * @param {object} [config]           the statutory configuration
 *
 * @returns {object} every figure the review screen and the payslip need, plus
 *                   `unresolved` - the statutory questions the engine refused
 *                   to answer with a plausible-looking number
 */
function computeCalculation(input = {}, config = CONFIG) {
  const {
    snapshot = {},
    attendance = {},
    nrm = {},
    amounts = {},
    statutory = {},
    as_of = null,
  } = input;

  const errors = [];
  const unresolved = [];

  /* ------------------------------------------------------------- SALARY */

  const grossPaise = toPaise(snapshot.monthly_gross);
  if (grossPaise === null) {
    errors.push("No approved monthly gross is recorded on this month's snapshot");
  }

  /*
   * PER-DAY SALARY = MONTHLY GROSS / 26, AND IT IS THE SALARY ENGINE'S
   * `dailySalary` RATHER THAN A DIVISION WRITTEN HERE. The 26 is
   * `config.salary.salaryDaysPerMonth` and it is a configured business
   * constant; a `/ 26` in this file would be a second copy of it, and the day
   * it is configured differently the payrun and the Salary Master would price
   * the same person's day differently.
   */
  const dailyRate = grossPaise === null ? null : engine.dailySalary(snapshot.monthly_gross, config);
  const dailyRatePaise = toPaise(dailyRate);

  /*
   * THE DAY COUNTS AND THE SALARY MONEY ARE THE ATTENDANCE ENGINE'S, TAKEN AS
   * THEY ARE. Salary Days, Extra Days, the shortage minutes and the deduction
   * are read out of the stored month; none of them is recomputed here, and
   * there is deliberately no `salary_days * daily_rate` in this file for the
   * earnings either - `salary_day_earnings` is what the engine priced and
   * re-multiplying it here would be a second answer that rounds differently.
   */
  const salaryDays = intOr0(attendance.salary_days);
  const extraDays = intOr0(attendance.extra_days);
  const salaryEarningsPaise = paiseOr0(attendance.salary_day_earnings);
  const extraDayAmountPaise = paiseOr0(attendance.extra_day_earnings);
  const missingMinutes = intOr0(attendance.shortage_minutes);
  const missingDeductionPaise = paiseOr0(attendance.missing_minute_deduction);

  /* ----------------------------------------------------------------- OT */

  /*
   * ONLY APPROVED OT ENTERS PAYROLL. `approved_ot_minutes` is the one overtime
   * column the attendance engine says payroll may read - candidate, raw and
   * pre/post-shift minutes are worth nothing until somebody approves them -
   * and it is the only one this file names.
   */
  const approvedOtMinutes = intOr0(attendance.approved_ot_minutes);
  const nrmMinutes = nrm && nrm.nrm_minutes ? intOr0(nrm.nrm_minutes) : null;
  const approvedOtHours = Math.round((approvedOtMinutes / 60) * 10000) / 10000;

  /*
   * OT HOURLY RATE = PER-DAY SALARY / EFFECTIVE NRM (in hours), and OT AMOUNT
   * = APPROVED HOURS x THAT RATE. Unrounded through the multiplication and
   * rounded once at the end, so an employee with thirty OT hours does not
   * carry thirty rounding errors.
   *
   * THE NRM IS THE EMPLOYEE'S EFFECTIVE ONE and never the shift master's - see
   * `resolveEffectiveNrm`. Where no NRM could be resolved the OT is reported
   * as an amount that could not be priced rather than as zero: a zero is an
   * employee quietly not paid for approved overtime, which is the kind of
   * error nobody notices until they complain.
   */
  let otHourlyRatePaise = null;
  let otAmountPaise = 0;
  if (approvedOtMinutes > 0) {
    if (dailyRatePaise === null || nrmMinutes === null || nrmMinutes <= 0) {
      errors.push(
        "Approved OT cannot be priced: no effective NRM was resolved from this employee's attendance for the month"
      );
    } else {
      const perHour = dailyRatePaise / (nrmMinutes / 60);
      otHourlyRatePaise = Math.round(perHour);
      otAmountPaise = Math.round((approvedOtMinutes / 60) * perHour);
    }
  } else if (dailyRatePaise !== null && nrmMinutes !== null && nrmMinutes > 0) {
    // No overtime, but the rate is still reported - somebody reviewing the
    // month should be able to see what an hour would have cost.
    otHourlyRatePaise = Math.round(dailyRatePaise / (nrmMinutes / 60));
  }

  /* -------------------------------------------------------- ADJUSTMENTS */

  /*
   * THE V1 CONTRACT IS CALLED, NOT REIMPLEMENTED. Which of the six are
   * additions, which are deductions, which is informational and what each does
   * to a PF or ESI wage is `utils/payrun_adjustments.js#computeContract`'s
   * answer, and that module exists precisely so this stage does not decide it
   * a second time.
   */
  const contract = computeContract(amounts);
  const incentivePaise = paiseOr0(contract.by_component[COMPONENT.INCENTIVE]);
  const bonusPaise = paiseOr0(contract.by_component[COMPONENT.BONUS]);
  const arrearsPaise = paiseOr0(contract.by_component[COMPONENT.ARREARS]);
  const advanceRecoveryPaise = paiseOr0(contract.by_component[COMPONENT.ADVANCE_RECOVERY]);
  const shortageRecoveryPaise = paiseOr0(contract.by_component[COMPONENT.SHORTAGE_RECOVERY]);
  const balanceAdvancePaise = paiseOr0(contract.by_component[COMPONENT.BALANCE_ADVANCE]);

  const additionsPaise = incentivePaise + bonusPaise + arrearsPaise;
  const deductionsFromNetPaise = advanceRecoveryPaise + shortageRecoveryPaise;

  /* ------------------------------------------------------------- THE PF */

  /*
   * PF WAGE = EARNED BASIC FOR SALARY DAYS ONLY.
   *
   * THE EARNED RATIO IS SALARY DAYS OVER THE 26-DAY BASIS, which is the same
   * basis the Per-Day Salary is built on. It is deliberately not salary days
   * over the month's `base_days`: those vary between 24 and 27 with the length
   * of the calendar month, and pricing a contribution on them would make
   * February and March charge different PF on identical attendance.
   *
   * EVERY EXCLUSION IS BY CONSTRUCTION RATHER THAN BY SUBTRACTION. Extra Days,
   * OT, Incentive, Bonus and Arrears are simply never added into this base -
   * there is no line below that adds them and then takes them away again - and
   * the recoveries and the Balance Advance cannot reach it either, because a
   * recovery of money somebody was already paid is not a change to what they
   * earned.
   *
   * THE CONTRIBUTION ITSELF IS `salary_engine.calculatePf`'s, unchanged: the
   * ceiling, the employee rate, the employer 12% and its EPF/EPS split on the
   * age and cutoff rules are the statutory engine's and are not restated here.
   */
  const salaryDaysPerMonth = Math.max(1, Number(config.salary.salaryDaysPerMonth) || 26);
  const earnedRatio = Math.min(salaryDays / salaryDaysPerMonth, 1);
  const earnedBasicPaise =
    toPaise(snapshot.basic) === null ? null : Math.round(toPaise(snapshot.basic) * earnedRatio);

  let pf = {
    status: engine.STATUS.NOT_APPLICABLE,
    pf_wage: 0,
    employee_pf: 0,
    employer_pf_total: 0,
    employer_epf: 0,
    employer_eps: 0,
    unresolved: [],
  };
  if (earnedBasicPaise === null) {
    errors.push("No Basic is recorded on this month's snapshot, so PF cannot be calculated");
  } else {
    pf = engine.calculatePf(
      {
        basic: toRupees(earnedBasicPaise),
        pf_applicable: snapshot.pf_applicable,
        dob: statutory.dob ?? null,
        date_of_joining: snapshot.date_of_joining ?? statutory.date_of_joining ?? null,
        previous_eps_member: statutory.previous_eps_member ?? null,
        as_of,
      },
      config
    );
    (pf.unresolved || []).forEach((u) => unresolved.push({ ...u, stage: "pf" }));
  }

  /* ------------------------------------------------------------ THE ESI */

  /*
   * THE ESI WAGE IS ELIGIBLE NORMAL SALARY EARNINGS ONLY.
   *
   * NORMAL SALARY EARNINGS = SALARY DAY EARNINGS - MISSING HOURS DEDUCTION.
   * Extra Days, OT, Incentive, Bonus and Arrears are excluded, and again by
   * construction: none of them appears in the remuneration handed to the wage
   * definition below.
   *
   * THE DEDUCTION COMES OFF THE WAGE because it is not a deduction from pay in
   * the recovery sense - it is minutes the employee did not work, so it is
   * remuneration that was never earned, and charging a contribution on it
   * would charge one on wages nobody received.
   *
   * THE DEFINITION IS THE CODE'S AND IS THE SALARY ENGINE'S. `statutoryWages`
   * applies the Code on Social Security exclusions and the 50% proviso to the
   * EARNED components, so HRA and Conveyance come out in the same proportion
   * they were earned in; the result is handed to `calculateEsi` as a supplied
   * PAYROLL wage, which is the path that engine already documents for exactly
   * this caller.
   */
  const normalEarningsPaise = Math.max(0, salaryEarningsPaise - missingDeductionPaise);
  const earned = (value) => {
    const p = toPaise(value);
    return p === null ? null : toRupees(Math.round(p * earnedRatio));
  };
  const wageDefinition = engine.statutoryWages(
    {
      basic: earned(snapshot.basic),
      conveyance: earned(snapshot.conveyance),
      hra: earned(snapshot.hra),
      special_allowance: earned(snapshot.special_allowance),
    },
    toRupees(normalEarningsPaise),
    config
  );

  const esi = engine.calculateEsi(
    {
      esi_applicable: snapshot.esi_applicable,
      esi_wage: wageDefinition === null ? null : wageDefinition.statutory_wages,
    },
    config
  );
  (esi.unresolved || []).forEach((u) => unresolved.push({ ...u, stage: "esi" }));

  /* ----------------------------------------------------------- THE TOTALS */

  const employeePfPaise = toPaise(pf.employee_pf);
  const employeeEsiPaise = toPaise(esi.employee_esi);

  if (employeePfPaise === null) errors.push("Employee PF is unresolved for this employee");
  if (employeeEsiPaise === null) errors.push("Employee ESI is unresolved for this employee");

  /*
   * THE NET PAY IDENTITY, WRITTEN ONCE, IN THE ORDER THE CONTRACT STATES IT.
   *
   *   Salary Earnings
   * + Extra Day Earnings
   * - Missing Hours Deduction
   * + Approved OT Amount
   * + Incentive + Bonus + Arrears
   * - Employee PF
   * - Employee ESI
   * - Advance Recovery - Shortage Recovery
   *
   * THE BALANCE ADVANCE IS NOT IN IT AND CANNOT BE. It never becomes a
   * variable in this arithmetic: it is read above only so the screen and the
   * eventual payslip can print the employee's remaining advance balance.
   */
  const totalEarningsPaise =
    salaryEarningsPaise + extraDayAmountPaise + otAmountPaise + additionsPaise;

  const totalEmployeeDeductionsPaise =
    missingDeductionPaise +
    (employeePfPaise || 0) +
    (employeeEsiPaise || 0) +
    deductionsFromNetPaise;

  const netPayPaise = totalEarningsPaise - totalEmployeeDeductionsPaise;

  return {
    calculation_version: CALCULATION_VERSION,

    /* -------------------------------------------------------- SALARY */
    monthly_gross: toRupees(grossPaise),
    daily_rate: toRupees(dailyRatePaise),
    salary_days: salaryDays,
    salary_earnings: toRupees(salaryEarningsPaise),
    missing_hours_minutes: missingMinutes,
    missing_hours: Math.round((missingMinutes / 60) * 100) / 100,
    missing_hours_deduction: toRupees(missingDeductionPaise),
    extra_days: extraDays,
    extra_day_amount: toRupees(extraDayAmountPaise),

    /* ------------------------------------------------------------ OT */
    approved_ot_minutes: approvedOtMinutes,
    approved_ot_hours: approvedOtHours,
    effective_nrm_minutes: nrmMinutes,
    effective_nrm_source: nrm ? nrm.nrm_source ?? null : null,
    effective_nrm_is_mixed: nrm ? nrm.nrm_is_mixed === true : false,
    ot_hourly_rate: toRupees(otHourlyRatePaise),
    ot_amount: toRupees(otAmountPaise),
    /*
     * WHAT ATTENDANCE PRICED THE SAME OVERTIME AT, CARRIED FOR RECONCILIATION
     * AND USED FOR NOTHING. The attendance engine prices OT per DATE, on that
     * date's NRM and that weekday's OT multiplier; the payrun prices it once,
     * on the month's effective NRM, with no multiplier, because that is the
     * agreed Daily Needs contract. The two are allowed to differ and the
     * difference is visible rather than silent.
     */
    attendance_ot_earnings: attendance.approved_ot_earnings ?? null,

    /* --------------------------------------------------- ADJUSTMENTS */
    incentive: toRupees(incentivePaise),
    bonus: toRupees(bonusPaise),
    arrears: toRupees(arrearsPaise),
    advance_recovery: toRupees(advanceRecoveryPaise),
    shortage_recovery: toRupees(shortageRecoveryPaise),
    /** INFORMATIONAL. Zero effect on every figure above and below it. */
    balance_advance: toRupees(balanceAdvancePaise),
    additions_total: toRupees(additionsPaise),
    deductions_total: toRupees(deductionsFromNetPaise),

    /* ----------------------------------------------------- STATUTORY */
    pf_status: pf.status,
    pf_wage: pf.pf_wage,
    employee_pf: pf.employee_pf,
    employer_pf_total: pf.employer_pf_total,
    employer_epf: pf.employer_epf,
    employer_eps: pf.employer_eps,

    esi_status: esi.status,
    esi_wage: esi.esi_wage,
    esi_wage_basis: esi.esi_wage_basis ?? null,
    employee_esi: esi.employee_esi,
    employer_esi: esi.employer_esi,
    esi_wage_definition: wageDefinition,

    /* --------------------------------------------------------- FINAL */
    total_earnings: toRupees(totalEarningsPaise),
    total_employee_deductions: toRupees(totalEmployeeDeductionsPaise),
    net_pay: toRupees(netPayPaise),
    pay_type: snapshot.pay_type ?? null,

    /*
     * THE QUESTIONS THE ENGINE REFUSED TO ANSWER WITH A NUMBER, and the ones
     * that stopped it outright. `unresolved` is the statutory engine's own
     * vocabulary passed through; `errors` is this stage's. An employee with
     * either cannot be approved - see `deriveStatus` - because approving a
     * month with an unresolved contribution in it is a filing error that
     * nobody notices for a year.
     */
    unresolved,
    errors,
    is_complete: errors.length === 0 && unresolved.length === 0,
  };
}

/* ======================================================== THE STATUS RULES */

/**
 * WHICH OF THE FIVE STATES ONE INITIALIZED EMPLOYEE IS IN, and everything
 * standing between them and approval.
 *
 * THE ORDER IS THE RULE, and every line of it matters:
 *
 *   1. LOCKED BEATS EVERYTHING. An approved employee is APPROVED_LOCKED
 *      whatever has happened to their sources since - that is what locking
 *      means. A salary back-dated into a locked month does not turn it into
 *      RECALCULATION_REQUIRED, because there is nothing anybody may do about
 *      it until the future unlock path exists.
 *   2. NO CALCULATION AT ALL IS `NOT_CALCULATED`, not "stale".
 *   3. A MOVED SOURCE OR A MOVED PAYRUN INPUT IS `RECALCULATION_REQUIRED`, and
 *      it OUTRANKS ready-ness: an employee whose salary changed this morning
 *      is not ready to approve merely because nothing else is outstanding.
 *   4. OTHERWISE, EVERY READY RULE IS CHECKED, and an employee with no blocker
 *      left is READY_FOR_APPROVAL. With one, they are CALCULATED and the
 *      blockers say what to go and do.
 *
 * THE SOURCE CHANGE IS NEVER APPLIED SILENTLY. Nothing in this function, and
 * nothing anywhere in this stage, recalculates an employee because a source
 * moved: the stored figures stay exactly as they were computed, the status
 * says they no longer match the world, and a person decides. That is the whole
 * requirement, and it is why detection and recalculation are separate acts.
 */
function deriveStatus(input = {}) {
  const {
    calculation = null,
    current_source_hash = null,
    current_inputs_hash = null,
    attendance = null,
    pending_regularizations = 0,
    pending_ot = 0,
    adjustment_state = null,
    statutory_setup_complete = true,
  } = input;

  const blockers = [];
  const recalcReasons = [];

  if (calculation && calculation.status === CALC_STATUS.APPROVED_LOCKED) {
    return {
      status: CALC_STATUS.APPROVED_LOCKED,
      status_label: CALC_STATUS_LABEL[CALC_STATUS.APPROVED_LOCKED],
      blockers: [blockerOf(READY_BLOCKER.ALREADY_LOCKED)],
      recalculation_reasons: [],
      /*
       * THE PAYSLIP ELIGIBILITY CONTRACT, AND IT IS DERIVED RATHER THAN
       * STORED. `payslip_eligible` is true for exactly the employees whose
       * month is APPROVED_LOCKED and false for everybody else, so there is no
       * column that can disagree with the lock it is supposed to describe.
       *
       * IT IS PER EMPLOYEE, WHICH IS THE POINT. One employee approved out of
       * six hundred is one employee eligible for a payslip; the rest of the
       * month being unfinished has nothing to do with it.
       */
      payslip_eligible: true,
    };
  }

  if (!calculation) {
    blockers.push(blockerOf(READY_BLOCKER.NOT_CALCULATED));
    return {
      status: CALC_STATUS.NOT_CALCULATED,
      status_label: CALC_STATUS_LABEL[CALC_STATUS.NOT_CALCULATED],
      blockers,
      recalculation_reasons: [],
      payslip_eligible: false,
    };
  }

  const sourceMoved =
    current_source_hash !== null && calculation.source_hash !== current_source_hash;
  const inputsMoved =
    current_inputs_hash !== null && calculation.inputs_hash !== current_inputs_hash;

  if (sourceMoved || inputsMoved) {
    (input.change_reasons || []).forEach((code) => recalcReasons.push(recalcReasonOf(code)));
    if (recalcReasons.length === 0) {
      /*
       * THE HASH SAYS SOMETHING MOVED AND THE MARKER COMPARISON NAMED NOTHING.
       * That is possible only for the payrun's own inputs, whose markers are
       * not compared field by field, so the honest answer is the one that is
       * true either way rather than an empty list that reads as "no reason".
       */
      recalcReasons.push(
        recalcReasonOf(inputsMoved ? RECALC_REASON.ADJUSTMENTS_CHANGED : RECALC_REASON.SALARY_CHANGED)
      );
    }
    blockers.push(blockerOf(READY_BLOCKER.RECALCULATION_REQUIRED));
    return {
      status: CALC_STATUS.RECALCULATION_REQUIRED,
      status_label: CALC_STATUS_LABEL[CALC_STATUS.RECALCULATION_REQUIRED],
      blockers,
      recalculation_reasons: recalcReasons,
      payslip_eligible: false,
    };
  }

  /*
   * THE READY RULES. Every one of them is re-decided here, from the state of
   * the world at the moment of the request, and NONE of them is read from a
   * stored flag - a stored "ready" is a flag that goes stale the moment a
   * regularization is raised.
   */
  if (!attendance || !(attendance.is_final === 1 || attendance.is_final === true)) {
    blockers.push(blockerOf(READY_BLOCKER.ATTENDANCE_INCOMPLETE));
  }
  if (Number(pending_regularizations) > 0) {
    blockers.push(blockerOf(READY_BLOCKER.PENDING_ATTENDANCE_REGULARIZATION));
  }
  if (Number(pending_ot) > 0) {
    blockers.push(blockerOf(READY_BLOCKER.PENDING_OT_APPROVAL));
  }
  /*
   * THE ADJUSTMENT STAGE MUST BE COMPLETE FOR THIS EMPLOYEE, and "complete"
   * means what the adjustments stage says it means: HAS_ADJUSTMENT or
   * NO_ADJUSTMENT_CONFIRMED. Somebody nobody has looked at yet is
   * NO_ADJUSTMENT_PENDING_CONFIRMATION, and approving them would be signing
   * off a month nobody checked for an incentive.
   */
  if (adjustment_state === ADJUSTMENT_STATE.NO_ADJUSTMENT_PENDING_CONFIRMATION) {
    blockers.push(blockerOf(READY_BLOCKER.ADJUSTMENT_PENDING_CONFIRMATION));
  }
  if (statutory_setup_complete !== true) {
    blockers.push(blockerOf(READY_BLOCKER.STATUTORY_SETUP_INCOMPLETE));
  }
  if (calculation.is_complete !== true) {
    blockers.push(blockerOf(READY_BLOCKER.CALCULATION_INCOMPLETE));
  }

  const status = blockers.length === 0 ? CALC_STATUS.READY_FOR_APPROVAL : CALC_STATUS.CALCULATED;
  return {
    status,
    status_label: CALC_STATUS_LABEL[status],
    blockers,
    recalculation_reasons: [],
    payslip_eligible: false,
  };
}

/**
 * THE MONTH'S COUNTS, over the CURRENT initialized population.
 *
 * `initialized` IS THE LENGTH OF WHAT WAS PASSED IN, which the repository read
 * from `payrun_employee` at the moment of the request - never a stored total.
 * Three employees initialized after the other two hundred were calculated turn
 * up as three not-calculated by arithmetic, with nothing re-opened. That is
 * the same dynamic-population rule the adjustments stage keeps.
 */
function summarize(rows = []) {
  const summary = {
    initialized: rows.length,
    not_calculated: 0,
    calculated: 0,
    recalculation_required: 0,
    ready_for_approval: 0,
    approved_locked: 0,
    payslip_eligible: 0,
  };
  rows.forEach((row) => {
    if (row.status === CALC_STATUS.NOT_CALCULATED) summary.not_calculated += 1;
    else if (row.status === CALC_STATUS.CALCULATED) summary.calculated += 1;
    else if (row.status === CALC_STATUS.RECALCULATION_REQUIRED) summary.recalculation_required += 1;
    else if (row.status === CALC_STATUS.READY_FOR_APPROVAL) summary.ready_for_approval += 1;
    else if (row.status === CALC_STATUS.APPROVED_LOCKED) summary.approved_locked += 1;
    if (row.payslip_eligible === true) summary.payslip_eligible += 1;
  });
  return summary;
}

/**
 * A FINGERPRINT OF THE ANSWER, not of the question.
 *
 * WHY BOTH THIS AND THE SOURCE HASH EXIST. The source hash says WHAT WENT IN;
 * this says WHAT CAME OUT, and it is what an approval is recorded against. The
 * audit requirement asks for a "calculation version/hash/reference" on the
 * approval, and a hash of the inputs would not satisfy it: two engine versions
 * can consume identical inputs and produce different net pay, and the thing
 * somebody approved is the net pay.
 */
function calculationHash(result = {}) {
  return hashOf([
    result.calculation_version,
    result.salary_earnings,
    result.extra_day_amount,
    result.missing_hours_deduction,
    result.ot_amount,
    result.incentive,
    result.bonus,
    result.arrears,
    result.advance_recovery,
    result.shortage_recovery,
    result.balance_advance,
    result.pf_wage,
    result.employee_pf,
    result.employer_epf,
    result.employer_eps,
    result.esi_wage,
    result.employee_esi,
    result.employer_esi,
    result.total_earnings,
    result.total_employee_deductions,
    result.net_pay,
    result.pay_type,
  ]);
}

module.exports = {
  toPaise,
  toRupees,
  resolveEffectiveNrm,
  sourceMarkers,
  sourceHash,
  inputsHash,
  detectChanges,
  computeCalculation,
  calculationHash,
  deriveStatus,
  summarize,
  recalcReasonOf,
  blockerOf,
  SOURCE_KEYS,
};
