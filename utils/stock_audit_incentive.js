/**
 * Stock Audit incentive CALCULATIONS. Pure: no database, no RetailPilot,
 * no payroll. Amounts and allocations come from the confirmed policy
 * (utils/stock_audit_policy.js); thresholds from its versioned scoring layer.
 *
 * Every figure is a status cell (utils/stock_audit_status.js). Anything not
 * decided - pending recounts, missing allotment, a KPI that cannot be
 * measured yet - is PENDING / UNAVAILABLE / NOT_APPLICABLE with a reason,
 * never 0 and never 100%. A role's total is AVAILABLE only when every one of
 * its components is decided. Nothing is `final` unless the policy version is
 * approved AND nothing is pending.
 *
 * Money is computed in paise (integers) and returned in rupees.
 */

const S = require("./stock_audit_status");
const { DEFAULT_POLICY } = require("./stock_audit_policy");
const { sampleOf, VERDICT } = require("./stock_audit_verification");
const { compareTs, toUtc } = require("./stock_audit_queries");

const paise = (rupees) => Math.round(Number(rupees) * 100);
const rupees = (p) => p / 100;

/** The slab rate for an exact accuracy (matched / verified), never rounded up into a slab. */
function rateFor(matched, verified, policy = DEFAULT_POLICY) {
  const slab = policy.employee.slabs.find((s) => matched * 100 * 1000 >= Math.round(s.minAccuracyPct * 1000) * verified);
  return slab ? slab.ratePerArticle : policy.employee.belowRatePerArticle;
}

/**
 * One employee, one cycle.
 * @param auditedArticles    unique articles they counted in the cycle (programme stores only) - the 5% base
 * @param eligibleArticles   of those, ELIGIBLE for their incentive
 * @param pendingEligibility of those, PENDING_ELIGIBILITY_REVIEW
 * @param verdicts           one per UNIQUE recounted article: { verdict } (utils/stock_audit_verification)
 */
function employeeIncentive({ auditedArticles = 0, eligibleArticles = 0, pendingEligibility = 0, verdicts = [] }, policy = DEFAULT_POLICY, { approved = false } = {}) {
  const sample = sampleOf(auditedArticles, verdicts, policy);
  const base = { audited: auditedArticles, eligible: eligibleArticles, pending_eligibility: pendingEligibility, sample, final: false, provisional_amount: null };

  if (!auditedArticles) {
    const na = S.notApplicable(S.REASON.NO_ARTICLES);
    return { ...base, status: "NOT_APPLICABLE", reason: S.REASON.NO_ARTICLES, accuracy: na, rate: na, amount: na };
  }
  if (sample.verified === 0) {
    const p = S.pending(S.REASON.PENDING_VERIFICATION);
    return { ...base, status: "PENDING_VERIFICATION", reason: S.REASON.PENDING_VERIFICATION, accuracy: p, rate: p, amount: p };
  }
  const accuracyPct = (sample.matched * 100) / sample.verified;
  if (!sample.met) {
    const p = S.pending(S.REASON.INSUFFICIENT_SAMPLE);
    return { ...base, status: "INSUFFICIENT_SAMPLE", reason: S.REASON.INSUFFICIENT_SAMPLE, accuracy: { ...S.available(accuracyPct), provisional: true }, rate: p, amount: p };
  }
  const rate = rateFor(sample.matched, sample.verified, policy);
  const amount = rupees(paise(rate) * eligibleArticles);
  if (pendingEligibility > 0) {
    return {
      ...base,
      status: "PENDING_ELIGIBILITY_REVIEW",
      reason: S.REASON.PENDING_ELIGIBILITY_REVIEW,
      accuracy: S.available(accuracyPct),
      rate: S.available(rate),
      amount: S.pending(S.REASON.PENDING_ELIGIBILITY_REVIEW),
      provisional_amount: amount,
    };
  }
  return { ...base, status: "CALCULATED", accuracy: S.available(accuracyPct), rate: S.available(rate), amount: S.available(amount), final: approved === true };
}

// ------------------------------------------------------------------ KPI measures

/** Allotment-based completion. Unavailable until RetailPilot allotment is readable. */
function measureCompletion(completion /* null | { completedPct, byDeadline: bool } */) {
  if (!completion) return S.unavailable(S.REASON.ALLOTMENT_UNAVAILABLE);
  return S.available(completion.byDeadline ? completion.completedPct : 0);
}

/** Store accuracy: matched / verified unique articles across the store's employees. */
function measureStoreAccuracy(verdicts = []) {
  const v = verdicts.filter((x) => x.verdict === VERDICT.MATCH || x.verdict === VERDICT.MISMATCH);
  if (!v.length) return S.pending(S.REASON.PENDING_VERIFICATION);
  return S.available((v.filter((x) => x.verdict === VERDICT.MATCH).length * 100) / v.length);
}

/** Share of the store's employees (with audited articles) whose 5% independent sample is met. */
function measureSampleMet(samples = []) {
  const withArticles = samples.filter((s) => s.audited > 0);
  if (!withArticles.length) return S.notApplicable(S.REASON.NO_ARTICLES);
  if (withArticles.every((s) => s.verified === 0)) return S.pending(S.REASON.PENDING_VERIFICATION);
  return S.available((withArticles.filter((s) => s.met).length * 100) / withArticles.length);
}

/** Verification quality control: share of the store's independent recounts that could be resolved. */
function measureVerificationResolved(recountVerdicts = []) {
  const independent = recountVerdicts.filter((r) => r.verdict !== VERDICT.NOT_INDEPENDENT);
  if (!independent.length) return S.pending(S.REASON.PENDING_VERIFICATION);
  const resolved = independent.filter((r) => r.verdict === VERDICT.MATCH || r.verdict === VERDICT.MISMATCH).length;
  return S.available((resolved * 100) / independent.length);
}

