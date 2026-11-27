/**
 * Stock Audit incentive POLICY - versioned data, validated here.
 *
 * Two layers, kept apart on purpose:
 *
 *   CONFIRMED  amounts and KPI allocations management confirmed on 27 Nov 2026.
 *              A policy version may not change them: validatePolicy refuses
 *              any version whose rates, maximums or allocations differ.
 *   SCORING    thresholds and calculation methods (what "achieved" means for
 *              each KPI, the recount verdict rule, match tolerance, movement
 *              handling). Configurable and VERSIONED (sa_rule_set). Nothing a
 *              policy produces is `final` until that version is APPROVED.
 *
 * The defaults below are a DRAFT proposal for the scoring layer.
 */

/** Confirmed 27 Nov 2026. Rupees. */
const CONFIRMED = Object.freeze({
  employeeSlabs: [
    { minAccuracyPct: 99, ratePerArticle: 1.1 },
    { minAccuracyPct: 97, ratePerArticle: 1.0 },
    { minAccuracyPct: 95, ratePerArticle: 0.5 },
  ],
  employeeBelowRate: 0,
  minSamplePct: 5,
  supervisor: { max: 1000, components: { completion_within_deadline: 200, employee_counting_accuracy: 300, independent_recount_verification: 500 } },
  storeManager: {
    max: 1500,
    components: { completion_within_deadline: 500, employee_counting_accuracy: 400, verification_quality_control: 200, stock_variance_investigation_closure: 400 },
  },
  operationsManager: {
    max: 2000,
    perStoreMax: 400,
    slabs: [
      { minScorePct: 98, amount: 400 },
      { minScorePct: 95, amount: 300 },
      { minScorePct: 90, amount: 200 },
    ],
    belowAmount: 0,
    noIndependentVerificationAmount: 0,
  },
});

/** Outlets in the programme: the five retail stores. The warehouse (outlet 2) is excluded. */
const PROGRAMME = Object.freeze({ outletIds: [3, 4, 5, 6, 7], excludedOutletIds: [2] });

const SCORING_TYPES = ["threshold", "linear", "slabs"];

/** Default policy (DRAFT): the confirmed layer + a proposed scoring layer. */
const DEFAULT_POLICY = Object.freeze({
  schema: 1,
  // The programme starts 25 Nov 2026, 00:00 IST. Eligibility is decided by
  // the ORIGINAL physical audit's timestamp: an older audit never becomes
  // eligible, whatever happens to it later (recount, modification).
  effectiveFrom: "2026-11-25T00:00:00+05:30",
  programme: { ...PROGRAMME },
  eligibility: {
    // Allotment is the basis for eligibility. While RetailPilot allotment is
    // not readable, every credit stays Pending Eligibility Review.
    requireAllotment: true,
    // A count cancelled and restarted by the SAME user (e.g. snapshot_moved)
    // is routine; cancelled by someone else it needs review.
    sameUserCancellationIsBenign: true,
  },
  employee: {
    slabs: CONFIRMED.employeeSlabs.map((s) => ({ ...s })),
    belowRatePerArticle: CONFIRMED.employeeBelowRate,
    minSamplePct: CONFIRMED.minSamplePct,
    // The sample counts UNIQUE articles, rounded up. Repeat recounts of one
    // article never add coverage.
    sampleBasis: "unique_articles",
    // Which recount decides an article when it was recounted more than once:
    //   earliest_resolved - the first recount that could be resolved (later
    //                       ones can never overturn it, so they cannot erase
    //                       an original counting error)
    //   any_mismatch      - a mismatch in any resolved recount
    recountVerdict: "earliest_resolved",
    requireIndependentRecount: true,
    match: { absQty: 0 },
    movements: {
      // Book-only entries, not physical movements. STK_ADJ is what the count
      // itself books; it never changes what is physically on the shelf.
      excludeActions: ["STK_ADJ"],
      // A movement this close to either count's instant cannot be placed
      // before or after it: the verification stays unresolved.
      ambiguityWindowSeconds: 120,
    },
  },
  management: {
    SUPERVISOR: {
      max: CONFIRMED.supervisor.max,
      components: [
        { key: "completion_within_deadline", max: 200, measure: "completion_within_deadline", scoring: { type: "threshold", minPct: 100 } },
        { key: "employee_counting_accuracy", max: 300, measure: "store_counting_accuracy", scoring: { type: "threshold", minPct: 97 } },
        { key: "independent_recount_verification", max: 500, measure: "sample_requirement_met", scoring: { type: "threshold", minPct: 100 } },
      ],
    },
    STORE_MANAGER: {
      max: CONFIRMED.storeManager.max,
      components: [
        { key: "completion_within_deadline", max: 500, measure: "completion_within_deadline", scoring: { type: "threshold", minPct: 100 } },
        { key: "employee_counting_accuracy", max: 400, measure: "store_counting_accuracy", scoring: { type: "threshold", minPct: 97 } },
        { key: "verification_quality_control", max: 200, measure: "verification_resolved", scoring: { type: "threshold", minPct: 95 } },
        { key: "stock_variance_investigation_closure", max: 400, measure: "variance_closed_in_time", params: { closeWithinDays: 7, minAbsValue: 0 }, scoring: { type: "threshold", minPct: 100 } },
      ],
    },
    OPERATIONS_MANAGER: {
      max: CONFIRMED.operationsManager.max,
      perStoreMax: CONFIRMED.operationsManager.perStoreMax,
      basis: "STORE_MANAGER_WEIGHTED_SCORE",
      slabs: CONFIRMED.operationsManager.slabs.map((s) => ({ ...s })),
      belowAmount: CONFIRMED.operationsManager.belowAmount,
    },
  },
});

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

