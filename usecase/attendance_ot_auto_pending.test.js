/**
 * AUTOMATIC PENDING OT - eligible OT enters approval with no employee
 * request, through the REAL engine, the REAL calculation and regularization
 * usecases and the REAL Telegram OT module, over in-memory fakes.
 *
 *   node --test usecase/attendance_ot_auto_pending.test.js
 *
 *   Employee punches -> attendance engine calculates eligible OT
 *     -> Pending OT approval -> approver approves / rejects
 *     -> only approved OT reaches payroll
 *
 * The numbered describes are the eighteen required proofs; the rest pin the
 * edges (withdrawal, the cutover, the kill switch, stale Telegram figures).
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildCalculation = require("../usecase/attendance_calculation");
const buildRegularization = require("../usecase/attendance_regularization");
const buildOtTelegram = require("../usecase/attendance_ot_telegram");
const backfill = require("../scripts/attendance/ot-auto-pending-backfill");
const { evaluatePayrollReadiness } = require("../utils/payroll_readiness");
const { REQUEST_TYPE, STEP_DECISION, APPROVER_ROLE } = require("../utils/attendance_approval_chain");

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
  // The same hours with SUNDAY as a weekly off.
  9: {
    config: config(9, "LATE-SUNOFF", "Late Shift, Sunday off"),
    schedule: weekly(9, "10:00:00", "22:00:00").map((row) => (row.day_of_week === 0 ? { ...row, is_working_day: 0 } : row)),
  },
};
let punchSeq = 1;
const punch = (employee_id, ioTime) => ({
  punch_id: punchSeq++, employee_id, io_time: ioTime, punch_date: ioTime.slice(0, 10),
  ingest_attendance_date: ioTime.slice(0, 10), dev_id: "DEV1", ingest_source: "DEVICE",
});
/** A complete late day: in at 10:00, out at `out` - 22:00 is the shift end. */
const day = (employee_id, date, out = "23:30:00") => [
  punch(employee_id, `${date} 10:00:00`),
  punch(employee_id, `${date} ${out}`),
];

/**
 * 42, 44: outlet 3 / 5, no approver role -> the ROLE chain SM -> OPS -> HR.
 * 43: outlet 3, an EMPLOYEE-LEVEL chain whose only (final) approver is 7.
 * 7 = Store Manager of 3, 9 = Store Manager of 5, 10 = Operations, 8 = HR.
 */
const EMPLOYEES = [
  { employee_id: 42, employee_name: "Asha", store_id: 3, designation_id: 11, status: 1, date_of_joining: "2020-01-01", resignation_date: null },
  { employee_id: 43, employee_name: "Sathiya Priya", store_id: 3, designation_id: 11, status: 1, date_of_joining: "2020-01-01", resignation_date: null },
  { employee_id: 44, employee_name: "Chitra", store_id: 5, designation_id: 11, status: 1, date_of_joining: "2020-01-01", resignation_date: null },
];
const IDENTITIES = {
  7: { employee_id: 7, employee_name: "Mgr3", outlet_id: 3, outlet_name: "Outlet 3", designation_id: 2, designation_name: "STORE MANAGER", approver_role: APPROVER_ROLE.STORE_MANAGER, requester_class: "MANAGER" },
  8: { employee_id: 8, employee_name: "HR", outlet_id: 1, designation_id: 3, designation_name: "HR EXECUTIVE", approver_role: APPROVER_ROLE.HR, requester_class: "MANAGER" },
  9: { employee_id: 9, employee_name: "Mgr5", outlet_id: 5, designation_id: 2, designation_name: "STORE MANAGER", approver_role: APPROVER_ROLE.STORE_MANAGER, requester_class: "MANAGER" },
  10: { employee_id: 10, employee_name: "Ops", outlet_id: 1, designation_id: 4, designation_name: "OPS", approver_role: APPROVER_ROLE.OPERATIONS_MANAGER, requester_class: "MANAGER" },
};
const ALL_BRANCHES = { kind: "ALL_BRANCHES", store_ids: null };
const actor = (employee_id) => ({ employee_id, user_type: 1, branch_scope: ALL_BRANCHES });
const SM3 = actor(7);
const SM5 = actor(9);
const OPS = actor(10);
const HR = actor(8);

const DATE = "2026-09-14";
const DATE2 = "2026-09-15";
/** Noon IST on the 20th: the 14th..19th are closed, the 20th is still open. */
const NOW = Date.parse("2026-09-20T12:00:00+05:30");

function build(state = {}) {
  const rawPunches = state.rawPunches || [];
  const saved = { calculations: [] };
  const store = { requests: [], steps: [], log: [], settlements: [] };
  const lockedMonths = new Set(state.lockedMonths || []); // "42:2026-9"
  const setting = state.setting === undefined ? { enabled: 1, auto_pending_from_date: "2026-09-01" } : state.setting;
  let nextId = 900;

  const lockHits = (rows) => {
    const hits = [];
    (rows || []).forEach((r) => {
      const key = `${r.employee_id}:${Number(r.attendance_date.slice(0, 4))}-${Number(r.attendance_date.slice(5, 7))}`;
      if (lockedMonths.has(key) && !hits.some((h) => h.key === key)) {
        hits.push({ key, employee_id: r.employee_id, year: Number(r.attendance_date.slice(0, 4)), month: Number(r.attendance_date.slice(5, 7)) });
      }
    });
    return hits;
  };
  const lockedError = () => {
    const err = new Error("payroll month locked");
    err.name = "ValidationError";
    err.code = "PAYROLL_MONTH_LOCKED";
    return err;
  };

  const calcRepo = {
    saved,
    getShiftAssignmentHistory: async (employeeId) => [
      { employee_work_shift_assignment_id: 1, employee_id: employeeId, work_shift_id: (state.shiftOf || {})[employeeId] || 7, effective_from: "2026-08-01", source: "MIGRATION_BACKFILL" },
    ],
    getDateShiftOverrides: async () => [],
    getWorkShiftWithSchedule: async (id) => SHIFTS[id] || null,
    getWorkShiftConfigVersions: async () => [],
    getRawPunchesByCalendarWindow: async (employeeId, from, to) =>
      rawPunches.filter((p) => p.employee_id === employeeId && p.punch_date >= from && p.punch_date <= to),
    getApprovedRegularizedPunches: async (employeeId) =>
      store.requests
        .filter((r) => r.requested_for_employee_id === employeeId && r.status === "APPROVED" && r.punch)
        .map((r) => ({ employee_id: employeeId, attendance_date: r.attendance_date, punch_id: `R${r.attendance_approval_request_id}`, io_time: r.punch.punch_time, attendance_approval_request_id: r.attendance_approval_request_id })),
    getBreakOverride: async () => null,
    getApprovalStateByDate: async (employeeId, from, to) =>
      store.requests
        .filter(
          (r) => r.requested_for_employee_id === employeeId && r.status !== "CANCELLED" && r.attendance_date >= from && r.attendance_date <= to
        )
        .map((r) => {
          // As the repository's correlated read: the request's prior-month settlement.
          const ls = store.settlements.find((x) => x.attendance_approval_request_id === r.attendance_approval_request_id && x.settlement_status !== "CANCELLED");
          return ls
            ? { ...r, late_settlement_status: ls.settlement_status, late_settlement_year: ls.settlement_year, late_settlement_month: ls.settlement_month, late_settlement_minutes: ls.approved_ot_minutes }
            : r;
        }),
    getEmploymentWindow: async (id) => EMPLOYEES.find((e) => e.employee_id === Number(id)) || null,
    getMonthlyGrossAsOf: async () => null,
    findPayrollLockedPeriods: async (rows) => lockHits(rows),
    saveCalculations: async (rows) => {
      if (lockHits(rows).length > 0) throw lockedError();
      saved.calculations.push(rows);
      return { written: rows.length };
    },
    saveCalculationsWithReconciliation: async ({ rows }) => {
      if (lockHits(rows).length > 0) throw lockedError();
      saved.calculations.push(rows);
      return { written: rows.length, stale_removed: 0 };
    },
    listEmployeesForRecalculation: async () => EMPLOYEES,
  };

  const stepsOf = (id) => store.steps.filter((s) => s.attendance_approval_request_id === id);
  const decidedSteps = (id) => stepsOf(id).filter((s) => s.decision === "APPROVED" || s.decision === "REJECTED").length;
  // The open-request groups, as migration 20261127120000 generates them: a
  // SYSTEM OT has its own, so it never holds the slot a correction needs.
  const group = (type, auto) =>
    type === "SHIFT_CHANGE" ? "SHIFT" : type === "PERMISSION" ? "PERM" : type === "OT" && auto ? "AUTO_OT" : "ATT";
  const CORRECTIONS = ["REGULARIZATION", "REGULARIZATION_WITH_OT", "SHIFT_CHANGE", "PERMISSION"];
  const pendingCorrections = (employeeId, dates) =>
    store.requests.filter((r) => r.requested_for_employee_id === employeeId && dates.includes(r.attendance_date) && r.status === "PENDING" && CORRECTIONS.includes(r.request_type));
  store.deferred = store.deferred || [];
  store.deferredLog = store.deferredLog || [];

  const regRepo = {
    store,
    getApprovalIdentity: async (id) =>
      IDENTITIES[id] ||
      (() => {
        const e = EMPLOYEES.find((x) => x.employee_id === Number(id));
        return e ? { employee_id: e.employee_id, employee_name: e.employee_name, outlet_id: e.store_id, outlet_name: `Outlet ${e.store_id}`, designation_id: e.designation_id, designation_name: "STAFF", approver_role: null, requester_class: null } : null;
      })(),
    findOpenRequest: async (employeeId, date) =>
      store.requests.find(
        (r) => r.requested_for_employee_id === employeeId && r.attendance_date === date && r.status === "PENDING" && !(r.request_type === "OT" && r.auto_created === 1)
      ) || null,
    findPendingCorrections: async (employeeId, dates) => pendingCorrections(employeeId, dates),
    listPendingCorrectionsForPairs: async (pairs) =>
      pairs.flatMap((p) => pendingCorrections(p.employee_id, [p.attendance_date]).map((r) => ({ ...r, employee_id: r.requested_for_employee_id }))),
    // ---- deferred historical OT (attendance_ot_deferred_sync) ----
    upsertDeferredOt: async ({ employee_id, attendance_date, blocking_request_id = null, blocking_request_type = null, eligible_ot_minutes, reason = "BLOCKED_BY_OPEN_REQUEST", source }) => {
      const found = store.deferred.find((d) => d.employee_id === employee_id && d.attendance_date === attendance_date);
      if (found && found.status === "WAITING_FOR_CORRECTION") return { deferred_sync_id: found.deferred_sync_id, recorded: false };
      const row = found || { deferred_sync_id: store.deferred.length + 1, employee_id, attendance_date, source };
      Object.assign(row, { status: "WAITING_FOR_CORRECTION", resolution: null, reason, blocking_request_id, blocking_request_type, eligible_ot_minutes });
      if (!found) store.deferred.push(row);
      store.deferredLog.push({ deferred_sync_id: row.deferred_sync_id, action: "DEFERRED", trigger_source: source });
      return { deferred_sync_id: row.deferred_sync_id, recorded: true };
    },
    listWaitingDeferredOt: async (employeeId, dates) =>
      store.deferred.filter((d) => d.employee_id === employeeId && dates.includes(d.attendance_date) && d.status === "WAITING_FOR_CORRECTION"),
    markDeferredOtStillBlocked: async ({ deferred_sync_id, blocking_request_id, trigger_source }) => {
      const d = store.deferred.find((x) => x.deferred_sync_id === deferred_sync_id);
      if (d && d.status === "WAITING_FOR_CORRECTION" && d.blocking_request_id !== blocking_request_id) {
        d.blocking_request_id = blocking_request_id;
        store.deferredLog.push({ deferred_sync_id, action: "STILL_BLOCKED", trigger_source });
      }
    },
    noteDeferredOtWaiting: async ({ deferred_sync_id, reason, trigger_source }) => {
      const d = store.deferred.find((x) => x.deferred_sync_id === deferred_sync_id);
      if (!d || d.status !== "WAITING_FOR_CORRECTION") return;
      if (reason && d.reason !== reason) {
        d.reason = reason;
        store.deferredLog.push({ deferred_sync_id, action: "STILL_BLOCKED", trigger_source });
      }
      d.touched = (d.touched || 0) + 1;
    },
    resolveDeferredOt: async ({ deferred_sync_id, resolution, ot_request_id, trigger_source }) => {
      const d = store.deferred.find((x) => x.deferred_sync_id === deferred_sync_id);
      if (!d || d.status !== "WAITING_FOR_CORRECTION") return { resolved: false };
      Object.assign(d, { status: "RESOLVED", resolution, resolved_request_id: ot_request_id });
      store.deferredLog.push({ deferred_sync_id, action: "SYNC_ATTEMPTED", trigger_source }, { deferred_sync_id, action: "RESOLVED", resolution, trigger_source });
      return { resolved: true };
    },
    listResolvableDeferredOt: async () =>
      store.deferred.filter((d) => d.status === "WAITING_FOR_CORRECTION" && pendingCorrections(d.employee_id, [d.attendance_date]).length === 0),
    findRequestsForDates: async (employeeId, dates) =>
      store.requests.filter((r) => r.requested_for_employee_id === employeeId && dates.includes(r.attendance_date) && r.status !== "CANCELLED"),
    getRegularizationPolicy: async () => null,
    // THE DATABASE'S OPEN-REQUEST KEY: one PENDING request per employee, date
    // and group - what makes a concurrent duplicate impossible.
    createRequest: async ({ request, chain, punch: manual }) => {
      if (request.refuse_when_payroll_locked && lockHits([{ employee_id: request.requested_for_employee_id, attendance_date: request.attendance_date }]).length > 0) {
        // THE DEFERRED HISTORICAL EXCEPTION, as the repository proves it: the
        // backfill's WAITING marker for this employee and date, and no
        // correction pending on the date.
        const marker = request.deferred_sync_id
          ? store.deferred.find((d) => d.deferred_sync_id === request.deferred_sync_id && d.employee_id === request.requested_for_employee_id &&
              d.attendance_date === request.attendance_date && d.status === "WAITING_FOR_CORRECTION" && ["BACKFILL", "OT_WITHDRAWN_INCOMPLETE"].includes(d.source))
          : null;
        if (!marker || pendingCorrections(request.requested_for_employee_id, [request.attendance_date]).length > 0) throw lockedError();
      }
      const sameDatePending = (r) =>
        r.requested_for_employee_id === request.requested_for_employee_id && r.attendance_date === request.attendance_date && r.status === "PENDING";
      const carriesOt = (t) => t === "OT" || t === "REGULARIZATION_WITH_OT";
      const clash = store.requests.find(
        (r) =>
          sameDatePending(r) &&
          (group(r.request_type, r.auto_created === 1) === group(request.request_type, !!request.auto_created) ||
            (carriesOt(r.request_type) && carriesOt(request.request_type)))
      );
      if (clash) {
        const err = new Error("Duplicate entry for key uq_aareq_open_per_employee_date");
        err.code = "ER_DUP_ENTRY";
        throw err;
      }
      const id = nextId; nextId += 1;
      const { refuse_when_payroll_locked, ...stored } = request; // eslint-disable-line no-unused-vars
      store.requests.push({
        attendance_approval_request_id: id, ...stored, auto_created: request.auto_created ? 1 : 0,
        status: "PENDING", current_stage_no: 1, total_stages: chain.length, finalization_state: "NOT_REQUIRED",
        approved_ot_minutes: null, closure_reason: null, created_at: "2026-09-20 06:55:00", decided_at: null, punch: manual,
      });
      chain.forEach((s) => store.steps.push({
        attendance_approval_request_id: id, stage_no: s.stage_no, approver_role: s.approver_role, outlet_id: s.outlet_id,
        approver_employee_id: s.approver_employee_id === undefined ? null : s.approver_employee_id,
        approval_level: s.approval_level || null,
        decision: "PENDING", decided_by_employee_id: null, decided_at: null, remarks: null, decision_source: null, acted_as_admin_override: 0,
      }));
      return { attendance_approval_request_id: id, total_stages: chain.length, status: "PENDING" };
    },
    getRequest: async (id) => {
      const r = store.requests.find((x) => x.attendance_approval_request_id === Number(id));
      if (!r) return null;
      return { ...r, steps: stepsOf(r.attendance_approval_request_id), regularized_punch: r.punch ? { attendance_regularized_punch_id: 77, punch_time: r.punch.punch_time } : null };
    },
    // The guarded transaction, as the SQL guards it: the step must still be
    // PENDING and the request still PENDING at this stage, else 409.
    decideStage: async (args) => {
      const isLocked = !!args.attendanceLock && lockHits([args.attendanceLock]).length > 0;
      if (args.lateOt && args.lateOt.expect_locked && !isLocked) return { code: 409, msg: "unlocked meanwhile" };
      if (isLocked && !args.lateOt && !(args.allowRejectWhenLocked && args.decision === "REJECTED")) throw lockedError();
      const r = store.requests.find((x) => x.attendance_approval_request_id === args.requestId);
      const st = stepsOf(args.requestId).find((s) => s.stage_no === args.stageNo);
      // ATTENDANCE CORRECTION FIRST, as the SQL proves it under the OT row lock.
      if (args.refuseWhileCorrectionPending) {
        const [blocker] = pendingCorrections(args.refuseWhileCorrectionPending.employee_id, [args.refuseWhileCorrectionPending.attendance_date]);
        if (blocker) {
          return { code: 409, waiting_for_correction: true, reason_code: "ATTENDANCE_CORRECTION_PENDING", blocking_request_id: blocker.attendance_approval_request_id, blocking_request_type: blocker.request_type, msg: "Attendance is being corrected. OT will be recalculated before approval." };
        }
      }
      if (!st || st.decision !== "PENDING") return { code: 409, msg: "That stage has already been decided - reload and try again" };
      if (r.status !== "PENDING" || r.current_stage_no !== args.stageNo) return { code: 409, msg: "This request moved" };
      if (args.expectCandidateOtMinutes !== null && args.expectCandidateOtMinutes !== undefined && (r.candidate_ot_minutes || 0) !== args.expectCandidateOtMinutes) {
        return { code: 409, ot_minutes_changed: true, candidate_ot_minutes: r.candidate_ot_minutes, msg: "moved" };
      }
      Object.assign(st, { decision: args.decision, decided_by_employee_id: args.actorId, decided_at: "2026-09-20 10:00:00", remarks: args.remarks, decision_source: args.decisionSource });
      r.status = args.next.status; r.current_stage_no = args.next.current_stage_no; r.approved_ot_minutes = args.next.approved_ot_minutes;
      r.finalization_state = args.next.status === "PENDING" ? "NOT_REQUIRED" : "SETTLED";
      if (args.next.status !== "PENDING") r.decided_at = "2026-09-20 10:00:00";
      // A locked month's day is never written with a decision.
      if (!isLocked && (args.calculations || []).length > 0) saved.calculations.push(args.calculations);
      let lateSettlementId = null;
      if (args.lateOt && args.lateOt.settlement && args.next.status === "APPROVED") {
        if (store.settlements.some((x) => x.attendance_approval_request_id === args.requestId)) {
          const err = new Error("Duplicate entry for key uq_aols_request");
          err.code = "ER_DUP_ENTRY";
          throw err;
        }
        lateSettlementId = store.settlements.length + 1;
        store.settlements.push({ late_settlement_id: lateSettlementId, attendance_approval_request_id: args.requestId, ...args.lateOt.settlement, settlement_status: "PENDING_SETTLEMENT", settlement_year: null, settlement_month: null, approved_by: args.actorId });
      }
      return { code: 200, status: r.status, current_stage_no: r.current_stage_no, finalization_state: r.finalization_state, calculations_written: isLocked ? 0 : (args.calculations || []).length, late_settlement_id: lateSettlementId };
    },
    // PRIOR-MONTH OT: the locked calculation's daily rate and the date's stored NRM.
    getLateOtPricingBasis: async ({ employee_id, attendance_date }) => {
      const day = saved.calculations.flat().filter((r) => r.employee_id === employee_id && r.attendance_date === attendance_date).pop() || null;
      return {
        year: Number(attendance_date.slice(0, 4)),
        month: Number(attendance_date.slice(5, 7)),
        calculation: (state.lockedCalc || {})[`${employee_id}:${attendance_date.slice(0, 7)}`] || null,
        day,
      };
    },
    // ---- automatic pending OT ----
    getAutoOtSetting: async () => setting,
    // Active employees and their roles: the approvers above plus staff.
    listApprovalAuthority: async () => [
      ...Object.values(IDENTITIES).map((i) => ({ employee_id: i.employee_id, outlet_id: i.outlet_id, approver_role: i.approver_role })),
      ...EMPLOYEES.map((e) => ({ employee_id: e.employee_id, outlet_id: e.store_id, approver_role: null })),
    ].filter((a) => !(state.inactive || []).includes(a.employee_id)),
    // ADMIN REVOKE, as the transaction applies it: the request CANCELLED, its
    // decision kept on its steps, the revocation recorded beside it.
    getRevocationSnapshot: async (id) => {
      const r = store.requests.find((x) => x.attendance_approval_request_id === Number(id));
      return r ? { request: { ...r }, steps: stepsOf(r.attendance_approval_request_id).map((st) => ({ ...st })), fingerprint: `fp-${id}` } : null;
    },
    getLatestRevocation: async () => null,
    revokeRequest: async (args) => {
      const r = store.requests.find((x) => x.attendance_approval_request_id === args.requestId);
      store.revocations = store.revocations || [];
      store.revocations.push({ attendance_approval_request_id: args.requestId, original_decision: args.originalDecision, reason: args.reason, revoked_stage_no: args.stageNo });
      r.status = "CANCELLED";
      if ((args.calculations || []).length > 0) saved.calculations.push(args.calculations);
      return { code: 200, status: "CANCELLED", calculations_written: (args.calculations || []).length };
    },
    findOtRequestsForSync: async (employeeId, dates) =>
      store.requests
        .filter((r) => r.requested_for_employee_id === employeeId && dates.includes(r.attendance_date) && ["OT", "REGULARIZATION_WITH_OT"].includes(r.request_type) && r.status !== "CANCELLED")
        .map((r) => ({ ...r, decided_steps: decidedSteps(r.attendance_approval_request_id) })),
    setPendingOtMinutes: async ({ requestId, fromMinutes, toMinutes, triggerSource }) => {
      const r = store.requests.find((x) => x.attendance_approval_request_id === requestId);
      if (!r || r.status !== "PENDING" || r.request_type !== "OT" || r.candidate_ot_minutes !== fromMinutes) return { updated: false, reason: "MOVED" };
      if (toMinutes > fromMinutes && decidedSteps(requestId) > 0) return { updated: false, reason: "INCREASE_AFTER_PARTIAL_APPROVAL" };
      r.candidate_ot_minutes = toMinutes;
      store.log.push({ attendance_approval_request_id: requestId, action: "MINUTES_CHANGED", previous_ot_minutes: fromMinutes, new_ot_minutes: toMinutes, trigger_source: triggerSource });
      return { updated: true };
    },
    withdrawAutoOtRequest: async ({ requestId, reason, triggerSource }) => {
      const r = store.requests.find((x) => x.attendance_approval_request_id === requestId);
      if (!r || r.status !== "PENDING" || r.request_type !== "OT" || r.auto_created !== 1 || decidedSteps(requestId) > 0) return { withdrawn: false };
      r.status = "CANCELLED";
      stepsOf(requestId).filter((s) => s.decision === "PENDING").forEach((s) => { s.decision = "SKIPPED"; s.remarks = reason; });
      store.log.push({ attendance_approval_request_id: requestId, action: "WITHDRAWN", previous_ot_minutes: r.candidate_ot_minutes, new_ot_minutes: 0, trigger_source: triggerSource });
      return { withdrawn: true };
    },
    logAutoOt: async (entry) => { store.log.push(entry); return true; },
    // ---- the approval screen, scoped as the SQL scopes it ----
    _visible: ({ request_type, status, approver_roles, outlet_id, actor_employee_id, is_admin }) =>
      store.requests.filter((r) => {
        const types = Array.isArray(request_type) ? request_type : [request_type];
        if (!types.includes(r.request_type)) return false;
        if (status === "PENDING") {
          if (r.status !== "PENDING") return false;
          const s = stepsOf(r.attendance_approval_request_id).find((x) => x.stage_no === r.current_stage_no);
          if (!s || s.decision !== "PENDING") return false;
          const mine = s.approver_employee_id
            ? s.approver_employee_id === actor_employee_id
            : approver_roles.includes(s.approver_role) && (s.approver_role !== "STORE_MANAGER" || s.outlet_id === outlet_id);
          if (!is_admin && !mine) return false;
        } else if (status === "APPROVED" || status === "REJECTED") {
          if (r.status !== status) return false;
        } else if (r.status === "CANCELLED") return false;
        if (!is_admin && (r.requested_for_employee_id === actor_employee_id || r.requested_by_employee_id === actor_employee_id)) return false;
        return true;
      }),
    listApprovals: async (f) => regRepo._visible(f).map((r) => ({
      ...r, employee_name: (EMPLOYEES.find((e) => e.employee_id === r.requested_for_employee_id) || {}).employee_name,
      outlet_name: `Outlet ${r.outlet_id}`, proposed_punch_time: r.punch ? r.punch.punch_time : null,
      shift_snapshot: null, effective_punches: null, nrm_minutes: 660, worked_minutes: 750, shortage_minutes: 0,
      stored_candidate_ot_minutes: r.candidate_ot_minutes, stored_status: "FINAL", shift_name: "Late Shift",
    })),
    countApprovals: async (f) => regRepo._visible(f).length,
    listStepsForRequests: async (ids) => store.steps.filter((s) => ids.includes(s.attendance_approval_request_id)),
    listForEmployee: async () => [],
  };

  const approverSetupRepo = {
    getActiveSetup: async (employeeId) => (employeeId === 43 ? { final_approver_employee_id: 7 } : null),
  };

  const telegramSent = [];
  const telegramLog = { sent: telegramSent, edited: [], answered: [] };
  const telegram = {
    isConfigured: () => true,
    sendMessage: async (chatId, text, opts = {}) => {
      telegramSent.push({ chatId, text, replyMarkup: opts.replyMarkup || null });
      return { message_id: 5000 + telegramSent.length };
    },
    editMessageReplyMarkup: async (chatId, messageId, markup) => { telegramLog.edited.push({ chatId, messageId, markup }); },
    answerCallbackQuery: async (id, text) => { telegramLog.answered.push(text); },
  };
  // Telegram user 50xx is employee xx; an approver's private chat is 1000 + id.
  const employeeTelegramRepo = {
    getActiveIdentityByEmployee: async (id) => ({ employee_id: id, private_chat_id: 1000 + Number(id) }),
    getActiveIdentityByTelegramUser: async (tgId) => (Number(tgId) > 5000 ? { employee_id: Number(tgId) - 5000 } : null),
  };

  const calculation = buildCalculation(calcRepo);
  const regularization = buildRegularization(regRepo, calculation, approverSetupRepo);
  calculation.setOtRequestService(regularization);
  if (state.wireAuto !== false) calculation.setOtAutoSync(regularization);
  const otTelegram = buildOtTelegram({ regularizationUsecase: regularization, employeeTelegramRepo, telegram });
  regularization.setOtNotifier(otTelegram);
  return { calcRepo, regRepo, calculation, regularization, otTelegram, store, saved, telegramLog, rawPunches, lockedMonths };
}

