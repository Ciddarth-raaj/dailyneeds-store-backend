/**
 * The read-only "why no OT request" investigation: its classification.
 *
 *   node --test scripts/attendance/ot_would_create_investigation.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const inv = require("./ot-would-create-investigation");

const C = inv.CLASS;
const setting = { enabled: 1, auto_pending_from_date: "2026-09-20", created_at: "2026-09-20 10:00" };
const row = (date) => ({ employee_id: 5, employee_name: "E Five", attendance_date: date, shift: "G", fresh_ot_minutes: 40 });
const stored = (o = {}) => ({ status: "FINAL", is_final: 1, punch_count: 4, candidate_ot_minutes: 40, shift_authorised_ot_minutes: 0, calculated_at: "2026-09-25 02:00", ...o });
const fresh = { status: "FINAL", is_final: true, punch_count: 4, shift_authorised_ot_minutes: 0, pre_shift_ot_minutes: 0, post_shift_ot_minutes: 40 };
const base = (o) => ({ row: row("2026-09-24"), setting, stored: stored(), fresh, verdict: { eligible: true, minutes: 40 }, requests: [], autoLog: [], deferred: null, lock: null, ...o });

describe("ot would-create investigation", () => {
  it("refuses --apply", () => assert.throws(() => inv.parseArgs(["--apply"]), /read-only/));
  it("valid missing: stored FINAL with OT after the cutover, nothing in the way", () => {
    assert.equal(inv.classify(base({})).classification, C.VALID);
  });
  it("pre-cutover", () => {
    assert.equal(inv.classify(base({ row: row("2026-09-10") })).classification, C.PRE_CUTOVER);
  });
  it("locked", () => {
    assert.equal(inv.classify(base({ lock: { status: "APPROVED_LOCKED", locked_at: "2026-10-03 11:00" } })).classification, C.LOCKED);
  });
  it("pending correction or non-final stored day", () => {
    assert.equal(inv.classify(base({ requests: [{ attendance_approval_request_id: 9, request_type: "REGULARIZATION", status: "PENDING" }] })).classification, C.NOT_FINAL);
    assert.equal(inv.classify(base({ stored: stored({ status: "REVIEW_REQUIRED", is_final: 0, punch_count: 3 }) })).classification, C.NOT_FINAL);
  });
  it("rejected or person-cancelled OT is preserved; a system withdrawal is not", () => {
    assert.equal(inv.classify(base({ requests: [{ attendance_approval_request_id: 3, request_type: "OT", status: "REJECTED" }] })).classification, C.REJECTED);
    const sys = { attendance_approval_request_id: 4, request_type: "OT", status: "CANCELLED", closure_reason: "Withdrawn by the system: x" };
    assert.equal(inv.classify(base({ requests: [sys] })).classification, C.UNKNOWN);
  });
  it("shift change covered", () => {
    const r = inv.classify(base({ stored: stored({ candidate_ot_minutes: 0, shift_authorised_ot_minutes: 60 }), requests: [{ attendance_approval_request_id: 7, request_type: "SHIFT_CHANGE", status: "APPROVED" }] }));
    assert.equal(r.classification, C.SHIFT_CHANGE);
  });
  it("stored day had no OT: manual review", () => {
    assert.equal(inv.classify(base({ stored: stored({ candidate_ot_minutes: 0 }) })).classification, C.UNKNOWN);
  });
  it("deleted request found only in the log: manual review", () => {
    assert.equal(inv.classify(base({ autoLog: [{ attendance_approval_request_id: 77, action: "CREATED" }] })).classification, C.UNKNOWN);
  });
});
