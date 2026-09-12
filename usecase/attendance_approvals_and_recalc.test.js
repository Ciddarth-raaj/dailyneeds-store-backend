/**
 * The approval screens' backend and the bulk recalculation, through the REAL
 * usecases over fakes.
 *
 *   node --test usecase/attendance_approvals_and_recalc.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildCalculation = require("../usecase/attendance_calculation");
const buildRegularization = require("../usecase/attendance_regularization");
const { CALC_STATUS } = require("../utils/attendance_engine");
const { REQUEST_TYPE, REQUEST_STATUS, STEP_DECISION, APPROVER_ROLE } =
  require("../utils/attendance_approval_chain");

/* ============================================================ fixtures */

const weekly = (workShiftId, inTime, outTime) =>
  Array.from({ length: 7 }, (_, day) => ({
    work_shift_weekly_schedule_id: workShiftId * 100 + day,
    work_shift_id: workShiftId,
    day_of_week: day,
    is_working_day: 1,
    in_time: inTime,
    out_time: outTime,
    attendance_day_cutoff: "04:00:00",
    break_minutes: 60,
    normal_work_minutes: 660,
    ot_rate: 1,
  }));
const config = (id, code, name) => ({
  work_shift_id: id, shift_code: code, shift_name: name, active: 1,
  overtime_allowed: 1, overtime_minimum_minutes: 0, overtime_rounding_method: "NONE",
  overtime_rounding_interval_minutes: 0, overtime_minimum_threshold_only: 0,
  maximum_ot_minutes_per_day: null, pre_shift_overtime_allowed: 0,
  pre_shift_overtime_minimum_minutes: 0, pre_shift_overtime_rounding_method: "NONE",
  pre_shift_overtime_rounding_interval_minutes: 0, late_offset_against_overtime: 0,
  early_exit_offset_against_overtime: 0,
});
const SHIFTS = {
  7: { config: config(7, "LATE", "Late Shift"), schedule: weekly(7, "10:00:00", "22:00:00") },
  8: { config: config(8, "MORN", "Morning Shift"), schedule: weekly(8, "06:00:00", "14:00:00") },
};
const punch = (id, employee_id, ioTime) => ({
  punch_id: id, employee_id, io_time: ioTime, punch_date: ioTime.slice(0, 10),
  ingest_attendance_date: ioTime.slice(0, 10), dev_id: "DEV1", ingest_source: "DEVICE",
});

/** Employees: 42 and 43 at outlet 3, 44 at outlet 5. 7 = Store Manager of 3, 8 = HR, 9 = SM of 5. */
const EMPLOYEES = [
  { employee_id: 42, employee_name: "Asha", store_id: 3, designation_id: 11, status: 1, date_of_joining: "2020-01-01", resignation_date: null },
  { employee_id: 43, employee_name: "Bala", store_id: 3, designation_id: 12, status: 1, date_of_joining: "2020-01-01", resignation_date: null },
  { employee_id: 44, employee_name: "Chitra", store_id: 5, designation_id: 11, status: 1, date_of_joining: "2020-01-01", resignation_date: null },
  { employee_id: 45, employee_name: "Left", store_id: 3, designation_id: 11, status: 0, date_of_joining: "2020-01-01", resignation_date: "2026-08-01" },
  { employee_id: 46, employee_name: "Joiner", store_id: 3, designation_id: 11, status: 1, date_of_joining: "2026-10-01", resignation_date: null },
];
const IDENTITIES = {
  7: { employee_id: 7, employee_name: "Mgr3", outlet_id: 3, designation_id: 2, designation_name: "STORE MANAGER", approver_role: APPROVER_ROLE.STORE_MANAGER, requester_class: "MANAGER" },
  8: { employee_id: 8, employee_name: "HR", outlet_id: 1, designation_id: 3, designation_name: "HR EXECUTIVE", approver_role: APPROVER_ROLE.HR, requester_class: "MANAGER" },
  9: { employee_id: 9, employee_name: "Mgr5", outlet_id: 5, designation_id: 2, designation_name: "STORE MANAGER", approver_role: APPROVER_ROLE.STORE_MANAGER, requester_class: "MANAGER" },
  10: { employee_id: 10, employee_name: "Ops", outlet_id: 1, designation_id: 4, designation_name: "OPS", approver_role: APPROVER_ROLE.OPERATIONS_MANAGER, requester_class: "MANAGER" },
};

