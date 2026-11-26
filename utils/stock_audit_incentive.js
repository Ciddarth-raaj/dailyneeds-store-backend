/**
 * Stock Audit incentives - the rules as DATA and the arithmetic as pure
 * functions. Nothing here reads a database, calls RetailPilot or posts to
 * payroll.
 *
 * Confirmed by management on 27 Nov 2026:
 *   Employee, per unique article audited, by counting accuracy:
 *     99% and above -> Rs 1.10 | 97% to < 99% -> Rs 1.00 | 95% to < 97% -> Rs 0.50 | below 95% -> nil
 *   Minimum independent random recount: 5% of each employee's audited articles.
 *   Supervisor max Rs 1,000 per store, Store Manager max Rs 1,500 per store,
 *   Operations Manager max Rs 2,000 across the five stores (Rs 400 a store).
 *
 * The KPI split and scoring below are DEFAULTS. They stay configurable, and
 * results are `final` only when the rule set carries `approved: true` (set
 * from an approved sa_rule_set row) - until then every figure is a draft.
 *
 * Accuracy is ONLY independent physical verification: a recount by someone
 * other than the original counter, compared with the ORIGINAL PHYSICAL COUNT.
 * System (book) stock never enters it, so a genuine shortage or excess -
 * where the original count and the recount agree - never lowers an
 * employee's incentive. No function here accepts a book quantity.
 *
 * Money is computed in paise (integers) and returned in rupees.
 */

const DEFAULT_RULES = Object.freeze({
  approved: false,
  employee: {
    slabs: [
      { minAccuracyPct: 99, ratePerArticle: 1.1 },
      { minAccuracyPct: 97, ratePerArticle: 1.0 },
      { minAccuracyPct: 95, ratePerArticle: 0.5 },
    ],
    belowRatePerArticle: 0,
    minSamplePct: 5,
    minSampleArticles: 1,
    requireIndependentRecount: true,
    // A recount matches the original count when they differ by at most this.
    match: { absQty: 0 },
  },
  management: {
    SUPERVISOR: {
      scope: "store",
      max: 1000,
      components: [
        { key: "completion_within_deadline", max: 200, scoring: { type: "binary" } },
        { key: "employee_counting_accuracy", max: 300, scoring: { type: "binary" } },
        { key: "independent_recount_verification", max: 500, scoring: { type: "binary" } },
      ],
    },
    STORE_MANAGER: {
      scope: "store",
      max: 1500,
      components: [
        { key: "completion_within_deadline", max: 500, scoring: { type: "binary" } },
        { key: "overall_counting_accuracy", max: 400, scoring: { type: "binary" } },
        { key: "verification_quality_control", max: 200, scoring: { type: "binary" } },
        { key: "variance_investigation_closure", max: 400, scoring: { type: "binary" } },
      ],
    },
    OPERATIONS_MANAGER: {
      scope: "chain",
      max: 2000,
      perStoreMax: 400,
      basis: "STORE_MANAGER_WEIGHTED_SCORE",
      requireIndependentStoreVerification: true,
      slabs: [
        { minScorePct: 98, amount: 400 },
        { minScorePct: 95, amount: 300 },
        { minScorePct: 90, amount: 200 },
      ],
      belowAmount: 0,
    },
  },
});