const recalc = (w, employee_id, from = DATE, to = DATE) =>
  w.calculation.recalculateRange({ employee_id, from_date: from, to_date: to, now: NOW });
/** The persisted attendance days (attendance_day_count > 0), as the repository reads them. */
const attendedFromSaved = (w) => async ({ employee_ids, from_date, to_date }) => {
  const latest = new Map();
  w.saved.calculations.flat().forEach((r) => latest.set(`${r.employee_id}|${r.attendance_date}`, r));
  return [...latest.values()]
    .filter((r) => employee_ids.includes(r.employee_id) && r.attendance_date >= from_date && r.attendance_date <= to_date && Number(r.attendance_day_count) > 0)
    .map((r) => ({ employee_id: r.employee_id, attendance_date: r.attendance_date }));
};
/** What the daily runs had stored before the deploy: every employee's days, persisted. */
const persistAll = async (w, ids = [42, 43, 44]) => {
  for (const id of ids) {
    // eslint-disable-next-line no-await-in-loop
    await w.calculation.recalculateRange({ employee_id: id, from_date: "2026-08-21", to_date: "2026-09-19", now: NOW });
  }
};
const otOf = (w, employee_id, date = DATE) =>
  w.store.requests.filter((r) => r.request_type === "OT" && r.requested_for_employee_id === employee_id && r.attendance_date === date);
const liveOt = (w, employee_id, date = DATE) => otOf(w, employee_id, date).filter((r) => r.status !== "CANCELLED");
const lastStored = (w, employee_id, date = DATE) =>
  w.saved.calculations.flat().filter((r) => r.employee_id === employee_id && r.attendance_date === date).pop();
const tap = (data, fromEmployee, messageId = 77) => ({
  callback_query: { id: `cb${messageId}`, data, from: { id: 5000 + fromEmployee }, message: { message_id: messageId, chat: { id: 1000 + fromEmployee } } },
});
const reply = (text, fromEmployee, requestId) => ({
  message: { chat: { id: 1000 + fromEmployee, type: "private" }, from: { id: 5000 + fromEmployee }, text, reply_to_message: { text: `Reject OT request #${requestId}\n\nReply...` } },
});
/** Approve the role chain's three stages: SM of 3, Operations, HR. */
const approveRoleChain = async (w, id, smActor = SM3) => {
  await w.regularization.decide({ actor: smActor, request_id: id, decision: STEP_DECISION.APPROVED, now: NOW });
  await w.regularization.decide({ actor: OPS, request_id: id, decision: STEP_DECISION.APPROVED, now: NOW });
  return w.regularization.decide({ actor: HR, request_id: id, decision: STEP_DECISION.APPROVED, now: NOW });
};

/* =============================================================== proofs */

describe("1. eligible OT automatically becomes Pending Approval", () => {
  it("a recalculation that finds 90 min OT raises ONE pending OT request on the employee's chain", async () => {
    const w = build({ rawPunches: day(42, DATE) });
    const out = await recalc(w, 42);
    const [ot] = otOf(w, 42);
    assert.ok(ot, "an OT request exists");
    assert.equal(ot.status, "PENDING");
    assert.equal(ot.auto_created, 1, "raised by the system");
    assert.equal(ot.candidate_ot_minutes, 90, "the engine's eligible minutes");
    assert.equal(ot.approved_ot_minutes, null, "nothing approved");
    assert.equal(ot.outlet_id, 3);
    assert.deepEqual(w.store.steps.filter((s) => s.attendance_approval_request_id === ot.attendance_approval_request_id).map((s) => s.approver_role),
      [APPROVER_ROLE.STORE_MANAGER, APPROVER_ROLE.OPERATIONS_MANAGER, APPROVER_ROLE.HR], "the normal role chain");
    assert.equal(out.ot_auto_pending.created.length, 1);
    assert.deepEqual(w.store.log.map((l) => [l.action, l.new_ot_minutes, l.trigger_source]), [["CREATED", 90, "RECALCULATION"]]);
  });

  it("the day reads as OT approval pending, not as OT available to request", async () => {
    const w = build({ rawPunches: day(42, DATE) });
    await recalc(w, 42);
    const [live] = await w.calculation.calculateRange({ employee_id: 42, from_date: DATE, to_date: DATE });
    assert.equal(live.ot_claim_state, "REQUEST_PENDING");
    assert.equal(live.approved_ot_minutes, 0);
  });
});