function checkScoring(errors, where, scoring) {
  const t = scoring && scoring.type;
  if (!SCORING_TYPES.includes(t)) return errors.push(`${where}: scoring.type must be ${SCORING_TYPES.join(", ")}`);
  if (t === "threshold" && (!isNum(scoring.minPct) || scoring.minPct < 0 || scoring.minPct > 100)) errors.push(`${where}: threshold needs minPct 0-100`);
  if (t === "slabs") {
    const sl = scoring.slabs || [];
    if (!sl.length) errors.push(`${where}: slabs scoring needs slabs`);
    sl.forEach((s, i) => {
      if (!isNum(s.minPct) || !isNum(s.payPct) || s.payPct < 0 || s.payPct > 100) errors.push(`${where}.slabs[${i}] needs minPct and payPct 0-100`);
      if (i > 0 && !(s.minPct < sl[i - 1].minPct)) errors.push(`${where}: slabs must be in descending minPct order`);
    });
  }
}

function checkAllocation(errors, role, policyRole, confirmed) {
  if (!policyRole) return errors.push(`management.${role} is required`);
  if (policyRole.max !== confirmed.max) errors.push(`management.${role}.max must stay the confirmed ${confirmed.max}`);
  const comps = policyRole.components || [];
  const keys = comps.map((c) => c.key);
  const expected = Object.keys(confirmed.components);
  if (keys.length !== expected.length || expected.some((k) => !keys.includes(k))) {
    errors.push(`management.${role} components must be exactly: ${expected.join(", ")}`);
  }
  for (const c of comps) {
    if (confirmed.components[c.key] !== undefined && c.max !== confirmed.components[c.key]) {
      errors.push(`management.${role}.${c.key} must stay the confirmed ${confirmed.components[c.key]}`);
    }
    if (!c.measure) errors.push(`management.${role}.${c.key}: measure is required`);
    checkScoring(errors, `management.${role}.${c.key}`, c.scoring);
  }
}

/** Problems with a policy version, as strings. Empty = usable (not yet approved). */
function validatePolicy(p) {
  const errors = [];
  if (!p || p.schema !== 1) return ["schema must be 1"];
  if (!p.effectiveFrom || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(p.effectiveFrom)) errors.push("effectiveFrom must be an ISO timestamp with an offset");
  const prog = p.programme || {};
  if (!Array.isArray(prog.outletIds) || !prog.outletIds.length) errors.push("programme.outletIds is required");
  for (const id of prog.excludedOutletIds || []) if ((prog.outletIds || []).includes(id)) errors.push(`outlet ${id} is both in and excluded from the programme`);
  if (!(prog.excludedOutletIds || []).includes(2)) errors.push("the warehouse (outlet 2) must stay excluded");

  const e = p.employee || {};
  if (JSON.stringify((e.slabs || []).map((s) => [s.minAccuracyPct, s.ratePerArticle])) !== JSON.stringify(CONFIRMED.employeeSlabs.map((s) => [s.minAccuracyPct, s.ratePerArticle]))) {
    errors.push("employee slabs must stay the confirmed 99% Rs 1.10 / 97% Rs 1.00 / 95% Rs 0.50");
  }
  if (e.belowRatePerArticle !== CONFIRMED.employeeBelowRate) errors.push("employee rate below 95% must stay nil");
  if (e.minSamplePct !== CONFIRMED.minSamplePct) errors.push("minimum independent recount must stay 5%");
  if (e.sampleBasis !== "unique_articles") errors.push("sampleBasis must be unique_articles");
  if (!["earliest_resolved", "any_mismatch"].includes(e.recountVerdict)) errors.push("recountVerdict must be earliest_resolved or any_mismatch");
  if (e.requireIndependentRecount !== true) errors.push("requireIndependentRecount must stay true");
  if (!e.match || !isNum(e.match.absQty) || e.match.absQty < 0) errors.push("employee.match.absQty must be >= 0");
  const mv = e.movements || {};
  if (!Array.isArray(mv.excludeActions) || !mv.excludeActions.includes("STK_ADJ")) errors.push("movements.excludeActions must include STK_ADJ");
  if (!isNum(mv.ambiguityWindowSeconds) || mv.ambiguityWindowSeconds < 0) errors.push("movements.ambiguityWindowSeconds must be >= 0");

  const m = p.management || {};
  checkAllocation(errors, "SUPERVISOR", m.SUPERVISOR, CONFIRMED.supervisor);
  checkAllocation(errors, "STORE_MANAGER", m.STORE_MANAGER, CONFIRMED.storeManager);
  const om = m.OPERATIONS_MANAGER;
  const c = CONFIRMED.operationsManager;
  if (!om) errors.push("management.OPERATIONS_MANAGER is required");
  else {
    if (om.max !== c.max || om.perStoreMax !== c.perStoreMax) errors.push("Operations Manager maximums must stay Rs 2,000 and Rs 400 a store");
    if (JSON.stringify(om.slabs) !== JSON.stringify(c.slabs) || om.belowAmount !== c.belowAmount) errors.push("Operations Manager slabs must stay 98% 400 / 95% 300 / 90% 200 / below nil");
    if (om.basis !== "STORE_MANAGER_WEIGHTED_SCORE") errors.push("Operations Manager basis must be STORE_MANAGER_WEIGHTED_SCORE");
  }
  return errors;
}

/** A deep copy of the default, for a new draft version. */
const draftFromDefault = () => JSON.parse(JSON.stringify(DEFAULT_POLICY));

module.exports = { CONFIRMED, PROGRAMME, DEFAULT_POLICY, SCORING_TYPES, validatePolicy, draftFromDefault };
