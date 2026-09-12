/**
 * Attendance v2 / A3 - raising and deciding a request, against fakes.
 *
 * No MySQL and no Express. What is exercised here is the part that is easy to
 * get wrong and expensive to get wrong: that only a MISSING punch may be
 * regularized, that an existing punch can never be named let alone replaced,
 * that nothing becomes payable before the last stage, and that the same date
 * cannot be regularized twice at once.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildUsecase = require("../usecase/attendance_regularization");
const {
  APPROVER_ROLE,
  REQUEST_TYPE,
  REQUEST_STATUS,
  STEP_DECISION,
} = require("../utils/attendance_approval_chain");

/** A calculated day, as `calculateRange` returns one. */
const day = (overrides = {}) => ({
  employee_id: 100,
  attendance_date: "2026-09-14",
  shift_snapshot: { work_shift_id: 7, snapshot_hash: "abc" },
  punch_count: 2,
  candidate_ot_minutes: 0,
  worked_minutes: 660,
  is_final: true,
  ...overrides,
});

function fakes(state = {}) {
  const calls = { created: [], decided: [], recalculated: [] };

  const repo = {
    calls,
    getApprovalIdentity: async (id) =>
      (state.identities || {})[id] || {
        employee_id: id,
        employee_name: `Employee ${id}`,
        outlet_id: 3,
        designation_id: 11,
        designation_name: "SALES ASSOCIATE",
        approver_role: null,
        requester_class: null,
      },
    findOpenRequest: async () => state.openRequest || null,
    createRequest: async ({ request, chain, punch }) => {
      calls.created.push({ request, chain, punch });
      return { attendance_approval_request_id: 500, total_stages: chain.length };
    },
    getRequest: async () => state.request || null,
    decideStage: async (args) => {
      calls.decided.push(args);
      return { code: 200, status: args.next.status, current_stage_no: args.next.current_stage_no };
    },
    listPendingFor: async (args) => {
      calls.listed = args;
      return state.pending || [];
    },
    listForEmployee: async () => [],
  };

  const calculation = {
    calculateRange: async () => [state.day || day()],
    recalculateRange: async (args) => {
      calls.recalculated.push(args);
      return { days: [day()] };
    },
  };

  return { repo, calculation, usecase: buildUsecase(repo, calculation) };
}

const actor = { employee_id: 100, user_type: 1 };

