/**
 * M2 — the salary engine.
 *
 * PURE FUNCTIONS ONLY. No database, no Express, no clock of its own: every
 * date it reasons about is passed in. That is what lets the whole of the
 * business rule be tested as arithmetic, and it is why the API layer can call
 * the same function for a preview as it does for a saved record — there is
 * exactly one implementation of "what is this salary", and the server runs it.
 *
 * THE SERVER CALCULATES EVERYTHING. Nothing here ever reads a component, a
 * contribution or a CTC from the caller and believes it. A manual override
 * supplies the four component AMOUNTS and nothing else; they are validated
 * against the gross and the caps, and every statutory number is still computed
 * here from them.
 *
 * MONEY IS HELD IN PAISE. Every intermediate is an integer number of paise, so
 * the components sum to the gross exactly rather than to within a floating
 * point epsilon. Rupee values are produced only at the edges.
 *
 * WHAT "UNRESOLVED" MEANS, AND WHY IT IS NOT ZERO. Several statutory questions
 * genuinely cannot be answered from an employee master row and a gross — an
 * ESI contribution needs the wage actually paid in a period, and the EPS split
 * needs a membership history nobody has recorded yet. The engine answers those
 * with a PENDING status and a named reason, never with a plausible-looking
 * number. A zero that should have been a contribution is a filing error that
 * nobody notices for a year; a PENDING is a question on a screen.
 */

const CONFIG = require("../config/statutory");

/* ------------------------------------------------------------------ money */

/** Rupees (or a numeric string) to integer paise. */
const toPaise = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
};

/** Integer paise back to a rupee number with two decimals. */
const toRupees = (paise) => (paise === null || paise === undefined ? null : Math.round(paise) / 100);

/** A percentage of a paise amount, still in paise, unrounded. */
const percentOf = (paise, percent) => (paise * percent) / 100;

/**
 * A statutory contribution, rounded to whole rupees.
 *
 * Contributions are filed in whole rupees, and the rounding is what makes the
 * familiar numbers come out right: 8.33% of the 15,000 ceiling is 1,249.50,
 * and the pension contribution everybody knows as 1,250 is that figure rounded
 * rather than truncated.
 */
const roundContribution = (paise, mode = CONFIG.rounding.contributionRounding) => {
  if (paise === null || paise === undefined) return null;
  if (mode === "NONE") return Math.round(paise);
  const rupees = paise / 100;
  if (mode === "UP_RUPEE") return Math.ceil(rupees) * 100;
  if (mode === "DOWN_RUPEE") return Math.floor(rupees) * 100;
  // NEAREST_RUPEE, the default.
  return Math.round(rupees) * 100;
};

/* ------------------------------------------------------------------ dates */

