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
const shiftChangeEligibility = require("../utils/shift_change_eligibility");
const buildWorkShift = require("./employee_work_shift");
const buildShiftTelegram = require("./attendance_shift_change_telegram");
const { REQUEST_TYPE, REQUEST_STATUS, STEP_DECISION, APPROVER_ROLE } =
  require("../utils/attendance_approval_chain");
const {
  affectedRangeForNewAssignment,
  monthProbesForRange,
  resolveAssignmentForDate,
} = require("../utils/shiftResolution");
const { payrollLockedError } = require("../utils/attendance_payroll_lock");

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

/**
 * A fixture shift's NRM on any day: the span less its own break, which is
 * exactly what `shiftForDate` reports and what the shared longer-shift helper
 * compares. Derived from the SHIFTS fixture rather than hardcoded, so a change
 * to the fixture cannot quietly invalidate the assertions built on it.
 */
const nrmOf = (workShiftId) => {
  const row = SHIFTS[workShiftId].schedule[0];
  const mins = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const span = mins(row.out_time) - mins(row.in_time);
  return Math.max(0, (span < 0 ? span + 24 * 60 : span) - row.break_minutes);
};

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
  const saved = { calculations: [], overrides: [], defaultShiftWrites: [], lockProbes: [] };
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
    /*
     * The REAL query joins the override to its authorising request and
     * answers `shift_change_approved`. The fake must do the same, or a test
     * of the shift-authorised OT rule would pass against a fake that simply
     * agreed with it.
     */
    getDateShiftOverrides: async (id, from, to) =>
      overrides
        .filter((o) => o.employee_id === id && o.attendance_date >= from && o.attendance_date <= to)
        .map((o) => {
          const request = store.requests.find(
            (r) => r.attendance_approval_request_id === o.attendance_approval_request_id
          );
          const approved =
            !!request &&
            request.request_type === "SHIFT_CHANGE" &&
            request.status === "APPROVED" &&
            request.finalization_state === "SETTLED";
          return { ...o, shift_change_approved: approved ? 1 : 0 };
        }),
    getWorkShiftWithSchedule: async (id) => SHIFTS[id] || null,
    getWorkShiftConfigVersions: async () => [],
    listActiveWorkShiftOptions: async () =>
      Object.values(SHIFTS).map((s) => ({ work_shift_id: s.config.work_shift_id, shift_code: s.config.shift_code, shift_name: s.config.shift_name })),
    getRawPunchesByCalendarWindow: async (id, from, to) =>
      (state.rawPunches || []).filter((p) => p.employee_id === id && p.punch_date >= from && p.punch_date <= to),
    // An APPROVED and SETTLED correction's punch counts on the day, exactly
    // as the real query returns it.
    getApprovedRegularizedPunches: async (id, from, to) =>
      store.requests
        .filter(
          (r) =>
            r.requested_for_employee_id === id &&
            r.punch &&
            r.status === "APPROVED" &&
            r.finalization_state === "SETTLED" &&
            r.attendance_date >= from &&
            r.attendance_date <= to
        )
        .map((r) => ({
          attendance_regularized_punch_id: r.attendance_approval_request_id,
          employee_id: id,
          attendance_date: r.attendance_date,
          io_time: r.punch.punch_time,
          punch_id: null,
        })),
    getBreakOverride: async () => null,
    // Every column the real query returns, `requested_work_shift_id` included:
    // a fake that returned less would make the day's shift-request fields
    // pass here and be null in production.
    getApprovalStateByDate: async (id, from, to) =>
      store.requests
        .filter((r) => r.requested_for_employee_id === id && r.attendance_date >= from && r.attendance_date <= to)
        .map((r) => ({ ...r, rejection_remarks: null })),
    getEmploymentWindow: async (id) => EMPLOYEES.find((e) => e.employee_id === Number(id)) || null,
    getMonthlyGrossAsOf: async () => null,
    saveCalculations: async (rows) => { saved.calculations.push(rows); return { written: rows.length }; },
    saveCalculationsWithReconciliation: async ({ rows }) => {
      // How a test makes the RECALCULATION fail while the assignment stands.
      if (state.recalculationFails) throw new Error("ER_LOCK_WAIT_TIMEOUT: the recalculation could not be stored");
      saved.calculations.push(rows);
      return { written: rows.length, stale_removed: 0 };
    },
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
    findOpenRequest: async (id, date) =>
      store.requests.find(
        (r) => r.requested_for_employee_id === id && r.attendance_date === date && r.status === "PENDING"
      ) || null,
    createRequest: async ({ request, chain, punch: manual }) => {
      const id = nextId; nextId += 1;
      store.requests.push({
        attendance_approval_request_id: id, ...request, status: "PENDING", current_stage_no: 1,
        total_stages: chain.length, finalization_state: "NOT_REQUIRED", approved_ot_minutes: null,
        closure_reason: null, created_at: "2026-09-19 09:00:00", decided_at: null,
        // The proposed punch, kept so an APPROVED correction can become an
        // effective punch on the day - as the real regularized-punch table
        // does.
        punch: manual || null,
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
      return {
        ...r,
        steps: store.steps.filter((s) => s.attendance_approval_request_id === r.attendance_approval_request_id),
        regularized_punch: r.punch
          ? { attendance_regularized_punch_id: r.attendance_approval_request_id, punch_time: r.punch.punch_time }
          : null,
      };
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
        overrides.push({
          attendance_date_shift_override_id: overrideId,
          ...args.shiftOverride,
          // The link the authorisation is read through, exactly as the real
          // INSERT writes it.
          attendance_approval_request_id: args.requestId,
          source: "APPROVED_REQUEST",
        });
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
    /*
     * THE REAL CLOSURE, mirrored: a REJECTED OT record per unrequested date
     * carrying the minutes it closed, and every PENDING OT request in the
     * period rejected with the pending closure reason. Idempotent, because
     * the real one skips a date that already has any OT record.
     */
    closeOtAtPayrollLock: async ({ unrequested = [], pending_closure, unrequested_closure, from_date, to_date }) => {
      let closedUnrequested = 0;
      let rejectedPending = 0;

      store.requests
        .filter(
          (r) =>
            r.request_type === "OT" &&
            r.status === "PENDING" &&
            r.attendance_date >= from_date &&
            r.attendance_date <= to_date
        )
        .forEach((r) => {
          r.status = "REJECTED";
          r.closure_reason = pending_closure.code;
          r.approved_ot_minutes = 0;
          r.finalization_state = "SETTLED";
          r.decided_at = "2026-09-30 10:00:00";
          rejectedPending += 1;
        });

      unrequested.forEach((u) => {
        const already = store.requests.find(
          (r) => r.request_type === "OT" && r.attendance_date === u.attendance_date && r.status !== "CANCELLED"
        );
        if (already) return; // idempotent: a date with any OT record is left alone
        const id = nextId; nextId += 1;
        store.requests.push({
          attendance_approval_request_id: id,
          request_type: "OT",
          requested_for_employee_id: EMPLOYEE,
          requested_by_employee_id: EMPLOYEE,
          attendance_date: u.attendance_date,
          outlet_id: u.outlet_id,
          requester_class: u.requester_class,
          reason: unrequested_closure.label,
          // THE MINUTES IT CLOSED - the excess, not the whole candidate.
          candidate_ot_minutes: u.candidate_ot_minutes,
          approved_ot_minutes: 0,
          auto_created: 1,
          status: "REJECTED",
          closure_reason: unrequested_closure.code,
          current_stage_no: 1,
          total_stages: 1,
          finalization_state: "SETTLED",
          created_at: "2026-09-30 10:00:00",
          decided_at: "2026-09-30 10:00:00",
        });
        closedUnrequested += 1;
      });

      return { rejected_pending: rejectedPending, closed_unrequested: closedUnrequested };
    },
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
    /*
     * THE REAL TRANSACTION, MIRRORED - and it has to be, because everything
     * the review found lives inside it: the lock is taken AFTER the
     * pre-flight and at write time, the affected range stops where a later
     * assignment takes over, and `default_work_shift_id` is the RESOLVER's
     * answer for today rather than the shift just inserted.
     *
     * `state.lockBeforeWrite` is how a test makes the month close in the gap
     * the pre-flight cannot cover.
     */
    changeAssignment: async ({ employeeId, workShiftId, effectiveFrom, note, createdBy, today: writeToday }) => {
      const before = assignments[employeeId] || [];

      if (state.lockBeforeWrite) lockedMonths.add(state.lockBeforeWrite);

      const affected = affectedRangeForNewAssignment({
        assignments: before,
        effectiveFrom,
        today: writeToday,
      });
      if (affected) {
        const probes = monthProbesForRange({ employeeId, from: affected.from, to: affected.to });
        saved.lockProbes.push(probes.map((p) => p.attendance_date));
        const hit = probes
          .map((p) => ({ employee_id: employeeId, year: Number(p.attendance_date.slice(0, 4)), month: Number(p.attendance_date.slice(5, 7)) }))
          .filter((p) => lockedMonths.has(`${p.year}-${p.month}`));
        if (hit.length > 0) throw payrollLockedError(hit);
      }

      const id = nextAssignmentId; nextAssignmentId += 1;
      const row = { employee_work_shift_assignment_id: id, employee_id: employeeId, work_shift_id: workShiftId, effective_from: effectiveFrom, source: "SHIFT_CHANGE", note, created_by: createdBy, created_at: "2026-09-19 11:00:00" };
      assignments[employeeId] = [...before, row];

      const current = resolveAssignmentForDate(assignments[employeeId], writeToday);
      const currentShiftId = current ? Number(current.work_shift_id) : null;
      if (currentShiftId !== null) saved.defaultShiftWrites.push({ employeeId, workShiftId: currentShiftId });

      return {
        code: 200, employee_work_shift_assignment_id: id, employee_id: employeeId,
        work_shift_id: workShiftId, effective_from: effectiveFrom, source: "SHIFT_CHANGE",
        current_work_shift_id: currentShiftId,
        affected_from: affected ? affected.from : null,
        affected_to: affected ? affected.to : null,
      };
    },
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

  // `state` is returned so a test can make punches ARRIVE after an approval -
  // the fake reads it on every call, exactly as the database would.
  return { calculation, regularization, workShift, shiftTelegram, telegramCalls, store, saved, overrides, assignments, state };
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

  it("a FUTURE effective date is REFUSED, because nothing in this system would activate it", async () => {
    /*
     * The dated history would resolve a future date correctly. The column
     * every current-state consumer reads - `new_employee.default_work_shift_id`
     * - would not: no job, no trigger and no scheduled reconciliation moves
     * it on a date, so a future-dated change would be right in the history
     * and wrong in the column from the day it took effect. The feature
     * refuses what it cannot honour.
     */
    const world = build();
    await assert.rejects(
      () => world.workShift.changeAssignment({
        employee_id: EMPLOYEE, work_shift_id: LONG, effective_from: "2026-10-01",
        reason: "From next month", actor_employee_id: 7, today: TODAY,
      }),
      /effective_from cannot be in the future/
    );

    const history = await world.workShift.assignmentHistory(EMPLOYEE, { today: TODAY });
    assert.equal(history.data.length, 1, "nothing was appended");
    assert.deepEqual(world.saved.defaultShiftWrites, [], "and no current shift was written");
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

  it("the lock is checked for every month the change ACTUALLY moves - and not for months a later assignment already governs", async () => {
    /*
     * 20 Aug inserted into a history that already says 01 Sep moves 20-31
     * August and nothing else: every September date still resolves through
     * the September row. Locking September would refuse a change that was
     * never going to reach it.
     */
    const world = build({
      lockedMonths: ["2026-9"],
      assignments: {
        [EMPLOYEE]: [
          { employee_work_shift_assignment_id: 1, employee_id: EMPLOYEE, work_shift_id: EVE, effective_from: "2026-08-01", source: "MIGRATION_BACKFILL", note: null, created_by: null, created_at: "2026-08-01 10:00:00" },
          { employee_work_shift_assignment_id: 2, employee_id: EMPLOYEE, work_shift_id: EVE, effective_from: "2026-09-01", source: "ASSIGNMENT", note: null, created_by: null, created_at: "2026-09-01 10:00:00" },
        ],
      },
    });

    const result = await world.workShift.changeAssignment({
      employee_id: EMPLOYEE, work_shift_id: LONG, effective_from: "2026-08-20",
      reason: "August cover, September already reassigned", actor_employee_id: 7, today: TODAY,
    });
    assert.equal(result.code, 200, "a locked September does not refuse an August-only change");
    assert.deepEqual(
      { from: result.affected_from, to: result.affected_to },
      { from: "2026-08-20", to: "2026-08-31" },
      "the range stops the day before the next assignment"
    );
    assert.deepEqual(world.saved.lockProbes, [["2026-08-01"]], "September was never probed");
  });

  it("but a change that DOES span into a locked month is refused", async () => {
    // The same August date with NO later assignment behind it: the range now
    // runs 20 Aug to today, which reaches into the locked September.
    const world = build({
      lockedMonths: ["2026-9"],
      assignments: {
        [EMPLOYEE]: [
          { employee_work_shift_assignment_id: 1, employee_id: EMPLOYEE, work_shift_id: EVE, effective_from: "2026-08-01", source: "MIGRATION_BACKFILL", note: null, created_by: null, created_at: "2026-08-01 10:00:00" },
        ],
      },
    });
    await assert.rejects(
      () => world.workShift.changeAssignment({
        employee_id: EMPLOYEE, work_shift_id: LONG, effective_from: "2026-08-20",
        reason: "Backdating across a locked month", actor_employee_id: 7, today: TODAY,
      }),
      (err) => err.code === "PAYROLL_MONTH_LOCKED"
    );
  });

  /* ========================= the write-time boundary, not the pre-flight == */

  it("THE RACE: the month closes between the pre-flight and the write, and the write refuses it", async () => {
    /*
     * The pre-flight holds no lock, so it can only ever be a courtesy. This
     * test makes the month close in exactly the window it cannot cover - the
     * fake locks it after the pre-flight has answered and before the insert,
     * which is what `assertMonthsNotPayrollLocked`'s `FOR UPDATE` on the
     * payrun rows exists to serialize in production.
     *
     * NOTHING may be written.
     */
    const world = build({ lockBeforeWrite: "2026-9" });

    await assert.rejects(
      () => world.workShift.changeAssignment({
        employee_id: EMPLOYEE, work_shift_id: LONG, effective_from: "2026-09-10",
        reason: "Racing a payroll lock", actor_employee_id: 7, today: TODAY,
      }),
      (err) => {
        assert.equal(err.code, "PAYROLL_MONTH_LOCKED", "refused by the WRITE, after the pre-flight passed");
        return true;
      }
    );

    const history = await world.workShift.assignmentHistory(EMPLOYEE, { today: TODAY });
    assert.equal(history.data.length, 1, "no assignment row was inserted");
    assert.deepEqual(world.saved.defaultShiftWrites, [], "and no current shift was written");
    assert.deepEqual(world.saved.calculations, [], "and nothing was recalculated");
  });

  /* ================== the current shift is resolved, never assumed ======== */

  it("a BACKDATED change behind a later assignment leaves the CURRENT shift alone", async () => {
    /*
     *   01 Sep  A          insert 05 Sep = C, today 19 Sep
     *   15 Sep  B
     *
     * Correct resolution: 01-04 A, 05-14 C, 15 onward B. The employee is
     * still on B today, so `default_work_shift_id` must stay B - stamping
     * the shift just inserted would make the column disagree with every
     * date it claims to describe.
     */
    const world = build({
      assignments: {
        [EMPLOYEE]: [
          { employee_work_shift_assignment_id: 1, employee_id: EMPLOYEE, work_shift_id: EVE, effective_from: "2026-09-01", source: "MIGRATION_BACKFILL", note: null, created_by: null, created_at: "2026-09-01 10:00:00" },
          { employee_work_shift_assignment_id: 2, employee_id: EMPLOYEE, work_shift_id: SAME, effective_from: "2026-09-15", source: "ASSIGNMENT", note: null, created_by: null, created_at: "2026-09-15 10:00:00" },
        ],
      },
    });

    const result = await world.workShift.changeAssignment({
      employee_id: EMPLOYEE, work_shift_id: LONG, effective_from: "2026-09-05",
      reason: "Covered the long shift that fortnight", actor_employee_id: 7, today: TODAY,
    });

    assert.equal(result.current_work_shift_id, SAME, "the later assignment still governs today");
    assert.deepEqual(world.saved.defaultShiftWrites, [{ employeeId: EMPLOYEE, workShiftId: SAME }]);
    assert.notEqual(result.current_work_shift_id, LONG, "NOT the shift just inserted");

    // And the history resolves exactly as stated.
    const history = await world.workShift.assignmentHistory(EMPLOYEE, { today: TODAY });
    const current = history.data.find((r) => r.is_current);
    assert.equal(current.work_shift_id, SAME);
    assert.equal(current.effective_from, "2026-09-15");
  });

  it("an ORDINARY change with nothing later does move the current shift", async () => {
    const world = build({
      assignments: {
        [EMPLOYEE]: [
          { employee_work_shift_assignment_id: 1, employee_id: EMPLOYEE, work_shift_id: EVE, effective_from: "2026-09-01", source: "MIGRATION_BACKFILL", note: null, created_by: null, created_at: "2026-09-01 10:00:00" },
        ],
      },
    });

    const result = await world.workShift.changeAssignment({
      employee_id: EMPLOYEE, work_shift_id: LONG, effective_from: "2026-09-10",
      reason: "Moved to the long shift", actor_employee_id: 7, today: TODAY,
    });

    assert.equal(result.current_work_shift_id, LONG);
    assert.deepEqual(world.saved.defaultShiftWrites, [{ employeeId: EMPLOYEE, workShiftId: LONG }]);
    assert.deepEqual(
      { from: result.affected_from, to: result.affected_to },
      { from: "2026-09-10", to: TODAY }
    );
  });

  /* ================ a failed recalculation is not a success ============== */

  it("a RECALCULATION FAILURE is reported as a partial failure, never as a completed save", async () => {
    const world = build({ recalculationFails: true, rawPunches: [punch(1, EMPLOYEE, "2026-09-12 18:00:00"), punch(2, EMPLOYEE, "2026-09-12 22:00:00")] });

    const result = await world.workShift.changeAssignment({
      employee_id: EMPLOYEE, work_shift_id: LONG, effective_from: "2026-09-10",
      reason: "Moved to the long shift", actor_employee_id: 7, today: TODAY,
    });

    assert.notEqual(result.code, 200, "a screen checking code === 200 must NOT see a success");
    assert.equal(result.code, 207);
    assert.equal(result.partial, true);
    assert.equal(result.recalculation_failed, true);
    assert.equal(result.recalculated, null);
    assert.ok(result.recalculation_error, "the reason travels with it");
    // The words matter: nothing may claim the attendance was recalculated.
    assert.match(result.msg, /SAVED/);
    assert.match(result.msg, /could NOT be recalculated/);
    assert.ok(!/has been recalculated/.test(result.msg));
    // And the caller is handed the exact range to retry.
    assert.deepEqual(result.recalculation_range, { from: "2026-09-10", to: TODAY });

    // The assignment itself IS committed - the history is correct, and it is
    // the attendance behind it that is stale.
    const history = await world.workShift.assignmentHistory(EMPLOYEE, { today: TODAY });
    assert.equal(history.data.length, 2);
    assert.equal(history.data[0].effective_from, "2026-09-10");
  });

  it("a successful change says so, and carries the range it re-ran", async () => {
    const world = build();
    const result = await world.workShift.changeAssignment({
      employee_id: EMPLOYEE, work_shift_id: LONG, effective_from: "2026-09-10",
      reason: "Moved to the long shift", actor_employee_id: 7, today: TODAY,
    });
    assert.equal(result.code, 200);
    assert.equal(result.partial, false);
    assert.equal(result.recalculation_failed, false);
    assert.ok(result.recalculated);
    assert.match(result.msg, /has been recalculated/);
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

/* ============ the recovery path, inside the change's own authority ====== */

describe("A. re-running the recalculation a shift change could not finish", () => {
  it("re-runs the exact employee and range, through the same calculation usecase", async () => {
    const world = build({ rawPunches: [punch(1, EMPLOYEE, "2026-09-12 18:00:00"), punch(2, EMPLOYEE, "2026-09-12 22:00:00")] });

    const result = await world.workShift.recalculateAfterChange({
      employee_id: EMPLOYEE, from_date: "2026-09-10", to_date: "2026-09-15", today: TODAY,
    });

    assert.equal(result.code, 200);
    assert.equal(result.employee_id, EMPLOYEE);
    assert.deepEqual([result.from_date, result.to_date], ["2026-09-10", "2026-09-15"]);
    assert.ok(result.recalculated, "the calculation usecase actually ran");
    assert.match(result.msg, /has been recalculated/);
  });

  it("refuses a LOCKED payroll range - the recovery never reopens a settled month", async () => {
    const world = build({ lockedMonths: ["2026-9"] });
    await assert.rejects(
      () => world.workShift.recalculateAfterChange({
        employee_id: EMPLOYEE, from_date: "2026-09-10", to_date: "2026-09-15", today: TODAY,
      }),
      (err) => {
        assert.equal(err.code, "PAYROLL_MONTH_LOCKED");
        return true;
      }
    );
    assert.deepEqual(world.saved.calculations, [], "nothing was written");
  });

  it("refuses a range this employee's own history does not cover", async () => {
    const world = build();
    // Their first dated assignment is 01 Sep.
    await assert.rejects(
      () => world.workShift.recalculateAfterChange({
        employee_id: EMPLOYEE, from_date: "2026-08-01", to_date: "2026-09-15", today: TODAY,
      }),
      /before this employee's first shift assignment/
    );
    await assert.rejects(
      () => world.workShift.recalculateAfterChange({
        employee_id: EMPLOYEE, from_date: "2026-09-10", to_date: "2026-12-31", today: TODAY,
      }),
      /to_date cannot be in the future/
    );
    assert.deepEqual(world.saved.calculations, []);
  });

  it("names ONE employee and has no parameter that could widen it", async () => {
    const world = build();
    await assert.rejects(
      () => world.workShift.recalculateAfterChange({ from_date: "2026-09-10", to_date: "2026-09-15", today: TODAY }),
      /employee_id is required/
    );
    const unknown = await world.workShift.recalculateAfterChange({
      employee_id: 999, from_date: "2026-09-10", to_date: "2026-09-15", today: TODAY,
    });
    assert.equal(unknown.code, 422);
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

  /**
   * ============ THE DROPDOWN AND THE SUBMIT PATH SHARE ONE PREDICATE ========
   *
   * `shiftChangeOptions` used to carry its own copy of "is this shift longer
   * than mine". It agreed with `raiseShiftChangeRequest` only for as long as
   * nobody edited one of them: a dropdown offering a shift the submit path
   * then refuses sends an employee round a loop they cannot escape, and one
   * hiding a shift the submit path would have accepted silently denies them a
   * regularisation they were entitled to.
   *
   * Both now call `utils/shift_change_eligibility.js#hasLongerShiftOption`.
   * These three tests hold that: the offered set IS what the helper decides,
   * everything offered is actually accepted, and when nothing is longer both
   * paths say so.
   */
  it("the options are DERIVED from the shared helper, not from a predicate of their own", async () => {
    const world = build();
    const { options, base } = await world.regularization.shiftChangeOptions({
      actor: self(EMPLOYEE), attendance_date: DATE,
    });

    // The expected set is computed by asking the SHARED HELPER about each
    // shift in the master - so this asserts agreement with the helper rather
    // than restating an answer, and it moves if the helper ever moves.
    const expected = Object.keys(SHIFTS)
      .map(Number)
      .filter((id) => id !== Number(base.work_shift_id))
      .filter((id) =>
        shiftChangeEligibility.hasLongerShiftOption({
          base_nrm_minutes: base.nrm_minutes,
          candidates: [{ is_working_day: true, nrm_minutes: nrmOf(id) }],
        })
      )
      .sort((a, b) => a - b);

    assert.deepEqual(options.map((o) => o.work_shift_id).sort((a, b) => a - b), expected);
    assert.ok(expected.length > 0, "the fixture must offer at least one longer shift");

    // ...and the RESPONSE SHAPE is unchanged by the refactor.
    options.forEach((o) => {
      assert.deepEqual(
        Object.keys(o).sort(),
        ["in_time", "nrm_minutes", "out_time", "shift_code", "shift_name", "work_shift_id"]
      );
    });
  });

  it("every shift the dropdown offers is ACCEPTED by the authoritative submit path", async () => {
    const { options } = await build().regularization.shiftChangeOptions({
      actor: self(EMPLOYEE), attendance_date: DATE,
    });
    assert.ok(options.length > 0);

    for (const option of options) {
      // A fresh world per submission: one open request per employee per date
      // is the rule, so a second submit would be refused for that reason and
      // would prove nothing about the predicate.
      const world = build();
      /* eslint-disable no-await-in-loop */
      const created = await world.regularization.raiseShiftChangeRequest({
        actor: self(EMPLOYEE), attendance_date: DATE, work_shift_id: option.work_shift_id,
        reason: "Covering the late delivery", today: TODAY,
      });
      /* eslint-enable no-await-in-loop */
      assert.equal(created.requested_work_shift_id, option.work_shift_id);
      assert.equal(created.requested_nrm_minutes, option.nrm_minutes);
      assert.equal(world.store.requests.length, 1);
    }
  });

  it("when NO longer shift exists, the dropdown and the submit path agree", async () => {
    // The employee is already on the longest shift in the master.
    const onTheLongest = {
      assignments: {
        [EMPLOYEE]: [
          { employee_work_shift_assignment_id: 1, employee_id: EMPLOYEE, work_shift_id: LONG, effective_from: "2026-09-01", source: "MIGRATION_BACKFILL", note: null, created_by: null, created_at: "2026-09-01 10:00:00" },
        ],
      },
    };

    const { options, base } = await build(onTheLongest).regularization.shiftChangeOptions({
      actor: self(EMPLOYEE), attendance_date: DATE,
    });
    assert.equal(base.work_shift_id, LONG);
    assert.deepEqual(options, [], "nothing may be offered when nothing is longer");

    // And the submit path refuses every one of them, with the shared sentence.
    for (const id of Object.keys(SHIFTS).map(Number).filter((id) => id !== LONG)) {
      const world = build(onTheLongest);
      /* eslint-disable no-await-in-loop */
      await assert.rejects(
        () => world.regularization.raiseShiftChangeRequest({
          actor: self(EMPLOYEE), attendance_date: DATE, work_shift_id: id,
          reason: "Asking for one the screen did not offer", today: TODAY,
        }),
        /longer working hours than your normal shift/
      );
      /* eslint-enable no-await-in-loop */
      assert.equal(world.store.requests.length, 0);
    }
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

/* ========================== the three request types do not blur into one == */

describe("a pending shift request is not a correction, and does not hold the day open", () => {
  const DATE = "2026-09-18";
  const DAY = [
    punch(1, EMPLOYEE, `${DATE} 18:00:00`),
    punch(2, EMPLOYEE, `${DATE} 22:00:00`),
  ];

  /*
   * INTEGRATION REGRESSION. The per-date request slots were "OT, or else a
   * correction", so a SHIFT_CHANGE request landed in the correction slot -
   * which would have marked the date REGULARIZATION_PENDING while a shift
   * request sat in the queue (holding it out of payroll for a day with
   * nothing wrong with it) and reported that request to the employee as a
   * correction, with its reason, on the Corrections tab.
   */
  it("the day stays FINAL, on the employee's ordinary shift, with no correction against it", async () => {
    const world = build({ rawPunches: DAY });

    const [before] = await world.calculation.calculateRange({
      employee_id: EMPLOYEE, from_date: DATE, to_date: DATE,
    });
    assert.equal(before.status, "FINAL");

    await world.regularization.raiseShiftChangeRequest({
      actor: self(EMPLOYEE), attendance_date: DATE, work_shift_id: LONG,
      reason: "Covering the full day", today: TODAY,
    });

    const [during] = await world.calculation.calculateRange({
      employee_id: EMPLOYEE, from_date: DATE, to_date: DATE,
    });
    assert.equal(during.status, "FINAL", "a pending shift request holds nothing open");
    assert.equal(during.is_final, true);
    assert.equal(during.work_shift_id, EVE, "and moves no shift");
    // The correction slot is the OTHER request type's, and stays empty.
    assert.equal(during.correction_state, "NONE");
    assert.equal(during.correction_request_id, null);
    assert.equal(during.correction_reason, null);
    // The shift request reports itself, in its own fields.
    assert.equal(during.shift_change_state, "PENDING");
    assert.equal(during.shift_change_requested_work_shift_id, LONG);
    assert.equal(during.shift_change_reason, "Covering the full day");
  });

  it("and the OT slot is untouched, so the date's OT claim is still its own", async () => {
    const world = build({ rawPunches: DAY });
    await world.regularization.raiseShiftChangeRequest({
      actor: self(EMPLOYEE), attendance_date: DATE, work_shift_id: LONG,
      reason: "Covering the full day", today: TODAY,
    });
    const [day] = await world.calculation.calculateRange({
      employee_id: EMPLOYEE, from_date: DATE, to_date: DATE,
    });
    assert.equal(day.ot_request_id, null);
    assert.notEqual(day.ot_claim_state, "PENDING");
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

/* ========== an approved shift change IS the OT authorisation for its date == */

describe("B. OT authorised by an approved one-day shift change", () => {
  const DATE = "2026-09-18";

  /** Punches inside the approved 10:00-22:00 window, ending at `out`. */
  const worked = (out) => [
    punch(1, EMPLOYEE, `${DATE} 10:00:00`),
    punch(2, EMPLOYEE, `${DATE} ${out}`),
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

  const dayOf = async (world) => {
    const [day] = await world.calculation.calculateRange({
      employee_id: EMPLOYEE, from_date: DATE, to_date: DATE,
    });
    return day;
  };

  it("1. approved AFTER the work: 9h worked on a 4h base pays 4 regular and 5 AUTOMATIC OT", async () => {
    // 10:00-20:00 is ten hours of span and nine of work: the approved shift
    // charges an hour's break, which is the point of measuring ACTUAL minutes.
    const world = build({ rawPunches: worked("20:00:00") });
    const { final } = await approveFully(world);
    const day = await dayOf(world);

    assert.equal(day.worked_minutes, 540);
    assert.equal(day.regular_minutes, 240, "MIN(worked, base NRM)");
    assert.equal(day.shift_authorised_ot_minutes, 300, "MAX(0, worked - base NRM), inside the approved window");
    assert.equal(day.approved_ot_minutes, 300, "and it is APPROVED, with no OT request anywhere");
    assert.equal(day.shortage_minutes, 0);
    assert.equal(day.approved_ot_source, "SHIFT_CHANGE");
    assert.equal(day.ot_claim_state, "APPROVED_VIA_SHIFT_CHANGE");
    assert.equal(day.ot_request_id, null, "no OT request was created");
    assert.ok(final.attendance_date_shift_override_id, "the override carries the authorisation");
  });

  it("2. approved BEFORE the work: 0 now, and derived automatically once the punches arrive", async () => {
    // No punches at all when the request is approved.
    const world = build({ rawPunches: [] });
    await approveFully(world);

    const before = await dayOf(world);
    assert.equal(before.shift_authorised_ot_minutes, 0, "nothing is worked, so nothing is authorised yet");
    assert.equal(before.approved_ot_minutes, 0);

    // The employee works the date. Nothing re-approves anything; the same
    // stored override is read again and the figure is derived from the
    // actual minutes.
    world.state.rawPunches = worked("20:00:00");
    const after = await dayOf(world);
    assert.equal(after.shift_authorised_ot_minutes, 300);
    assert.equal(after.approved_ot_minutes, 300);
    assert.equal(after.ot_claim_state, "APPROVED_VIA_SHIFT_CHANGE");
  });

  it("3./4./5. the authorised figure follows the ACTUAL minutes", async () => {
    for (const [out, expected] of [
      // worked 7h, 4h and 3h respectively, after the approved shift's break.
      ["18:00:00", { regular: 240, ot: 180, shortage: 0 }],
      ["14:00:00", { regular: 240, ot: 0, shortage: 0 }],
      ["13:00:00", { regular: 180, ot: 0, shortage: 60 }],
    ]) {
      /* eslint-disable no-await-in-loop */
      const world = build({ rawPunches: worked(out) });
      await approveFully(world);
      const day = await dayOf(world);
      /* eslint-enable no-await-in-loop */
      assert.equal(day.regular_minutes, expected.regular, `regular for ${out}`);
      assert.equal(day.shift_authorised_ot_minutes, expected.ot, `authorised OT for ${out}`);
      assert.equal(day.approved_ot_minutes, expected.ot, `approved OT for ${out}`);
      assert.equal(day.shortage_minutes, expected.shortage, `shortage for ${out}`);
    }
  });

  it("6. a PENDING shift change authorises nothing", async () => {
    const world = build({ rawPunches: worked("19:00:00") });
    await world.regularization.raiseShiftChangeRequest({
      actor: self(EMPLOYEE), attendance_date: DATE, work_shift_id: LONG,
      reason: "Covering the full day", today: TODAY,
    });
    const day = await dayOf(world);
    assert.equal(day.shift_authorised_ot_minutes, 0);
    assert.equal(day.approved_ot_minutes, 0);
    assert.equal(day.work_shift_id, EVE, "and the shift has not moved either");
  });

  it("6b. an INTERMEDIATE approval authorises nothing", async () => {
    const world = build({ rawPunches: worked("19:00:00") });
    const raised = await world.regularization.raiseShiftChangeRequest({
      actor: self(EMPLOYEE), attendance_date: DATE, work_shift_id: LONG,
      reason: "Covering the full day", today: TODAY,
    });
    const first = await world.regularization.decide({
      actor: approver(7), request_id: raised.attendance_approval_request_id, decision: STEP_DECISION.APPROVED,
    });
    assert.equal(first.status, REQUEST_STATUS.PENDING, "there is a stage left");
    const day = await dayOf(world);
    assert.equal(day.shift_authorised_ot_minutes, 0);
    assert.equal(day.approved_ot_minutes, 0);
  });

  it("7. a REJECTED shift change authorises nothing", async () => {
    const world = build({ rawPunches: worked("19:00:00") });
    const raised = await world.regularization.raiseShiftChangeRequest({
      actor: self(EMPLOYEE), attendance_date: DATE, work_shift_id: LONG,
      reason: "Covering the full day", today: TODAY,
    });
    await world.regularization.decide({
      actor: approver(7), request_id: raised.attendance_approval_request_id,
      decision: STEP_DECISION.REJECTED, remarks: "We have cover that day",
    });
    const day = await dayOf(world);
    assert.equal(day.shift_authorised_ot_minutes, 0);
    assert.equal(day.approved_ot_minutes, 0);
    assert.notEqual(day.ot_claim_state, "APPROVED_VIA_SHIFT_CHANGE");
  });

  it("8. an ORDINARY day with overtime is unchanged: AVAILABLE, and a request is still required", async () => {
    // No shift change at all - the employee simply worked past their own shift.
    const world = build({
      rawPunches: [punch(1, EMPLOYEE, `${DATE} 18:00:00`), punch(2, EMPLOYEE, `${DATE} 23:30:00`)],
    });
    const day = await dayOf(world);
    assert.ok(day.candidate_ot_minutes > 0);
    assert.equal(day.shift_authorised_ot_minutes, 0, "nobody authorised anything");
    assert.equal(day.approved_ot_minutes, 0);
    assert.equal(day.ot_claim_state, "AVAILABLE", "the ordinary path, unchanged");
    assert.equal(day.ot_claimable_minutes, day.candidate_ot_minutes);
  });

  it("9. a MANAGEMENT date-shift override is not an employee authorisation", async () => {
    const world = build({ rawPunches: worked("19:00:00") });
    await world.calculation.setDateShift({
      employee_id: EMPLOYEE, attendance_date: DATE, work_shift_id: LONG, actor_employee_id: 7,
    });
    const day = await dayOf(world);
    assert.equal(day.work_shift_id, LONG, "the shift did move");
    assert.equal(day.shift_authorised_ot_minutes, 0, "but nobody agreed with the EMPLOYEE to work longer");
    assert.equal(day.ot_claim_state, "AVAILABLE", "so the OT keeps the ordinary request path");
  });

  it("10./11. a later punch correction moves the authorised OT in BOTH directions", async () => {
    const world = build({ rawPunches: worked("18:00:00") });
    await approveFully(world);
    assert.equal((await dayOf(world)).shift_authorised_ot_minutes, 180, "7h worked");

    // More minutes: a correction adds an hour.
    world.state.rawPunches = worked("19:00:00");
    assert.equal((await dayOf(world)).shift_authorised_ot_minutes, 240, "8h worked - it rose");

    // Fewer minutes: a correction takes two away.
    world.state.rawPunches = worked("16:00:00");
    assert.equal((await dayOf(world)).shift_authorised_ot_minutes, 60, "6h worked - it fell");

    // And below the base NRM there is none at all.
    world.state.rawPunches = worked("13:00:00");
    const short = await dayOf(world);
    assert.equal(short.shift_authorised_ot_minutes, 0);
    assert.equal(short.shortage_minutes, 60);
  });

  it("12. a payroll-locked date cannot have its shift-authorised OT rewritten", async () => {
    const world = build({ rawPunches: worked("19:00:00"), lockedMonths: ["2026-9"] });
    // The approval itself is refused while the month is locked...
    const raised = await world.regularization.raiseShiftChangeRequest({
      actor: self(EMPLOYEE), attendance_date: DATE, work_shift_id: LONG,
      reason: "Covering the full day", today: TODAY,
    }).catch((err) => err);
    assert.equal(raised.code, "PAYROLL_MONTH_LOCKED", "and the request cannot even be filed");
    assert.deepEqual(world.saved.overrides, [], "so no override, and no authorisation");
  });

  it("15./16. OT outside the approved window stays claimable, and cannot be paid twice", async () => {
    // In at 08:00 (two hours before the approved shift) and out at 23:30
    // (ninety minutes after it).
    const world = build({
      rawPunches: [punch(1, EMPLOYEE, `${DATE} 08:00:00`), punch(2, EMPLOYEE, `${DATE} 23:30:00`)],
    });
    await approveFully(world);
    const day = await dayOf(world);

    assert.ok(day.candidate_ot_minutes > 0);
    assert.equal(
      day.shift_authorised_ot_minutes + day.excess_ot_minutes,
      day.candidate_ot_minutes,
      "the two halves are exactly the candidate - no minute is in both, and none is lost"
    );
    assert.ok(day.excess_ot_minutes > 0, "the time outside the approved shift is NOT automatic");
    assert.equal(day.ot_claimable_minutes, day.excess_ot_minutes, "and only that is offered");

    // An OT request on this date may claim the EXCESS only.
    const ot = await world.regularization.raiseOtRequest({
      actor: self(EMPLOYEE), attendance_date: DATE, reason: "Stayed past the approved shift", today: TODAY,
    });
    assert.equal(ot.candidate_ot_minutes, day.excess_ot_minutes, "the claim is the excess, not the whole day");

    const id = ot.attendance_approval_request_id;
    await world.regularization.decide({ actor: approver(7), request_id: id, decision: STEP_DECISION.APPROVED });
    await world.regularization.decide({ actor: approver(8), request_id: id, decision: STEP_DECISION.APPROVED });

    const paid = await dayOf(world);
    assert.equal(
      paid.approved_ot_minutes,
      day.shift_authorised_ot_minutes + day.excess_ot_minutes,
      "authorised + approved excess"
    );
    assert.equal(paid.approved_ot_minutes, paid.candidate_ot_minutes, "and never more than the day earned");
  });

  it("16b. an OT request cannot be raised for a date the shift change fully authorises", async () => {
    const world = build({ rawPunches: worked("20:00:00") });
    await approveFully(world);
    await assert.rejects(
      () => world.regularization.raiseOtRequest({
        actor: self(EMPLOYEE), attendance_date: DATE, reason: "Asking for it again", today: TODAY,
      }),
      /already authorises its 300 overtime minute\(s\)/
    );
  });

  it("14. the approval centre grows no duplicate OT row - the approval lives under Shift", async () => {
    const world = build({ rawPunches: worked("19:00:00") });
    await approveFully(world);

    const ot = await world.regularization.listApprovals({
      actor: approver(7), request_type: REQUEST_TYPE.OT, status: "ALL",
    });
    assert.deepEqual(ot.rows, [], "no OT request was fabricated to carry the approval");

    const shift = await world.regularization.listApprovals({
      actor: approver(7), request_type: REQUEST_TYPE.SHIFT_CHANGE, status: "APPROVED",
    });
    assert.equal(shift.rows.length, 1, "the approval is on the Shift tab, where it happened");
    assert.equal(shift.rows[0].status, REQUEST_STATUS.APPROVED);
  });
});

/* ===== the payroll lock closes the EXCESS, and never the authorised part == */

describe("B. payroll lock over a shift-authorised date", () => {
  const DATE = "2026-09-18";
  const MONTH = { from_date: "2026-09-01", to_date: "2026-09-30" };

  /** In at 08:00 and out at 23:30: inside AND outside the approved 10-22. */
  const OUTSIDE = [
    punch(1, EMPLOYEE, `${DATE} 08:00:00`),
    punch(2, EMPLOYEE, `${DATE} 23:30:00`),
  ];
  /** Wholly inside the approved shift: nine hours worked, no excess. */
  const INSIDE = [
    punch(1, EMPLOYEE, `${DATE} 10:00:00`),
    punch(2, EMPLOYEE, `${DATE} 20:00:00`),
  ];

  const approveFully = async (world) => {
    const raised = await world.regularization.raiseShiftChangeRequest({
      actor: self(EMPLOYEE), attendance_date: DATE, work_shift_id: LONG,
      reason: "Covering the full day", today: TODAY,
    });
    const id = raised.attendance_approval_request_id;
    await world.regularization.decide({ actor: approver(7), request_id: id, decision: STEP_DECISION.APPROVED });
    await world.regularization.decide({ actor: approver(8), request_id: id, decision: STEP_DECISION.APPROVED });
    return id;
  };

  const dayOf = async (world) => {
    const [day] = await world.calculation.calculateRange({
      employee_id: EMPLOYEE, from_date: DATE, to_date: DATE,
    });
    return day;
  };

  const lock = async (world, days) =>
    world.regularization.closeOtForPayrollLock({
      employee_id: EMPLOYEE, ...MONTH, days, actor_employee_id: 8,
    });

  it("1./2. closes the EXCESS only, and the authorised minutes stay approved and payable", async () => {
    const world = build({ rawPunches: OUTSIDE });
    await approveFully(world);

    const before = await dayOf(world);
    const authorised = before.shift_authorised_ot_minutes;
    const excess = before.excess_ot_minutes;
    assert.ok(authorised > 0 && excess > 0, "the day has both portions");
    assert.equal(before.approved_ot_minutes, authorised);

    const result = await lock(world, [before]);
    assert.equal(result.closed_unrequested, 1, "the unclaimed excess was closed");

    // The closure record carries the EXCESS, never the whole candidate.
    const closure = world.store.requests.find((r) => r.request_type === "OT");
    assert.equal(closure.candidate_ot_minutes, excess);
    assert.equal(closure.closure_reason, "NOT_REQUESTED_BEFORE_PAYROLL_LOCK");
    assert.notEqual(closure.candidate_ot_minutes, before.candidate_ot_minutes);

    // And the approved minutes did not move.
    const after = await dayOf(world);
    assert.equal(after.shift_authorised_ot_minutes, authorised, "still authorised");
    assert.equal(after.approved_ot_minutes, authorised, "still payable");
  });

  it("3. the day still reads as approved via the shift change, with the excess closed beside it", async () => {
    const world = build({ rawPunches: OUTSIDE });
    await approveFully(world);
    await lock(world, [await dayOf(world)]);

    const after = await dayOf(world);
    // NOT "Closed - Payroll Locked" for the whole date: the five hours were
    // approved before the month closed and are not un-approved by it.
    assert.equal(after.ot_claim_state, "APPROVED_VIA_SHIFT_CHANGE");
    assert.equal(after.ot_excess_state, "CLOSED_AT_PAYROLL_LOCK", "and the excess says what became of it");
    assert.ok(after.ot_shift_authorised_minutes > 0);
    // Nothing is claimable any more, so no screen can offer Request OT.
    assert.equal(after.ot_claimable_minutes, after.excess_ot_minutes);
    assert.equal(after.ot_closure_reason, "NOT_REQUESTED_BEFORE_PAYROLL_LOCK");
  });

  it("4. a date with NO excess has nothing closed - no OT record is fabricated", async () => {
    const world = build({ rawPunches: INSIDE });
    await approveFully(world);
    const day = await dayOf(world);
    assert.equal(day.excess_ot_minutes, 0);
    assert.equal(day.shift_authorised_ot_minutes, 300);

    const result = await lock(world, [day]);
    assert.equal(result.closed_unrequested, 0);
    assert.deepEqual(world.store.requests.filter((r) => r.request_type === "OT"), []);
    assert.equal((await dayOf(world)).approved_ot_minutes, 300);
  });

  it("5. a PENDING excess request is closed at the lock; the authorised portion is untouched", async () => {
    const world = build({ rawPunches: OUTSIDE });
    await approveFully(world);
    const before = await dayOf(world);
    const authorised = before.shift_authorised_ot_minutes;

    await world.regularization.raiseOtRequest({
      actor: self(EMPLOYEE), attendance_date: DATE, reason: "Stayed past the approved shift", today: TODAY,
    });
    const pendingDay = await dayOf(world);
    assert.equal(pendingDay.ot_excess_state, "REQUEST_PENDING");
    assert.equal(pendingDay.ot_claim_state, "APPROVED_VIA_SHIFT_CHANGE", "the approved part is not 'pending'");

    const result = await lock(world, [pendingDay]);
    assert.equal(result.rejected_pending, 1);
    assert.equal(result.closed_unrequested, 0, "there was a request, so nothing is filed as unrequested");

    const after = await dayOf(world);
    assert.equal(after.approved_ot_minutes, authorised, "the 300 remain approved");
    assert.equal(after.ot_excess_state, "CLOSED_AT_PAYROLL_LOCK");
    assert.equal(after.ot_claim_state, "APPROVED_VIA_SHIFT_CHANGE", "and the day does not read as rejected");
  });

  it("6. an APPROVED excess survives the lock, and both portions stay payable", async () => {
    const world = build({ rawPunches: OUTSIDE });
    await approveFully(world);
    const before = await dayOf(world);
    const authorised = before.shift_authorised_ot_minutes;
    const excess = before.excess_ot_minutes;

    const ot = await world.regularization.raiseOtRequest({
      actor: self(EMPLOYEE), attendance_date: DATE, reason: "Stayed past the approved shift", today: TODAY,
    });
    const id = ot.attendance_approval_request_id;
    await world.regularization.decide({ actor: approver(7), request_id: id, decision: STEP_DECISION.APPROVED });
    await world.regularization.decide({ actor: approver(8), request_id: id, decision: STEP_DECISION.APPROVED });

    const approvedDay = await dayOf(world);
    assert.equal(approvedDay.approved_ot_minutes, authorised + excess);

    const result = await lock(world, [approvedDay]);
    assert.equal(result.closed_unrequested, 0);
    assert.equal(result.rejected_pending, 0, "an approved claim is not reopened to be closed");

    const after = await dayOf(world);
    assert.equal(after.approved_ot_minutes, authorised + excess, "both portions still payable");
  });

  it("7. an ORDINARY available day is closed exactly as before", async () => {
    // No shift change anywhere: the whole candidate is the claimable figure.
    const world = build({
      rawPunches: [punch(1, EMPLOYEE, `${DATE} 18:00:00`), punch(2, EMPLOYEE, `${DATE} 23:30:00`)],
    });
    const day = await dayOf(world);
    assert.equal(day.ot_claim_state, "AVAILABLE");
    assert.ok(day.candidate_ot_minutes > 0);

    const result = await lock(world, [day]);
    assert.equal(result.closed_unrequested, 1);
    const closure = world.store.requests.find((r) => r.request_type === "OT");
    assert.equal(closure.candidate_ot_minutes, day.candidate_ot_minutes, "the whole candidate, as before");
    assert.equal(closure.closure_reason, "NOT_REQUESTED_BEFORE_PAYROLL_LOCK");
  });

  it("8. running the lock twice closes nothing twice", async () => {
    const world = build({ rawPunches: OUTSIDE });
    await approveFully(world);
    const first = await lock(world, [await dayOf(world)]);
    assert.equal(first.closed_unrequested, 1);

    const second = await lock(world, [await dayOf(world)]);
    assert.equal(second.closed_unrequested, 0, "the date already has an OT record");
    assert.equal(world.store.requests.filter((r) => r.request_type === "OT").length, 1);
  });

  it("9. a closure can never reduce the approved minutes below what the shift change authorised", async () => {
    const world = build({ rawPunches: OUTSIDE });
    await approveFully(world);
    const before = await dayOf(world);
    await lock(world, [before]);
    const after = await dayOf(world);

    assert.ok(after.approved_ot_minutes >= after.shift_authorised_ot_minutes);
    assert.equal(after.approved_ot_minutes, before.shift_authorised_ot_minutes);
  });

  it("10. payroll consumes the authorised minutes plus SETTLED excess, and never the closed excess", async () => {
    const world = build({ rawPunches: OUTSIDE });
    await approveFully(world);
    const before = await dayOf(world);
    await lock(world, [before]);
    const after = await dayOf(world);

    // approved_ot_minutes is what payroll reads. The closed excess is not in it.
    assert.equal(after.approved_ot_minutes, after.shift_authorised_ot_minutes);
    assert.ok(after.excess_ot_minutes > 0, "the excess still exists as a figure");
    assert.ok(
      after.approved_ot_minutes < after.candidate_ot_minutes,
      "and is deliberately NOT paid, because nobody approved it in time"
    );
  });

  it("the summary counts approved days truthfully, whichever approved them", async () => {
    const world = build({ rawPunches: INSIDE });
    await approveFully(world);
    const day = await dayOf(world);
    const result = await lock(world, [day]);

    assert.equal(result.approved_preserved, 1, "a shift-authorised day IS an approved day");
    assert.equal(result.approved_via_shift_change, 1);
    assert.equal(result.approved_via_ot_request, 0);
    assert.equal(result.approved_minutes_preserved, 300);
  });
});

/* ============== the two approved-OT components, and their audit trail === */

describe("B. approved OT decomposes into its two components", () => {
  const DATE = "2026-09-18";

  const INSIDE = [punch(1, EMPLOYEE, `${DATE} 10:00:00`), punch(2, EMPLOYEE, `${DATE} 20:00:00`)];
  const OUTSIDE = [punch(1, EMPLOYEE, `${DATE} 08:00:00`), punch(2, EMPLOYEE, `${DATE} 23:30:00`)];

  const approveShift = async (world) => {
    const raised = await world.regularization.raiseShiftChangeRequest({
      actor: self(EMPLOYEE), attendance_date: DATE, work_shift_id: LONG,
      reason: "Covering the full day", today: TODAY,
    });
    const id = raised.attendance_approval_request_id;
    await world.regularization.decide({ actor: approver(7), request_id: id, decision: STEP_DECISION.APPROVED });
    await world.regularization.decide({ actor: approver(8), request_id: id, decision: STEP_DECISION.APPROVED });
    return id;
  };

  const approveOt = async (world) => {
    const ot = await world.regularization.raiseOtRequest({
      actor: self(EMPLOYEE), attendance_date: DATE, reason: "Stayed past the approved shift", today: TODAY,
    });
    const id = ot.attendance_approval_request_id;
    await world.regularization.decide({ actor: approver(7), request_id: id, decision: STEP_DECISION.APPROVED });
    await world.regularization.decide({ actor: approver(8), request_id: id, decision: STEP_DECISION.APPROVED });
    return id;
  };

  const dayOf = async (world) => {
    const [day] = await world.calculation.calculateRange({
      employee_id: EMPLOYEE, from_date: DATE, to_date: DATE,
    });
    return day;
  };

  /** The row as it is STORED - what a payroll audit actually reads. */
  const storedRow = async (world) => world.calculation.toStorageRow(await dayOf(world));

  const assertInvariant = (day) => {
    assert.ok(day.shift_authorised_ot_minutes >= 0);
    assert.ok(day.ot_request_approved_minutes >= 0);
    assert.equal(
      day.shift_authorised_ot_minutes + day.ot_request_approved_minutes,
      day.approved_ot_minutes,
      "the two components sum to the total"
    );
    assert.ok(day.approved_ot_minutes <= day.candidate_ot_minutes, "and never exceed what was earned");
    assert.ok(
      day.ot_request_approved_minutes <= day.excess_ot_minutes,
      "the request's share never reaches the authorised portion"
    );
  };

  it("1. SHIFT ONLY: the whole total is the shift component, and names the shift request", async () => {
    const world = build({ rawPunches: INSIDE });
    const shiftId = await approveShift(world);
    const day = await dayOf(world);
    const row = await storedRow(world);

    assert.equal(day.approved_ot_minutes, 300);
    assert.equal(day.shift_authorised_ot_minutes, 300);
    assert.equal(day.ot_request_approved_minutes, 0);
    assert.equal(day.approved_ot_source, "SHIFT_CHANGE");
    assertInvariant(day);

    assert.equal(row.shift_authorised_ot_minutes, 300);
    assert.equal(row.shift_authorising_request_id, shiftId);
    assert.equal(row.ot_request_approved_minutes, 0);
    assert.equal(row.ot_request_id, null, "no OT request approved anything, so no id is claimed");
  });

  it("2. OT ONLY: the whole total is the request component, and names the OT request", async () => {
    // No shift change: an ordinary day worked past the employee's own shift.
    const world = build({
      rawPunches: [punch(1, EMPLOYEE, `${DATE} 18:00:00`), punch(2, EMPLOYEE, `${DATE} 23:30:00`)],
    });
    const otId = await approveOt(world);
    const day = await dayOf(world);
    const row = await storedRow(world);

    assert.ok(day.approved_ot_minutes > 0);
    assert.equal(day.shift_authorised_ot_minutes, 0);
    assert.equal(day.ot_request_approved_minutes, day.approved_ot_minutes);
    assert.equal(day.approved_ot_source, "OT_REQUEST");
    assertInvariant(day);

    assert.equal(row.shift_authorised_ot_minutes, 0);
    assert.equal(row.shift_authorising_request_id, null);
    assert.equal(row.ot_request_id, otId);
  });

  it("3./11. MIXED: both components, both request ids, and the source says MIXED", async () => {
    const world = build({ rawPunches: OUTSIDE });
    const shiftId = await approveShift(world);
    const before = await dayOf(world);
    const authorised = before.shift_authorised_ot_minutes;
    const excess = before.excess_ot_minutes;
    assert.ok(authorised > 0 && excess > 0);

    const otId = await approveOt(world);
    const day = await dayOf(world);
    const row = await storedRow(world);

    assert.equal(day.approved_ot_minutes, authorised + excess);
    assert.equal(day.shift_authorised_ot_minutes, authorised);
    assert.equal(day.ot_request_approved_minutes, excess);
    assert.equal(day.approved_ot_source, "MIXED");
    assertInvariant(day);

    // The audit can name BOTH decisions, and they are different requests.
    assert.equal(row.shift_authorising_request_id, shiftId);
    assert.equal(row.ot_request_id, otId);
    assert.notEqual(row.shift_authorising_request_id, row.ot_request_id);
  });

  it("4. a MIXED day carrying an attendance CORRECTION still names the right two requests", async () => {
    /*
     * `approval_request_id` on the stored row prefers the CORRECTION when a
     * date has one, which is why it must never be the OT provenance. This is
     * that exact day: a correction, a shift change and an OT request, all on
     * one date.
     */
    const world = build({
      rawPunches: [punch(1, EMPLOYEE, `${DATE} 08:00:00`), punch(2, EMPLOYEE, `${DATE} 23:30:00`), punch(3, EMPLOYEE, `${DATE} 23:45:00`)],
    });
    // An odd punch count: the date needs a correction, which is filed and approved.
    const correction = await world.regularization.raiseRequest({
      actor: self(EMPLOYEE), requested_for_employee_id: EMPLOYEE, attendance_date: DATE,
      reason: "Terminal missed the last punch", punch_time: `${DATE} 23:50:00`,
    });
    const correctionId = correction.attendance_approval_request_id;
    await world.regularization.decide({ actor: approver(7), request_id: correctionId, decision: STEP_DECISION.APPROVED });
    await world.regularization.decide({ actor: approver(8), request_id: correctionId, decision: STEP_DECISION.APPROVED });

    const shiftId = await approveShift(world);
    const otId = await approveOt(world);

    const row = await storedRow(world);
    assert.equal(row.shift_authorising_request_id, shiftId, "the SHIFT request, not the correction");
    assert.equal(row.ot_request_id, otId, "the OT request, not the correction");
    assert.notEqual(row.shift_authorising_request_id, correctionId);
    assert.notEqual(row.ot_request_id, correctionId);
    assertInvariant(await dayOf(world));
  });

  it("5./6./7. a PENDING, REJECTED or CLOSED excess contributes nothing to the request component", async () => {
    // PENDING
    const pendingWorld = build({ rawPunches: OUTSIDE });
    await approveShift(pendingWorld);
    const authorised = (await dayOf(pendingWorld)).shift_authorised_ot_minutes;
    await pendingWorld.regularization.raiseOtRequest({
      actor: self(EMPLOYEE), attendance_date: DATE, reason: "Stayed past the approved shift", today: TODAY,
    });
    const pending = await dayOf(pendingWorld);
    assert.equal(pending.ot_request_approved_minutes, 0);
    assert.equal(pending.approved_ot_minutes, authorised);
    assert.equal(pending.approved_ot_source, "SHIFT_CHANGE");
    assertInvariant(pending);

    // REJECTED
    const rejectedWorld = build({ rawPunches: OUTSIDE });
    await approveShift(rejectedWorld);
    const rejectedOt = await rejectedWorld.regularization.raiseOtRequest({
      actor: self(EMPLOYEE), attendance_date: DATE, reason: "Stayed past the approved shift", today: TODAY,
    });
    await rejectedWorld.regularization.decide({
      actor: approver(7), request_id: rejectedOt.attendance_approval_request_id,
      decision: STEP_DECISION.REJECTED, remarks: "Not authorised to stay that late",
    });
    const rejected = await dayOf(rejectedWorld);
    assert.equal(rejected.ot_request_approved_minutes, 0);
    assert.equal(rejected.approved_ot_minutes, authorised);
    assertInvariant(rejected);

    // CLOSED at payroll lock
    const closedWorld = build({ rawPunches: OUTSIDE });
    await approveShift(closedWorld);
    await closedWorld.regularization.closeOtForPayrollLock({
      employee_id: EMPLOYEE, from_date: "2026-09-01", to_date: "2026-09-30",
      days: [await dayOf(closedWorld)], actor_employee_id: 8,
    });
    const closed = await dayOf(closedWorld);
    assert.equal(closed.ot_request_approved_minutes, 0);
    assert.equal(closed.approved_ot_minutes, authorised);
    const closedRow = await storedRow(closedWorld);
    assert.equal(closedRow.ot_request_id, null, "a closure approved nothing, so it claims no id");
    assertInvariant(closed);
  });

  it("8./9. a later correction moves the components, and the request's share clamps down", async () => {
    const world = build({ rawPunches: OUTSIDE });
    await approveShift(world);
    const otId = await approveOt(world);

    const before = await dayOf(world);
    assert.equal(before.approved_ot_minutes, before.shift_authorised_ot_minutes + before.ot_request_approved_minutes);
    assert.ok(before.ot_request_approved_minutes > 0);

    // A correction removes the time outside the approved shift entirely, so
    // there is no excess left for the approved request to be paid against.
    world.state.rawPunches = INSIDE;
    const after = await dayOf(world);

    assert.equal(after.excess_ot_minutes, 0, "nothing outside the approved shift any more");
    assert.equal(after.ot_request_approved_minutes, 0, "so the request's share clamps to nothing");
    assert.equal(after.shift_authorised_ot_minutes, 300);
    assert.equal(after.approved_ot_minutes, 300, "and the total follows the ACTUAL minutes");
    assertInvariant(after);

    // The decision still exists; it is the MINUTES that were recalculated.
    const request = world.store.requests.find((r) => r.attendance_approval_request_id === otId);
    assert.equal(request.status, REQUEST_STATUS.APPROVED);
  });

  it("10./12. the invariant holds on every shape of day, and the payroll total is unchanged", async () => {
    for (const [punches, approve] of [
      [INSIDE, ["shift"]],
      [OUTSIDE, ["shift"]],
      [OUTSIDE, ["shift", "ot"]],
      [[punch(1, EMPLOYEE, `${DATE} 18:00:00`), punch(2, EMPLOYEE, `${DATE} 23:30:00`)], ["ot"]],
      [[punch(1, EMPLOYEE, `${DATE} 18:00:00`), punch(2, EMPLOYEE, `${DATE} 22:00:00`)], []],
    ]) {
      /* eslint-disable no-await-in-loop */
      const world = build({ rawPunches: punches });
      if (approve.includes("shift")) await approveShift(world);
      if (approve.includes("ot")) await approveOt(world);
      const day = await dayOf(world);
      const row = await storedRow(world);
      /* eslint-enable no-await-in-loop */

      assertInvariant(day);
      // Payroll reads one number, and it is unchanged by the decomposition.
      assert.equal(row.approved_ot_minutes, day.approved_ot_minutes);
      assert.equal(
        row.shift_authorised_ot_minutes + row.ot_request_approved_minutes,
        row.approved_ot_minutes,
        "the STORED row decomposes exactly too"
      );
    }
  });
});
