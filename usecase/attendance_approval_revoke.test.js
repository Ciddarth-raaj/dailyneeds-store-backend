/**
 * ADMIN REVOKE = VOID - the rule, the day without the request, a fresh
 * request afterwards, and the HTTP boundary.
 *
 *   node --test usecase/attendance_approval_revoke.test.js
 *
 * The REAL `attendance_regularization` and `attendance_calculation` usecases
 * over fakes that return what the real queries return. The transaction itself
 * - resets, audit, day row, payroll lock, rollback, the race - is proven
 * against MariaDB in `repository/attendance_approval_revoke.mysql.test.js`;
 * this file proves what the usecase hands that transaction: who may ask, what
 * may be revoked, and above all the DAY it computes for the reopened request,
 * by the production engine, and that a CANCELLED request frees the date for
 * a fresh one.
 *
 *   GEN  09:00-18:00, 60m break  NRM 480, OT allowed
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildCalculation = require("./attendance_calculation");
const buildRegularization = require("./attendance_regularization");
const buildRoutes = require("../routes/attendance_regularization");

const EMP = 42;
const DATE = "2026-09-10"; // a Thursday, long closed
const ADMIN = { employee_id: 900, user_id: 5, user_type: 2 };

const weekly = (id, inTime, outTime, breakMinutes) =>
  Array.from({ length: 7 }, (_, day) => ({
    work_shift_weekly_schedule_id: id * 100 + day, work_shift_id: id, day_of_week: day, is_working_day: 1,
    in_time: inTime, out_time: outTime, attendance_day_cutoff: "04:00:00", break_minutes: breakMinutes, ot_rate: 1,
  }));
const GEN = {
  config: {
    work_shift_id: 1, shift_code: "GEN", shift_name: "General", active: 1, overtime_allowed: 1,
    overtime_minimum_minutes: 0, overtime_rounding_method: "NONE", overtime_rounding_interval_minutes: 0,
    pre_shift_overtime_allowed: 0, late_offset_against_overtime: 0, early_exit_offset_against_overtime: 0,
  },
  schedule: weekly(1, "09:00:00", "18:00:00", 60),
};

const punch = (id, ioTime) => ({
  punch_id: id, employee_id: EMP, io_time: ioTime, punch_date: ioTime.slice(0, 10),
  ingest_attendance_date: ioTime.slice(0, 10), dev_id: "DEV1", ingest_source: "DEVICE",
});

/** A three-stage chain, every stage decided as given. */
const chain = (decisions) =>
  decisions.map((decision, i) => ({
    attendance_approval_step_id: 100 + i, stage_no: i + 1, approver_role: "EMPLOYEE", outlet_id: null,
    approver_employee_id: [7, 8, 9][i], approval_level: ["FIRST", "SECOND", "FINAL"][i], decision,
    decided_by_employee_id: decision === "PENDING" ? null : [7, 8, 9][i],
    decided_at: decision === "PENDING" ? null : "2026-09-11 10:00:00.000000",
    remarks: null, acted_as_admin_override: 0, decision_source: decision === "PENDING" ? null : "WEB",
  }));

