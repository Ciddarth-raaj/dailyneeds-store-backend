/**
 * BULK approval actions - the OT "back to Request" rule on the PRODUCTION
 * engine, the batch's own validation, and the architecture that keeps bulk
 * and single from drifting.
 *
 *   node --test usecase/attendance_approval_bulk.test.js
 *
 * The REAL `attendance_regularization` and `attendance_calculation` usecases
 * over fake repositories. The SQL - transactions, FOR UPDATE, the payroll
 * lock, the per-record log, races - is `repository/attendance_approval_bulk.
 * mysql.test.js`; this file proves what the engine makes of a bulk-revoked
 * OT day, and that bulk is a loop over the single-record methods.
 *
 *   GEN  09:00-18:00, 60m break  NRM 480, OT allowed; worked 09:00-21:00
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const buildCalculation = require("./attendance_calculation");
const buildRegularization = require("./attendance_regularization");

const DATE = "2026-09-10";
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
const punch = (id, emp, ioTime) => ({
  punch_id: id, employee_id: emp, io_time: ioTime, punch_date: ioTime.slice(0, 10),
  ingest_attendance_date: ioTime.slice(0, 10), dev_id: "DEV1", ingest_source: "DEVICE",
});
const finalStep = (decision) => [{
  attendance_approval_step_id: 1, stage_no: 1, approver_role: "EMPLOYEE", outlet_id: null,
  approver_employee_id: 33, approval_level: "FINAL", decision,
  decided_by_employee_id: decision === "PENDING" ? null : 33,
  decided_at: decision === "PENDING" ? null : "2026-09-11 10:00:00.000000",
  remarks: null, acted_as_admin_override: 0, decision_source: decision === "PENDING" ? null : "WEB",
}];
const otRequest = (id, emp, status) => ({
  attendance_approval_request_id: id, request_type: "OT", requested_for_employee_id: emp, requested_by_employee_id: emp,
  attendance_date: DATE, reason: "stock audit", candidate_ot_minutes: 180,
  approved_ot_minutes: status === "APPROVED" ? 180 : null,
  status, current_stage_no: 1, total_stages: 1, finalization_state: status === "PENDING" ? "NOT_REQUIRED" : "SETTLED",
  closure_reason: null, auto_created: 0, decided_at: status === "PENDING" ? null : "2026-09-11 10:00:00.000000",
  steps: finalStep(status === "PENDING" ? "PENDING" : status),
});

/** Several employees, one OT request each, 09:00-21:00 worked on DATE. */
function world(requests) {
  const store = new Map(requests.map((r) => [r.attendance_approval_request_id, { ...r }]));
  const byEmployee = (emp) => [...store.values()].filter((r) => r.requested_for_employee_id === emp);
  const calls = { revokeRequest: [], decideStage: [], log: [] };
  const calcRepo = {
    getShiftAssignmentHistory: async (emp) => [{ employee_work_shift_assignment_id: 1, employee_id: emp, work_shift_id: 1, effective_from: "2026-09-01" }],
    getDateShiftOverrides: async () => [],
    getWorkShiftWithSchedule: async (id) => (id === 1 ? GEN : null),
    getWorkShiftConfigVersions: async () => [],
    listActiveWorkShiftOptions: async () => [GEN.config],
    getRawPunchesByCalendarWindow: async (emp) => [punch(emp * 10 + 1, emp, `${DATE} 09:00:00`), punch(emp * 10 + 2, emp, `${DATE} 21:00:00`)],
    getApprovedRegularizedPunches: async () => [],
    getApprovalStateByDate: async (emp) =>
      byEmployee(Number(emp)).filter((r) => r.status !== "CANCELLED").map((r) => ({ ...r, rejection_remarks: null })),
    getBreakOverride: async () => null,
    getEmploymentWindow: async (emp) => ({ employee_id: emp, date_of_joining: "2020-01-01", resignation_date: null }),
    findPayrollLockedPeriods: async () => [],
  };
  const calculation = buildCalculation(calcRepo);
  const regRepo = {
    getRequest: async (id) => (store.has(Number(id)) ? { ...store.get(Number(id)), steps: store.get(Number(id)).steps.map((s) => ({ ...s })) } : null),
    getRevocationSnapshot: async (id) =>
      store.has(Number(id)) ? { request: { ...store.get(Number(id)) }, steps: store.get(Number(id)).steps, fingerprint: `fp-${id}` } : null,
    getLatestRevocation: async () => null,
    revokeRequest: async (args) => {
      calls.revokeRequest.push(args);
      const r = store.get(args.requestId);
      r.status = "CANCELLED";
      r.approved_ot_minutes = 0;
      return { code: 200, status: "CANCELLED", calculations_written: args.calculations.length };
    },
    decideStage: async (args) => {
      calls.decideStage.push(args);
      const r = store.get(args.requestId);
      r.status = args.next.status;
      r.approved_ot_minutes = args.next.approved_ot_minutes;
      r.finalization_state = "SETTLED";
      r.steps[0].decision = args.decision;
      return { code: 200, status: args.next.status, current_stage_no: args.next.current_stage_no, finalization_state: "SETTLED" };
    },
    recordBulkActionItem: async (item) => calls.log.push(item),
    getApprovalIdentity: async (id) => ({ employee_id: id, employee_name: "X", outlet_id: 3, approver_role: null, requester_class: null }),
    findRequestsForDates: async (emp) => byEmployee(Number(emp)).filter((r) => r.status !== "CANCELLED"),
    findOpenRequest: async () => null,
    createRequest: async (args) => ({ attendance_approval_request_id: 500, total_stages: args.chain.length }),
  };
  const regularization = buildRegularization(regRepo, calculation);
  return { calculation, regularization, calls, store };
}