describe("2. no employee OT request is required", () => {
  it("the system-raised request goes straight to the approver queue and is approvable as is", async () => {
    const w = build({ rawPunches: day(42, DATE) });
    await recalc(w, 42);
    const queue = await w.regularization.listApprovals({ actor: SM3, request_type: REQUEST_TYPE.OT, status: "PENDING" });
    assert.equal(queue.rows.length, 1);
    const [row] = queue.rows;
    assert.equal(row.ot_source, "SYSTEM");
    assert.equal(row.actionable, true);
    const done = await approveRoleChain(w, row.attendance_approval_request_id);
    assert.equal(done.status, "APPROVED");
    assert.equal(done.approved_ot_minutes, 90);
  });

  it("the Mini App exposes no OT request at all (the routes answer 410 - see routes/*.test.js)", () => {
    const miniApp = require("./telegram_attendance_miniapp")({
      attendanceMissingUsecase: {}, attendanceCalculationUsecase: {}, attendanceRegularizationUsecase: { MAX_BACKDATE_DAYS: 45 }, log: { Log: () => {}, LEVEL: {} },
    });
    assert.equal(miniApp.submitOtRequest, undefined);
  });
});

describe("3. zero eligible OT creates no pending approval", () => {
  it("a day ending at the shift end raises nothing", async () => {
    const w = build({ rawPunches: day(42, DATE, "22:00:00") });
    const out = await recalc(w, 42);
    assert.equal(otOf(w, 42).length, 0);
    assert.equal(out.ot_auto_pending.created.length, 0);
  });

  it("an incomplete day (missing punch) raises nothing - that is a regularization", async () => {
    const w = build({ rawPunches: [punch(42, `${DATE} 10:00:00`)] });
    await recalc(w, 42);
    assert.equal(otOf(w, 42).length, 0);
  });

  it("an OPEN day raises nothing until it closes", async () => {
    const w = build({ rawPunches: day(42, "2026-09-20") });
    await w.calculation.recalculateRange({ employee_id: 42, from_date: "2026-09-20", to_date: "2026-09-20", now: NOW });
    assert.equal(otOf(w, 42, "2026-09-20").length, 0);
  });
});

describe("4. recalculation does not create duplicates", () => {
  it("recalculating the same date three times leaves exactly one OT request", async () => {
    const w = build({ rawPunches: day(42, DATE) });
    await recalc(w, 42);
    const second = await recalc(w, 42);
    await recalc(w, 42);
    assert.equal(otOf(w, 42).length, 1);
    assert.equal(second.ot_auto_pending.created.length, 0);
    assert.equal(second.ot_auto_pending.unchanged.length, 1);
  });

  it("two concurrent runs for the same date: the open-request key lets exactly one through", async () => {
    const w = build({ rawPunches: day(42, DATE) });
    const [a, b] = await Promise.all([recalc(w, 42), recalc(w, 42)]);
    assert.equal(otOf(w, 42).length, 1);
    const created = a.ot_auto_pending.created.length + b.ot_auto_pending.created.length;
    assert.equal(created, 1);
    const prevented = [...a.ot_auto_pending.unchanged, ...b.ot_auto_pending.unchanged].filter((u) => u.duplicate_prevented).length;
    assert.equal(prevented, 1, "the loser is reported, not failed");
  });
});

describe("5. pending OT updates when the attendance calculation changes", () => {
  it("90 -> 60 min: the pending request follows the engine, audited", async () => {
    const w = build({ rawPunches: day(42, DATE) });
    await recalc(w, 42);
    // The device clock was wrong: the out punch is really 23:00.
    w.rawPunches.find((p) => p.employee_id === 42 && p.io_time.endsWith("23:30:00")).io_time = `${DATE} 23:00:00`;
    const out = await recalc(w, 42);
    const [ot] = otOf(w, 42);
    assert.equal(ot.status, "PENDING");
    assert.equal(ot.candidate_ot_minutes, 60);
    assert.deepEqual(out.ot_auto_pending.updated.map((u) => [u.previous_ot_minutes, u.ot_minutes]), [[90, 60]]);
    assert.deepEqual(w.store.log.filter((l) => l.action === "MINUTES_CHANGED").map((l) => [l.previous_ot_minutes, l.new_ot_minutes]), [[90, 60]]);
    // And approval pays the new figure.
    const done = await approveRoleChain(w, ot.attendance_approval_request_id);
    assert.equal(done.approved_ot_minutes, 60);
  });

  it("an increase is held once a stage has approved the smaller figure; a decrease still applies", async () => {
    const w = build({ rawPunches: day(42, DATE, "23:00:00") });
    await recalc(w, 42);
    const [ot] = otOf(w, 42);
    await w.regularization.decide({ actor: SM3, request_id: ot.attendance_approval_request_id, decision: STEP_DECISION.APPROVED, now: NOW });
    w.rawPunches.find((p) => p.employee_id === 42 && p.io_time.endsWith("23:00:00")).io_time = `${DATE} 23:30:00`;
    const up = await recalc(w, 42);
    assert.equal(otOf(w, 42)[0].candidate_ot_minutes, 60, "not raised behind the stage-1 approver's back");
    assert.equal(up.ot_auto_pending.held[0].reason, "INCREASE_AFTER_PARTIAL_APPROVAL");
    w.rawPunches.find((p) => p.employee_id === 42 && p.io_time.endsWith("23:30:00")).io_time = `${DATE} 22:30:00`;
    await recalc(w, 42);
    assert.equal(otOf(w, 42)[0].candidate_ot_minutes, 30, "a decrease always applies");
  });

  it("when the OT disappears entirely the SYSTEM's undecided request is withdrawn, never deleted", async () => {
    const w = build({ rawPunches: day(42, DATE) });
    await recalc(w, 42);
    w.rawPunches.find((p) => p.employee_id === 42 && p.io_time.endsWith("23:30:00")).io_time = `${DATE} 21:59:00`;
    const out = await recalc(w, 42);
    const [ot] = otOf(w, 42);
    assert.equal(ot.status, "CANCELLED");
    assert.ok(w.store.steps.filter((s) => s.attendance_approval_request_id === ot.attendance_approval_request_id).every((s) => s.decision === "SKIPPED"));
    assert.equal(out.ot_auto_pending.withdrawn.length, 1);
    assert.equal(w.store.log.pop().action, "WITHDRAWN");
  });

  it("an EMPLOYEE-raised pending request (historical) is never withdrawn by the system", async () => {
    const w = build({ rawPunches: day(42, DATE), wireAuto: false });
    await w.regularization.raiseOtRequest({ actor: actor(42), attendance_date: DATE, reason: "Stock count ran late", today: "2026-09-20", now: NOW });
    w.calculation.setOtAutoSync(w.regularization);
    w.rawPunches.find((p) => p.employee_id === 42 && p.io_time.endsWith("23:30:00")).io_time = `${DATE} 21:59:00`;
    const out = await recalc(w, 42);
    assert.equal(otOf(w, 42)[0].status, "PENDING");
    assert.equal(out.ot_auto_pending.held.length, 1);
  });
});

describe("6. approved OT is not silently overwritten by recalculation", () => {
  it("a later correction changes neither the approval nor its minutes; payroll pays the engine-clamped figure", async () => {
    const w = build({ rawPunches: day(42, DATE) });
    await recalc(w, 42);
    const [ot] = otOf(w, 42);
    await approveRoleChain(w, ot.attendance_approval_request_id);
    w.rawPunches.find((p) => p.employee_id === 42 && p.io_time.endsWith("23:30:00")).io_time = `${DATE} 23:00:00`;
    const out = await recalc(w, 42);
    const [after] = otOf(w, 42);
    assert.equal(after.status, "APPROVED");
    assert.equal(after.approved_ot_minutes, 90, "the decision record is untouched");
    assert.equal(otOf(w, 42).length, 1, "no new request");
    assert.deepEqual(out.ot_auto_pending.preserved_approved.map((p) => [p.approved_ot_minutes, p.eligible_ot_minutes]), [[90, 60]]);
    // THE EXISTING CORRECTION PATH: the engine clamps an approval to the
    // day's eligible OT on every recalculation.
    assert.equal(lastStored(w, 42).approved_ot_minutes, 60);
  });
});

describe("7. rejected OT is not recreated as pending", () => {
  it("a rejection stands through any number of recalculations", async () => {
    const w = build({ rawPunches: day(42, DATE) });
    await recalc(w, 42);
    const [ot] = otOf(w, 42);
    await w.regularization.decide({ actor: SM3, request_id: ot.attendance_approval_request_id, decision: STEP_DECISION.REJECTED, remarks: "Not authorised by store", now: NOW });
    const out = await recalc(w, 42);
    await recalc(w, 42);
    assert.deepEqual(otOf(w, 42).map((r) => r.status), ["REJECTED"]);
    assert.equal(out.ot_auto_pending.preserved_rejected.length, 1);
    assert.equal(lastStored(w, 42).approved_ot_minutes, 0);
  });
});

describe("8. approval from DnDS updates the common OT record", () => {
  it("each stage is stamped WEB on the one record, and the stored day carries the approved minutes", async () => {
    const w = build({ rawPunches: day(42, DATE) });
    await recalc(w, 42);
    const [ot] = otOf(w, 42);
    const done = await approveRoleChain(w, ot.attendance_approval_request_id);
    assert.equal(done.decision_source, "WEB");
    const steps = w.store.steps.filter((s) => s.attendance_approval_request_id === ot.attendance_approval_request_id);
    assert.deepEqual(steps.map((s) => [s.decision, s.decision_source, s.decided_by_employee_id]), [
      ["APPROVED", "WEB", 7], ["APPROVED", "WEB", 10], ["APPROVED", "WEB", 8],
    ]);
    assert.equal(otOf(w, 42)[0].status, "APPROVED");
    assert.equal(otOf(w, 42)[0].decided_at, "2026-09-20 10:00:00", "decision timestamp");
  });
});

describe("9. approval from Telegram updates the same record", () => {
  it("the first approver is messaged with the details, taps Approve, and DnDS reads APPROVED", async () => {
    const w = build({ rawPunches: day(43, DATE, "23:00:00") });
    await recalc(w, 43);
    const [ot] = otOf(w, 43);
    const [card] = w.telegramLog.sent;
    assert.equal(card.chatId, 1007, "the employee-level first approver, 7");
    assert.match(card.text, /OT Approval Pending/);
    assert.match(card.text, /Employee: 43 - Sathiya Priya/);
    assert.match(card.text, /Date: 14 Sep 2026/);
    assert.match(card.text, /Shift: 10:00 - 22:00/);
    assert.match(card.text, /Punch Out: 23:00/);
    assert.match(card.text, /Eligible OT: 60 min/);
    const [approve, reject] = card.replyMarkup.inline_keyboard[0];
    assert.equal(approve.callback_data, `ot:${ot.attendance_approval_request_id}:A:60`);
    assert.equal(reject.callback_data, `ot:${ot.attendance_approval_request_id}:R`);

    const outcome = await w.otTelegram.handle(tap(approve.callback_data, 7));
    assert.equal(outcome.outcome, "APPROVED");
    const record = otOf(w, 43)[0];
    assert.equal(record.attendance_approval_request_id, ot.attendance_approval_request_id, "the same record");
    assert.equal(record.status, "APPROVED");
    assert.equal(record.approved_ot_minutes, 60);
    assert.equal(w.store.steps.find((s) => s.attendance_approval_request_id === ot.attendance_approval_request_id).decision_source, "TELEGRAM");
    // DnDS reads the decision immediately - it is the same row.
    const history = await w.regularization.listApprovals({ actor: SM3, request_type: REQUEST_TYPE.OT, status: "APPROVED" });
    assert.equal(history.rows[0].attendance_approval_request_id, ot.attendance_approval_request_id);
    assert.equal(history.rows[0].approved_ot_minutes, 60);
  });

  it("Reject asks for a reason; the reply rejects the same record with that reason", async () => {
    const w = build({ rawPunches: day(43, DATE) });
    await recalc(w, 43);
    const [ot] = otOf(w, 43);
    const asked = await w.otTelegram.handle(tap(`ot:${ot.attendance_approval_request_id}:R`, 7));
    assert.equal(asked.outcome, "REJECT_REASON_REQUESTED");
    assert.equal(otOf(w, 43)[0].status, "PENDING", "a tap alone decides nothing");
    const done = await w.otTelegram.handle(reply("Left without handover", 7, ot.attendance_approval_request_id));
    assert.equal(done.outcome, "REJECTED");
    const step = w.store.steps.find((s) => s.attendance_approval_request_id === ot.attendance_approval_request_id);
    assert.deepEqual([step.decision, step.remarks, step.decision_source], ["REJECTED", "Left without handover", "TELEGRAM"]);
  });

  it("/ot lists the pending OT this approver may decide, with buttons, for a ROLE chain too", async () => {
    const w = build({ rawPunches: [...day(42, DATE), ...day(44, DATE)] });
    await recalc(w, 42);
    await recalc(w, 44);
    w.telegramLog.sent.length = 0;
    const out = await w.otTelegram.handle({ message: { chat: { id: 1007, type: "private" }, from: { id: 5007 }, text: "/ot" } });
    assert.equal(out.count, 1, "outlet 3's only - not outlet 5's");
    const card = w.telegramLog.sent.find((m) => m.replyMarkup);
    assert.match(card.text, /Employee: 42 - Asha/);
  });
});

describe("10. an old Telegram button cannot process an already-decided OT", () => {
  it("decided in DnDS first: Approve on the old message answers 'already processed' and changes nothing", async () => {
    const w = build({ rawPunches: day(43, DATE) });
    await recalc(w, 43);
    const [ot] = otOf(w, 43);
    await w.regularization.decide({ actor: SM3, request_id: ot.attendance_approval_request_id, decision: STEP_DECISION.REJECTED, remarks: "Not authorised", now: NOW });
    const out = await w.otTelegram.handle(tap(`ot:${ot.attendance_approval_request_id}:A:90`, 7));
    assert.equal(out.outcome, "ALREADY_DECIDED");
    assert.match(w.telegramLog.answered.pop(), /Already processed: this OT was rejected/);
    assert.equal(otOf(w, 43)[0].status, "REJECTED", "no approve-after-reject");
    assert.deepEqual(w.telegramLog.edited.pop().markup, { inline_keyboard: [] }, "the buttons are taken away");
  });

  it("an OT button pointed at a NON-OT request (a crafted callback) decides nothing", async () => {
    const w = build({ rawPunches: day(43, DATE) });
    await recalc(w, 43);
    const [ot] = otOf(w, 43);
    ot.request_type = "REGULARIZATION"; // the id now names another type of request
    const out = await w.otTelegram.handle(tap(`ot:${ot.attendance_approval_request_id}:A:90`, 7));
    assert.equal(out.wrong_type, true);
    assert.match(w.telegramLog.answered.pop(), /not for an OT request/);
    assert.equal(ot.status, "PENDING", "nothing decided");
  });

  it("Reject on an approved OT's old message is refused before even asking for a reason", async () => {
    const w = build({ rawPunches: day(43, DATE) });
    await recalc(w, 43);
    const [ot] = otOf(w, 43);
    await w.otTelegram.handle(tap(`ot:${ot.attendance_approval_request_id}:A:90`, 7));
    const out = await w.otTelegram.handle(tap(`ot:${ot.attendance_approval_request_id}:R`, 7, 78));
    assert.equal(out.outcome, "ALREADY_DECIDED");
    assert.match(w.telegramLog.answered.pop(), /approved \(90 min\)/);
    const late = await w.regularization.decide({ actor: SM3, request_id: ot.attendance_approval_request_id, decision: STEP_DECISION.REJECTED, remarks: "Changed my mind", now: NOW });
    assert.equal(late.code, 409, "and DnDS cannot reject after approve either");
    assert.equal(otOf(w, 43)[0].status, "APPROVED");
  });

  it("two taps racing: exactly one decision lands", async () => {
    const w = build({ rawPunches: day(43, DATE) });
    await recalc(w, 43);
    const [ot] = otOf(w, 43);
    const outcomes = await Promise.all([
      w.otTelegram.handle(tap(`ot:${ot.attendance_approval_request_id}:A:90`, 7, 1)),
      w.regularization.decide({ actor: SM3, request_id: ot.attendance_approval_request_id, decision: STEP_DECISION.APPROVED, now: NOW }),
    ]);
    const steps = w.store.steps.filter((s) => s.attendance_approval_request_id === ot.attendance_approval_request_id);
    assert.equal(steps.filter((s) => s.decision === "APPROVED").length, 1, "no double approval");
    assert.ok(outcomes.some((o) => o.outcome === "ALREADY_DECIDED" || o.code === 409));
  });

  it("a figure that MOVED since the message was sent is not approved; a fresh card is sent", async () => {
    const w = build({ rawPunches: day(43, DATE) });
    await recalc(w, 43);
    const [ot] = otOf(w, 43);
    w.rawPunches.find((p) => p.employee_id === 43 && p.io_time.endsWith("23:30:00")).io_time = `${DATE} 23:00:00`;
    await recalc(w, 43);
    w.telegramLog.sent.length = 0;
    const out = await w.otTelegram.handle(tap(`ot:${ot.attendance_approval_request_id}:A:90`, 7));
    assert.equal(out.outcome, "OT_MINUTES_CHANGED");
    assert.equal(otOf(w, 43)[0].status, "PENDING", "90 was never approved");
    const fresh = w.telegramLog.sent.find((m) => m.replyMarkup);
    assert.match(fresh.text, /Eligible OT: 60 min/);
    assert.equal(fresh.replyMarkup.inline_keyboard[0][0].callback_data, `ot:${ot.attendance_approval_request_id}:A:60`);
  });
});

