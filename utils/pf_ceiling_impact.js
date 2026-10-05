/**
 * THE EPFO 2026 WAGE CEILING REVISION - WHO IS AFFECTED, AND BY HOW MUCH.
 *
 * READ-ONLY AND PURE. It takes employee master / approved salary rows the
 * caller has already read, and returns a classification and the before /
 * after figures. It writes nothing, enrols nobody and changes no flag: an
 * employee recorded as not in PF is reported as possibly needing enrolment,
 * and their "if enrolled" figures are shown beside the recorded ones, never
 * in place of them.
 *
 * THE FIGURES ARE STANDARD-MONTH FIGURES - full attendance, the approved
 * salary in force at the end of September 2026 - computed through
 * `utils/pf_period.js`, which is the same code a payrun runs:
 *
 *   current     the pre-revision month (August 2026): the 15,000 ceiling
 *   september   the split month: 01-16 on 15,000, 17-30 on 25,000
 *   october     the first full month on 25,000
 *
 * The actual September payrun will differ for anybody with loss of pay, a
 * mid-month join or exit, or a salary revision; this report is the population
 * to review before the payrun is run, not a substitute for it.
 *
 * THE PF WAGE IS BASIC. The Daily Needs PF wage basis is Basic only
 * (`config/statutory.js#pf`), so the classification is on Basic - never on
 * gross salary.
 */

const CONFIG = require("../config/statutory");
const engine = require("./salary_engine");
const pfPeriod = require("./pf_period");

const CATEGORY = {
  UP_TO_15000: "PF_WAGE_UP_TO_15000",
  FROM_15001_TO_25000: "PF_WAGE_15001_TO_25000",
  ABOVE_25000: "PF_WAGE_ABOVE_25000",
  NO_SALARY: "NO_APPROVED_SALARY",
};

const CATEGORY_LABEL = {
  [CATEGORY.UP_TO_15000]: "PF wage <= 15,000",
  [CATEGORY.FROM_15001_TO_25000]: "PF wage 15,001 - 25,000",
  [CATEGORY.ABOVE_25000]: "PF wage > 25,000",
  [CATEGORY.NO_SALARY]: "No approved salary",
};

const FLAG = {
  NO_CHANGE: "NO_CHANGE",
  CONTRIBUTION_INCREASES: "CONTRIBUTION_INCREASES",
  CEILING_RAISED_TO_25000: "CEILING_RAISED_TO_25000",
  BECOMES_EPS_ELIGIBLE: "BECOMES_EPS_ELIGIBLE_FROM_17_09_2026",
  MAY_REQUIRE_PF_ENROLMENT: "PREVIOUSLY_PF_EXCLUDED_MAY_REQUIRE_ENROLMENT_FROM_17_09_2026",
  PF_EXCLUDED_ABOVE_CEILING: "PF_EXCLUDED_ABOVE_25000_NO_CHANGE",
  PF_EXCLUDED_BELOW_15000_REVIEW: "PF_NOT_APPLICABLE_AT_OR_BELOW_15000_REVIEW",
  PF_APPLICABILITY_NOT_RECORDED: "PF_APPLICABILITY_NOT_RECORDED",
  DOB_NOT_RECORDED: "DOB_NOT_RECORDED",
  AGE_58_PLUS: "AGE_58_PLUS_NO_EPS",
  UAN_MISSING: "UAN_MISSING",
  HIGHER_WAGE_CONTRIBUTOR: "EXISTING_HIGHER_WAGE_EPF_CONTRIBUTOR",
  SEPTEMBER_JOINER_CHECK: "SEPTEMBER_JOINER_ABOVE_15000_CHECK_PRE_17_09_COVERAGE",
};

const REVISION_DATE = "2026-09-17";

const toPaise = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};
const toRupees = (p) => (p === null || p === undefined ? null : Math.round(p) / 100);