function world({ request, punches, regularizedPunchTime = null, lockedMonths = [] }) {
  const calls = { revokeRequest: [], createRequest: [] };
  const store = { request: { ...request } };

  const calcRepo = {
    getShiftAssignmentHistory: async () => [
      { employee_work_shift_assignment_id: 1, employee_id: EMP, work_shift_id: 1, effective_from: "2026-09-01" },
    ],
    getDateShiftOverrides: async () => [],
    getWorkShiftWithSchedule: async (id) => (id === 1 ? GEN : null),
    getWorkShiftConfigVersions: async () => [],
    listActiveWorkShiftOptions: async () => [GEN.config],
    getRawPunchesByCalendarWindow: async (id, from, to) =>
      punches.filter((p) => p.punch_date >= from && p.punch_date <= to),
    // THE STORED STATE, as the real queries answer it: an APPROVED+SETTLED
    // correction's punch counts, and the request row is what it is.
    getApprovedRegularizedPunches: async () =>
      regularizedPunchTime && store.request.status === "APPROVED" && store.request.finalization_state === "SETTLED"
        ? [{ attendance_regularized_punch_id: 55, attendance_approval_request_id: store.request.attendance_approval_request_id, employee_id: EMP, attendance_date: DATE, io_time: regularizedPunchTime, punch_id: null }]
        : [],
    // `status <> 'CANCELLED'`, as the real query.
    getApprovalStateByDate: async () =>
      store.request.status === "CANCELLED" ? [] : [{ ...store.request, rejection_remarks: null }],
    getBreakOverride: async () => null,
    getEmploymentWindow: async () => ({ employee_id: EMP, date_of_joining: "2020-01-01", resignation_date: null }),
    findPayrollLockedPeriods: async (rows) =>
      (rows || [])
        .map((r) => ({ employee_id: Number(r.employee_id), year: Number(r.attendance_date.slice(0, 4)), month: Number(r.attendance_date.slice(5, 7)) }))
        .filter((p) => lockedMonths.includes(`${p.year}-${p.month}`)),
  };
  const calculation = buildCalculation(calcRepo);

  const regRepo = {
    getRevocationSnapshot: async (id) =>
      Number(id) === Number(store.request.attendance_approval_request_id)
        ? { request: { ...store.request }, steps: store.request.steps.map((s) => ({ ...s })), fingerprint: `fp-${id}` }
        : null,
    getLatestRevocation: async () => store.priorRevocation || null,
    // What the transaction is handed; applied here only so a follow-up call
    // sees the CANCELLED request. The real write is the MariaDB suite's.
    revokeRequest: async (args) => {
      calls.revokeRequest.push(args);
      store.request.status = "CANCELLED";
      store.request.approved_ot_minutes = 0;
      return { code: 200, status: "CANCELLED", calculations_written: args.calculations.length };
    },
    // `status <> 'CANCELLED'`, as the real query.
    findRequestsForDates: async () => (store.request.status === "CANCELLED" ? [] : [store.request]),
    findOpenRequest: async () => (store.request.status === "PENDING" ? store.request : null),
    createRequest: async (args) => {
      calls.createRequest.push(args);
      return { attendance_approval_request_id: 172, total_stages: args.chain.length };
    },
    getApprovalIdentity: async (id) => ({ employee_id: id, employee_name: "X", outlet_id: 3, approver_role: null, requester_class: null }),
  };
  const regularization = buildRegularization(regRepo, calculation);
  return { calculation, regularization, calls, store, calcRepo };
}

const OT_REQUEST = {
  attendance_approval_request_id: 71, request_type: "OT", requested_for_employee_id: EMP, requested_by_employee_id: EMP,
  attendance_date: DATE, reason: "stock audit", candidate_ot_minutes: 180, approved_ot_minutes: 180,
  status: "APPROVED", current_stage_no: 3, total_stages: 3, finalization_state: "SETTLED",
  closure_reason: null, auto_created: 0, decided_at: "2026-09-11 10:00:00.000000",
  steps: chain(["APPROVED", "APPROVED", "APPROVED"]),
};
const REG_REQUEST = {
  ...OT_REQUEST, attendance_approval_request_id: 72, request_type: "REGULARIZATION",
  candidate_ot_minutes: 0, approved_ot_minutes: 0, reason: "forgot to punch out",
};
const OT_DAY = [punch(1, `${DATE} 09:00:00`), punch(2, `${DATE} 21:00:00`)];

const revoke = (w, extra = {}) =>
  w.regularization.revokeDecision({ actor: ADMIN, request_id: 71, reason: "approved by mistake", ...extra });

