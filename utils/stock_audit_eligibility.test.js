/**
 *   node --test utils/stock_audit_eligibility.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const E = require("./stock_audit_eligibility");
const P = require("./stock_audit_policy");

const staff = { u1: 101, u2: 102 };
const deps = { employeeOf: (u) => staff[u] ?? null };
const fin = (rp_slug, user, at, extra = {}) => ({ rp_slug, status: "FINALIZED", finalized_by: user, initiated_by: user, finalized_at: at, ...extra });
const g = (sessions, extra = {}) => ({ sessions, outletId: 7, cycleId: 9, allotment: null, review: null, ...extra });
const noAllotment = P.draftFromDefault(); noAllotment.eligibility.requireAllotment = false;

describe("programme effective date (25 Nov 2026 00:00 IST)", () => {
  it("an original audit one microsecond before the start is not eligible; at the start it is evaluated", () => {
    const before = E.evaluateArticle(g([fin("a", "u1", "2026-11-24T23:59:59.999999+05:30")]), deps, noAllotment);
    assert.equal(before.status, E.ELIGIBILITY.NOT_ELIGIBLE);
    assert.deepEqual(before.reasons, [E.WHY.BEFORE_EFFECTIVE_DATE]);
    assert.equal(E.evaluateArticle(g([fin("a", "u1", "2026-11-25T00:00:00+05:30")]), deps, noAllotment).status, E.ELIGIBILITY.ELIGIBLE);
    assert.equal(E.evaluateArticle(g([fin("a", "u1", "2026-11-24T18:30:00Z")]), deps, noAllotment).status, E.ELIGIBILITY.ELIGIBLE);
  });
  it("recounting an older audit after the start does not make it eligible", () => {
    const r = E.evaluateArticle(g([fin("a", "u1", "2026-11-24T20:00:00+05:30"), fin("r", "u2", "2026-11-26T10:00:00+05:30")]), { ...deps, isRecount: (s) => s.rp_slug === "r" }, noAllotment);
    assert.equal(r.status, E.ELIGIBILITY.NOT_ELIGIBLE);
    assert.equal(r.original_session, "a");
  });
});

describe("article eligibility", () => {
  it("never awards by 'first finalized': without allotment a clean single count is pending review", () => {
    const r = E.evaluateArticle(g([fin("a", "u1", "2026-11-26T10:00:00Z")]), deps);
    assert.equal(r.status, E.ELIGIBILITY.PENDING_ELIGIBILITY_REVIEW);
    assert.deepEqual(r.reasons, [E.WHY.ALLOTMENT_UNAVAILABLE]);
    assert.ok(E.isCleanPending(r));
  });
  it("two counters for one article: pending, with every reason", () => {
    const r = E.evaluateArticle(g([fin("a", "u1", "2026-11-26T10:00:00Z"), fin("b", "u2", "2026-11-26T11:00:00Z")]), deps);
    assert.equal(r.status, E.ELIGIBILITY.PENDING_ELIGIBILITY_REVIEW);
    for (const w of [E.WHY.RECOUNT_CLASSIFICATION_PENDING, E.WHY.MULTIPLE_FINALIZED_COUNTS, E.WHY.MULTIPLE_COUNTERS, E.WHY.ALLOTMENT_UNAVAILABLE]) assert.ok(r.reasons.includes(w), w);
    assert.equal(E.isCleanPending(r), false);
  });
  it("with allotment: the allotted counter is eligible", () => {
    const r = E.evaluateArticle(g([fin("a", "u1", "2026-11-26T10:00:00Z")], { allotment: { rp_user_id: "u1" } }), deps);
    assert.equal(r.status, E.ELIGIBILITY.ELIGIBLE);
    assert.equal(r.employee_id, 101);
  });
  it("counted by someone not allotted and not reassigned: not eligible", () => {
    const r = E.evaluateArticle(g([fin("a", "u2", "2026-11-26T10:00:00Z")], { allotment: { rp_user_id: "u1" } }), deps);
    assert.equal(r.status, E.ELIGIBILITY.NOT_ELIGIBLE);
    assert.deepEqual(r.reasons, [E.WHY.COUNTED_BY_NON_ALLOTTED_EMPLOYEE]);
  });
  it("an AUTHORIZED reassignment moves the entitlement; an unauthorized one does not", () => {
    const ok = E.evaluateArticle(g([fin("a", "u2", "2026-11-26T10:00:00Z")], { allotment: { rp_user_id: "u1", reassignments: [{ to_rp_user_id: "u2", authorized: true }] } }), deps);
    assert.equal(ok.status, E.ELIGIBILITY.ELIGIBLE);
    const no = E.evaluateArticle(g([fin("a", "u2", "2026-11-26T10:00:00Z")], { allotment: { rp_user_id: "u1", reassignments: [{ to_rp_user_id: "u2", authorized: false }] } }), deps);
    assert.equal(no.status, E.ELIGIBILITY.NOT_ELIGIBLE);
  });
  it("a recount (once classifiable) does not make the original ambiguous", () => {
    const r = E.evaluateArticle(g([fin("a", "u1", "2026-11-26T10:00:00Z"), fin("r", "u2", "2026-11-26T15:00:00Z")]), { ...deps, isRecount: (s) => s.rp_slug === "r" }, noAllotment);
    assert.equal(r.status, E.ELIGIBILITY.ELIGIBLE);
    assert.equal(r.original_session, "a");
  });
  it("cancelled and restarted by the same user is routine; cancelled by another user needs review", () => {
    const same = E.evaluateArticle(g([{ rp_slug: "x", status: "CANCELLED", initiated_by: "u1" }, fin("a", "u1", "2026-11-26T10:00:00Z")]), deps, noAllotment);
    assert.equal(same.status, E.ELIGIBILITY.ELIGIBLE);
    const other = E.evaluateArticle(g([{ rp_slug: "x", status: "CANCELLED", initiated_by: "u2" }, fin("a", "u1", "2026-11-26T10:00:00Z")]), deps, noAllotment);
    assert.deepEqual(other.reasons, [E.WHY.CANCELLED_BY_OTHER_USER]);
  });
  it("unmapped employee and missing cycle are pending, not dropped", () => {
    const r = E.evaluateArticle(g([fin("a", "ghost", "2026-11-26T10:00:00Z")], { cycleId: null }), deps, noAllotment);
    assert.equal(r.status, E.ELIGIBILITY.PENDING_ELIGIBILITY_REVIEW);
    assert.deepEqual(r.reasons.sort(), [E.WHY.EMPLOYEE_UNMAPPED, E.WHY.NO_CYCLE].sort());
  });
  it("the warehouse and unmapped stores are outside the programme", () => {
    assert.equal(E.evaluateArticle(g([fin("a", "u1", "2026-11-26T10:00:00Z")], { outletId: 2 }), deps).status, E.ELIGIBILITY.EXCLUDED);
    assert.equal(E.evaluateArticle(g([fin("a", "u1", "2026-11-26T10:00:00Z")], { outletId: null }), deps).status, E.ELIGIBILITY.EXCLUDED);
  });
  it("only in-progress or cancelled sessions: nothing to award", () => {
    assert.equal(E.evaluateArticle(g([{ rp_slug: "p", status: "IN_PROGRESS", initiated_by: "u1" }]), deps).status, E.ELIGIBILITY.NOT_APPLICABLE);
  });
  it("a reviewer decision overrides: award to a named employee, or not eligible", () => {
    const two = [fin("a", "u1", "2026-11-26T10:00:00Z"), fin("b", "u2", "2026-11-26T11:00:00Z")];
    const award = E.evaluateArticle(g(two, { review: { decision: "AWARD", employee_id: 102, rp_user_id: "u2" } }), deps);
    assert.equal(award.status, E.ELIGIBILITY.ELIGIBLE);
    assert.equal(award.employee_id, 102);
    assert.equal(E.evaluateArticle(g(two, { review: { decision: "NOT_ELIGIBLE" } }), deps).status, E.ELIGIBILITY.NOT_ELIGIBLE);
  });
  it("evaluateAll groups by store and article", () => {
    const sessions = [
      { ...fin("a", "u1", "2026-11-26T10:00:00Z"), rp_store_id: "kKFom", article_id: 1 },
      { ...fin("b", "u2", "2026-11-26T11:00:00Z"), rp_store_id: "kKFom", article_id: 1 },
      { ...fin("c", "u1", "2026-11-26T10:00:00Z"), rp_store_id: "9rJMC", article_id: 1 },
    ];
    const out = E.evaluateAll(sessions, { ...deps, outletOf: (s) => ({ kKFom: 7, "9rJMC": 2 })[s] ?? null, cycleOf: () => 9 });
    assert.equal(out.length, 2);
    assert.equal(out.find((x) => x.outlet_id === 7).status, E.ELIGIBILITY.PENDING_ELIGIBILITY_REVIEW);
    assert.equal(out.find((x) => x.outlet_id === 2).status, E.ELIGIBILITY.EXCLUDED);
  });
});
