/**
 * Attendance v2 / A3 - the approval chains, exhaustively.
 *
 * Pure decisions about role and outlet, so every case here is a fixed input
 * and a fixed answer. No database, no Express, no clock.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  REQUESTER_CLASS,
  APPROVER_ROLE,
  REQUEST_TYPE,
  REQUEST_STATUS,
  STEP_DECISION,
  buildApprovalChain,
  requestTypeFor,
  canApprove,
  advance,
  isFinallyApproved,
} = require("../utils/attendance_approval_chain");

const roles = (chain) => chain.map((s) => s.approver_role);

describe("the three chains", () => {
  it("a store employee goes Store Manager -> Operations -> HR", () => {
    const chain = buildApprovalChain({
      requester_class: REQUESTER_CLASS.STORE_EMPLOYEE,
      outlet_id: 3,
    });
    assert.deepEqual(roles(chain), [
      APPROVER_ROLE.STORE_MANAGER,
      APPROVER_ROLE.OPERATIONS_MANAGER,
      APPROVER_ROLE.HR,
    ]);
    assert.deepEqual(chain.map((s) => s.stage_no), [1, 2, 3]);
  });

  it("a manager goes Operations -> HR", () => {
    assert.deepEqual(roles(buildApprovalChain({ requester_class: REQUESTER_CLASS.MANAGER })), [
      APPROVER_ROLE.OPERATIONS_MANAGER,
      APPROVER_ROLE.HR,
    ]);
  });

  it("a head goes to Admin alone", () => {
    assert.deepEqual(roles(buildApprovalChain({ requester_class: REQUESTER_CLASS.HEAD })), [
      APPROVER_ROLE.ADMIN,
    ]);
  });

  it("only the Store Manager stage is outlet scoped", () => {
    const chain = buildApprovalChain({
      requester_class: REQUESTER_CLASS.STORE_EMPLOYEE,
      outlet_id: 3,
    });
    assert.equal(chain[0].outlet_id, 3);
    assert.equal(chain[1].outlet_id, null);
    assert.equal(chain[2].outlet_id, null);
  });
});

describe("a Store Manager never approves their own request", () => {
  it("their own request follows the Manager chain instead", () => {
    const chain = buildApprovalChain({
      requester_class: REQUESTER_CLASS.STORE_EMPLOYEE,
      outlet_id: 3,
      requester_is_store_manager: true,
    });
    assert.deepEqual(roles(chain), [APPROVER_ROLE.OPERATIONS_MANAGER, APPROVER_ROLE.HR]);
    assert.ok(!roles(chain).includes(APPROVER_ROLE.STORE_MANAGER));
  });
});

describe("one date, one request, one pass", () => {
  it("a missing punch that also earns OT is a single combined request", () => {
    assert.equal(
      requestTypeFor({ has_missing_punch: true, has_candidate_ot: true }),
      REQUEST_TYPE.REGULARIZATION_WITH_OT
    );
  });

  it("a missing punch alone is a regularization", () => {
    assert.equal(
      requestTypeFor({ has_missing_punch: true, has_candidate_ot: false }),
      REQUEST_TYPE.REGULARIZATION
    );
  });

  it("OT with no missing punch is an OT request, on the same chain", () => {
    assert.equal(
      requestTypeFor({ has_missing_punch: false, has_candidate_ot: true }),
      REQUEST_TYPE.OT
    );
    assert.deepEqual(
      roles(buildApprovalChain({ requester_class: REQUESTER_CLASS.STORE_EMPLOYEE, outlet_id: 1 })),
      roles(buildApprovalChain({ requester_class: REQUESTER_CLASS.STORE_EMPLOYEE, outlet_id: 1 }))
    );
  });
});

describe("who may decide a stage", () => {
  const request = {
    status: REQUEST_STATUS.PENDING,
    current_stage_no: 1,
    requested_for_employee_id: 100,
    requested_by_employee_id: 100,
  };
  const step = { stage_no: 1, approver_role: APPROVER_ROLE.STORE_MANAGER, outlet_id: 3, decision: "PENDING" };

  it("the right role at the right outlet may", () => {
    const verdict = canApprove(step, {
      employee_id: 7,
      outlet_id: 3,
      approver_roles: [APPROVER_ROLE.STORE_MANAGER],
    }, request);
    assert.equal(verdict.allowed, true);
    assert.equal(verdict.as_admin_override, false);
  });

  it("the right role at the WRONG outlet may not", () => {
    const verdict = canApprove(step, {
      employee_id: 7,
      outlet_id: 4,
      approver_roles: [APPROVER_ROLE.STORE_MANAGER],
    }, request);
    assert.equal(verdict.allowed, false);
    assert.match(verdict.reason, /own outlet/);
  });

  it("the wrong role may not, however senior", () => {
    const verdict = canApprove(step, {
      employee_id: 7,
      outlet_id: 3,
      approver_roles: [APPROVER_ROLE.HR],
    }, request);
    assert.equal(verdict.allowed, false);
  });

  it("nobody approves a request about their own attendance", () => {
    const verdict = canApprove(step, {
      employee_id: 100,
      outlet_id: 3,
      approver_roles: [APPROVER_ROLE.STORE_MANAGER],
    }, request);
    assert.equal(verdict.allowed, false);
    assert.match(verdict.reason, /your own attendance/);
  });

  it("nor one they raised themselves", () => {
    const verdict = canApprove(step, {
      employee_id: 55,
      outlet_id: 3,
      approver_roles: [APPROVER_ROLE.STORE_MANAGER],
    }, { ...request, requested_for_employee_id: 100, requested_by_employee_id: 55 });
    assert.equal(verdict.allowed, false);
    assert.match(verdict.reason, /raised yourself/);
  });

  it("an administrator may, and it is recorded as an override", () => {
    const verdict = canApprove(step, {
      employee_id: 7,
      user_type: 2,
      outlet_id: 99,
      approver_roles: [],
    }, request);
    assert.equal(verdict.allowed, true);
    assert.equal(verdict.as_admin_override, true);
  });

  it("but an administrator still may not approve their own request", () => {
    const verdict = canApprove(step, {
      employee_id: 100,
      user_type: 2,
      outlet_id: 3,
      approver_roles: [],
    }, request);
    assert.equal(verdict.allowed, false);
  });

  it("a later stage cannot be decided before an earlier one", () => {
    const verdict = canApprove(
      { stage_no: 2, approver_role: APPROVER_ROLE.HR, outlet_id: null, decision: "PENDING" },
      { employee_id: 7, outlet_id: 3, approver_roles: [APPROVER_ROLE.HR] },
      request
    );
    assert.equal(verdict.allowed, false);
    assert.match(verdict.reason, /earlier stage/);
  });

  it("a finished request cannot be decided again", () => {
    const verdict = canApprove(step, {
      employee_id: 7,
      outlet_id: 3,
      approver_roles: [APPROVER_ROLE.STORE_MANAGER],
    }, { ...request, status: REQUEST_STATUS.APPROVED });
    assert.equal(verdict.allowed, false);
  });

  it("a stage already decided cannot be decided twice", () => {
    const verdict = canApprove(
      { ...step, decision: STEP_DECISION.APPROVED },
      { employee_id: 7, outlet_id: 3, approver_roles: [APPROVER_ROLE.STORE_MANAGER] },
      request
    );
    assert.equal(verdict.allowed, false);
  });
});

describe("advancing the chain", () => {
  const chain = buildApprovalChain({
    requester_class: REQUESTER_CLASS.STORE_EMPLOYEE,
    outlet_id: 3,
  });

  it("an approval at stage 1 moves to stage 2 and stays pending", () => {
    assert.deepEqual(advance({ current_stage_no: 1 }, chain, STEP_DECISION.APPROVED), {
      status: REQUEST_STATUS.PENDING,
      current_stage_no: 2,
    });
  });

  it("an approval at the last stage is what approves the request", () => {
    assert.deepEqual(advance({ current_stage_no: 3 }, chain, STEP_DECISION.APPROVED), {
      status: REQUEST_STATUS.APPROVED,
      current_stage_no: 3,
    });
  });

  it("a rejection ends the whole request wherever it happens", () => {
    assert.equal(
      advance({ current_stage_no: 1 }, chain, STEP_DECISION.REJECTED).status,
      REQUEST_STATUS.REJECTED
    );
    assert.equal(
      advance({ current_stage_no: 2 }, chain, STEP_DECISION.REJECTED).status,
      REQUEST_STATUS.REJECTED
    );
  });

  it("only a fully approved request may reach payroll", () => {
    assert.equal(isFinallyApproved({ status: REQUEST_STATUS.APPROVED }), true);
    assert.equal(isFinallyApproved({ status: REQUEST_STATUS.PENDING }), false);
    assert.equal(isFinallyApproved({ status: REQUEST_STATUS.REJECTED }), false);
    assert.equal(isFinallyApproved(null), false);
  });
});
