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

/** A comma-separated list from the environment, lower-cased, or the default. */
const list = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const items = String(raw)
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return items.length ? items : fallback;
};

/** A comma-separated list of month numbers (1-12) from the environment. */
const months = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const items = String(raw)
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 12);
  return items.length ? [...new Set(items)].sort((a, b) => a - b) : fallback;
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

  /**
   * A HIGHER-WAGE CONTRIBUTOR'S EDLI WAGE. The EPFO wage-ceiling FAQ's
   * Scenario B (an EPF + EDLI member contributing on 20,000) charges EDLI and
   * admin on the full 20,000. `true` follows the FAQ: for an employee whose
   * contribution basis is ACTUAL_WAGE the EDLI wage is the EPF wage. `false`
   * caps the EDLI wage at the statutory ceiling for everybody.
   */
  higherWageEdliOnActualWage: bool("PF_HIGHER_WAGE_EDLI_ON_ACTUAL_WAGE", true),
};

/**
 * THE EFFECTIVE-DATED PF / EPS / EDLI WAGE CEILING.
 *
 * `wageCeiling`, `epsWageCeiling` and `edliWageCeiling` above answer "what was
 * the ceiling before the revision" and stay exactly as they were, so a stored
 * record and every caller that never passes a date behave as before. This
 * schedule answers "which ceiling was in force ON A DATE", and it is what a
 * payrun reads: EPFO revised the ceiling from 15,000 to 25,000 with effect
 * from 17-09-2026, part-way through a wage month, and September 2026 has to be
 * charged on the old ceiling for 01-16 and on the new one for 17-30.
 *
 * ONE ROW PER VERSION, IN DATE ORDER. Each row runs from its `effectiveFrom`
 * to the day before the next row's. The next revision is a new row (or the
 * `PF_WAGE_CEILING_SCHEDULE` environment JSON) and not a change to payroll
 * arithmetic. `version` is stamped on every payrun calculation so that a
 * contribution can say which rule produced it.
 */
const pfCeilingSchedule = (() => {
  const fallback = [
    {
      effectiveFrom: "1900-01-01",
      wageCeiling: pf.wageCeiling,
      epsWageCeiling: pf.epsWageCeiling,
      edliWageCeiling: pf.edliWageCeiling,
      version: process.env.PF_CEILING_VERSION_BEFORE_REVISION || "EPFO-CEILING-15000-2014-09-01",
    },
    {
      effectiveFrom: date("PF_REVISED_CEILING_EFFECTIVE_FROM", "2026-09-17"),
      wageCeiling: num("PF_REVISED_WAGE_CEILING", 25000),
      epsWageCeiling: num("PF_REVISED_EPS_WAGE_CEILING", 25000),
      edliWageCeiling: num("PF_REVISED_EDLI_WAGE_CEILING", 25000),
      version: process.env.PF_REVISED_CEILING_VERSION || "EPFO-CEILING-25000-2026-09-17",
    },
  ];
  const raw = process.env.PF_WAGE_CEILING_SCHEDULE;
  if (raw === undefined || String(raw).trim() === "") return fallback;
  try {
    const rows = JSON.parse(raw);
    const valid =
      Array.isArray(rows) &&
      rows.length > 0 &&
      rows.every(
        (r) =>
          r &&
          /^\d{4}-\d{2}-\d{2}$/.test(String(r.effectiveFrom)) &&
          [r.wageCeiling, r.epsWageCeiling, r.edliWageCeiling].every((n) => Number.isFinite(Number(n))) &&
          typeof r.version === "string" &&
          r.version.trim() !== ""
      );
    if (!valid) return fallback;
    return rows
      .map((r) => ({
        effectiveFrom: r.effectiveFrom,
        wageCeiling: Number(r.wageCeiling),
        epsWageCeiling: Number(r.epsWageCeiling),
        edliWageCeiling: Number(r.edliWageCeiling),
        version: r.version.trim(),
      }))
      .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1));
  } catch (err) {
    return fallback;
  }
})();
pf.ceilingSchedule = pfCeilingSchedule;

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
   * OVERTIME IS ESI WAGE FOR THE CONTRIBUTION, NOT FOR COVERAGE.
   *
   * ESIC: "Overtime allowances will be considered as wage for the purpose of
   * charging the contribution only and will not be considered for the
   * purpose of the coverage of the employee under the Scheme" (memo
   * 3-1(2)/3(1)/68 of 31.05.1968; Indian Drugs & Pharmaceuticals Ltd v ESIC,
   * SC, Civil Appeal 2777/1980, 06.11.1996). So for a covered employee the
   * month's OT and any Prior-Month OT paid in the month are added to the
   * contribution wage, and the coverage ceiling is still tested on the wage
   * without them (`utils/salary_engine.js#calculateEsi`).
   *
   * A SWITCH, because the Code on Social Security 2020 s.2(88)(h) lists
   * "overtime allowance" among the heads excluded from wages (subject to the
   * 50% proviso) and ESIC's post-21.11.2025 advisories are read both ways.
   * `false` restores the previous behaviour (overtime outside the ESI wage)
   * without a code change, should compliance settle it the other way.
   */
  overtimeInContributionWage: bool("ESI_OVERTIME_IN_CONTRIBUTION_WAGE", true),

  /**
   * THE CONTRIBUTION PERIODS, as the months they begin in: 1 April and
   * 1 October, each running to the day before the next one starts.
   *
   * They are not a calendar convenience. Coverage is decided ONCE per period,
   * at its start or at the employee's entry into it, and an employee who was
   * covered then stays covered to the end of it even if their wages cross the
   * ceiling in between — see
   * `utils/salary_engine.js#resolveContributionPeriodCoverage`. Without the
   * period there is no way to say how long "until the end" is.
   */
  contributionPeriodStartMonths: months("ESI_CONTRIBUTION_PERIOD_START_MONTHS", [4, 10]),

  /*
   * WHICH WAGE ESI IS CHARGED ON IS NOT DECLARED HERE. It is the statutory
   * wage definition in `wages` below, which ESI shares with every other
   * contribution that uses it — see `utils/salary_engine.js#statutoryWages`.
   */
};