function build(state = {}) {
  const saved = { calculations: [], runs: [] };
  const overrides = [...(state.overrides || [])];
  const store = { requests: [], steps: [], decided: [] };
  let nextId = 900;
  let nextRun = 1;

  const calcRepo = {
    saved,
    getShiftAssignmentHistory: async (employeeId) =>
      (state.assignments && state.assignments[employeeId]) || [
        { employee_work_shift_assignment_id: 1, employee_id: employeeId, work_shift_id: 7, effective_from: "2026-09-01", source: "MIGRATION_BACKFILL" },
      ],
    getDateShiftOverrides: async (employeeId, from, to) =>
      overrides.filter((o) => o.employee_id === employeeId && o.attendance_date >= from && o.attendance_date <= to),
    getWorkShiftWithSchedule: async (id) => SHIFTS[id] || null,
    getWorkShiftConfigVersions: async () => [],
    getRawPunchesByCalendarWindow: async (employeeId, from, to) => {
      if (state.punchesThrowFor && state.punchesThrowFor.includes(employeeId)) throw new Error("ER_LOCK_WAIT_TIMEOUT");
      return (state.rawPunches || []).filter((p) => p.employee_id === employeeId && p.punch_date >= from && p.punch_date <= to);
    },
    getApprovedRegularizedPunches: async (employeeId) =>
      (state.regularized || []).filter((r) => r.employee_id === employeeId),
    getBreakOverride: async () => null,
    getApprovalStateByDate: async (employeeId, from, to) =>
      store.requests
        .filter((r) => r.requested_for_employee_id === employeeId && r.status !== "CANCELLED" && r.attendance_date >= from && r.attendance_date <= to)
        .map((r) => ({ ...r })),
    getEmploymentWindow: async (id) => EMPLOYEES.find((e) => e.employee_id === Number(id)) || null,
    getMonthlyGrossAsOf: async () => null,
    saveCalculations: async (rows) => { saved.calculations.push(rows); return { written: rows.length }; },
    listEmployeesForRecalculation: async ({ employee_id, store_id, designation_id, from_date }) =>
      EMPLOYEES.filter((e) =>
        (e.status === 1 || e.resignation_date === null || e.resignation_date >= from_date) &&
        (!employee_id || e.employee_id === employee_id) &&
        (!store_id || e.store_id === store_id) &&
        (!designation_id || e.designation_id === designation_id)
      ),
    outletExists: async (id) => [1, 3, 5].includes(id),
    designationExists: async (id) => [11, 12].includes(id),
    insertRecalculationRun: async (run) => { const id = nextRun; nextRun += 1; saved.runs.push({ id, ...run, status: "RUNNING" }); return id; },
    finishRecalculationRun: async (id, outcome) => { Object.assign(saved.runs.find((r) => r.id === id), outcome); },
    listRecalculationRuns: async () => saved.runs.map((r) => ({ ...r, errors: JSON.stringify(r.errors || []) })),
  };

  const regRepo = {
    store,
    getApprovalIdentity: async (id) =>
      IDENTITIES[id] || (() => {
        const e = EMPLOYEES.find((x) => x.employee_id === Number(id));
        return e ? { employee_id: e.employee_id, employee_name: e.employee_name, outlet_id: e.store_id, designation_id: e.designation_id, designation_name: "STAFF", approver_role: null, requester_class: null } : null;
      })(),
    findOpenRequest: async (employeeId, date) =>
      store.requests.find((r) => r.requested_for_employee_id === employeeId && r.attendance_date === date && r.status === "PENDING") || null,
    findRequestsForDates: async (employeeId, dates) =>
      store.requests.filter((r) => r.requested_for_employee_id === employeeId && dates.includes(r.attendance_date) && r.status !== "CANCELLED"),
    createRequest: async ({ request, chain, punch: manual }) => {
      const id = nextId; nextId += 1;
      store.requests.push({
        attendance_approval_request_id: id, ...request, auto_created: request.auto_created ? 1 : 0,
        status: "PENDING", current_stage_no: 1, total_stages: chain.length, finalization_state: "NOT_REQUIRED",
        approved_ot_minutes: null, closure_reason: null, created_at: "2026-09-15 09:00:00", decided_at: null,
        punch: manual,
      });
      chain.forEach((s) => store.steps.push({ attendance_approval_request_id: id, attendance_approval_step_id: id * 10 + s.stage_no, stage_no: s.stage_no, approver_role: s.approver_role, outlet_id: s.outlet_id, decision: "PENDING", decided_by_employee_id: null, decided_by_name: null, decided_at: null, remarks: null, acted_as_admin_override: 0 }));
      return { attendance_approval_request_id: id, total_stages: chain.length };
    },
    getRequest: async (id) => {
      const r = store.requests.find((x) => x.attendance_approval_request_id === Number(id));
      if (!r) return null;
      return { ...r, steps: store.steps.filter((s) => s.attendance_approval_request_id === r.attendance_approval_request_id), regularized_punch: r.punch ? { attendance_regularized_punch_id: 77, punch_time: r.punch.punch_time } : null };
    },
    decideStage: async (args) => {
      store.decided.push(args);
      const r = store.requests.find((x) => x.attendance_approval_request_id === args.requestId);
      const st = store.steps.find((s) => s.attendance_approval_request_id === args.requestId && s.stage_no === args.stageNo);
      st.decision = args.decision; st.decided_by_employee_id = args.actorId; st.decided_by_name = (IDENTITIES[args.actorId] || {}).employee_name || null; st.decided_at = "2026-09-16 10:00:00"; st.remarks = args.remarks;
      r.status = args.next.status; r.current_stage_no = args.next.current_stage_no; r.approved_ot_minutes = args.next.approved_ot_minutes;
      r.finalization_state = args.next.status === "PENDING" ? "NOT_REQUIRED" : "SETTLED";
      if (args.next.status !== "PENDING") r.decided_at = "2026-09-16 10:00:00";
      return { code: 200, status: r.status, current_stage_no: r.current_stage_no, finalization_state: r.finalization_state, calculations_written: (args.calculations || []).length };
    },
    // The scope, mirrored from the SQL in the repository.
    _visible: ({ request_type, status, approver_roles, outlet_id, actor_employee_id, is_admin }) =>
      store.requests.filter((r) => {
        if (r.request_type !== request_type) return false;
        if (status === "PENDING") {
          if (r.status !== "PENDING") return false;
          const s = store.steps.find((x) => x.attendance_approval_request_id === r.attendance_approval_request_id && x.stage_no === r.current_stage_no);
          if (!s || s.decision !== "PENDING") return false;
          if (!is_admin && !(approver_roles.includes(s.approver_role) && (s.approver_role !== "STORE_MANAGER" || s.outlet_id === outlet_id))) return false;
        } else {
          if (status === "APPROVED" || status === "REJECTED") { if (r.status !== status) return false; }
          else if (r.status === "CANCELLED") return false;
          if (!is_admin && !store.steps.some((x) => x.attendance_approval_request_id === r.attendance_approval_request_id && approver_roles.includes(x.approver_role) && (x.approver_role !== "STORE_MANAGER" || x.outlet_id === outlet_id))) return false;
        }
        if (!is_admin && (r.requested_for_employee_id === actor_employee_id || r.requested_by_employee_id === actor_employee_id)) return false;
        return true;
      }),
    listApprovals: async (f) => regRepo._visible(f).map((r) => ({
      ...r, employee_name: (EMPLOYEES.find((e) => e.employee_id === r.requested_for_employee_id) || {}).employee_name,
      outlet_name: `Outlet ${r.outlet_id}`, proposed_punch_time: r.punch ? r.punch.punch_time : null,
      shift_snapshot: null, effective_punches: null, nrm_minutes: 660, worked_minutes: 700, shortage_minutes: 0,
      stored_candidate_ot_minutes: r.candidate_ot_minutes, stored_status: "FINAL", shift_name: "Late Shift",
    })),
    countApprovals: async (f) => regRepo._visible(f).length,
    listStepsForRequests: async (ids) => store.steps.filter((s) => ids.includes(s.attendance_approval_request_id)),
    listPendingFor: async () => [],
    listForEmployee: async () => [],
    closeOtAtPayrollLock: async () => ({ rejected_pending: 0, closed_unrequested: 0 }),
  };

  const calculation = buildCalculation(calcRepo);
  const regularization = buildRegularization(regRepo, calculation);
  calculation.setOtRequestService(regularization);
  return { calcRepo, regRepo, calculation, regularization, store, saved };
}

