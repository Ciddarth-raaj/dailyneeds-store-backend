/**
 * SHIFT ASSIGNMENT HISTORY, THE ONE-DAY SHIFT REQUEST, AND WHAT EACH IS
 * ALLOWED TO MOVE.
 *
 *   node --test usecase/shift_assignment_and_one_day_requests.test.js
 *
 * The REAL usecases - `employee_work_shift`, `attendance_calculation`,
 * `attendance_regularization` and the Telegram handler - over fakes that
 * return what the real queries return. Nothing here is a stub of the rule
 * being tested: the chain, the engine, the resolver and the payroll lock are
 * all the production code.
 *
 * The shifts, chosen so the arithmetic states the business rule:
 *
 *   EVE   18:00-22:00, no break   NRM  240  the permanent shift
 *   LONG  10:00-22:00, 60m break  NRM  660  longer - may be requested
 *   SAME  09:00-13:00, no break   NRM  240  equal  - may NOT be requested
 *   MINI  09:00-12:00, no break   NRM  180  shorter- may NOT be requested
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildCalculation = require("./attendance_calculation");
const buildRegularization = require("./attendance_regularization");
const buildWorkShift = require("./employee_work_shift");
const buildShiftTelegram = require("./attendance_shift_change_telegram");
const { REQUEST_TYPE, REQUEST_STATUS, STEP_DECISION, APPROVER_ROLE } =
  require("../utils/attendance_approval_chain");

/* ============================================================== fixtures */

const EMPLOYEE = 42;
const TODAY = "2026-09-19";
const ALL_BRANCHES = { kind: "ALL_BRANCHES", store_ids: null };

const weekly = (workShiftId, inTime, outTime, breakMinutes) =>
  Array.from({ length: 7 }, (_, day) => ({
    work_shift_weekly_schedule_id: workShiftId * 100 + day,
    work_shift_id: workShiftId,
    day_of_week: day,
    is_working_day: 1,
    in_time: inTime,
    out_time: outTime,
    attendance_day_cutoff: "04:00:00",
    break_minutes: breakMinutes,
    ot_rate: 1,
  }));

const config = (id, code, name, active = 1) => ({
  work_shift_id: id, shift_code: code, shift_name: name, active,
  overtime_allowed: 1, overtime_minimum_minutes: 0, overtime_rounding_method: "NONE",
  overtime_rounding_interval_minutes: 0, overtime_minimum_threshold_only: 0,
  maximum_ot_minutes_per_day: null, pre_shift_overtime_allowed: 0,
  pre_shift_overtime_minimum_minutes: 0, pre_shift_overtime_rounding_method: "NONE",
  pre_shift_overtime_rounding_interval_minutes: 0, late_offset_against_overtime: 0,
  early_exit_offset_against_overtime: 0, late_grace_minutes: 0, early_exit_grace_minutes: 0,
});

const EVE = 6;
const LONG = 7;
const SAME = 8;
const MINI = 9;

const SHIFTS = {
  [EVE]: { config: config(EVE, "EVE", "Evening Shift"), schedule: weekly(EVE, "18:00:00", "22:00:00", 0) },
  [LONG]: { config: config(LONG, "LONG", "Long Shift"), schedule: weekly(LONG, "10:00:00", "22:00:00", 60) },
  [SAME]: { config: config(SAME, "SAME", "Same Length Shift"), schedule: weekly(SAME, "09:00:00", "13:00:00", 0) },
  [MINI]: { config: config(MINI, "MINI", "Short Shift"), schedule: weekly(MINI, "09:00:00", "12:00:00", 0) },
};

const punch = (id, employee_id, ioTime) => ({
  punch_id: id, employee_id, io_time: ioTime, punch_date: ioTime.slice(0, 10),
  ingest_attendance_date: ioTime.slice(0, 10), dev_id: "DEV1", ingest_source: "DEVICE",
});

const EMPLOYEES = [
  { employee_id: 42, employee_name: "Asha", store_id: 3, designation_id: 11, status: 1, date_of_joining: "2020-01-01", resignation_date: null },
  { employee_id: 43, employee_name: "Bala", store_id: 5, designation_id: 12, status: 1, date_of_joining: "2020-01-01", resignation_date: null },
];

/** 7 approves for outlet 3 as First, 8 as Final. 9 is outlet 5's manager. */
const IDENTITIES = {
  7: { employee_id: 7, employee_name: "Mgr3", outlet_id: 3, designation_id: 2, designation_name: "STORE MANAGER", approver_role: APPROVER_ROLE.STORE_MANAGER, requester_class: "MANAGER" },
  8: { employee_id: 8, employee_name: "HR", outlet_id: 1, designation_id: 3, designation_name: "HR", approver_role: APPROVER_ROLE.HR, requester_class: "MANAGER" },
  9: { employee_id: 9, employee_name: "Mgr5", outlet_id: 5, designation_id: 2, designation_name: "STORE MANAGER", approver_role: APPROVER_ROLE.STORE_MANAGER, requester_class: "MANAGER" },
};

/**
 * The world. `lockedMonths` holds `"YYYY-M"` strings, which is exactly what
 * the real `findPayrollLockedPeriods` answers from `payrun_employee_calculation`.
 */
