/**
 *   node --test utils/ot_historical_review.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const r = require("./ot_historical_review");

const CUT = "2026-10-07";
const row = (o = {}) => ({
  employee_id: 945, employee_name: "Mritunjay Kharwar", attendance_date: "2026-09-04",
  status: "FINAL", is_final: 1, punch_count: 2, candidate_ot_minutes: 22, shift_authorised_ot_minutes: 0,
  approved_ot_minutes: 0, ot_request_id: null, ot_request_status: null, ot_request_closure_reason: null,
  withdrawn_request_id: null, late_settlement_status: null, correction_pending: 0, marker_status: null,
  marker_source: null, already_reviewed: 0, outside_employment: 0,
  payroll_calculation_id: null, payroll_status: null, payroll_published_at: null, ...o,
});
const action = (o) => r.classify(row(o), { cutover: CUT }).proposed_action;

describe("classify: the proposed action per date", () => {
  it("unlocked payroll -> CREATE_PENDING_OT; calculated payroll too", () => {
    assert.equal(action({}), r.ACTION.CREATE_PENDING_OT);
    assert.equal(action({ payroll_status: "CALCULATED", payroll_calculation_id: 5 }), r.ACTION.CREATE_PENDING_OT);
  });
  it("locked and published payroll -> Pending OT settled as Prior-Month OT, with the payroll source reference", () => {
    const locked = r.classify(row({ payroll_status: "APPROVED_LOCKED", payroll_calculation_id: 7001 }), { cutover: CUT });
    assert.deepEqual([locked.proposed_action, locked.payroll_status, locked.payroll_calculation_id], [r.ACTION.CREATE_PENDING_OT_PRIOR_MONTH, "APPROVED_LOCKED", 7001]);
    assert.equal(r.classify(row({ payroll_status: "APPROVED_LOCKED", payroll_published_at: "2026-10-06" }), { cutover: CUT }).payroll_status, "PUBLISHED");
  });
  it("existing requests are never duplicated", () => {
    assert.equal(action({ ot_request_id: 1, ot_request_status: "PENDING" }), r.ACTION.SKIP_EXISTING_PENDING);
    assert.equal(action({ ot_request_id: 1, ot_request_status: "APPROVED" }), r.ACTION.SKIP_EXISTING_APPROVED);
    assert.equal(action({ ot_request_id: 1, ot_request_status: "REJECTED" }), r.ACTION.SKIP_EXISTING_REJECTED);
    assert.equal(action({ ot_request_id: 1, ot_request_status: "REJECTED", ot_request_closure_reason: "NOT_REQUESTED_BEFORE_PAYROLL_LOCK" }), r.ACTION.SKIP_CLOSED_AT_PAYROLL_LOCK);
  });
  it("previously paid OT is never repaid", () => {
    assert.equal(action({ late_settlement_status: "SETTLED" }), r.ACTION.SKIP_ALREADY_PAID);
    assert.equal(action({ approved_ot_minutes: 22 }), r.ACTION.SKIP_ALREADY_PAID);
  });
  it("a WITHDRAWN request does not block a review, and is reported", () => {
    const l = r.classify(row({ withdrawn_request_id: 77 }), { cutover: CUT });
    assert.deepEqual([l.proposed_action, l.withdrawn_request_id], [r.ACTION.CREATE_PENDING_OT, 77]);
  });
  it("a date a review already raised is never raised again", () => {
    assert.equal(action({ already_reviewed: 1, withdrawn_request_id: 77 }), r.ACTION.SKIP_ALREADY_REVIEWED);
  });
  it("attendance first: incomplete or under correction is skipped", () => {
    assert.equal(action({ is_final: 0 }), r.ACTION.SKIP_ATTENDANCE_INCOMPLETE);
    assert.equal(action({ punch_count: 3 }), r.ACTION.SKIP_ATTENDANCE_INCOMPLETE);
    assert.equal(action({ correction_pending: 1 }), r.ACTION.SKIP_CORRECTION_PENDING);
    assert.equal(action({ outside_employment: 1 }), r.ACTION.SKIP_OUTSIDE_EMPLOYMENT);
  });
  it("the cutover stays: a date on or after it is normal processing", () => {
    assert.equal(action({ attendance_date: "2026-10-07" }), r.ACTION.SKIP_ON_OR_AFTER_CUTOVER);
  });
  it("shift-authorised minutes are not reviewable OT; a fully authorised day drops out of the preview", () => {
    assert.equal(r.buildPreview([row({ candidate_ot_minutes: 60, shift_authorised_ot_minutes: 60 })], { cutover: CUT }).length, 0);
    assert.equal(r.buildPreview([row({ candidate_ot_minutes: 60, shift_authorised_ot_minutes: 40 })], { cutover: CUT })[0].calculated_ot_minutes, 20);
  });
});

describe("previewHash and summarize", () => {
  const lines = r.buildPreview(
    [
      row(),
      row({ employee_id: 946, payroll_status: "APPROVED_LOCKED", candidate_ot_minutes: 30 }),
      row({ employee_id: 947, ot_request_id: 3, ot_request_status: "APPROVED", candidate_ot_minutes: 10 }),
    ],
    { cutover: CUT }
  );
  it("the hash is order-independent and changes when an action changes", () => {
    assert.equal(r.previewHash(lines), r.previewHash([...lines].reverse()));
    assert.notEqual(r.previewHash(lines), r.previewHash(lines.map((l, i) => (i === 0 ? { ...l, proposed_action: "SKIP_X" } : l))));
  });
  it("company-wide totals: all calculated OT, without a request, to create, by action and payroll status", () => {
    const s = r.summarize(lines);
    assert.deepEqual(s.calculated_ot, { entries: 3, minutes: 62, employees: 3 });
    assert.deepEqual(s.without_request, { entries: 2, minutes: 52, employees: 2 });
    assert.deepEqual(s.to_create, { entries: 2, minutes: 52, employees: 2 });
    assert.deepEqual(s.by_payroll_status.APPROVED_LOCKED, { entries: 1, minutes: 30, employees: 1 });
    assert.deepEqual(s.by_proposed_action.SKIP_EXISTING_APPROVED, { entries: 1, minutes: 10, employees: 1 });
  });
});