describe("what revoking does to the day, and to the employee's next request", () => {
  it("1./8. OT: before, the day pays 180 approved OT; the day handed to the transaction is the day WITHOUT the request", async () => {
    const w = world({ request: OT_REQUEST, punches: OT_DAY });
    const [before] = await w.calculation.calculateRange({ employee_id: EMP, from_date: DATE, to_date: DATE });
    assert.equal(before.approved_ot_minutes, 180, "sanity: the stored approval pays today");

    const out = await revoke(w);
    assert.equal(out.code, 200);
    assert.equal(out.status, "CANCELLED");
    assert.equal(w.calls.revokeRequest.length, 1);
    const call = w.calls.revokeRequest[0];
    assert.equal(call.requestId, 71);
    assert.equal(call.stageNo, 3, "the stage that DECIDED the request is the one recorded");
    assert.equal(call.originalDecision, "APPROVED");
    assert.equal(call.employeeId, EMP, "the employee comes from the stored request");
    assert.equal(call.expectedFingerprint, "fp-71", "the transaction is told exactly what was read");
    assert.equal(call.reason, "approved by mistake");
    assert.deepEqual(call.actor, { employee_id: 900, user_id: 5 });
    assert.equal(call.calculations.length, 1, "a closed day is rewritten in the same transaction");
    const row = call.calculations[0];
    assert.equal(row.employee_id, EMP);
    assert.equal(row.attendance_date, DATE);
    assert.equal(row.approved_ot_minutes, 0, "payroll sees zero payable OT from the revoked request");
    assert.equal(row.ot_request_approved_minutes, 0);
    assert.equal(Number(row.candidate_ot_minutes), 180, "the OT is still there to be claimed");
  });

  it("4. after the revoke the day reads NOT REQUESTED - OT AVAILABLE, with no request against it", async () => {
    const w = world({ request: OT_REQUEST, punches: OT_DAY });
    await revoke(w);
    const [after] = await w.calculation.calculateRange({ employee_id: EMP, from_date: DATE, to_date: DATE });
    assert.equal(after.ot_claim_state, "AVAILABLE", "the screen's Not Requested + Request OT");
    assert.equal(after.ot_request_id, null);
    assert.equal(after.approved_ot_minutes, 0);
  });

  it("5./6. the employee can request OT again for that date - a NEW request, a fresh chain", async () => {
    const w = world({ request: OT_REQUEST, punches: OT_DAY });
    await revoke(w);
    const raised = await w.regularization.raiseOtRequest({
      actor: { employee_id: EMP }, attendance_date: DATE, reason: "stock audit - again", today: "2026-09-25",
    });
    assert.equal(raised.attendance_approval_request_id, 172, "a new request id");
    assert.notEqual(raised.attendance_approval_request_id, 71);
    assert.equal(w.calls.createRequest.length, 1);
    const created = w.calls.createRequest[0];
    assert.equal(created.request.request_type, "OT");
    assert.equal(created.request.candidate_ot_minutes, 180);
    assert.ok(created.chain.length > 0 && created.chain[0].stage_no === 1, "a fresh chain from its first stage");
  });

  it("before a revoke, the one-OT-claim rule still refuses a second request", async () => {
    const w = world({ request: OT_REQUEST, punches: OT_DAY });
    await assert.rejects(
      () => w.regularization.raiseOtRequest({ actor: { employee_id: EMP }, attendance_date: DATE, reason: "again please", today: "2026-09-25" }),
      /An OT request for 2026-09-10 has already been approved \(#71\)/
    );
  });

  it("9. REGULARIZATION: the approved punch is not in the day handed to the transaction", async () => {
    const w = world({ request: { ...REG_REQUEST }, punches: [punch(1, `${DATE} 09:00:00`)], regularizedPunchTime: `${DATE} 18:00:00` });
    const [before] = await w.calculation.calculateRange({ employee_id: EMP, from_date: DATE, to_date: DATE });
    assert.equal(before.punch_count, 2, "sanity: today the approved punch completes the day");

    await w.regularization.revokeDecision({ actor: ADMIN, request_id: 72, reason: "wrong punch time" });
    const row = w.calls.revokeRequest[0].calculations[0];
    assert.equal(row.punch_count, 1, "the regularized punch is gone from the day");
    assert.ok(!String(row.effective_punches).includes("18:00"), "and from its effective punches");
  });

  it("10. REJECTED correction: voided, and a fresh correction for the incomplete day is accepted", async () => {
    const rejected = { ...REG_REQUEST, status: "REJECTED", current_stage_no: 2, approved_ot_minutes: null, steps: chain(["APPROVED", "REJECTED", "PENDING"]) };
    const w = world({ request: rejected, punches: [punch(1, `${DATE} 09:00:00`)] });
    const out = await w.regularization.revokeDecision({ actor: ADMIN, request_id: 72, reason: "rejected in error" });
    assert.equal(out.code, 200);
    assert.equal(w.calls.revokeRequest[0].stageNo, 2, "the REJECTED stage is the deciding one");
    assert.equal(w.calls.revokeRequest[0].originalDecision, "REJECTED");
    const raised = await w.regularization.raiseRequest({
      actor: { employee_id: EMP, user_type: 1 }, requested_for_employee_id: EMP, attendance_date: DATE, punch_time: `${DATE} 18:00:00`, reason: "forgot to punch out", today: "2026-09-25",
    });
    assert.equal(raised.attendance_approval_request_id, 172);
  });

  it("a stage may be named, and must be a decided one", async () => {
    const w = world({ request: OT_REQUEST, punches: OT_DAY });
    await revoke(w, { stage_no: 2 });
    assert.equal(w.calls.revokeRequest[0].stageNo, 2);
    const w2 = world({ request: { ...OT_REQUEST, status: "REJECTED", steps: chain(["APPROVED", "REJECTED", "PENDING"]) }, punches: OT_DAY });
    await assert.rejects(() => revoke(w2, { stage_no: 3 }), /Stage 3 has no decision to revoke/);
  });
});

describe("who may revoke, and what", () => {
  const refusedAs = async (actor) => {
    const w = world({ request: OT_REQUEST, punches: OT_DAY });
    await assert.rejects(() => revoke(w, { actor }), (err) => err.name === "ForbiddenError");
    assert.equal(w.calls.revokeRequest.length, 0, "the transaction is never reached");
  };

  it("6. an ordinary user is refused", () => refusedAs({ employee_id: 42, user_type: 1 }));
  it("7. HR is refused unless the ACCOUNT is an administrator (user_type 2)", () => refusedAs({ employee_id: 60, user_type: 1, approver_roles: ["HR"] }));
  it("8. the named approver of the very stage is refused", () => refusedAs({ employee_id: 9, user_type: 1 }));
  it("no user_type at all is refused", () => refusedAs({ employee_id: 900 }));

  it("an administrator is accepted, whether the token says 2 or \"2\"", async () => {
    const w = world({ request: OT_REQUEST, punches: OT_DAY });
    assert.equal((await revoke(w, { actor: { ...ADMIN, user_type: "2" } })).code, 200);
  });

  it("10. a reason is mandatory - blank, short and missing are refused", async () => {
    for (const reason of [undefined, "", "   ", "oops"]) {
      const w = world({ request: OT_REQUEST, punches: OT_DAY });
      /* eslint-disable-next-line no-await-in-loop */
      await assert.rejects(() => revoke(w, { reason }), /reason of at least 5 characters/);
      assert.equal(w.calls.revokeRequest.length, 0);
    }
  });

  it("9. a payroll-locked month is refused before anything is computed", async () => {
    const w = world({ request: OT_REQUEST, punches: OT_DAY, lockedMonths: ["2026-9"] });
    await assert.rejects(() => revoke(w), (err) => err.code === "PAYROLL_MONTH_LOCKED" && /This revocation/.test(err.message));
    assert.equal(w.calls.revokeRequest.length, 0);
  });

  it("a request still in approval is refused - there is no decision to void; an approver can reject it", async () => {
    const w = world({ request: { ...OT_REQUEST, status: "PENDING", current_stage_no: 2, approved_ot_minutes: null, steps: chain(["APPROVED", "PENDING", "PENDING"]) }, punches: OT_DAY });
    await assert.rejects(() => revoke(w), /still in approval/);
    assert.equal(w.calls.revokeRequest.length, 0);
  });

  it("a request the EARLIER reopening revoke left pending is voided, with the decision that revoke recorded", async () => {
    const w = world({ request: { ...OT_REQUEST, status: "PENDING", current_stage_no: 3, approved_ot_minutes: null, steps: chain(["APPROVED", "APPROVED", "PENDING"]) }, punches: OT_DAY });
    w.store.priorRevocation = { revoked_stage_no: 3, original_decision: "APPROVED" };
    assert.equal((await revoke(w)).code, 200);
    assert.equal(w.calls.revokeRequest[0].stageNo, 3);
    assert.equal(w.calls.revokeRequest[0].originalDecision, "APPROVED");
  });

  it("an already-revoked request is refused", async () => {
    const w = world({ request: { ...OT_REQUEST, status: "CANCELLED" }, punches: OT_DAY });
    await assert.rejects(() => revoke(w), /already been revoked/);
  });

  it("14. a SHIFT_CHANGE decision is refused", async () => {
    const w = world({ request: { ...OT_REQUEST, request_type: "SHIFT_CHANGE" }, punches: OT_DAY });
    await assert.rejects(() => revoke(w), /shift change decision cannot be revoked/);
    assert.equal(w.calls.revokeRequest.length, 0);
  });

  it("a payroll-lock CLOSURE, a missing stage and a missing request are refused", async () => {
    const closed = world({ request: { ...OT_REQUEST, status: "REJECTED", closure_reason: "NOT_APPROVED_BEFORE_PAYROLL_LOCK" }, punches: OT_DAY });
    await assert.rejects(() => revoke(closed), /closed by the payroll lock/);
    const w = world({ request: OT_REQUEST, punches: OT_DAY });
    await assert.rejects(() => revoke(w, { stage_no: 4 }), /no stage 4/);
    await assert.rejects(() => revoke(w, { request_id: 999 }), /No such request/);
    assert.equal(w.calls.revokeRequest.length + closed.calls.revokeRequest.length, 0);
  });

  it("14. revoking never touches the shift-change path: no override is written, none is assumed", async () => {
    const w = world({ request: OT_REQUEST, punches: OT_DAY });
    await revoke(w);
    const [after] = await w.calculation.calculateRange({ employee_id: EMP, from_date: DATE, to_date: DATE });
    assert.equal(after.work_shift_id, 1, "the date keeps its own shift");
  });
});

/* ======================================================= the HTTP boundary */

function fakeRes() {
  const res = { statusCode: 200, body: null, ended: false };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; res.ended = true; return res; };
  return res;
}
async function post(routes, path, req) {
  for (const layer of routes.getRouter().stack) {
    if (!layer.route || layer.route.path !== path || !layer.route.methods.post) continue;
    const res = fakeRes();
    for (const handler of layer.route.stack) {
      let advanced = false;
      // eslint-disable-next-line no-await-in-loop
      await handler.handle(req, res, () => { advanced = true; });
      if (res.ended || !advanced) return res;
    }
    return res;
  }
  throw new Error(`no route for POST ${path}`);
}
const allowAll = { has: async () => true, hasAll: async () => true, require: () => (req, res, next) => next(), requireAll: () => (req, res, next) => next() };
const PATH = "/attendance/approvals/:request_id/revoke";