function build(state = {}) {
  const saved = { calculations: [], overrides: [], defaultShiftWrites: [] };
  const store = { requests: [], steps: [], telegram: [] };
  const overrides = [...(state.overrides || [])];
  const assignments = state.assignments || {
    [EMPLOYEE]: [
      { employee_work_shift_assignment_id: 1, employee_id: EMPLOYEE, work_shift_id: EVE, effective_from: "2026-09-01", source: "MIGRATION_BACKFILL", note: null, created_by: null, created_at: "2026-09-01 10:00:00" },
    ],
    43: [
      { employee_work_shift_assignment_id: 2, employee_id: 43, work_shift_id: EVE, effective_from: "2026-09-01", source: "MIGRATION_BACKFILL", note: null, created_by: null, created_at: "2026-09-01 10:00:00" },
    ],
  };
  const lockedMonths = new Set(state.lockedMonths || []);
  let nextId = 900;
  let nextAssignmentId = 50;
  let nextOverrideId = 1000;

  const calcRepo = {
    getShiftAssignmentHistory: async (id) => assignments[id] || [],
    getDateShiftOverrides: async (id, from, to) =>
      overrides.filter((o) => o.employee_id === id && o.attendance_date >= from && o.attendance_date <= to),
    getWorkShiftWithSchedule: async (id) => SHIFTS[id] || null,
    getWorkShiftConfigVersions: async () => [],
    listActiveWorkShiftOptions: async () =>
      Object.values(SHIFTS).map((s) => ({ work_shift_id: s.config.work_shift_id, shift_code: s.config.shift_code, shift_name: s.config.shift_name })),
    getRawPunchesByCalendarWindow: async (id, from, to) =>
      (state.rawPunches || []).filter((p) => p.employee_id === id && p.punch_date >= from && p.punch_date <= to),
    getApprovedRegularizedPunches: async () => [],
    getBreakOverride: async () => null,
    getApprovalStateByDate: async (id, from, to) =>
      store.requests.filter((r) => r.requested_for_employee_id === id && r.attendance_date >= from && r.attendance_date <= to).map((r) => ({ ...r })),
    getEmploymentWindow: async (id) => EMPLOYEES.find((e) => e.employee_id === Number(id)) || null,
    getMonthlyGrossAsOf: async () => null,
    saveCalculations: async (rows) => { saved.calculations.push(rows); return { written: rows.length }; },
    saveCalculationsWithReconciliation: async ({ rows }) => { saved.calculations.push(rows); return { written: rows.length, stale_removed: 0 }; },
    saveDateShiftOverrideWithCalculation: async ({ override, rows }) => {
      const id = nextOverrideId; nextOverrideId += 1;
      overrides.push({ attendance_date_shift_override_id: id, ...override });
      saved.overrides.push(override);
      saved.calculations.push(rows);
      return { attendance_date_shift_override_id: id, written: rows.length };
    },
    // The REAL rule: a month is locked for an employee or it is not.
    findPayrollLockedPeriods: async (rows) =>
      (rows || [])
        .map((r) => ({ employee_id: Number(r.employee_id), year: Number(String(r.attendance_date).slice(0, 4)), month: Number(String(r.attendance_date).slice(5, 7)) }))
        .filter((p) => lockedMonths.has(`${p.year}-${p.month}`)),
    listEmployeesForRecalculation: async () => EMPLOYEES,
    outletExists: async () => true,
    designationExists: async () => true,
    insertRecalculationRun: async () => 1,
    finishRecalculationRun: async () => {},
    listRecalculationRuns: async () => [],
  };

  const regRepo = {
    store,
    getApprovalIdentity: async (id) => {
      if (IDENTITIES[id]) return { ...IDENTITIES[id], outlet_name: `Outlet ${IDENTITIES[id].outlet_id}` };
      const e = EMPLOYEES.find((x) => x.employee_id === Number(id));
      return e
        ? { employee_id: e.employee_id, employee_name: e.employee_name, outlet_id: e.store_id, outlet_name: `Outlet ${e.store_id}`, designation_id: e.designation_id, designation_name: "STAFF", approver_role: null, requester_class: null }
        : null;
    },
    findRequestsForDates: async (id, dates) =>
      store.requests.filter((r) => r.requested_for_employee_id === id && dates.includes(r.attendance_date) && r.status !== "CANCELLED"),
    createRequest: async ({ request, chain }) => {
      const id = nextId; nextId += 1;
      store.requests.push({
        attendance_approval_request_id: id, ...request, status: "PENDING", current_stage_no: 1,
        total_stages: chain.length, finalization_state: "NOT_REQUIRED", approved_ot_minutes: null,
        closure_reason: null, created_at: "2026-09-19 09:00:00", decided_at: null,
      });
      chain.forEach((s) => store.steps.push({
        attendance_approval_request_id: id, attendance_approval_step_id: id * 10 + s.stage_no,
        stage_no: s.stage_no, approver_role: s.approver_role, outlet_id: s.outlet_id,
        approver_employee_id: s.approver_employee_id === undefined ? null : s.approver_employee_id,
        approval_level: s.approval_level === undefined ? null : s.approval_level,
        decision: "PENDING", decided_by_employee_id: null, decided_at: null, remarks: null,
        acted_as_admin_override: 0, decision_source: null,
      }));
      return { attendance_approval_request_id: id, total_stages: chain.length };
    },
    getRequest: async (id) => {
      const r = store.requests.find((x) => x.attendance_approval_request_id === Number(id));
      if (!r) return null;
      return { ...r, steps: store.steps.filter((s) => s.attendance_approval_request_id === r.attendance_approval_request_id), regularized_punch: null };
    },
    decideStage: async (args) => {
      const r = store.requests.find((x) => x.attendance_approval_request_id === args.requestId);
      const st = store.steps.find((s) => s.attendance_approval_request_id === args.requestId && s.stage_no === args.stageNo);
      // THE DATABASE'S OWN GUARD, mirrored: the update names `decision =
      // 'PENDING'`, so a second decision of one stage affects no rows.
      if (!st || st.decision !== "PENDING" || r.status !== "PENDING") {
        return { code: 409, msg: "That stage has already been decided - reload and try again" };
      }
      st.decision = args.decision;
      st.decided_by_employee_id = args.actorId;
      st.decided_at = "2026-09-19 10:00:00";
      st.remarks = args.remarks;
      st.decision_source = args.decisionSource || "WEB";
      r.status = args.next.status;
      r.current_stage_no = args.next.current_stage_no;
      r.approved_ot_minutes = args.next.approved_ot_minutes;
      r.finalization_state = args.next.status === "PENDING" ? "NOT_REQUIRED" : "SETTLED";

      let overrideId = null;
      if (args.shiftOverride) {
        overrideId = nextOverrideId; nextOverrideId += 1;
        overrides.push({ attendance_date_shift_override_id: overrideId, ...args.shiftOverride });
        saved.overrides.push(args.shiftOverride);
      }
      saved.calculations.push(args.calculations || []);
      return {
        code: 200, status: r.status, current_stage_no: r.current_stage_no,
        finalization_state: r.finalization_state,
        calculations_written: (args.calculations || []).length,
        attendance_date_shift_override_id: overrideId,
      };
    },
    _visible: ({ request_type, status, actor_employee_id, is_admin, approver_roles = [], outlet_id = null, permitted_outlet_ids = null, filter_outlet_ids = null, filter_employee_id = null, filter_designation_id = null }) =>
      store.requests.filter((r) => {
        const types = Array.isArray(request_type) ? request_type : [request_type];
        if (!types.includes(r.request_type)) return false;
        if (status === "PENDING" && r.status !== "PENDING") return false;
        if ((status === "APPROVED" || status === "REJECTED") && r.status !== status) return false;
        if (Array.isArray(permitted_outlet_ids) && !permitted_outlet_ids.includes(r.outlet_id)) return false;
        if (Array.isArray(filter_outlet_ids) && filter_outlet_ids.length > 0 && !filter_outlet_ids.includes(r.outlet_id)) return false;
        if (filter_employee_id && r.requested_for_employee_id !== Number(filter_employee_id)) return false;
        if (filter_designation_id) {
          const e = EMPLOYEES.find((x) => x.employee_id === r.requested_for_employee_id) || {};
          if (Number(e.designation_id) !== Number(filter_designation_id)) return false;
        }
        if (!is_admin) {
          const step = store.steps.find((s) => s.attendance_approval_request_id === r.attendance_approval_request_id && s.stage_no === r.current_stage_no);
          if (status === "PENDING") {
            if (!step) return false;
            const mine = step.approver_employee_id
              ? Number(step.approver_employee_id) === Number(actor_employee_id)
              : approver_roles.includes(step.approver_role) && (step.approver_role !== "STORE_MANAGER" || step.outlet_id === outlet_id);
            if (!mine) return false;
          }
          if (r.requested_for_employee_id === actor_employee_id) return false;
        }
        return true;
      }),
    listApprovals: async (f) => regRepo._visible(f).map((r) => ({
      ...r,
      employee_name: (EMPLOYEES.find((e) => e.employee_id === r.requested_for_employee_id) || {}).employee_name,
      designation_id: (EMPLOYEES.find((e) => e.employee_id === r.requested_for_employee_id) || {}).designation_id,
      outlet_name: `Outlet ${r.outlet_id}`,
      requested_shift_code: r.requested_work_shift_id ? SHIFTS[r.requested_work_shift_id].config.shift_code : null,
      requested_shift_name: r.requested_work_shift_id ? SHIFTS[r.requested_work_shift_id].config.shift_name : null,
      base_shift_code: r.base_work_shift_id ? SHIFTS[r.base_work_shift_id].config.shift_code : null,
      base_shift_name: r.base_work_shift_id ? SHIFTS[r.base_work_shift_id].config.shift_name : null,
      proposed_punch_time: null, shift_snapshot: null, effective_punches: null,
      nrm_minutes: null, worked_minutes: null, shortage_minutes: null,
      stored_candidate_ot_minutes: 0, stored_status: null, shift_name: null,
    })),
    countApprovals: async (f) => regRepo._visible(f).length,
    listStepsForRequests: async (ids) => store.steps.filter((s) => ids.includes(s.attendance_approval_request_id)),
    listPendingFor: async () => [],
    listForEmployee: async () => [],
    closeOtAtPayrollLock: async () => ({ rejected_pending: 0, closed_unrequested: 0 }),
  };

  /** Employee-level chain: 7 First, 8 Final, for everybody. */
  const approverSetupRepo = state.roleChain
    ? null
    : { getActiveSetup: async (employeeId) => ({ employee_id: employeeId, first_level_approver_employee_id: 7, second_level_approver_employee_id: null, final_approver_employee_id: 8 }) };

  const workShiftRepo = {
    saved,
    findExistingEmployeeIds: async (ids) => ids.filter((id) => EMPLOYEES.some((e) => e.employee_id === id)),
    getActiveWorkShift: async (id) => (SHIFTS[id] ? { ...SHIFTS[id].config } : null),
    listAssignmentHistory: async (id) => [...(assignments[id] || [])].sort((a, b) => (a.effective_from < b.effective_from ? 1 : -1)),
    changeAssignment: async ({ employeeId, workShiftId, effectiveFrom, note, createdBy }) => {
      const id = nextAssignmentId; nextAssignmentId += 1;
      assignments[employeeId] = [
        ...(assignments[employeeId] || []),
        { employee_work_shift_assignment_id: id, employee_id: employeeId, work_shift_id: workShiftId, effective_from: effectiveFrom, source: "SHIFT_CHANGE", note, created_by: createdBy, created_at: "2026-09-19 11:00:00" },
      ];
      return { code: 200, employee_work_shift_assignment_id: id, employee_id: employeeId, work_shift_id: workShiftId, effective_from: effectiveFrom, source: "SHIFT_CHANGE" };
    },
    setDefaultWorkShift: async (employeeId, workShiftId) => { saved.defaultShiftWrites.push({ employeeId, workShiftId }); return { code: 200 }; },
    getEmployeeWorkShift: async () => null,
    listForAssignment: async () => [],
    getWorkShiftWorkingTimes: async () => [],
    listActiveWorkShiftOptions: async () => [],
    assignWorkShift: async () => ({ code: 200 }),
    correctAssignment: async () => ({ code: 200 }),
  };

  const calculation = buildCalculation(calcRepo);
  const regularization = buildRegularization(regRepo, calculation, approverSetupRepo);
  calculation.setOtRequestService(regularization);

  const workShift = buildWorkShift(workShiftRepo);
  workShift.setAttendanceCalculation(calculation, calcRepo);

  const telegramCalls = { sent: [], answered: [], retired: [] };
  const telegram = {
    isConfigured: () => true,
    sendMessage: async (chatId, text, options) => { telegramCalls.sent.push({ chatId, text, options }); return { message_id: 555 }; },
    answerCallbackQuery: async (id, text) => { telegramCalls.answered.push({ id, text }); },
    editMessageReplyMarkup: async (chatId, messageId, markup) => { telegramCalls.retired.push({ chatId, messageId, markup }); },
  };
  const employeeTelegramRepo = {
    getActiveIdentityByEmployee: async (employeeId) =>
      state.noTelegramFor === employeeId ? null : { employee_id: employeeId, private_chat_id: 1000 + employeeId },
    getActiveIdentityByTelegramUser: async (telegramUserId) =>
      telegramUserId ? { employee_id: telegramUserId - 1000, private_chat_id: telegramUserId } : null,
  };
  const shiftTelegram = buildShiftTelegram({
    regularizationUsecase: regularization,
    employeeTelegramRepo,
    telegram,
    webBaseUrl: "https://dnds.co.in",
  });
  regularization.setShiftChangeNotifier(shiftTelegram);

  return { calculation, regularization, workShift, shiftTelegram, telegramCalls, store, saved, overrides, assignments };
}