/** `YYYY-MM-DD` from a string or Date, or null for anything unusable. */
function toDateOnly(value) {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, "0");
    const d = String(value.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  const s = String(value).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** Date-only strings compare correctly as strings, which is the whole point of the format. */
const isOnOrAfter = (a, b) => a !== null && b !== null && a >= b;

/** Completed years between two date-only strings, or null when either is missing. */
function ageYearsOn(dob, asOf) {
  const birth = toDateOnly(dob);
  const at = toDateOnly(asOf);
  if (!birth || !at) return null;
  const [by, bm, bd] = birth.split("-").map(Number);
  const [ay, am, ad] = at.split("-").map(Number);
  let years = ay - by;
  if (am < bm || (am === bm && ad < bd)) years -= 1;
  return years;
}

/** The later of two date-only strings. */
const laterOf = (a, b) => {
  const x = toDateOnly(a);
  const y = toDateOnly(b);
  if (!x) return y;
  if (!y) return x;
  return x >= y ? x : y;
};

/* --------------------------------------------------- tri-state flag reading */

/**
 * A tri-state applicability flag as `true` / `false` / `null`.
 *
 * NULL IS A REAL ANSWER and means "nobody has said yet". It is never collapsed
 * into false: `pf_applicable` is NULL for every employee the C3 migration
 * touched, and treating that as "not in the scheme" would silently stop
 * contributions for people who are in it.
 */
function triState(value) {
  if (value === null || value === undefined || value === "") return null;
  if (value === true || value === false) return value;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n === 1;
}

/* --------------------------------------------------------------- breakup */

const STATUS = {
  APPLIED: "APPLIED",
  NOT_APPLICABLE: "NOT_APPLICABLE",
  PENDING: "PENDING",
};

/**
 * Which wage an ESI figure was charged on.
 *
 *   PAYROLL   the wage actually payable in a month, supplied by a payrun after
 *             attendance and deductions. The authoritative monthly liability.
 *   STANDARD  the wage this salary structure implies for a full month. What the
 *             Salary Master states as the employee's standard monthly cost.
 *
 * They are allowed to differ, and a caller that mixes them up would be
 * reporting an estimate as a liability — hence a named basis on the result
 * rather than a bare amount.
 */
const ESI_WAGE_BASIS = {
  PAYROLL: "PAYROLL",
  STANDARD: "STANDARD",
};

/** Reason codes. Stable strings, because screens and reports key off them. */
const UNRESOLVED = {
  PF_APPLICABILITY_NOT_RECORDED: "PF_APPLICABILITY_NOT_RECORDED",
  EPS_MEMBERSHIP_NOT_RECORDED: "EPS_MEMBERSHIP_NOT_RECORDED",
  EPS_DOB_NOT_RECORDED: "EPS_DOB_NOT_RECORDED",
  ESI_APPLICABILITY_NOT_RECORDED: "ESI_APPLICABILITY_NOT_RECORDED",
  ESI_WAGE_CONTEXT_UNAVAILABLE: "ESI_WAGE_CONTEXT_UNAVAILABLE",
};

/**
 * The automatic breakup of a monthly gross.
 *
 *   Gross <  threshold   Basic is the whole gross; everything else is zero.
 *   Gross >= threshold   Basic      = max(floor, 50% of gross)
 *                        Conveyance = min(what is left, 2500)
 *                        HRA        = min(what is left after that, 10000)
 *                        Special    = the balance
 *
 * There is no DA in this structure, by design.
 *
 * THE COMPONENTS ALWAYS SUM TO THE GROSS, and they do so by construction
 * rather than by a correction at the end: every step after Basic spends what
 * the previous step left, and Special Allowance is whatever remains. That is
 * why the arithmetic is in paise — the identity has to hold exactly.
 */
function calculateBreakup(grossRupees, config = CONFIG) {
  const cfg = config.salary;
  const gross = toPaise(grossRupees);
  if (gross === null || gross < 0) {
    throw new Error("Monthly gross must be a non-negative number");
  }

  const threshold = toPaise(cfg.breakupThreshold);

  if (gross < threshold) {
    return {
      basic: toRupees(gross),
      conveyance: 0,
      hra: 0,
      special_allowance: 0,
    };
  }

  const floor = toPaise(cfg.basicFloor);
  const byPercent = Math.round(percentOf(gross, cfg.basicPercentOfGross));
  const basic = Math.max(floor, byPercent);

  const afterBasic = gross - basic;
  const conveyance = Math.min(afterBasic, toPaise(cfg.conveyanceCap));

  const afterConveyance = afterBasic - conveyance;
  const hra = Math.min(afterConveyance, toPaise(cfg.hraCap));

  const special = afterConveyance - hra;

  return {
    basic: toRupees(basic),
    conveyance: toRupees(conveyance),
    hra: toRupees(hra),
    special_allowance: toRupees(special),
  };
}

/** Daily salary. A month is 26 salary days, so this is Gross / 26. */
function dailySalary(grossRupees, config = CONFIG) {
  const gross = Number(grossRupees);
  if (!Number.isFinite(gross)) return null;
  const days = config.salary.salaryDaysPerMonth;
  if (!days) return null;
  return Math.round((gross / days) * 100) / 100;
}

/**
 * Validate a MANUAL breakup against the rules a manual breakup may not break.
 *
 * Returns `{ valid, errors, requiresOverride }`. It never repairs a breakup:
 * a manual entry that does not add up is refused, not adjusted, because
 * adjusting it would hand back a structure nobody chose.
 *
 * THE GROSS IS FIXED. A manual override redistributes a gross; it cannot
 * change it. Changing pay is a new salary revision, which is a different
 * action with a different approval.
 */
function validateManualBreakup(grossRupees, components = {}, options = {}, config = CONFIG) {
  const cfg = config.salary;
  const errors = [];

  const gross = toPaise(grossRupees);
  if (gross === null || gross < 0) {
    return { valid: false, errors: ["Monthly gross must be a non-negative number"], requiresOverride: false };
  }

  const names = ["basic", "conveyance", "hra", "special_allowance"];
  const parts = {};
  for (const name of names) {
    const p = toPaise(components[name]);
    if (p === null) {
      errors.push(`${name} must be a number`);
    } else if (p < 0) {
      errors.push(`${name} cannot be negative`);
    }
    parts[name] = p;
  }
  if (errors.length > 0) return { valid: false, errors, requiresOverride: false };

  const sum = names.reduce((total, name) => total + parts[name], 0);
  if (sum !== gross) {
    errors.push(
      `Components must add up to the monthly gross: ${toRupees(sum)} entered against a gross of ${toRupees(gross)}`
    );
  }

  const conveyanceCap = toPaise(cfg.conveyanceCap);
  if (parts.conveyance > conveyanceCap) {
    errors.push(`Conveyance cannot exceed ${cfg.conveyanceCap}`);
  }

  const hraCap = toPaise(cfg.hraCap);
  if (parts.hra > hraCap) {
    errors.push(`HRA cannot exceed ${cfg.hraCap}`);
  }

  /*
   * Deviation from the AUTOMATIC BASIC is the thing that needs a reason.
   *
   * Basic is the PF wage basis, so moving it moves the provident fund — that
   * is a statutory consequence and it has to be explained by a person and
   * audited. Shifting money between HRA and Special Allowance within the caps
   * changes no contribution at all, so it is a redistribution rather than an
   * override and the rule does not demand a reason for it.
   */
  const automatic = calculateBreakup(grossRupees, config);
  const basicDeviates = parts.basic !== toPaise(automatic.basic);

  const overrideFlag = options.manual_override === true || options.manual_override === 1;
  const reason = typeof options.override_reason === "string" ? options.override_reason.trim() : "";

  if (basicDeviates && !overrideFlag) {
    errors.push(
      `Basic differs from the automatic breakup (${automatic.basic}); this needs the manual override to be set`
    );
  }
  if (basicDeviates && overrideFlag && reason === "") {
    errors.push("A reason is required when Basic differs from the automatic breakup");
  }

  return {
    valid: errors.length === 0,
    errors,
    requiresOverride: basicDeviates,
    automatic,
  };
}

/* -------------------------------------------------------------------- PF */

/**
 * ISOLATED NUANCE — whether EPS applies, and to whom.
 *
 * Everything about the pension scheme that is not simple arithmetic lives in
 * this one function, because the approved task asks for exactly that: where a
 * rule cannot be proven from current project material, isolate it and report
 * the unresolved point rather than guessing.
 *
 * Three questions, in order:
 *
 *   1. Is the employee in the provident fund at all? If PF applicability has
 *      not been recorded, nothing downstream is knowable.
 *   2. Have they reached the EPS exit age? Pension membership ceases at 58 and
 *      the employer's whole share goes to EPF from then on. Needs a DOB.
 *   3. Are they a post-cutoff joiner above the pension wage ceiling? Somebody
 *      who was NOT ALREADY AN EPS MEMBER on or after the cutoff, earning above
 *      the ceiling, cannot join EPS. This is the question `previous_eps_member`
 *      exists to answer, and when it has not been recorded the answer is
 *      genuinely unknown.
 *
 * THE MEMBERSHIP FACT IS `previous_eps_member`, NOT `previous_pf_member`.
 * Official EPFO Form 11 asks the two questions separately — "Whether earlier a
 * member of the Employees' Provident Fund Scheme, 1952" and "Whether earlier a
 * member of the Employees' Pension Scheme, 1995" — because they genuinely have
 * different answers. Somebody can have been an EPF member without ever having
 * been an EPS member: an international worker, an excluded employee, or
 * anybody who joined the fund above the pension wage ceiling after the cutoff
 * and was therefore kept out of EPS at that employer too. Reading a prior EPF
 * membership as a prior EPS membership would file those people into the
 * pension scheme on an inference nobody made, so this function reads the EPS
 * fact and only the EPS fact. `previous_pf_member` remains the separate EPF
 * history fact and no rule here consults it.
 *
 * WHEN THE SPLIT IS UNRESOLVED THE EMPLOYER TOTAL STILL IS NOT. The employer
 * pays 12% either way; only its division between EPF and EPS is in question.
 * So an unresolved EPS does not make the CTC unknown, and the engine is
 * careful to keep the two facts apart.
 */
function resolveEpsEligibility(context = {}, config = CONFIG) {
  const cfg = config.pf;

  const pfApplicable = triState(context.pf_applicable);
  if (pfApplicable === null) {
    return { eligible: null, unresolved: UNRESOLVED.PF_APPLICABILITY_NOT_RECORDED };
  }
  if (pfApplicable === false) {
    return { eligible: false, reason: "PF is not applicable to this employee" };
  }

  const asOf = toDateOnly(context.as_of) || toDateOnly(context.effective_from);
  const age = ageYearsOn(context.dob, asOf);
  if (age === null) {
    return { eligible: null, unresolved: UNRESOLVED.EPS_DOB_NOT_RECORDED };
  }
  if (age >= cfg.epsExitAgeYears) {
    return { eligible: false, reason: `EPS membership ceases at ${cfg.epsExitAgeYears}` };
  }

  /*
   * The ceiling test comes BEFORE the membership test on purpose. At or below
   * the pension wage ceiling the membership history does not matter — the
   * employee is eligible either way — so an unrecorded `previous_eps_member`
   * is only an unresolved answer for the people it can actually change, which
   * in this structure means a Basic above the ceiling.
   */
  const pfWage = toPaise(context.pf_wage);
  const epsCeiling = toPaise(cfg.epsWageCeiling);
  if (pfWage !== null && pfWage <= epsCeiling) {
    return { eligible: true, reason: "Pension wage is at or below the EPS ceiling" };
  }

  const doj = toDateOnly(context.date_of_joining);
  if (doj === null) {
    return { eligible: null, unresolved: UNRESOLVED.EPS_MEMBERSHIP_NOT_RECORDED };
  }
  if (!isOnOrAfter(doj, cfg.newMemberCutoffDate)) {
    return { eligible: true, reason: "Joined before the new-member cutoff" };
  }

  /*
   * ONLY the EPS fact decides this. `previous_pf_member` is deliberately not
   * consulted, in either direction: a recorded prior EPF membership does not
   * establish a prior EPS membership, and this engine does not turn one into
   * the other. An unrecorded EPS history is reported as unresolved, which is a
   * question on a screen rather than a pension position nobody took.
   */
  const previousEpsMember = triState(context.previous_eps_member);
  if (previousEpsMember === null) {
    return { eligible: null, unresolved: UNRESOLVED.EPS_MEMBERSHIP_NOT_RECORDED };
  }
  if (previousEpsMember === true) {
    return { eligible: true, reason: "Existing EPS member before the cutoff" };
  }
  return {
    eligible: false,
    reason: "Not an EPS member before the cutoff, above the EPS wage ceiling",
  };
}

/**
 * The provident fund block.
 *
 * THE WAGE BASIS IS BASIC ONLY. Not gross, not basic + DA — there is no DA in
 * this structure. Contributions are computed on `min(basic, ceiling)` when the
 * ceiling applies, which is the modelled Daily Needs configuration.
 */
function calculatePf(context = {}, config = CONFIG) {
  const cfg = config.pf;

  const basic = toPaise(context.basic);
  if (basic === null || basic < 0) {
    throw new Error("Basic is required to calculate PF");
  }

  const pfApplicable = triState(context.pf_applicable);

  if (pfApplicable === null) {
    return {
      status: STATUS.PENDING,
      unresolved: [{ code: UNRESOLVED.PF_APPLICABILITY_NOT_RECORDED, component: "pf" }],
      pf_wage: null,
      employee_pf: null,
      employer_pf_total: null,
      employer_epf: null,
      employer_eps: null,
      edli: null,
      pf_admin_charge: null,
    };
  }

  if (pfApplicable === false) {
    return {
      status: STATUS.NOT_APPLICABLE,
      unresolved: [],
      pf_wage: 0,
      employee_pf: 0,
      employer_pf_total: 0,
      employer_epf: 0,
      employer_eps: 0,
      edli: 0,
      pf_admin_charge: 0,
    };
  }

  const ceiling = toPaise(cfg.wageCeiling);
  const pfWage = cfg.applyCeilingToWage ? Math.min(basic, ceiling) : basic;

  const employeePf = roundContribution(percentOf(pfWage, cfg.employeeRatePercent), config.rounding.contributionRounding);
  const employerTotal = roundContribution(
    percentOf(pfWage, cfg.employerRatePercent),
    config.rounding.contributionRounding
  );

  const edliWage = Math.min(pfWage, toPaise(cfg.edliWageCeiling));
  const edli = roundContribution(percentOf(edliWage, cfg.edliRatePercent), config.rounding.contributionRounding);
  const admin = roundContribution(percentOf(pfWage, cfg.adminRatePercent), config.rounding.contributionRounding);

  const eps = resolveEpsEligibility({ ...context, pf_wage: toRupees(pfWage) }, config);

  const unresolved = [];
  let employerEps = null;
  let employerEpf = null;

  if (eps.eligible === true) {
    const epsWage = Math.min(pfWage, toPaise(cfg.epsWageCeiling));
    employerEps = roundContribution(percentOf(epsWage, cfg.epsRatePercent), config.rounding.contributionRounding);
    /*
     * EPF IS THE REMAINDER, NEVER ITS OWN PERCENTAGE. Computing it as
     * 3.67% would let rounding put the two halves a rupee away from the
     * employer total, which is the sort of difference that surfaces as a
     * reconciliation failure months later.
     */
    employerEpf = employerTotal - employerEps;
  } else if (eps.eligible === false) {
    employerEps = 0;
    employerEpf = employerTotal;
  } else {
    unresolved.push({ code: eps.unresolved, component: "employer_eps" });
  }

  return {
    status: STATUS.APPLIED,
    unresolved,
    pf_wage: toRupees(pfWage),
    employee_pf: toRupees(employeePf),
    employer_pf_total: toRupees(employerTotal),
    employer_epf: toRupees(employerEpf),
    employer_eps: toRupees(employerEps),
    edli: toRupees(edli),
    pf_admin_charge: toRupees(admin),
    eps_eligibility: eps,
  };
}

/* ------------------------------------------- the statutory wage definition */

/**
 * STATUTORY WAGES — the Code on Social Security, 2020 definition, and the ONE
 * implementation of it.
 *
 * Every contribution charged on "wages" is charged on this, not on the gross
 * and not on a convenient subset of the structure:
 *
 *   wages = total remuneration
 *         − the heads of remuneration the Code excludes
 *         + the 50% proviso's add-back
 *
 * THE EXCLUSIONS ARE A LIST OF WHAT COMES OUT, never a list of what goes in
 * (`config/statutory.js#wages.excludedComponents`). The Code makes all
 * remuneration wages except what it specifically excludes, so a component
 * added to the structure next quarter is wages by default and cannot be left
 * out of the contribution base by nobody having thought about it. That is also
 * why nothing below names `hra` or `conveyance`.
 *
 * THE 50% PROVISO. If the excluded heads come to more than half of total
 * remuneration, the EXCESS OVER THAT HALF — not the whole of the excluded
 * amount — is added back to wages. The arithmetic below computes the excess
 * explicitly rather than jumping to the equivalent `max(included, half)`,
 * because the add-back is the number somebody reconciling a contribution asks
 * for, and it is returned beside the wage for exactly that reason.
 *
 * IT IS NOT A BOUND. The figure this returns is the wage a contribution is
 * charged on. (It replaces an earlier `esiWageBounds`, which was a
 * deliberately conservative LOWER BOUND for deciding "definitely above the
 * coverage ceiling" and was never the statutory wage.)
 *
 * @param components the four component amounts, in rupees
 * @param totalRemunerationRupees everything paid for the period — the monthly
 *        gross in the Salary Master's standard case, the payable remuneration
 *        in a payrun's
 */
function statutoryWages(components = {}, totalRemunerationRupees, config = CONFIG) {
  const cfg = config.wages;
  const total = toPaise(totalRemunerationRupees);
  if (total === null || total < 0) return null;

  const excludedComponents = {};
  let excluded = 0;
  for (const name of cfg.excludedComponents || []) {
    const amount = toPaise(components[name]) || 0;
    excludedComponents[name] = toRupees(amount);
    excluded += amount;
  }

  /*
   * Bad data cannot be allowed to produce a negative wage: components that sum
   * to more than the remuneration they came out of is a broken record, and the
   * honest floor for it is zero rather than a contribution on a negative wage.
   */
  excluded = Math.min(Math.max(excluded, 0), total);
  const included = total - excluded;

  const floor = Math.round(percentOf(total, cfg.minimumPercentOfRemuneration));
  const addBack = excluded > floor ? excluded - floor : 0;

  return {
    total_remuneration: toRupees(total),
    excluded_remuneration: toRupees(excluded),
    excluded_components: excludedComponents,
    included_remuneration: toRupees(included),
    minimum_percent_of_remuneration: cfg.minimumPercentOfRemuneration,
    /** The proviso's floor, and the amount added back to reach it. Both, because one alone does not explain the other. */
    minimum_wages: toRupees(floor),
    add_back: toRupees(addBack),
    statutory_wages: toRupees(included + addBack),
  };
}

/* ------------------------------------------------------------------- ESI */

/**
 * The ESI block.
 *
 * TWO WAGES, ONE ARITHMETIC. ESI is charged on what is actually paid in a wage
 * period, which includes overtime and other per-period inputs a salary
 * structure knows nothing about. So there are two honest answers, not one:
 *
 *   ACTUAL    the caller supplies `esi_wage` — the payable wage a monthly
 *             payrun worked out after attendance and deductions. This is the
 *             authoritative figure and the one a payrun must keep using.
 *   STANDARD  no wage is supplied, so the wage is the one this SALARY
 *             STRUCTURE implies for a full month: `statutoryWages` above,
 *             applied to the approved monthly gross.
 *
 * The rates, the ceiling, the low-wage exemption and the rounding are the same
 * in both cases — only the wage differs — so both go through `contributionsFor`
 * below and there is one implementation of the statutory rule.
 *
 * WHY STANDARD IS NOT PENDING. The Salary Master has to be able to state an
 * employee's standard monthly cost the moment their salary is approved; a
 * figure that the structure fully determines is not an open question, and
 * showing it as Pending until a payrun happens to run reports a known number
 * as unknown. What genuinely cannot be answered from the employee master — has
 * anybody recorded whether this employee is in the scheme at all — is still
 * PENDING with its own named reason.
 *
 * `esi_wage_basis` says which of the two a caller is looking at, so a standard
 * amount is never mistaken for a month's actual liability.
 */
function calculateEsi(context = {}, config = CONFIG) {
  const cfg = config.esi;

  const esiApplicable = triState(context.esi_applicable);

  if (esiApplicable === false) {
    return {
      status: STATUS.NOT_APPLICABLE,
      unresolved: [],
      esi_wage: 0,
      employee_esi: 0,
      employer_esi: 0,
    };
  }

  const pending = (code, extra = {}) => ({
    status: STATUS.PENDING,
    unresolved: [{ code, component: "esi" }],
    esi_wage: null,
    employee_esi: null,
    employer_esi: null,
    ...extra,
  });

  const ceiling = toPaise(cfg.coverageCeiling);

  /**
   * The contribution pair for a wage, in paise. THE ONLY place the ESI rates,
   * the exemption and the rounding are applied — the actual wage a payrun
   * supplies and the standard wage this structure implies are the same
   * arithmetic on a different number, and one implementation is what keeps
   * them from drifting apart.
   */
  const contributionsFor = (wage, basis) => {
    const covered = context.contribution_period_continues === true || wage <= ceiling;
    if (!covered) {
      return {
        status: STATUS.NOT_APPLICABLE,
        unresolved: [],
        esi_wage: toRupees(wage),
        esi_wage_basis: basis,
        employee_esi: 0,
        employer_esi: 0,
        reason: "Wage is above the ESI coverage ceiling",
      };
    }

    const employerEsi = roundContribution(
      percentOf(wage, cfg.employerRatePercent),
      config.rounding.contributionRounding
    );

    /*
     * The low-wage exemption: the EMPLOYEE pays nothing below the daily-wage
     * threshold and the EMPLOYER still pays in full. An exemption that zeroed
     * both would understate the employer cost, so the two are decided apart.
     */
    const daily = Number(toRupees(wage)) / config.salary.salaryDaysPerMonth;
    const exempt =
      context.employee_contribution_exempt === true || daily <= cfg.employeeExemptionDailyWage;

    const employeeEsi = exempt
      ? 0
      : roundContribution(percentOf(wage, cfg.employeeRatePercent), config.rounding.contributionRounding);

    return {
      status: STATUS.APPLIED,
      unresolved: [],
      esi_wage: toRupees(wage),
      esi_wage_basis: basis,
      employee_esi: toRupees(employeeEsi),
      employer_esi: toRupees(employerEsi),
      employee_contribution_exempt: exempt,
    };
  };

  /*
   * A wage the caller can prove beats every inference below. This is the path
   * a monthly payrun takes, and it stays authoritative: nothing here lets the
   * standard figure override a wage that was actually worked out.
   */
  const supplied = toPaise(context.esi_wage);
  if (supplied !== null) {
    if (esiApplicable === null && supplied > ceiling) {
      // Above the ceiling nobody is covered, so the unrecorded flag cannot change the answer.
      return {
        status: STATUS.NOT_APPLICABLE,
        unresolved: [],
        esi_wage: toRupees(supplied),
        esi_wage_basis: ESI_WAGE_BASIS.PAYROLL,
        employee_esi: 0,
        employer_esi: 0,
        reason: "Wage is above the ESI coverage ceiling",
      };
    }
    if (esiApplicable === null) {
      return pending(UNRESOLVED.ESI_APPLICABILITY_NOT_RECORDED);
    }

    return contributionsFor(supplied, ESI_WAGE_BASIS.PAYROLL);
  }

  /*
   * No wage supplied, so this is the Salary Master asking what a full standard
   * month costs. The wage is the statutory wage definition applied to the
   * approved structure for a whole month — the same definition a payrun
   * applies to what is actually payable — and it decides the coverage ceiling
   * question too, because the ceiling is a ceiling on wages.
   */
  const wageDefinition = statutoryWages(context, context.gross, config);
  const standard = wageDefinition === null ? null : toPaise(wageDefinition.statutory_wages);

  if (standard === null) {
    /*
     * No usable remuneration to apply the definition to. Nothing about this
     * employee has been decided, so it is a question and not a zero.
     */
    return pending(UNRESOLVED.ESI_WAGE_CONTEXT_UNAVAILABLE);
  }

  if (standard > ceiling && context.contribution_period_continues !== true) {
    return {
      status: STATUS.NOT_APPLICABLE,
      unresolved: [],
      esi_wage: 0,
      employee_esi: 0,
      employer_esi: 0,
      wage_definition: wageDefinition,
      reason: "Standard statutory wages are above the ESI coverage ceiling",
    };
  }

  if (esiApplicable === null) {
    return pending(UNRESOLVED.ESI_APPLICABILITY_NOT_RECORDED);
  }

  /*
   * NOT PENDING. Whether this employee is in the scheme is recorded and the
   * structure fixes the wage, so the standard monthly contribution is a known
   * number and is reported as one. A payrun still computes its own from the
   * wage actually payable, and the two are allowed to differ.
   *
   * `contributionsFor` re-checks the ceiling — and must, because a continuing
   * contribution period keeps somebody covered above it, which is exactly the
   * case the return above steps around rather than deciding.
   */
  return {
    ...contributionsFor(standard, ESI_WAGE_BASIS.STANDARD),
    wage_definition: wageDefinition,
  };
}

/* ------------------------------------------------------------------- CTC */

/**
 * Monthly CTC = Gross + the employer's statutory costs.
 *
 * THE EMPLOYEE'S OWN PF AND ESI ARE NOT ADDED. They are deductions FROM the
 * gross, already inside it; adding them again is the classic way to overstate
 * a CTC by several thousand rupees a month.
 *
 * A CTC with an unresolved employer cost in it is not a CTC, so this returns
 * `PENDING` and a null amount rather than a subtotal that reads like a
 * finished number.
 */
function calculateCtc(grossRupees, pf, esi) {
  const gross = toPaise(grossRupees);
  const pending = [];

  const employerCosts = [
    ["employer_pf_total", pf.employer_pf_total],
    ["edli", pf.edli],
    ["pf_admin_charge", pf.pf_admin_charge],
    ["employer_esi", esi.employer_esi],
  ];

  let total = gross;
  for (const [name, value] of employerCosts) {
    if (value === null || value === undefined) {
      pending.push(name);
      continue;
    }
    total += toPaise(value);
  }

  if (pending.length > 0) {
    return { status: STATUS.PENDING, monthly_ctc: null, pending_components: pending };
  }
  return { status: STATUS.APPLIED, monthly_ctc: toRupees(total), pending_components: [] };
}

/* ------------------------------------- stored records from before the fix */

/**
 * A record's OWN rates, as a config object.
 *
 * Every salary row carries the snapshot that produced it, precisely so that it
 * can be re-read years later without the current `config/statutory.js` being
 * mistaken for the rates in force when it was calculated. Anything the
 * snapshot does not carry falls back to the live config.
 */
function configFromSnapshot(snapshot, config = CONFIG) {
  const snap = snapshot && typeof snapshot === "object" ? snapshot : {};
  const pick = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
  return {
    ...config,
    salary: {
      ...config.salary,
      salaryDaysPerMonth: pick(snap.salary_days_per_month, config.salary.salaryDaysPerMonth),
    },
    esi: {
      ...config.esi,
      employeeRatePercent: pick(snap.esi_employee_rate_percent, config.esi.employeeRatePercent),
      employerRatePercent: pick(snap.esi_employer_rate_percent, config.esi.employerRatePercent),
      coverageCeiling: pick(snap.esi_coverage_ceiling, config.esi.coverageCeiling),
      employeeExemptionDailyWage: pick(
        snap.esi_employee_exemption_daily_wage,
        config.esi.employeeExemptionDailyWage
      ),
    },
    /*
     * THE WAGE DEFINITION TOO, and it is the one place the fallback does real
     * work: a row written before the Code definition was implemented has no
     * wage-definition keys to honour — it never held an ESI wage at all — so
     * the definition in force now is the right one to apply to it.
     */
    wages: {
      ...config.wages,
      excludedComponents: Array.isArray(snap.wage_excluded_components)
        ? snap.wage_excluded_components
        : config.wages.excludedComponents,
      minimumPercentOfRemuneration: pick(
        snap.wage_minimum_percent_of_remuneration,
        config.wages.minimumPercentOfRemuneration
      ),
      effectiveFrom: snap.wage_definition_effective_from || config.wages.effectiveFrom,
    },
    rounding: {
      ...config.rounding,
      contributionRounding: snap.contribution_rounding || config.rounding.contributionRounding,
    },
  };
}

/**
 * Fill in the standard ESI and CTC on a record stored BEFORE ESI had a
 * standard basis.
 *
 * Rows written by the earlier engine carry `esi_status = PENDING` and a
 * `ESI_WAGE_CONTEXT_UNAVAILABLE` note — the engine of the day declined to
 * state a contribution without a payroll wage. That is exactly the figure the
 * Salary Master now shows, and it is fully determined by the record's own
 * gross, components and snapshot, so those rows are completed at READ time
 * rather than being rewritten: a salary record is history, and nothing here
 * changes what was approved or when.
 *
 * ONLY THAT ONE NOTE. Any other unresolved reason — nobody recorded ESI
 * applicability, nobody recorded the EPS membership — is a real open question
 * and is left exactly as it is. A row the current engine wrote never reaches
 * the arithmetic below, because the current engine cannot produce that note
 * for a record that has a gross.
 */
function fillStandardEsi(record, config = CONFIG) {
  if (!record || record.esi_status !== STATUS.PENDING) return record;

  const notes = Array.isArray(record.unresolved_notes) ? record.unresolved_notes : [];
  const stale = notes.filter(
    (n) => n && n.component === "esi" && n.code === UNRESOLVED.ESI_WAGE_CONTEXT_UNAVAILABLE
  );
  if (stale.length !== notes.filter((n) => n && n.component === "esi").length) return record;
  if (stale.length === 0) return record;

  const cfg = configFromSnapshot(record.statutory_snapshot, config);
  const esi = calculateEsi(
    {
      // Applicability is not re-decided: this note could only have been
      // written for an employee already recorded as ESI applicable.
      esi_applicable: true,
      gross: record.monthly_gross,
      // EVERY COMPONENT TRAVELS. The statutory wage definition is a rule about
      // the whole structure, so handing it a subset would compute a different
      // wage from the one a record created today gets on the same numbers.
      basic: record.basic,
      conveyance: record.conveyance,
      hra: record.hra,
      special_allowance: record.special_allowance,
    },
    cfg
  );
  if (esi.status === STATUS.PENDING) return record;

  const ctc = calculateCtc(
    record.monthly_gross,
    {
      employer_pf_total: record.employer_pf_total,
      edli: record.edli,
      pf_admin_charge: record.pf_admin_charge,
    },
    esi
  );

  return {
    ...record,
    esi_status: esi.status,
    esi_wage: esi.esi_wage,
    employee_esi: esi.employee_esi,
    employer_esi: esi.employer_esi,
    monthly_ctc: ctc.monthly_ctc,
    ctc_status: ctc.status,
    // The ESI question is answered, so its note goes. Every other note stays.
    unresolved_notes: notes.filter((n) => !stale.includes(n)),
  };
}

/* ------------------------------------------------------ effective dating */

/**
 * The Effective From an employee's FIRST salary record carries: the later of
 * the opening floor and their date of joining.
 *
 * A joiner from 2019 does not get a salary history claiming to start in 2019,
 * and somebody joining in 2027 does not get one backdated to the floor.
 */
function resolveOpeningEffectiveFrom(dateOfJoining, config = CONFIG) {
  const floor = toDateOnly(config.salary.openingEffectiveFloor);
  const doj = toDateOnly(dateOfJoining);
  if (!doj) return floor;
  return laterOf(floor, doj);
}

/* --------------------------------------------------------- the whole thing */

/**
 * Calculate a complete salary from a gross and an employee's statutory context.
 *
 * This is the function the API exposes as a preview and the function the
 * create path uses to fill a record, so a preview cannot disagree with what is
 * saved a second later.
 *
 * `manual_components` is the ONLY way a caller influences the components, and
 * even then the four amounts are validated before anything statutory is
 * computed from them.
 */
function calculateSalary(input = {}, config = CONFIG) {
  const gross = Number(input.monthly_gross);
  if (!Number.isFinite(gross) || gross < 0) {
    return { valid: false, errors: ["Monthly gross must be a non-negative number"] };
  }

  let components;
  let manualOverride = false;
  let overrideReason = null;

  if (input.manual_components) {
    const check = validateManualBreakup(gross, input.manual_components, input, config);
    if (!check.valid) return { valid: false, errors: check.errors };

    components = {
      basic: Number(input.manual_components.basic),
      conveyance: Number(input.manual_components.conveyance),
      hra: Number(input.manual_components.hra),
      special_allowance: Number(input.manual_components.special_allowance),
    };
    manualOverride = true;
    overrideReason = check.requiresOverride ? String(input.override_reason).trim() : (input.override_reason || null);
  } else {
    components = calculateBreakup(gross, config);
  }

  const statutoryContext = {
    ...components,
    gross,
    pf_applicable: input.pf_applicable,
    esi_applicable: input.esi_applicable,
    /*
     * BOTH history facts travel, and they are not interchangeable. The EPS
     * split reads `previous_eps_member` and nothing else; `previous_pf_member`
     * is carried because it is part of the statutory context a later phase
     * (EPF transfer, Form 11 generation) will need, not because any rule here
     * consults it.
     */
    previous_pf_member: input.previous_pf_member,
    previous_eps_member: input.previous_eps_member,
    dob: input.dob,
    date_of_joining: input.date_of_joining,
    as_of: input.as_of || input.effective_from,
    effective_from: input.effective_from,
    esi_wage: input.esi_wage,
    contribution_period_continues: input.contribution_period_continues,
    employee_contribution_exempt: input.employee_contribution_exempt,
  };

  const pf = calculatePf(statutoryContext, config);
  const esi = calculateEsi(statutoryContext, config);
  const ctc = calculateCtc(gross, pf, esi);

  const unresolved = [...pf.unresolved, ...esi.unresolved];

  return {
    valid: true,
    errors: [],
    monthly_gross: Math.round(gross * 100) / 100,
    daily_salary: dailySalary(gross, config),
    components,
    manual_override: manualOverride,
    override_reason: overrideReason,
    pf,
    esi,
    monthly_ctc: ctc.monthly_ctc,
    ctc_status: ctc.status,
    ctc_pending_components: ctc.pending_components,
    unresolved,
    /*
     * The snapshot. A salary record has to be able to explain itself years
     * later, when the rates in `config/statutory.js` have moved on - so the
     * numbers that produced it travel WITH it rather than being looked up
     * again at read time.
     */
    statutory_snapshot: {
      config_version: config.configVersion,
      salary_days_per_month: config.salary.salaryDaysPerMonth,
      basic_floor: config.salary.basicFloor,
      basic_percent_of_gross: config.salary.basicPercentOfGross,
      conveyance_cap: config.salary.conveyanceCap,
      hra_cap: config.salary.hraCap,
      breakup_threshold: config.salary.breakupThreshold,
      pf_employee_rate_percent: config.pf.employeeRatePercent,
      pf_employer_rate_percent: config.pf.employerRatePercent,
      pf_eps_rate_percent: config.pf.epsRatePercent,
      pf_edli_rate_percent: config.pf.edliRatePercent,
      pf_admin_rate_percent: config.pf.adminRatePercent,
      pf_wage_ceiling: config.pf.wageCeiling,
      pf_eps_wage_ceiling: config.pf.epsWageCeiling,
      pf_eps_exit_age_years: config.pf.epsExitAgeYears,
      pf_new_member_cutoff_date: config.pf.newMemberCutoffDate,
      pf_apply_ceiling_to_wage: config.pf.applyCeilingToWage,
      esi_employee_rate_percent: config.esi.employeeRatePercent,
      esi_employer_rate_percent: config.esi.employerRatePercent,
      esi_coverage_ceiling: config.esi.coverageCeiling,
      esi_employee_exemption_daily_wage: config.esi.employeeExemptionDailyWage,
      /*
       * WHICH DEFINITION OF WAGES produced the contributions on this record.
       * A rate change is visible in a number; a change to what counts as wages
       * is not, so it travels with the record explicitly.
       */
      wage_definition_effective_from: config.wages.effectiveFrom,
      wage_excluded_components: [...config.wages.excludedComponents],
      wage_minimum_percent_of_remuneration: config.wages.minimumPercentOfRemuneration,
      contribution_rounding: config.rounding.contributionRounding,
    },
  };
}

module.exports = {
  STATUS,
  ESI_WAGE_BASIS,
  UNRESOLVED,
  calculateBreakup,
  dailySalary,
  validateManualBreakup,
  resolveEpsEligibility,
  calculatePf,
  statutoryWages,
  calculateEsi,
  calculateCtc,
  configFromSnapshot,
  fillStandardEsi,
  resolveOpeningEffectiveFrom,
  calculateSalary,
  // exported for tests and for callers that need the same date handling
  toDateOnly,
  ageYearsOn,
  laterOf,
  triState,
};