describe("only a missing punch may be regularized", () => {
  it("refuses a date whose punch count is already even", async () => {
    const { usecase } = fakes({ day: day({ punch_count: 2, candidate_ot_minutes: 0 }) });
    await assert.rejects(
      usecase.raiseRequest({
        actor,
        requested_for_employee_id: 100,
        attendance_date: "2026-09-14",
        reason: "Forgot to punch out",
      }),
      /nothing to approve/
    );
  });

  it("refuses a manual punch on a complete day", async () => {
    const { usecase } = fakes({ day: day({ punch_count: 2, candidate_ot_minutes: 15 }) });
    await assert.rejects(
      usecase.raiseRequest({
        actor,
        requested_for_employee_id: 100,
        attendance_date: "2026-09-14",
        reason: "Trying to change an existing punch",
        punch_time: "2026-09-14 20:00:00",
      }),
      /cannot be added to a complete day/
    );
  });

  it("requires a punch time when a punch really is missing", async () => {
    const { usecase } = fakes({ day: day({ punch_count: 3 }) });
    await assert.rejects(
      usecase.raiseRequest({
        actor,
        requested_for_employee_id: 100,
        attendance_date: "2026-09-14",
        reason: "Forgot to punch out",
      }),
      /punch_time is required/
    );
  });

  it("creates the request and its manual punch when one is missing", async () => {
    const { usecase, repo } = fakes({ day: day({ punch_count: 3 }) });
    const result = await usecase.raiseRequest({
      actor,
      requested_for_employee_id: 100,
      attendance_date: "2026-09-14",
      reason: "Forgot to punch out at the end of the shift",
      punch_time: "2026-09-14 21:00:00",
    });

    assert.equal(result.attendance_approval_request_id, 500);
    const [created] = repo.calls.created;
    assert.equal(created.request.request_type, REQUEST_TYPE.REGULARIZATION);
    assert.equal(created.punch.punch_time, "2026-09-14 21:00:00");
    // There is no field anywhere for the id of a punch to replace.
    assert.ok(!("replaces_punch_id" in created.punch));
    assert.ok(!("biomax_punch_id" in created.punch));
  });

  it("refuses a date with no shift resolved", async () => {
    const { usecase } = fakes({ day: day({ shift_snapshot: null, punch_count: 3 }) });
    await assert.rejects(
      usecase.raiseRequest({
        actor,
        requested_for_employee_id: 100,
        attendance_date: "2026-08-31",
        reason: "Forgot to punch out",
      }),
      /no work shift resolved/
    );
  });

  it("refuses a second open request for the same date", async () => {
    const { usecase } = fakes({
      day: day({ punch_count: 3 }),
      openRequest: { attendance_approval_request_id: 44, status: "PENDING" },
    });
    await assert.rejects(
      usecase.raiseRequest({
        actor,
        requested_for_employee_id: 100,
        attendance_date: "2026-09-14",
        reason: "Forgot to punch out",
        punch_time: "2026-09-14 21:00:00",
      }),
      /already an open request/
    );
  });

  it("refuses a reason that says nothing", async () => {
    const { usecase } = fakes({ day: day({ punch_count: 3 }) });
    await assert.rejects(
      usecase.raiseRequest({
        actor,
        requested_for_employee_id: 100,
        attendance_date: "2026-09-14",
        reason: "x",
        punch_time: "2026-09-14 21:00:00",
      }),
      /at least 5 characters/
    );
  });
});

describe("one date, one request, one pass", () => {
  it("a missing punch that also earns OT raises one combined request", async () => {
    const { usecase, repo } = fakes({ day: day({ punch_count: 3, candidate_ot_minutes: 45 }) });
    await usecase.raiseRequest({
      actor,
      requested_for_employee_id: 100,
      attendance_date: "2026-09-14",
      reason: "Forgot to punch out after covering the late shift",
      punch_time: "2026-09-14 22:00:00",
    });

    const [created] = repo.calls.created;
    assert.equal(created.request.request_type, REQUEST_TYPE.REGULARIZATION_WITH_OT);
    assert.equal(created.request.candidate_ot_minutes, 45);
    assert.equal(created.chain.length, 3, "one chain, not two");
  });

  it("OT with no missing punch walks the same chain", async () => {
    const { usecase, repo } = fakes({ day: day({ punch_count: 4, candidate_ot_minutes: 30 }) });
    await usecase.raiseRequest({
      actor,
      requested_for_employee_id: 100,
      attendance_date: "2026-09-14",
      reason: "Stayed late for the stock count",
    });

    const [created] = repo.calls.created;
    assert.equal(created.request.request_type, REQUEST_TYPE.OT);
    assert.deepEqual(created.chain.map((s) => s.approver_role), [
      APPROVER_ROLE.STORE_MANAGER,
      APPROVER_ROLE.OPERATIONS_MANAGER,
      APPROVER_ROLE.HR,
    ]);
    assert.equal(created.punch, null);
  });
});