const self = (employeeId) => ({ employee_id: employeeId, user_type: 1, branch_scope: ALL_BRANCHES });
const approver = (employeeId) => ({ employee_id: employeeId, user_type: 1, branch_scope: ALL_BRANCHES });

/* ============================== A. the effective-dated permanent change == */

describe("A. Edit Shift Assignment - effective from a date", () => {
  it("mid-month: the days before the effective date keep the old shift, the days from it take the new one", async () => {
    const world = build();

    const result = await world.workShift.changeAssignment({
      employee_id: EMPLOYEE, work_shift_id: LONG, effective_from: "2026-09-15",
      reason: "Moved to the long shift", actor_employee_id: 7, today: TODAY,
    });
    assert.equal(result.code, 200);
    assert.equal(result.source, "SHIFT_CHANGE");
    assert.equal(result.previous_work_shift_id, EVE);

    const days = await world.calculation.calculateRange({ employee_id: EMPLOYEE, from_date: "2026-09-13", to_date: "2026-09-16" });
    assert.deepEqual(
      days.map((d) => [d.attendance_date, d.work_shift_id]),
      [["2026-09-13", EVE], ["2026-09-14", EVE], ["2026-09-15", LONG], ["2026-09-16", LONG]]
    );
  });

  it("nothing is overwritten or deleted: the old row is still there, and the history says who changed it and why", async () => {
    const world = build();
    await world.workShift.changeAssignment({
      employee_id: EMPLOYEE, work_shift_id: LONG, effective_from: "2026-09-15",
      reason: "Moved to the long shift", actor_employee_id: 7, today: TODAY,
    });

    const history = await world.workShift.assignmentHistory(EMPLOYEE, { today: TODAY });
    assert.equal(history.data.length, 2, "the original assignment row is still there");
    const [newest, oldest] = history.data;
    assert.equal(newest.effective_from, "2026-09-15");
    assert.equal(newest.reason, "Moved to the long shift");
    assert.equal(newest.changed_by_employee_id, 7);
    assert.equal(newest.source, "SHIFT_CHANGE");
    assert.equal(newest.is_current, true);
    assert.equal(oldest.effective_from, "2026-09-01");
    assert.equal(oldest.is_current, false);
  });

  it("a FUTURE effective date is recorded, is not current, and does not touch the employee's shift today", async () => {
    const world = build();
    const result = await world.workShift.changeAssignment({
      employee_id: EMPLOYEE, work_shift_id: LONG, effective_from: "2026-10-01",
      reason: "From next month", actor_employee_id: 7, today: TODAY,
    });
    assert.equal(result.is_future_dated, true);
    assert.deepEqual(world.saved.defaultShiftWrites, [], "today's shift is not moved by a change that has not happened");

    const history = await world.workShift.assignmentHistory(EMPLOYEE, { today: TODAY });
    assert.equal(history.data[0].is_future_dated, true);
    assert.equal(history.data[0].is_current, false, "the newest row is not necessarily the current one");
    assert.equal(history.data[1].is_current, true);
  });

  it("a RETROACTIVE change into an UNLOCKED month is allowed, and recalculates from the effective date", async () => {
    const world = build({ rawPunches: [punch(1, EMPLOYEE, "2026-09-10 18:00:00"), punch(2, EMPLOYEE, "2026-09-10 22:00:00")] });
    const result = await world.workShift.changeAssignment({
      employee_id: EMPLOYEE, work_shift_id: LONG, effective_from: "2026-09-10",
      reason: "Was moved a week ago, filed late", actor_employee_id: 7, today: TODAY,
    });
    assert.equal(result.code, 200);
    assert.ok(result.recalculated, "the dates it moved were recalculated");
    assert.equal(result.recalculated.from_date, "2026-09-10");
    assert.equal(result.recalculated.to_date, TODAY);
  });

  it("a retroactive change into a LOCKED month is REFUSED, and writes nothing", async () => {
    const world = build({ lockedMonths: ["2026-8"] });
    await assert.rejects(
      () => world.workShift.changeAssignment({
        employee_id: EMPLOYEE, work_shift_id: LONG, effective_from: "2026-08-20",
        reason: "Backdating into a settled month", actor_employee_id: 7, today: TODAY,
      }),
      (err) => {
        assert.equal(err.code, "PAYROLL_MONTH_LOCKED");
        assert.match(err.message, /08\/2026/);
        return true;
      }
    );
    const history = await world.workShift.assignmentHistory(EMPLOYEE, { today: TODAY });
    assert.equal(history.data.length, 1, "nothing was appended");
    assert.deepEqual(world.saved.defaultShiftWrites, []);
  });

  it("the lock is checked for EVERY month the change would move, not only the effective one", async () => {
    // Effective in August, today in September: September is locked, and the
    // change would rewrite it too.
    const world = build({ lockedMonths: ["2026-9"] });
    await assert.rejects(
      () => world.workShift.changeAssignment({
        employee_id: EMPLOYEE, work_shift_id: LONG, effective_from: "2026-08-20",
        reason: "Backdating across a locked month", actor_employee_id: 7, today: TODAY,
      }),
      (err) => err.code === "PAYROLL_MONTH_LOCKED"
    );
  });

  it("a reason is mandatory, and an effective date is never defaulted", async () => {
    const world = build();
    await assert.rejects(
      () => world.workShift.changeAssignment({ employee_id: EMPLOYEE, work_shift_id: LONG, effective_from: "2026-09-15", reason: "x" }),
      /reason of at least 5 characters/
    );
    await assert.rejects(
      () => world.workShift.changeAssignment({ employee_id: EMPLOYEE, work_shift_id: LONG, reason: "No date given at all" }),
      /effective_from is required/
    );
  });
});

