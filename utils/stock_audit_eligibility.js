/**
 * Stock Audit - WHO, IF ANYONE, EARNS THE ARTICLE INCENTIVE. Pure.
 *
 * One (audit cycle, store, article) earns at most ONE employee incentive.
 * Who earns it is decided from the employee ALLOTMENT and any AUTHORIZED
 * REASSIGNMENT in RetailPilot, the ORIGINAL counting employee, recounts,
 * cancellations and corrections - never simply "whoever finalized first".
 *
 * Until the data that settles it is available, the article is
 * PENDING_ELIGIBILITY_REVIEW, with every reason listed. Today allotment is
 * not readable, so with the default policy (requireAllotment) every article
 * is pending; the reasons still tell a clean single count from an ambiguous
 * one, so the review can be prioritised.
 *
 * A reviewer's decision (sa_eligibility) overrides the computed status. The
 * database enforces the "at most one" rule (sa_incentive_article primary key
 * on cycle, store, article), so even concurrent runs cannot award twice.
 */

const { compareTs } = require("./stock_audit_queries");
const { DEFAULT_POLICY } = require("./stock_audit_policy");

const ELIGIBILITY = Object.freeze({
  ELIGIBLE: "ELIGIBLE",
  PENDING_ELIGIBILITY_REVIEW: "PENDING_ELIGIBILITY_REVIEW",
  NOT_ELIGIBLE: "NOT_ELIGIBLE",
  EXCLUDED: "EXCLUDED",
  NOT_APPLICABLE: "NOT_APPLICABLE",
});

const WHY = Object.freeze({
  ALLOTMENT_UNAVAILABLE: "ALLOTMENT_UNAVAILABLE",
  RECOUNT_CLASSIFICATION_PENDING: "RECOUNT_CLASSIFICATION_PENDING",
  MULTIPLE_FINALIZED_COUNTS: "MULTIPLE_FINALIZED_COUNTS",
  MULTIPLE_COUNTERS: "MULTIPLE_COUNTERS",
  CANCELLED_BY_OTHER_USER: "CANCELLED_BY_OTHER_USER",
  EMPLOYEE_UNMAPPED: "EMPLOYEE_UNMAPPED",
  NO_CYCLE: "NO_CYCLE",
  COUNTED_BY_NON_ALLOTTED_EMPLOYEE: "COUNTED_BY_NON_ALLOTTED_EMPLOYEE",
  OUTSIDE_PROGRAMME: "OUTSIDE_PROGRAMME",
  NO_FINALIZED_COUNT: "NO_FINALIZED_COUNT",
  BEFORE_EFFECTIVE_DATE: "BEFORE_EFFECTIVE_DATE",
  REVIEWED: "REVIEWED",
});

const counterOf = (s) => s.finalized_by || s.initiated_by || null;

/**
 * @param group.sessions   ALL mirrored sessions of one (store, article) in the cycle window,
 *                         any status: { rp_slug, status, finalized_by, initiated_by, finalized_at, started_at }
 * @param group.outletId   DNDS outlet, or null when the store is unmapped
 * @param group.cycleId    or null
 * @param group.allotment  null = not available; else { rp_user_id, reassignments: [{ to_rp_user_id, authorized: bool }] }
 * @param group.review     a reviewer decision { decision: "AWARD" | "NOT_ELIGIBLE", employee_id?, rp_user_id? } or null
 * @param deps.employeeOf  (rpUserId) => employee_id | null
 * @param deps.isRecount   (session) => true | false | null  (null = cannot tell yet)
 * @returns { status, reasons, employee_id, rp_user_id, original_session, sessions }
 */
