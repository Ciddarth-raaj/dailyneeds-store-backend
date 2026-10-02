/**
 * LOCKED-PERIOD CORRECTION (attendance and OT only - no money), end to end through the REAL calculation and
 * regularization usecases, over a stateful fake repository that mirrors the
 * SQL gate (the gate itself is proven against MariaDB in
 * repository/attendance_locked_correction.mysql.test.js).
 *
 *   IS_TEST=true node --test usecase/attendance_locked_correction.test.js
 *
 * 12-09-2026, shift 14:00-22:00 (stated config: 30-minute break, pre-shift OT
 * allowed - the real shift's values must be confirmed), September
 * APPROVED_LOCKED with a frozen daily rate of 1,000.00.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildCalculation = require("./attendance_calculation");
const buildRegularization = require("./attendance_regularization");

const EMP = 42;
const DATE = "2026-09-12";
const MANAGER = { employee_id: 7, user_type: 1 };
const AUTHORISER = { employee_id: 8, user_id: 55, user_type: 1 };
const ADMIN = { employee_id: 900, user_id: 5, user_type: 2 };
const at = (hm) => `${DATE} ${hm}:00`;

const SHIFT = {
  config: {
    work_shift_id: 1, shift_code: "S1422", shift_name: "14:00-22:00", active: 1, overtime_allowed: 1,
    overtime_minimum_minutes: 0, overtime_rounding_method: "NONE", overtime_rounding_interval_minutes: 0,
    pre_shift_overtime_allowed: 1, pre_shift_overtime_minimum_minutes: 0,
    pre_shift_overtime_rounding_method: "NONE", pre_shift_overtime_rounding_interval_minutes: 0,
    late_offset_against_overtime: 0, early_exit_offset_against_overtime: 0,
  },
  schedule: Array.from({ length: 7 }, (_, d) => ({
    work_shift_weekly_schedule_id: 100 + d, work_shift_id: 1, day_of_week: d, is_working_day: 1,
    in_time: "14:00:00", out_time: "22:00:00", attendance_day_cutoff: "04:00:00", break_minutes: 30, ot_rate: 1,
  })),
};
const raw = (id, hm) => ({ punch_id: id, employee_id: EMP, io_time: at(hm), punch_date: DATE, ingest_attendance_date: DATE, dev_id: "BIOMAX-1", ingest_source: "DEVICE" });

function world({ punches, approvedOt = 0 }) {
  const store = { requests: [], punches: [], auths: [], events: [], storedDay: null };
  if (approvedOt) {
    store.requests.push({
      attendance_approval_request_id: 71, request_type: "OT", requested_for_employee_id: EMP, requested_by_employee_id: EMP,
      attendance_date: DATE, reason: "Covered the morning", candidate_ot_minutes: approvedOt, approved_ot_minutes: approvedOt,
      status: "APPROVED", current_stage_no: 1, total_stages: 1, finalization_state: "SETTLED", closure_reason: null,
      steps: [{ attendance_approval_step_id: 711, stage_no: 1, approver_role: "HR", decision: "APPROVED", decided_by_employee_id: 9 }],
    });
  }
  let nextId = 900;
  let nextPunch = 31;
  const byId = (id) => store.requests.find((r) => r.attendance_approval_request_id === Number(id));
  const authOf = (id) => store.auths.find((a) => a.attendance_approval_request_id === Number(id)) || null;
  const lockedPeriods = (rows) =>
    (rows || []).filter((r) => String(r.attendance_date).startsWith("2026-09")).map((r) => ({ employee_id: Number(r.employee_id), year: 2026, month: 9 }));

  const calculation = buildCalculation({
    getShiftAssignmentHistory: async () => [{ employee_work_shift_assignment_id: 1, employee_id: EMP, work_shift_id: 1, effective_from: "2026-09-01" }],
    getDateShiftOverrides: async () => [],
    getWorkShiftWithSchedule: async () => SHIFT,
    getWorkShiftConfigVersions: async () => [],
    getRawPunchesByCalendarWindow: async () => punches.map((p) => ({ ...p })),
    getApprovedRegularizedPunches: async () =>
      store.punches
        .filter((p) => {
          const r = byId(p.request_id);
          return r && r.status === "APPROVED" && r.finalization_state === "SETTLED";
        })
        .map((p) => ({ punch_id: p.id, employee_id: EMP, attendance_date: DATE, io_time: p.punch_time, attendance_approval_request_id: p.request_id })),
    getApprovalStateByDate: async () => store.requests.filter((r) => r.status !== "CANCELLED").map((r) => ({ ...r })),
    getBreakOverride: async () => null,
    findPayrollLockedPeriods: async (rows) => lockedPeriods(rows),
  });

  // Mirrors repository/attendance_regularization.js for the locked paths.
  const requireAuth = (id, status) => {
    const a = authOf(id);
    if (!a || a.status !== status) {
      const err = new Error(status === "AUTHORISED" ? "Locked-period authorisation required" : "no applied correction");
      err.name = "ValidationError";
      throw err;
    }
    return a;
  };
  const appendEvent = (a, type, actor, reason, event) => {
    store.events.push({
      attendance_locked_period_correction_event_id: store.events.length + 1, authorisation_id: a.id, request_id: a.attendance_approval_request_id,
      event_type: type, actor_employee_id: actor, event_reason: reason, authorised_by_employee_id: a.authorised_by_employee_id,
      authorisation_reason: a.authorisation_reason, ...event,
      employee_id: EMP, attendance_date: DATE,
    });
    return store.events.length;
  };

  const regRepo = {
    getApprovalIdentity: async (id) => ({ employee_id: id, employee_name: `E${id}`, outlet_id: 3, approver_role: null, requester_class: null }),
    findOpenRequest: async () => store.requests.find((r) => r.status === "PENDING") || null,
    findRequestsForDates: async () => store.requests.filter((r) => r.status !== "CANCELLED"),
    createRequest: async ({ request, chain, punches: ps, lockedPeriod }) => {
      const id = nextId++;
      store.requests.push({
        attendance_approval_request_id: id, ...request, status: "PENDING", current_stage_no: 1, total_stages: chain.length,
        finalization_state: "NOT_REQUIRED", approved_ot_minutes: null, closure_reason: null,
        steps: chain.map((s) => ({ ...s, attendance_approval_step_id: id * 10 + s.stage_no, decision: "PENDING" })),
      });
      (ps || []).forEach((p) => store.punches.push({ id: nextPunch++, request_id: id, punch_time: p.punch_time }));
      if (lockedPeriod) store.auths.push({ id: store.auths.length + 1, attendance_approval_request_id: id, status: "REQUIRED" });
      return { attendance_approval_request_id: id, total_stages: chain.length };
    },
    getRequest: async (id) => {
      const r = byId(id);
      if (!r) return null;
      const own = store.punches.filter((p) => p.request_id === r.attendance_approval_request_id).map((p) => ({ attendance_regularized_punch_id: p.id, punch_time: p.punch_time }));
      return { ...r, steps: r.steps.map((s) => ({ ...s })), regularized_punch: own[0] || null, regularized_punches: own };
    },
    getLockedAuthorisation: async (id) => {
      const a = authOf(id);
      return a ? { ...a, attendance_locked_period_authorisation_id: a.id, attendance_date: DATE } : null;
    },
    authoriseLockedCorrection: async ({ request_id, actor_employee_id, reason }) => {
      const a = authOf(request_id);
      if (a && a.status !== "REQUIRED") return { code: 409, msg: `already ${a.status.toLowerCase()}` };
      if (a) Object.assign(a, { status: "AUTHORISED", authorised_by_employee_id: actor_employee_id, authorisation_reason: reason });
      else store.auths.push({ id: store.auths.length + 1, attendance_approval_request_id: request_id, status: "AUTHORISED", authorised_by_employee_id: actor_employee_id, authorisation_reason: reason });
      return { code: 200, status: "AUTHORISED", attendance_approval_request_id: request_id };
    },
    getStoredDay: async () => store.storedDay,
    decideStage: async (args) => {
      const r = byId(args.requestId);
      const locked = lockedPeriods([args.attendanceLock]).length > 0;
      let eventId = null;
      if (locked) {
        if (args.lockedCorrection && args.decision === "APPROVED") requireAuth(args.requestId, "AUTHORISED");
        else if (!(args.allowRejectWhenLocked && args.decision === "REJECTED")) throw new Error("PAYROLL_MONTH_LOCKED");
      }
      const step = r.steps.find((s) => s.stage_no === args.stageNo);
      Object.assign(step, { decision: args.decision, decided_by_employee_id: args.actorId });
      r.status = args.next.status;
      r.current_stage_no = args.next.current_stage_no;
      r.finalization_state = r.status === "PENDING" ? "NOT_REQUIRED" : "SETTLED";
      if (locked && args.lockedCorrection && args.next.status === "APPROVED") {
        const a = requireAuth(args.requestId, "AUTHORISED");
        store.storedDay = args.calculations[0];
        eventId = appendEvent(a, "APPROVAL", args.actorId, null, args.lockedCorrection.event);
        a.status = "APPLIED";
      } else if (!locked && (args.calculations || []).length) {
        store.storedDay = args.calculations[0];
      }
      return { code: 200, status: r.status, current_stage_no: r.current_stage_no, finalization_state: r.finalization_state, locked_correction_event_id: eventId };
    },
    getRevocationSnapshot: async (id) => {
      const r = byId(id);
      return r ? { request: { ...r }, steps: r.steps.map((s) => ({ ...s })), fingerprint: `fp-${id}` } : null;
    },
    getLatestRevocation: async () => null,
    revokeRequest: async (args) => {
      const locked = lockedPeriods([{ employee_id: EMP, attendance_date: DATE }]).length > 0;
      let eventId = null;
      if (locked) {
        if (!args.lockedCorrection) throw new Error("PAYROLL_MONTH_LOCKED");
        const a = requireAuth(args.requestId, "APPLIED");
        store.storedDay = args.calculations[0];
        eventId = appendEvent(a, "REVOKE", args.actor.employee_id, args.reason, args.lockedCorrection.event);
        a.status = "REVOKED";
      }
      byId(args.requestId).status = "CANCELLED";
      return { code: 200, status: "CANCELLED", locked_correction_event_id: eventId };
    },
  };
  const regularization = buildRegularization(regRepo, calculation);
  const read = async () => (await calculation.calculateRange({ employee_id: EMP, from_date: DATE, to_date: DATE }))[0];
  return { store, calculation, regularization, read, init: async () => { store.storedDay = calculation.toStorageRow(await read()); } };
}

const approveAll = async (w, id) => {
  let out;
  for (let i = 0; i < 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    out = await w.regularization.decide({ actor: ADMIN, request_id: id, decision: "APPROVED" });
  }
  return out;
};

const MONEY = /daily_rate|net_pay|rupee|paise|payroll_difference|net_difference|PAYABLE|RECOVERABLE|PENDING_ADJUSTMENT|NETTED_OFF|adjustment|applied_/i;

describe("12-09 locked: Missing Lunch Punches with OT 235 approved - attendance and OT only", () => {
  it("raise -> authorisation required -> separate authorise -> chain -> before/after recorded -> revoke appends", async () => {
    const w = world({ punches: [raw(1, "10:09"), raw(2, "22:04")], approvedOt: 235 });
    await w.init();

    // The employee route (no allow flag) is refused in the locked month.
    await assert.rejects(
      w.regularization.raiseRequest({ actor: { employee_id: EMP, user_type: 1 }, requested_for_employee_id: EMP, attendance_date: DATE, reason: "Missing Lunch Punches", break_out_time: at("14:00"), break_in_time: at("15:00") }),
      /locked/i
    );

    const raised = await w.regularization.raiseRequest({
      actor: MANAGER, requested_for_employee_id: EMP, attendance_date: DATE, reason: "Missing Lunch Punches",
      break_out_time: at("14:00"), break_in_time: at("15:00"), allow_locked_period: true,
    });
    assert.equal(raised.locked_period_status, "REQUIRED");
    assert.equal(raised.auto_approved, false);
    const id = raised.attendance_approval_request_id;

    await assert.rejects(w.regularization.decide({ actor: ADMIN, request_id: id, decision: "APPROVED" }), /Locked-period authorisation required/);
    await assert.rejects(w.regularization.authoriseLockedCorrection({ actor: MANAGER, request_id: id, reason: "I raised it" }), /cannot authorise/);
    await assert.rejects(w.regularization.authoriseLockedCorrection({ actor: { employee_id: EMP }, request_id: id, reason: "my own day" }), /cannot authorise/);
    await assert.rejects(w.regularization.authoriseLockedCorrection({ actor: AUTHORISER, request_id: id, reason: "x" }), /at least 5/);
    assert.equal((await w.regularization.authoriseLockedCorrection({ actor: AUTHORISER, request_id: id, reason: "Lunch confirmed by store CCTV" })).status, "AUTHORISED");

    const final = await approveAll(w, id);
    assert.equal(final.status, "APPROVED");
    const lc = final.locked_correction;
    assert.deepEqual(lc.new_calculation.effective_punches.map((p) => `${p.io_time.slice(11, 16)}${p.source === "REGULARIZED" ? "*" : ""}`), ["10:09", "14:00*", "15:00*", "22:04"]);
    assert.deepEqual(lc.impact, {
      worked_minutes: { before: 685, after: 655, change: -30 },
      break_charged_minutes: { before: 30, after: 60, change: 30 },
      ot_eligible_minutes: { before: 235, after: 205, change: -30 },
      approved_ot_minutes: { before: 235, after: 205, change: -30 },
    });
    assert.ok(!MONEY.test(JSON.stringify(lc)), "no money on the event");
    assert.equal(w.store.auths[0].status, "APPLIED");
    assert.equal(w.store.events[0].authorisation_reason, "Lunch confirmed by store CCTV");
    assert.equal(w.store.storedDay.approved_ot_minutes, 205);

    // REVOKE: administrators (who hold the key), a reason, an appended event.
    await assert.rejects(w.regularization.revokeDecision({ actor: { ...ADMIN, user_type: 1 }, request_id: id, reason: "not an admin" }), /administrator/);
    const revoked = await w.regularization.revokeDecision({ actor: ADMIN, request_id: id, reason: "Lunch was punched on paper after all" });
    assert.equal(revoked.status, "CANCELLED");
    assert.deepEqual(revoked.locked_correction.impact.approved_ot_minutes, { before: 205, after: 235, change: 30 });
    assert.deepEqual(revoked.locked_correction.impact.worked_minutes, { before: 655, after: 685, change: 30 });
    assert.deepEqual(w.store.events.map((e) => [e.event_type, e.impact.approved_ot_minutes.change]), [["APPROVAL", -30], ["REVOKE", 30]]);
    assert.equal(w.store.auths[0].status, "REVOKED");
    assert.equal(w.store.storedDay.approved_ot_minutes, 235);
    assert.ok(!MONEY.test(JSON.stringify(w.store.events)), "no money on any event");
  });

  it("a held missing-punch day becomes final: the before/after shows it, OT eligible 235 now visible", async () => {
    const w = world({ punches: [raw(1, "10:09")] });
    await w.init();
    assert.equal(Number(w.store.storedDay.is_final), 0, "held: odd punches");
    const raised = await w.regularization.raiseRequest({
      actor: MANAGER, requested_for_employee_id: EMP, attendance_date: DATE, reason: "Forgot to punch out",
      punch_time: at("22:04"), allow_locked_period: true,
    });
    await w.regularization.authoriseLockedCorrection({ actor: AUTHORISER, request_id: raised.attendance_approval_request_id, reason: "Closing duty confirmed" });
    const final = await approveAll(w, raised.attendance_approval_request_id);
    assert.equal(final.locked_correction.old_calculation.is_final, false);
    assert.equal(final.locked_correction.new_calculation.is_final, true);
    assert.equal(final.locked_correction.impact.ot_eligible_minutes.after, 235);
    assert.equal(final.locked_correction.impact.approved_ot_minutes.after, 0, "a regularization approves no OT");
  });
});

describe("SEPARATION OF DUTIES on a locked-period correction", () => {
  const raiseAndAuthorise = async (w, authoriser = AUTHORISER) => {
    const raised = await w.regularization.raiseRequest({
      actor: MANAGER, requested_for_employee_id: EMP, attendance_date: DATE, reason: "Missing Lunch Punches",
      break_out_time: at("14:00"), break_in_time: at("15:00"), allow_locked_period: true,
    });
    await w.regularization.authoriseLockedCorrection({ actor: authoriser, request_id: raised.attendance_approval_request_id, reason: "Lunch confirmed" });
    return raised.attendance_approval_request_id;
  };

  it("the authoriser cannot approve any stage - not even through an administrator override", async () => {
    const w = world({ punches: [raw(1, "10:09"), raw(2, "22:04")], approvedOt: 235 });
    await w.init();
    const adminAuthoriser = { employee_id: 901, user_id: 6, user_type: 2 };
    const id = await raiseAndAuthorise(w, adminAuthoriser);
    await assert.rejects(w.regularization.decide({ actor: adminAuthoriser, request_id: id, decision: "APPROVED" }), /another approver must approve/);
    // Another administrator (or eligible approver) carries it through.
    const out = await approveAll(w, id);
    assert.equal(out.status, "APPROVED");
    w.store.requests.find((r) => r.attendance_approval_request_id === id).steps.forEach((st) => {
      assert.notEqual(st.decided_by_employee_id, adminAuthoriser.employee_id);
    });
  });

  it("someone who already decided a stage cannot then authorise", async () => {
    const w = world({ punches: [raw(1, "10:09"), raw(2, "22:04")], approvedOt: 235 });
    await w.init();
    const raised = await w.regularization.raiseRequest({
      actor: MANAGER, requested_for_employee_id: EMP, attendance_date: DATE, reason: "Missing Lunch Punches",
      break_out_time: at("14:00"), break_in_time: at("15:00"), allow_locked_period: true,
    });
    const req = w.store.requests.find((r) => r.attendance_approval_request_id === raised.attendance_approval_request_id);
    Object.assign(req.steps[0], { decision: "APPROVED", decided_by_employee_id: AUTHORISER.employee_id });
    await assert.rejects(
      w.regularization.authoriseLockedCorrection({ actor: AUTHORISER, request_id: raised.attendance_approval_request_id, reason: "Lunch confirmed" }),
      /already decided a stage/
    );
  });

  it("the authoriser may still reject, and unlocked-date approvals are unaffected", async () => {
    const w = world({ punches: [raw(1, "10:09"), raw(2, "22:04")], approvedOt: 235 });
    await w.init();
    const adminAuthoriser = { employee_id: 901, user_id: 6, user_type: 2 };
    const id = await raiseAndAuthorise(w, adminAuthoriser);
    const rejected = await w.regularization.decide({ actor: adminAuthoriser, request_id: id, decision: "REJECTED", remarks: "Not supported by evidence" });
    assert.equal(rejected.status, "REJECTED");
  });
});

describe("the approval list does not offer the authoriser a stage", () => {
  const listWorld = (authorisedBy) => {
    const row = {
      attendance_approval_request_id: 900, request_type: "REGULARIZATION", status: "PENDING", requested_for_employee_id: EMP,
      requested_by_employee_id: 7, employee_name: "Staff", attendance_date: DATE, outlet_id: 3, outlet_name: "S",
      reason: "Missing Lunch Punches", candidate_ot_minutes: 0, approved_ot_minutes: null, current_stage_no: 1, total_stages: 1,
      finalization_state: "NOT_REQUIRED", closure_reason: null, chain_source: "ROLE",
      locked_period_status: "AUTHORISED", locked_period_authorised_by: authorisedBy,
    };
    const regRepo = {
      getApprovalIdentity: async (id) => ({ employee_id: id, employee_name: "A", outlet_id: 1, approver_role: null, requester_class: null }),
      listApprovals: async () => [row],
      countApprovals: async () => 1,
      listStepsForRequests: async () => [{ attendance_approval_request_id: 900, attendance_approval_step_id: 1, stage_no: 1, approver_role: "HR", outlet_id: null, decision: "PENDING" }],
      listRevocationsForRequests: async () => [],
    };
    return buildRegularization(regRepo, { calculateRange: async () => [] });
  };
  const admin = (id) => ({ employee_id: id, user_type: 2, branch_scope: { kind: "ALL_BRANCHES" } });

  it("the authorising administrator sees it not actionable, with the reason; another administrator can act", async () => {
    const mine = await listWorld(901).listApprovals({ actor: admin(901), request_type: "REGULARIZATION", status: "PENDING" });
    assert.equal(mine.rows[0].actionable, false);
    assert.match(mine.rows[0].not_actionable_reason, /another approver must approve/);
    assert.equal(mine.rows[0].locked_period_status, "AUTHORISED");
    const other = await listWorld(901).listApprovals({ actor: admin(902), request_type: "REGULARIZATION", status: "PENDING" });
    assert.equal(other.rows[0].actionable, true);
  });
});


describe("the approval list does not offer the authoriser a stage", () => {
  const listWorld = (authorisedBy) => {
    const row = {
      attendance_approval_request_id: 900, request_type: "REGULARIZATION", status: "PENDING", requested_for_employee_id: EMP,
      requested_by_employee_id: 7, employee_name: "Staff", attendance_date: DATE, outlet_id: 3, outlet_name: "S",
      reason: "Missing Lunch Punches", candidate_ot_minutes: 0, approved_ot_minutes: null, current_stage_no: 1, total_stages: 1,
      finalization_state: "NOT_REQUIRED", closure_reason: null, chain_source: "ROLE",
      locked_period_status: "AUTHORISED", locked_period_authorised_by: authorisedBy,
    };
    const regRepo = {
      getApprovalIdentity: async (id) => ({ employee_id: id, employee_name: "A", outlet_id: 1, approver_role: null, requester_class: null }),
      listApprovals: async () => [row],
      countApprovals: async () => 1,
      listStepsForRequests: async () => [{ attendance_approval_request_id: 900, attendance_approval_step_id: 1, stage_no: 1, approver_role: "HR", outlet_id: null, decision: "PENDING" }],
      listRevocationsForRequests: async () => [],
    };
    return buildRegularization(regRepo, { calculateRange: async () => [] });
  };
  const admin = (id) => ({ employee_id: id, user_type: 2, branch_scope: { kind: "ALL_BRANCHES" } });

  it("the authorising administrator sees it not actionable, with the reason; another administrator can act", async () => {
    const mine = await listWorld(901).listApprovals({ actor: admin(901), request_type: "REGULARIZATION", status: "PENDING" });
    assert.equal(mine.rows[0].actionable, false);
    assert.match(mine.rows[0].not_actionable_reason, /another approver must approve/);
    assert.equal(mine.rows[0].locked_period_status, "AUTHORISED");
    const other = await listWorld(901).listApprovals({ actor: admin(902), request_type: "REGULARIZATION", status: "PENDING" });
    assert.equal(other.rows[0].actionable, true);
  });
});