describe("11. only approved OT reaches payroll", () => {
  it("the stored day pays 0 while pending and the approved minutes once approved", async () => {
    const w = build({ rawPunches: day(42, DATE) });
    await recalc(w, 42);
    assert.equal(lastStored(w, 42).approved_ot_minutes, 0, "pending pays nothing");
    const [ot] = otOf(w, 42);
    await approveRoleChain(w, ot.attendance_approval_request_id);
    assert.equal(lastStored(w, 42).approved_ot_minutes, 90, "the approval's own day row");
    assert.equal(lastStored(w, 42).candidate_ot_minutes, 90);
  });
});

describe("12. pending and rejected OT do not reach payroll", () => {
  it("pending OT is surfaced as PENDING_OT_APPROVAL, never treated as approved", async () => {
    const w = build({ rawPunches: day(42, DATE) });
    await recalc(w, 42);
    const verdict = evaluatePayrollReadiness({
      year: 2026, month: 9,
      snapshot: { monthly_gross: 26000, basic: 13000, date_of_joining: "2020-01-01" },
      monthly: null, day_rows: [lastStored(w, 42)], latest_closed_date: "2026-09-19",
      pending: { pending_regularizations: 0, pending_ot: liveOt(w, 42).filter((r) => r.status === "PENDING").length },
    });
    const pending = verdict.reasons.find((r) => r.code === "PENDING_OT_APPROVAL");
    assert.ok(pending, JSON.stringify(verdict.reasons));
    assert.match(pending.detail || pending.message || JSON.stringify(pending), /1 OT request/);
    assert.equal(lastStored(w, 42).approved_ot_minutes, 0);
  });

  it("rejected OT pays 0", async () => {
    const w = build({ rawPunches: day(42, DATE) });
    await recalc(w, 42);
    const [ot] = otOf(w, 42);
    await w.regularization.decide({ actor: SM3, request_id: ot.attendance_approval_request_id, decision: STEP_DECISION.REJECTED, remarks: "Not authorised", now: NOW });
    assert.equal(lastStored(w, 42).approved_ot_minutes, 0);
  });
});

describe("13-15. the deploy backfill: each employee's previous 5 ATTENDANCE days", () => {
  const TODAY = "2026-09-20"; // a Sunday
  /*
   * 42 (every day a working day) attended 10, 11, 12, 15 and 18 Sep - leave on
   * 16-17, absent on 13, 14 and 19. Five CALENDAR days (15-19) would miss the
   * 90 min OT on the 10th; five ATTENDANCE days reach back to it.
   * 44 (Sunday weekly off) attended 14-19 Sep, plus 60 min OT on the 19th;
   * its 17th OT was rejected and its 18th approved before the deploy.
   * 43 has no punches at all.
   */
  const seed = (extra = {}) =>
    build({
      wireAuto: false, // the deploy state: days stored before the feature
      setting: { enabled: 1, auto_pending_from_date: "2026-09-15" },
      shiftOf: { 44: 9 },
      rawPunches: [
        ...day(42, "2026-09-05"), // older than its 5 attendance days
        ...day(42, "2026-09-10"), // 90 min, reached only by attendance days
        ...day(42, "2026-09-11", "22:00:00"),
        ...day(42, "2026-09-12", "22:00:00"),
        ...day(42, "2026-09-15", "22:00:00"),
        ...day(42, "2026-09-18", "22:00:00"),
        ...day(44, "2026-09-11"), // 90 min, but NOT one of 44's last 5 attendance days
        ...day(44, "2026-09-14", "22:00:00"),
        ...day(44, "2026-09-15", "22:00:00"),
        ...day(44, "2026-09-16", "22:00:00"),
        ...day(44, "2026-09-17"), // rejected before deploy
        ...day(44, "2026-09-18"), // approved before deploy
        ...day(44, "2026-09-19", "23:00:00"), // 60 min, new
        ...day(43, "2026-09-20"), // today: never evaluated
      ],
      ...extra,
    });
  const deps = (w, extra = {}) => ({
    calculateRange: w.calculation.calculateRange,
    syncAutoOt: w.regularization.syncAutoOt,
    listEmployees: async () => EMPLOYEES,
    listApprovalAuthority: () => w.regRepo.listApprovalAuthority(),
    listAttendedDates: attendedFromSaved(w),
    setting: { enabled: 1, auto_pending_from_date: "2026-09-15" },
    notifySummary: w.otTelegram.notifyBacklogSummary,
    today: TODAY,
    days: 5,
    lookback: 31,
    ...extra,
  });
  const decideExisting = async (w) => {
    await persistAll(w);
    await w.regularization.raiseOtRequest({ actor: actor(44), attendance_date: "2026-09-18", reason: "Stock count ran late", today: TODAY, now: NOW });
    await approveRoleChain(w, otOf(w, 44, "2026-09-18")[0].attendance_approval_request_id, SM5);
    await w.regularization.raiseOtRequest({ actor: actor(44), attendance_date: "2026-09-17", reason: "Stock count ran late", today: TODAY, now: NOW });
    await w.regularization.decide({ actor: SM5, request_id: otOf(w, 44, "2026-09-17")[0].attendance_approval_request_id, decision: STEP_DECISION.REJECTED, remarks: "Not authorised", now: NOW });
  };
  const detailOf = (report, id) => report.detail.find((d) => d.employee_id === id);

  it("13/14. the window is per employee: their last 5 PERSISTED attendance days, and every date in between", () => {
    const all = ["2026-09-10", "2026-09-11", "2026-09-12", "2026-09-13", "2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18", "2026-09-19"];
    const persisted = ["2026-09-10", "2026-09-11", "2026-09-12", "2026-09-15", "2026-09-18"];
    // The 19th has a raw punch that was VOIDED: the engine counts no
    // attendance day there (attendance_day_count 0), so it is not persisted
    // as one - raw punches alone would have counted it.
    const calculated = all.map((d) => ({
      attendance_date: d,
      punch_count: persisted.includes(d) ? 2 : 0,
      raw_punches: persisted.includes(d) || d === "2026-09-19" ? [{ punch_id: 1 }] : [],
    }));
    const w = backfill.windowFor({ calculated, attendedDates: persisted, today: TODAY, days: 5, lookback: 31 });
    assert.deepEqual(w.attendance_dates_counted, persisted);
    assert.equal(w.from_date, "2026-09-10");
    assert.equal(w.to_date, "2026-09-19");
    assert.equal(w.dates_evaluated.length, 10, "weekly offs, leave and absences in between are evaluated too");
    // SOURCE A (raw punches) would have picked 11 Sep onward and missed the 10th.
    assert.deepEqual(w.punch_dates_last_n, ["2026-09-11", "2026-09-12", "2026-09-15", "2026-09-18", "2026-09-19"]);
    assert.equal(w.sources_differ, true);
    // Fewer than 5 persisted days: the whole lookback is evaluated.
    const short = backfill.windowFor({ calculated, attendedDates: persisted.slice(-2), today: TODAY, days: 5, lookback: 31 });
    assert.equal(short.from_date, "2026-08-20");
    assert.equal(short.complete, false);
  });

  it("13. PREVIEW: the exact dates per employee, the counts, and nothing written", async () => {
    const w = seed();
    await decideExisting(w);
    const before = JSON.stringify(w.store.requests);
    const report = await backfill.run(deps(w, { apply: false }));
    assert.equal(JSON.stringify(w.store.requests), before, "preview writes nothing");
    assert.equal(w.telegramLog.sent.length, 0, "and messages nobody");
    const d42 = detailOf(report, 42);
    assert.deepEqual(d42.attendance_dates_counted, ["2026-09-10", "2026-09-11", "2026-09-12", "2026-09-15", "2026-09-18"]);
    assert.equal(d42.from_date, "2026-09-10", "not 2026-09-15: five ATTENDANCE days, not five calendar days");
    assert.equal(d42.dates_evaluated[0], "2026-09-10");
    assert.equal(d42.dates_evaluated[d42.dates_evaluated.length - 1], "2026-09-19");
    const d44 = detailOf(report, 44);
    assert.equal(d44.from_date, "2026-09-15");
    assert.ok(!report.detail.some((d) => d.employee_id === 43), "no punches, nothing to evaluate");
    assert.equal(report.dates_covered.from_date, "2026-09-10");
    assert.equal(report.dates_covered.to_date, "2026-09-19");
    assert.equal(report.employees_checked, EMPLOYEES.length);
    assert.equal(report.totals.new_pending_would_be_created, 2);
    assert.equal(report.totals.new_pending_ot_minutes, 150);
    assert.equal(report.totals.total_ot_minutes_added_to_queue, 150);
    assert.equal(report.totals.already_approved, 1);
    assert.equal(report.totals.already_rejected, 1);
    // Always present, so a summary-only preview shows dates another request holds.
    assert.equal(report.totals.blocked_by_open_request_days, 0);
    assert.deepEqual(report.blocked_by_open_request, []);
    assert.equal(report.totals.eligible_ot_days_found, 4);
    assert.deepEqual(report.employees_without_valid_approval_chain, []);
    assert.deepEqual(report.failures, []);
  });

  it("13/14. APPLY: creates them pending, approved and rejected untouched, the cutover reaches back", async () => {
    const w = seed();
    await decideExisting(w);
    const approved = { ...otOf(w, 44, "2026-09-18")[0] };
    const rejected = { ...otOf(w, 44, "2026-09-17")[0] };
    const report = await backfill.run(deps(w, { apply: true }));
    assert.equal(report.totals.new_pending_created, 2);
    assert.deepEqual(otOf(w, 42, "2026-09-10").map((r) => [r.status, r.auto_created, r.candidate_ot_minutes]), [["PENDING", 1, 90]]);
    assert.deepEqual(otOf(w, 44, "2026-09-19").map((r) => [r.status, r.auto_created, r.candidate_ot_minutes]), [["PENDING", 1, 60]]);
    assert.deepEqual(otOf(w, 44, "2026-09-18"), [approved], "approved: untouched");
    assert.deepEqual(otOf(w, 44, "2026-09-17"), [rejected], "rejected: untouched");
    assert.equal(otOf(w, 42, "2026-09-05").length, 0, "older than the 5 attendance days");
    assert.equal(otOf(w, 43, "2026-09-20").length, 0, "today is never in the window");
    assert.equal(report.global_cutover, "2026-09-15", "the global cutover is NOT moved");
    assert.equal(otOf(w, 44, "2026-09-11").length, 0, "44's 11 Sep is not one of ITS five attendance days");
    assert.ok(w.store.log.filter((l) => l.action === "CREATED").every((l) => l.trigger_source === "BACKFILL"));
  });

  it("15. the backfill does not widen automatic OT: a later recalculation of a date outside every window raises nothing", async () => {
    const w = seed();
    await decideExisting(w);
    await backfill.run(deps(w, { apply: true }));
    assert.equal(otOf(w, 42, "2026-09-10").length, 1, "the backfill created 42's 10 Sep (its window)");
    // Ongoing automation, after the deploy: 44's 11 Sep is before the global
    // cutover and was in no window of 44's, so it is NOT raised - even though
    // 42's window reached back to the 10th.
    w.calculation.setOtAutoSync(w.regularization);
    const out = await w.calculation.recalculateRange({ employee_id: 44, from_date: "2026-09-11", to_date: "2026-09-11", now: NOW });
    assert.equal(otOf(w, 44, "2026-09-11").length, 0);
    assert.deepEqual(out.ot_auto_pending.skipped.map((x) => x.reason), ["BEFORE_CUTOVER"]);
  });

  it("15. running the backfill twice produces no duplicates", async () => {
    const w = seed();
    await decideExisting(w);
    await backfill.run(deps(w, { apply: true }));
    const count = w.store.requests.length;
    const second = await backfill.run(deps(w, { apply: true }));
    assert.equal(w.store.requests.length, count);
    assert.equal(second.totals.new_pending_created, 0);
    assert.equal(second.totals.already_pending_unchanged, 2);
  });

  it("an employee with nobody active to decide their chain is named in the preview", async () => {
    const w = seed({ inactive: [7] }); // the only Store Manager of outlet 3 has left
    await persistAll(w);
    const report = await backfill.run(deps(w, { apply: false }));
    const problems = report.employees_without_valid_approval_chain;
    assert.ok(problems.some((p) => p.employee_id === 42 && /no active Store Manager mapped for outlet 3/.test(p.problem)), JSON.stringify(problems));
  });

  it("payroll-locked months: OT is NOT raised there, but reported with its minutes", async () => {
    const w = seed({ lockedMonths: [] });
    await persistAll(w);
    w.lockedMonths.add("42:2026-9");
    const report = await backfill.run(deps(w, { apply: true }));
    assert.equal(otOf(w, 42, "2026-09-10").length, 0);
    assert.equal(report.totals.payroll_locked_eligible_days_not_raised, 1);
    assert.equal(report.totals.payroll_locked_eligible_minutes, 90);
  });

  it("apply refuses to run before the migration has seeded its setting", async () => {
    const w = seed();
    await assert.rejects(backfill.run(deps(w, { apply: true, setting: null })), /not enabled/);
  });

  it("parses its arguments strictly", () => {
    assert.deepEqual(backfill.parseArgs([]), { apply: false, days: 5, lookback: 31, employee_ids: [], today: null, telegram: true, summary_only: false });
    assert.equal(backfill.parseArgs(["--apply", "--no-telegram"]).telegram, false);
    assert.throws(() => backfill.parseArgs(["--days", "90"]), /1 to 31/);
    // --today re-points a PREVIEW only, and never into the future.
    assert.throws(() => backfill.parseArgs(["--apply", "--today", "2026-10-01"]), /preview only/);
    assert.throws(() => backfill.parseArgs(["--today", "2999-01-01"]), /cannot be in the future/);
    assert.equal(backfill.parseArgs(["--today", "2026-10-01"]).today, "2026-10-01");
    assert.throws(() => backfill.parseArgs(["--lookback", "60"]), /5 to 45/);
    assert.throws(() => backfill.parseArgs(["--force"]), /unknown argument/);
  });
});

