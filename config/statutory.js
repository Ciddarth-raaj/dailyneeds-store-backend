require("dotenv").config();

/**
 * M2 — the statutory rates, ceilings and salary-structure constants, in ONE
 * place.
 *
 * WHY THIS FILE EXISTS. PF and ESI rates change by notification, not by code
 * review. Scattering `0.12` and `15000` through the engine would mean that the
 * day EPFO moves the ceiling, the change is a hunt through arithmetic rather
 * than an edit to a number. Everything statutory that the salary engine reads
 * is declared here, and `utils/salary_engine.js` contains no bare rate.
 *
 * EVERY VALUE IS ENVIRONMENT-OVERRIDABLE, so a rate change can be deployed as
 * configuration ahead of a code release. The committed values are the ones
 * modelled by the approved M2 task and are the CURRENT configuration, not a
 * historical table: this file answers "what are the rates now", and the
 * per-record snapshot on `employee_salary` is what answers "what were they
 * when this salary was calculated" (see §snapshot in the migration).
 *
 * NOTHING HERE IS A SECRET. These are published statutory rates; no
 * credential, key or connection string belongs in this file.
 */

/** A number from the environment, or the committed default when unset/unusable. */
const num = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
};

/** A boolean from the environment. Only the exact string "false" turns one off. */
const bool = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  return String(raw).trim().toLowerCase() !== "false";
};

/** A `YYYY-MM-DD` string from the environment, or the committed default. */
const date = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  return /^\d{4}-\d{2}-\d{2}$/.test(String(raw).trim()) ? String(raw).trim() : fallback;
};

/**
 * The salary structure itself — the Daily Needs breakup rule, which is a
 * company policy rather than a statutory one, but belongs beside the rates it
 * feeds because changing either changes the same numbers.
 */
const salary = {
  /**
   * A month is 26 salary days. The monthly figure HR types is the Monthly
   * Gross for 26 days, and the daily rate is Gross / 26.
   */
  salaryDaysPerMonth: num("SALARY_DAYS_PER_MONTH", 26),

  /**
   * Below this gross there is no breakup at all: Basic is the whole gross and
   * every other component is zero.
   */
  breakupThreshold: num("SALARY_BREAKUP_THRESHOLD", 10000),

  /** At or above the threshold, Basic is the greater of this floor and the percentage. */
  basicFloor: num("SALARY_BASIC_FLOOR", 10000),
  basicPercentOfGross: num("SALARY_BASIC_PERCENT_OF_GROSS", 50),

  /** Caps on the two middle components. The balance falls to Special Allowance. */
  conveyanceCap: num("SALARY_CONVEYANCE_CAP", 2500),
  hraCap: num("SALARY_HRA_CAP", 10000),

  /**
   * The earliest Effective From an OPENING salary record may carry. The first
   * record for an employee is dated the later of this and their date of
   * joining, so a joiner from 2019 does not get a salary history that claims
   * to start in 2019 when the system has never held one.
   */
  openingEffectiveFloor: date("SALARY_OPENING_EFFECTIVE_FLOOR", "2026-04-01"),
};

/**
 * Provident fund.
 *
 * The Daily Needs PF wage basis is BASIC ONLY — not gross, and not
 * basic + DA, because there is no DA in this structure.
 */
