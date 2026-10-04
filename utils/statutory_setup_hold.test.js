/**
 * The statutory setup hold - which gaps hold whom, by name, for September 2026.
 *
 *   IS_TEST=true node --test utils/statutory_setup_hold.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { statutorySetupGaps, statutorySetupComplete } = require("./payrun_eligibility");
const { evaluatePayrollReadiness, statutoryHoldReason, READINESS_REASON } = require("./payroll_readiness");

const SEP = { year: 2026, month: 9 };
const JOINER = {
  pf_applicable: 1,
  esi_applicable: 0,
  date_of_joining: "2026-09-08",
  dob: "1999-02-01",
  previous_pf_member: 0,
  previous_eps_member: 0,
  uan: null,
  pf_number: "TN/MAS/1/77",
};
const fields = (e, p = SEP) => statutorySetupGaps(e, p).map((g) => g.field);

describe("a September 2026 joiner", () => {
  it("with complete statutory data has no gap", () => {
    assert.deepEqual(fields(JOINER), []);
  });
  it("missing Previous PF / EPS Member, DOB: each named, none inferred", () => {
    assert.deepEqual(fields({ ...JOINER, previous_pf_member: null, previous_eps_member: null, dob: null }), [
      "dob", "previous_pf_member", "previous_eps_member",
    ]);
  });
  it("Previous EPS Member is never inferred from Basic or gross", () => {
    assert.deepEqual(fields({ ...JOINER, previous_eps_member: null, basic: 9000, monthly_gross: 9000 }), ["previous_eps_member"]);
  });
  it("an existing PF member needs their 12-digit UAN; a first-time member may still be awaiting it", () => {
    assert.deepEqual(fields({ ...JOINER, previous_pf_member: 1 }), ["uan"]);
    assert.deepEqual(fields({ ...JOINER, previous_pf_member: 1, uan: "100200300400" }), []);
    assert.deepEqual(fields({ ...JOINER, previous_pf_member: 0 }), []);
  });
  it("PF Applicable not answered holds everybody, joiner or not", () => {
    assert.deepEqual(fields({ ...JOINER, pf_applicable: null }), ["pf_applicable"]);
  });
  it("a PF-not-applicable joiner needs no PF facts", () => {
    assert.deepEqual(fields({ ...JOINER, pf_applicable: 0, previous_eps_member: null, dob: null }), []);
  });
});

describe("existing members are not newly held", () => {
  const EXISTING = { ...JOINER, date_of_joining: "2019-01-01", previous_eps_member: null, previous_pf_member: null, dob: null };
  it("Form 11 facts / DOB missing on an existing member: no hold (the engine reports what matters)", () => {
    assert.deepEqual(fields(EXISTING), []);
  });
  it("the pre-existing rule still applies to them: an identifier where PF applies", () => {
    assert.deepEqual(fields({ ...EXISTING, pf_number: null, uan: null }), ["uan"]);
    assert.equal(statutorySetupComplete({ ...EXISTING, pf_number: null, uan: null }), false);
  });
  it("a PF member with no DOJ at all is held - DOJ is what the joining / EPS rules read", () => {
    assert.ok(fields({ ...EXISTING, date_of_joining: null }).includes("date_of_joining"));
  });
});

describe("the hold in readiness", () => {
  it("is a named, non-attendance blocker that Process Attendance and Close Attendance cannot clear", () => {
    const hold = statutoryHoldReason(statutorySetupGaps({ ...JOINER, previous_eps_member: null }, SEP));
    assert.equal(hold.code, READINESS_REASON.STATUTORY_SETUP_INCOMPLETE);
    assert.equal(hold.processable, false);
    assert.equal(hold.accepted_by_close, false);
    assert.match(hold.message, /Previous EPS Member not recorded/);
  });
  it("makes the employee not calculable even with settled attendance", () => {
    const r = evaluatePayrollReadiness({
      year: 2026, month: 9,
      snapshot: { monthly_gross: 20000, basic: 10000, date_of_joining: "2026-09-08" },
      monthly: null,
      attendance_required: false,
      statutory_gaps: [{ field: "dob", label: "Date of Birth" }],
      closed_for_payroll: true,
    });
    assert.equal(r.calculable, false);
    assert.ok(r.reasons.some((x) => x.code === "STATUTORY_SETUP_INCOMPLETE"));
  });
  it("no gap, no hold", () => {
    assert.equal(statutoryHoldReason([]), null);
  });
});