describe("Telegram volume: the backfill sends ONE summary per approver, never a card per date", () => {
  it("12 backlog OT for one approver -> one message pointing at /ot; the records stay individual", async () => {
    const dates = ["2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11", "2026-09-12", "2026-09-13", "2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18", "2026-09-19"];
    // 43's chain names its first approver: 7.
    const w = build({ wireAuto: false, rawPunches: dates.flatMap((d) => day(43, d)) });
    await persistAll(w, [43]);
    const report = await backfill.run({
      calculateRange: w.calculation.calculateRange,
      syncAutoOt: w.regularization.syncAutoOt,
      listEmployees: async () => [{ employee_id: 43 }],
      listApprovalAuthority: () => w.regRepo.listApprovalAuthority(),
      listAttendedDates: attendedFromSaved(w),
      setting: { enabled: 1, auto_pending_from_date: "2026-09-01" },
      notifySummary: w.otTelegram.notifyBacklogSummary,
      today: "2026-09-20",
      days: 12,
      lookback: 31,
      apply: true,
    });
    assert.equal(report.totals.new_pending_created, 12);
    assert.equal(w.store.requests.filter((r) => r.requested_for_employee_id === 43 && r.status === "PENDING").length, 12, "twelve individual records");
    assert.equal(w.telegramLog.sent.length, 1, "one message, not twelve");
    const [msg] = w.telegramLog.sent;
    assert.equal(msg.chatId, 1007);
    assert.match(msg.text, /^12 OT approvals pending from previous days \(08 Sep 2026 - 19 Sep 2026\)\./);
    assert.match(msg.text, /Send \/ot to review them/);
    assert.equal(report.telegram.summaries[0].count, 12);
  });

  it("normal daily recalculation still sends an individual card per new OT", async () => {
    const w = build({ rawPunches: [...day(43, DATE), ...day(43, DATE2)] });
    await recalc(w, 43, DATE, DATE2);
    assert.equal(w.telegramLog.sent.filter((m) => /OT Approval Pending/.test(m.text)).length, 2);
  });
});

describe("16. existing attendance regularisation behaviour continues working", () => {
  it("a missing punch is still regularized; once approved, the corrected day's OT goes to approval by itself", async () => {
    const w = build({ rawPunches: [punch(42, `${DATE} 10:00:00`)] });
    await recalc(w, 42);
    assert.equal(otOf(w, 42).length, 0, "an incomplete day has no OT");
    const raised = await w.regularization.raiseRequest({
      actor: actor(42), requested_for_employee_id: 42, attendance_date: DATE,
      reason: "Terminal offline at close", punch_time: `${DATE} 23:30:00`, now: NOW,
    });
    assert.equal(raised.request_type || "REGULARIZATION", "REGULARIZATION");
    const id = raised.attendance_approval_request_id;
    const done = await approveRoleChain(w, id);
    assert.equal(done.status, "APPROVED");
    assert.equal(done.approved_ot_minutes, 0, "a correction approves no OT itself");
    // The corrected day now earns 90 min - pending, raised by the system.
    assert.deepEqual(otOf(w, 42).map((r) => [r.status, r.auto_created, r.candidate_ot_minutes]), [["PENDING", 1, 90]]);
    assert.equal(done.ot_auto_pending.created.length, 1);
  });

  it("a stale system OT on a day that has since lost a punch does not block the correction; it is WITHDRAWN, never left waiting", async () => {
    const w = build({ rawPunches: day(42, DATE) });
    await recalc(w, 42);
    // The out punch is voided at the source; nobody has recalculated yet.
    w.rawPunches.splice(w.rawPunches.findIndex((p) => p.employee_id === 42 && p.io_time.endsWith("23:30:00")), 1);
    const raised = await w.regularization.raiseRequest({
      actor: actor(42), requested_for_employee_id: 42, attendance_date: DATE,
      reason: "Terminal offline at close", punch_time: `${DATE} 23:00:00`, now: NOW,
    });
    assert.ok(raised.attendance_approval_request_id);
    assert.equal(otOf(w, 42)[0].status, "CANCELLED", "incomplete attendance carries no OT - not even a waiting one");
    assert.equal(liveOt(w, 42).length, 0);
  });
});

describe("17. existing locked-month protections continue working", () => {
  it("no pending OT is raised in a payroll-locked month", async () => {
    const w = build({ rawPunches: day(42, DATE) });
    w.lockedMonths.add("42:2026-9");
    const out = await w.regularization.syncAutoOt({ employee_id: 42, dates: [DATE], now: NOW });
    assert.equal(otOf(w, 42).length, 0);
    assert.deepEqual(out.skipped.map((s) => s.reason), ["PAYROLL_LOCKED"]);
  });

  it("a pending OT in a month that locks is frozen: a recalculation does not change it (deciding it is the carry-forward)", async () => {
    const w = build({ rawPunches: day(42, DATE) });
    await recalc(w, 42);
    const [ot] = otOf(w, 42);
    w.lockedMonths.add("42:2026-9");
    w.rawPunches.find((p) => p.employee_id === 42 && p.io_time.endsWith("23:30:00")).io_time = `${DATE} 23:00:00`;
    await w.regularization.syncAutoOt({ employee_id: 42, dates: [DATE], now: NOW });
    assert.equal(otOf(w, 42)[0].candidate_ot_minutes, 90, "unchanged");
    assert.equal(otOf(w, 42)[0].status, "PENDING", "preserved, still decidable");
    // A NON-OT approval in a locked month is still refused, exactly as before.
    const reg = { attendance_approval_request_id: 990, request_type: "REGULARIZATION", requested_for_employee_id: 42, requested_by_employee_id: 42, attendance_date: DATE, status: "PENDING", current_stage_no: 1, total_stages: 1, candidate_ot_minutes: 0 };
    w.store.requests.push(reg);
    w.store.steps.push({ attendance_approval_request_id: 990, stage_no: 1, approver_role: "STORE_MANAGER", outlet_id: 3, approver_employee_id: null, decision: "PENDING" });
    await assert.rejects(
      w.regularization.decide({ actor: SM3, request_id: 990, decision: STEP_DECISION.APPROVED, now: NOW }),
      /payroll|locked/i
    );
    void ot;
  });

  it("the race: a month locked between the check and the insert is refused under the lock", async () => {
    const w = build({ rawPunches: day(42, DATE) });
    const findLocked = w.calcRepo.findPayrollLockedPeriods;
    w.calcRepo.findPayrollLockedPeriods = async (rows) => {
      const hits = await findLocked(rows);
      w.lockedMonths.add("42:2026-9"); // locks right after the pre-check
      return hits;
    };
    const out = await w.regularization.syncAutoOt({ employee_id: 42, dates: [DATE], now: NOW });
    assert.equal(otOf(w, 42).length, 0);
    assert.deepEqual(out.skipped.map((s) => s.reason), ["PAYROLL_LOCKED"]);
  });
});

describe("18. permission and outlet scope continue working", () => {
  it("a Store Manager sees and decides their own outlet's OT only", async () => {
    const w = build({ rawPunches: [...day(42, DATE), ...day(44, DATE)] });
    await recalc(w, 42);
    await recalc(w, 44);
    const mine = await w.regularization.listApprovals({ actor: SM3, request_type: REQUEST_TYPE.OT, status: "PENDING" });
    assert.deepEqual(mine.rows.map((r) => r.employee_id), [42]);
    const other = otOf(w, 44)[0];
    await assert.rejects(
      w.regularization.decide({ actor: SM3, request_id: other.attendance_approval_request_id, decision: STEP_DECISION.APPROVED, now: NOW }),
      (err) => err.name === "ForbiddenError"
    );
  });

  it("from Telegram: a linked employee who is not the stage's approver is refused; an unlinked account is refused", async () => {
    const w = build({ rawPunches: day(44, DATE) });
    await recalc(w, 44);
    const [ot] = otOf(w, 44);
    const wrong = await w.otTelegram.handle(tap(`ot:${ot.attendance_approval_request_id}:A:90`, 7));
    assert.equal(wrong.outcome, "REFUSED");
    const unlinked = await w.otTelegram.handle({ callback_query: { id: "x", data: `ot:${ot.attendance_approval_request_id}:A:90`, from: { id: 12 }, message: { message_id: 1, chat: { id: 1 } } } });
    assert.equal(unlinked.outcome, "NOT_LINKED");
    assert.equal(otOf(w, 44)[0].status, "PENDING");
  });

  it("nobody approves their own OT, and the employee never sees it in a queue", async () => {
    const w = build({ rawPunches: day(42, DATE) });
    await recalc(w, 42);
    const own = await w.regularization.listApprovals({ actor: actor(42), request_type: REQUEST_TYPE.OT, status: "PENDING" });
    assert.equal(own.rows.length, 0);
  });
});

/* ================================================================ edges */

describe("gates", () => {
  it("nothing is raised before the cutover date (no surprise OT for old months)", async () => {
    const w = build({ rawPunches: day(42, DATE), setting: { enabled: 1, auto_pending_from_date: "2026-09-15" } });
    const out = await recalc(w, 42);
    assert.equal(otOf(w, 42).length, 0);
    assert.deepEqual(out.ot_auto_pending.skipped.map((s) => s.reason), ["BEFORE_CUTOVER"]);
  });

  it("the kill switch (enabled = 0) and an absent setting both disable it, changing nothing", async () => {
    for (const setting of [{ enabled: 0, auto_pending_from_date: "2026-09-01" }, null]) {
      const w = build({ rawPunches: day(42, DATE), setting });
      // eslint-disable-next-line no-await-in-loop
      const out = await recalc(w, 42);
      assert.equal(out.ot_auto_pending.enabled, false);
      assert.equal(otOf(w, 42).length, 0);
    }
  });

  it("Present/Absent Only dates calculate no OT and raise nothing", async () => {
    const w = build({ rawPunches: day(42, DATE) });
    const calc = w.calculation.calculateRange;
    const days = (await calc({ employee_id: 42, from_date: DATE, to_date: DATE })).map((d) => ({ ...d, attendance_calculation_mode: "PRESENT_ABSENT_ONLY" }));
    const out = await w.regularization.syncAutoOt({ employee_id: 42, days, now: NOW });
    assert.equal(otOf(w, 42).length, 0);
    assert.deepEqual(out.skipped.map((s) => s.reason), ["PRESENT_ABSENT_ONLY"]);
  });

  it("a failing sync never fails the recalculation that triggered it", async () => {
    const w = build({ rawPunches: day(42, DATE) });
    w.regRepo.findOtRequestsForSync = async () => { throw new Error("ER_LOCK_WAIT_TIMEOUT"); };
    const out = await recalc(w, 42);
    assert.equal(out.days.length, 1, "the day is stored");
    assert.match(out.ot_auto_pending.error, /LOCK_WAIT/);
  });

  it("a request already decided answers 'already processed' to DnDS too, whatever the decision asked", async () => {
    const w = build({ rawPunches: day(43, DATE) });
    await recalc(w, 43);
    const [ot] = otOf(w, 43);
    await w.regularization.decide({ actor: SM3, request_id: ot.attendance_approval_request_id, decision: STEP_DECISION.APPROVED, now: NOW });
    const again = await w.regularization.decide({ actor: SM3, request_id: ot.attendance_approval_request_id, decision: STEP_DECISION.APPROVED, now: NOW });
    assert.equal(again.code, 409);
    assert.equal(again.already_decided, true);
    assert.equal(again.status, "APPROVED");
  });

  it("a recalculation never touches an OT record on another date", async () => {
    const w = build({ rawPunches: [...day(42, DATE), ...day(42, DATE2)] });
    await recalc(w, 42, DATE, DATE2);
    assert.equal(liveOt(w, 42, DATE).length, 1);
    assert.equal(liveOt(w, 42, DATE2).length, 1);
    w.rawPunches.find((p) => p.employee_id === 42 && p.io_time === `${DATE2} 23:30:00`).io_time = `${DATE2} 23:00:00`;
    await recalc(w, 42, DATE2, DATE2);
    assert.equal(liveOt(w, 42, DATE)[0].candidate_ot_minutes, 90);
    assert.equal(liveOt(w, 42, DATE2)[0].candidate_ot_minutes, 60);
  });
});

describe("production wiring", () => {
  const fs = require("fs");
  const path = require("path");
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

  it("every stored day reaches the sync, and new OT reaches Telegram", () => {
    assert.match(server, /attendanceCalculationUsecase\.setOtAutoSync\(this\.attendanceRegularizationUsecase\)/);
    assert.match(server, /attendanceRegularizationUsecase\.setOtNotifier\(this\.attendanceOtTelegramUsecase\)/);
    assert.match(server, /name: "attendance_ot_approval"/);
  });
});

describe("revoke: an OT decision goes back to Pending Approval - only while OT is still eligible", () => {
  const ADMIN = { employee_id: 8, user_type: 2, branch_scope: ALL_BRANCHES };
  const revoke = (w, id) =>
    w.regularization.revokeDecision({ actor: ADMIN, request_id: id, reason: "decided by mistake", now: NOW });

  it("Approved -> Revoke -> Pending Approval (a new pending record; the old one kept, cancelled, with its decision)", async () => {
    const w = build({ rawPunches: day(42, DATE) });
    await recalc(w, 42);
    const [ot] = otOf(w, 42);
    await approveRoleChain(w, ot.attendance_approval_request_id);
    const out = await revoke(w, ot.attendance_approval_request_id);
    assert.equal(out.code, 200);
    const rows = otOf(w, 42);
    assert.deepEqual(rows.map((r) => [r.attendance_approval_request_id, r.status]), [
      [ot.attendance_approval_request_id, "CANCELLED"],
      [rows[1].attendance_approval_request_id, "PENDING"],
    ]);
    assert.equal(rows[1].candidate_ot_minutes, 90);
    assert.equal(rows[1].approved_ot_minutes, null, "nothing payable until approved again");
    // FULL HISTORY: the revoked approval's own steps are untouched, the
    // revocation is recorded, and the new record's creation is logged.
    const oldSteps = w.store.steps.filter((s) => s.attendance_approval_request_id === ot.attendance_approval_request_id);
    assert.deepEqual(oldSteps.map((s) => s.decision), ["APPROVED", "APPROVED", "APPROVED"]);
    assert.deepEqual(w.store.revocations.map((r) => [r.attendance_approval_request_id, r.original_decision]), [[ot.attendance_approval_request_id, "APPROVED"]]);
    assert.equal(w.store.log.filter((l) => l.action === "CREATED").pop().trigger_source, "REVOKE_OT");
    assert.equal(out.ot_auto_pending.created.length, 1);
    assert.equal(lastStored(w, 42).approved_ot_minutes, 0, "the revoked OT stops reaching payroll");
  });

  it("Rejected -> Revoke -> Pending Approval", async () => {
    const w = build({ rawPunches: day(42, DATE) });
    await recalc(w, 42);
    const [ot] = otOf(w, 42);
    await w.regularization.decide({ actor: SM3, request_id: ot.attendance_approval_request_id, decision: STEP_DECISION.REJECTED, remarks: "Not authorised", now: NOW });
    await revoke(w, ot.attendance_approval_request_id);
    assert.deepEqual(otOf(w, 42).map((r) => r.status), ["CANCELLED", "PENDING"]);
    assert.equal(w.store.steps.find((s) => s.attendance_approval_request_id === ot.attendance_approval_request_id).decision, "REJECTED", "the rejection stays on record");
    assert.equal(w.store.revocations[0].original_decision, "REJECTED");
  });

  it("revoked when the eligible OT has become zero -> no new pending OT", async () => {
    const w = build({ rawPunches: day(42, DATE) });
    await recalc(w, 42);
    const [ot] = otOf(w, 42);
    await approveRoleChain(w, ot.attendance_approval_request_id);
    // A later correction: the out punch was really at the shift end.
    w.rawPunches.find((p) => p.employee_id === 42 && p.io_time.endsWith("23:30:00")).io_time = `${DATE} 22:00:00`;
    const out = await revoke(w, ot.attendance_approval_request_id);
    assert.equal(out.code, 200);
    assert.deepEqual(otOf(w, 42).map((r) => r.status), ["CANCELLED"], "nothing recreated");
    assert.equal(out.ot_auto_pending.created.length, 0);
  });
});

