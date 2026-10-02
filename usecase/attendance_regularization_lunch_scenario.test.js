/**
 * THE HISTORICAL CASE, end to end, through the REAL calculation and
 * regularization usecases over stateful fake repositories.
 *
 *   IS_TEST=true node --test usecase/attendance_regularization_lunch_scenario.test.js
 *
 *   12-09-2026, shift 14:00-22:00, punches 10:09 and 22:04, OT already
 *   APPROVED. A manager regularizes Missing Lunch Punches 14:00 OUT /
 *   15:00 IN through the ordinary REGULARIZATION request; it is approved
 *   through the ordinary chain, then revoked by an administrator. September
 *   locked is covered at the end.
 *
 * The shift's real configuration is not in this repository, so the two
 * values that decide the outcome are stated: pre-shift OT ALLOWED (without
 * it a 10:09 start earns 4 minutes of OT and there is nothing approved to
 * revalidate) and the break allowance, run at 30 and at 60 minutes.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildCalculation = require("./attendance_calculation");
const buildRegularization = require("./attendance_regularization");

const EMP = 42;
const DATE = "2026-09-12";
const ADMIN = { employee_id: 900, user_id: 5, user_type: 2 };
const MANAGER = { employee_id: 7, user_type: 1 };
const at = (hm) => `${DATE} ${hm}:00`;

const shiftWithBreak = (breakMinutes) => ({
  config: {
    work_shift_id: 1, shift_code: "S1422", shift_name: "14:00-22:00", active: 1, overtime_allowed: 1,
    overtime_minimum_minutes: 0, overtime_rounding_method: "NONE", overtime_rounding_interval_minutes: 0,
    pre_shift_overtime_allowed: 1, pre_shift_overtime_minimum_minutes: 0,
    pre_shift_overtime_rounding_method: "NONE", pre_shift_overtime_rounding_interval_minutes: 0,
    late_offset_against_overtime: 0, early_exit_offset_against_overtime: 0,
  },
  schedule: Array.from({ length: 7 }, (_, d) => ({
    work_shift_weekly_schedule_id: 100 + d, work_shift_id: 1, day_of_week: d, is_working_day: 1,
    in_time: "14:00:00", out_time: "22:00:00", attendance_day_cutoff: "04:00:00", break_minutes: breakMinutes, ot_rate: 1,
  })),
});

const RAW = Object.freeze([
  Object.freeze({ punch_id: 1, employee_id: EMP, io_time: at("10:09"), punch_date: DATE, ingest_attendance_date: DATE, dev_id: "BIOMAX-1", ingest_source: "DEVICE" }),
  Object.freeze({ punch_id: 2, employee_id: EMP, io_time: at("22:04"), punch_date: DATE, ingest_attendance_date: DATE, dev_id: "BIOMAX-1", ingest_source: "DEVICE" }),
]);

const approvedSteps = () =>
  [1, 2, 3].map((n) => ({
    attendance_approval_step_id: 700 + n, stage_no: n, approver_role: "HR", outlet_id: null, decision: "APPROVED",
    decided_by_employee_id: 8, decided_at: "2026-09-13 10:00:00", remarks: null, acted_as_admin_override: 0,
  }));

function world({ breakMinutes, approvedOt, lockedMonths = [] }) {
  const shift = shiftWithBreak(breakMinutes);
  const store = {
    requests: [
      {
        attendance_approval_request_id: 71, request_type: "OT", requested_for_employee_id: EMP,
        requested_by_employee_id: EMP, attendance_date: DATE, reason: "Covered the morning",
        candidate_ot_minutes: approvedOt, approved_ot_minutes: approvedOt, status: "APPROVED",
        current_stage_no: 3, total_stages: 3, finalization_state: "SETTLED", closure_reason: null,
        steps: approvedSteps(),
      },
    ],
    punches: [], // attendance_regularized_punch
    written: [], // calculations committed with decisions / revokes
  };
  let nextId = 900;
  let nextPunchId = 31;
  const byId = (id) => store.requests.find((r) => r.attendance_approval_request_id === Number(id));
  const lockedPeriods = (rows) =>
    (rows || [])
      .map((r) => ({ employee_id: Number(r.employee_id), year: Number(r.attendance_date.slice(0, 4)), month: Number(r.attendance_date.slice(5, 7)) }))
      .filter((p) => lockedMonths.includes(`${p.year}-${p.month}`));

  const calcRepo = {
    getShiftAssignmentHistory: async () => [
      { employee_work_shift_assignment_id: 1, employee_id: EMP, work_shift_id: 1, effective_from: "2026-09-01" },
    ],
    getDateShiftOverrides: async () => [],
    getWorkShiftWithSchedule: async () => shift,
    getWorkShiftConfigVersions: async () => [],
    getRawPunchesByCalendarWindow: async () => RAW.map((p) => ({ ...p })),
    // As the real query: punches of APPROVED + SETTLED requests only.
    getApprovedRegularizedPunches: async () =>
      store.punches
        .filter((p) => {
          const r = byId(p.attendance_approval_request_id);
          return r && r.status === "APPROVED" && r.finalization_state === "SETTLED";
        })
        .map((p) => ({
          punch_id: p.attendance_regularized_punch_id, employee_id: EMP, attendance_date: DATE,
          io_time: p.punch_time, punch_source: "REGULARIZED", attendance_approval_request_id: p.attendance_approval_request_id,
        }))
        .sort((a, b) => (a.io_time < b.io_time ? -1 : 1)),
    // As the real query: every request but CANCELLED, oldest first.
    getApprovalStateByDate: async () => store.requests.filter((r) => r.status !== "CANCELLED").map((r) => ({ ...r })),
    getBreakOverride: async () => null,
    getEmploymentWindow: async () => ({ employee_id: EMP, date_of_joining: "2020-01-01", resignation_date: null }),
    findPayrollLockedPeriods: async (rows) => lockedPeriods(rows),
  };
  const calculation = buildCalculation(calcRepo);

  const regRepo = {
    getApprovalIdentity: async (id) => ({ employee_id: id, employee_name: `E${id}`, outlet_id: 3, approver_role: null, requester_class: null }),
    findOpenRequest: async () => store.requests.find((r) => r.status === "PENDING") || null,
    findRequestsForDates: async () => store.requests.filter((r) => r.status !== "CANCELLED"),
    createRequest: async ({ request, chain, punches }) => {
      const id = nextId++;
      store.requests.push({
        attendance_approval_request_id: id, ...request, status: "PENDING", current_stage_no: 1,
        total_stages: chain.length, finalization_state: "NOT_REQUIRED", approved_ot_minutes: null, closure_reason: null,
        steps: chain.map((s) => ({ ...s, attendance_approval_step_id: id * 10 + s.stage_no, decision: "PENDING" })),
      });
      (punches || []).forEach((p) =>
        store.punches.push({ attendance_regularized_punch_id: nextPunchId++, attendance_approval_request_id: id, punch_time: p.punch_time })
      );
      return { attendance_approval_request_id: id, total_stages: chain.length };
    },
    getRequest: async (id) => {
      const r = byId(id);
      if (!r) return null;
      const own = store.punches
        .filter((p) => p.attendance_approval_request_id === r.attendance_approval_request_id)
        .map((p) => ({ attendance_regularized_punch_id: p.attendance_regularized_punch_id, punch_time: p.punch_time, punch_source: "REGULARIZED" }));
      return { ...r, steps: r.steps.map((s) => ({ ...s })), regularized_punch: own[0] || null, regularized_punches: own };
    },
    decideStage: async (args) => {
      const locked = lockedPeriods([{ employee_id: EMP, attendance_date: DATE }]);
      if (locked.length && args.next.status === "APPROVED") throw new Error("PAYROLL_MONTH_LOCKED (repository gate)");
      const r = byId(args.requestId);
      const step = r.steps.find((s) => s.stage_no === args.stageNo);
      Object.assign(step, { decision: args.decision, decided_by_employee_id: args.actorId, remarks: args.remarks, acted_as_admin_override: args.adminOverride ? 1 : 0 });
      r.status = args.next.status;
      r.current_stage_no = args.next.current_stage_no;
      r.approved_ot_minutes = args.next.approved_ot_minutes;
      r.finalization_state = r.status === "PENDING" ? "NOT_REQUIRED" : "SETTLED";
      store.written.push(...(args.calculations || []));
      return { code: 200, status: r.status, current_stage_no: r.current_stage_no, finalization_state: r.finalization_state };
    },
    getRevocationSnapshot: async (id) => {
      const r = byId(id);
      return r ? { request: { ...r }, steps: r.steps.map((s) => ({ ...s })), fingerprint: `fp-${id}` } : null;
    },
    getLatestRevocation: async () => null,
    revokeRequest: async (args) => {
      byId(args.requestId).status = "CANCELLED";
      store.written.push(...(args.calculations || []));
      return { code: 200, status: "CANCELLED", calculations_written: args.calculations.length };
    },
  };
  const regularization = buildRegularization(regRepo, calculation);
  const read = async () => (await calculation.calculateRange({ employee_id: EMP, from_date: DATE, to_date: DATE }))[0];
  return { store, calculation, regularization, read };
}

const sequence = (day) =>
  day.effective_punches.map((p, i) => `${String(p.io_time).slice(11, 16)} ${i % 2 === 0 ? "IN" : "OUT"}${p.source === "REGULARIZED" ? "*" : ""}`).join(" → ");
const figures = (day) => ({
  punch_count: day.punch_count,
  status: day.status,
  worked: day.worked_minutes,
  break_charged: day.break_charged_minutes,
  actual_gap: day.actual_gap_minutes,
  shortage: day.shortage_minutes,
  excess: day.excess_ot_minutes,
  ot_eligible: day.candidate_ot_minutes,
  approved_ot: day.approved_ot_minutes,
});

async function raiseLunch(w, extra = {}) {
  return w.regularization.raiseRequest({
    actor: MANAGER,
    requested_for_employee_id: EMP,
    attendance_date: DATE,
    reason: "Missing Lunch Punches - Remarks: lunch 2-3pm, did not punch",
    break_out_time: at("14:00"),
    break_in_time: at("15:00"),
    ...extra,
  });
}
async function approveAllStages(w, requestId) {
  let out;
  for (let i = 0; i < 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    out = await w.regularization.decide({ actor: ADMIN, request_id: requestId, decision: "APPROVED" });
  }
  return out;
}

describe("12-09-2026, 14:00-22:00, 10:09 -> 22:04, OT approved, break allowance 30", () => {
  it("before, after approval, OT revalidation and revoke - through the ordinary engine", async () => {
    const w = world({ breakMinutes: 30, approvedOt: 235 });
    const rawBefore = JSON.stringify(RAW);

    // BEFORE: a complete two-punch day; the approved 235 OT is fully earned.
    const before = await w.read();
    assert.equal(sequence(before), "10:09 IN → 22:04 OUT");
    assert.deepEqual(figures(before), {
      punch_count: 2, status: "FINAL", worked: 685, break_charged: 30, actual_gap: null,
      shortage: 0, excess: 235, ot_eligible: 235, approved_ot: 235,
    });

    // RAISE: one REGULARIZATION carrying both punches. Nothing is effective yet.
    const raised = await raiseLunch(w);
    assert.equal(raised.request_type, "REGULARIZATION");
    assert.equal(raised.regularization_kind, "MISSED_BREAK");
    assert.deepEqual(raised.ot_revalidation, {
      ot_claim_state: "APPROVED", candidate_ot_minutes_before: 235, candidate_ot_minutes_after: 205,
      approved_ot_minutes_before: 235, approved_ot_minutes_after: 205, approved_ot_reduced: true,
    });
    const reqId = raised.attendance_approval_request_id;
    assert.deepEqual(w.store.punches.map((p) => [p.attendance_approval_request_id, p.punch_time]), [[reqId, at("14:00")], [reqId, at("15:00")]]);
    const pending = await w.read();
    assert.equal(sequence(pending), "10:09 IN → 22:04 OUT", "a pending punch changes nothing");
    assert.equal(pending.status, "REGULARIZATION_PENDING");

    // A second lunch request on the same date is refused while one is open.
    await assert.rejects(raiseLunch(w, { break_out_time: at("18:00"), break_in_time: at("18:30") }), /already an open request/);

    // APPROVE through the ordinary three-stage chain.
    const decided = await approveAllStages(w, reqId);
    assert.equal(decided.status, "APPROVED");
    assert.equal(decided.finalization_state, "SETTLED");
    assert.equal(decided.attendance_persisted, true, "the corrected day commits with the approval");
    assert.deepEqual(decided.ot_revalidation, {
      ot_claim_state: "APPROVED", candidate_ot_minutes_before: 235, candidate_ot_minutes_after: 205,
      approved_ot_minutes_before: 235, approved_ot_minutes_after: 205, approved_ot_reduced: true,
    });
    const stored = w.store.written[w.store.written.length - 1];
    assert.equal(stored.approved_ot_minutes, 205, "payroll reads the capped figure");

    // AFTER: the ordinary four-punch day.
    const after = await w.read();
    assert.equal(sequence(after), "10:09 IN → 14:00 OUT* → 15:00 IN* → 22:04 OUT");
    assert.deepEqual(figures(after), {
      punch_count: 4, status: "FINAL", worked: 655, break_charged: 60, actual_gap: 60,
      shortage: 0, excess: 205, ot_eligible: 205, approved_ot: 205,
    });
    assert.ok(after.approved_ot_minutes <= after.candidate_ot_minutes, "approved OT never exceeds eligible OT");
    // The OT request's own decision is history and is not rewritten; the
    // engine caps what it pays.
    assert.equal(w.store.requests.find((r) => r.request_type === "OT").approved_ot_minutes, 235);

    // Overlapping / duplicate lunch after approval is refused by the sequence rule.
    await assert.rejects(raiseLunch(w), /overlaps/);
    await assert.rejects(raiseLunch(w, { break_out_time: at("14:30"), break_in_time: at("15:30") }), /overlaps/);

    // REVOKE the regularization: both punches stop together.
    const revoked = await w.regularization.revokeDecision({ actor: ADMIN, request_id: reqId, reason: "Lunch was punched on paper" });
    assert.equal(revoked.status, "CANCELLED");
    assert.equal(revoked.attendance_persisted, true);
    const back = await w.read();
    assert.equal(sequence(back), "10:09 IN → 22:04 OUT");
    assert.deepEqual(figures(back), figures(before), "recalculated back to the original day, approved OT 235 again");
    const revokedRow = w.store.written[w.store.written.length - 1];
    assert.equal(revokedRow.punch_count, 2);
    assert.equal(revokedRow.approved_ot_minutes, 235);

    // Raw punches untouched throughout.
    assert.equal(JSON.stringify(RAW), rawBefore);
  });
});

describe("the same day with a 60-minute break allowance", () => {
  it("a 60-minute lunch only replaces the deemed break with evidence: worked and OT unchanged", async () => {
    const w = world({ breakMinutes: 60, approvedOt: 235 });
    const before = await w.read();
    const raised = await raiseLunch(w);
    await approveAllStages(w, raised.attendance_approval_request_id);
    const after = await w.read();
    assert.equal(sequence(after), "10:09 IN → 14:00 OUT* → 15:00 IN* → 22:04 OUT");
    assert.equal(before.worked_minutes, 655);
    assert.equal(after.worked_minutes, 655);
    assert.equal(after.break_charged_minutes, 60);
    assert.equal(after.candidate_ot_minutes, 235);
    assert.equal(after.approved_ot_minutes, 235);
  });
});

describe("September payroll-locked", () => {
  it("the lunch raise is refused before anything is written, and the read marks the day locked", async () => {
    const w = world({ breakMinutes: 30, approvedOt: 235, lockedMonths: ["2026-9"] });
    await assert.rejects(raiseLunch(w), /locked/i);
    assert.equal(w.store.requests.length, 1, "no request written");
    assert.equal(w.store.punches.length, 0);

    const [marked] = await w.calculation.markPayrollLocked(EMP, [await w.read()]);
    assert.equal(marked.payroll_locked, true, "the read tells the screen");
    const [open] = await world({ breakMinutes: 30, approvedOt: 235 }).calculation.markPayrollLocked(EMP, [await w.read()]);
    assert.equal(open.payroll_locked, false);
  });

  it("a request raised before the month locked cannot be approved afterwards", async () => {
    const locked = [];
    const w = world({ breakMinutes: 30, approvedOt: 235, lockedMonths: locked });
    const raised = await raiseLunch(w);
    locked.push("2026-9");
    await assert.rejects(approveAllStages(w, raised.attendance_approval_request_id), /locked/i);
    assert.equal((await w.read()).punch_count, 2);
  });
});