const day = async (w, emp) => (await w.calculation.calculateRange({ employee_id: emp, from_date: DATE, to_date: DATE }))[0];

describe("OT: Approved or Rejected -> bulk Revoke -> REQUEST (never Pending), on the production engine", () => {
  it("5. Approved OT: before, 180 approved OT is paid; after the bulk revoke the day is Not Requested with OT AVAILABLE to request", async () => {
    const w = world([otRequest(71, 42, "APPROVED"), otRequest(72, 43, "APPROVED")]);
    assert.equal((await day(w, 42)).approved_ot_minutes, 180, "sanity");
    const out = await w.regularization.bulkAction({
      actor: ADMIN, revoke_actor: ADMIN, action: "REVOKE", request_type: "OT",
      items: [{ request_id: 71, status: "APPROVED" }, { request_id: 72, status: "APPROVED" }], reason: "approved by mistake",
    });
    assert.deepEqual(out.summary, { requested: 2, succeeded: 2, skipped: 0, failed: 0 });
    for (const emp of [42, 43]) {
      /* eslint-disable-next-line no-await-in-loop */
      const after = await day(w, emp);
      assert.equal(after.ot_claim_state, "AVAILABLE", "the screen's Not Requested + Request OT");
      assert.equal(after.ot_request_id, null, "no request - not a PENDING one");
      assert.equal(after.approved_ot_minutes, 0);
    }
    assert.deepEqual(out.results.map((r) => [r.previous_status, r.new_status]), [["APPROVED", "CANCELLED"], ["APPROVED", "CANCELLED"]]);
    // The day each revoke transaction was handed pays nothing.
    assert.deepEqual(w.calls.revokeRequest.map((c) => c.calculations[0].approved_ot_minutes), [0, 0]);
    // And the employee can request again: a NEW request.
    const raised = await w.regularization.raiseOtRequest({ actor: { employee_id: 42 }, attendance_date: DATE, reason: "stock audit again", today: "2026-09-25" });
    assert.equal(raised.attendance_approval_request_id, 500);
  });

  it("6. Rejected OT: after the bulk revoke the day is Not Requested with OT AVAILABLE too", async () => {
    const w = world([otRequest(71, 42, "REJECTED")]);
    assert.equal((await day(w, 42)).ot_claim_state, "REJECTED", "sanity");
    const out = await w.regularization.bulkAction({
      actor: ADMIN, revoke_actor: ADMIN, action: "REVOKE", request_type: "OT", items: [{ request_id: 71 }], reason: "rejected in error",
    });
    assert.equal(out.results[0].new_status, "CANCELLED");
    const after = await day(w, 42);
    assert.equal(after.ot_claim_state, "AVAILABLE");
    assert.equal(after.ot_request_id, null);
  });

  it("1. a bulk approval pays exactly what a single approval would: the engine's eligible OT", async () => {
    const w = world([otRequest(71, 42, "PENDING"), otRequest(72, 43, "PENDING")]);
    const out = await w.regularization.bulkAction({
      actor: { employee_id: 33, user_type: 1 }, action: "APPROVE", request_type: "OT", items: [{ request_id: 71, current_stage_no: 1 }, { request_id: 72 }],
    });
    assert.deepEqual(out.summary, { requested: 2, succeeded: 2, skipped: 0, failed: 0 });
    assert.deepEqual(w.calls.decideStage.map((c) => [c.requestId, c.decision, c.next.approved_ot_minutes, c.decisionSource]), [[71, "APPROVED", 180, "WEB"], [72, "APPROVED", 180, "WEB"]]);
    assert.equal((await day(w, 42)).approved_ot_minutes, 180);
  });
});

