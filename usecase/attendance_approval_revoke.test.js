/**
 * ADMIN REVOKE - the rule, the reopened day, and the HTTP boundary.
 *
 *   node --test usecase/attendance_approval_revoke.test.js
 *
 * The REAL `attendance_regularization` and `attendance_calculation` usecases
 * over fakes that return what the real queries return. The transaction itself
 * - resets, audit, day row, payroll lock, rollback, the race - is proven
 * against MariaDB in `repository/attendance_approval_revoke.mysql.test.js`;
 * this file proves what the usecase hands that transaction: who may ask, what
 * may be revoked, and above all the DAY it computes for the reopened request,
 * by the production engine.
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
  const calls = { revokeStage: [] };
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
        ? [{ attendance_regularized_punch_id: 55, employee_id: EMP, attendance_date: DATE, io_time: regularizedPunchTime, punch_id: null }]
        : [],
    getApprovalStateByDate: async () => [{ ...store.request, rejection_remarks: null }],
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
    // What the transaction is handed; applied here only so a follow-up call
    // sees the reopened request. The real reset is the MariaDB suite's.
    revokeStage: async (args) => {
      calls.revokeStage.push(args);
      store.request.status = "PENDING";
      store.request.current_stage_no = args.stageNo;
      store.request.approved_ot_minutes = null;
      store.request.finalization_state = "NOT_REQUIRED";
      store.request.steps = store.request.steps.map((s) =>
        s.stage_no >= args.stageNo ? { ...s, decision: "PENDING", decided_by_employee_id: null, decided_at: null } : s
      );
      return { code: 200, status: "PENDING", current_stage_no: args.stageNo, calculations_written: args.calculations.length };
    },
    findRequestsForDates: async () => [store.request],
    getApprovalIdentity: async (id) => ({ employee_id: id, employee_name: "X", outlet_id: 3, approver_role: null, requester_class: null }),
  };
  const regularization = buildRegularization(regRepo, calculation);
  return { calculation, regularization, calls, store };
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
  w.regularization.revokeDecision({ actor: ADMIN, request_id: 71, stage_no: 3, reason: "approved by mistake", ...extra });

describe("what revoking does to the day", () => {
  it("1. OT: before, the day pays 180 approved OT; the revoked day handed to the transaction pays 0", async () => {
    const w = world({ request: OT_REQUEST, punches: OT_DAY });
    const [before] = await w.calculation.calculateRange({ employee_id: EMP, from_date: DATE, to_date: DATE });
    assert.equal(before.approved_ot_minutes, 180, "sanity: the stored approval pays today");

    const out = await revoke(w);
    assert.equal(out.code, 200);
    assert.equal(w.calls.revokeStage.length, 1);
    const call = w.calls.revokeStage[0];
    assert.equal(call.requestId, 71);
    assert.equal(call.stageNo, 3);
    assert.equal(call.employeeId, EMP, "the employee comes from the stored request");
    assert.equal(call.expectedFingerprint, "fp-71", "the transaction is told exactly what was read");
    assert.equal(call.reason, "approved by mistake");
    assert.deepEqual(call.actor, { employee_id: 900, user_id: 5 });
    assert.equal(call.calculations.length, 1, "a closed day is rewritten in the same transaction");
    const row = call.calculations[0];
    assert.equal(row.employee_id, EMP);
    assert.equal(row.attendance_date, DATE);
    assert.equal(row.approved_ot_minutes, 0, "payroll sees zero payable OT from the reopened request");
    assert.equal(row.ot_request_approved_minutes, 0);
    assert.equal(Number(row.candidate_ot_minutes), 180, "the OT is still AVAILABLE - the claim is simply pending again");
  });

  it("2. REGULARIZATION: the approved punch stops being effective in the revoked day", async () => {
    const w = world({ request: { ...REG_REQUEST }, punches: [punch(1, `${DATE} 09:00:00`)], regularizedPunchTime: `${DATE} 18:00:00` });
    const [before] = await w.calculation.calculateRange({ employee_id: EMP, from_date: DATE, to_date: DATE });
    assert.equal(before.punch_count, 2, "sanity: today the approved punch completes the day");

    await w.regularization.revokeDecision({ actor: ADMIN, request_id: 72, stage_no: 3, reason: "wrong punch time" });
    const row = w.calls.revokeStage[0].calculations[0];
    assert.equal(row.punch_count, 1, "the regularized punch is gone from the day");
    assert.ok(!String(row.effective_punches).includes("18:00"), "and from its effective punches");
    assert.equal(Number(row.is_final), 0, "the date is held out of payroll again while the correction is pending");
  });

  it("3./4./5. the stage asked for is the stage reopened - earlier stages are the transaction's to keep", async () => {
    for (const stage of [1, 2, 3]) {
      const w = world({ request: OT_REQUEST, punches: OT_DAY });
      /* eslint-disable-next-line no-await-in-loop */
      await revoke(w, { stage_no: stage });
      assert.equal(w.calls.revokeStage[0].stageNo, stage);
    }
    const rejected = world({ request: { ...OT_REQUEST, status: "REJECTED", current_stage_no: 2, approved_ot_minutes: null, steps: chain(["APPROVED", "REJECTED", "PENDING"]) }, punches: OT_DAY });
    assert.equal((await revoke(rejected, { stage_no: 2 })).code, 200, "a REJECTED stage can be revoked too");
  });
});