/** The employer's monthly statutory PF cost: 12% + EDLI + admin. Null when any is unresolved. */
function employerCost(pf) {
  const parts = [pf.employer_pf_total, pf.edli, pf.pf_admin_charge];
  if (parts.some((p) => p === null || p === undefined)) return null;
  return toRupees(parts.reduce((s, p) => s + toPaise(p), 0));
}

function categoryOf(basic) {
  const p = toPaise(basic);
  if (p === null) return CATEGORY.NO_SALARY;
  if (p <= 1500000) return CATEGORY.UP_TO_15000;
  if (p <= 2500000) return CATEGORY.FROM_15001_TO_25000;
  return CATEGORY.ABOVE_25000;
}

function monthFigures(row, year, month, overrides = {}, config = CONFIG) {
  return pfPeriod.calculatePfForMonth(
    {
      year,
      month,
      monthly_basic: row.basic,
      earned_basic: row.basic,
      pf_applicable: row.pf_applicable,
      pf_applicable_from: row.pf_applicable_from || null,
      pf_contribution_basis: row.pf_contribution_basis || null,
      dob: row.dob,
      date_of_joining: row.date_of_joining,
      ...overrides,
    },
    config
  );
}

const pick = (pf) => ({
  status: pf.status,
  pf_wage: pf.pf_wage,
  employee_pf: pf.employee_pf,
  employer_pf_total: pf.employer_pf_total,
  employer_epf: pf.employer_epf,
  employer_eps: pf.employer_eps,
  eps_wage: pf.eps_wage,
  edli: pf.edli,
  pf_admin_charge: pf.pf_admin_charge,
  employer_cost: employerCost(pf),
  total_remittance: pf.total_remittance ?? null,
  exact: pf.exact || null,
  pf_scenario: pf.pf_scenario || null,
  unresolved: (pf.unresolved || []).map((u) => u.code),
});

/**
 * ONE EMPLOYEE, CLASSIFIED.
 *
 * @param {object} row  employee_id, employee_name, store_name, date_of_joining,
 *                      dob, resignation_date, monthly_gross, basic,
 *                      pf_applicable, pf_applicable_from, uan,
 *                      previous_pf_member, previous_eps_member (reference columns only)
 */