const TODAY = "2026-09-20";
const lateDay = (employee_id, date) => [punch(employee_id * 10, employee_id, `${date} 10:00:00`), punch(employee_id * 10 + 1, employee_id, `${date} 23:30:00`)];

/* ================================================ attendance approval */

describe("Attendance Approval - REGULARIZATION pending with me", () => {
  const seed = () => {
    const world = build({ rawPunches: [punch(1, 42, "2026-09-14 10:00:00"), punch(2, 44, "2026-09-14 10:00:00"), ...lateDay(43, "2026-09-14")] });
    return world;
  };
  const raiseAll = async (world) => {
    const { regularization } = world;
    await regularization.raiseRequest({ actor: { employee_id: 42, user_type: 1 }, requested_for_employee_id: 42, attendance_date: "2026-09-14", reason: "Terminal offline at close", punch_time: "2026-09-14 22:00:00" });
    await regularization.raiseRequest({ actor: { employee_id: 44, user_type: 1 }, requested_for_employee_id: 44, attendance_date: "2026-09-14", reason: "Terminal offline at close", punch_time: "2026-09-14 22:00:00" });
    await regularization.raiseOtRequest({ actor: { employee_id: 43, user_type: 1 }, attendance_date: "2026-09-14", reason: "Stock count ran late", today: TODAY });
  };

  it("1/2. contains REGULARIZATION only - the OT request on the same outlet does not appear", async () => {
    const world = seed(); await raiseAll(world);
    const result = await world.regularization.listApprovals({ actor: { employee_id: 7, user_type: 1 }, request_type: REQUEST_TYPE.REGULARIZATION, status: "PENDING" });
    assert.ok(result.rows.length > 0);
    result.rows.forEach((r) => assert.equal(r.request_type, REQUEST_TYPE.REGULARIZATION));
    assert.ok(!result.rows.some((r) => r.employee_id === 43), "43's OT request is not attendance approval");
  });

  it("3/4. pending with me is the actor's CURRENT actionable stage, scoped to their outlet", async () => {
    const world = seed(); await raiseAll(world);
    const mgr3 = await world.regularization.listApprovals({ actor: { employee_id: 7, user_type: 1 }, request_type: REQUEST_TYPE.REGULARIZATION, status: "PENDING" });
    assert.deepEqual(mgr3.rows.map((r) => r.employee_id), [42], "only outlet 3's request, not outlet 5's");
    assert.equal(mgr3.total, 1);
    assert.equal(mgr3.rows[0].actionable, true);
    assert.equal(mgr3.rows[0].current_stage_role, APPROVER_ROLE.STORE_MANAGER);

    const mgr5 = await world.regularization.listApprovals({ actor: { employee_id: 9, user_type: 1 }, request_type: REQUEST_TYPE.REGULARIZATION, status: "PENDING" });
    assert.deepEqual(mgr5.rows.map((r) => r.employee_id), [44]);

    // HR's stage is 3; nothing is with HR yet, so HR's pending is empty and
    // so is the count - the count is type-specific and stage-specific.
    const hr = await world.regularization.listApprovals({ actor: { employee_id: 8, user_type: 1 }, request_type: REQUEST_TYPE.REGULARIZATION, status: "PENDING" });
    assert.equal(hr.rows.length, 0);
    assert.deepEqual(await world.regularization.countPending({ actor: { employee_id: 8, user_type: 1 }, request_type: REQUEST_TYPE.REGULARIZATION }), { request_type: "REGULARIZATION", pending_with_me: 0 });
    assert.deepEqual(await world.regularization.countPending({ actor: { employee_id: 7, user_type: 1 }, request_type: REQUEST_TYPE.REGULARIZATION }), { request_type: "REGULARIZATION", pending_with_me: 1 });
    assert.deepEqual(await world.regularization.countPending({ actor: { employee_id: 7, user_type: 1 }, request_type: REQUEST_TYPE.OT }), { request_type: "OT", pending_with_me: 1 });
  });

  it("returns the inline detail: existing punches, the proposed punch, the reason, NRM/worked/shortage, the chain", async () => {
    const world = seed(); await raiseAll(world);
    const [row] = (await world.regularization.listApprovals({ actor: { employee_id: 7, user_type: 1 }, request_type: REQUEST_TYPE.REGULARIZATION, status: "PENDING" })).rows;
    assert.equal(row.employee_name, "Asha");
    assert.equal(row.attendance_date, "2026-09-14");
    assert.equal(row.shift_name, "Late Shift");
    assert.equal(row.effective_punches.length, 1, "the live incomplete day");
    assert.equal(row.proposed_punch_time, "2026-09-14 22:00:00");
    assert.equal(row.reason, "Terminal offline at close");
    assert.equal(typeof row.nrm_minutes, "number");
    assert.equal(row.chain.length, 3);
    assert.equal(row.chain[0].decision, "PENDING");
    assert.equal(row.submitted_at, "2026-09-15 09:00:00");
    assert.equal(row.claimed_ot_minutes, 0);
    assert.equal(row.eligible_ot_minutes, 0, "no OT figure on an attendance approval");
  });

  it("5. the requester never sees their own request as pending with them", async () => {
    const world = build({ rawPunches: [punch(1, 7, "2026-09-14 10:00:00")] });
    // The Store Manager raises their own regularization (Manager chain: Ops -> HR).
    await world.regularization.raiseRequest({ actor: { employee_id: 7, user_type: 1 }, requested_for_employee_id: 7, attendance_date: "2026-09-14", reason: "Terminal offline at close", punch_time: "2026-09-14 22:00:00" });
    const own = await world.regularization.listApprovals({ actor: { employee_id: 7, user_type: 1 }, request_type: REQUEST_TYPE.REGULARIZATION, status: "PENDING" });
    assert.equal(own.rows.length, 0);
    const ops = await world.regularization.listApprovals({ actor: { employee_id: 10, user_type: 1 }, request_type: REQUEST_TYPE.REGULARIZATION, status: "PENDING" });
    assert.equal(ops.rows.length, 1);
    await assert.rejects(
      world.regularization.decide({ actor: { employee_id: 7, user_type: 2 }, request_id: ops.rows[0].attendance_approval_request_id, decision: STEP_DECISION.APPROVED }),
      /your own attendance/
    );
  });

  it("6/7. final attendance approval approves no OT, and the corrected day's OT is AVAILABLE", async () => {
    const world = build({ rawPunches: [punch(1, 42, "2026-09-14 10:00:00")] });
    const raised = await world.regularization.raiseRequest({ actor: { employee_id: 42, user_type: 1 }, requested_for_employee_id: 42, attendance_date: "2026-09-14", reason: "Terminal offline at close", punch_time: "2026-09-15 00:30:00" });
    const id = raised.attendance_approval_request_id;
    await world.regularization.decide({ actor: { employee_id: 7, user_type: 1 }, request_id: id, decision: STEP_DECISION.APPROVED });
    await world.regularization.decide({ actor: { employee_id: 10, user_type: 1 }, request_id: id, decision: STEP_DECISION.APPROVED });
    const final = await world.regularization.decide({ actor: { employee_id: 8, user_type: 1 }, request_id: id, decision: STEP_DECISION.APPROVED });
    assert.equal(final.status, REQUEST_STATUS.APPROVED);
    assert.equal(final.approved_ot_minutes, 0);
    assert.equal(final.ot_now_available, 150);
    assert.equal(world.store.requests.length, 1, "no OT request was created");

    // The approved punch is now effective.
    world.calcRepo.getApprovedRegularizedPunches = async () => [{ punch_id: 77, employee_id: 42, attendance_date: "2026-09-14", io_time: "2026-09-15 00:30:00" }];
    const [day] = await world.calculation.calculateRange({ employee_id: 42, from_date: "2026-09-14", to_date: "2026-09-14" });
    assert.equal(day.status, CALC_STATUS.FINAL);
    assert.equal(day.ot_claim_state, "AVAILABLE");
    assert.equal(day.approved_ot_minutes, 0);

    // And it now appears in HR's approved history, but not their pending.
    const hist = await world.regularization.listApprovals({ actor: { employee_id: 8, user_type: 1 }, request_type: REQUEST_TYPE.REGULARIZATION, status: "APPROVED" });
    assert.equal(hist.rows.length, 1);
    assert.equal(hist.rows[0].decided_by_name, "HR");
    assert.equal(hist.rows[0].actionable, false);
  });

  it("refuses a request type or status it does not know", async () => {
    const world = build();
    await assert.rejects(world.regularization.listApprovals({ actor: { employee_id: 8, user_type: 1 }, request_type: "REGULARIZATION_WITH_OT" }), /REGULARIZATION or OT/);
    await assert.rejects(world.regularization.listApprovals({ actor: { employee_id: 8, user_type: 1 }, request_type: "OT", status: "CANCELLED" }), /PENDING, APPROVED, REJECTED or ALL/);
  });
});