describe("PRIOR-MONTH OT: deciding OT after its payroll month is locked", () => {
  const { priceLateOt } = require("../utils/payrun_calculation");
  /**
   * September is Approved & Locked for 43 (employee-level chain, one stage:
   * 7) and for 42 (role chain). The locked calculation priced September at
   * Rs 800 a day; the day row stores NRM 660 (the late shift's).
   */
  const lockedWorld = async (employee_id = 43) => {
    const w = build({
      rawPunches: day(employee_id, DATE),
      lockedCalc: { [`${employee_id}:2026-09`]: { payrun_calculation_id: 7001, daily_rate: 800, monthly_gross: 20800, status: "APPROVED_LOCKED" } },
    });
    await recalc(w, employee_id); // OT raised PENDING before the lock
    w.lockedMonths.add(`${employee_id}:2026-9`);
    return w;
  };

  it("1/3/13. DnDS: a pending OT is approved after the lock -> APPROVED, Pending Settlement, and the screen is told so", async () => {
    const w = await lockedWorld();
    const [ot] = otOf(w, 43);
    const out = await w.regularization.decide({ actor: SM3, request_id: ot.attendance_approval_request_id, decision: STEP_DECISION.APPROVED, now: NOW });
    assert.equal(out.code, 200);
    assert.equal(out.status, "APPROVED", "the APPROVAL status");
    assert.equal(out.payroll_locked, true);
    assert.equal(out.late_settlement.settlement_status, "PENDING_SETTLEMENT", "the MONEY status, kept apart");
    assert.equal(out.late_settlement.message, "Approved — will be settled in the next eligible payroll as Prior-Month OT");
    assert.equal(w.store.settlements.length, 1);
  });

  it("2. nothing of the locked month is written: no day row, no month refresh", async () => {
    const w = await lockedWorld();
    const [ot] = otOf(w, 43);
    const rowsBefore = JSON.stringify(w.saved.calculations);
    const out = await w.regularization.decide({ actor: SM3, request_id: ot.attendance_approval_request_id, decision: STEP_DECISION.APPROVED, now: NOW });
    assert.equal(JSON.stringify(w.saved.calculations), rowsBefore, "the locked day is byte-identical");
    assert.equal(out.attendance_persisted, false);
    assert.equal(out.month_refresh, null);
  });

  it("8/9. traceable, and priced on the ORIGINAL month: September's daily rate and the date's own NRM", async () => {
    const w = await lockedWorld();
    const [ot] = otOf(w, 43);
    await w.regularization.decide({ actor: SM3, request_id: ot.attendance_approval_request_id, decision: STEP_DECISION.APPROVED, now: NOW });
    const [s] = w.store.settlements;
    const nrm = lastStored(w, 43).nrm_minutes;
    const expected = priceLateOt({ approved_ot_minutes: 90, daily_rate: 800, nrm_minutes: nrm });
    assert.deepEqual(
      [s.attendance_approval_request_id, s.attendance_date, s.source_year, s.source_month, s.eligible_ot_minutes, s.approved_ot_minutes, s.source_payrun_calculation_id, s.daily_rate, s.nrm_minutes, s.amount],
      [ot.attendance_approval_request_id, DATE, 2026, 9, 90, 90, 7001, 800, nrm, expected.amount]
    );
    // 800 / (660/60 h) = 72.73 an hour; 1.5 h = 109.09
    assert.equal(expected.ot_hourly_rate, 72.73);
    assert.equal(expected.amount, 109.09);
  });

  it("the day never pays it as well: it reads Approved, paid as Prior-Month OT, with 0 approved minutes on the day", async () => {
    const w = await lockedWorld();
    const [ot] = otOf(w, 43);
    await w.regularization.decide({ actor: SM3, request_id: ot.attendance_approval_request_id, decision: STEP_DECISION.APPROVED, now: NOW });
    const [live] = await w.calculation.calculateRange({ employee_id: 43, from_date: DATE, to_date: DATE });
    assert.equal(live.ot_claim_state, "APPROVED");
    assert.equal(live.approved_ot_minutes, 0, "not paid on the original day - even if the month is ever unlocked");
    assert.deepEqual(live.ot_late_settlement, { status: "PENDING_SETTLEMENT", approved_ot_minutes: 90, settlement_year: null, settlement_month: null });
  });

  it("7. Pending -> Rejected after the lock, fully audited; no settlement", async () => {
    const w = await lockedWorld();
    const [ot] = otOf(w, 43);
    const out = await w.regularization.decide({ actor: SM3, request_id: ot.attendance_approval_request_id, decision: STEP_DECISION.REJECTED, remarks: "Not authorised by store", now: NOW });
    assert.equal(out.status, "REJECTED");
    assert.equal(out.late_settlement, null);
    const step = w.store.steps.find((x) => x.attendance_approval_request_id === ot.attendance_approval_request_id);
    assert.deepEqual([step.decision, step.decided_by_employee_id, step.remarks, step.decision_source], ["REJECTED", 7, "Not authorised by store", "WEB"]);
    assert.equal(w.store.settlements.length, 0);
  });

  it("a role chain decides stage by stage after the lock; only the FINAL approval settles", async () => {
    const w = await lockedWorld(42);
    const [ot] = otOf(w, 42);
    await w.regularization.decide({ actor: SM3, request_id: ot.attendance_approval_request_id, decision: STEP_DECISION.APPROVED, now: NOW });
    await w.regularization.decide({ actor: OPS, request_id: ot.attendance_approval_request_id, decision: STEP_DECISION.APPROVED, now: NOW });
    assert.equal(w.store.settlements.length, 0, "intermediate stages pay nothing");
    const out = await w.regularization.decide({ actor: HR, request_id: ot.attendance_approval_request_id, decision: STEP_DECISION.APPROVED, now: NOW });
    assert.equal(out.late_settlement.settlement_status, "PENDING_SETTLEMENT");
    assert.equal(w.store.settlements.length, 1);
  });

  it("12. Telegram: the late approval says 'next eligible payroll' - never the locked month - on the same record", async () => {
    const w = await lockedWorld();
    const [ot] = otOf(w, 43);
    const card = w.telegramLog.sent.find((m) => m.replyMarkup);
    const outcome = await w.otTelegram.handle(tap(card.replyMarkup.inline_keyboard[0][0].callback_data, 7));
    assert.equal(outcome.outcome, "APPROVED");
    const said = w.telegramLog.sent[w.telegramLog.sent.length - 1].text;
    assert.match(said, /^Approved — will be settled in the next eligible payroll as Prior-Month OT: 90 min for 14 Sep 2026, Rs 109\.09\./);
    assert.match(said, /Sep 2026 payroll is locked and is not changed/);
    assert.equal(w.store.settlements[0].attendance_approval_request_id, ot.attendance_approval_request_id);
    // ... and an old button cannot decide it again.
    const again = await w.otTelegram.handle(tap(card.replyMarkup.inline_keyboard[0][0].callback_data, 7, 99));
    assert.equal(again.outcome, "ALREADY_DECIDED");
    assert.equal(w.store.settlements.length, 1);
  });

  it("an OT that cannot be priced on its month is refused in a sentence, never settled at zero", async () => {
    const w = build({ rawPunches: day(43, DATE), lockedCalc: {} }); // no locked calculation to price from
    await recalc(w, 43);
    w.lockedMonths.add("43:2026-9");
    const [ot] = otOf(w, 43);
    await assert.rejects(
      w.regularization.decide({ actor: SM3, request_id: ot.attendance_approval_request_id, decision: STEP_DECISION.APPROVED, now: NOW }),
      /cannot be settled as Prior-Month OT: The original month's locked calculation has no daily rate/
    );
    assert.equal(otOf(w, 43)[0].status, "PENDING");
  });

  it("16. an ordinary (unlocked) OT approval is unchanged: paid on its day, no settlement", async () => {
    const w = build({ rawPunches: day(43, DATE) });
    await recalc(w, 43);
    const [ot] = otOf(w, 43);
    const out = await w.regularization.decide({ actor: SM3, request_id: ot.attendance_approval_request_id, decision: STEP_DECISION.APPROVED, now: NOW });
    assert.equal(out.payroll_locked, false);
    assert.equal(out.late_settlement, null);
    assert.equal(lastStored(w, 43).approved_ot_minutes, 90);
    assert.equal(w.store.settlements.length, 0);
  });
});

/* ===================== ATTENDANCE CORRECTION COMES BEFORE SYSTEM OT ===== */

/**
 * The date has a pending system OT of 90 min (out at 23:30). The out punch
 * then turns out to be wrong - voided at the source - and a correction is
 * raised with the right time. The correction comes first: it is raised, the
 * OT waits (not approvable anywhere), and the correction's decision re-runs
 * the OT from the corrected day.
 */
const correctionScenario = async (newOut, by = 42) => {
  const w = build({ rawPunches: day(42, DATE) });
  await recalc(w, 42);
  const [ot] = otOf(w, 42);
  w.rawPunches.splice(w.rawPunches.findIndex((p) => p.employee_id === 42 && p.io_time.endsWith("23:30:00")), 1);
  const reg = await w.regularization.raiseRequest({
    actor: by === 42 ? actor(42) : HR, requested_for_employee_id: 42, attendance_date: DATE,
    reason: "Terminal offline at close", punch_time: `${DATE} ${newOut}`, now: NOW,
  });
  return { w, ot, reg };
};
const otList = (w, who = SM3) => w.regularization.listApprovals({ actor: who, request_type: REQUEST_TYPE.OT, status: "PENDING" });

describe("INCOMPLETE ATTENDANCE: a correction never leaves a waiting OT behind", () => {
  it("1. the employee's regularization is raised while the system OT is pending; that OT is withdrawn at once and its date remembered", async () => {
    const { w, ot, reg } = await correctionScenario("23:00:00");
    assert.ok(reg.attendance_approval_request_id, "the correction is never blocked by the OT");
    assert.equal(otOf(w, 42)[0].attendance_approval_request_id, ot.attendance_approval_request_id);
    assert.equal(otOf(w, 42)[0].status, "CANCELLED", "withdrawn - kept for audit, never deleted, never waiting");
    assert.equal(liveOt(w, 42).length, 0);
    const [withdrawn] = reg.ot_auto_pending.withdrawn;
    assert.equal(withdrawn.attendance_incomplete, true);
    assert.equal(withdrawn.incomplete_reason, "MISSING_IN_OR_OUT_PUNCH");
    assert.deepEqual(w.store.deferred.map((d) => [d.attendance_date, d.status, d.reason, d.source]), [[DATE, "WAITING_FOR_CORRECTION", "INCOMPLETE_ATTENDANCE", "OT_WITHDRAWN_INCOMPLETE"]]);
    const log = w.store.log.find((l) => l.action === "WITHDRAWN");
    assert.equal(log.trigger_source, "REGULARIZATION_RAISED");
  });

  it("2. an HR correction for the employee is raised the same way", async () => {
    const { w, reg } = await correctionScenario("23:00:00", "HR");
    assert.ok(reg.attendance_approval_request_id);
    assert.equal(liveOt(w, 42).length, 0);
  });

  it("3. while the correction is pending there is NO OT approval row for the day in DnDS", async () => {
    const { w } = await correctionScenario("23:00:00");
    const out = await otList(w);
    assert.equal((out.rows || out.items || out).filter((r) => r.request_type === "OT").length, 0);
  });

  it("9. DnDS: the old OT answers 'withdrawn' - single and bulk; nothing is approved", async () => {
    const { w, ot } = await correctionScenario("23:00:00");
    const out = await w.regularization.decide({ actor: SM3, request_id: ot.attendance_approval_request_id, decision: STEP_DECISION.APPROVED, now: NOW });
    assert.equal(out.code, 409);
    assert.equal(out.msg, "This request was withdrawn and can no longer be decided");
    const bulk = await w.regularization.bulkAction({
      actor: SM3, action: "APPROVE", request_type: REQUEST_TYPE.OT, items: [{ request_id: ot.attendance_approval_request_id, current_stage_no: 1 }], now: NOW,
    });
    assert.notEqual(bulk.results[0].outcome, "APPROVED");
    assert.equal(otOf(w, 42)[0].status, "CANCELLED");
  });

  it("8. an old Telegram Approve approves nothing: already processed, buttons retired", async () => {
    const { w, ot } = await correctionScenario("23:00:00");
    const out = await w.otTelegram.handle(tap(`ot:${ot.attendance_approval_request_id}:A:90`, 7));
    assert.equal(out.outcome, "ALREADY_DECIDED");
    assert.match(w.telegramLog.answered.pop(), /withdrawn/);
    assert.equal(otOf(w, 42)[0].status, "CANCELLED");
  });

  it("18. nothing pays: the day carries 0 approved OT and no OT is pending", async () => {
    const { w } = await correctionScenario("23:00:00");
    assert.equal(lastStored(w, 42).approved_ot_minutes, 0);
    assert.equal(liveOt(w, 42).length, 0);
  });

  it("a correction on a COMPLETE day (a pending permission) still keeps the OT waiting, refused until decided", async () => {
    const w = build({ rawPunches: day(42, DATE) });
    await recalc(w, 42);
    const [ot] = otOf(w, 42);
    w.store.requests.push({
      attendance_approval_request_id: 4999, request_type: "PERMISSION", requested_for_employee_id: 42, requested_by_employee_id: 42,
      attendance_date: DATE, status: "PENDING", current_stage_no: 1, total_stages: 1, auto_created: 0, candidate_ot_minutes: 0,
    });
    const synced = await w.regularization.syncAutoOt({ employee_id: 42, dates: [DATE], now: NOW });
    assert.equal(synced.unchanged[0].waiting_for_correction, true);
    const out = await w.regularization.decide({ actor: SM3, request_id: ot.attendance_approval_request_id, decision: STEP_DECISION.APPROVED, now: NOW });
    assert.equal(out.waiting_for_correction, true);
    assert.equal(otOf(w, 42)[0].status, "PENDING");
  });
});

describe("ATTENDANCE CORRECTION FIRST: the correction's decision re-runs the OT", () => {
  it("4/5. approved with an earlier out time: OT is calculated from the COMPLETED day (60) - a fresh pending OT, decidable", async () => {
    const { w, ot, reg } = await correctionScenario("23:00:00");
    const decided = await approveRoleChain(w, reg.attendance_approval_request_id);
    const [now] = liveOt(w, 42);
    assert.notEqual(now.attendance_approval_request_id, ot.attendance_approval_request_id, "the withdrawn one stays withdrawn");
    assert.deepEqual([now.status, now.candidate_ot_minutes, now.auto_created], ["PENDING", 60, 1]);
    assert.equal(decided.ot_auto_pending.created.length, 1);
    assert.deepEqual(w.store.deferred.map((d) => [d.status, d.resolution]), [["RESOLVED", "RESOLVED_OT_CREATED"]]);
    const row = (await otList(w)).rows.find((r) => r.request_type === "OT");
    assert.equal(row.actionable, true);
    const done = await approveRoleChain(w, now.attendance_approval_request_id);
    assert.equal(done.status, "APPROVED");
    assert.equal(done.approved_ot_minutes, 60);
  });

  it("6. approved with a later out time: the completed day's OT (119) goes to approval", async () => {
    const { w, reg } = await correctionScenario("23:59:00");
    await approveRoleChain(w, reg.attendance_approval_request_id);
    assert.deepEqual(liveOt(w, 42).map((r) => [r.status, r.candidate_ot_minutes]), [["PENDING", 119]]);
  });

  it("7. corrected to no OT at all: nothing is created, and the remembered date is resolved NO_OT", async () => {
    const { w, reg } = await correctionScenario("21:30:00");
    await approveRoleChain(w, reg.attendance_approval_request_id);
    assert.equal(otOf(w, 42)[0].status, "CANCELLED");
    assert.equal(liveOt(w, 42).length, 0);
    assert.deepEqual(w.store.deferred.map((d) => [d.status, d.resolution]), [["RESOLVED", "RESOLVED_NO_OT"]]);
  });

  it("rejected correction: the day stays incomplete, so still no OT - the date keeps waiting", async () => {
    const { w, reg } = await correctionScenario("23:00:00");
    await w.regularization.decide({ actor: SM3, request_id: reg.attendance_approval_request_id, decision: STEP_DECISION.REJECTED, remarks: "No proof", now: NOW });
    assert.equal(liveOt(w, 42).length, 0);
    assert.deepEqual(w.store.deferred.map((d) => d.status), ["WAITING_FOR_CORRECTION"]);
  });

  it("17. an OT APPROVED before the correction is never overwritten; the day pays what the corrected day supports", async () => {
    const w = build({ rawPunches: day(42, DATE) });
    await recalc(w, 42);
    const [ot] = otOf(w, 42);
    await approveRoleChain(w, ot.attendance_approval_request_id);
    w.rawPunches.splice(w.rawPunches.findIndex((p) => p.employee_id === 42 && p.io_time.endsWith("23:30:00")), 1);
    const reg = await w.regularization.raiseRequest({
      actor: actor(42), requested_for_employee_id: 42, attendance_date: DATE, reason: "Terminal offline at close", punch_time: `${DATE} 23:00:00`, now: NOW,
    });
    await approveRoleChain(w, reg.attendance_approval_request_id);
    const [after] = otOf(w, 42);
    assert.deepEqual([after.status, after.approved_ot_minutes], ["APPROVED", 90], "the decision itself is untouched");
    assert.equal(lastStored(w, 42).approved_ot_minutes, 60, "the existing clamp: never paid beyond the corrected day's eligible OT");
  });
});