describe("the conservative default for an unmapped designation", () => {
  it("follows the strictest chain, and grants no approver role", async () => {
    const { usecase } = fakes();
    const identity = await usecase.resolveIdentity(100);

    assert.equal(identity.requester_class, "STORE_EMPLOYEE");
    assert.equal(identity.requester_class_is_default, true);
    assert.deepEqual(identity.approver_roles, [], "authority is granted, never defaulted");
  });

  it("a mapped designation uses what it was mapped to", async () => {
    const { usecase } = fakes({
      identities: {
        7: {
          employee_id: 7,
          outlet_id: 3,
          designation_id: 2,
          designation_name: "STORE MANAGER",
          approver_role: APPROVER_ROLE.STORE_MANAGER,
          requester_class: "STORE_EMPLOYEE",
        },
      },
    });
    const identity = await usecase.resolveIdentity(7);
    assert.deepEqual(identity.approver_roles, [APPROVER_ROLE.STORE_MANAGER]);
    assert.equal(identity.is_store_manager, true);
  });

  it("a Store Manager's own request skips the Store Manager stage", async () => {
    const { usecase, repo } = fakes({
      day: day({ punch_count: 3 }),
      identities: {
        7: {
          employee_id: 7,
          outlet_id: 3,
          designation_id: 2,
          designation_name: "STORE MANAGER",
          approver_role: APPROVER_ROLE.STORE_MANAGER,
          requester_class: "STORE_EMPLOYEE",
        },
      },
    });
    await usecase.raiseRequest({
      actor: { employee_id: 7, user_type: 1 },
      requested_for_employee_id: 7,
      attendance_date: "2026-09-14",
      reason: "Terminal was offline at closing",
      punch_time: "2026-09-14 21:00:00",
    });

    const [created] = repo.calls.created;
    assert.deepEqual(created.chain.map((s) => s.approver_role), [
      APPROVER_ROLE.OPERATIONS_MANAGER,
      APPROVER_ROLE.HR,
    ]);
  });
});

describe("deciding a stage", () => {
  const pendingRequest = (overrides = {}) => ({
    attendance_approval_request_id: 500,
    request_type: REQUEST_TYPE.REGULARIZATION_WITH_OT,
    requested_for_employee_id: 100,
    requested_by_employee_id: 100,
    attendance_date: "2026-09-14",
    outlet_id: 3,
    requester_class: "STORE_EMPLOYEE",
    candidate_ot_minutes: 45,
    status: REQUEST_STATUS.PENDING,
    current_stage_no: 1,
    total_stages: 3,
    steps: [
      { stage_no: 1, approver_role: APPROVER_ROLE.STORE_MANAGER, outlet_id: 3, decision: "PENDING" },
      { stage_no: 2, approver_role: APPROVER_ROLE.OPERATIONS_MANAGER, outlet_id: null, decision: "PENDING" },
      { stage_no: 3, approver_role: APPROVER_ROLE.HR, outlet_id: null, decision: "PENDING" },
    ],
    ...overrides,
  });

  const managerIdentity = {
    7: {
      employee_id: 7,
      outlet_id: 3,
      designation_id: 2,
      designation_name: "STORE MANAGER",
      approver_role: APPROVER_ROLE.STORE_MANAGER,
      requester_class: "MANAGER",
    },
  };

  it("approves stage 1 and leaves the request pending, with NO payable OT", async () => {
    const { usecase, repo } = fakes({ request: pendingRequest(), identities: managerIdentity });
    const result = await usecase.decide({
      actor: { employee_id: 7, user_type: 1 },
      request_id: 500,
      decision: STEP_DECISION.APPROVED,
    });

    assert.equal(result.status, REQUEST_STATUS.PENDING);
    assert.equal(result.current_stage_no, 2);
    assert.equal(result.approved_ot_minutes, null, "nothing is payable before the last stage");
    assert.equal(repo.calls.decided[0].next.approved_ot_minutes, null);
  });

  it("the last stage is what makes the OT payable, clamped to the candidate", async () => {
    const { usecase, repo } = fakes({
      request: pendingRequest({ current_stage_no: 3 }),
      identities: {
        7: { employee_id: 7, outlet_id: 3, approver_role: APPROVER_ROLE.HR, requester_class: "MANAGER" },
      },
    });
    const result = await usecase.decide({
      actor: { employee_id: 7, user_type: 1 },
      request_id: 500,
      decision: STEP_DECISION.APPROVED,
    });

    assert.equal(result.status, REQUEST_STATUS.APPROVED);
    assert.equal(result.approved_ot_minutes, 45);
    assert.equal(repo.calls.recalculated.length, 1, "the date is recalculated immediately");
    assert.equal(repo.calls.recalculated[0].from_date, "2026-09-14");
  });

  it("refuses somebody who is not the current approver", async () => {
    const { usecase } = fakes({
      request: pendingRequest(),
      identities: {
        8: { employee_id: 8, outlet_id: 3, approver_role: APPROVER_ROLE.HR, requester_class: "MANAGER" },
      },
    });
    await assert.rejects(
      usecase.decide({ actor: { employee_id: 8, user_type: 1 }, request_id: 500, decision: "APPROVED" }),
      (err) => err.name === "ForbiddenError"
    );
  });

  it("refuses a Store Manager from another outlet", async () => {
    const { usecase } = fakes({
      request: pendingRequest(),
      identities: {
        9: {
          employee_id: 9,
          outlet_id: 4,
          approver_role: APPROVER_ROLE.STORE_MANAGER,
          requester_class: "MANAGER",
        },
      },
    });
    await assert.rejects(
      usecase.decide({ actor: { employee_id: 9, user_type: 1 }, request_id: 500, decision: "APPROVED" }),
      /own outlet/
    );
  });

  it("refuses the subject of the request, even as an administrator", async () => {
    const { usecase } = fakes({
      request: pendingRequest(),
      identities: {
        100: { employee_id: 100, outlet_id: 3, approver_role: APPROVER_ROLE.ADMIN, requester_class: "HEAD" },
      },
    });
    await assert.rejects(
      usecase.decide({ actor: { employee_id: 100, user_type: 2 }, request_id: 500, decision: "APPROVED" }),
      /your own attendance/
    );
  });

  it("records an administrator short-cut as an override", async () => {
    const { usecase, repo } = fakes({
      request: pendingRequest(),
      identities: {
        3: { employee_id: 3, outlet_id: 99, approver_role: null, requester_class: null },
      },
    });
    const result = await usecase.decide({
      actor: { employee_id: 3, user_type: 2 },
      request_id: 500,
      decision: STEP_DECISION.APPROVED,
    });
    assert.equal(result.acted_as_admin_override, true);
    assert.equal(repo.calls.decided[0].adminOverride, true);
  });

  it("a rejection ends the request and still recalculates the date", async () => {
    const { usecase, repo } = fakes({ request: pendingRequest(), identities: managerIdentity });
    const result = await usecase.decide({
      actor: { employee_id: 7, user_type: 1 },
      request_id: 500,
      decision: STEP_DECISION.REJECTED,
      remarks: "The employee was not on site",
    });

    assert.equal(result.status, REQUEST_STATUS.REJECTED);
    assert.equal(result.approved_ot_minutes, null);
    assert.equal(repo.calls.recalculated.length, 1);
  });

  it("refuses a decision that is neither approve nor reject", async () => {
    const { usecase } = fakes({ request: pendingRequest() });
    await assert.rejects(
      usecase.decide({ actor, request_id: 500, decision: "MAYBE" }),
      /APPROVED or REJECTED/
    );
  });
});