/* ================================ B. the employee's one-day shift request = */

describe("B. the one-day shift request - what may be asked for", () => {
  const DATE = "2026-09-26";

  it("a LONGER shift may be requested", async () => {
    const world = build();
    const raised = await world.regularization.raiseShiftChangeRequest({
      actor: self(EMPLOYEE), attendance_date: DATE, work_shift_id: LONG,
      reason: "Covering the full day", today: TODAY,
    });
    assert.equal(raised.request_type, REQUEST_TYPE.SHIFT_CHANGE);
    assert.equal(raised.requested_work_shift_id, LONG);
    assert.equal(raised.base_work_shift_id, EVE);
    assert.equal(raised.base_nrm_minutes, 240);
    assert.equal(raised.requested_nrm_minutes, 660);
  });

  it("a shift with an EQUAL NRM may not", async () => {
    const world = build();
    await assert.rejects(
      () => world.regularization.raiseShiftChangeRequest({
        actor: self(EMPLOYEE), attendance_date: DATE, work_shift_id: SAME,
        reason: "Same hours, different times", today: TODAY,
      }),
      /longer working hours than your normal shift/
    );
    assert.equal(world.store.requests.length, 0);
  });

  it("a SHORTER shift may not - that is what Edit Shift Assignment is for", async () => {
    const world = build();
    await assert.rejects(
      () => world.regularization.raiseShiftChangeRequest({
        actor: self(EMPLOYEE), attendance_date: DATE, work_shift_id: MINI,
        reason: "I would like a shorter day", today: TODAY,
      }),
      /longer working hours than your normal shift/
    );
    assert.equal(world.store.requests.length, 0);
  });

  it("the OPTIONS the screen offers are exactly the ones the server would accept", async () => {
    const world = build();
    const { options, base } = await world.regularization.shiftChangeOptions({
      actor: self(EMPLOYEE), attendance_date: DATE,
    });
    assert.equal(base.work_shift_id, EVE);
    assert.deepEqual(options.map((o) => o.work_shift_id), [LONG]);

    // And the server refuses the ones it did not offer, independently.
    for (const rejected of [SAME, MINI]) {
      /* eslint-disable no-await-in-loop */
      await assert.rejects(
        () => world.regularization.raiseShiftChangeRequest({
          actor: self(EMPLOYEE), attendance_date: DATE, work_shift_id: rejected,
          reason: "Asking for one the screen did not offer", today: TODAY,
        }),
        /longer working hours/
      );
      /* eslint-enable no-await-in-loop */
    }
  });

  it("two open requests for one date are impossible", async () => {
    const world = build();
    await world.regularization.raiseShiftChangeRequest({
      actor: self(EMPLOYEE), attendance_date: DATE, work_shift_id: LONG, reason: "Covering the full day", today: TODAY,
    });
    await assert.rejects(
      () => world.regularization.raiseShiftChangeRequest({
        actor: self(EMPLOYEE), attendance_date: DATE, work_shift_id: LONG, reason: "Asking twice", today: TODAY,
      }),
      /already pending/
    );
  });

  it("a date in a LOCKED payroll month cannot be requested at all", async () => {
    const world = build({ lockedMonths: ["2026-8"] });
    await assert.rejects(
      () => world.regularization.raiseShiftChangeRequest({
        actor: self(EMPLOYEE), attendance_date: "2026-08-20", work_shift_id: LONG,
        reason: "A settled month", today: TODAY,
      }),
      (err) => err.code === "PAYROLL_MONTH_LOCKED"
    );
    assert.equal(world.store.requests.length, 0);
  });
});

