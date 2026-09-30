/**
 * REQUESTED PERMISSION through the EXISTING approval system - the real
 * calculation and approval usecases over an in-memory store.
 *
 *   raise (self / for others) -> the employee's ordinary chain -> approve at
 *   each stage -> final approval settles the day with the permission applied
 *   -> revoke withdraws it; reject and payroll lock behave as for every
 *   other attendance request.
 *
 * The repository fakes mirror the SQL they stand for: a permission row is
 * effective only through its request's APPROVED + SETTLED state.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildCalculation = require("./attendance_calculation");
const buildRegularization = require("./attendance_regularization");
const { CALC_STATUS } = require("../utils/attendance_engine");
const { REQUEST_TYPE, STEP_DECISION, APPROVER_ROLE } = require("../utils/attendance_approval_chain");

const weekly = (id) =>
  Array.from({ length: 7 }, (_, day) => ({
    work_shift_weekly_schedule_id: id * 100 + day,
    work_shift_id: id,
    day_of_week: day,
    is_working_day: 1,
    in_time: "10:00:00",
    out_time: "22:00:00",
    attendance_day_cutoff: "04:00:00",
    break_minutes: 60,
    normal_work_minutes: 660,
    ot_rate: 1,
  }));
const SHIFT = {
  config: {
    work_shift_id: 7, shift_code: "LATE", shift_name: "Late Shift", active: 1, overtime_allowed: 1,
    overtime_minimum_minutes: 0, overtime_rounding_method: "NONE", overtime_rounding_interval_minutes: 0,
    overtime_minimum_threshold_only: 0, maximum_ot_minutes_per_day: null,
  },
  schedule: weekly(7),
};

const EMPLOYEES = {
  42: { employee_id: 42, employee_name: "Asha", outlet_id: 3, designation_id: 11, designation_name: "STAFF", approver_role: null, requester_class: null },
  7: { employee_id: 7, employee_name: "Mgr3", outlet_id: 3, designation_id: 2, designation_name: "SM", approver_role: APPROVER_ROLE.STORE_MANAGER, requester_class: "MANAGER" },
  10: { employee_id: 10, employee_name: "Ops", outlet_id: 1, designation_id: 4, designation_name: "OPS", approver_role: APPROVER_ROLE.OPERATIONS_MANAGER, requester_class: "MANAGER" },
  8: { employee_id: 8, employee_name: "HR", outlet_id: 1, designation_id: 3, designation_name: "HR", approver_role: APPROVER_ROLE.HR, requester_class: "MANAGER" },
};
const DATE = "2026-09-14";
const TODAY = "2026-09-20";
const ALL = { kind: "ALL_BRANCHES", store_ids: null };
const as = (id, extra = {}) => ({ employee_id: id, user_type: 1, branch_scope: ALL, ...extra });

const punch = (id, ioTime) => ({
  punch_id: id, employee_id: 42, io_time: ioTime, punch_date: ioTime.slice(0, 10),
  ingest_attendance_date: ioTime.slice(0, 10), dev_id: "D", ingest_source: "LIVE",
});

function build({ rawPunches = [], locked = [], summaries = [], refreshFails = false } = {}) {
  const store = { requests: [], steps: [], permissions: [], decided: [], revoked: [], months: [] };
  let nextRequest = 900;
  let nextPermission = 1;
  const requestOf = (id) => store.requests.find((r) => r.attendance_approval_request_id === Number(id));
  const joined = (p) => {
    const r = p.attendance_approval_request_id ? requestOf(p.attendance_approval_request_id) : null;
    return {
      ...p,
      request_status: r ? r.status : null,
      finalization_state: r ? r.finalization_state : null,
      closure_reason: r ? r.closure_reason : null,
    };
  };

  const calcRepo = {
    getShiftAssignmentHistory: async (e) => [{ employee_work_shift_assignment_id: 1, employee_id: e, work_shift_id: 7, effective_from: "2026-09-01", source: "MIGRATION_BACKFILL" }],
    getWorkShiftWithSchedule: async () => SHIFT,
    getWorkShiftConfigVersions: async () => [],
    getRawPunchesByCalendarWindow: async (e, from, to) => rawPunches.filter((p) => p.employee_id === e && p.punch_date >= from && p.punch_date <= to),
    getApprovedRegularizedPunches: async () => [],
    getBreakOverride: async () => null,
    getApprovalStateByDate: async (e, from, to) =>
      store.requests.filter((r) => r.requested_for_employee_id === e && r.status !== "CANCELLED" && r.attendance_date >= from && r.attendance_date <= to),
    getPermissionsForRange: async (e, from, to) =>
      store.permissions.filter((p) => p.employee_id === e && p.attendance_date >= from && p.attendance_date <= to).map(joined),
    getEmploymentWindow: async () => ({ employee_id: 42, status: 1, date_of_joining: "2020-01-01", resignation_date: null }),
    getMonthlyGrossAsOf: async () => null,
    // A monthly summary exists only for the months listed in `summaries`.
    getMonthlyPayroll: async ({ period_year, period_month }) =>
      summaries.includes(`${period_year}-${String(period_month).padStart(2, "0")}`) ? { attendance_monthly_payroll_id: 1 } : null,
    saveMonthWithPayroll: async (args) => {
      if (refreshFails) throw Object.assign(new Error("ER_LOCK_WAIT_TIMEOUT"), { code: "ER_LOCK_WAIT_TIMEOUT" });
      store.months.push(args);
      return { written: args.rows.length, monthly_written: 1 };
    },
    findPayrollLockedPeriods: async (rows) =>
      rows.some((r) => locked.includes(String(r.attendance_date).slice(0, 7))) ? [{ employee_id: 42, period: "2026-09" }] : [],
  };

  const regRepo = {
    getApprovalIdentity: async (id) => EMPLOYEES[id] || null,
    findOpenRequest: async () => null,
    findRequestsForDates: async (e, dates) =>
      store.requests.filter((r) => r.requested_for_employee_id === e && dates.includes(r.attendance_date) && r.status !== "CANCELLED"),
    createRequest: async ({ request, chain, permissions }) => {
      // The database's own refusal of a second OPEN request in the group.
      if (store.requests.some((r) => r.request_type === request.request_type && r.requested_for_employee_id === request.requested_for_employee_id && r.attendance_date === request.attendance_date && r.status === "PENDING")) {
        throw new Error("ER_DUP_ENTRY");
      }
      const id = nextRequest++;
      store.requests.push({ attendance_approval_request_id: id, ...request, status: "PENDING", current_stage_no: 1, total_stages: chain.length, finalization_state: "NOT_REQUIRED", approved_ot_minutes: null, closure_reason: null });
      chain.forEach((s) => store.steps.push({ attendance_approval_request_id: id, stage_no: s.stage_no, approver_role: s.approver_role, outlet_id: s.outlet_id, decision: "PENDING" }));
      const ids = (permissions || []).map((w) => {
        const pid = nextPermission++;
        store.permissions.push({ attendance_permission_id: pid, employee_id: request.requested_for_employee_id, attendance_date: request.attendance_date, source: "REQUEST", attendance_approval_request_id: id, ...w });
        return pid;
      });
      return { attendance_approval_request_id: id, total_stages: chain.length, attendance_permission_ids: ids };
    },
    getRequest: async (id) => {
      const r = requestOf(id);
      return r ? { ...r, steps: store.steps.filter((s) => s.attendance_approval_request_id === r.attendance_approval_request_id) } : null;
    },
    decideStage: async (args) => {
      store.decided.push(args);
      const r = requestOf(args.requestId);
      const st = store.steps.find((s) => s.attendance_approval_request_id === args.requestId && s.stage_no === args.stageNo);
      st.decision = args.decision;
      r.status = args.next.status;
      r.current_stage_no = args.next.current_stage_no;
      r.finalization_state = args.next.status === "PENDING" ? "NOT_REQUIRED" : "SETTLED";
      return { code: 200, status: r.status, current_stage_no: r.current_stage_no, finalization_state: r.finalization_state };
    },
    getRevocationSnapshot: async (id) => {
      const r = requestOf(id);
      return r ? { request: { ...r }, steps: store.steps.filter((s) => s.attendance_approval_request_id === r.attendance_approval_request_id), fingerprint: "fp" } : null;
    },
    revokeRequest: async (args) => {
      store.revoked.push(args);
      requestOf(args.requestId).status = "CANCELLED";
      return { code: 200, new_request_status: "CANCELLED", calculations_written: args.calculations.length };
    },
    listPermissionsForRequests: async (ids) =>
      store.permissions.filter((p) => ids.includes(p.attendance_approval_request_id)).map(joined),
  };

  const calculation = buildCalculation(calcRepo);
  const regularization = buildRegularization(regRepo, calculation);
  return { store, calculation, regularization };
}

const LEFT_AT_20 = [punch(1, `${DATE} 10:00:00`), punch(2, `${DATE} 20:00:00`)];
const raise = (world, extra = {}) =>
  world.regularization.raisePermissionRequest({
    actor: as(42),
    attendance_date: DATE,
    windows: [{ from_time: "20:00", to_shift_end: true }],
    reason: "Family function in the evening",
    today: TODAY,
    ...extra,
  });
const dayOf = async (world, date = DATE) =>
  (await world.calculation.calculateRange({ employee_id: 42, from_date: date, to_date: date }))[0];
const approveAll = async (world, id) => {
  for (const approver of [7, 10, 8]) {
    // eslint-disable-next-line no-await-in-loop
    await world.regularization.decide({ actor: as(approver), request_id: id, decision: STEP_DECISION.APPROVED });
  }
};

describe("raising a Permission request", () => {
  it("creates a PERMISSION request on the employee's ordinary chain with the window as payload", async () => {
    const world = build({ rawPunches: LEFT_AT_20 });
    const created = await raise(world);
    assert.equal(created.request_type, REQUEST_TYPE.PERMISSION);
    assert.deepEqual(created.chain.map((s) => s.approver_role), ["STORE_MANAGER", "OPERATIONS_MANAGER", "HR"]);
    assert.equal(created.windows[0].permission_from, `${DATE} 20:00:00`);
    assert.equal(created.windows[0].permission_to, `${DATE} 22:00:00`);
    assert.equal(created.windows[0].permission_minutes, 120);
    assert.equal(world.store.permissions.length, 1);
    assert.equal(world.store.permissions[0].source, "REQUEST");
  });

  it("a PENDING request pays nothing and does not hold the day", async () => {
    const world = build({ rawPunches: LEFT_AT_20 });
    await raise(world);
    const day = await dayOf(world);
    assert.equal(day.status, CALC_STATUS.FINAL);
    assert.equal(day.shortage_minutes, 120);
    assert.equal(day.permissions[0].state, "PENDING");
  });

  it("refuses a window outside the shift, a whole-shift window, a second pending request and a locked month", async () => {
    const world = build({ rawPunches: LEFT_AT_20 });
    await assert.rejects(raise(world, { windows: [{ from_time: "21:00", to_time: "23:00" }] }), /inside the scheduled shift/);
    await assert.rejects(raise(world, { windows: [{ from_time: "10:00", to_shift_end: true }] }), /leave, not permission/);
    await raise(world);
    await assert.rejects(raise(world, { windows: [{ from_time: "10:00", to_time: "11:00" }] }), /already pending/);
    const locked = build({ rawPunches: LEFT_AT_20, locked: ["2026-09"] });
    await assert.rejects(raise(locked), /payroll|locked/i);
  });

  it("refuses a date beyond the request window", async () => {
    const world = build();
    await assert.rejects(raise(world, { attendance_date: "2026-06-01" }), /days back/);
  });
});

describe("deciding it through the existing chain", () => {
  it("each stage is decided by its own approver; the FINAL approval settles the day with the permission applied", async () => {
    const world = build({ rawPunches: LEFT_AT_20 });
    const { attendance_approval_request_id: id } = await raise(world);
    await approveAll(world, id);
    const final = world.store.decided[world.store.decided.length - 1];
    assert.equal(final.next.status, "APPROVED");
    assert.equal(final.calculations.length, 1, "the closed day is written with the decision");
    assert.equal(final.calculations[0].permission_minutes, 120);
    assert.equal(final.calculations[0].shortage_minutes, 0);
    assert.equal(final.calculations[0].worked_minutes, 540, "worked is what was worked");

    const day = await dayOf(world);
    assert.equal(day.permission_minutes, 120);
    assert.equal(day.shortage_minutes, 0);
    assert.equal(day.permissions[0].state, "APPROVED");
  });

  it("nobody decides a request they raised: a manager raising for an employee cannot approve it", async () => {
    const world = build({ rawPunches: LEFT_AT_20 });
    const { attendance_approval_request_id: id } = await raise(world, { actor: as(7), requested_for_employee_id: 42 });
    await assert.rejects(
      world.regularization.decide({ actor: as(7), request_id: id, decision: STEP_DECISION.APPROVED }),
      (err) => err.name === "ForbiddenError"
    );
  });

  it("an OPEN (future) day can be finally approved in advance; nothing is stored until it closes", async () => {
    const future = "2026-10-05";
    const world = build();
    const { attendance_approval_request_id: id } = await raise(world, { attendance_date: future, today: "2026-10-01" });
    await approveAll(world, id);
    const final = world.store.decided[world.store.decided.length - 1];
    assert.equal(final.next.status, "APPROVED");
    assert.equal(final.calculations.length, 0, "an open day is not stored");
  });

  it("a rejection pays nothing, and is allowed in a locked month", async () => {
    const world = build({ rawPunches: LEFT_AT_20 });
    const { attendance_approval_request_id: id } = await raise(world);
    await world.regularization.decide({ actor: as(7), request_id: id, decision: STEP_DECISION.REJECTED, remarks: "Not this week" });
    const day = await dayOf(world);
    assert.equal(day.permission_minutes, 0);
    assert.equal(day.permissions[0].state, "REJECTED");
  });

  it("approval in a payroll-locked month is refused", async () => {
    const world = build({ rawPunches: LEFT_AT_20 });
    const { attendance_approval_request_id: id } = await raise(world);
    // The month locks while the request waits.
    const locked = build({ rawPunches: LEFT_AT_20, locked: ["2026-09"] });
    Object.assign(locked.store, world.store);
    await assert.rejects(
      locked.regularization.decide({ actor: as(7), request_id: id, decision: STEP_DECISION.APPROVED }),
      /locked/i
    );
  });
});

describe("revoking an approved Permission request", () => {
  it("is admin-only, and recalculates the day WITHOUT the permission in the revocation's own write", async () => {
    const world = build({ rawPunches: LEFT_AT_20 });
    const { attendance_approval_request_id: id } = await raise(world);
    await approveAll(world, id);
    await assert.rejects(
      world.regularization.revokeDecision({ actor: as(8), request_id: id, reason: "Approved by mistake" }),
      (err) => err.name === "ForbiddenError"
    );
    await world.regularization.revokeDecision({ actor: as(1, { user_type: 2 }), request_id: id, reason: "Approved by mistake" });
    const revoke = world.store.revoked[0];
    assert.equal(revoke.calculations.length, 1);
    assert.equal(revoke.calculations[0].permission_minutes, 0);
    assert.equal(revoke.calculations[0].shortage_minutes, 120);
  });
});

describe("the Approval Centre's Permission tab", () => {
  it("shows the window and what approving it would forgive", async () => {
    const listing = build({ rawPunches: LEFT_AT_20 });
    await raise(listing);
    // A listing fake: the one row, with the scope already applied.
    const regRepo = {
      getApprovalIdentity: async (id) => EMPLOYEES[id],
      listApprovals: async () => listing.store.requests.map((r) => ({ ...r, requested_by_employee_id: 42, created_at: "2026-09-15 09:00:00" })),
      countApprovals: async () => 1,
      listStepsForRequests: async () => listing.store.steps,
      listPermissionsForRequests: async () => listing.store.permissions.map((p) => ({ ...p, request_status: "PENDING" })),
    };
    const reg = buildRegularization(regRepo, listing.calculation);
    const result = await reg.listApprovals({ actor: as(7), request_type: REQUEST_TYPE.PERMISSION, status: "PENDING" });
    assert.equal(result.rows.length, 1);
    const row = result.rows[0];
    assert.equal(row.permissions[0].from_time, "20:00");
    assert.equal(row.permissions[0].to_shift_end, true);
    assert.deepEqual(
      { before: row.permission_preview.shortage_before_permission_minutes, covered: row.permission_preview.permission_minutes, after: row.permission_preview.shortage_after_permission_minutes },
      { before: 120, covered: 120, after: 0 }
    );
  });
});

describe("THE MONTHLY SUMMARY FOLLOWS A PERMISSION CHANGE", () => {
  it("a final approval re-persists an existing summary through the month persist, with the permission in it", async () => {
    const world = build({ rawPunches: LEFT_AT_20, summaries: ["2026-09"] });
    const { attendance_approval_request_id: id } = await raise(world);
    await world.regularization.decide({ actor: as(7), request_id: id, decision: STEP_DECISION.APPROVED });
    assert.equal(world.store.months.length, 0, "an intermediate stage changes nothing payable");
    await world.regularization.decide({ actor: as(10), request_id: id, decision: STEP_DECISION.APPROVED });
    const final = await world.regularization.decide({ actor: as(8), request_id: id, decision: STEP_DECISION.APPROVED });
    assert.deepEqual({ refreshed: final.month_refresh.refreshed, year: final.month_refresh.year, month: final.month_refresh.month }, { refreshed: true, year: 2026, month: 9 });
    assert.equal(world.store.months.length, 1);
    assert.equal(world.store.months[0].monthly.shortage_minutes, 0, "the summary carries the forgiven shortage");
  });

  it("no summary yet: nothing to refresh, and nothing is created", async () => {
    const world = build({ rawPunches: LEFT_AT_20 });
    const { attendance_approval_request_id: id } = await raise(world);
    let last;
    for (const a of [7, 10, 8]) last = await world.regularization.decide({ actor: as(a), request_id: id, decision: STEP_DECISION.APPROVED });
    assert.equal(last.month_refresh.reason, "NO_SUMMARY");
    assert.equal(world.store.months.length, 0);
  });

  it("a refresh that fails is reported, and the approval stands (Approve & Lock refuses the stale month)", async () => {
    const world = build({ rawPunches: LEFT_AT_20, summaries: ["2026-09"], refreshFails: true });
    const { attendance_approval_request_id: id } = await raise(world);
    let last;
    for (const a of [7, 10, 8]) last = await world.regularization.decide({ actor: as(a), request_id: id, decision: STEP_DECISION.APPROVED });
    assert.equal(last.code, 200);
    assert.equal(last.month_refresh.refreshed, false);
    assert.equal(last.month_refresh.reason, "ER_LOCK_WAIT_TIMEOUT");
  });

  it("revoking an approved Permission re-persists the month without it", async () => {
    const world = build({ rawPunches: LEFT_AT_20, summaries: ["2026-09"] });
    const { attendance_approval_request_id: id } = await raise(world);
    await approveAll(world, id);
    world.store.months.length = 0;
    const out = await world.regularization.revokeDecision({ actor: as(1, { user_type: 2 }), request_id: id, reason: "Approved by mistake" });
    assert.equal(out.month_refresh.refreshed, true);
    assert.equal(world.store.months[0].monthly.shortage_minutes, 120);
  });

  it("a rejection changes nothing payable and refreshes nothing", async () => {
    const world = build({ rawPunches: LEFT_AT_20, summaries: ["2026-09"] });
    const { attendance_approval_request_id: id } = await raise(world);
    const out = await world.regularization.decide({ actor: as(7), request_id: id, decision: STEP_DECISION.REJECTED, remarks: "Not this week" });
    assert.equal(out.month_refresh, null);
    assert.equal(world.store.months.length, 0);
  });
});
