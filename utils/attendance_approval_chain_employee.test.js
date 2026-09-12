/**
 * The EMPLOYEE-LEVEL chain: building it, validating a mapping, deciding it.
 *
 *   node --test utils/attendance_approval_chain_employee.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  APPROVAL_LEVEL,
  EMPLOYEE_STAGE_ROLE,
  APPROVER_ROLE,
  REQUEST_STATUS,
  STEP_DECISION,
  buildEmployeeApprovalChain,
  validateApproverSetup,
  canApprove,
  advance,
  isEmployeeStep,
} = require("./attendance_approval_chain");

const ids = (chain) => chain.map((s) => s.approver_employee_id);
const levels = (chain) => chain.map((s) => s.approval_level);

describe("buildEmployeeApprovalChain", () => {
  it("First + Second + Final -> 1, 2, Final", () => {
    const chain = buildEmployeeApprovalChain({ first_level_approver_employee_id: 11, second_level_approver_employee_id: 22, final_approver_employee_id: 33 });
    assert.deepEqual(ids(chain), [11, 22, 33]);
    assert.deepEqual(levels(chain), ["FIRST", "SECOND", "FINAL"]);
    assert.deepEqual(chain.map((s) => s.stage_no), [1, 2, 3]);
    chain.forEach((s) => { assert.equal(s.approver_role, EMPLOYEE_STAGE_ROLE); assert.equal(s.outlet_id, null); });
  });
  it("First + Final -> 1, Final (blank Second skipped)", () => {
    const chain = buildEmployeeApprovalChain({ first_level_approver_employee_id: 11, second_level_approver_employee_id: null, final_approver_employee_id: 33 });
    assert.deepEqual(ids(chain), [11, 33]);
    assert.deepEqual(chain.map((s) => s.stage_no), [1, 2]);
  });
  it("Second + Final -> 2, Final (blank First skipped, stages stay dense)", () => {
    const chain = buildEmployeeApprovalChain({ first_level_approver_employee_id: "", second_level_approver_employee_id: 22, final_approver_employee_id: 33 });
    assert.deepEqual(ids(chain), [22, 33]);
    assert.deepEqual(levels(chain), ["SECOND", "FINAL"]);
    assert.deepEqual(chain.map((s) => s.stage_no), [1, 2]);
  });
  it("Final only -> Final", () => {
    const chain = buildEmployeeApprovalChain({ final_approver_employee_id: 33 });
    assert.deepEqual(ids(chain), [33]);
    assert.deepEqual(levels(chain), ["FINAL"]);
  });
  it("the Final Approver is always the last stage, and only its approval finishes the request", () => {
    const chain = buildEmployeeApprovalChain({ first_level_approver_employee_id: 11, final_approver_employee_id: 33 });
    assert.equal(chain[chain.length - 1].approval_level, APPROVAL_LEVEL.FINAL);
    const afterFirst = advance({ current_stage_no: 1 }, chain, STEP_DECISION.APPROVED);
    assert.equal(afterFirst.status, REQUEST_STATUS.PENDING);
    const afterFinal = advance({ current_stage_no: 2 }, chain, STEP_DECISION.APPROVED);
    assert.equal(afterFinal.status, REQUEST_STATUS.APPROVED);
  });
  it("refuses a mapping with no Final Approver", () => {
    assert.throws(() => buildEmployeeApprovalChain({ first_level_approver_employee_id: 11 }), /Final Approver/);
  });
});

describe("validateApproverSetup", () => {
  const facts = (active = [1, 11, 22, 33], all = [1, 11, 22, 33, 99]) => ({
    exists: (id) => all.includes(Number(id)),
    isActive: (id) => active.includes(Number(id)),
  });
  it("accepts Final only, First+Final, Second+Final, all three", () => {
    for (const setup of [
      { employee_id: 1, final_approver_employee_id: 33 },
      { employee_id: 1, first_level_approver_employee_id: 11, final_approver_employee_id: 33 },
      { employee_id: 1, second_level_approver_employee_id: 22, final_approver_employee_id: 33 },
      { employee_id: 1, first_level_approver_employee_id: 11, second_level_approver_employee_id: 22, final_approver_employee_id: 33 },
    ]) {
      const v = validateApproverSetup(setup, facts());
      assert.deepEqual(v.errors, [], JSON.stringify(setup));
      assert.equal(v.normalized.employee_id, 1);
    }
  });
  it("Final Approver is required", () => {
    const v = validateApproverSetup({ employee_id: 1, first_level_approver_employee_id: 11 }, facts());
    assert.ok(v.errors.includes("Final Approver is required"));
  });
  it("nobody is their own approver at any level", () => {
    for (const key of ["first_level_approver_employee_id", "second_level_approver_employee_id", "final_approver_employee_id"]) {
      const v = validateApproverSetup({ employee_id: 1, final_approver_employee_id: 33, [key]: 1 }, facts());
      assert.ok(v.errors.some((e) => /own approver/.test(e)), key);
    }
  });
  it("an inactive employee cannot be NEWLY assigned, but an unchanged existing approver may stay", () => {
    const inactive99 = facts([1, 11, 22, 33], [1, 11, 22, 33, 99]);
    const fresh = validateApproverSetup({ employee_id: 1, final_approver_employee_id: 99 }, inactive99);
    assert.ok(fresh.errors.some((e) => /not active/.test(e)));
    const kept = validateApproverSetup({ employee_id: 1, final_approver_employee_id: 99 }, { ...inactive99, previous: { final_approver_employee_id: 99 } });
    assert.deepEqual(kept.errors, []);
  });
  it("the three non-blank approvers must be different people", () => {
    const all = validateApproverSetup({ employee_id: 1, first_level_approver_employee_id: 11, second_level_approver_employee_id: 11, final_approver_employee_id: 11 }, facts());
    assert.equal(all.errors.filter((e) => /must be different people/.test(e)).length, 2);
    const two = validateApproverSetup({ employee_id: 1, first_level_approver_employee_id: 11, final_approver_employee_id: 11 }, facts());
    assert.match(two.errors.join(";"), /Final Approver: employee 11 is already the First Level Approver/);
    const okBlank = validateApproverSetup({ employee_id: 1, first_level_approver_employee_id: null, second_level_approver_employee_id: null, final_approver_employee_id: 33 }, facts());
    assert.deepEqual(okBlank.errors, [], "blanks are not duplicates of each other");
  });
  it("unknown ids are refused", () => {
    const v = validateApproverSetup({ employee_id: 1, final_approver_employee_id: 555 }, facts());
    assert.ok(v.errors.some((e) => /no such employee 555/.test(e)));
    const w = validateApproverSetup({ employee_id: 777, final_approver_employee_id: 33 }, facts());
    assert.ok(w.errors.some((e) => /No such employee: 777/.test(e)));
  });
});

describe("canApprove on an employee-level step", () => {
  const step = { stage_no: 1, approver_role: EMPLOYEE_STAGE_ROLE, outlet_id: null, approver_employee_id: 11, approval_level: "FIRST", decision: "PENDING" };
  const request = { requested_for_employee_id: 1, requested_by_employee_id: 1, status: REQUEST_STATUS.PENDING, current_stage_no: 1 };
  it("the snapshotted approver may decide it, without any role", () => {
    assert.deepEqual(canApprove(step, { employee_id: 11, user_type: 1, outlet_id: 3, approver_roles: [] }, request), { allowed: true, reason: null, as_admin_override: false });
  });
  it("anybody else, whatever their role, may not", () => {
    const v = canApprove(step, { employee_id: 12, user_type: 1, outlet_id: 3, approver_roles: [APPROVER_ROLE.HR, APPROVER_ROLE.STORE_MANAGER] }, request);
    assert.equal(v.allowed, false);
    assert.match(v.reason, /assigned approver/);
  });
  it("an administrator may, recorded as an override", () => {
    assert.deepEqual(canApprove(step, { employee_id: 12, user_type: 2, outlet_id: null, approver_roles: [] }, request), { allowed: true, reason: null, as_admin_override: true });
  });
  it("NOBODY approves their own request, even as the snapshotted approver", () => {
    const own = { ...step, approver_employee_id: 1 };
    const v = canApprove(own, { employee_id: 1, user_type: 2, outlet_id: 3, approver_roles: [] }, request);
    assert.equal(v.allowed, false);
    assert.match(v.reason, /your own attendance/);
  });
  it("role-based steps are untouched: a historical HR step still needs the HR role", () => {
    const roleStep = { stage_no: 1, approver_role: APPROVER_ROLE.HR, outlet_id: null, decision: "PENDING" };
    assert.equal(isEmployeeStep(roleStep), false);
    assert.equal(canApprove(roleStep, { employee_id: 11, user_type: 1, outlet_id: 3, approver_roles: [] }, request).allowed, false);
    assert.equal(canApprove(roleStep, { employee_id: 11, user_type: 1, outlet_id: 3, approver_roles: [APPROVER_ROLE.HR] }, request).allowed, true);
  });
});