describe("the batch itself", () => {
  const w = () => world([otRequest(71, 42, "PENDING")]);
  const approver = { employee_id: 33, user_type: 1 };

  it("refuses an empty, oversized or unreadable selection, and an unknown action or tab", async () => {
    const r = w().regularization;
    await assert.rejects(() => r.bulkAction({ actor: approver, action: "APPROVE", request_type: "OT", items: [] }), /at least one/);
    const many = Array.from({ length: r.MAX_BULK_ITEMS + 1 }, (_, i) => ({ request_id: i + 1 }));
    await assert.rejects(() => r.bulkAction({ actor: approver, action: "APPROVE", request_type: "OT", items: many }), /At most 100/);
    await assert.rejects(() => r.bulkAction({ actor: approver, action: "APPROVE", request_type: "OT", items: [{ request_id: "x" }] }), /request id/);
    await assert.rejects(() => r.bulkAction({ actor: approver, action: "DELETE", request_type: "OT", items: [{ request_id: 71 }] }), /APPROVE, REJECT or REVOKE/);
    await assert.rejects(() => r.bulkAction({ actor: approver, action: "APPROVE", request_type: "LEAVE", items: [{ request_id: 71 }] }), /request_type/);
  });

  it("Reject and Revoke need a reason of 5-500 characters; Approve does not", async () => {
    const r = w().regularization;
    await assert.rejects(() => r.bulkAction({ actor: approver, action: "REJECT", request_type: "OT", items: [{ request_id: 71 }], reason: "no" }), /rejection reason/);
    await assert.rejects(() => r.bulkAction({ actor: ADMIN, revoke_actor: ADMIN, action: "REVOKE", request_type: "OT", items: [{ request_id: 71 }] }), /revoke reason/);
    await assert.rejects(() => r.bulkAction({ actor: approver, action: "REJECT", request_type: "OT", items: [{ request_id: 71 }], reason: "x".repeat(501) }), /at most 500/);
    const ok = await r.bulkAction({ actor: approver, action: "APPROVE", request_type: "OT", items: [{ request_id: 71 }] });
    assert.equal(ok.summary.succeeded, 1);
  });

  it("9. a non-administrator's bulk revoke is refused as a whole", async () => {
    await assert.rejects(
      () => w().regularization.bulkAction({ actor: approver, revoke_actor: { employee_id: 33, user_type: 1 }, action: "REVOKE", request_type: "OT", items: [{ request_id: 71 }], reason: "approved by mistake" }),
      (err) => err.name === "ForbiddenError"
    );
  });

  it("a repeated id is actioned once", async () => {
    const world1 = w();
    const out = await world1.regularization.bulkAction({ actor: approver, action: "APPROVE", request_type: "OT", items: [{ request_id: 71 }, { request_id: 71 }, 71] });
    assert.equal(out.summary.requested, 1);
    assert.equal(world1.calls.decideStage.length, 1);
  });

  it("12. every record gets its own log row under one operation id, successes and refusals alike", async () => {
    const world1 = world([otRequest(71, 42, "PENDING"), otRequest(72, 43, "APPROVED")]);
    const out = await world1.regularization.bulkAction({ actor: approver, action: "APPROVE", request_type: "OT", items: [{ request_id: 71 }, { request_id: 72 }, { request_id: 999 }] });
    assert.equal(world1.calls.log.length, 3);
    assert.ok(world1.calls.log.every((l) => l.bulk_operation_id === out.bulk_operation_id && /^[0-9a-f-]{36}$/.test(l.bulk_operation_id)));
    assert.deepEqual(world1.calls.log.map((l) => [l.request_id, l.outcome, l.previous_status, l.new_status]), [
      [71, "SUCCEEDED", "PENDING", "APPROVED"],
      [72, "FAILED", "APPROVED", null],
      [999, "SKIPPED", null, null],
    ]);
  });

  it("a log write that fails does not undo, or fail, a record that succeeded", async () => {
    const world1 = w();
    const reg = buildRegularization(
      { getRequest: async () => ({ ...otRequest(71, 42, "PENDING") }),
        decideStage: async (a) => ({ code: 200, status: a.next.status, current_stage_no: 1 }),
        getApprovalIdentity: async (id) => ({ employee_id: id, outlet_id: 3, approver_role: null }),
        recordBulkActionItem: async () => { throw new Error("log down"); } },
      world1.calculation
    );
    const out = await reg.bulkAction({ actor: approver, action: "APPROVE", request_type: "OT", items: [{ request_id: 71 }] });
    assert.equal(out.results[0].outcome, "SUCCEEDED");
    assert.equal(out.results[0].logged, false);
  });

  it("an unexpected error is FAILED with a plain message, never the internal error text", async () => {
    const world1 = w();
    const reg = buildRegularization(
      { getRequest: async () => { throw new Error("ER_LOCK_DEADLOCK: internal detail"); }, recordBulkActionItem: async () => {} },
      world1.calculation
    );
    const out = await reg.bulkAction({ actor: approver, action: "APPROVE", request_type: "OT", items: [{ request_id: 71 }] });
    assert.equal(out.results[0].outcome, "FAILED");
    assert.equal(out.results[0].code, "ERROR");
    assert.ok(!/ER_LOCK|internal/.test(out.results[0].message));
  });
});

