/**
 * Stock Audit - ACTUAL employee-wise and store-wise progress for one audit
 * period, from mirrored RetailPilot sessions + the imported allotment +
 * recount verifications. Pure: the repository loads, this decides.
 *
 * The figures and their shape are the ones the screens show (each figure a
 * status cell). Rules, in one place:
 *   - a session belongs to the store cycle whose dates (IST) contain its
 *     finalize time; only FINALIZED sessions are audits
 *   - one (store cycle, article) is audited once: by its ORIGINAL counter
 *     (utils/stock_audit_eligibility.js), whatever recounts follow
 *   - allotment comes ONLY from confirmed CSV imports; without one, allotted,
 *     pending and completion are Unavailable - never 0, never 100%
 *   - audits are matched to the allotment on Store + Auditor + Article
 *   - accuracy comes ONLY from independent recounts, never book stock
 *   - shortage / excess are reported, and feed no incentive or ranking
 *   - completion within deadline stays Pending until the deadline has passed
 */
const S = require("./stock_audit_status");
const { DEFAULT_POLICY } = require("./stock_audit_policy");
const { evaluateAll, ELIGIBILITY, WHY } = require("./stock_audit_eligibility");
const { articleVerdict, VERDICT, requiredSample } = require("./stock_audit_verification");
const I = require("./stock_audit_incentive");
const { istDate } = require("./stock_audit_activity");

const LABELS = {
  completion_within_deadline: "Audit completion within deadline",
  employee_counting_accuracy: "Employee counting accuracy",
  independent_recount_verification: "Independent recount and verification",
  verification_quality_control: "Verification quality control",
};
const ROLE_TITLE = { SUPERVISOR: "Supervisor", STORE_MANAGER: "Store Manager" };

const pct = (a, b) => (b > 0 ? (a * 100) / b : null);
const cellPct = (a, b, reasonIfNone) => (b > 0 ? S.available(pct(a, b)) : S.notApplicable(reasonIfNone));
const sum = (list, f) => list.reduce((t, x) => t + f(x), 0);
const at = (s) => s.finalized_at || s.started_at;

/** End of a DATE in IST, as a UTC ISO string - "within the deadline" means up to then. */
const endOfIstDay = (date) => new Date(Date.parse(`${date}T23:59:59.999+05:30`)).toISOString();

/** Estimate cell in the screen's shape (never payable). */
function estimateView(e) {
  const tag = (c) => (S.isKnown(c) ? { ...c, estimate: true } : c);
  return { basis: e.basis, sample: e.sample, base: e.base_articles, accuracy: e.accuracy, rate: e.rate, estimate: tag(e.estimate), projected: tag(e.projected), maxSoFar: e.max_so_far };
}

/**
 * @param input.cycles      [{ cycle_id, outlet_id, name, period_code, start_date, end_date, deadline, status }]
 * @param input.stores      [{ outlet_id, name, rp_id }]
 * @param input.sessions    mirrored sessions of those outlets: { rp_slug, rp_store_id, outlet_id, article_id, status,
 *                          initiated_by, finalized_by, started_at, finalized_at, var_qty, var_value }
 * @param input.allotment   current allotment rows: { cycle_id, rp_user_id, article_id, effective }
 * @param input.allotmentCycles Set of cycle_id with a confirmed import
 * @param input.people      Map rp_user_id -> { employee_id, name, designation }   (mapped users only)
 * @param input.rpNames     Map rp_user_id -> RetailPilot name
 * @param input.verifications [{ cycle_id, outlet_id, article_id, original_session_slug, recount_user, verdict, recount_at, ... }]
 * @param input.reviews     Map "cycle|outlet|article" -> { decision, employee_id }
 * @param input.roleHolders Map outlet_id -> { SUPERVISOR: {employee_id, name} | null, STORE_MANAGER: ... }
 * @param input.independentVerification Map outlet_id -> true | false | null
 * @param input.today       IST date YYYY-MM-DD
 * @param input.asOf        ISO timestamp (now)
 */