describe("DEFERRED HISTORICAL OT: the backfill remembers a date a correction holds", () => {
  const backfillArgs = (w, apply) => ({
    calculateRange: w.calculation.calculateRange,
    syncAutoOt: w.regularization.syncAutoOt,
    resolveDeferredOt: w.regularization.resolveDeferredOt,
    listEmployees: async () => [{ employee_id: 42 }],
    listApprovalAuthority: () => w.regRepo.listApprovalAuthority(),
    listAttendedDates: attendedFromSaved(w),
    // As deployed: the cutover is the deploy date - every backfill date is before it.
    setting: { enabled: 1, auto_pending_from_date: "2026-09-20" },
    today: "2026-09-20",
    days: 5,
    lookback: 31,
    apply,
    telegram: false,
  });
  const openCorrection = (w, date, by = 42, type = "REGULARIZATION") => {
    w.store.requests.push({
      attendance_approval_request_id: 5000, request_type: type, requested_for_employee_id: 42, requested_by_employee_id: by,
      attendance_date: date, status: "PENDING", current_stage_no: 1, total_stages: 1, auto_created: 0, candidate_ot_minutes: 0,
    });
    return w.store.requests[w.store.requests.length - 1];
  };

  it("10/11. a COMPLETE day a correction holds (a permission): preview reports it with minutes and blocker, writes nothing; --apply records ONE marker; a re-run adds none", async () => {
    const dates = ["2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18", "2026-09-19"];
    const w = build({ wireAuto: false, rawPunches: dates.flatMap((d) => day(42, d)) });
    await persistAll(w, [42]);
    openCorrection(w, "2026-09-17", 8, "PERMISSION");
    const preview = await backfill.run(backfillArgs(w, false));
    assert.deepEqual(preview.blocked_by_open_request.map((b) => [b.attendance_date, b.eligible_ot_minutes, b.blocking_request_id, b.blocking_request_type, b.blocking_request_kind]),
      [["2026-09-17", 90, 5000, "PERMISSION", "PERMISSION"]]);
    assert.deepEqual(preview.incomplete_attendance, []);
    assert.equal(preview.deferred_historical_ot.dates_would_be_tracked, 1);
    assert.equal(preview.deferred_historical_ot.eligible_minutes_on_uncorrected_days, 90);
    assert.deepEqual(preview.deferred_historical_ot.by_blocking_request_kind, { PERMISSION: 1 });
    assert.equal(w.store.deferred.length, 0, "11. a preview records nothing");
    assert.equal(preview.totals.new_pending_would_be_created, 4, "the four free dates");

    const applied = await backfill.run(backfillArgs(w, true));
    assert.equal(applied.deferred_historical_ot.dates_tracked, 1);
    assert.equal(applied.deferred_historical_ot.newly_recorded, 1);
    assert.deepEqual(w.store.deferred.map((d) => [d.attendance_date, d.status, d.reason]), [["2026-09-17", "WAITING_FOR_CORRECTION", "BLOCKED_BY_OPEN_REQUEST"]]);
    assert.equal(liveOt(w, 42, "2026-09-17").length, 0, "no OT from the uncorrected day");
    const again = await backfill.run(backfillArgs(w, true));
    assert.equal(again.deferred_historical_ot.newly_recorded, 0);
    assert.equal(w.store.deferred.length, 1, "15. never a second marker");
  });

  it("INCOMPLETE ATTENDANCE in the window: reported on its own (never eligible, never blocked minutes), no OT, remembered on --apply only", async () => {
    const dates = ["2026-09-15", "2026-09-16", "2026-09-18", "2026-09-19"];
    const w = build({
      wireAuto: false,
      rawPunches: [...dates.flatMap((d) => day(42, d)), punch(42, "2026-09-17 10:00:00"), ...day(42, "2026-09-14")],
    });
    await persistAll(w, [42]);
    // 17 Sep: one punch (out missing), nothing raised. 16 Sep: complete, but an
    // HR regularization is pending on it - not FINAL, so incomplete as well.
    openCorrection(w, "2026-09-16", 8);
    const preview = await backfill.run(backfillArgs(w, false));
    assert.deepEqual(
      preview.incomplete_attendance.map((x) => [x.attendance_date, x.incomplete_reason, x.blocking_request_kind, x.ot_created, x.would_be_remembered_for_reevaluation]),
      [["2026-09-16", "REGULARIZATION_PENDING", "HR_CORRECTION", false, true], ["2026-09-17", "MISSING_IN_OR_OUT_PUNCH", null, false, true]]
    );
    assert.deepEqual(preview.blocked_by_open_request, [], "incomplete days are not 'blocked eligible OT'");
    assert.equal(preview.totals.incomplete_attendance_days, 2);
    assert.equal(preview.totals.blocked_by_open_request_minutes, 0);
    assert.equal(preview.totals.eligible_ot_days_found, preview.totals.new_pending_would_be_created, "only the complete days");
    assert.ok(!preview.detail[0].created.some((c) => ["2026-09-16", "2026-09-17"].includes(c.attendance_date)));
    assert.equal(preview.deferred_historical_ot.incomplete_attendance_dates, 2);
    assert.equal(preview.deferred_historical_ot.eligible_minutes_on_uncorrected_days, 0);
    assert.equal(w.store.deferred.length, 0, "a preview records nothing");

    const applied = await backfill.run(backfillArgs(w, true));
    assert.deepEqual(applied.incomplete_attendance.map((x) => [x.attendance_date, x.remembered_for_reevaluation]), [["2026-09-16", true], ["2026-09-17", true]]);
    assert.deepEqual(w.store.deferred.map((d) => [d.attendance_date, d.reason, d.source]), [["2026-09-16", "INCOMPLETE_ATTENDANCE", "BACKFILL"], ["2026-09-17", "INCOMPLETE_ATTENDANCE", "BACKFILL"]]);
    assert.equal(liveOt(w, 42, "2026-09-16").length + liveOt(w, 42, "2026-09-17").length, 0, "no OT, no card, no approval row");
    assert.equal(w.telegramLog.sent.filter((m) => /2026-09-1[67]|1[67]-09-2026/.test(m.text)).length, 0);
    // The sweep leaves an incomplete date WAITING: nothing is resolved from a broken day.
    await w.regularization.resolveDeferredOt({ now: NOW });
    assert.deepEqual(w.store.deferred.map((d) => d.status), ["WAITING_FOR_CORRECTION", "WAITING_FOR_CORRECTION"]);
    // The missing out punch arrives (a device upload): the remembered
    // pre-cutover date is re-evaluated - and only it - with the global cutover unmoved.
    w.rawPunches.push(punch(42, "2026-09-17 23:00:00"));
    await w.regularization.resolveDeferredOt({ now: NOW });
    assert.deepEqual(liveOt(w, 42, "2026-09-17").map((r) => [r.status, r.candidate_ot_minutes]), [["PENDING", 60]]);
    assert.equal(liveOt(w, 42, "2026-09-16").length, 0, "the date still under correction stays without OT");
    assert.deepEqual(w.store.deferred.map((d) => [d.attendance_date, d.status, d.resolution]), [["2026-09-16", "WAITING_FOR_CORRECTION", null], ["2026-09-17", "RESOLVED", "RESOLVED_OT_CREATED"]]);
    assert.equal((await w.regRepo.getAutoOtSetting()).auto_pending_from_date, "2026-09-01");
  });

  it("12/13/14. deciding the correction re-runs OT for that pre-cutover date only, through the decision path itself", async () => {
    const dates = ["2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18", "2026-09-19"];
    // As at deploy: the cutover is the deploy date, so every window date is before it.
    const w = build({ wireAuto: false, setting: { enabled: 1, auto_pending_from_date: "2026-09-20" }, rawPunches: dates.flatMap((d) => day(42, d)) });
    await persistAll(w, [42]);
    // The correction: raised for real, on a date whose out punch was wrong.
    w.rawPunches.splice(w.rawPunches.findIndex((p) => p.employee_id === 42 && p.io_time === "2026-09-17 23:30:00"), 1);
    const reg = await w.regularization.raiseRequest({
      actor: actor(42), requested_for_employee_id: 42, attendance_date: "2026-09-17", reason: "Terminal offline at close", punch_time: "2026-09-17 23:00:00", now: NOW,
    });
    await backfill.run(backfillArgs(w, true));
    assert.equal(w.store.deferred.length, 1);
    // An unrelated pre-cutover date nobody remembered: eligible, never auto-created.
    w.rawPunches.push(...day(42, "2026-09-10"));
    await recalc(w, 42, "2026-09-10", "2026-09-10");
    const ordinary = await w.regularization.syncAutoOt({ employee_id: 42, dates: ["2026-09-10"], now: NOW, source: "RECALCULATION" });
    assert.deepEqual(ordinary.skipped.map((x) => [x.attendance_date, x.reason]), [["2026-09-10", "BEFORE_CUTOVER"]]);
    assert.equal(liveOt(w, 42, "2026-09-10").length, 0, "14. no broad historical creation");
    // The correction is decided: its decision re-runs the sync for 17 Sep.
    await approveRoleChain(w, reg.attendance_approval_request_id);
    const [ot] = liveOt(w, 42, "2026-09-17");
    assert.ok(ot, "12. the remembered date's OT is raised from the corrected day");
    assert.equal(ot.candidate_ot_minutes, 60);
    assert.deepEqual(w.store.deferred.map((d) => [d.status, d.resolution]), [["RESOLVED", "RESOLVED_OT_CREATED"]]);
    assert.deepEqual(w.store.deferredLog.map((l) => l.action), ["DEFERRED", "SYNC_ATTEMPTED", "RESOLVED"]);
    assert.equal((await w.regRepo.getAutoOtSetting()).auto_pending_from_date, "2026-09-20", "13. the cutover is untouched by any of it");
  });
});

describe("DEFERRED HISTORICAL DATE IN A LOCKED MONTH: raised, then settled forward", () => {
  /*
   * 43's chain names its first approver (7). 14 Sep was remembered by the
   * backfill (a correction held it); September has since been locked at
   * Rs 800 a day; the correction has finished.
   */
  const lockedDeferredWorld = async () => {
    const w = build({
      wireAuto: false,
      setting: { enabled: 1, auto_pending_from_date: "2026-09-20" },
      rawPunches: day(43, DATE),
      lockedCalc: { "43:2026-09": { payrun_calculation_id: 7001, daily_rate: 800, monthly_gross: 20800, status: "APPROVED_LOCKED" } },
    });
    await recalc(w, 43); // the day row the late pricing reads (no OT raised: automation not wired yet)
    w.lockedMonths.add("43:2026-9");
    await w.regRepo.upsertDeferredOt({ employee_id: 43, attendance_date: DATE, blocking_request_id: 1, blocking_request_type: "PERMISSION", eligible_ot_minutes: 0, source: "BACKFILL" });
    return w;
  };

  it("2. the sweep raises the ordinary pending OT although September is locked; the card says it settles forward", async () => {
    const w = await lockedDeferredWorld();
    const out = await w.regularization.resolveDeferredOt({ now: NOW });
    assert.equal(out.resolved[0].resolution, "RESOLVED_OT_CREATED");
    const [ot] = otOf(w, 43);
    assert.deepEqual([ot.status, ot.candidate_ot_minutes, ot.auto_created], ["PENDING", 90, 1]);
    const card = w.telegramLog.sent.find((m) => m.replyMarkup);
    assert.match(card.text, /Source payroll locked - if approved, this OT will be settled in the next eligible payroll\./);
    assert.equal(w.store.settlements.length, 0, "not priced, not payable until approved");
  });

  it("15. approved from Telegram: the existing Prior-Month OT settlement, with the late-settlement answer", async () => {
    const w = await lockedDeferredWorld();
    await w.regularization.resolveDeferredOt({ now: NOW });
    const [ot] = otOf(w, 43);
    await w.otTelegram.handle(tap(`ot:${ot.attendance_approval_request_id}:A:90`, 7));
    assert.equal(w.telegramLog.answered.pop(), "Approved");
    const said = w.telegramLog.sent[w.telegramLog.sent.length - 1].text;
    assert.match(said, /^Approved — will be settled in the next eligible payroll as Prior-Month OT: 90 min/);
    assert.match(said, /payroll is locked and is not changed\./);
    assert.equal(otOf(w, 43)[0].status, "APPROVED");
    assert.deepEqual(w.store.settlements.map((x) => [x.settlement_status, x.approved_ot_minutes]), [["PENDING_SETTLEMENT", 90]]);
  });

  it("an ordinary locked-month date - no marker - is still not raised (the existing lock rule)", async () => {
    const w = build({ wireAuto: false, rawPunches: day(43, DATE) });
    await recalc(w, 43);
    w.lockedMonths.add("43:2026-9");
    const out = await w.regularization.syncAutoOt({ employee_id: 43, dates: [DATE], now: NOW });
    assert.deepEqual(out.skipped.map((x) => x.reason), ["PAYROLL_LOCKED"]);
    assert.equal(otOf(w, 43).length, 0);
  });
});

