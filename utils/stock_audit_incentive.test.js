/**
 *   node --test utils/stock_audit_incentive.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const I = require("./stock_audit_incentive");
const S = require("./stock_audit_status");
const P = require("./stock_audit_policy");

const verdicts = (match, mismatch, unresolved = 0) => [
  ...Array(match).fill({ verdict: "MATCH" }), ...Array(mismatch).fill({ verdict: "MISMATCH" }), ...Array(unresolved).fill({ verdict: "UNRESOLVED" }),
];

describe("employee incentive (confirmed rates)", () => {
  const calc = (m, x, extra = {}) => I.employeeIncentive({ auditedArticles: 1000, eligibleArticles: 1000, verdicts: verdicts(m, x), ...extra });
  it("99% -> Rs 1.10, 97% -> Rs 1.00, 95% -> Rs 0.50, below -> nil, at exact boundaries", () => {
    assert.equal(calc(99, 1).amount.value, 1100);
    assert.equal(calc(98, 2).rate.value, 1.0);
    assert.equal(calc(97, 3).amount.value, 1000);
    assert.equal(calc(96, 4).rate.value, 0.5);
    assert.equal(calc(95, 5).amount.value, 500);
    assert.equal(calc(94, 6).amount.value, 0);
    assert.equal(calc(94, 6).status, "CALCULATED");
  });
  it("never rounds up into a slab (98.98% is the Rs 1.00 slab)", () => {
    const r = I.employeeIncentive({ auditedArticles: 1000, eligibleArticles: 1000, verdicts: verdicts(97, 1) });
    assert.equal(r.rate.value, 1.0);
  });
  it("no recount yet is PENDING, never nil and never 100%", () => {
    const r = I.employeeIncentive({ auditedArticles: 700, eligibleArticles: 700, verdicts: [] });
    assert.equal(r.status, "PENDING_VERIFICATION");
    assert.equal(r.amount.status, S.STATUS.PENDING);
    assert.equal(r.amount.value, null);
    assert.equal(r.accuracy.value, null);
  });
  it("below the 5% unique-article sample: pending, with a provisional accuracy", () => {
    const r = I.employeeIncentive({ auditedArticles: 1000, eligibleArticles: 1000, verdicts: verdicts(49, 0, 30) });
    assert.equal(r.status, "INSUFFICIENT_SAMPLE");
    assert.equal(r.sample.required, 50);
    assert.equal(r.sample.verified, 49);
    assert.equal(r.amount.status, S.STATUS.PENDING);
    assert.equal(r.accuracy.provisional, true);
  });
  it("articles pending eligibility keep the amount pending, with a provisional figure on the eligible ones", () => {
    const r = I.employeeIncentive({ auditedArticles: 1000, eligibleArticles: 0, pendingEligibility: 1000, verdicts: verdicts(50, 0) });
    assert.equal(r.status, "PENDING_ELIGIBILITY_REVIEW");
    assert.equal(r.amount.status, S.STATUS.PENDING);
    assert.equal(r.provisional_amount, 0);
  });
  it("no audited articles: not applicable", () => {
    assert.equal(I.employeeIncentive({}).amount.status, S.STATUS.NOT_APPLICABLE);
  });
  it("final only when the policy version is approved", () => {
    assert.equal(calc(50, 0).final, false);
    assert.equal(I.employeeIncentive({ auditedArticles: 1000, eligibleArticles: 1000, verdicts: verdicts(50, 0) }, P.DEFAULT_POLICY, { approved: true }).final, true);
  });
  it("pays exact paise", () => {
    assert.equal(I.employeeIncentive({ auditedArticles: 333, eligibleArticles: 333, verdicts: verdicts(17, 0) }).amount.value, 366.3);
  });
});

describe("KPI measures never invent a value", () => {
  it("completion is unavailable without allotment", () => {
    assert.equal(I.measureCompletion(null).status, S.STATUS.UNAVAILABLE);
    assert.equal(I.measureCompletion(null).reason, S.REASON.ALLOTMENT_UNAVAILABLE);
  });
  it("accuracy, sample and resolution are pending without recounts", () => {
    assert.equal(I.measureStoreAccuracy([]).status, S.STATUS.PENDING);
    assert.equal(I.measureSampleMet([{ audited: 10, verified: 0, met: false }]).status, S.STATUS.PENDING);
    assert.equal(I.measureVerificationResolved([]).status, S.STATUS.PENDING);
  });
  it("variance closure: not applicable without variances, pending while one is open before its deadline", () => {
    assert.equal(I.measureVarianceClosure([], {}, "2026-11-30T00:00:00Z").status, S.STATUS.NOT_APPLICABLE);
    const v = [{ abs_value: 50, finalized_at: "2026-11-26T10:00:00+05:30", closed_at: null }];
    assert.equal(I.measureVarianceClosure(v, { closeWithinDays: 7 }, "2026-11-28T00:00:00Z").status, S.STATUS.PENDING);
    assert.equal(I.measureVarianceClosure(v, { closeWithinDays: 7 }, "2026-12-10T00:00:00Z").value, 0);
    const closed = [{ abs_value: 50, finalized_at: "2026-11-26T10:00:00+05:30", closed_at: "2026-11-30T10:00:00+05:30" }];
    assert.equal(I.measureVarianceClosure(closed, { closeWithinDays: 7 }, "2026-12-10T00:00:00Z").value, 100);
  });
  it("store accuracy and resolution from verdicts", () => {
    assert.equal(I.measureStoreAccuracy(verdicts(97, 3)).value, 97);
    assert.equal(I.measureVerificationResolved([{ verdict: "MATCH" }, { verdict: "UNRESOLVED" }, { verdict: "NOT_INDEPENDENT" }]).value, 50);
  });
});

describe("management incentives (confirmed allocations)", () => {
  const A = (v) => S.available(v);
  it("supervisor: all achieved = Rs 1,000", () => {
    const r = I.roleIncentive("SUPERVISOR", { completion_within_deadline: A(100), employee_counting_accuracy: A(98), independent_recount_verification: A(100) });
    assert.equal(r.amount.value, 1000);
    assert.equal(r.weighted_score.value, 100);
  });
  it("supervisor today: completion unavailable -> total pending; decided parts shown", () => {
    const r = I.roleIncentive("SUPERVISOR", { completion_within_deadline: I.measureCompletion(null), employee_counting_accuracy: A(98), independent_recount_verification: A(80) });
    assert.equal(r.amount.status, S.STATUS.PENDING);
    assert.equal(r.decided_amount, 300);
    assert.equal(r.components[0].amount.status, S.STATUS.UNAVAILABLE);
  });
  it("store manager: allocation 500 / 400 / 200 / 400 and weighted score", () => {
    const r = I.roleIncentive("STORE_MANAGER", { completion_within_deadline: A(100), employee_counting_accuracy: A(97), verification_quality_control: A(90), stock_variance_investigation_closure: A(100) });
    assert.equal(r.amount.value, 1300);
    assert.equal(Math.round(r.weighted_score.value * 100) / 100, 86.67);
  });
  it("operations manager: 400 / 300 / 200 / nil per store, nil without independent verification, pending when unknown, max 2,000", () => {
    const r = I.operationsManagerIncentive([
      { outlet_id: 3, storeManagerScore: A(98), independentVerification: true },
      { outlet_id: 4, storeManagerScore: A(97.99), independentVerification: true },
      { outlet_id: 5, storeManagerScore: A(90), independentVerification: true },
      { outlet_id: 6, storeManagerScore: A(89.99), independentVerification: true },
      { outlet_id: 7, storeManagerScore: A(100), independentVerification: false },
    ]);
    assert.deepEqual(r.perStore.map((p) => p.amount.value), [400, 300, 200, 0, 0]);
    assert.equal(r.amount.value, 900);
    const pend = I.operationsManagerIncentive([{ outlet_id: 3, storeManagerScore: A(99), independentVerification: null }]);
    assert.equal(pend.amount.status, S.STATUS.PENDING);
    const all = I.operationsManagerIncentive([3, 4, 5, 6, 7].map((o) => ({ outlet_id: o, storeManagerScore: A(99), independentVerification: true })));
    assert.equal(all.amount.value, 2000);
  });
});