describe("POST /attendance/approvals/:request_id/revoke", () => {
  const spy = () => {
    const calls = [];
    return {
      calls,
      revokeDecision: async (args) => { calls.push(args); return { code: 200, status: "PENDING" }; },
    };
  };
  const req = (decoded, body) => ({ decoded, params: { request_id: "71" }, body, query: {} });

  it("refuses every non-administrator with a 403 before the usecase is reached - whatever keys they hold", async () => {
    for (const decoded of [
      { id: 1, employee_id: 42, user_type: 1 },
      { id: 2, employee_id: 60, user_type: 1, designation_id: 3 }, // HR, with every key (allowAll)
      { id: 3, employee_id: 9, user_type: 1 }, // the named approver
    ]) {
      const usecase = spy();
      /* eslint-disable-next-line no-await-in-loop */
      const res = await post(buildRoutes(usecase, allowAll, null, null), PATH, req(decoded, { stage_no: 3, reason: "approved by mistake" }));
      assert.equal(res.statusCode, 403);
      // Worded as the permission middleware's refusal, which the web app
      // shows as an answer - any other 403 body signs the user out.
      assert.equal(res.body.msg, "You do not have permission to perform this action");
      assert.equal(res.body.error, "ADMIN_ONLY");
      assert.equal(usecase.calls.length, 0);
    }
  });

  it("401 without a session", async () => {
    const usecase = spy();
    const res = await post(buildRoutes(usecase, allowAll, null, null), PATH, req(undefined, { stage_no: 3, reason: "approved by mistake" }));
    assert.equal(res.statusCode, 401);
    assert.equal(usecase.calls.length, 0);
  });

  it("an administrator reaches the usecase with the id from the path, the actor from the token and nothing else", async () => {
    const usecase = spy();
    const res = await post(buildRoutes(usecase, allowAll, null, null), PATH, req({ id: 5, employee_id: 900, user_type: 2 }, { stage_no: 2, reason: "approved by mistake" }));
    assert.equal(res.statusCode, 200);
    assert.deepEqual(usecase.calls, [
      { actor: { employee_id: 900, user_id: 5, user_type: 2 }, request_id: 71, stage_no: 2, reason: "approved by mistake" },
    ]);
  });

  it("the body cannot carry the type, the employee, the decision, the minutes or the actor", async () => {
    for (const extra of [{ request_type: "OT" }, { employee_id: 42 }, { approved_ot_minutes: 0 }, { original_decision: "APPROVED" }, { actor: 1 }]) {
      const usecase = spy();
      /* eslint-disable-next-line no-await-in-loop */
      const res = await post(buildRoutes(usecase, allowAll, null, null), PATH, req({ id: 5, employee_id: 900, user_type: 2 }, { stage_no: 2, reason: "approved by mistake", ...extra }));
      assert.equal(res.statusCode, 400, JSON.stringify(extra));
      assert.equal(usecase.calls.length, 0);
    }
  });

  it("the stage is OPTIONAL: a reason alone voids the request, with the deciding stage found by the server", async () => {
    const usecase = spy();
    const res = await post(buildRoutes(usecase, allowAll, null, null), PATH, req({ id: 5, employee_id: 900, user_type: 2 }, { reason: "approved by mistake" }));
    assert.equal(res.statusCode, 200);
    assert.deepEqual(usecase.calls, [
      { actor: { employee_id: 900, user_id: 5, user_type: 2 }, request_id: 71, stage_no: null, reason: "approved by mistake" },
    ]);
  });

  it("a missing or short reason, or a stage that is not a stage, is a 400", async () => {
    for (const body of [{ stage_no: 2 }, { stage_no: 2, reason: "oops" }, {}, { stage_no: 0, reason: "approved by mistake" }]) {
      const usecase = spy();
      /* eslint-disable-next-line no-await-in-loop */
      const res = await post(buildRoutes(usecase, allowAll, null, null), PATH, req({ id: 5, employee_id: 900, user_type: 2 }, body));
      assert.equal(res.statusCode, 400, JSON.stringify(body));
    }
  });

  it("a 409 from the transaction is a 409 on the wire", async () => {
    const usecase = { revokeDecision: async () => ({ code: 409, msg: "This request changed while you were revoking it - reload and try again" }) };
    const res = await post(buildRoutes(usecase, allowAll, null, null), PATH, req({ id: 5, employee_id: 900, user_type: 2 }, { stage_no: 2, reason: "approved by mistake" }));
    assert.equal(res.statusCode, 409);
  });
});