/* ===================================== the approved day, and what it pays = */

describe("B. the approved one-day shift - the day's rules and the day's pay", () => {
  const DATE = "2026-09-18";
  /** 10:00-22:00 with an hour's break taken: 12h span, 11h worked. */
  const LONG_DAY = [
    punch(1, EMPLOYEE, "2026-09-18 10:00:00"), punch(2, EMPLOYEE, "2026-09-18 14:00:00"),
    punch(3, EMPLOYEE, "2026-09-18 15:00:00"), punch(4, EMPLOYEE, "2026-09-18 22:00:00"),
    // The NEXT day, worked on the ordinary evening shift.
    punch(5, EMPLOYEE, "2026-09-19 18:00:00"), punch(6, EMPLOYEE, "2026-09-19 22:00:00"),
  ];

  const approveFully = async (world) => {
    const raised = await world.regularization.raiseShiftChangeRequest({
      actor: self(EMPLOYEE), attendance_date: DATE, work_shift_id: LONG,
      reason: "Covering the full day", today: TODAY,
    });
    const id = raised.attendance_approval_request_id;
    await world.regularization.decide({ actor: approver(7), request_id: id, decision: STEP_DECISION.APPROVED });
    const final = await world.regularization.decide({ actor: approver(8), request_id: id, decision: STEP_DECISION.APPROVED });
    return { id, final };
  };

  it("becomes effective for that date ONLY on final approval, and through the ordinary override table", async () => {
    const world = build({ rawPunches: LONG_DAY });

    const raised = await world.regularization.raiseShiftChangeRequest({
      actor: self(EMPLOYEE), attendance_date: DATE, work_shift_id: LONG,
      reason: "Covering the full day", today: TODAY,
    });

    // PENDING changes nothing at all.
    let [day] = await world.calculation.calculateRange({ employee_id: EMPLOYEE, from_date: DATE, to_date: DATE });
    assert.equal(day.work_shift_id, EVE, "a pending request moves no shift");

    // The FIRST approval does not either - there is a stage left.
    const first = await world.regularization.decide({
      actor: approver(7), request_id: raised.attendance_approval_request_id, decision: STEP_DECISION.APPROVED,
    });
    assert.equal(first.status, REQUEST_STATUS.PENDING);
    [day] = await world.calculation.calculateRange({ employee_id: EMPLOYEE, from_date: DATE, to_date: DATE });
    assert.equal(day.work_shift_id, EVE, "an intermediate approval moves no shift either");

    const final = await world.regularization.decide({
      actor: approver(8), request_id: raised.attendance_approval_request_id, decision: STEP_DECISION.APPROVED,
    });
    assert.equal(final.status, REQUEST_STATUS.APPROVED);
    assert.ok(final.attendance_date_shift_override_id, "the override was written with the decision");
    assert.equal(world.saved.overrides.length, 1);
    assert.deepEqual(
      { ...world.saved.overrides[0] },
      { employee_id: EMPLOYEE, attendance_date: DATE, work_shift_id: LONG, previous_work_shift_id: EVE, reason: "Covering the full day" }
    );

    [day] = await world.calculation.calculateRange({ employee_id: EMPLOYEE, from_date: DATE, to_date: DATE });
    assert.equal(day.work_shift_id, LONG);
  });

  it("THE NEXT DAY IS UNTOUCHED - an override is one date and cannot leak forward", async () => {
    const world = build({ rawPunches: LONG_DAY });
    await approveFully(world);

    const days = await world.calculation.calculateRange({ employee_id: EMPLOYEE, from_date: "2026-09-17", to_date: "2026-09-19" });
    assert.deepEqual(
      days.map((d) => [d.attendance_date, d.work_shift_id]),
      [["2026-09-17", EVE], ["2026-09-18", LONG], ["2026-09-19", EVE]]
    );
  });

  it("the day's RULES come from the requested shift: its hours, its break, its lateness", async () => {
    const world = build({ rawPunches: LONG_DAY });
    await approveFully(world);
    const [day] = await world.calculation.calculateRange({ employee_id: EMPLOYEE, from_date: DATE, to_date: DATE });

    assert.equal(day.shift_snapshot.in_time, "10:00:00", "the requested shift's start");
    assert.equal(day.shift_snapshot.out_time, "22:00:00", "the requested shift's end");
    assert.equal(day.shift_snapshot.break_minutes, 60, "the requested shift's break");
    assert.equal(day.nrm_minutes, 660, "the requested shift's own NRM still describes the DAY");
    assert.equal(day.late_minutes, 0, "10:00 against a 10:00 start is not late - the EVE shift's 18:00 is not used");
    assert.equal(day.break_charged_minutes, 60, "the break actually taken, under the requested shift's rules");
    assert.equal(day.worked_minutes, 660);
  });

  it("but the day's PAY comes from the BASE shift: Regular = MIN(worked, base NRM), OT = the rest, shortage = 0", async () => {
    const world = build({ rawPunches: LONG_DAY });
    await approveFully(world);
    const [day] = await world.calculation.calculateRange({ employee_id: EMPLOYEE, from_date: DATE, to_date: DATE });

    assert.equal(day.base_nrm_minutes, 240, "the PERMANENT evening shift's NRM");
    assert.equal(day.base_work_shift_id, EVE);
    assert.equal(day.regular_minutes, 240, "MIN(660 worked, 240 base NRM)");
    assert.equal(day.candidate_ot_minutes, 420, "660 - 240, and NOT nothing-because-the-temporary-shift-is-11h");
    assert.equal(day.shortage_minutes, 0, "never 7h short for working an 11h day");
  });

  it("working LESS than the temporary shift but at least the base NRM is a full day with no shortage", async () => {
    // 10:00-16:00 with no break gap: 6h worked against a 4h entitlement.
    const world = build({
      rawPunches: [punch(1, EMPLOYEE, `${DATE} 10:00:00`), punch(2, EMPLOYEE, `${DATE} 16:00:00`)],
    });
    await approveFully(world);
    const [day] = await world.calculation.calculateRange({ employee_id: EMPLOYEE, from_date: DATE, to_date: DATE });

    assert.equal(day.base_nrm_minutes, 240);
    assert.equal(day.regular_minutes, 240, "the whole entitlement is earned");
    assert.equal(day.shortage_minutes, 0, "and NOT short by the difference from the temporary shift");
    assert.ok(day.candidate_ot_minutes > 0, "the hours beyond the base entitlement are overtime");
  });

  it("working LESS than the BASE NRM is short by exactly that much", async () => {
    // 10:00-13:00: three hours of a four-hour entitlement.
    const world = build({
      rawPunches: [punch(1, EMPLOYEE, `${DATE} 10:00:00`), punch(2, EMPLOYEE, `${DATE} 13:00:00`)],
    });
    await approveFully(world);
    const [day] = await world.calculation.calculateRange({ employee_id: EMPLOYEE, from_date: DATE, to_date: DATE });

    assert.equal(day.worked_minutes, 180);
    assert.equal(day.regular_minutes, 180);
    assert.equal(day.shortage_minutes, 60, "one hour short of the BASE entitlement, not seven of the temporary one");
    assert.equal(day.candidate_ot_minutes, 0);
  });

  it("neither the permanent assignment nor the employee's current shift is touched by any of it", async () => {
    const world = build({ rawPunches: LONG_DAY });
    await approveFully(world);

    const history = await world.workShift.assignmentHistory(EMPLOYEE, { today: TODAY });
    assert.equal(history.data.length, 1, "no history row was appended by a one-day request");
    assert.equal(history.data[0].work_shift_id, EVE);
    assert.deepEqual(world.saved.defaultShiftWrites, [], "and the employee's current shift was never written");
  });

  it("a REJECTION needs a reason, and leaves the date on the permanent shift", async () => {
    const world = build({ rawPunches: LONG_DAY });
    const raised = await world.regularization.raiseShiftChangeRequest({
      actor: self(EMPLOYEE), attendance_date: DATE, work_shift_id: LONG, reason: "Covering the full day", today: TODAY,
    });
    await assert.rejects(
      () => world.regularization.decide({
        actor: approver(7), request_id: raised.attendance_approval_request_id, decision: STEP_DECISION.REJECTED,
      }),
      /rejection reason of at least 5 characters/
    );

    const rejected = await world.regularization.decide({
      actor: approver(7), request_id: raised.attendance_approval_request_id,
      decision: STEP_DECISION.REJECTED, remarks: "We have cover that day",
    });
    assert.equal(rejected.status, REQUEST_STATUS.REJECTED);
    assert.equal(world.saved.overrides.length, 0);
    const [day] = await world.calculation.calculateRange({ employee_id: EMPLOYEE, from_date: DATE, to_date: DATE });
    assert.equal(day.work_shift_id, EVE);
  });

  it("approval is REFUSED once the month is locked, even though the request was filed while it was open", async () => {
    const world = build({ rawPunches: LONG_DAY });
    const raised = await world.regularization.raiseShiftChangeRequest({
      actor: self(EMPLOYEE), attendance_date: DATE, work_shift_id: LONG, reason: "Covering the full day", today: TODAY,
    });
    world.store.lockedAfterFiling = true;

    // The month closes while the request sits in the queue.
    const locked = build({ rawPunches: LONG_DAY, lockedMonths: ["2026-9"] });
    const raisedInOpen = world.store.requests[0];
    locked.store.requests.push(raisedInOpen);
    locked.store.steps.push(...world.store.steps);

    await assert.rejects(
      () => locked.regularization.decide({
        actor: approver(7), request_id: raisedInOpen.attendance_approval_request_id, decision: STEP_DECISION.APPROVED,
      }),
      (err) => err.code === "PAYROLL_MONTH_LOCKED"
    );
    assert.equal(locked.saved.overrides.length, 0);

    // A REJECTION is still allowed: it changes no attendance and pays nothing,
    // and the alternative is a request that can never be closed.
    const closed = await locked.regularization.decide({
      actor: approver(7), request_id: raisedInOpen.attendance_approval_request_id,
      decision: STEP_DECISION.REJECTED, remarks: "Payroll for that month is closed",
    });
    assert.equal(closed.status, REQUEST_STATUS.REJECTED);
  });
});