/**
 * Variance closure: share of variances closed within closeWithinDays of the count.
 * An open variance whose deadline has not passed yet keeps the measure PENDING.
 * @param variances [{ abs_value, finalized_at, closed_at | null }]
 */
function measureVarianceClosure(variances = [], params = {}, asOf) {
  const days = params.closeWithinDays == null ? 7 : params.closeWithinDays;
  const minAbs = params.minAbsValue || 0;
  const list = variances.filter((v) => Math.abs(Number(v.abs_value || 0)) >= minAbs);
  if (!list.length) return S.notApplicable(S.REASON.NO_VARIANCES);
  let inTime = 0;
  for (const v of list) {
    const due = new Date(Date.parse(toUtc(v.finalized_at).iso.slice(0, 23) + "Z") + days * 86400000).toISOString();
    if (v.closed_at) {
      if (compareTs(v.closed_at, due) <= 0) inTime += 1;
    } else if (compareTs(asOf, due) <= 0) {
      return S.pending(S.REASON.NO_DATA);
    }
  }
  return S.available((inTime * 100) / list.length);
}

// ------------------------------------------------------------------ scoring

/** Pay share of one component from its measure cell. A measure that is not AVAILABLE pays nothing YET: pending, not zero. */
function scoreComponent(component, measure) {
  if (!S.isKnown(measure)) {
    return { key: component.key, max: component.max, measure, payPct: null, amount: { ...measure } };
  }
  const pct = Math.max(0, Math.min(100, measure.value));
  const sc = component.scoring;
  let payPct = 0;
  if (sc.type === "threshold") payPct = pct >= sc.minPct ? 100 : 0;
  else if (sc.type === "linear") payPct = pct;
  else if (sc.type === "slabs") {
    const slab = sc.slabs.find((s) => pct >= s.minPct);
    payPct = slab ? slab.payPct : 0;
  }
  return { key: component.key, max: component.max, measure, payPct, amount: S.available(rupees(Math.round((paise(component.max) * payPct) / 100))) };
}

/**
 * Supervisor or Store Manager, one store, one cycle.
 * @param measures { [componentKey]: cell }
 */
function roleIncentive(role, measures = {}, policy = DEFAULT_POLICY, { approved = false } = {}) {
  const r = policy.management[role];
  if (!r || !r.components) throw new Error(`Not a store-level role: ${role}`);
  const components = r.components.map((c) => scoreComponent(c, measures[c.key] || S.pending(S.REASON.NO_DATA)));
  const decided = components.filter((c) => S.isKnown(c.amount));
  const decidedPaise = Math.min(decided.reduce((t, c) => t + paise(c.amount.value), 0), paise(r.max));
  const complete = decided.length === components.length;
  const totalMax = components.reduce((t, c) => t + c.max, 0);
  const weighted = complete ? components.reduce((t, c) => t + c.payPct * c.max, 0) / totalMax : null;
  return {
    role,
    components,
    decided_amount: rupees(decidedPaise),
    amount: complete ? S.available(rupees(decidedPaise)) : S.pending(S.REASON.COMPONENT_PENDING),
    weighted_score: complete ? S.available(weighted) : S.pending(S.REASON.COMPONENT_PENDING),
    final: complete && approved === true,
  };
}

/**
 * Operations Manager across the programme stores.
 * @param stores [{ outlet_id, storeManagerScore: cell, independentVerification: true | false | null }]
 */
function operationsManagerIncentive(stores = [], policy = DEFAULT_POLICY, { approved = false } = {}) {
  const om = policy.management.OPERATIONS_MANAGER;
  const perStore = stores.map((s) => {
    if (s.independentVerification === false) {
      return { outlet_id: s.outlet_id, score: s.storeManagerScore, amount: S.available(0), reason: S.REASON.INDEPENDENT_VERIFICATION_NOT_DONE };
    }
    if (s.independentVerification !== true) {
      return { outlet_id: s.outlet_id, score: s.storeManagerScore, amount: S.pending(S.REASON.INDEPENDENT_VERIFICATION_PENDING) };
    }
    if (!S.isKnown(s.storeManagerScore)) return { outlet_id: s.outlet_id, score: s.storeManagerScore, amount: S.pending(S.REASON.COMPONENT_PENDING) };
    const slab = om.slabs.find((x) => s.storeManagerScore.value >= x.minScorePct);
    return { outlet_id: s.outlet_id, score: s.storeManagerScore, amount: S.available(Math.min(slab ? slab.amount : om.belowAmount, om.perStoreMax)) };
  });
  const decided = perStore.filter((p) => S.isKnown(p.amount));
  const sum = Math.min(decided.reduce((t, p) => t + p.amount.value, 0), om.max);
  const complete = perStore.length > 0 && decided.length === perStore.length;
  return {
    role: "OPERATIONS_MANAGER",
    perStore,
    decided_amount: sum,
    amount: complete ? S.available(sum) : S.pending(perStore.length ? S.REASON.COMPONENT_PENDING : S.REASON.NO_DATA),
    final: complete && approved === true,
  };
}

module.exports = {
  rateFor,
  employeeIncentive,
  measureCompletion,
  measureStoreAccuracy,
  measureSampleMet,
  measureVerificationResolved,
  measureVarianceClosure,
  scoreComponent,
  roleIncentive,
  operationsManagerIncentive,
};
