/**
 *   node --test utils/stock_audit_incentive.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const I = require("./stock_audit_incentive");

const R = I.DEFAULT_RULES;
const v = (matched, mismatched, independent = true) => [
  ...Array.from({ length: matched }, () => ({ isMatch: true, independent })),
  ...Array.from({ length: mismatched }, () => ({ isMatch: false, independent })),
];

describe("default rules", () => {
  it("are the confirmed structure and valid", () => {
    assert.deepEqual(I.validateRules(R), []);
    assert.deepEqual(R.employee.slabs.map((s) => [s.minAccuracyPct, s.ratePerArticle]), [[99, 1.1], [97, 1.0], [95, 0.5]]);
    assert.equal(R.employee.belowRatePerArticle, 0);
    assert.equal(R.management.SUPERVISOR.max, 1000);
    assert.equal(R.management.STORE_MANAGER.max, 1500);
    assert.equal(R.management.OPERATIONS_MANAGER.max, 2000);
    assert.equal(R.management.SUPERVISOR.components.reduce((s, c) => s + c.max, 0), 1000);
    assert.equal(R.management.STORE_MANAGER.components.reduce((s, c) => s + c.max, 0), 1500);
  });
  it("are NOT approved, so nothing they produce is final", () => {
    assert.equal(R.approved, false);
    assert.equal(I.employeeIncentive({ creditedArticles: 100, verifications: v(5, 0) }).final, false);
    assert.equal(I.employeeIncentive({ creditedArticles: 100, verifications: v(5, 0) }, { ...R, approved: true }).final, true);
  });
  it("validation catches bad slabs and over-budget components", () => {
    const bad = JSON.parse(JSON.stringify(R));
    bad.employee.slabs[1].minAccuracyPct = 99.5;
    bad.management.SUPERVISOR.components[0].max = 400;
    const errs = I.validateRules(bad);
    assert.ok(errs.some((e) => /descending/.test(e)));
    assert.ok(errs.some((e) => /above the maximum 1000/.test(e)));
  });
});

describe("employee incentive", () => {
  it("slab boundaries: exactly 99% / 97% / 95% earn that slab", () => {
    const at = (matched, of) => I.employeeIncentive({ creditedArticles: 1000, verifications: v(matched, of - matched) });
    assert.equal(at(99, 100).ratePerArticle, 1.1);
    assert.equal(at(99, 100).amount, 1100);
    assert.equal(at(98, 100).ratePerArticle, 1.0);
    assert.equal(at(97, 100).ratePerArticle, 1.0);
    assert.equal(at(96, 100).ratePerArticle, 0.5);
    assert.equal(at(95, 100).ratePerArticle, 0.5);
    assert.equal(at(95, 100).amount, 500);
    assert.equal(at(94, 100).ratePerArticle, 0);
    assert.equal(at(94, 100).amount, 0);
  });
  it("never rounds up into a slab: 98.98% is the 97% slab", () => {
    const r = I.employeeIncentive({ creditedArticles: 1000, verifications: v(97, 1) }); // 98.98%, sample 98 >= 50
    assert.equal(r.ratePerArticle, 1.0);
  });
  it("needs at least 5% of credited articles rechecked, rounded up", () => {
    assert.equal(I.requiredSample(1000), 50);
    assert.equal(I.requiredSample(1001), 51);
    assert.equal(I.requiredSample(10), 1);
    const short = I.employeeIncentive({ creditedArticles: 1000, verifications: v(49, 0) });
    assert.equal(short.status, "INSUFFICIENT_SAMPLE");
    assert.equal(short.amount, null);
    assert.equal(I.employeeIncentive({ creditedArticles: 1000, verifications: v(50, 0) }).status, "CALCULATED");
  });
  it("counts only independent recounts with a decidable result", () => {
    const r = I.employeeIncentive({ creditedArticles: 100, verifications: [...v(5, 0, false), { isMatch: null, independent: true }] });
    assert.equal(r.status, "PENDING_VERIFICATION");
    assert.equal(r.rechecked, 0);
  });
  it("is pending, not nil, while no recount exists", () => {
    const r = I.employeeIncentive({ creditedArticles: 700, verifications: [] });
    assert.equal(r.status, "PENDING_VERIFICATION");
    assert.equal(r.amount, null);
  });
  it("pays in exact paise", () => {
    const r = I.employeeIncentive({ creditedArticles: 333, verifications: v(17, 0) });
    assert.equal(r.amount, 366.3);
  });
  it("no articles, no incentive", () => {
    assert.equal(I.employeeIncentive({ creditedArticles: 0 }).status, "NO_ARTICLES");
  });
});

describe("recount match (original physical count vs recount, never book stock)", () => {
  it("matches on equal quantities and tolerates float noise", () => {
    assert.equal(I.isMatch(12, 12), true);
    assert.equal(I.isMatch(0.3, 0.1 + 0.2), true);
    assert.equal(I.isMatch(12, 11), false);
  });
  it("honours a configured tolerance", () => {
    assert.equal(I.isMatch(1.25, 1.2, { absQty: 0.05 }), true);
    assert.equal(I.isMatch(1.3, 1.2, { absQty: 0.05 }), false);
  });
  it("is undecidable when a quantity is missing", () => {
    assert.equal(I.isMatch(null, 3), null);
    assert.equal(I.isMatch(3, undefined), null);
  });
  it("a genuine shortage the recount confirms is a MATCH: book stock is not an input", () => {
    // book said 11, counter found 7, recounter also found 7 -> accurate count of a real shortage
    assert.equal(I.isMatch(7, 7), true);
  });
});

describe("management incentives", () => {
  it("supervisor: all components achieved = Rs 1,000; partial = sum of achieved parts", () => {
    const all = I.managementIncentive("SUPERVISOR", { completion_within_deadline: { achieved: true }, employee_counting_accuracy: { achieved: true }, independent_recount_verification: { achieved: true } });
    assert.equal(all.amount, 1000);
    const part = I.managementIncentive("SUPERVISOR", { completion_within_deadline: { achieved: true }, independent_recount_verification: { achieved: false } });
    assert.equal(part.amount, 200);
    assert.deepEqual(part.missing, ["employee_counting_accuracy"]);
  });
  it("store manager: Rs 1,500 cap and a weighted score", () => {
    const r = I.managementIncentive("STORE_MANAGER", {
      completion_within_deadline: { achieved: true }, overall_counting_accuracy: { achieved: true },
      verification_quality_control: { achieved: false }, variance_investigation_closure: { achieved: true },
    });
    assert.equal(r.amount, 1300);
    assert.equal(Math.round(r.weightedScorePct * 100) / 100, 86.67);
  });
  it("configurable scoring: linear and slabs", () => {
    const rules = JSON.parse(JSON.stringify(R));
    rules.management.STORE_MANAGER.components[1].scoring = { type: "linear" };
    rules.management.STORE_MANAGER.components[3].scoring = { type: "slabs", slabs: [{ minPct: 100, payPct: 100 }, { minPct: 80, payPct: 50 }] };
    assert.deepEqual(I.validateRules(rules), []);
    const r = I.managementIncentive("STORE_MANAGER", { overall_counting_accuracy: { achievedPct: 75 }, variance_investigation_closure: { achievedPct: 85 } }, rules);
    assert.equal(r.components[1].amount, 300);
    assert.equal(r.components[3].amount, 200);
  });
  it("operations manager: slab per store on the Store Manager score, only with independent verification, capped at Rs 2,000", () => {
    const r = I.operationsManagerIncentive([
      { outletId: 1, storeManagerScorePct: 100, independentVerification: true },
      { outletId: 2, storeManagerScorePct: 96, independentVerification: true },
      { outletId: 3, storeManagerScorePct: 92, independentVerification: true },
      { outletId: 4, storeManagerScorePct: 89.99, independentVerification: true },
      { outletId: 5, storeManagerScorePct: 100, independentVerification: false },
    ]);
    assert.deepEqual(r.perStore.map((s) => s.amount), [400, 300, 200, 0, 0]);
    assert.equal(r.perStore[4].reason, "no independent store verification");
    assert.equal(r.amount, 900);
    const five = I.operationsManagerIncentive([1, 2, 3, 4, 5].map((o) => ({ outletId: o, storeManagerScorePct: 99, independentVerification: true })));
    assert.equal(five.amount, 2000);
  });
});