describe("the pending queue", () => {
  it("asks only for the roles the actor actually holds", async () => {
    const { usecase, repo } = fakes({
      identities: {
        7: { employee_id: 7, outlet_id: 3, approver_role: APPROVER_ROLE.HR, requester_class: "MANAGER" },
      },
    });
    await usecase.listPending({ actor: { employee_id: 7, user_type: 1 } });
    assert.deepEqual(repo.calls.listed.approver_roles, [APPROVER_ROLE.HR]);
    assert.equal(repo.calls.listed.actor_employee_id, 7);
  });

  it("shows an administrator every stage", async () => {
    const { usecase, repo } = fakes({
      identities: { 3: { employee_id: 3, outlet_id: 1, approver_role: null, requester_class: null } },
    });
    await usecase.listPending({ actor: { employee_id: 3, user_type: 2 } });
    assert.deepEqual(repo.calls.listed.approver_roles.sort(), [
      "ADMIN",
      "HR",
      "OPERATIONS_MANAGER",
      "STORE_MANAGER",
    ]);
  });

  it("shows nothing to somebody who holds no role at all", async () => {
    const { usecase } = fakes();
    const result = await usecase.listPending({ actor: { employee_id: 100, user_type: 1 } });
    assert.deepEqual(result.rows, []);
  });
});
