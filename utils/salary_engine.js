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

/* ------------------------------------------------------------------- ESI */

/**
 * ISOLATED NUANCE — what an ESI wage could be, given only a salary structure.
 *
 * The engine needs this for exactly one decision: can it say "outside the
 * scheme" WITHOUT a payroll wage? It can, but only when even the smallest wage
 * the structure could produce is already above the coverage ceiling.
 *
 * The lower bound is the gross less Conveyance, because travelling allowance
 * is outside the statutory definition of wages and Conveyance is this
 * structure's travelling allowance. If that exclusion is wrong the bound is
 * merely too low, and a bound that is too low can only cost an unresolved
 * answer — never a wrong contribution. That is why the flag defaults the way
 * it does and why this is the safe direction to be uncertain in.
 */
function esiWageBounds(components = {}, grossRupees, config = CONFIG) {
  const gross = toPaise(grossRupees);
  const conveyance = toPaise(components.conveyance) || 0;
  const minimum = config.esi.conveyanceExcludedFromWage ? gross - conveyance : gross;
  return { minimum_wage: toRupees(minimum), structural_wage: toRupees(gross) };
}

/**
 * The ESI block.
 *
 * IT WILL NOT INVENT A WAGE. ESI is charged on what is actually paid in a
 * wage period, which includes overtime and other per-period inputs that a
 * salary structure does not know about. Monthly payroll does not exist yet, so
 * for anybody who might be covered this returns PENDING with a named reason
 * rather than a number computed off the gross.
 *
 * The caller may supply `esi_wage` once payroll can, and the same function
 * then computes the contribution — that is the whole point of taking the wage
 * as context rather than deriving it.
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

  /*
   * A wage the caller can prove beats every inference below. This is the path
   * monthly payroll will take; the bound-based reasoning exists only because
   * that caller does not exist yet.
   */
  const supplied = toPaise(context.esi_wage);
  if (supplied !== null) {
    if (esiApplicable === null && supplied > ceiling) {
      // Above the ceiling nobody is covered, so the unrecorded flag cannot change the answer.
      return {
        status: STATUS.NOT_APPLICABLE,
        unresolved: [],
        esi_wage: toRupees(supplied),
        employee_esi: 0,
        employer_esi: 0,
        reason: "Wage is above the ESI coverage ceiling",
      };
    }
    if (esiApplicable === null) {
      return pending(UNRESOLVED.ESI_APPLICABILITY_NOT_RECORDED);
    }

    const covered = context.contribution_period_continues === true || supplied <= ceiling;
    if (!covered) {
      return {
        status: STATUS.NOT_APPLICABLE,
        unresolved: [],
        esi_wage: toRupees(supplied),
        employee_esi: 0,
        employer_esi: 0,
        reason: "Wage is above the ESI coverage ceiling",
      };
    }

    const employerEsi = roundContribution(
      percentOf(supplied, cfg.employerRatePercent),
      config.rounding.contributionRounding
    );

    /*
     * The low-wage exemption: the EMPLOYEE pays nothing below the daily-wage
     * threshold and the EMPLOYER still pays in full. An exemption that zeroed
     * both would understate the employer cost, so the two are decided apart.
     */
    const daily = Number(toRupees(supplied)) / config.salary.salaryDaysPerMonth;
    const exempt =
      context.employee_contribution_exempt === true || daily <= cfg.employeeExemptionDailyWage;

    const employeeEsi = exempt
      ? 0
      : roundContribution(percentOf(supplied, cfg.employeeRatePercent), config.rounding.contributionRounding);

    return {
      status: STATUS.APPLIED,
      unresolved: [],
      esi_wage: toRupees(supplied),
      employee_esi: toRupees(employeeEsi),
      employer_esi: toRupees(employerEsi),
      employee_contribution_exempt: exempt,
    };
  }

  /*
   * No wage supplied. The one thing still provable from the structure alone is
   * that somebody is too well paid to be covered at all.
   */
  const bounds = esiWageBounds(context, context.gross, config);
  const minimum = toPaise(bounds.minimum_wage);

  if (minimum !== null && minimum > ceiling) {
    return {
      status: STATUS.NOT_APPLICABLE,
      unresolved: [],
      esi_wage: 0,
      employee_esi: 0,
      employer_esi: 0,
      reason: "Even the lowest wage this structure can produce is above the coverage ceiling",
    };
  }

  if (esiApplicable === null) {
    return pending(UNRESOLVED.ESI_APPLICABILITY_NOT_RECORDED);
  }

  return pending(UNRESOLVED.ESI_WAGE_CONTEXT_UNAVAILABLE, {
    wage_bounds: bounds,
  });
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
      esi_conveyance_excluded_from_wage: config.esi.conveyanceExcludedFromWage,
      contribution_rounding: config.rounding.contributionRounding,
    },
  };
}

module.exports = {
  STATUS,
  UNRESOLVED,
  calculateBreakup,
  dailySalary,
  validateManualBreakup,
  resolveEpsEligibility,
  calculatePf,
  esiWageBounds,
  calculateEsi,
  calculateCtc,
  resolveOpeningEffectiveFrom,
  calculateSalary,
  // exported for tests and for callers that need the same date handling
  toDateOnly,
  ageYearsOn,
  laterOf,
  triState,
};