describe("who may revoke, and what", () => {
  const refusedAs = async (actor) => {
    const w = world({ request: OT_REQUEST, punches: OT_DAY });
    await assert.rejects(() => revoke(w, { actor }), (err) => err.name === "ForbiddenError");
    assert.equal(w.calls.revokeStage.length, 0, "the transaction is never reached");
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
      assert.equal(w.calls.revokeStage.length, 0);
    }
  });

  it("9. a payroll-locked month is refused before anything is computed", async () => {
    const w = world({ request: OT_REQUEST, punches: OT_DAY, lockedMonths: ["2026-9"] });
    await assert.rejects(() => revoke(w), (err) => err.code === "PAYROLL_MONTH_LOCKED" && /This revocation/.test(err.message));
    assert.equal(w.calls.revokeStage.length, 0);
  });

  it("13. a PENDING stage has nothing to revoke", async () => {
    const w = world({ request: { ...OT_REQUEST, status: "PENDING", current_stage_no: 2, approved_ot_minutes: null, steps: chain(["APPROVED", "PENDING", "PENDING"]) }, punches: OT_DAY });
    await assert.rejects(() => revoke(w, { stage_no: 2 }), /no decision to revoke - it is pending/);
    assert.equal(w.calls.revokeStage.length, 0);
  });

  it("14. a SHIFT_CHANGE decision is refused", async () => {
    const w = world({ request: { ...OT_REQUEST, request_type: "SHIFT_CHANGE" }, punches: OT_DAY });
    await assert.rejects(() => revoke(w), /shift change decision cannot be revoked/);
    assert.equal(w.calls.revokeStage.length, 0);
  });

  it("a payroll-lock CLOSURE, a missing stage and a missing request are refused", async () => {
    const closed = world({ request: { ...OT_REQUEST, status: "REJECTED", closure_reason: "NOT_APPROVED_BEFORE_PAYROLL_LOCK" }, punches: OT_DAY });
    await assert.rejects(() => revoke(closed), /closed by the payroll lock/);
    const w = world({ request: OT_REQUEST, punches: OT_DAY });
    await assert.rejects(() => revoke(w, { stage_no: 4 }), /no stage 4/);
    await assert.rejects(() => revoke(w, { request_id: 999 }), /No such request/);
    assert.equal(w.calls.revokeStage.length + closed.calls.revokeStage.length, 0);
  });

  it("16. ONE OT CLAIM PER DATE still holds after a revoke: the reopened claim blocks a second one", async () => {
    const w = world({ request: OT_REQUEST, punches: OT_DAY });
    await revoke(w);
    await assert.rejects(
      () => w.regularization.raiseOtRequest({ actor: { employee_id: EMP }, attendance_date: DATE, reason: "again please", today: "2026-09-25" }),
      /An OT request for 2026-09-10 is already pending \(#71\)/
    );
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

  it("a missing or short reason, or no stage, is a 400", async () => {
    for (const body of [{ stage_no: 2 }, { stage_no: 2, reason: "oops" }, { reason: "approved by mistake" }, { stage_no: 0, reason: "approved by mistake" }]) {
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

describe("listApprovals: `revocable` per step, for administrators only, and the audit", () => {
  const listWorld = () => {
    const row = {
      attendance_approval_request_id: 71, request_type: "OT", status: "APPROVED", requested_for_employee_id: EMP,
      requested_by_employee_id: EMP, employee_name: "Staff", attendance_date: DATE, outlet_id: 3, outlet_name: "S",
      reason: "x", candidate_ot_minutes: 180, approved_ot_minutes: 180, current_stage_no: 3, total_stages: 3,
      finalization_state: "SETTLED", closure_reason: null, chain_source: "EMPLOYEE",
    };
    const regRepo = {
      getApprovalIdentity: async (id) => ({ employee_id: id, employee_name: "A", outlet_id: 1, approver_role: null, requester_class: null }),
      listApprovals: async () => [row],
      countApprovals: async () => 1,
      listStepsForRequests: async () => chain(["APPROVED", "REJECTED", "PENDING"]).map((s) => ({ ...s, attendance_approval_request_id: 71 })),
      listRevocationsForRequests: async () => [{
        attendance_approval_revocation_id: 1, attendance_approval_request_id: 71, revoked_stage_no: 3,
        revoked_approval_level: "FINAL", original_decision: "APPROVED", original_decided_by_name: "Final",
        original_decided_at: "2026-09-11 10:00:00", original_request_status: "APPROVED", original_approved_ot_minutes: 95,
        revoked_by_employee_id: 900, revoked_by_name: "Admin", revoked_at: "2026-09-12 09:00:00", reason: "approved by mistake",
      }],
    };
    return buildRegularization(regRepo, { calculateRange: async () => [] });
  };

  it("an administrator is offered Revoke on the APPROVED and REJECTED steps, never on a PENDING one", async () => {
    const out = await listWorld().listApprovals({ actor: { employee_id: 900, user_type: 2, branch_scope: { kind: "ALL_BRANCHES" } }, request_type: "OT", status: "ALL" });
    assert.deepEqual(out.rows[0].chain.map((s) => s.revocable), [true, true, false]);
    assert.deepEqual(out.rows[0].revocations.map((v) => [v.revoked_stage_no, v.original_approved_ot_minutes, v.reason]), [[3, 95, "approved by mistake"]]);
  });

  it("nobody else is offered it", async () => {
    const out = await listWorld().listApprovals({ actor: { employee_id: 9, user_type: 1, branch_scope: { kind: "ALL_BRANCHES" } }, request_type: "OT", status: "ALL" });
    assert.deepEqual(out.rows[0].chain.map((s) => s.revocable), [false, false, false]);
  });
});
