/**
 * New requests resolve ONE chain: the employee-level mapping when the
 * requester has one, the role/outlet fallback when they do not. Through the
 * REAL regularization usecase over fakes.
 *
 *   node --test usecase/attendance_regularization_employee_chain.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildUsecase = require("./attendance_regularization");
const { APPROVER_ROLE, REQUEST_TYPE, REQUEST_STATUS, STEP_DECISION, EMPLOYEE_STAGE_ROLE, CHAIN_SOURCE } =
  require("../utils/attendance_approval_chain");

const day = (overrides = {}) => ({
  employee_id: 100, attendance_date: "2026-09-10", shift_snapshot: { work_shift_id: 7 },
  punch_count: 1, candidate_ot_minutes: 0, worked_minutes: 660, is_final: true, status: "FINAL", ...overrides,
});

function fakes(state = {}) {
  const calls = { created: [], decided: [] };
  const repo = {
    getApprovalIdentity: async (id) => (state.identities || {})[id] || {
      employee_id: id, employee_name: `Employee ${id}`, outlet_id: 3, designation_id: 11, approver_role: null, requester_class: null,
    },
    findOpenRequest: async () => null,
    findRequestsForDates: async () => [],
    createRequest: async ({ request, chain, punch }) => { calls.created.push({ request, chain, punch }); return { attendance_approval_request_id: 700 + calls.created.length, total_stages: chain.length }; },
    getRequest: async () => state.request || null,
    decideStage: async (args) => { calls.decided.push(args); return { code: 200, status: args.next.status, current_stage_no: args.next.current_stage_no, finalization_state: "SETTLED", calculations_written: 0 }; },
    listPendingFor: async () => [],
    listForEmployee: async () => [],
  };
  const calculation = {
    calculateRange: async (args) => [args && args.assume ? day({ punch_count: 2 }) : state.day || day()],
    calculateProposedDay: async () => day({ punch_count: 2 }),
    attendanceDateForPunchTime: async (args) => String(args.punch_time).slice(0, 10),
    toStorageRow: (d) => d,
  };
  const setupRepo = { getActiveSetup: async (id) => (state.setups || {})[id] || null };
  return {
    calls,
    usecase: buildUsecase(repo, calculation, state.withoutSetupRepo ? undefined : setupRepo),
  };
}

const MAPPED = { 100: { employee_id: 100, first_level_approver_employee_id: 11, second_level_approver_employee_id: 22, final_approver_employee_id: 33 } };
const raiseReg = (usecase, forId = 100) =>
  usecase.raiseRequest({ actor: { employee_id: forId, user_type: 1 }, requested_for_employee_id: forId, attendance_date: "2026-09-10", reason: "Forgot to punch out", punch_time: "2026-09-10 21:00:00" });
const raiseOt = (usecase, forId = 100) =>
  usecase.raiseOtRequest({ actor: { employee_id: forId, user_type: 1 }, attendance_date: "2026-09-10", reason: "Stock count ran late", today: "2026-09-12" });

describe("chain resolution at request creation", () => {
  it("14. a new REGULARIZATION for a mapped employee uses the employee mapping", async () => {
    const { usecase, calls } = fakes({ setups: MAPPED });
    const res = await raiseReg(usecase);
    assert.equal(res.chain_source, CHAIN_SOURCE.EMPLOYEE);
    assert.equal(calls.created[0].request.chain_source, "EMPLOYEE");
    assert.deepEqual(calls.created[0].chain.map((s) => s.approver_employee_id), [11, 22, 33]);
    assert.ok(calls.created[0].chain.every((s) => s.approver_role === EMPLOYEE_STAGE_ROLE));
    assert.equal(calls.created[0].request.request_type, REQUEST_TYPE.REGULARIZATION);
  });
  it("15. a new OT request for a mapped employee uses the employee mapping", async () => {
    const { usecase, calls } = fakes({ setups: MAPPED, day: day({ punch_count: 2, candidate_ot_minutes: 45 }) });
    const res = await raiseOt(usecase);
    assert.equal(res.chain_source, CHAIN_SOURCE.EMPLOYEE);
    assert.deepEqual(calls.created[0].chain.map((s) => s.approver_employee_id), [11, 22, 33]);
    assert.equal(calls.created[0].request.request_type, REQUEST_TYPE.OT);
    assert.equal(calls.created[0].request.candidate_ot_minutes, 45);
  });
  it("16. blank levels are skipped; 17. the Final Approver is the final stage", async () => {
    const { usecase, calls } = fakes({ setups: { 100: { employee_id: 100, first_level_approver_employee_id: null, second_level_approver_employee_id: 22, final_approver_employee_id: 33 } } });
    await raiseReg(usecase);
    const chain = calls.created[0].chain;
    assert.deepEqual(chain.map((s) => [s.stage_no, s.approval_level, s.approver_employee_id]), [[1, "SECOND", 22], [2, "FINAL", 33]]);
    assert.equal(chain[chain.length - 1].approval_level, "FINAL");
    assert.equal(calls.created[0].request.chain_source, "EMPLOYEE");
  });
  it("18. an unmapped employee falls back to the current role/outlet chain, untouched", async () => {
    const { usecase, calls } = fakes({ setups: {} });
    const res = await raiseReg(usecase);
    assert.equal(res.chain_source, CHAIN_SOURCE.ROLE);
    assert.deepEqual(calls.created[0].chain.map((s) => s.approver_role), [APPROVER_ROLE.STORE_MANAGER, APPROVER_ROLE.OPERATIONS_MANAGER, APPROVER_ROLE.HR]);
    assert.equal(calls.created[0].chain[0].outlet_id, 3);
    assert.ok(calls.created[0].chain.every((s) => s.approver_employee_id === undefined));
  });
  it("18b. with no approver store wired at all, the role chain is used exactly as before", async () => {
    const { usecase, calls } = fakes({ withoutSetupRepo: true });
    await raiseReg(usecase);
    assert.equal(calls.created[0].request.chain_source, "ROLE");
    assert.equal(calls.created[0].chain.length, 3);
  });
  it("19. a mapped employee does not use the fallback - no role stage appears in the snapshot", async () => {
    const { usecase, calls } = fakes({ setups: MAPPED, identities: { 100: { employee_id: 100, outlet_id: 3, approver_role: null, requester_class: "STORE_EMPLOYEE" } } });
    await raiseReg(usecase);
    assert.ok(!calls.created[0].chain.some((s) => Object.values(APPROVER_ROLE).includes(s.approver_role)));
  });
  it("20. the request snapshots the ACTUAL approver employee ids, not the mapping row", async () => {
    const setups = { 100: { ...MAPPED[100] } };
    const { usecase, calls } = fakes({ setups });
    await raiseReg(usecase);
    setups[100].final_approver_employee_id = 44; // the mapping changes afterwards
    assert.deepEqual(calls.created[0].chain.map((s) => s.approver_employee_id), [11, 22, 33]);
  });
  it("33. REGULARIZATION and OT remain two separate request types under the employee chain", async () => {
    const { usecase, calls } = fakes({ setups: MAPPED });
    await raiseReg(usecase);
    const withOt = fakes({ setups: MAPPED, day: day({ punch_count: 2, candidate_ot_minutes: 30 }) });
    await raiseOt(withOt.usecase);
    assert.equal(calls.created[0].request.request_type, "REGULARIZATION");
    assert.equal(calls.created[0].request.candidate_ot_minutes, 0);
    assert.equal(withOt.calls.created[0].request.request_type, "OT");
    assert.ok(!calls.created.concat(withOt.calls.created).some((c) => c.request.request_type === "REGULARIZATION_WITH_OT"));
  });
});

describe("deciding an employee-level request", () => {
  const employeeRequest = (overrides = {}) => ({
    attendance_approval_request_id: 701, request_type: "REGULARIZATION", requested_for_employee_id: 100, requested_by_employee_id: 100,
    attendance_date: "2026-09-10", outlet_id: 3, requester_class: "STORE_EMPLOYEE", reason: "Forgot", candidate_ot_minutes: 0,
    status: REQUEST_STATUS.PENDING, current_stage_no: 1, total_stages: 2, chain_source: "EMPLOYEE",
    steps: [
      { stage_no: 1, approver_role: "EMPLOYEE", outlet_id: null, approver_employee_id: 11, approval_level: "FIRST", decision: "PENDING" },
      { stage_no: 2, approver_role: "EMPLOYEE", outlet_id: null, approver_employee_id: 33, approval_level: "FINAL", decision: "PENDING" },
    ],
    regularized_punch: { attendance_regularized_punch_id: 5, punch_time: "2026-09-10 21:00:00" },
    ...overrides,
  });
  it("the snapshotted approver decides the stage and it passes to the Final Approver", async () => {
    const { usecase, calls } = fakes({ request: employeeRequest() });
    const res = await usecase.decide({ actor: { employee_id: 11, user_type: 1 }, request_id: 701, decision: STEP_DECISION.APPROVED });
    assert.equal(res.status, REQUEST_STATUS.PENDING);
    assert.equal(res.current_stage_no, 2);
    assert.equal(calls.decided[0].adminOverride, false);
  });
  it("17b. only the Final Approver's approval makes the request APPROVED", async () => {
    const { usecase } = fakes({ request: employeeRequest({ current_stage_no: 2, steps: [
      { stage_no: 1, approver_role: "EMPLOYEE", approver_employee_id: 11, approval_level: "FIRST", decision: "APPROVED" },
      { stage_no: 2, approver_role: "EMPLOYEE", approver_employee_id: 33, approval_level: "FINAL", decision: "PENDING" },
    ] }) });
    const res = await usecase.decide({ actor: { employee_id: 33, user_type: 1 }, request_id: 701, decision: STEP_DECISION.APPROVED });
    assert.equal(res.status, REQUEST_STATUS.APPROVED);
  });
  it("somebody who holds an approval ROLE but is not the snapshotted approver is refused", async () => {
    const { usecase } = fakes({ request: employeeRequest(), identities: { 22: { employee_id: 22, outlet_id: 3, approver_role: "HR", requester_class: "MANAGER" } } });
    await assert.rejects(usecase.decide({ actor: { employee_id: 22, user_type: 1 }, request_id: 701, decision: "APPROVED" }), /assigned approver/);
  });
  it("28. no self-approval at decision time, even when the snapshot names the requester", async () => {
    const { usecase } = fakes({ request: employeeRequest({ steps: [{ stage_no: 1, approver_role: "EMPLOYEE", approver_employee_id: 100, approval_level: "FINAL", decision: "PENDING" }], total_stages: 1 }) });
    await assert.rejects(usecase.decide({ actor: { employee_id: 100, user_type: 2 }, request_id: 701, decision: "APPROVED" }), /your own attendance/);
  });
  it("32. a historical role-based request still works exactly as before", async () => {
    const roleRequest = employeeRequest({ chain_source: null, steps: [
      { stage_no: 1, approver_role: "STORE_MANAGER", outlet_id: 3, approver_employee_id: null, approval_level: null, decision: "PENDING" },
      { stage_no: 2, approver_role: "HR", outlet_id: null, approver_employee_id: null, approval_level: null, decision: "PENDING" },
    ] });
    const { usecase } = fakes({ request: roleRequest, identities: { 11: { employee_id: 11, outlet_id: 3, approver_role: "STORE_MANAGER", requester_class: "MANAGER" }, 12: { employee_id: 12, outlet_id: 4, approver_role: "STORE_MANAGER", requester_class: "MANAGER" } } });
    const res = await usecase.decide({ actor: { employee_id: 11, user_type: 1 }, request_id: 701, decision: "APPROVED" });
    assert.equal(res.current_stage_no, 2);
    await assert.rejects(usecase.decide({ actor: { employee_id: 12, user_type: 1 }, request_id: 701, decision: "APPROVED" }), /own outlet/);
  });
});