/* ======================================== the screen is told what it may offer */

describe("listApprovals: `revocable` per REQUEST, for administrators only; a revoked request shows as revoked", () => {
  const listWorld = (status = "APPROVED", revocations = []) => {
    const row = {
      attendance_approval_request_id: 71, request_type: "OT", status, requested_for_employee_id: EMP,
      requested_by_employee_id: EMP, employee_name: "Staff", attendance_date: DATE, outlet_id: 3, outlet_name: "S",
      reason: "x", candidate_ot_minutes: 180, approved_ot_minutes: status === "CANCELLED" ? 0 : 180, current_stage_no: 3, total_stages: 3,
      finalization_state: "SETTLED", closure_reason: null, chain_source: "EMPLOYEE",
    };
    const regRepo = {
      getApprovalIdentity: async (id) => ({ employee_id: id, employee_name: "A", outlet_id: 1, approver_role: null, requester_class: null }),
      listApprovals: async () => [row],
      countApprovals: async () => 1,
      listStepsForRequests: async () => chain(["APPROVED", "APPROVED", "APPROVED"]).map((s) => ({ ...s, attendance_approval_request_id: 71 })),
      listRevocationsForRequests: async () => revocations,
    };
    return buildRegularization(regRepo, { calculateRange: async () => [] });
  };
  const AUDIT = [{
    attendance_approval_revocation_id: 1, attendance_approval_request_id: 71, revoked_stage_no: 3,
    revoked_approval_level: "FINAL", original_decision: "APPROVED", original_decided_by_name: "Final",
    original_decided_at: "2026-09-11 10:00:00", original_request_status: "APPROVED", original_approved_ot_minutes: 95,
    revoked_by_employee_id: 900, revoked_by_name: "Admin", revoked_at: "2026-09-12 09:00:00", reason: "approved by mistake",
  }];
  const admin = { employee_id: 900, user_type: 2, branch_scope: { kind: "ALL_BRANCHES" } };

  it("an administrator is offered Revoke on an APPROVED or REJECTED request", async () => {
    for (const status of ["APPROVED", "REJECTED"]) {
      /* eslint-disable-next-line no-await-in-loop */
      const out = await listWorld(status).listApprovals({ actor: admin, request_type: "OT", status: "ALL" });
      assert.equal(out.rows[0].revocable, true, status);
      assert.equal(out.rows[0].revoked, false);
    }
  });

  it("nobody else is offered it", async () => {
    const out = await listWorld().listApprovals({ actor: { employee_id: 9, user_type: 1, branch_scope: { kind: "ALL_BRANCHES" } }, request_type: "OT", status: "ALL" });
    assert.equal(out.rows[0].revocable, false);
  });

  it("11. a revoked request: CANCELLED, flagged revoked, not revocable again, its chain decisions and its audit intact", async () => {
    const out = await listWorld("CANCELLED", AUDIT).listApprovals({ actor: admin, request_type: "OT", status: "ALL" });
    const row = out.rows[0];
    assert.equal(row.status, "CANCELLED");
    assert.equal(row.revoked, true);
    assert.equal(row.revocable, false);
    assert.deepEqual(row.chain.map((s) => s.decision), ["APPROVED", "APPROVED", "APPROVED"], "the old chain is history, unchanged");
    assert.deepEqual(row.revocations.map((v) => [v.revoked_stage_no, v.original_decision, v.original_approved_ot_minutes, v.reason]), [[3, "APPROVED", 95, "approved by mistake"]]);
  });
});
