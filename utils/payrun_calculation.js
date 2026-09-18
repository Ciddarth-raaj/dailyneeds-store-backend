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
 * THE EMPLOYEE'S OVERTIME, SPLIT BY THE NRM EACH HOUR OF IT WAS WORKED
 * AGAINST.
 *
 * WHAT IS BEING ANSWERED, AND WHY IT IS NOT "ONE NRM FOR THE MONTH". OT is
 * priced per hour, and the hourly rate is Daily Rate / NRM - so an hour worked
 * on an 8-hour day and an hour worked on an 11-hour day are worth DIFFERENT
 * amounts. An employee who has approved OT on both kinds of day has no single
 * correct monthly NRM, and choosing one would misprice every hour worked
 * against the other: on the example of 120 minutes at NRM 11h and 60 minutes
 * at NRM 8h, pricing all 180 on either NRM is wrong for a third or two thirds
 * of it. So each group is priced on its own NRM and the amounts are summed.
 *
 * THE INPUT IS ALREADY-GROUPED ATTENDANCE, never a shift row. Each group is
 * `{ nrm_minutes, break_allowance_source, day_count, approved_ot_minutes }` as
 * the repository read them out of `attendance_day_calculation`. THE SHIFT
 * MASTER IS NOT CONSULTED ANYWHERE IN THIS STAGE: attendance has already
 * applied the employee's lunch/break override (`special_break_override_minutes`)
 * and reading the master again would be a second answer that disagrees with
 * the one the month was actually calculated on. An employee with no override
 * gets attendance's shift-derived NRM; one with an override gets attendance's
 * employee-specific NRM; the payrun asks which it was and never decides it.
 *
 * WHAT COMES BACK:
 *
 *   ot_groups        one entry per NRM that carries APPROVED OT, each with its
 *                    own minutes and its own source. This is what prices the
 *                    overtime, and it is the whole of it.
 *   nrm_minutes      A SINGLE REPRESENTATIVE NRM, and ONLY when there is
 *                    genuinely one. With one OT group it is that group's -
 *                    the ordinary case, and the screen goes on showing one NRM
 *                    and one hourly rate. With SEVERAL it is NULL, deliberately:
 *                    there is no single rate, and reporting one would be
 *                    reporting a figure that priced none of the money. With no
 *                    OT at all it is the month's ordinary pattern - the NRM
 *                    covering the most days - which prices nothing and is
 *                    shown so somebody can see what an hour would have cost.
 *   nrm_is_mixed     whether the month had more than one NRM at all.
 *
 * ZERO-NRM GROUPS ARE DROPPED. An NRM of zero is a rest day or a misconfigured
 * schedule; it cannot price an hour, and dividing by it is how a payroll
 * screen ends up showing Infinity. A group's OT minutes go with it - see
 * `computeCalculation`, which refuses to price approved OT it has no NRM for
 * rather than paying nothing for it.
 *
 * GROUPS WITH NO APPROVED OT REACH NO OT FIGURE. They are counted for the
 * ordinary-pattern fallback above and for nothing else, so a month of
 * twenty-six 8-hour days and one approved OT hour on a 12-hour day prices that
 * hour at the 12-hour rate.
 */