const pf = {
  /** Employee share, and the employer's matching total before it is split. */
  employeeRatePercent: num("PF_EMPLOYEE_RATE_PERCENT", 12),
  employerRatePercent: num("PF_EMPLOYER_RATE_PERCENT", 12),

  /**
   * The employer's 12% is not a single contribution: part goes to the pension
   * scheme (EPS) and the remainder to the provident fund (EPF). EPS is 8.33%
   * of the pension wage, and EPF is whatever is left of the employer total.
   * EPF is therefore always computed by SUBTRACTION, never by its own rate —
   * that is what keeps the two halves summing to the employer total exactly.
   */
  epsRatePercent: num("PF_EPS_RATE_PERCENT", 8.33),

  /** Employer-side insurance and administration, on the ceiling wage. */
  edliRatePercent: num("PF_EDLI_RATE_PERCENT", 0.5),
  adminRatePercent: num("PF_ADMIN_RATE_PERCENT", 0.5),

  /**
   * The statutory wage ceiling. Contributions are computed on
   * `min(basic, ceiling)` rather than on the whole of Basic.
   */
  wageCeiling: num("PF_WAGE_CEILING", 15000),

  /** EPS and EDLI are capped at the same wage. Separate knobs so they can diverge. */
  epsWageCeiling: num("PF_EPS_WAGE_CEILING", 15000),
  edliWageCeiling: num("PF_EDLI_WAGE_CEILING", 15000),

  /**
   * EPS membership ceases at 58. From that birthday the employer's whole 12%
   * goes to EPF and no pension contribution is made.
   */
  epsExitAgeYears: num("PF_EPS_EXIT_AGE_YEARS", 58),

  /**
   * The "new member" cut-off. Somebody who was NOT ALREADY AN EPS MEMBER on or
   * after this date, whose pension wage exceeds the EPS ceiling, is not
   * eligible to join EPS — the employer's whole share goes to EPF instead.
   * This is the rule that makes `previous_eps_member` a payroll input rather
   * than a note, and it is why the field is tri-state: for an employee whose
   * pension history nobody has recorded, the answer is genuinely unknown and
   * the engine reports it as unresolved rather than picking a side.
   *
   * IT IS THE EPS FACT AND NOT THE EPF ONE. Form 11 asks about prior EPF
   * membership and prior EPS membership as two questions because they have two
   * answers; `previous_pf_member` records the first and is not consulted here.
   */
  newMemberCutoffDate: date("PF_NEW_MEMBER_CUTOFF_DATE", "2014-09-01"),

  /**
   * ISOLATED NUANCE — see `utils/salary_engine.js#resolveEpsEligibility`.
   *
   * Whether the employer contributes on the ceiling wage or on the whole of
   * Basic when Basic exceeds the ceiling. Daily Needs' modelled configuration
   * is the ceiling, which is what this defaults to. An establishment MAY
   * contribute on higher wages, and for an employee who was already
   * contributing on higher wages there is a live argument that it must
   * continue to. Nothing in the current authoritative project material settles
   * it, so it is one flag here rather than an assumption baked into the
   * arithmetic.
   */
  applyCeilingToWage: bool("PF_APPLY_CEILING_TO_WAGE", true),
};

/**
 * Employees' State Insurance.
 *
 * THE WAGE IS NOT THE GROSS. ESI "wages" is a statutory definition tied to
 * what is actually paid in a wage period — so it picks up overtime and other
 * period inputs the salary structure knows nothing about, and it excludes at
 * least one component the structure does carry. The engine therefore refuses
 * to compute a contribution from the structure alone and asks for the wage.
 */
const esi = {
  employeeRatePercent: num("ESI_EMPLOYEE_RATE_PERCENT", 0.75),
  employerRatePercent: num("ESI_EMPLOYER_RATE_PERCENT", 3.25),

  /** Above this wage an employee is outside the scheme for the contribution period. */
  coverageCeiling: num("ESI_COVERAGE_CEILING", 21000),

  /**
   * The low-wage exemption: below this AVERAGE DAILY wage the employee pays
   * nothing and the employer still pays its share in full.
   */
  employeeExemptionDailyWage: num("ESI_EMPLOYEE_EXEMPTION_DAILY_WAGE", 176),

  /**
   * ISOLATED NUANCE — see `utils/salary_engine.js#esiWageBounds`.
   *
   * Travelling allowance is excluded from the statutory definition of wages,
   * and Conveyance is this structure's travelling allowance. That matters only
   * for the BOUND the engine uses to decide "definitely outside the scheme"
   * without a payroll wage, and getting it wrong in the safe direction costs
   * an unresolved answer rather than a wrong number. It is a flag because it
   * is not settled by current project material.
   */
  conveyanceExcludedFromWage: bool("ESI_CONVEYANCE_EXCLUDED_FROM_WAGE", true),
};

/**
 * How money is rounded.
 *
 * Statutory contributions are filed in whole rupees. The salary components
 * themselves are not — a 50% Basic on an odd gross is a legitimate .50 — so
 * the two are rounded differently and deliberately.
 */
const rounding = {
  /** Contributions: nearest rupee. */
  contributionRounding: process.env.STATUTORY_CONTRIBUTION_ROUNDING || "NEAREST_RUPEE",
  /** Components and CTC: two decimal places. */
  componentDecimals: num("SALARY_COMPONENT_DECIMALS", 2),
};

/**
 * The version stamp written onto every salary record.
 *
 * A record explains itself from its own snapshot columns, so this is not what
 * makes history readable — it is what makes a whole GENERATION of records
 * findable when a rate change turns out to have been wrong. Bump it whenever
 * a committed default above changes.
 */
const configVersion = process.env.STATUTORY_CONFIG_VERSION || "M2-2026-04-01";

module.exports = { salary, pf, esi, rounding, configVersion };