describe("ARCHITECTURE: bulk -> the single-record action -> its validations, transitions and audit", () => {
  const src = fs.readFileSync(path.join(__dirname, "attendance_regularization.js"), "utf8");
  const body = src.slice(src.indexOf("const bulkAction = async"), src.indexOf("const listBulkTargets = async"));

  it("bulkAction calls `decide` and `revokeDecision` - the very methods the single endpoints call", () => {
    assert.match(body, /await revokeDecision\(\{ actor: revoke_actor, request_id: target\.request_id, reason: why, now \}\)/);
    assert.match(body, /await decide\(\{/);
  });

  it("and writes NO approval state of its own: no step, request, revocation or day write, no chain logic", () => {
    for (const forbidden of ["decideStage", "revokeRequest", "writeCalculations", "advance(", "canApprove(", "calculateRange", "findPayrollLockedPeriods"]) {
      assert.ok(!body.includes(forbidden), `bulkAction must not call ${forbidden} itself`);
    }
  });

  it("the single routes still call the same methods, unchanged (13.)", () => {
    const routes = fs.readFileSync(path.join(__dirname, "..", "routes", "attendance_regularization.js"), "utf8");
    assert.match(routes, /"\/attendance\/regularization\/:request_id\/decision"[\s\S]*?this\.usecase\.decide\(/);
    assert.match(routes, /"\/attendance\/approvals\/:request_id\/revoke"[\s\S]*?this\.usecase\.revokeDecision\(/);
  });
});