function resolveEffectiveNrm(groups = []) {
  const usable = (groups || [])
    .map((g) => ({
      nrm_minutes: intOr0(g.nrm_minutes),
      nrm_source:
        String(g.break_allowance_source || NRM_SOURCE.SHIFT).toUpperCase() ===
        NRM_SOURCE.EMPLOYEE_OVERRIDE
          ? NRM_SOURCE.EMPLOYEE_OVERRIDE
          : NRM_SOURCE.SHIFT,
      day_count: intOr0(g.day_count),
      approved_ot_minutes: intOr0(g.approved_ot_minutes),
    }))
    .filter((g) => g.nrm_minutes > 0);

  /*
   * THE OT-CARRYING GROUPS, MERGED BY (NRM, SOURCE) AND IN A FIXED ORDER.
   *
   * MERGED, because the repository groups by NRM **and** by break source, and
   * the same NRM can legitimately arrive from both - an override that happens
   * to equal the shift's own break gives two rows that must not be priced as
   * two rates. SORTED BY NRM, so the stored breakdown and its hash are stable
   * across reads: an order that depended on how MySQL returned the rows would
   * make an identical month hash differently on a different day.
   */
  const byRate = new Map();
  usable
    .filter((g) => g.approved_ot_minutes > 0)
    .forEach((g) => {
      const key = `${g.nrm_minutes}|${g.nrm_source}`;
      const existing = byRate.get(key);
      if (existing) existing.approved_ot_minutes += g.approved_ot_minutes;
      else byRate.set(key, { ...g });
    });

  const otGroups = [...byRate.values()]
    .sort((a, b) => a.nrm_minutes - b.nrm_minutes || (a.nrm_source < b.nrm_source ? -1 : 1))
    .map((g) => ({
      nrm_minutes: g.nrm_minutes,
      nrm_source: g.nrm_source,
      approved_ot_minutes: g.approved_ot_minutes,
    }));

  if (usable.length === 0) {
    return { nrm_minutes: null, nrm_source: null, nrm_is_mixed: false, ot_groups: [] };
  }

  /*
   * THE REPRESENTATIVE NRM. One OT group is one rate and is reported as one;
   * several is NO single rate, and null is the honest answer rather than the
   * largest, the commonest or the first. Nothing is priced from this value -
   * `ot_groups` above prices the overtime - so a null here costs no money and
   * only changes what a screen may show.
   */
  let representative = null;
  if (otGroups.length === 1) {
    representative = otGroups[0];
  } else if (otGroups.length === 0) {
    representative = usable.reduce((best, g) => {
      if (best === null) return g;
      if (g.day_count !== best.day_count) return g.day_count > best.day_count ? g : best;
      // The tie-break: the larger NRM, which is the lower hourly rate. Where
      // the month is genuinely ambiguous, the payrun does not resolve the
      // ambiguity in the direction of paying more.
      return g.nrm_minutes > best.nrm_minutes ? g : best;
    }, null);
  }

  return {
    nrm_minutes: representative ? representative.nrm_minutes : null,
    nrm_source: representative ? representative.nrm_source : null,
    /*
     * REPORTED SO A SCREEN CAN SAY THE MONTH WAS NOT UNIFORM - and, when the
     * OT itself spans more than one NRM, so it can show the breakdown instead
     * of a single misleading rate.
     */
    nrm_is_mixed: usable.length > 1,
    ot_groups: otGroups,
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
  coverage = {},
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
    /**
     * THE WHOLE OT SPLIT, NOT JUST THE HEADLINE NRM. The overtime is priced
     * per NRM group, so a month that moved 60 approved minutes from an 8-hour
     * day to an 11-hour one is a month that must be recalculated - and with a
     * single marker for one representative NRM, that move would be invisible:
     * the total minutes and the headline NRM can both be unchanged while the
     * amount is different. The groups are already in a fixed order (see
     * `resolveEffectiveNrm`), so an identical split always marks identically.
     */
    ot_groups: (nrm.ot_groups || [])
      .map((g) => `${g.nrm_minutes}:${g.nrm_source}:${g.approved_ot_minutes}`)
      .join(","),

    pf_applicable: statutory.pf_applicable ?? null,
    esi_applicable: statutory.esi_applicable ?? null,

    /**
     * THE ESI CONTRIBUTION-PERIOD BASIS IS A SOURCE IN ITS OWN RIGHT.
     *
     * Coverage is decided from the APPROVED SALARY IN FORCE AT THE PERIOD'S
     * ENTRY DATE, which is a different record from the one pricing the month -
     * often a much older one. A revision back-dated into the previous
     * September can therefore change whether this January is covered at all,
     * without touching `salary_id` or any other marker above. So the entry
     * date, the record found there and the position it established are all
     * marked, and a change to any of them makes the stored calculation
     * RECALCULATION_REQUIRED.
     */
    esi_coverage_entry_date: coverage.entry_date ?? null,
    esi_coverage_entry_salary_id: coverage.entry_salary_id ?? null,
    esi_coverage_entry_gross: coverage.entry_gross ?? null,
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
  "ot_groups",
  "pf_applicable",
  "esi_applicable",
  "esi_coverage_entry_date",
  "esi_coverage_entry_salary_id",
  "esi_coverage_entry_gross",
];

function sourceHash(markers = {}) {
  return hashOf(SOURCE_KEYS.map((key) => markers[key]));
}

/**
 * THE ATTENDANCE SUBSET OF THE SOURCE MARKERS.
 *
 * A NAMED SUBSET, NOT A SECOND DEFINITION. These are the seven keys of
 * `SOURCE_KEYS` above that come from attendance, listed here so the approval's
 * post-lock revalidation can ask the narrower question - "has ATTENDANCE moved
 * under this calculation?" - without inventing its own idea of freshness or
 * re-reading the salary, the statutory flags and the ESI coverage evidence
 * inside a lock it is holding.
 *
 * Every key is spelled in `SOURCE_KEYS`, and a test holds it to that: a marker
 * added to the source set and forgotten here would be a source the approval
 * stopped watching at the one moment it matters most.
 */
const ATTENDANCE_SOURCE_KEYS = [
  "attendance_monthly_payroll_id",
  "attendance_payroll_version",
  "attendance_calculated_at",
  "approved_ot_minutes",
  "effective_nrm_minutes",
  "effective_nrm_source",
  "ot_groups",
];

/**
 * Has attendance moved under this stored calculation?
 *
 * Compares the stored row's attendance markers against the ones read NOW,
 * using the same `mark()` normalization the hash uses - so "0" and 0 are the
 * same answer here exactly as they are there, and a difference this reports is
 * a difference that would have changed `source_hash`.
 *
 * Returns the keys that differ, in `SOURCE_KEYS` order, or an empty list. The
 * caller decides what to do about it; this decides nothing.
 */
function attendanceSourceChanges(storedRow = {}, currentMarkers = {}) {
  const stored = storedMarkers(storedRow || {});
  return ATTENDANCE_SOURCE_KEYS.filter(
    (key) => mark(stored[key]) !== mark((currentMarkers || {})[key])
  );
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
  if (
    differs("effective_nrm_minutes") ||
    differs("effective_nrm_source") ||
    /*
     * THE SPLIT COUNTS AS AN NRM CHANGE, because that is what it is: the same
     * total minutes worked against different NRMs is a different OT amount,
     * and the person reading the badge needs to go and look at the same place.
     */
    differs("ot_groups")
  ) {
    reasons.push(RECALC_REASON.EFFECTIVE_NRM_CHANGED);
  }
  if (differs("pf_applicable") || differs("esi_applicable")) {
    reasons.push(RECALC_REASON.STATUTORY_CONTEXT_CHANGED);
  }
  /*
   * THE ESI COVERAGE BASIS IS ITS OWN REASON. "A salary changed" would send
   * somebody to look at this month's revision, which is not where the change
   * is: the record that moved is the one in force when the contribution period
   * began, possibly months earlier.
   */
  if (
    differs("esi_coverage_entry_date") ||
    differs("esi_coverage_entry_salary_id") ||
    differs("esi_coverage_entry_gross")
  ) {
    reasons.push(RECALC_REASON.ESI_COVERAGE_CHANGED);
  }
  return reasons;
}

/**
 * THE MARKER SET A **STORED** CALCULATION CONSUMED, read back off its row.
 *
 * WHY THIS EXISTS RATHER THAN COMPARING THE ROW DIRECTLY. Most markers are
 * stored under their own names and compare as they are - but the OT split is
 * stored as the PRICED breakdown (`ot_groups`, with hours, rates and amounts
 * on it, because that is what a payslip has to be able to show), while the
 * marker is the bare NRM-to-minutes split. Comparing the column against the
 * marker string would find a difference on every single read, and every
 * calculated employee would read as stale forever - a failure that looks like
 * working stale-detection and is in fact total.
 *
 * SO THE TRANSLATION LIVES HERE, once, beside the marker definition it has to
 * agree with.
 */
function storedMarkers(row = {}) {
  const groups = (() => {
    const raw = row.ot_groups;
    if (Array.isArray(raw)) return raw;
    if (typeof raw === "string" && raw.trim() !== "") {
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch (err) {
        return [];
      }
    }
    return [];
  })();

  return {
    ...row,
    ot_groups: groups
      .map((g) => `${g.nrm_minutes}:${g.nrm_source}:${g.approved_ot_minutes}`)
      .join(","),
  };
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
    /**
     * THE APPROVED SALARY IN FORCE WHEN THIS CONTRIBUTION PERIOD BEGAN - or
     * when the employee joined, if they joined part-way through it. The one
     * piece of evidence the coverage rule cannot derive for itself; the
     * repository reads it from the employee's own salary history at the entry
     * date the engine names. See the ESI section below.
     */
    coverage_entry_salary = null,
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
  const approvedOtHours = Math.round((approvedOtMinutes / 60) * 10000) / 10000;
  const otGroups = (nrm && Array.isArray(nrm.ot_groups) ? nrm.ot_groups : []).map((g) => ({
    ...g,
  }));
  const nrmMinutes = nrm && nrm.nrm_minutes ? intOr0(nrm.nrm_minutes) : null;

  /*
   * OT IS PRICED GROUP BY GROUP, AND THE TOTAL IS THEIR SUM.
   *
   *   OT amount for a group = its Approved OT Hours
   *                           x (Per-Day Salary / its Effective NRM in hours)
   *   OT amount             = the sum of the groups
   *
   * WHY NOT ONE RATE FOR THE MONTH. The hourly rate is Daily Rate / NRM, so an
   * hour worked against an 8-hour NRM and an hour worked against an 11-hour
   * one are worth different amounts. An employee with approved OT on both has
   * no single correct rate, and applying either to all of it misprices
   * whichever hours belong to the other. Attendance has already resolved the
   * employee-specific NRM per date - override and all - so the split is read
   * from its answer and never re-derived here.
   *
   * THERE IS NO WEEKDAY MULTIPLIER ANYWHERE IN THIS ARITHMETIC. Attendance's
   * own `approved_ot_earnings` applies the Work Shift's weekday OT rate; the
   * agreed Daily Needs payrun formula does not, and that figure is carried on
   * the row for reconciliation and reaches no total. There is no reference to
   * `ot_rate` in this file.
   *
   * EACH GROUP IS ROUNDED ONCE, at its own total, rather than per hour - so
   * thirty OT hours do not carry thirty rounding errors - and the group
   * amounts are summed as integer paise.
   */
  let otAmountPaise = 0;
  let otHourlyRatePaise = null;
  const otBreakdown = [];

  const groupedOtMinutes = otGroups.reduce((total, g) => total + intOr0(g.approved_ot_minutes), 0);

  if (dailyRatePaise === null) {
    if (approvedOtMinutes > 0) {
      errors.push("Approved OT cannot be priced: this month has no daily rate to price an hour with");
    }
  } else if (approvedOtMinutes > 0 && otGroups.length === 0) {
    /*
     * APPROVED OT WITH NO NRM TO PRICE IT ON IS AN ERROR, NEVER A ZERO. A zero
     * is an employee quietly not paid for overtime somebody approved, which is
     * the kind of mistake nobody notices until they complain.
     */
    errors.push(
      "Approved OT cannot be priced: no effective NRM was resolved from this employee's attendance for the month"
    );
  } else if (otGroups.length > 0) {
    otGroups.forEach((group) => {
      const minutes = intOr0(group.approved_ot_minutes);
      const perHour = dailyRatePaise / (group.nrm_minutes / 60);
      const amount = Math.round((minutes / 60) * perHour);
      otAmountPaise += amount;
      otBreakdown.push({
        nrm_minutes: group.nrm_minutes,
        nrm_source: group.nrm_source,
        approved_ot_minutes: minutes,
        approved_ot_hours: Math.round((minutes / 60) * 10000) / 10000,
        ot_hourly_rate: toRupees(Math.round(perHour)),
        ot_amount: toRupees(amount),
      });
    });

    /*
     * THE HEADLINE RATE IS REPORTED ONLY WHEN THERE IS ONE. With a single
     * group it is that group's - the ordinary case, and the screen goes on
     * showing one NRM and one hourly rate. With several, it stays null and the
     * breakdown above is what the screen shows: a single rate there would be a
     * figure that priced none of the money.
     */
    if (otBreakdown.length === 1) otHourlyRatePaise = toPaise(otBreakdown[0].ot_hourly_rate);

    /*
     * THE MONTHLY ROLL-UP AND ITS OWN DAY ROWS MUST AGREE ABOUT HOW MUCH OT
     * WAS APPROVED. They are two views of one fact, written by one engine, and
     * when they disagree this calculation cannot know which is right - so it
     * says so rather than paying whichever it happened to read. Blocking the
     * approval is the point: a silent difference here is money.
     */
    if (groupedOtMinutes !== approvedOtMinutes) {
      errors.push(
        `Approved OT does not reconcile: the attendance month reports ${approvedOtMinutes} minutes ` +
          `and its day rows report ${groupedOtMinutes}. Recalculate the attendance for this month.`
      );
    }
  } else if (nrmMinutes !== null && nrmMinutes > 0) {
    // No overtime at all, but the rate is still reported - somebody reviewing
    // the month should be able to see what an hour would have cost.
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

  /*
   * ================================ THE CONTRIBUTION PERIOD, RESOLVED ======
   *
   * ESI DOES NOT STOP THE MOMENT WAGES CROSS THE CEILING. Coverage is decided
   * ONCE per contribution period - at its start, or at the employee's entry
   * into it if they joined part-way through - and somebody covered at that
   * moment stays covered to the end of the period whatever their wages do in
   * between. A payrun that asked only "is this month's wage above the
   * ceiling?" would stop contributing for exactly the employees the
   * continuation rule exists to protect, and a contribution that quietly stops
   * is a filing error nobody notices for a year.
   *
   * THE RULE IS THE SALARY ENGINE'S AND IS NOT REIMPLEMENTED HERE.
   * `resolveContributionPeriodCoverage` already decides it - the period from
   * `contributionPeriodFor`, the entry date from `contributionPeriodEntryDate`,
   * the wages at entry through the same `statutoryWages` definition - and this
   * is the same call `usecase/employee_salary.js` makes for the Salary Master.
   * What the payrun supplies is the one piece of evidence the rule cannot
   * derive: the APPROVED salary that was in force at the entry date, which the
   * repository looked up from the employee's own salary history.
   *
   * NOTHING HERE COMES FROM A CLIENT. The entry date is derived from the
   * period and the date of joining, the entry salary is the server's own read,
   * and there is no key on this function's input that a request body could
   * reach.
   */
  const coverage = engine.resolveContributionPeriodCoverage(
    {
      esi_applicable: snapshot.esi_applicable,
      date_of_joining: snapshot.date_of_joining ?? statutory.date_of_joining ?? null,
      as_of,
      entry_salary: coverage_entry_salary,
    },
    config
  );

  const esiWageRupees = wageDefinition === null ? null : wageDefinition.statutory_wages;
  const esiWagePaise = toPaise(esiWageRupees);
  const coverageCeilingPaise = toPaise(config.esi.coverageCeiling);

  /*
   * AN UNPROVABLE POSITION AT ENTRY IS A QUESTION, NOT A ZERO - AND ONLY WHERE
   * IT DECIDES ANYTHING.
   *
   * `continues === null` means the server could not establish whether this
   * employee was in the scheme when the period began: no approved salary at
   * the entry date, or applicability never recorded. That matters only ABOVE
   * the ceiling, because at or below it the employee is covered either way and
   * the contribution is the same whichever the answer would have been. So the
   * question is raised exactly where it changes the money, and an employee
   * carrying it cannot be approved - see `deriveStatus`, which refuses an
   * incomplete calculation.
   *
   * WHY THIS IS DECIDED HERE RATHER THAN IN `calculateEsi`. That function's
   * SUPPLIED-WAGE path treats a wage above the ceiling with no established
   * continuation as simply not covered, which is right for a caller that has
   * no period context at all. The payrun HAS the context and has failed to
   * resolve it, which is a different situation and must not read as a No.
   */
  const coverageUnresolvedAboveCeiling =
    coverage.continues === null &&
    esiWagePaise !== null &&
    coverageCeilingPaise !== null &&
    esiWagePaise > coverageCeilingPaise;

  let esi;
  if (coverageUnresolvedAboveCeiling) {
    esi = {
      status: engine.STATUS.PENDING,
      unresolved: [
        {
          code:
            coverage.basis === "APPLICABILITY_NOT_RECORDED"
              ? engine.UNRESOLVED.ESI_APPLICABILITY_NOT_RECORDED
              : engine.UNRESOLVED.ESI_CONTRIBUTION_PERIOD_UNRESOLVED,
          component: "esi",
        },
      ],
      esi_wage: null,
      employee_esi: null,
      employer_esi: null,
    };
  } else {
    esi = engine.calculateEsi(
      {
        esi_applicable: snapshot.esi_applicable,
        esi_wage: esiWageRupees,
        /*
         * `true` OR `undefined`, NEVER `false`, which is the shape the engine
         * documents: a proven continuation keeps somebody covered above the
         * ceiling, and its absence simply leaves the ordinary ceiling test to
         * decide. Passing `false` would be asserting a position the coverage
         * rule did not take.
         */
        contribution_period_continues: coverage.continues === true ? true : undefined,
        contribution_period_unresolved: coverage.continues === null,
      },
      config
    );
  }
  (esi.unresolved || []).forEach((u) => unresolved.push({ ...u, stage: "esi" }));

  /* ----------------------------------------------------------- THE TOTALS */

  const employeePfPaise = toPaise(pf.employee_pf);
  const employeeEsiPaise = toPaise(esi.employee_esi);

  /*
   * AN UNRESOLVED CONTRIBUTION IS NOT A FAILED CALCULATION, AND IT IS NOT A
   * ZERO EITHER.
   *
   * The statutory engine answers what it cannot establish with a named
   * question rather than a plausible number - an unrecorded applicability, a
   * contribution period whose entry position could not be proved - and that is
   * a REAL result which has to be stored, shown and acted on. So the row is
   * written, carrying the question.
   *
   * WHAT IT CANNOT HAVE IS A NET PAY. Subtracting an unknown deduction as
   * though it were zero would produce a net pay that is too high by exactly
   * the contribution nobody has worked out, and that figure would sit on a
   * review screen looking finished. The totals below are therefore null until
   * both contributions are known, and `is_complete` is false, which stops the
   * employee being approved.
   */
  const contributionsResolved = employeePfPaise !== null && employeeEsiPaise !== null;

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

  const totalEmployeeDeductionsPaise = contributionsResolved
    ? missingDeductionPaise + employeePfPaise + employeeEsiPaise + deductionsFromNetPaise
    : null;

  const netPayPaise =
    totalEmployeeDeductionsPaise === null ? null : totalEarningsPaise - totalEmployeeDeductionsPaise;

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
    /**
     * THE HEADLINE RATE, AND IT IS NULL WHEN THE MONTH HAS MORE THAN ONE.
     * `ot_groups` below is what priced the overtime in that case, and a single
     * rate here would be a figure that priced none of it.
     */
    ot_hourly_rate: toRupees(otHourlyRatePaise),
    ot_amount: toRupees(otAmountPaise),
    /**
     * HOW THE OVERTIME WAS ACTUALLY PRICED: one entry per NRM that carried
     * approved OT, each with its own minutes, its own source and its own rate.
     * With one entry it says the same thing as the two fields above; with more
     * than one it is the only honest account of the amount.
     */
    ot_groups: otBreakdown,
    /*
     * WHAT ATTENDANCE PRICED THE SAME OVERTIME AT, CARRIED FOR RECONCILIATION
     * AND USED FOR NOTHING. The attendance engine prices OT per DATE, on that
     * date's NRM and that weekday's OT multiplier; the payrun prices approved
     * OT SEPARATELY FOR EACH ATTENDANCE-RESOLVED EFFECTIVE NRM GROUP and sums
     * the group amounts, with no weekday multiplier, because that is the
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
    /**
     * HOW THE COVERAGE QUESTION WAS ANSWERED, beside the contribution it
     * decided - the same pair `calculateSalary` returns for the Salary Master.
     * A contribution that differs from what the ceiling rule alone would give
     * has to be able to say why without anybody re-deriving it, and "covered
     * at entry, so covered to the end of the period" is that reason.
     */
    esi_period_start: coverage.period ? coverage.period.start : null,
    esi_period_end: coverage.period ? coverage.period.end : null,
    esi_coverage_entry_date: coverage.entry_date ?? null,
    esi_coverage_entry_salary_id: coverage.entry_salary_id ?? null,
    esi_coverage_basis: coverage.basis ?? null,
    esi_contribution_period_continues: coverage.continues,

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

  /*
   * IS THE ATTENDANCE THIS MONTH WAS PRICED FROM SETTLED?
   *
   * ONE ANSWER, READ IN THREE PLACES BELOW: it decides the approval blocker it
   * always decided, it decides the visible ATTENDANCE_PENDING status, and it
   * decides `attendance_pending` - the flag the presentation layer suppresses
   * provisional figures from. A missing row and a row the engine has not
   * finalized are the SAME fact here: in both, the salary days, the overtime
   * and the statutory wages this calculation used are arithmetic on an
   * attendance month that is not settled yet.
   */
  const attendanceFinal = Boolean(
    attendance && (attendance.is_final === 1 || attendance.is_final === true)
  );

  if (calculation && calculation.status === CALC_STATUS.APPROVED_LOCKED) {
    return {
      status: CALC_STATUS.APPROVED_LOCKED,
      status_label: CALC_STATUS_LABEL[CALC_STATUS.APPROVED_LOCKED],
      blockers: [blockerOf(READY_BLOCKER.ALREADY_LOCKED)],
      recalculation_reasons: [],
      /*
       * A LOCKED MONTH IS NEVER PENDING. Approval refuses attendance that is
       * not final, so a locked employee's figures were computed from a settled
       * month by construction - and suppressing a figure somebody has signed
       * off would hide what they signed.
       */
      attendance_pending: false,
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
      /*
       * NOTHING TO SUPPRESS. There are no stored figures at all, so every one
       * of them is already absent rather than provisional, and NOT_CALCULATED
       * is the more informative thing to say about this employee.
       */
      attendance_pending: false,
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
      /*
       * A MOVED SOURCE IS THE MORE URGENT THING TO SAY, so it keeps the
       * status - and it is exactly what an attendance month turning final
       * produces, which is how this employee gets back to real figures.
       *
       * THE FLAG STILL STANDS THOUGH. Stale figures computed from attendance
       * that is STILL not settled are provisional twice over, and presenting
       * their zeroes as results would be the same lie with a warning over it.
       */
      attendance_pending: !attendanceFinal,
      payslip_eligible: false,
    };
  }

  /*
   * THE READY RULES. Every one of them is re-decided here, from the state of
   * the world at the moment of the request, and NONE of them is read from a
   * stored flag - a stored "ready" is a flag that goes stale the moment a
   * regularization is raised.
   */
  if (!attendanceFinal) {
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

  /*
   * THE VISIBLE STATUS, AND `ATTENDANCE_PENDING` REPLACES `CALCULATED` ONLY.
   *
   * A calculated employee with nothing outstanding is READY_FOR_APPROVAL; one
   * with something outstanding was CALCULATED, whatever the something was -
   * and that is what put "CALCULATED, Salary Days 0, Net Pay 0.00" on the
   * screen for somebody whose attendance had never been settled. Where the
   * outstanding thing is the attendance the figures were priced FROM, the
   * status says so, because the figures are not results yet.
   *
   * IT IS NOT A NEW GATE. `blockers` is unchanged, `payslip_eligible` is
   * unchanged, and approval reads the blockers rather than the status - so
   * this employee was refused before and is refused now, by the same rule.
   */
  const status =
    blockers.length === 0
      ? CALC_STATUS.READY_FOR_APPROVAL
      : attendanceFinal
      ? CALC_STATUS.CALCULATED
      : CALC_STATUS.ATTENDANCE_PENDING;
  return {
    status,
    status_label: CALC_STATUS_LABEL[status],
    blockers,
    recalculation_reasons: [],
    attendance_pending: !attendanceFinal,
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
    /*
     * COUNTED SEPARATELY FROM `calculated`, because it is a separate thing to
     * do about it: a CALCULATED employee is waiting on a confirmation or an
     * approval somebody can give, and an ATTENDANCE_PENDING one is waiting on
     * the attendance month being settled, which is a different person's job.
     * Rolling them together would hide how much of a month is not costed yet.
     */
    attendance_pending: 0,
    calculated: 0,
    recalculation_required: 0,
    ready_for_approval: 0,
    approved_locked: 0,
    payslip_eligible: 0,
  };
  rows.forEach((row) => {
    if (row.status === CALC_STATUS.NOT_CALCULATED) summary.not_calculated += 1;
    else if (row.status === CALC_STATUS.ATTENDANCE_PENDING) summary.attendance_pending += 1;
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
    result.esi_contribution_period_continues,
    (result.ot_groups || [])
      .map((g) => `${g.nrm_minutes}:${g.approved_ot_minutes}:${g.ot_amount}`)
      .join(","),
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
  storedMarkers,
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
  ATTENDANCE_SOURCE_KEYS,
  attendanceSourceChanges,
};