/**
 * THE STATUTORY WAGE DEFINITION — Code on Social Security, 2020.
 *
 * The Code replaced a per-Act list of includes and excludes with ONE
 * definition of "wages", and it applies to ESI for our payroll periods from
 * 21 November 2025. Two parts matter to a salary structure:
 *
 *   THE EXCLUSIONS. Named heads of remuneration are outside wages. Of this
 *   structure's four components, HRA and Conveyance (the Code's house rent
 *   allowance and conveyance allowance) are excluded; Basic and Special
 *   Allowance are wages, as is any other remuneration the Code does not
 *   specifically exclude — which is why this is a list of what comes OUT
 *   rather than a list of what goes in. A component added to the structure
 *   tomorrow is wages unless somebody names it here.
 *
 *   THE 50% PROVISO. If the excluded heads exceed half of total remuneration,
 *   the excess over that half is ADDED BACK, so statutory wages can never be
 *   less than 50% of total remuneration. It exists to stop a structure being
 *   arranged into excluded allowances to shrink the contribution base.
 *
 * ONE DEFINITION, EVERY CALLER. The Salary Master's standard wage and the
 * wage a payrun derives from what is actually payable are the same definition
 * applied to different remuneration, so both go through the one helper.
 */
const wages = {
  /**
   * The component names outside wages, matched against the component keys the
   * engine works in. Overridable as a comma-separated list, because the next
   * notification to move a head of remuneration in or out of the definition
   * should be deployable as configuration.
   */
  excludedComponents: list("STATUTORY_WAGE_EXCLUDED_COMPONENTS", ["hra", "conveyance"]),

  /** The proviso's floor, as a percentage of total remuneration. */
  minimumPercentOfRemuneration: num("STATUTORY_WAGE_MINIMUM_PERCENT_OF_REMUNERATION", 50),

  /**
   * When this definition took effect for our purposes. Stamped onto every
   * record so that a contribution can say WHICH definition of wages produced
   * it, rather than the answer having to be inferred from the record's date.
   */
  effectiveFrom: date("STATUTORY_WAGE_DEFINITION_EFFECTIVE_FROM", "2025-11-21"),
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
const configVersion = process.env.STATUTORY_CONFIG_VERSION || "M2-2026-10-07-ESI-OT-IN-CONTRIBUTION-WAGE";

module.exports = { salary, pf, esi, wages, rounding, configVersion };