function assessEmployee(row = {}, config = CONFIG) {
  const category = categoryOf(row.basic);
  const pfApplicable = engine.triState(row.pf_applicable);
  const age = engine.ageYearsOn(row.dob, REVISION_DATE);
  const flags = [];

  const base = {
    employee_id: Number(row.employee_id),
    employee_name: row.employee_name || null,
    store_name: row.store_name || null,
    date_of_joining: row.date_of_joining || null,
    dob: row.dob || null,
    age_on_17_09_2026: age,
    resignation_date: row.resignation_date || null,
    gross_salary: row.monthly_gross === undefined ? null : row.monthly_gross,
    basic: row.basic === undefined ? null : row.basic,
    /** The eligible PF wage (Basic) and the wage PF is charged on today (capped). */
    eligible_pf_wage: row.basic === undefined ? null : row.basic,
    current_pf_wage: null,
    pf_applicable: pfApplicable,
    pf_applicable_from: row.pf_applicable_from || null,
    pf_contribution_basis: pfPeriod.resolveBasis(row.pf_contribution_basis, config),
    pf_contribution_basis_recorded: row.pf_contribution_basis || null,
    uan: row.uan || null,
    previous_pf_member: engine.triState(row.previous_pf_member),
    previous_eps_member: engine.triState(row.previous_eps_member),
    category,
    category_label: CATEGORY_LABEL[category],
  };

  if (category === CATEGORY.NO_SALARY) {
    return { ...base, flags: [], reason: "No approved salary in force on 30-09-2026", current: null, september: null, october: null, if_enrolled: null, monthly_employer_cost_increase: null, potential_monthly_employer_cost_increase: null };
  }

  const current = pick(monthFigures(row, 2026, 8, {}, config));
  const september = pick(monthFigures(row, 2026, 9, {}, config));
  const october = pick(monthFigures(row, 2026, 10, {}, config));

  if (base.pf_contribution_basis === pfPeriod.BASIS.ACTUAL_WAGE) flags.push(FLAG.HIGHER_WAGE_CONTRIBUTOR);
  if (
    pfApplicable === true &&
    category !== CATEGORY.UP_TO_15000 &&
    row.date_of_joining &&
    String(row.date_of_joining).slice(0, 7) === "2026-09" &&
    !row.pf_applicable_from
  ) {
    flags.push(FLAG.SEPTEMBER_JOINER_CHECK);
  }

  let ifEnrolled = null;
  if (pfApplicable === null) flags.push(FLAG.PF_APPLICABILITY_NOT_RECORDED);
  if (pfApplicable === false) {
    if (category === CATEGORY.FROM_15001_TO_25000) {
      flags.push(FLAG.MAY_REQUIRE_PF_ENROLMENT);
      /*
       * WHAT IT WOULD COST IF HR ENROLS THEM FROM 17-09-2026 - shown beside
       * the recorded position, never in place of it. Coverage from the
       * revision date means no PF for 01-16 September at all.
       */
      const enrolled = { pf_applicable: 1, pf_applicable_from: REVISION_DATE };
      ifEnrolled = {
        september: pick(monthFigures(row, 2026, 9, enrolled, config)),
        october: pick(monthFigures(row, 2026, 10, enrolled, config)),
      };
    } else if (category === CATEGORY.ABOVE_25000) {
      flags.push(FLAG.PF_EXCLUDED_ABOVE_CEILING);
    } else {
      flags.push(FLAG.PF_EXCLUDED_BELOW_15000_REVIEW);
    }
  }

  if (pfApplicable === true) {
    if (toPaise(october.employee_pf) !== null && toPaise(october.employee_pf) === toPaise(current.employee_pf)) {
      flags.push(FLAG.NO_CHANGE);
    } else if (category === CATEGORY.ABOVE_25000) {
      flags.push(FLAG.CEILING_RAISED_TO_25000);
    } else if (category === CATEGORY.FROM_15001_TO_25000) {
      flags.push(FLAG.CONTRIBUTION_INCREASES);
    }
    const epsBefore = current.employer_eps;
    const epsAfter = october.employer_eps;
    if (toPaise(epsBefore) === 0 && toPaise(epsAfter) > 0) flags.push(FLAG.BECOMES_EPS_ELIGIBLE);
    if (!/^\d{12}$/.test(String(row.uan || "").trim())) flags.push(FLAG.UAN_MISSING);
  }
  const allUnresolved = [...current.unresolved, ...september.unresolved, ...october.unresolved];
  if (allUnresolved.includes(engine.UNRESOLVED.EPS_DOB_NOT_RECORDED)) flags.push(FLAG.DOB_NOT_RECORDED);
  if (age !== null && age >= config.pf.epsExitAgeYears) flags.push(FLAG.AGE_58_PLUS);

  const increase =
    current.employer_cost === null || october.employer_cost === null
      ? null
      : toRupees(toPaise(october.employer_cost) - toPaise(current.employer_cost));
  const potential =
    ifEnrolled && ifEnrolled.october.employer_cost !== null ? ifEnrolled.october.employer_cost : null;

  return {
    ...base,
    current_pf_wage: current.pf_wage,
    flags,
    reason: reasonOf(flags, category),
    current,
    september,
    october,
    if_enrolled: ifEnrolled,
    september_scenario: september.pf_scenario,
    monthly_employer_cost_increase: increase,
    potential_monthly_employer_cost_increase: potential,
  };
}