describe("INCOMPLETE ATTENDANCE NEVER CARRIES OT", () => {
  const voidOut = (w, employee_id = 42, date = DATE, out = "23:30:00") =>
    w.rawPunches.splice(w.rawPunches.findIndex((p) => p.employee_id === employee_id && p.io_time === `${date} ${out}`), 1);

  it("a missing out-punch, an odd punch pair, a pending regularization: no pending OT, no Telegram card, no DnDS row", async () => {
    const w = build({
      rawPunches: [
        punch(42, `${DATE} 10:00:00`), // out missing
        ...day(42, DATE2), punch(42, `${DATE2} 23:50:00`), // three punches: an odd pair
        ...day(44, DATE),
      ],
    });
    w.store.requests.push({
      attendance_approval_request_id: 4998, request_type: "REGULARIZATION", requested_for_employee_id: 44, requested_by_employee_id: 44,
      attendance_date: DATE, status: "PENDING", current_stage_no: 1, total_stages: 1, auto_created: 0, candidate_ot_minutes: 0,
    });
    await recalc(w, 42, DATE, DATE2);
    const out44 = await recalc(w, 44);
    assert.equal(w.store.requests.filter((r) => r.request_type === "OT").length, 0, "no pending OT at all");
    assert.equal(w.telegramLog.sent.length, 0, "no Telegram OT card");
    assert.equal((await otList(w)).rows.length + (await otList(w, SM5)).rows.length, 0, "no DnDS OT approval row");
    const reasons = (await w.regularization.syncAutoOt({ employee_id: 42, dates: [DATE, DATE2], now: NOW })).skipped.map((x) => [x.attendance_date, x.incomplete_reason, x.eligible_ot_minutes]);
    assert.deepEqual(reasons, [[DATE, "MISSING_IN_OR_OUT_PUNCH", 0], [DATE2, "INCOMPLETE_PUNCH_PAIR", 0]]);
    assert.equal(out44.ot_auto_pending.skipped[0].incomplete_reason, "REGULARIZATION_PENDING");
  });

  it("an open (not yet closed) day raises nothing either", async () => {
    const w = build({ rawPunches: [punch(42, "2026-09-20 10:00:00")] });
    const out = await w.regularization.syncAutoOt({ employee_id: 42, dates: ["2026-09-20"], now: NOW });
    assert.equal(otOf(w, 42, "2026-09-20").length, 0);
    assert.deepEqual(out.skipped.map((x) => [x.reason, x.incomplete_reason]), [["DAY_OPEN", "ATTENDANCE_OPEN"]]);
  });

  it("a recalculation that finds the day incomplete WITHDRAWS the pending system OT; when it is complete again OT is calculated afresh", async () => {
    const w = build({ rawPunches: day(42, DATE) });
    await recalc(w, 42);
    const [ot] = otOf(w, 42);
    voidOut(w);
    const out = await recalc(w, 42);
    assert.equal(otOf(w, 42)[0].status, "CANCELLED");
    assert.equal(out.ot_auto_pending.withdrawn[0].incomplete_reason, "MISSING_IN_OR_OUT_PUNCH");
    assert.match(w.store.steps.find((s) => s.attendance_approval_request_id === ot.attendance_approval_request_id).remarks, /attendance for 2026-09-14 is incomplete/);
    assert.deepEqual(w.store.deferred.map((d) => [d.reason, d.source, d.status]), [["INCOMPLETE_ATTENDANCE", "OT_WITHDRAWN_INCOMPLETE", "WAITING_FOR_CORRECTION"]]);
    // A second recalculation of the still-incomplete day changes nothing.
    await recalc(w, 42);
    assert.equal(liveOt(w, 42).length, 0);
    assert.equal(w.store.deferred[0].status, "WAITING_FOR_CORRECTION", "never resolved from a broken day");
    // The punch is back: the completed day's OT goes to approval again.
    w.rawPunches.push(punch(42, `${DATE} 23:00:00`));
    await recalc(w, 42);
    assert.deepEqual(liveOt(w, 42).map((r) => [r.status, r.candidate_ot_minutes]), [["PENDING", 60]]);
    assert.deepEqual([w.store.deferred[0].status, w.store.deferred[0].resolution], ["RESOLVED", "RESOLVED_OT_CREATED"]);
  });

  it("a stale OT on a day that became incomplete is never approved - DnDS, bulk and Telegram all refuse, and it is withdrawn", async () => {
    for (const via of ["DNDS", "BULK", "TELEGRAM"]) {
      const w = build({ rawPunches: day(42, DATE) });
      // eslint-disable-next-line no-await-in-loop
      await recalc(w, 42);
      const [ot] = otOf(w, 42);
      voidOut(w); // nobody has recalculated yet
      let out;
      /* eslint-disable no-await-in-loop */
      if (via === "DNDS") {
        out = await w.regularization.decide({ actor: SM3, request_id: ot.attendance_approval_request_id, decision: STEP_DECISION.APPROVED, now: NOW });
        assert.equal(out.code, 409);
        assert.equal(out.attendance_incomplete, true);
        assert.equal(out.msg, "Attendance is incomplete. OT will be calculated after attendance is complete.");
        assert.equal(out.withdrawn, true);
      } else if (via === "BULK") {
        out = await w.regularization.bulkAction({
          actor: SM3, action: "APPROVE", request_type: REQUEST_TYPE.OT, items: [{ request_id: ot.attendance_approval_request_id, current_stage_no: 1 }], now: NOW,
        });
        assert.equal(out.results[0].outcome, "SKIPPED");
        assert.equal(out.results[0].code, "ATTENDANCE_INCOMPLETE");
      } else {
        out = await w.otTelegram.handle(tap(`ot:${ot.attendance_approval_request_id}:A:90`, 7));
        assert.equal(out.outcome, "ATTENDANCE_INCOMPLETE");
        assert.equal(w.telegramLog.answered.pop(), "Attendance is incomplete. OT will be calculated after attendance is complete.");
        assert.ok(w.telegramLog.edited.length > 0, "the card's buttons are retired");
      }
      /* eslint-enable no-await-in-loop */
      assert.equal(otOf(w, 42)[0].status, "CANCELLED", via);
      assert.equal(w.store.steps.filter((s) => s.decision === "APPROVED").length, 0, via);
    }
  });

  it("a remembered date whose month locks before the attendance completes: an ordinary Pending OT, then Prior-Month OT when approved", async () => {
    const w = build({
      rawPunches: day(43, DATE),
      lockedCalc: { "43:2026-09": { payrun_calculation_id: 7001, daily_rate: 800, monthly_gross: 20800, status: "APPROVED_LOCKED" } },
    });
    await recalc(w, 43);
    const [first] = otOf(w, 43);
    voidOut(w, 43);
    await recalc(w, 43); // withdrawn, remembered
    assert.equal(otOf(w, 43)[0].status, "CANCELLED");
    w.lockedMonths.add("43:2026-9");
    // Still incomplete in the locked month: nothing.
    await w.regularization.resolveDeferredOt({ now: NOW });
    assert.equal(liveOt(w, 43).length, 0);
    // The out punch arrives late; the sweep re-evaluates the remembered date.
    w.rawPunches.push(punch(43, `${DATE} 23:30:00`));
    const swept = await w.regularization.resolveDeferredOt({ now: NOW });
    assert.equal(swept.resolved[0].resolution, "RESOLVED_OT_CREATED");
    const [ot] = liveOt(w, 43);
    assert.notEqual(ot.attendance_approval_request_id, first.attendance_approval_request_id);
    assert.deepEqual([ot.status, ot.candidate_ot_minutes], ["PENDING", 90]);
    assert.equal(w.store.settlements.length, 0, "not priced at creation");
    const card = w.telegramLog.sent.filter((m) => m.replyMarkup).pop();
    assert.match(card.text, /Source payroll locked - if approved, this OT will be settled in the next eligible payroll\./);
    await w.otTelegram.handle(tap(`ot:${ot.attendance_approval_request_id}:A:90`, 7));
    assert.equal(liveOt(w, 43)[0].status, "APPROVED");
    assert.deepEqual(w.store.settlements.map((x) => [x.settlement_status, x.approved_ot_minutes]), [["PENDING_SETTLEMENT", 90]]);
  });

  it("an ordinary incomplete date in a locked month (never remembered) still raises nothing", async () => {
    const w = build({ wireAuto: false, rawPunches: [punch(43, `${DATE} 10:00:00`)] });
    await recalc(w, 43);
    w.lockedMonths.add("43:2026-9");
    w.rawPunches.push(punch(43, `${DATE} 23:30:00`));
    const out = await w.regularization.syncAutoOt({ employee_id: 43, dates: [DATE], now: NOW });
    assert.deepEqual(out.skipped.map((x) => x.reason), ["PAYROLL_LOCKED"]);
    assert.equal(otOf(w, 43).length, 0);
  });
});

describe("BACKFILL PREVIEW: approval-chain problems and source mismatches stay visible", () => {
  it("an employee whose chain nobody active can decide is named even when ALL their window dates are incomplete (no OT raised)", async () => {
    const dates = ["2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18", "2026-09-19"];
    const w = build({ wireAuto: false, inactive: [7], rawPunches: dates.map((d) => punch(43, `${d} 10:00:00`)) });
    await persistAll(w, [43]);
    const report = await backfill.run({
      calculateRange: w.calculation.calculateRange,
      syncAutoOt: w.regularization.syncAutoOt,
      listEmployees: async () => [{ employee_id: 43 }],
      listApprovalAuthority: () => w.regRepo.listApprovalAuthority(),
      previewChain: w.regularization.previewOtApprovalChain,
      listAttendedDates: attendedFromSaved(w),
      setting: { enabled: 1, auto_pending_from_date: "2026-09-20" },
      today: "2026-09-20",
      apply: false,
      telegram: false,
    });
    assert.equal(report.totals.new_pending_would_be_created, 0);
    assert.equal(report.incomplete_attendance.length, 5);
    const [problem] = report.employees_without_valid_approval_chain;
    assert.equal(problem.employee_id, 43);
    assert.equal(problem.attendance_date, null);
    assert.equal(problem.no_new_ot_in_this_run, true);
    assert.match(problem.problem, /named approver 7 is not an active employee/);
    assert.deepEqual(problem.incomplete_or_remembered_dates, dates);
  });

  it("the raw-punch vs persisted-attendance mismatch is still listed under source_comparison", async () => {
    const w = build({ wireAuto: false, rawPunches: ["2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18", "2026-09-19"].flatMap((d) => day(42, d)) });
    await persistAll(w, [42]);
    const report = await backfill.run({
      calculateRange: w.calculation.calculateRange,
      syncAutoOt: w.regularization.syncAutoOt,
      listEmployees: async () => [{ employee_id: 42 }],
      listApprovalAuthority: () => w.regRepo.listApprovalAuthority(),
      // 19 Sep has raw punches but no persisted attendance day (voided at the source).
      listAttendedDates: async (args) => (await attendedFromSaved(w)(args)).filter((r) => r.attendance_date !== "2026-09-19"),
      setting: { enabled: 1, auto_pending_from_date: "2026-09-20" },
      today: "2026-09-20",
      apply: false,
      telegram: false,
    });
    const [row] = report.source_comparison.employees_where_raw_punch_dates_differ;
    assert.equal(row.employee_id, 42);
    assert.notDeepEqual(row.raw_punch_dates, row.persisted_attendance_dates);
  });
});

describe("DEFERRED OT IS REMEMBERED ONLY WHERE A CORRECTION COULD PRODUCE OT", () => {
  /*
   * 42's window: 15, 16 and 19 Sep complete (90 min OT each); 17 Sep no
   * punch at all (an ordinary absence); 18 Sep one punch (out missing);
   * 13 Sep no punch but an HR regularization pending on it; 12 Sep three
   * punches (an odd pair) with a regularization pending as well.
   */
  const world = () => {
    const w = build({
      wireAuto: false,
      setting: { enabled: 1, auto_pending_from_date: "2026-09-20" },
      rawPunches: [
        ...day(42, "2026-09-15"), ...day(42, "2026-09-16"), ...day(42, "2026-09-19"),
        punch(42, "2026-09-18 10:00:00"),
        ...day(42, "2026-09-12"), punch(42, "2026-09-12 23:50:00"),
      ],
    });
    return w;
  };
  const pendingReg = (w, id, date) =>
    w.store.requests.push({
      attendance_approval_request_id: id, request_type: "REGULARIZATION", requested_for_employee_id: 42, requested_by_employee_id: 8,
      attendance_date: date, status: "PENDING", current_stage_no: 1, total_stages: 1, auto_created: 0, candidate_ot_minutes: 0,
    });
  const args = (w, apply) => ({
    calculateRange: w.calculation.calculateRange,
    syncAutoOt: w.regularization.syncAutoOt,
    resolveDeferredOt: w.regularization.resolveDeferredOt,
    listEmployees: async () => [{ employee_id: 42 }],
    listApprovalAuthority: () => w.regRepo.listApprovalAuthority(),
    listAttendedDates: attendedFromSaved(w),
    setting: { enabled: 1, auto_pending_from_date: "2026-09-20" },
    today: "2026-09-20",
    apply,
    telegram: false,
  });
  const entry = (report, date) => report.incomplete_attendance.find((x) => x.attendance_date === date);

  it("1/6/8. a zero-punch ABSENT day with no correction: reported, never remembered, not counted as tracked", async () => {
    const w = world();
    await persistAll(w, [42]);
    const preview = await backfill.run(args(w, false));
    const absent = entry(preview, "2026-09-17");
    assert.equal(absent.attendance_status, "ABSENT");
    assert.equal(absent.punch_count, 0);
    assert.equal(absent.blocking_request_id, null);
    assert.equal(absent.ot_reevaluation_category, "ORDINARY_ABSENT_NO_OT_REEVALUATION");
    assert.equal(absent.ot_created, false);
    assert.equal(absent.would_be_remembered_for_reevaluation, false);
    // Every remembered date is a missing-punch one: no absence is tracked.
    const remembered = preview.incomplete_attendance.filter((x) => x.would_be_remembered_for_reevaluation);
    assert.deepEqual(remembered.map((x) => [x.attendance_date, x.ot_reevaluation_category]), [
      ["2026-09-12", "MISSING_PUNCH_INCOMPLETE"],
      ["2026-09-18", "MISSING_PUNCH_INCOMPLETE"],
    ]);
    assert.equal(preview.deferred_historical_ot.dates_would_be_tracked, 2, "8. ordinary absences are not tracked");
    assert.ok(preview.totals.ordinary_absent_excluded_from_reevaluation >= 1);
    assert.equal(preview.totals.incomplete_attendance_by_category.ORDINARY_ABSENT_NO_OT_REEVALUATION, preview.totals.ordinary_absent_excluded_from_reevaluation);
    const applied = await backfill.run(args(w, true));
    assert.equal(entry(applied, "2026-09-17").remembered_for_reevaluation, false);
    assert.ok(!w.store.deferred.some((d) => d.attendance_date === "2026-09-17"), "1. no marker for an ordinary absence");
    assert.equal(w.store.deferred.length, 2);
  });

  it("2. a zero-punch day WITH an active regularization: remembered (ACTIVE_CORRECTION)", async () => {
    const w = world();
    await persistAll(w, [42]);
    pendingReg(w, 6100, "2026-09-17");
    const preview = await backfill.run(args(w, false));
    const e = entry(preview, "2026-09-17");
    assert.deepEqual([e.ot_reevaluation_category, e.blocking_request_id, e.would_be_remembered_for_reevaluation], ["ACTIVE_CORRECTION", 6100, true]);
    await backfill.run(args(w, true));
    const marker = w.store.deferred.find((d) => d.attendance_date === "2026-09-17");
    assert.deepEqual([marker.reason, marker.blocking_request_id, marker.status], ["INCOMPLETE_ATTENDANCE", 6100, "WAITING_FOR_CORRECTION"]);
  });

  it("3/7. an odd punch count (missing punch): remembered (MISSING_PUNCH_INCOMPLETE)", async () => {
    const w = world();
    await persistAll(w, [42]);
    const preview = await backfill.run(args(w, false));
    const e = entry(preview, "2026-09-18");
    assert.deepEqual([e.punch_count, e.review_reasons, e.ot_reevaluation_category, e.would_be_remembered_for_reevaluation], [1, ["MISSING_PUNCH"], "MISSING_PUNCH_INCOMPLETE", true]);
    assert.equal(preview.deferred_historical_ot.incomplete_by_reevaluation_category.MISSING_PUNCH_INCOMPLETE, 2);
  });

  it("4. a missing punch WITH an active regularization (the 2279 pattern): ONE marker, carrying the regularization", async () => {
    const w = world();
    await persistAll(w, [42]);
    pendingReg(w, 920, "2026-09-12");
    const preview = await backfill.run(args(w, false));
    const e = entry(preview, "2026-09-12");
    assert.deepEqual([e.punch_count, e.ot_reevaluation_category, e.blocking_request_id, e.would_be_remembered_for_reevaluation], [3, "MISSING_PUNCH_INCOMPLETE", 920, true]);
    await backfill.run(args(w, true));
    await backfill.run(args(w, true));
    const markers = w.store.deferred.filter((d) => d.attendance_date === "2026-09-12");
    assert.equal(markers.length, 1, "one marker, however many runs");
    assert.equal(markers[0].blocking_request_id, 920);
  });

  it("9. none of it moves the global cutover", async () => {
    const w = world();
    await persistAll(w, [42]);
    await backfill.run(args(w, true));
    assert.equal((await w.regRepo.getAutoOtSetting()).auto_pending_from_date, "2026-09-20");
  });

  it("10. an ordinary absence is no locked-month exception: punches arriving after the lock raise nothing", async () => {
    const w = world();
    await persistAll(w, [42]);
    await backfill.run(args(w, true));
    w.lockedMonths.add("42:2026-9");
    w.rawPunches.push(...day(42, "2026-09-17"));
    await w.regularization.resolveDeferredOt({ now: NOW });
    const out = await w.regularization.syncAutoOt({ employee_id: 42, dates: ["2026-09-17"], now: NOW });
    assert.deepEqual(out.skipped.map((x) => x.reason), ["BEFORE_CUTOVER"]);
    assert.equal(otOf(w, 42, "2026-09-17").length, 0);
    // A genuine remembered date (the missing punch) still is one, once complete.
    w.rawPunches.push(punch(42, "2026-09-18 23:30:00"));
    await w.regularization.resolveDeferredOt({ now: NOW });
    assert.deepEqual(liveOt(w, 42, "2026-09-18").map((r) => [r.status, r.candidate_ot_minutes]), [["PENDING", 90]]);
  });
});