const toPaise = (rupees) => Math.round(Number(rupees) * 100);
const toRupees = (paise) => paise / 100;
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/** Problems with a rule set, as strings. Empty = usable. */
function validateRules(rules) {
  const errors = [];
  const e = rules && rules.employee;
  if (!e || !Array.isArray(e.slabs) || !e.slabs.length) errors.push("employee.slabs is required");
  else {
    e.slabs.forEach((s, i) => {
      if (!isNum(s.minAccuracyPct) || s.minAccuracyPct < 0 || s.minAccuracyPct > 100) errors.push(`employee.slabs[${i}].minAccuracyPct must be 0-100`);
      if (!isNum(s.ratePerArticle) || s.ratePerArticle < 0) errors.push(`employee.slabs[${i}].ratePerArticle must be >= 0`);
      if (i > 0 && !(s.minAccuracyPct < e.slabs[i - 1].minAccuracyPct)) errors.push("employee.slabs must be in descending minAccuracyPct order");
    });
  }
  if (e && (!isNum(e.minSamplePct) || e.minSamplePct <= 0 || e.minSamplePct > 100)) errors.push("employee.minSamplePct must be > 0 and <= 100");
  if (e && (!e.match || !isNum(e.match.absQty) || e.match.absQty < 0)) errors.push("employee.match.absQty must be >= 0");

  const m = (rules && rules.management) || {};
  for (const role of ["SUPERVISOR", "STORE_MANAGER"]) {
    const r = m[role];
    if (!r) { errors.push(`management.${role} is required`); continue; }
    const keys = new Set();
    let sum = 0;
    for (const c of r.components || []) {
      if (!c.key || keys.has(c.key)) errors.push(`management.${role}: component keys must be present and unique`);
      keys.add(c.key);
      if (!isNum(c.max) || c.max < 0) errors.push(`management.${role}.${c.key}: max must be >= 0`);
      sum += c.max || 0;
      const t = c.scoring && c.scoring.type;
      if (!["binary", "linear", "slabs"].includes(t)) errors.push(`management.${role}.${c.key}: scoring.type must be binary, linear or slabs`);
      if (t === "slabs") {
        const sl = c.scoring.slabs || [];
        if (!sl.length) errors.push(`management.${role}.${c.key}: slabs scoring needs slabs`);
        sl.forEach((s, i) => {
          if (!isNum(s.minPct) || !isNum(s.payPct) || s.payPct < 0 || s.payPct > 100) errors.push(`management.${role}.${c.key}.slabs[${i}] needs minPct and payPct 0-100`);
          if (i > 0 && !(s.minPct < sl[i - 1].minPct)) errors.push(`management.${role}.${c.key}: slabs must be in descending minPct order`);
        });
      }
    }
    if (sum > r.max) errors.push(`management.${role}: components add up to ${sum}, above the maximum ${r.max}`);
  }
  const om = m.OPERATIONS_MANAGER;
  if (!om) errors.push("management.OPERATIONS_MANAGER is required");
  else {
    (om.slabs || []).forEach((s, i, a) => {
      if (!isNum(s.minScorePct) || !isNum(s.amount) || s.amount < 0) errors.push(`OPERATIONS_MANAGER.slabs[${i}] needs minScorePct and amount >= 0`);
      if (s.amount > om.perStoreMax) errors.push(`OPERATIONS_MANAGER.slabs[${i}].amount is above perStoreMax`);
      if (i > 0 && !(s.minScorePct < a[i - 1].minScorePct)) errors.push("OPERATIONS_MANAGER.slabs must be in descending minScorePct order");
    });
  }
  return errors;
}

/**
 * Does a recount agree with the ORIGINAL PHYSICAL COUNT?
 * null when either quantity is missing: not decidable, not a mismatch.
 */
function isMatch(originalCountedQty, recountQty, match = DEFAULT_RULES.employee.match) {
  if (originalCountedQty == null || recountQty == null) return null;
  const a = Number(originalCountedQty);
  const b = Number(recountQty);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  // Compare in thousandths (quantities have 3 decimals) so 0.1 + 0.2 issues never decide a match.
  return Math.abs(Math.round(a * 1000) - Math.round(b * 1000)) <= Math.round(match.absQty * 1000);
}

/** Recount sample the employee needs: at least minSamplePct of credited articles, rounded up. */
function requiredSample(creditedArticles, rules = DEFAULT_RULES) {
  const e = rules.employee;
  if (!creditedArticles) return 0;
  return Math.max(e.minSampleArticles || 1, Math.ceil((creditedArticles * e.minSamplePct) / 100));
}

/**
 * One employee's incentive for one cycle.
 *
 * @param creditedArticles unique articles credited to them (after the duplicate guard)
 * @param verifications    [{ isMatch: true|false|null, independent: true|false }]
 *                         one per recounted article of theirs
 * @returns { status, creditedArticles, rechecked, matched, requiredSample,
 *            accuracyPct, ratePerArticle, amount, final }
 *   status: NO_ARTICLES | PENDING_VERIFICATION | INSUFFICIENT_SAMPLE | CALCULATED
 *   amount is null unless CALCULATED (or 0 for NO_ARTICLES).
 */
