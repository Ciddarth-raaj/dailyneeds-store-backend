/**
 * The LR Follow-up rules, without a database.
 *
 *   node --test utils/lr_followup.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const R = require("./lr_followup");

const TODAY = "2026-10-01";

describe("dispatch evidence and status", () => {
  it("an LR number or a dispatch date is dispatch; neither is mandatory", () => {
    assert.equal(R.hasDispatchEvidence({ lr_no: "LR-1" }), true);
    assert.equal(R.hasDispatchEvidence({ dispatch_date: "2026-09-30" }), true);
    assert.equal(R.hasDispatchEvidence({ lr_no: "  " }), false);
  });

  it("the transporter alone, or an expected date alone, is not dispatch", () => {
    assert.equal(R.hasDispatchEvidence({ transporter_id: 4 }), false);
    assert.equal(R.hasDispatchEvidence({ expected_delivery_date: "2026-10-04" }), false);
  });

  it("LR details move only open follow-ups, both ways", () => {
    assert.equal(R.statusForDispatch("DISPATCH_PENDING", { lr_no: "LR-1" }), "IN_TRANSIT");
    assert.equal(R.statusForDispatch("IN_TRANSIT", { lr_no: null }), "DISPATCH_PENDING");
    assert.equal(R.statusForDispatch("CLOSED", { lr_no: "LR-1" }), "CLOSED");
    assert.equal(R.statusForDispatch("VERIFICATION_REQUIRED", { lr_no: "LR-1" }), "VERIFICATION_REQUIRED");
  });
});

describe("overdue is derived", () => {
  it("expected delivery before today, not closed", () => {
    assert.equal(R.isOverdue({ status: "IN_TRANSIT", expected_delivery_date: "2026-09-30" }, TODAY), true);
    assert.equal(R.isOverdue({ status: "IN_TRANSIT", expected_delivery_date: TODAY }, TODAY), false);
    assert.equal(R.isOverdue({ status: "IN_TRANSIT", expected_delivery_date: null }, TODAY), false);
    assert.equal(R.isOverdue({ status: "CLOSED", expected_delivery_date: "2026-09-01" }, TODAY), false);
  });
});

describe("ageing", () => {
  it("runs from the source date to today while open, and stops at closure", () => {
    assert.equal(R.ageingDays({ status: "IN_TRANSIT", source_date: "2026-09-26 15:00:00" }, TODAY), 5);
    assert.equal(
      R.ageingDays({ status: "CLOSED", source_date: "2026-09-20", goods_received_at: "2026-09-23 10:00:00" }, TODAY),
      3
    );
  });

  it("buckets for display only", () => {
    assert.deepEqual([0, 2, 3, 5, 6, 10, 11, 40].map(R.ageingBucket), ["0-2", "0-2", "3-5", "3-5", "6-10", "6-10", "10+", "10+"]);
    assert.equal(R.ageingBucket(null), null);
  });
});

describe("references", () => {
  it("names the follow-up and its source the way the screens show them", () => {
    assert.equal(R.followupRef(12), "LRF-12");
    assert.equal(R.sourceRef({ source_type: "ADVANCE_REQUEST", advance_request_id: 1025 }), "AR-1025");
    assert.equal(R.sourceRef({ source_type: "CREDIT_PURCHASE", credit_purchase_id: 4587 }), "CP-4587");
  });
});

describe("legacy decisions", () => {
  it("only Goods Still Pending keeps a follow-up open", () => {
    assert.deepEqual(R.outcomeForDecision("STILL_PENDING", {}), { status: "DISPATCH_PENDING", closure_reason: null });
    assert.deepEqual(R.outcomeForDecision("STILL_PENDING", { lr_no: "X" }), { status: "IN_TRANSIT", closure_reason: null });
    for (const d of ["GOODS_RECEIVED", "REFUNDED", "ADJUSTED", "CANCELLED"]) {
      assert.deepEqual(R.outcomeForDecision(d, {}), { status: "CLOSED", closure_reason: d });
    }
    assert.throws(() => R.outcomeForDecision("LOST", {}), (e) => e.name === "BusinessRuleError");
  });
});
