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
  const calls = { created: [], decided: [], proposed: [], cancelled: [] };
  let nextRequestId = state.first_request_id || 500;

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
      const id = nextRequestId;
      nextRequestId += 1;
      return { attendance_approval_request_id: id, total_stages: chain.length };
    },
    getRequest: async () => state.request || null,
    decideStage: async (args) => {
      calls.decided.push(args);
      if (state.decideStageThrows) throw new Error(state.decideStageThrows);
      return {
        code: 200,
        status: args.next.status,
        current_stage_no: args.next.current_stage_no,
        finalization_state:
          args.next.status === "APPROVED" || args.next.status === "REJECTED"
            ? "SETTLED"
            : "NOT_REQUIRED",
        calculations_written: (args.calculations || []).length,
      };
    },
    // Review fix #6: what the OT auto-queue reads and writes.
    findRequestsForDates: async () => state.existingRequests || [],
    cancelAutoOtRequest: async (args) => {
      calls.cancelled.push(args);
      return { code: 200, attendance_approval_request_id: args.requestId };
    },
    listPendingFor: async (args) => {
      calls.listed = args;
      return state.pending || [];
    },
    listForEmployee: async () => [],
  };

  const calculation = {
    calculateRange: async (args) => {
      calls.calculated = args;
      if (args && args.assume) return [state.assumedDay || state.day || day()];
      return [state.day || day()];
    },
    // The PROPOSED corrected day: raw punches plus the punch being proposed,
    // run through the same engine, stored nowhere.
    calculateProposedDay: async (args) => {
      calls.proposed.push(args);
      return state.proposedDay || day({ punch_count: 4 });
    },
    attendanceDateForPunchTime: async (args) =>
      state.punchResolvesTo === undefined
        ? String(args.punch_time).slice(0, 10)
        : state.punchResolvesTo,
    toStorageRow: (d) => ({ employee_id: d.employee_id, attendance_date: d.attendance_date }),
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
  /**
   * Review fix #3. The incomplete day reports ZERO overtime - an odd punch
   * count leaves the engine before OT is calculated at all - so the request
   * has to carry what the PROPOSED punch would produce, which is what the
   * proposed-day calculation answers.
   */
  it("a missing punch that also earns OT raises one combined request, carrying the OT the proposed punch creates", async () => {
    const { usecase, repo } = fakes({
      day: day({ punch_count: 3, candidate_ot_minutes: 0 }),
      proposedDay: day({ punch_count: 4, candidate_ot_minutes: 150, is_final: true }),
      // A 00:30 finish after a 10:00-22:00 shift belongs to the SHIFT date,
      // which is what the historical cutoff says and what the raise path
      // insists on before it will accept the punch.
      punchResolvesTo: "2026-09-14",
    });
    const result = await usecase.raiseRequest({
      actor,
      requested_for_employee_id: 100,
      attendance_date: "2026-09-14",
      reason: "Forgot to punch out after covering the late shift",
      punch_time: "2026-09-15 00:30:00",
    });

    const [created] = repo.calls.created;
    assert.equal(created.request.request_type, REQUEST_TYPE.REGULARIZATION_WITH_OT);
    assert.equal(
      created.request.candidate_ot_minutes,
      150,
      "the OT the proposed punch produces, not the incomplete day's zero"
    );
    assert.equal(created.chain.length, 3, "one chain, not two");
    assert.equal(result.candidate_ot_minutes, 150);
    assert.equal(result.proposed_day.punch_count, 4);

    // The proposed punch was run through the engine, not assumed.
    assert.equal(repo.calls.proposed.length, 1);
    assert.equal(repo.calls.proposed[0].punch_time, "2026-09-15 00:30:00");
  });

  it("refuses a proposed punch that belongs to a different attendance date", async () => {
    const { usecase } = fakes({
      day: day({ punch_count: 3 }),
      punchResolvesTo: "2026-09-15",
    });
    await assert.rejects(
      usecase.raiseRequest({
        actor,
        requested_for_employee_id: 100,
        attendance_date: "2026-09-14",
        reason: "Forgot to punch out at the end of the shift",
        punch_time: "2026-09-15 09:00:00",
      }),
      /belongs to attendance date 2026-09-15/
    );
  });

  it("refuses a proposed punch that still leaves the punch set odd", async () => {
    const { usecase } = fakes({
      day: day({ punch_count: 3 }),
      proposedDay: day({ punch_count: 5 }),
    });
    await assert.rejects(
      usecase.raiseRequest({
        actor,
        requested_for_employee_id: 100,
        attendance_date: "2026-09-14",
        reason: "Forgot to punch out at the end of the shift",
        punch_time: "2026-09-14 21:00:00",
      }),
      /odd number of punches/
    );
  });

  it("a missing punch that creates NO overtime stays a plain regularization", async () => {
    const { usecase, repo } = fakes({
      day: day({ punch_count: 3, candidate_ot_minutes: 0 }),
      proposedDay: day({ punch_count: 4, candidate_ot_minutes: 0 }),
    });
    await usecase.raiseRequest({
      actor,
      requested_for_employee_id: 100,
      attendance_date: "2026-09-14",
      reason: "Forgot to punch out at the end of the shift",
      punch_time: "2026-09-14 21:00:00",
    });
    const [created] = repo.calls.created;
    assert.equal(created.request.request_type, REQUEST_TYPE.REGULARIZATION);
    assert.equal(created.request.candidate_ot_minutes, 0);
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

    // Review fix #4: the recalculated day travels INTO the decision
    // transaction, rather than being written after it commits.
    const [decided] = repo.calls.decided;
    assert.equal(decided.calculations.length, 1);
    assert.equal(decided.calculations[0].attendance_date, "2026-09-14");
    assert.equal(result.finalization_state, "SETTLED");
  });

  /**
   * Review fix #4, the failure that used to be possible. If storing the
   * recalculated day fails, the whole decision fails with it: the caller sees
   * the error and the request is never reported as approved, so no payable OT
   * can exist against a day that was not recalculated.
   */
  it("a storage failure fails the decision rather than leaving an approved request with a stale day", async () => {
    const { usecase, repo } = fakes({
      request: pendingRequest({ current_stage_no: 3 }),
      identities: {
        7: { employee_id: 7, outlet_id: 3, approver_role: APPROVER_ROLE.HR, requester_class: "MANAGER" },
      },
      decideStageThrows: "the recalculated day could not be stored",
    });

    await assert.rejects(
      usecase.decide({
        actor: { employee_id: 7, user_type: 1 },
        request_id: 500,
        decision: STEP_DECISION.APPROVED,
      }),
      /could not be stored/
    );

    // The decision and the day were offered to the repository together, so
    // there is no half-applied state for anybody to read.
    assert.equal(repo.calls.decided.length, 1);
    assert.equal(repo.calls.decided[0].calculations.length, 1);
    assert.equal(repo.calls.decided[0].next.status, REQUEST_STATUS.APPROVED);
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
    // The date is recalculated in the same transaction on a rejection too: the
    // pending state that was holding it out of payroll has ended.
    assert.equal(repo.calls.decided[0].calculations.length, 1);
    assert.equal(result.finalization_state, "SETTLED");
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