function evaluateArticle(group, { employeeOf, isRecount = () => null }, policy = DEFAULT_POLICY) {
  const { sessions = [], outletId, cycleId, allotment = null, review = null } = group;
  const base = { employee_id: null, rp_user_id: null, original_session: null, sessions: sessions.map((s) => s.rp_slug) };

  if (outletId == null || !policy.programme.outletIds.includes(outletId)) {
    return { ...base, status: ELIGIBILITY.EXCLUDED, reasons: [WHY.OUTSIDE_PROGRAMME] };
  }

  const finalized = sessions
    .filter((s) => s.status === "FINALIZED" && s.finalized_at)
    .sort((a, b) => compareTs(a.finalized_at, b.finalized_at) || (a.rp_slug < b.rp_slug ? -1 : 1));
  if (!finalized.length) return { ...base, status: ELIGIBILITY.NOT_APPLICABLE, reasons: [WHY.NO_FINALIZED_COUNT] };

  const classified = finalized.map((s) => ({ s, recount: isRecount(s) }));
  const originals = classified.filter((c) => c.recount !== true).map((c) => c.s);
  const original = originals[0] || finalized[0];
  const rpUser = counterOf(original);
  const employeeId = rpUser ? employeeOf(rpUser) : null;
  const found = { ...base, original_session: original.rp_slug, rp_user_id: rpUser, employee_id: employeeId };

  // The ORIGINAL audit's time decides: before the programme start it is never
  // eligible - a later recount or edit of it does not change that.
  if (policy.effectiveFrom && compareTs(original.finalized_at, policy.effectiveFrom) < 0) {
    return { ...found, employee_id: null, status: ELIGIBILITY.NOT_ELIGIBLE, reasons: [WHY.BEFORE_EFFECTIVE_DATE] };
  }

  if (review && review.decision === "NOT_ELIGIBLE") return { ...found, employee_id: null, status: ELIGIBILITY.NOT_ELIGIBLE, reasons: [WHY.REVIEWED] };
  if (review && review.decision === "AWARD" && review.employee_id != null) {
    return { ...found, employee_id: review.employee_id, rp_user_id: review.rp_user_id || rpUser, status: ELIGIBILITY.ELIGIBLE, reasons: [WHY.REVIEWED] };
  }

  const reasons = [];
  if (cycleId == null) reasons.push(WHY.NO_CYCLE);
  if (employeeId == null) reasons.push(WHY.EMPLOYEE_UNMAPPED);
  if (finalized.length > 1 && classified.some((c) => c.recount === null)) reasons.push(WHY.RECOUNT_CLASSIFICATION_PENDING);
  if (originals.length > 1) reasons.push(WHY.MULTIPLE_FINALIZED_COUNTS);
  // counters are PEOPLE: two RetailPilot ids mapped to one employee are one counter
  const counters = new Set(originals.map(counterOf).filter(Boolean).map((u) => (employeeOf(u) != null ? `e${employeeOf(u)}` : `r${u}`)));
  if (counters.size > 1) reasons.push(WHY.MULTIPLE_COUNTERS);
  const otherCancels = sessions.filter((s) => s.status === "CANCELLED" && counterOf(s) && counterOf(s) !== rpUser);
  const anyCancels = sessions.filter((s) => s.status === "CANCELLED");
  if (otherCancels.length || (!policy.eligibility.sameUserCancellationIsBenign && anyCancels.length)) reasons.push(WHY.CANCELLED_BY_OTHER_USER);

  if (allotment == null) {
    if (policy.eligibility.requireAllotment) reasons.push(WHY.ALLOTMENT_UNAVAILABLE);
  } else {
    const allottedTo = allotment.rp_user_id;
    const reassignedTo = (allotment.reassignments || []).filter((r) => r.authorized === true).map((r) => r.to_rp_user_id);
    const entitled = reassignedTo.length ? reassignedTo[reassignedTo.length - 1] : allottedTo;
    // the same EMPLOYEE under another RetailPilot user id is the allotted auditor
    const sameEmployee = rpUser === entitled || (employeeId != null && entitled != null && employeeOf(entitled) === employeeId);
    if (!sameEmployee) return { ...found, employee_id: null, status: ELIGIBILITY.NOT_ELIGIBLE, reasons: [WHY.COUNTED_BY_NON_ALLOTTED_EMPLOYEE] };
  }

  if (reasons.length) return { ...found, status: ELIGIBILITY.PENDING_ELIGIBILITY_REVIEW, reasons };
  return { ...found, status: ELIGIBILITY.ELIGIBLE, reasons: [] };
}

/** True when the only reason an article is pending is the missing allotment: a clean single count. */
const isCleanPending = (r) => r.status === ELIGIBILITY.PENDING_ELIGIBILITY_REVIEW && r.reasons.length === 1 && r.reasons[0] === WHY.ALLOTMENT_UNAVAILABLE;

/**
 * Group mirrored sessions by (store, article) and evaluate each group.
 * @param sessions mirrored sessions (any status) inside one cycle window
 * @param ctx.outletOf (rpStoreId) => outlet_id | null
 * @param ctx.cycleOf  (outletId, at) => cycle_id | null
 * @param ctx.allotmentOf (outletId, articleId) => allotment | null
 * @param ctx.reviewOf (cycleId, outletId, articleId) => review | null
 */
function evaluateAll(sessions, ctx, policy = DEFAULT_POLICY) {
  const groups = new Map();
  for (const s of sessions) {
    const key = `${s.rp_store_id}|${s.article_id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  const results = [];
  for (const list of groups.values()) {
    const first = list[0];
    const outletId = ctx.outletOf(first.rp_store_id);
    const anchor = list.find((s) => s.finalized_at) || first;
    const cycleId = outletId == null ? null : ctx.cycleOf(outletId, anchor.finalized_at || anchor.started_at);
    const r = evaluateArticle(
      {
        sessions: list,
        outletId,
        cycleId,
        allotment: ctx.allotmentOf ? ctx.allotmentOf(outletId, first.article_id) : null,
        review: ctx.reviewOf && cycleId != null ? ctx.reviewOf(cycleId, outletId, first.article_id) : null,
      },
      ctx,
      policy
    );
    results.push({ ...r, cycle_id: cycleId, outlet_id: outletId, article_id: first.article_id, rp_store_id: first.rp_store_id });
  }
  return results;
}

module.exports = { ELIGIBILITY, WHY, evaluateArticle, evaluateAll, isCleanPending, counterOf };