/* ======================================================= OT approval */

describe("OT Approval - pending, approved, rejected, all", () => {
  const seed = async () => {
    const world = build({ rawPunches: [...lateDay(42, "2026-09-14"), ...lateDay(43, "2026-09-15"), ...lateDay(44, "2026-09-14"), punch(1, 42, "2026-09-16 10:00:00")] });
    const { regularization } = world;
    const a = await regularization.raiseOtRequest({ actor: { employee_id: 42, user_type: 1 }, attendance_date: "2026-09-14", reason: "Stock count ran late", today: TODAY });
    const b = await regularization.raiseOtRequest({ actor: { employee_id: 43, user_type: 1 }, attendance_date: "2026-09-15", reason: "Covered the evening", today: TODAY });
    const c = await regularization.raiseOtRequest({ actor: { employee_id: 44, user_type: 1 }, attendance_date: "2026-09-14", reason: "Delivery came late", today: TODAY });
    await regularization.raiseRequest({ actor: { employee_id: 42, user_type: 1 }, requested_for_employee_id: 42, attendance_date: "2026-09-16", reason: "Terminal offline at close", punch_time: "2026-09-16 22:00:00" });
    return { world, a: a.attendance_approval_request_id, b: b.attendance_approval_request_id, c: c.attendance_approval_request_id };
  };
  const mgr3 = { employee_id: 7, user_type: 1 };
  const ops = { employee_id: 10, user_type: 1 };
  const hr = { employee_id: 8, user_type: 1 };

  it("8. the pending tab has OT requests only, scoped to the actor's stage and outlet", async () => {
    const { world } = await seed();
    const pending = await world.regularization.listApprovals({ actor: mgr3, request_type: REQUEST_TYPE.OT, status: "PENDING" });
    assert.deepEqual(pending.rows.map((r) => r.employee_id).sort(), [42, 43]);
    pending.rows.forEach((r) => { assert.equal(r.request_type, "OT"); assert.equal(r.actionable, true); });
    assert.equal(pending.total, 2);
    assert.deepEqual(await world.regularization.countPending({ actor: mgr3, request_type: REQUEST_TYPE.OT }), { request_type: "OT", pending_with_me: 2 });
  });

  it("14/16. returns eligible, claimed and approved OT, and the employee's reason", async () => {
    const { world } = await seed();
    const [row] = (await world.regularization.listApprovals({ actor: mgr3, request_type: REQUEST_TYPE.OT, status: "PENDING" })).rows.filter((r) => r.employee_id === 42);
    assert.equal(row.claimed_ot_minutes, 90);
    assert.equal(row.eligible_ot_minutes, 90);
    assert.equal(row.approved_ot_minutes, 0, "0 until final approval");
    assert.equal(row.reason, "Stock count ran late");
    assert.equal(row.worked_minutes, 750);
    assert.equal(row.effective_punches.length, 2);
  });

  it("15/18. the chain is enforced and an approver cannot increase the minutes: approval is clamped to eligibility", async () => {
    const { world, a } = await seed();
    await assert.rejects(world.regularization.decide({ actor: hr, request_id: a, decision: STEP_DECISION.APPROVED }), /must be decided by store manager/);
    await world.regularization.decide({ actor: mgr3, request_id: a, decision: STEP_DECISION.APPROVED, approved_ot_minutes: 999 });
    await world.regularization.decide({ actor: ops, request_id: a, decision: STEP_DECISION.APPROVED });
    // Inflate the stored claim to prove the clamp: the engine still says 90.
    world.store.requests.find((r) => r.attendance_approval_request_id === a).candidate_ot_minutes = 500;
    const final = await world.regularization.decide({ actor: hr, request_id: a, decision: STEP_DECISION.APPROVED, approved_ot_minutes: 999 });
    assert.equal(final.approved_ot_minutes, 90);
  });

  it("9/10/11/12/13/17. history tabs are scoped like the queue, count is type-specific, closure wording is returned", async () => {
    const { world, a, b, c } = await seed();
    // a: approved all the way. b: rejected by the manager. c: outlet 5, pending; then closed by payroll lock.
    await world.regularization.decide({ actor: mgr3, request_id: a, decision: STEP_DECISION.APPROVED });
    await world.regularization.decide({ actor: ops, request_id: a, decision: STEP_DECISION.APPROVED });
    await world.regularization.decide({ actor: hr, request_id: a, decision: STEP_DECISION.APPROVED });
    await world.regularization.decide({ actor: mgr3, request_id: b, decision: STEP_DECISION.REJECTED, remarks: "Not authorised" });
    const cRow = world.store.requests.find((r) => r.attendance_approval_request_id === c);
    cRow.status = "REJECTED"; cRow.closure_reason = "NOT_APPROVED_BEFORE_PAYROLL_LOCK"; cRow.approved_ot_minutes = 0; cRow.decided_at = "2026-10-01 00:00:00";

    const approved = await world.regularization.listApprovals({ actor: mgr3, request_type: REQUEST_TYPE.OT, status: "APPROVED" });
    assert.deepEqual(approved.rows.map((r) => [r.attendance_approval_request_id, r.approved_ot_minutes, r.decided_by_name]), [[a, 90, "HR"]]);
    const rejected = await world.regularization.listApprovals({ actor: mgr3, request_type: REQUEST_TYPE.OT, status: "REJECTED" });
    assert.deepEqual(rejected.rows.map((r) => r.attendance_approval_request_id), [b], "outlet 5's closure is not the outlet-3 manager's to see");
    assert.equal(rejected.rows[0].decided_by_name, "Mgr3");
    assert.equal(rejected.rows[0].chain[0].remarks, "Not authorised");
    const all = await world.regularization.listApprovals({ actor: mgr3, request_type: REQUEST_TYPE.OT, status: "ALL" });
    assert.deepEqual(all.rows.map((r) => r.attendance_approval_request_id).sort(), [a, b].sort());
    assert.equal(all.total, 2);
    all.rows.forEach((r) => assert.equal(r.request_type, "OT"));

    // HR sees the outlet-5 closure (HR is on every chain), with the exact wording.
    const hrRejected = await world.regularization.listApprovals({ actor: hr, request_type: REQUEST_TYPE.OT, status: "REJECTED" });
    const closed = hrRejected.rows.find((r) => r.attendance_approval_request_id === c);
    assert.equal(closed.closure_reason, "NOT_APPROVED_BEFORE_PAYROLL_LOCK");
    assert.equal(closed.closure_label, "Rejected – Not Approved Before Payroll Lock");
    assert.equal(closed.actionable, false);

    // The outlet-5 manager sees only their own outlet, in every tab.
    const mgr5All = await world.regularization.listApprovals({ actor: { employee_id: 9, user_type: 1 }, request_type: REQUEST_TYPE.OT, status: "ALL" });
    assert.deepEqual(mgr5All.rows.map((r) => r.attendance_approval_request_id), [c]);
    // A pending count never counts history.
    assert.deepEqual(await world.regularization.countPending({ actor: mgr3, request_type: REQUEST_TYPE.OT }), { request_type: "OT", pending_with_me: 0 });
    assert.deepEqual(await world.regularization.countPending({ actor: mgr3, request_type: REQUEST_TYPE.REGULARIZATION }), { request_type: "REGULARIZATION", pending_with_me: 1 });
  });

  it("somebody with no approver role sees nothing in any tab", async () => {
    const { world } = await seed();
    for (const status of ["PENDING", "APPROVED", "REJECTED", "ALL"]) {
      const r = await world.regularization.listApprovals({ actor: { employee_id: 42, user_type: 1 }, request_type: REQUEST_TYPE.OT, status });
      assert.equal(r.rows.length, 0, status);
      assert.equal(r.total, 0, status);
    }
  });
});