/* ====================================== C. the approval chain and Telegram = */

describe("C. Telegram - the first approver, and only the first", () => {
  const DATE = "2026-09-26";

  const raise = async (world) =>
    world.regularization.raiseShiftChangeRequest({
      actor: self(EMPLOYEE), attendance_date: DATE, work_shift_id: LONG,
      reason: "Covering the full day", today: TODAY,
    });

  it("the FIRST approver is messaged, once, with the employee, outlet, date, both shifts and the reason", async () => {
    const world = build();
    const raised = await raise(world);

    assert.equal(world.telegramCalls.sent.length, 1, "exactly one message");
    const [message] = world.telegramCalls.sent;
    assert.equal(message.chatId, 1007, "the FIRST approver's private chat");
    assert.equal(raised.telegram.sent, true);
    assert.equal(raised.telegram.approver_employee_id, 7);

    for (const expected of ["Asha", `ID ${EMPLOYEE}`, "Outlet 3", DATE, "EVE 18:00-22:00", "LONG 10:00-22:00", "Covering the full day"]) {
      assert.ok(message.text.includes(expected), `the message states ${expected}`);
    }
    const buttons = message.options.replyMarkup.inline_keyboard.flat().map((b) => b.text);
    assert.deepEqual(buttons, ["Approve", "Reject", "View"]);
    // PLAIN TEXT: the reason and the names are user-controlled.
    assert.equal(message.options.parseMode, null);
  });

  it("the LATER approver is NOT messaged - the next stage continues in the web app", async () => {
    const world = build();
    const raised = await raise(world);
    world.telegramCalls.sent.length = 0;

    const first = await world.regularization.decide({
      actor: approver(7), request_id: raised.attendance_approval_request_id, decision: STEP_DECISION.APPROVED,
    });
    assert.equal(first.status, REQUEST_STATUS.PENDING, "there is a second stage");
    assert.equal(first.current_stage_no, 2);
    assert.deepEqual(
      world.telegramCalls.sent.filter((m) => m.options && m.options.replyMarkup),
      [],
      "no message with Approve/Reject buttons went to the final approver"
    );
  });

  it("a ROLE chain names nobody, so nobody is messaged", async () => {
    const world = build({ roleChain: true });
    const raised = await raise(world);
    assert.equal(raised.telegram.sent, false);
    assert.equal(raised.telegram.reason, "FIRST_APPROVER_IS_A_ROLE");
    assert.deepEqual(world.telegramCalls.sent, []);
  });

  it("an approver with no linked Telegram account stops nothing - the request is still raised", async () => {
    const world = build({ noTelegramFor: 7 });
    const raised = await raise(world);
    assert.equal(raised.telegram.sent, false);
    assert.equal(raised.telegram.reason, "APPROVER_HAS_NO_TELEGRAM");
    assert.equal(world.store.requests.length, 1);
  });

  it("the Telegram tap and the web decision act on ONE record, and the step says which surface decided", async () => {
    const world = build();
    const raised = await raise(world);
    const id = raised.attendance_approval_request_id;

    await world.shiftTelegram.handle({
      callback_query: { id: "cb1", data: `sc:${id}:A`, from: { id: 1007 }, message: { message_id: 555, chat: { id: 1007 } } },
    });

    const step = world.store.steps.find((s) => s.attendance_approval_request_id === id && s.stage_no === 1);
    assert.equal(step.decision, "APPROVED");
    assert.equal(step.decided_by_employee_id, 7);
    assert.equal(step.decision_source, "TELEGRAM");
    assert.equal(world.store.requests[0].current_stage_no, 2, "the same record moved on");

    // And the web app finishes the very same request.
    const final = await world.regularization.decide({ actor: approver(8), request_id: id, decision: STEP_DECISION.APPROVED });
    assert.equal(final.status, REQUEST_STATUS.APPROVED);
    assert.equal(final.decision_source, "WEB");
  });

  it("a STALE button is refused and retired: the second tap changes nothing", async () => {
    const world = build();
    const raised = await raise(world);
    const id = raised.attendance_approval_request_id;
    const tap = {
      callback_query: { id: "cb1", data: `sc:${id}:A`, from: { id: 1007 }, message: { message_id: 555, chat: { id: 1007 } } },
    };

    await world.shiftTelegram.handle(tap);
    const after = { ...world.store.requests[0] };
    world.telegramCalls.answered.length = 0;

    const second = await world.shiftTelegram.handle(tap);
    // The stage this approver held has moved on, so the second tap is refused
    // with the reason - and, crucially, changes nothing.
    assert.equal(second.outcome, "REFUSED");
    assert.ok(world.telegramCalls.answered[0].text, "the approver was told why");
    assert.deepEqual({ ...world.store.requests[0] }, after, "nothing moved on the second tap");
    assert.ok(world.telegramCalls.retired.some((r) => r.messageId === 555), "the buttons were taken away");
  });

  it("the 409 a concurrent web decision produces retires the buttons and says so", async () => {
    // The race the database itself answers: `decideStage` updates the step
    // `AND decision = 'PENDING'`, so the loser of two simultaneous decisions
    // affects no rows and is handed 409. This drives that answer directly,
    // because a fake cannot be genuinely concurrent.
    const calls = { answered: [], retired: [] };
    const handler = buildShiftTelegram({
      regularizationUsecase: { decide: async () => ({ code: 409, msg: "already decided" }) },
      employeeTelegramRepo: { getActiveIdentityByTelegramUser: async () => ({ employee_id: 7 }) },
      telegram: {
        isConfigured: () => true,
        sendMessage: async () => ({}),
        answerCallbackQuery: async (id, text) => calls.answered.push(text),
        editMessageReplyMarkup: async (chatId, messageId) => calls.retired.push(messageId),
      },
    });

    const result = await handler.handle({
      callback_query: { id: "cb", data: "sc:901:A", from: { id: 1007 }, message: { message_id: 555, chat: { id: 1007 } } },
    });
    assert.equal(result.outcome, "ALREADY_DECIDED");
    assert.match(calls.answered[0], /already been actioned/);
    assert.deepEqual(calls.retired, [555]);
  });

  it("somebody with no authority over the request is refused, with the reason, and decides nothing", async () => {
    const world = build();
    const raised = await raise(world);
    const id = raised.attendance_approval_request_id;

    // Employee 9 manages another outlet and holds no stage on this request.
    await world.shiftTelegram.handle({
      callback_query: { id: "cb1", data: `sc:${id}:A`, from: { id: 1009 }, message: { message_id: 555, chat: { id: 1009 } } },
    });
    const step = world.store.steps.find((s) => s.attendance_approval_request_id === id && s.stage_no === 1);
    assert.equal(step.decision, "PENDING", "no authority, no decision");
    assert.ok(world.telegramCalls.answered.length > 0, "and they were told why");
  });

  it("REJECT from Telegram asks for the reason, and the reply is what records the rejection", async () => {
    const world = build();
    const raised = await raise(world);
    const id = raised.attendance_approval_request_id;

    const asked = await world.shiftTelegram.handle({
      callback_query: { id: "cb1", data: `sc:${id}:R`, from: { id: 1007 }, message: { message_id: 555, chat: { id: 1007 } } },
    });
    assert.equal(asked.outcome, "REJECT_REASON_REQUESTED");
    assert.equal(world.store.requests[0].status, "PENDING", "the tap alone decides nothing");

    const prompt = world.telegramCalls.sent[world.telegramCalls.sent.length - 1];
    assert.match(prompt.text, new RegExp(`Reject shift request #${id}`));
    assert.equal(prompt.options.replyMarkup.force_reply, true);

    const reply = {
      message: {
        chat: { id: 1007 }, from: { id: 1007 }, text: "We already have cover that day",
        reply_to_message: { text: prompt.text },
      },
    };
    assert.equal(world.shiftTelegram.claims(reply), true, "the handler claims its own prompt's reply");
    await world.shiftTelegram.handle(reply);

    const step = world.store.steps.find((s) => s.attendance_approval_request_id === id && s.stage_no === 1);
    assert.equal(step.decision, "REJECTED");
    assert.equal(step.remarks, "We already have cover that day");
    assert.equal(step.decision_source, "TELEGRAM");
  });

  it("a reply that is too short records nothing", async () => {
    const world = build();
    const raised = await raise(world);
    const id = raised.attendance_approval_request_id;
    await world.shiftTelegram.handle({
      callback_query: { id: "cb1", data: `sc:${id}:R`, from: { id: 1007 }, message: { message_id: 555, chat: { id: 1007 } } },
    });
    const prompt = world.telegramCalls.sent[world.telegramCalls.sent.length - 1];

    const result = await world.shiftTelegram.handle({
      message: { chat: { id: 1007 }, from: { id: 1007 }, text: "no", reply_to_message: { text: prompt.text } },
    });
    assert.equal(result.outcome, "REASON_TOO_SHORT");
    assert.equal(world.store.requests[0].status, "PENDING");
  });
});