function computePeriod(input, policy = DEFAULT_POLICY) {
  const { cycles, stores, sessions = [], allotment = [], allotmentCycles = new Set(), people = new Map(), rpNames = new Map(),
    verifications = [], reviews = new Map(), roleHolders = new Map(), independentVerification = new Map(), today, asOf } = input;

  const storeById = new Map(stores.map((s) => [s.outlet_id, s]));
  const cycleByOutlet = new Map(cycles.map((c) => [c.outlet_id, c]));
  const cycleOf = (outletId, ts) => {
    const c = cycleByOutlet.get(outletId);
    if (!c || !ts) return null;
    const d = istDate(ts);
    return d >= c.start_date && d <= c.end_date ? c.cycle_id : null;
  };

  // ---- sessions inside the period's store cycles
  const inPeriod = sessions.filter((s) => s.outlet_id != null && cycleOf(s.outlet_id, at(s)) != null);

  // ---- allotment
  const allotByCycle = new Map(); // cycle -> Map article -> rp_user (auditable)
  const allotByUser = new Map(); // "outlet|user" -> { auditable:Set, notAuditable:number }
  const outletOfCycle = new Map(cycles.map((c) => [c.cycle_id, c.outlet_id]));
  for (const a of allotment) {
    const outletId = outletOfCycle.get(a.cycle_id);
    if (outletId == null) continue;
    const k = `${outletId}|${a.rp_user_id}`;
    if (!allotByUser.has(k)) allotByUser.set(k, { auditable: new Set(), notAuditable: 0 });
    if (a.effective === "Y") {
      allotByUser.get(k).auditable.add(Number(a.article_id));
      if (!allotByCycle.has(a.cycle_id)) allotByCycle.set(a.cycle_id, new Map());
      allotByCycle.get(a.cycle_id).set(Number(a.article_id), a.rp_user_id);
    } else allotByUser.get(k).notAuditable += 1;
  }
  const hasAllotment = (outletId) => {
    const c = cycleByOutlet.get(outletId);
    return Boolean(c && allotmentCycles.has(c.cycle_id));
  };

  // ---- eligibility (who earns each article)
  const outletOfRpStore = new Map(inPeriod.map((s) => [s.rp_store_id, s.outlet_id]));
  const employeeOf = (u) => (people.get(u) ? people.get(u).employee_id : null);
  const results = evaluateAll(
    inPeriod,
    {
      outletOf: (rpStore) => (outletOfRpStore.has(rpStore) ? outletOfRpStore.get(rpStore) : null),
      cycleOf,
      employeeOf,
      allotmentOf: (outletId, articleId) => {
        if (!hasAllotment(outletId)) return null;
        const c = cycleByOutlet.get(outletId);
        const owner = (allotByCycle.get(c.cycle_id) || new Map()).get(Number(articleId));
        return { rp_user_id: owner || null, reassignments: [] };
      },
      reviewOf: (cycleId, outletId, articleId) => reviews.get(`${cycleId}|${outletId}|${articleId}`) || null,
      isRecount: () => null, // decided once real RetailPilot recounts are inspected
    },
    policy
  );
  const sessionBySlug = new Map(inPeriod.map((s) => [s.rp_slug, s]));

  // ---- recount verdicts per ORIGINAL session
  const recountsByOriginal = new Map();
  for (const v of verifications) {
    if (!recountsByOriginal.has(v.original_session_slug)) recountsByOriginal.set(v.original_session_slug, []);
    recountsByOriginal.get(v.original_session_slug).push({ at: v.recount_at, verdict: v.verdict, ref: v.recount_ref });
  }

  // ---- per employee (store, RetailPilot user)
  const emp = new Map();
  const touch = (outletId, user) => {
    const k = `${outletId}|${user}`;
    if (!emp.has(k)) {
      emp.set(k, { outlet_id: outletId, rp_user_id: user, counted: new Set(), today: new Set(), ownAllotted: new Set(), ownByDeadline: new Set(),
        eligible: 0, hardPending: 0, pendingEligibility: 0, notEligible: 0, verdicts: [], allRecounts: [] });
    }
    return emp.get(k);
  };
  for (const [k] of allotByUser) {
    const [outletId, user] = k.split("|");
    touch(Number(outletId), user);
  }
  const storeAgg = new Map();
  const storeOf = (outletId) => {
    if (!storeAgg.has(outletId)) storeAgg.set(outletId, { audited: new Set(), today: new Set(), allottedAudited: new Set(), allottedByDeadline: new Set(), shortageQty: 0, shortageValue: 0, excessQty: 0, excessValue: 0, verdicts: [], allRecounts: [] });
    return storeAgg.get(outletId);
  };

  for (const r of results) {
    if (r.status === ELIGIBILITY.EXCLUDED || r.status === ELIGIBILITY.NOT_APPLICABLE || !r.original_session || r.cycle_id == null) continue;
    if (r.reasons.includes(WHY.BEFORE_EFFECTIVE_DATE)) continue;
    const s = sessionBySlug.get(r.original_session);
    const user = r.rp_user_id;
    const e = touch(r.outlet_id, user);
    const st = storeOf(r.outlet_id);
    const day = istDate(s.finalized_at);
    const cycle = cycleByOutlet.get(r.outlet_id);
    const article = Number(r.article_id);
    e.counted.add(article);
    st.audited.add(article);
    if (day === today) { e.today.add(article); st.today.add(article); }
    const owner = hasAllotment(r.outlet_id) ? (allotByCycle.get(cycle.cycle_id) || new Map()).get(article) : undefined;
    if (owner) {
      st.allottedAudited.add(article);
      if (day <= cycle.deadline) st.allottedByDeadline.add(article);
      if (owner === user) { e.ownAllotted.add(article); if (day <= cycle.deadline) e.ownByDeadline.add(article); }
    }
    if (r.status === ELIGIBILITY.ELIGIBLE) e.eligible += 1;
    else if (r.status === ELIGIBILITY.PENDING_ELIGIBILITY_REVIEW) {
      e.pendingEligibility += 1;
      if (r.reasons.some((x) => x !== WHY.ALLOTMENT_UNAVAILABLE)) e.hardPending += 1;
    } else if (r.status === ELIGIBILITY.NOT_ELIGIBLE) e.notEligible += 1;
    // variance as booked by RetailPilot (review only)
    const q = Number(s.var_qty) || 0;
    const val = Number(s.var_value) || 0;
    if (q < 0) { st.shortageQty += -q; st.shortageValue += -val; } else if (q > 0) { st.excessQty += q; st.excessValue += val; }
    // recounts of this original count
    const rec = recountsByOriginal.get(r.original_session) || [];
    if (rec.length) {
      const v = articleVerdict(rec, policy);
      if (v.verdict !== "NONE") { e.verdicts.push({ verdict: v.verdict }); st.verdicts.push({ verdict: v.verdict }); }
      for (const x of rec) { e.allRecounts.push(x); st.allRecounts.push(x); }
    }
  }

  // ---- employee rows
  const employees = [];
  for (const e of emp.values()) {
    if (!storeById.has(e.outlet_id)) continue;
    const store = storeById.get(e.outlet_id);
    const cycle = cycleByOutlet.get(e.outlet_id);
    const person = people.get(e.rp_user_id) || null;
    const withAllot = hasAllotment(e.outlet_id);
    const al = allotByUser.get(`${e.outlet_id}|${e.rp_user_id}`) || { auditable: new Set(), notAuditable: 0 };
    const allottedN = al.auditable.size;
    const audited = e.counted.size;
    const inc = I.employeeIncentive({ auditedArticles: audited, eligibleArticles: e.eligible, pendingEligibility: e.pendingEligibility, verdicts: e.verdicts }, policy);
    // Estimate base: the articles that can still earn - allotted to them (when allotment is imported), less hard review cases.
    const estBase = Math.max(0, (withAllot ? e.ownAllotted.size : audited) - e.hardPending);
    const est = I.estimateEmployeeIncentive({ auditedArticles: audited, pendingEligibility: audited - estBase, allottedArticles: withAllot ? allottedN : null, verdicts: e.verdicts }, policy);
    const unavailable = S.unavailable(S.REASON.ALLOTMENT_UNAVAILABLE);
    employees.push({
      employee_id: person ? person.employee_id : null,
      code: person ? String(person.employee_id) : null,
      rp_user_id: e.rp_user_id,
      name: person ? person.name : null,
      rp_name: rpNames.get(e.rp_user_id) || e.rp_user_id,
      designation: person ? person.designation || null : null,
      outlet_id: e.outlet_id,
      store: store.name,
      cycle_id: cycle ? cycle.cycle_id : null,
      allotted: withAllot ? allottedN : null,
      not_auditable: withAllot ? al.notAuditable : null,
      audited,
      audited_own: e.ownAllotted.size,
      audited_not_allotted: withAllot ? audited - e.ownAllotted.size : null,
      today: e.today.size,
      within_deadline: e.ownByDeadline.size,
      recount_required: requiredSample(audited, policy),
      recount_done: inc.sample.verified,
      recount_matched: inc.sample.matched,
      unresolved: inc.sample.unresolved,
      eligible: e.eligible,
      pending_eligibility: e.pendingEligibility,
      not_eligible: e.notEligible,
      allotted_c: withAllot ? S.available(allottedN) : unavailable,
      pending_c: withAllot ? S.available(Math.max(0, allottedN - e.ownAllotted.size)) : unavailable,
      completion_c: withAllot ? (allottedN ? S.available(pct(e.ownAllotted.size, allottedN)) : S.notApplicable(S.REASON.NO_ARTICLES)) : unavailable,
      within_deadline_c: withAllot ? S.available(e.ownByDeadline.size) : unavailable,
      accuracy: inc.accuracy,
      rate: inc.rate,
      estimated: inc.amount,
      provisional: inc.provisional_amount,
      calc_status: inc.status,
      sample: inc.sample,
      est: estimateView(est),
      approved_c: S.pending(S.REASON.NOT_APPROVED),
      payment: "NOT_STARTED",
    });
  }
  employees.sort((a, b) => a.outlet_id - b.outlet_id || b.audited - a.audited || String(a.rp_user_id).localeCompare(String(b.rp_user_id)));

  // ---- store rows
  const storeRows = stores.map((store) => {
    const cycle = cycleByOutlet.get(store.outlet_id) || null;
    const st = storeOf(store.outlet_id);
    const list = employees.filter((e) => e.outlet_id === store.outlet_id);
    const withAllot = hasAllotment(store.outlet_id);
    const allottedN = cycle && allotByCycle.get(cycle.cycle_id) ? allotByCycle.get(cycle.cycle_id).size : 0;
    const required = sum(list, (e) => e.recount_required);
    const doneCapped = sum(list, (e) => Math.min(e.recount_done, e.recount_required));
    const unavailable = S.unavailable(S.REASON.ALLOTMENT_UNAVAILABLE);
    const known = (c) => S.isKnown(c);
    return {
      outlet_id: store.outlet_id,
      name: store.name,
      rp_id: store.rp_id,
      cycle,
      employees: list,
      eligible_employees: list.length,
      participating: list.filter((e) => e.audited > 0).length,
      allotment_imported: withAllot,
      allotted: withAllot ? S.available(allottedN) : unavailable,
      audited_today: st.today.size,
      audited: st.audited.size,
      audited_allotted: st.allottedAudited.size,
      pending: withAllot ? S.available(Math.max(0, allottedN - st.allottedAudited.size)) : unavailable,
      completion: withAllot ? (allottedN ? S.available(pct(st.allottedAudited.size, allottedN)) : S.notApplicable(S.REASON.NO_ARTICLES)) : unavailable,
      completed_by_deadline_pct: withAllot && allottedN ? pct(st.allottedByDeadline.size, allottedN) : null,
      recount_required: required,
      recount_done: sum(list, (e) => e.recount_done),
      recount_progress: required ? S.available(pct(doneCapped, required)) : S.notApplicable(S.REASON.NO_ARTICLES),
      accuracy: I.measureStoreAccuracy(st.verdicts),
      verification_resolved: I.measureVerificationResolved(st.allRecounts),
      sample_met: I.measureSampleMet(list.map((e) => ({ audited: e.audited, verified: e.sample.verified, met: e.sample.met }))),
      shortage_qty: st.shortageQty,
      shortage_value: Math.round(st.shortageValue * 100) / 100,
      excess_qty: st.excessQty,
      excess_value: Math.round(st.excessValue * 100) / 100,
      estimated_employee: sum(list, (e) => (known(e.estimated) ? e.estimated.value : 0)),
      estimated_employee_pending: list.filter((e) => !known(e.estimated)).length,
      estimate_employee: Math.round(sum(list, (e) => (known(e.est.estimate) ? e.est.estimate.value : 0)) * 100) / 100,
      estimate_employee_none: list.filter((e) => !known(e.est.estimate)).length,
      independent_verification: independentVerification.has(store.outlet_id) ? independentVerification.get(store.outlet_id) : null,
    };
  });

  // ---- Supervisor / Store Manager / Operations Manager
  const management = storeRows.map((s) => {
    const cycle = s.cycle;
    const completion = !s.allotment_imported
      ? null
      : { completedByDeadlinePct: s.completed_by_deadline_pct == null ? 0 : s.completed_by_deadline_pct, deadline: cycle ? endOfIstDay(cycle.deadline) : null, asOf };
    const measures = {
      completion_within_deadline: s.allotment_imported && s.completed_by_deadline_pct == null ? S.notApplicable(S.REASON.NO_ARTICLES) : I.measureCompletion(completion),
      employee_counting_accuracy: s.accuracy,
      independent_recount_verification: s.sample_met,
      verification_quality_control: s.verification_resolved,
    };
    const holders = roleHolders.get(s.outlet_id) || {};
    const view = (role) => {
      const r = I.roleIncentive(role, measures, policy);
      const h = holders[role] || null;
      return {
        role,
        title: ROLE_TITLE[role],
        employee_id: h ? h.employee_id : null,
        name: h ? h.name : "Not assigned",
        components: r.components.map((c) => ({ ...c, label: LABELS[c.key] || c.key })),
        decidedAmount: r.decided_amount,
        amount: r.amount,
        weightedScore: r.weighted_score,
      };
    };
    return { store: s, supervisor: view("SUPERVISOR"), storeManager: view("STORE_MANAGER") };
  });
  const om = I.operationsManagerIncentive(
    management.map((m) => ({ outlet_id: m.store.outlet_id, storeManagerScore: m.storeManager.weightedScore, independentVerification: m.store.independent_verification })),
    policy
  );
  for (const m of management) m.om = (om.perStore.find((p) => p.outlet_id === m.store.outlet_id) || {}).amount || S.pending(S.REASON.COMPONENT_PENDING);

  // ---- Premier League KPIs (shortage / excess deliberately absent)
  const saplKpis = storeRows.map((s) => ({
    outlet_id: s.outlet_id,
    name: s.name,
    kpis: {
      completion: s.completion,
      accuracy: s.accuracy,
      recount: s.recount_progress,
      participation: cellPct(s.participating, s.eligible_employees, S.REASON.NO_DATA),
    },
  }));

  const issues = {
    unmapped_users: [...new Set(employees.filter((e) => e.employee_id == null).map((e) => e.rp_user_id))],
    before_effective_date: results.filter((r) => r.reasons.includes(WHY.BEFORE_EFFECTIVE_DATE)).length,
    outside_programme: results.filter((r) => r.status === ELIGIBILITY.EXCLUDED).length,
  };
  return { employees, stores: storeRows, management, operationsManager: om, saplKpis, eligibility: results, issues };
}

module.exports = { computePeriod, endOfIstDay };
