/**
 *   node --test utils/stock_audit_policy.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const P = require("./stock_audit_policy");

const tweak = (fn) => { const p = P.draftFromDefault(); fn(p); return P.validatePolicy(p); };

describe("stock audit policy", () => {
  it("the default draft is valid and carries the confirmed amounts", () => {
    assert.deepEqual(P.validatePolicy(P.DEFAULT_POLICY), []);
    const m = P.DEFAULT_POLICY.management;
    assert.deepEqual(m.SUPERVISOR.components.map((c) => [c.key, c.max]), [["completion_within_deadline", 200], ["employee_counting_accuracy", 300], ["independent_recount_verification", 500]]);
    assert.deepEqual(m.STORE_MANAGER.components.map((c) => [c.key, c.max]), [["completion_within_deadline", 500], ["employee_counting_accuracy", 400], ["verification_quality_control", 200], ["stock_variance_investigation_closure", 400]]);
    assert.deepEqual(m.OPERATIONS_MANAGER.slabs, [{ minScorePct: 98, amount: 400 }, { minScorePct: 95, amount: 300 }, { minScorePct: 90, amount: 200 }]);
  });
  it("the five retail stores are in; the warehouse is out", () => {
    assert.deepEqual(P.DEFAULT_POLICY.programme.outletIds, [3, 4, 5, 6, 7]);
    assert.ok(tweak((p) => { p.programme.outletIds.push(2); }).some((e) => /both in and excluded/.test(e)));
    assert.ok(tweak((p) => { p.programme.excludedOutletIds = []; }).some((e) => /warehouse/.test(e)));
  });
  it("refuses any change to confirmed rates, maximums and allocations", () => {
    assert.ok(tweak((p) => { p.employee.slabs[0].ratePerArticle = 1.2; }).length);
    assert.ok(tweak((p) => { p.employee.minSamplePct = 3; }).length);
    assert.ok(tweak((p) => { p.management.SUPERVISOR.components[2].max = 600; }).length);
    assert.ok(tweak((p) => { p.management.STORE_MANAGER.max = 2000; }).length);
    assert.ok(tweak((p) => { p.management.OPERATIONS_MANAGER.slabs[0].amount = 500; }).length);
    assert.ok(tweak((p) => { p.management.STORE_MANAGER.components.pop(); }).length);
  });
  it("lets the scoring layer change, within valid shapes", () => {
    assert.deepEqual(tweak((p) => { p.management.SUPERVISOR.components[1].scoring = { type: "slabs", slabs: [{ minPct: 99, payPct: 100 }, { minPct: 97, payPct: 50 }] }; }), []);
    assert.deepEqual(tweak((p) => { p.employee.recountVerdict = "any_mismatch"; p.employee.movements.ambiguityWindowSeconds = 300; }), []);
    assert.ok(tweak((p) => { p.management.SUPERVISOR.components[1].scoring = { type: "magic" }; }).length);
    assert.ok(tweak((p) => { p.employee.movements.excludeActions = []; }).some((e) => /STK_ADJ/.test(e)));
    assert.ok(tweak((p) => { p.employee.requireIndependentRecount = false; }).length);
  });
});