/* ================================ D/E. the unified queue, and who sees it == */

describe("D/E. the unified approval centre - filters and outlet scope", () => {
  const DATE = "2026-09-26";

  const seed = async () => {
    const world = build();
    await world.regularization.raiseShiftChangeRequest({
      actor: self(EMPLOYEE), attendance_date: DATE, work_shift_id: LONG, reason: "Covering the full day", today: TODAY,
    });
    await world.regularization.raiseShiftChangeRequest({
      actor: self(43), attendance_date: DATE, work_shift_id: LONG, reason: "Covering the full day too", today: TODAY,
    });
    return world;
  };

  it("the Shift tab lists shift requests, with both shifts and the approval stage named", async () => {
    const world = await seed();
    const { rows } = await world.regularization.listApprovals({
      actor: approver(7), request_type: REQUEST_TYPE.SHIFT_CHANGE, status: "PENDING",
    });
    assert.equal(rows.length, 2);
    const [row] = rows;
    assert.equal(row.request_type, REQUEST_TYPE.SHIFT_CHANGE);
    assert.equal(row.base_shift_code, "EVE");
    assert.equal(row.requested_shift_code, "LONG");
    assert.equal(row.approval_stage, "1 of 2");
    assert.equal(row.reason, "Covering the full day");
  });

  it("the OUTLET filter narrows it, and the count follows the same filters", async () => {
    const world = await seed();
    const filtered = await world.regularization.listApprovals({
      actor: approver(7), request_type: REQUEST_TYPE.SHIFT_CHANGE, status: "PENDING", outlet_ids: [3],
    });
    assert.deepEqual(filtered.rows.map((r) => r.employee_id), [EMPLOYEE]);

    const counted = await world.regularization.countPending({
      actor: approver(7), request_type: REQUEST_TYPE.SHIFT_CHANGE, outlet_ids: [3],
    });
    assert.equal(counted.pending_with_me, 1, "the counter counts the table the reader is looking at");
  });

  it("the EMPLOYEE and DESIGNATION filters work, together with the outlet", async () => {
    const world = await seed();
    const byEmployee = await world.regularization.listApprovals({
      actor: approver(7), request_type: REQUEST_TYPE.SHIFT_CHANGE, status: "PENDING", employee_id: 43,
    });
    assert.deepEqual(byEmployee.rows.map((r) => r.employee_id), [43]);

    const byDesignation = await world.regularization.listApprovals({
      actor: approver(7), request_type: REQUEST_TYPE.SHIFT_CHANGE, status: "PENDING", designation_id: 12, outlet_ids: [5],
    });
    assert.deepEqual(byDesignation.rows.map((r) => r.employee_id), [43]);

    const contradictory = await world.regularization.listApprovals({
      actor: approver(7), request_type: REQUEST_TYPE.SHIFT_CHANGE, status: "PENDING", designation_id: 12, outlet_ids: [3],
    });
    assert.deepEqual(contradictory.rows, [], "the filters combine rather than override each other");
  });

  it("OUTLET SCOPE IS NOT A FILTER: a caller scoped to one outlet cannot ask for another", async () => {
    const world = await seed();
    const scoped = {
      employee_id: 7, user_type: 1,
      branch_scope: { kind: "OWN_BRANCHES", store_ids: [3] },
    };

    const own = await world.regularization.listApprovals({
      actor: scoped, request_type: REQUEST_TYPE.SHIFT_CHANGE, status: "PENDING",
    });
    assert.deepEqual(own.rows.map((r) => r.employee_id), [EMPLOYEE]);

    const asked = await world.regularization.listApprovals({
      actor: scoped, request_type: REQUEST_TYPE.SHIFT_CHANGE, status: "PENDING", outlet_ids: [5],
    });
    assert.deepEqual(asked.rows, [], "asking for an outlet you have no rights to returns nothing, not everything");
  });

  it("AND IT FAILS CLOSED: an actor with no resolved scope sees nothing at all", async () => {
    const world = await seed();
    const unscoped = await world.regularization.listApprovals({
      actor: { employee_id: 7, user_type: 1 },
      request_type: REQUEST_TYPE.SHIFT_CHANGE,
      status: "PENDING",
    });
    assert.deepEqual(unscoped.rows, []);
  });

  it("the three tabs are three filters on one queue, and never mix", async () => {
    const world = await seed();
    const shift = await world.regularization.listApprovals({ actor: approver(7), request_type: REQUEST_TYPE.SHIFT_CHANGE, status: "PENDING" });
    const attendance = await world.regularization.listApprovals({ actor: approver(7), request_type: REQUEST_TYPE.REGULARIZATION, status: "PENDING" });
    const ot = await world.regularization.listApprovals({ actor: approver(7), request_type: REQUEST_TYPE.OT, status: "PENDING" });
    assert.equal(shift.rows.length, 2);
    assert.deepEqual(attendance.rows, []);
    assert.deepEqual(ot.rows, []);
  });
});
