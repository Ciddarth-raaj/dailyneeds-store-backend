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
  const store = { requests: [], steps: [], log: [] };
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
      { employee_work_shift_assignment_id: 1, employee_id: employeeId, work_shift_id: 7, effective_from: "2026-09-01", source: "MIGRATION_BACKFILL" },
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
      store.requests.filter(
        (r) => r.requested_for_employee_id === employeeId && r.status !== "CANCELLED" && r.attendance_date >= from && r.attendance_date <= to
      ),
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
  const group = (type) => (type === "SHIFT_CHANGE" ? "SHIFT" : type === "PERMISSION" ? "PERM" : "ATT");

  const regRepo = {
    store,
    getApprovalIdentity: async (id) =>
      IDENTITIES[id] ||
      (() => {
        const e = EMPLOYEES.find((x) => x.employee_id === Number(id));
        return e ? { employee_id: e.employee_id, employee_name: e.employee_name, outlet_id: e.store_id, outlet_name: `Outlet ${e.store_id}`, designation_id: e.designation_id, designation_name: "STAFF", approver_role: null, requester_class: null } : null;
      })(),
    findOpenRequest: async (employeeId, date) =>
      store.requests.find((r) => r.requested_for_employee_id === employeeId && r.attendance_date === date && r.status === "PENDING") || null,
    findRequestsForDates: async (employeeId, dates) =>
      store.requests.filter((r) => r.requested_for_employee_id === employeeId && dates.includes(r.attendance_date) && r.status !== "CANCELLED"),
    getRegularizationPolicy: async () => null,
    // THE DATABASE'S OPEN-REQUEST KEY: one PENDING request per employee, date
    // and group - what makes a concurrent duplicate impossible.
    createRequest: async ({ request, chain, punch: manual }) => {
      if (request.refuse_when_payroll_locked && lockHits([{ employee_id: request.requested_for_employee_id, attendance_date: request.attendance_date }]).length > 0) {
        throw lockedError();
      }
      const clash = store.requests.find(
        (r) => r.requested_for_employee_id === request.requested_for_employee_id && r.attendance_date === request.attendance_date &&
          r.status === "PENDING" && group(r.request_type) === group(request.request_type)
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
      if (args.attendanceLock && lockHits([args.attendanceLock]).length > 0) throw lockedError();
      const r = store.requests.find((x) => x.attendance_approval_request_id === args.requestId);
      const st = stepsOf(args.requestId).find((s) => s.stage_no === args.stageNo);
      if (!st || st.decision !== "PENDING") return { code: 409, msg: "That stage has already been decided - reload and try again" };
      if (r.status !== "PENDING" || r.current_stage_no !== args.stageNo) return { code: 409, msg: "This request moved" };
      Object.assign(st, { decision: args.decision, decided_by_employee_id: args.actorId, decided_at: "2026-09-20 10:00:00", remarks: args.remarks, decision_source: args.decisionSource });
      r.status = args.next.status; r.current_stage_no = args.next.current_stage_no; r.approved_ot_minutes = args.next.approved_ot_minutes;
      r.finalization_state = args.next.status === "PENDING" ? "NOT_REQUIRED" : "SETTLED";
      if (args.next.status !== "PENDING") r.decided_at = "2026-09-20 10:00:00";
      if ((args.calculations || []).length > 0) saved.calculations.push(args.calculations);
      return { code: 200, status: r.status, current_stage_no: r.current_stage_no, finalization_state: r.finalization_state, calculations_written: (args.calculations || []).length };
    },
    // ---- automatic pending OT ----
    getAutoOtSetting: async () => setting,
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

describe("13-15. the last-5-days deploy backfill", () => {
  const TODAY = "2026-09-20";
  const seed = () =>
    build({
      wireAuto: false, // the deploy state: days stored before the feature
      setting: { enabled: 1, auto_pending_from_date: "2026-09-15" },
      rawPunches: [
        ...day(42, "2026-09-12"), // older than 5 days: out of the window
        ...day(42, "2026-09-15"), // eligible, open -> created
        ...day(42, "2026-09-16", "22:00:00"), // no OT
        ...day(42, "2026-09-17"), // approved already -> preserved
        ...day(44, "2026-09-18"), // rejected already -> preserved
        ...day(44, "2026-09-19", "23:00:00"), // eligible -> created
        ...day(43, "2026-09-20"), // today: not in the window
      ],
    });
  const runBackfill = (w, apply) =>
    backfill.run({
      syncAutoOt: w.regularization.syncAutoOt,
      listEmployees: async () => EMPLOYEES,
      setting: { enabled: 1, auto_pending_from_date: "2026-09-15" },
      today: TODAY, days: 5, apply, telegram: false,
    });
  const decideExisting = async (w) => {
    // History made before the deploy, by employees and approvers.
    await w.regularization.raiseOtRequest({ actor: actor(42), attendance_date: "2026-09-17", reason: "Stock count ran late", today: TODAY, now: NOW });
    await approveRoleChain(w, otOf(w, 42, "2026-09-17")[0].attendance_approval_request_id);
    await w.regularization.raiseOtRequest({ actor: actor(44), attendance_date: "2026-09-18", reason: "Stock count ran late", today: TODAY, now: NOW });
    await w.regularization.decide({ actor: SM5, request_id: otOf(w, 44, "2026-09-18")[0].attendance_approval_request_id, decision: STEP_DECISION.REJECTED, remarks: "Not authorised", now: NOW });
  };

  it("13. the window is yesterday back five days", () => {
    assert.deepEqual(backfill.windowFor(TODAY, 5), ["2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18", "2026-09-19"]);
  });

  it("13. PREVIEW finds exactly the open eligible OT and writes nothing", async () => {
    const w = seed();
    await decideExisting(w);
    const before = w.store.requests.length;
    const report = await runBackfill(w, false);
    assert.equal(w.store.requests.length, before, "preview writes nothing");
    assert.equal(report.totals.pending_ot_would_be_created, 2);
    assert.equal(report.totals.pending_ot_minutes_created, 90 + 60);
    assert.equal(report.totals.approved_preserved, 1);
    assert.equal(report.totals.rejected_preserved, 1);
    assert.deepEqual(report.failures, []);
  });

  it("13/14. APPLY creates them pending and leaves the approved and rejected decisions exactly as they were", async () => {
    const w = seed();
    await decideExisting(w);
    const approved = { ...otOf(w, 42, "2026-09-17")[0] };
    const rejected = { ...otOf(w, 44, "2026-09-18")[0] };
    const report = await runBackfill(w, true);
    assert.equal(report.totals.pending_ot_created, 2);
    assert.deepEqual(otOf(w, 42, "2026-09-15").map((r) => [r.status, r.auto_created, r.candidate_ot_minutes]), [["PENDING", 1, 90]]);
    assert.deepEqual(otOf(w, 44, "2026-09-19").map((r) => [r.status, r.auto_created, r.candidate_ot_minutes]), [["PENDING", 1, 60]]);
    assert.deepEqual(otOf(w, 42, "2026-09-17"), [approved], "approved: untouched");
    assert.deepEqual(otOf(w, 44, "2026-09-18"), [rejected], "rejected: untouched");
    assert.equal(otOf(w, 42, "2026-09-12").length, 0, "older than the window");
    assert.equal(otOf(w, 43, "2026-09-20").length, 0, "today is not in the window");
    assert.ok(w.store.log.filter((l) => l.action === "CREATED").every((l) => l.trigger_source === "BACKFILL"));
  });

  it("15. running the backfill twice produces no duplicates", async () => {
    const w = seed();
    await decideExisting(w);
    await runBackfill(w, true);
    const count = w.store.requests.length;
    const second = await runBackfill(w, true);
    assert.equal(w.store.requests.length, count);
    assert.equal(second.totals.pending_ot_created, 0);
    assert.equal(second.totals.already_pending_unchanged, 2);
  });

  it("apply refuses to run before the migration has seeded its setting", async () => {
    const w = seed();
    await assert.rejects(
      backfill.run({ syncAutoOt: w.regularization.syncAutoOt, listEmployees: async () => EMPLOYEES, setting: null, today: TODAY, days: 5, apply: true }),
      /not enabled/
    );
  });

  it("parses its arguments strictly", () => {
    assert.deepEqual(backfill.parseArgs([]), { apply: false, days: 5, employee_ids: [], today: null, telegram: true });
    assert.equal(backfill.parseArgs(["--apply", "--no-telegram"]).telegram, false);
    assert.throws(() => backfill.parseArgs(["--days", "90"]), /1 to 31/);
    assert.throws(() => backfill.parseArgs(["--force"]), /unknown argument/);
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

  it("a stale system OT on a day that has since lost a punch does not block the correction", async () => {
    const w = build({ rawPunches: day(42, DATE) });
    await recalc(w, 42);
    // The out punch is voided at the source; nobody has recalculated yet.
    w.rawPunches.splice(w.rawPunches.findIndex((p) => p.employee_id === 42 && p.io_time.endsWith("23:30:00")), 1);
    const raised = await w.regularization.raiseRequest({
      actor: actor(42), requested_for_employee_id: 42, attendance_date: DATE,
      reason: "Terminal offline at close", punch_time: `${DATE} 23:00:00`, now: NOW,
    });
    assert.ok(raised.attendance_approval_request_id);
    assert.equal(otOf(w, 42)[0].status, "CANCELLED", "the stale OT was withdrawn");
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

  it("a pending OT in a month that locks is frozen: not updated, and not approvable", async () => {
    const w = build({ rawPunches: day(42, DATE) });
    await recalc(w, 42);
    const [ot] = otOf(w, 42);
    w.lockedMonths.add("42:2026-9");
    w.rawPunches.find((p) => p.employee_id === 42 && p.io_time.endsWith("23:30:00")).io_time = `${DATE} 23:00:00`;
    await w.regularization.syncAutoOt({ employee_id: 42, dates: [DATE], now: NOW });
    assert.equal(otOf(w, 42)[0].candidate_ot_minutes, 90, "unchanged");
    await assert.rejects(
      w.regularization.decide({ actor: SM3, request_id: ot.attendance_approval_request_id, decision: STEP_DECISION.APPROVED, now: NOW }),
      /payroll|locked/i
    );
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