function employeeIncentive({ creditedArticles, verifications = [] }, rules = DEFAULT_RULES) {
  const e = rules.employee;
  const credited = Number(creditedArticles) || 0;
  const usable = verifications.filter((v) => v && (v.isMatch === true || v.isMatch === false) && (!e.requireIndependentRecount || v.independent === true));
  const rechecked = usable.length;
  const matched = usable.filter((v) => v.isMatch === true).length;
  const need = requiredSample(credited, rules);
  const base = { creditedArticles: credited, rechecked, matched, requiredSample: need, final: rules.approved === true };

  if (credited === 0) return { ...base, status: "NO_ARTICLES", accuracyPct: null, ratePerArticle: 0, amount: 0 };
  if (rechecked === 0) return { ...base, status: "PENDING_VERIFICATION", accuracyPct: null, ratePerArticle: null, amount: null };
  const accuracyPct = (matched * 100) / rechecked;
  if (rechecked < need) return { ...base, status: "INSUFFICIENT_SAMPLE", accuracyPct, ratePerArticle: null, amount: null };

  // Exact slab test in integers: matched/rechecked >= min/100  <=>  matched*100 >= min*rechecked.
  const slab = e.slabs.find((s) => matched * 100 * 1000 >= Math.round(s.minAccuracyPct * 1000) * rechecked);
  const ratePerArticle = slab ? slab.ratePerArticle : e.belowRatePerArticle;
  const amount = toRupees(toPaise(ratePerArticle) * credited);
  return { ...base, status: "CALCULATED", accuracyPct, ratePerArticle, amount };
}

/** Pay share (0-100) of one component from its measured result. */
function componentPayPct(component, result) {
  const sc = component.scoring || { type: "binary" };
  if (!result) return 0;
  const pct = isNum(result.achievedPct) ? Math.max(0, Math.min(100, result.achievedPct)) : null;
  if (sc.type === "binary") {
    if (typeof result.achieved === "boolean") return result.achieved ? 100 : 0;
    return pct != null && pct >= (isNum(sc.thresholdPct) ? sc.thresholdPct : 100) ? 100 : 0;
  }
  if (pct == null) return 0;
  if (sc.type === "linear") return pct;
  const slab = (sc.slabs || []).find((s) => pct >= s.minPct);
  return slab ? slab.payPct : 0;
}

/**
 * Supervisor or Store Manager incentive for one store and cycle.
 * @param results { [componentKey]: { achieved?: boolean, achievedPct?: number } }
 * @returns { role, components: [{ key, max, payPct, amount }], amount, weightedScorePct, missing, final }
 */
function managementIncentive(role, results = {}, rules = DEFAULT_RULES) {
  const r = rules.management[role];
  if (!r || r.scope !== "store") throw new Error(`Not a store-level role: ${role}`);
  const components = r.components.map((c) => {
    const payPct = componentPayPct(c, results[c.key]);
    return { key: c.key, max: c.max, payPct, amount: toRupees(Math.round((toPaise(c.max) * payPct) / 100)) };
  });
  const totalMax = components.reduce((s, c) => s + c.max, 0);
  const paise = Math.min(components.reduce((s, c) => s + toPaise(c.amount), 0), toPaise(r.max));
  const weightedScorePct = totalMax ? components.reduce((s, c) => s + c.payPct * c.max, 0) / totalMax : 0;
  const missing = r.components.filter((c) => !results[c.key]).map((c) => c.key);
  return { role, components, amount: toRupees(paise), weightedScorePct, missing, final: rules.approved === true };
}

/**
 * Operations Manager: per store, a slab on the Store Manager's weighted KPI
 * score, paid only where the store's independent verification was done.
 * @param stores [{ outletId, storeManagerScorePct, independentVerification: boolean }]
 */
function operationsManagerIncentive(stores = [], rules = DEFAULT_RULES) {
  const om = rules.management.OPERATIONS_MANAGER;
  const perStore = stores.map((s) => {
    if (om.requireIndependentStoreVerification && s.independentVerification !== true) {
      return { outletId: s.outletId, scorePct: s.storeManagerScorePct, amount: 0, reason: "no independent store verification" };
    }
    if (!isNum(s.storeManagerScorePct)) return { outletId: s.outletId, scorePct: null, amount: 0, reason: "no Store Manager score" };
    const slab = om.slabs.find((x) => s.storeManagerScorePct >= x.minScorePct);
    return { outletId: s.outletId, scorePct: s.storeManagerScorePct, amount: Math.min(slab ? slab.amount : om.belowAmount, om.perStoreMax) };
  });
  const amount = Math.min(perStore.reduce((t, s) => t + s.amount, 0), om.max);
  return { role: "OPERATIONS_MANAGER", perStore, amount, final: rules.approved === true };
}

module.exports = {
  DEFAULT_RULES,
  validateRules,
  isMatch,
  requiredSample,
  employeeIncentive,
  managementIncentive,
  operationsManagerIncentive,
  componentPayPct,
};