/* ================================================== bulk recalculation */

describe("bulk recalculation", () => {
  const RANGE = { from_date: "2026-09-14", to_date: "2026-09-16" };
  const world = (extra = {}) => build({ rawPunches: [...lateDay(42, "2026-09-14"), ...lateDay(43, "2026-09-14"), ...lateDay(44, "2026-09-14")], ...extra });
  const admin = 1;

  it("19. date range + employee", async () => {
    const w = world();
    const r = await w.calculation.recalculateBulk({ ...RANGE, employee_id: 42, actor_employee_id: admin });
    assert.equal(r.employees_targeted, 1);
    assert.equal(r.employees_completed, 1);
    assert.equal(r.attendance_days_processed, 3);
    assert.equal(r.status, "COMPLETED");
    assert.deepEqual(w.saved.calculations.flat().map((x) => x.employee_id), [42, 42, 42]);
  });

  it("20. date range + store", async () => {
    const w = world();
    const r = await w.calculation.recalculateBulk({ ...RANGE, store_id: 3, actor_employee_id: admin });
    assert.deepEqual([...new Set(w.saved.calculations.flat().map((x) => x.employee_id))], [42, 43], "outlet 3 only; the leaver and the future joiner excluded");
    assert.equal(r.employees_targeted, 2);
  });

  it("21. date range + designation, 22. combined filters", async () => {
    const w = world();
    const r = await w.calculation.recalculateBulk({ ...RANGE, designation_id: 11, actor_employee_id: admin });
    assert.deepEqual([...new Set(w.saved.calculations.flat().map((x) => x.employee_id))], [42, 44]);
    assert.equal(r.employees_targeted, 2);
    const w2 = world();
    const r2 = await w2.calculation.recalculateBulk({ ...RANGE, store_id: 3, designation_id: 11, actor_employee_id: admin });
    assert.deepEqual(w2.saved.calculations.flat().map((x) => x.employee_id), [42, 42, 42]);
    assert.equal(r2.filters.store_id, 3);
    assert.equal(r2.filters.designation_id, 11);
  });

  it("23. date range only targets the permitted population: employed inside the range", async () => {
    const w = world();
    const r = await w.calculation.recalculateBulk({ ...RANGE, actor_employee_id: admin });
    assert.equal(r.employees_targeted, 3);
    assert.ok(!w.saved.calculations.flat().some((x) => x.employee_id === 45), "left before the range");
    assert.ok(!w.saved.calculations.flat().some((x) => x.employee_id === 46), "joins after the range");
  });

  it("validates the filters and the range", async () => {
    const w = world();
    await assert.rejects(w.calculation.recalculateBulk({ from_date: "2026-09-14", to_date: "2026-09-13" }), /must not be after/);
    await assert.rejects(w.calculation.recalculateBulk({ ...RANGE, store_id: 99 }), /No outlet/);
    await assert.rejects(w.calculation.recalculateBulk({ ...RANGE, designation_id: 99 }), /No designation/);
    await assert.rejects(w.calculation.recalculateBulk({ ...RANGE, employee_id: 999 }), /No employee/);
    await assert.rejects(w.calculation.recalculateBulk({ ...RANGE, store_id: "x" }), /positive id/);
    assert.equal(w.saved.runs.length, 0);
  });

  it("24. honours the single-date shift override, 25. the dated assignment, 26. the approved regularized punch", async () => {
    const w = build({
      rawPunches: [...lateDay(42, "2026-09-14"), ...lateDay(42, "2026-09-15"), punch(500, 42, "2026-09-16 10:00:00")],
      overrides: [{ attendance_date_shift_override_id: 1, employee_id: 42, attendance_date: "2026-09-15", work_shift_id: 8 }],
      assignments: { 42: [
        { employee_work_shift_assignment_id: 1, employee_id: 42, work_shift_id: 8, effective_from: "2026-09-01", source: "MIGRATION_BACKFILL" },
        { employee_work_shift_assignment_id: 2, employee_id: 42, work_shift_id: 7, effective_from: "2026-09-14", source: "ASSIGNMENT" },
      ] },
      regularized: [{ punch_id: 77, employee_id: 42, attendance_date: "2026-09-16", io_time: "2026-09-16 22:00:00" }],
    });
    await w.calculation.recalculateBulk({ ...RANGE, employee_id: 42, actor_employee_id: admin });
    const rows = w.saved.calculations.flat();
    const byDate = Object.fromEntries(rows.map((r) => [r.attendance_date, r]));
    assert.equal(byDate["2026-09-14"].work_shift_id, 7, "the assignment dated the 14th");
    assert.equal(byDate["2026-09-15"].work_shift_id, 8, "the one-date override");
    assert.equal(byDate["2026-09-16"].work_shift_id, 7, "back to the assignment the day after");
    assert.equal(byDate["2026-09-16"].punch_count, 2, "the approved regularized punch counts");
    assert.equal(byDate["2026-09-16"].status, CALC_STATUS.FINAL);
  });

  it("27/28. never creates an OT request; candidate OT is merely AVAILABLE", async () => {
    const w = world();
    await w.calculation.recalculateBulk({ ...RANGE, actor_employee_id: admin });
    assert.equal(w.store.requests.length, 0);
    const [day] = await w.calculation.calculateRange({ employee_id: 42, from_date: "2026-09-14", to_date: "2026-09-14" });
    assert.equal(day.candidate_ot_minutes, 90);
    assert.equal(day.ot_claim_state, "AVAILABLE");
    assert.equal(day.approved_ot_minutes, 0);
  });

  it("29. Biomax punches remain unchanged", async () => {
    const state = { rawPunches: [...lateDay(42, "2026-09-14")] };
    const before = JSON.stringify(state.rawPunches);
    const w = build(state);
    await w.calculation.recalculateBulk({ ...RANGE, actor_employee_id: admin });
    assert.equal(JSON.stringify(state.rawPunches), before);
  });

  it("30/31. a partial failure is reported honestly and recorded in the run history", async () => {
    const w = world({ punchesThrowFor: [43] });
    const r = await w.calculation.recalculateBulk({ ...RANGE, store_id: 3, actor_employee_id: 8 });
    assert.equal(r.employees_targeted, 2);
    assert.equal(r.employees_completed, 1);
    assert.equal(r.employees_failed, 1);
    assert.equal(r.status, "COMPLETED_WITH_ERRORS");
    assert.deepEqual(r.errors.map((e) => [e.employee_id, e.message]), [[43, "ER_LOCK_WAIT_TIMEOUT"]]);
    assert.equal(r.attendance_days_processed, 3);

    const [run] = w.saved.runs;
    assert.equal(run.status, "COMPLETED_WITH_ERRORS");
    assert.equal(run.requested_by_employee_id, 8);
    assert.equal(run.store_id, 3);
    assert.equal(run.employee_id, null);
    assert.equal(run.employees_targeted, 2);
    assert.equal(run.employees_completed, 1);
    assert.equal(run.employees_failed, 1);
    assert.equal(run.days_processed, 3);
    assert.equal(run.from_date, "2026-09-14");
    const listed = await w.calculation.listRecalculationRuns();
    assert.equal(listed[0].errors[0].employee_id, 43);

    const allFail = world({ punchesThrowFor: [42] });
    const f = await allFail.calculation.recalculateBulk({ ...RANGE, employee_id: 42, actor_employee_id: 8 });
    assert.equal(f.status, "FAILED");
  });

  it("32. re-running writes the same rows again through the idempotent upsert - no duplicates by key", async () => {
    const w = world();
    await w.calculation.recalculateBulk({ ...RANGE, employee_id: 42, actor_employee_id: admin });
    await w.calculation.recalculateBulk({ ...RANGE, employee_id: 42, actor_employee_id: admin });
    const keys = w.saved.calculations.flat().map((r) => `${r.employee_id}|${r.attendance_date}`);
    assert.equal(keys.length, 6);
    assert.equal(new Set(keys).size, 3, "the second run addresses the same three (employee, date) keys");
    assert.equal(w.saved.runs.length, 2, "and each run is its own audit row");
  });
});