function reasonOf(flags, category) {
  const text = {
    [FLAG.NO_CHANGE]: "No change in the employee PF",
    [FLAG.CONTRIBUTION_INCREASES]: "PF wage 15,001-25,000: contribution now on actual wage from 17-09-2026",
    [FLAG.CEILING_RAISED_TO_25000]: "PF wage above 25,000: contribution ceiling rises 15,000 -> 25,000 from 17-09-2026",
    [FLAG.BECOMES_EPS_ELIGIBLE]: "PF-only member becomes EPS eligible from 17-09-2026",
    [FLAG.MAY_REQUIRE_PF_ENROLMENT]: "Recorded as PF not applicable, but PF wage is within 25,000: may need enrolment from 17-09-2026",
    [FLAG.PF_EXCLUDED_ABOVE_CEILING]: "PF not applicable and PF wage above 25,000: no change",
    [FLAG.PF_EXCLUDED_BELOW_15000_REVIEW]: "PF not applicable although PF wage is within 15,000: review the exclusion",
    [FLAG.PF_APPLICABILITY_NOT_RECORDED]: "PF applicability not recorded",
    [FLAG.DOB_NOT_RECORDED]: "Date of birth not recorded: EPS age rule unresolved",
    [FLAG.AGE_58_PLUS]: "Age 58+: no EPS, the whole employer share goes to EPF",
    [FLAG.UAN_MISSING]: "UAN not recorded: cannot be filed in the ECR",
    [FLAG.HIGHER_WAGE_CONTRIBUTOR]: "Existing higher-wage contributor: EPF on actual wage (FAQ Scenario B pattern)",
    [FLAG.SEPTEMBER_JOINER_CHECK]: "Joined in September above 15,000 and recorded as PF from joining: confirm whether excluded until 16-09 (FAQ Scenario A)",
  };
  const parts = flags.map((f) => text[f]).filter(Boolean);
  return parts.length ? parts.join("; ") : CATEGORY_LABEL[category];
}

/** The whole population, assessed, with counts and cost totals by category. */
function assessPopulation(rows = [], config = CONFIG) {
  const employees = rows.map((r) => assessEmployee(r, config));
  const byCategory = {};
  Object.values(CATEGORY).forEach((c) => {
    byCategory[c] = {
      label: CATEGORY_LABEL[c],
      employees: 0,
      pf_applicable: 0,
      pf_not_applicable: 0,
      pf_not_recorded: 0,
      monthly_employer_cost_increase: 0,
      unresolved_cost_employees: 0,
    };
  });
  const flagCounts = {};
  let total = 0;
  let potential = 0;
  employees.forEach((e) => {
    const bucket = byCategory[e.category];
    bucket.employees += 1;
    if (e.pf_applicable === true) bucket.pf_applicable += 1;
    else if (e.pf_applicable === false) bucket.pf_not_applicable += 1;
    else bucket.pf_not_recorded += 1;
    if (e.monthly_employer_cost_increase === null) bucket.unresolved_cost_employees += 1;
    else {
      bucket.monthly_employer_cost_increase = toRupees(
        toPaise(bucket.monthly_employer_cost_increase) + toPaise(e.monthly_employer_cost_increase)
      );
      total += toPaise(e.monthly_employer_cost_increase);
    }
    if (e.potential_monthly_employer_cost_increase !== null) potential += toPaise(e.potential_monthly_employer_cost_increase);
    e.flags.forEach((f) => {
      flagCounts[f] = (flagCounts[f] || 0) + 1;
    });
  });
  return {
    revision: {
      effective_from: REVISION_DATE,
      old_ceiling: 15000,
      new_ceiling: 25000,
      config_version: config.configVersion,
      ceiling_schedule: (config.pf.ceilingSchedule || []).map((r) => ({ ...r })),
    },
    summary: {
      employees: employees.length,
      by_category: byCategory,
      by_flag: flagCounts,
      monthly_employer_cost_increase: toRupees(total),
      potential_monthly_employer_cost_if_enrolled: toRupees(potential),
      may_require_enrolment: employees.filter((e) => e.flags.includes(FLAG.MAY_REQUIRE_PF_ENROLMENT)).length,
      by_september_scenario: employees.reduce((acc, e) => {
        if (e.september_scenario) acc[e.september_scenario] = (acc[e.september_scenario] || 0) + 1;
        return acc;
      }, {}),
    },
    employees,
  };
}

module.exports = { CATEGORY, CATEGORY_LABEL, FLAG, REVISION_DATE, categoryOf, assessEmployee, assessPopulation, employerCost };
