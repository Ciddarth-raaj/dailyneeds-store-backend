/**
 * Attendance Regularisation - a MISSED BREAK (lunch OUT + IN) through the
 * existing regularization request, against fakes.
 *
 *   IS_TEST=true node --test usecase/attendance_regularization_break.test.js
 *
 * 12-09-2026, punches 10:09 -> 22:04, lunch taken but not punched. The
 * request carries 14:00 OUT and 15:00 IN; once approved the day is the
 * ordinary four-punch day 10:09 IN -> 14:00 OUT -> 15:00 IN -> 22:04 OUT.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildUsecase = require("./attendance_regularization");
const buildCalculation = require("./attendance_calculation");
const { APPROVER_ROLE, REQUEST_TYPE, REQUEST_STATUS, STEP_DECISION } = require("../utils/attendance_approval_chain");

const DATE = "2026-09-12";
const at = (hm) => `${DATE} ${hm}:00`;
const punch = (hm, extra = {}) => ({ punch_id: null, io_time: at(hm), source: "BIOMAX", ...extra });

const day = (overrides = {}) => ({
  employee_id: 100,
  attendance_date: DATE,
  shift_snapshot: { work_shift_id: 7, snapshot_hash: "abc", attendance_day_cutoff: "04:00:00" },
  punch_count: 2,
  effective_punches: [punch("10:09"), punch("22:04")],
  candidate_ot_minutes: 60,
  approved_ot_minutes: 0,
  worked_minutes: 655,
  status: "FINAL",
  is_final: true,
  ...overrides,
});

function fakes(state = {}) {
  const calls = { created: [], decided: [], proposed: [], ranges: [], lockChecks: [] };
  const repo = {
    calls,
    getApprovalIdentity: async (id) =>
      (state.identities || {})[id] || {
        employee_id: id,
        employee_name: `Employee ${id}`,
        outlet_id: 3,
        designation_id: 11,
        approver_role: null,
        requester_class: null,
      },
    findOpenRequest: async () => state.openRequest || null,
    createRequest: async (args) => {
      calls.created.push(args);
      return { attendance_approval_request_id: 900, total_stages: args.chain.length };
    },
    getRequest: async () => state.request || null,
    decideStage: async (args) => {
      calls.decided.push(args);
      return {
        code: 200,
        status: args.next.status,
        current_stage_no: args.next.current_stage_no,
        finalization_state: args.next.status === "APPROVED" ? "SETTLED" : "NOT_REQUIRED",
      };
    },
  };
  const calculation = {
    calculateRange: async (args) => {
      calls.ranges.push(args);
      if (args && args.assume) return [state.assumedDay || state.proposedDay || day({ punch_count: 4 })];
      return [state.day || day()];
    },
    calculateProposedDay: async (args) => {
      calls.proposed.push(args);
      return state.proposedDay || day({ punch_count: 4 });
    },
    attendanceDateForPunchTime: async (args) => String(args.punch_time).slice(0, 10),
    findPayrollLockedPeriods: async (rows) => {
      calls.lockChecks.push(rows);
      return state.locked || [];
    },
    toStorageRow: (d) => ({ employee_id: d.employee_id, attendance_date: d.attendance_date }),
  };
  return { repo, calculation, usecase: buildUsecase(repo, calculation) };
}

const hr = { employee_id: 7, user_type: 1 };
const raise = (usecase, extra = {}) =>
  usecase.raiseRequest({
    actor: hr,
    requested_for_employee_id: 100,
    attendance_date: DATE,
    reason: "Took lunch 2-3pm, forgot to punch",
    break_out_time: at("14:00"),
    break_in_time: at("15:00"),
    ...extra,
  });

describe("raising a missed-break regularization", () => {
  it("creates ONE regularization carrying BOTH punches, proven through the engine", async () => {
    const { usecase, repo } = fakes();
    const result = await raise(usecase);

    const [created] = repo.calls.created;
    assert.equal(created.request.request_type, REQUEST_TYPE.REGULARIZATION);
    assert.equal(created.request.candidate_ot_minutes, 0);
    assert.deepEqual(
      created.punches.map((p) => p.punch_time),
      [at("14:00"), at("15:00")]
    );
    assert.equal(result.regularization_kind, "MISSED_BREAK");
    assert.deepEqual(result.punch_times, [at("14:00"), at("15:00")]);
    assert.equal(result.status, REQUEST_STATUS.PENDING);

    // The pair, not one punch, is what the engine priced.
    assert.deepEqual(repo.calls.proposed[0].punch_times, [at("14:00"), at("15:00")]);
    // And the payroll lock was asked about the date.
    assert.deepEqual(repo.calls.lockChecks[0], [{ employee_id: 100, attendance_date: DATE }]);
  });

  it("reports the OT effect: an approved claim is re-capped at the corrected day's entitlement", async () => {
    const { usecase } = fakes({
      day: day({ candidate_ot_minutes: 120, approved_ot_minutes: 120, ot_claim_state: "APPROVED" }),
      proposedDay: day({ punch_count: 4, candidate_ot_minutes: 60, approved_ot_minutes: 60, ot_claim_state: "APPROVED" }),
    });
    const result = await raise(usecase);
    assert.deepEqual(result.ot_revalidation, {
      ot_claim_state: "APPROVED",
      candidate_ot_minutes_before: 120,
      candidate_ot_minutes_after: 60,
      approved_ot_minutes_before: 120,
      approved_ot_minutes_after: 60,
      approved_ot_reduced: true,
    });
  });

  for (const [label, out, inn, pattern] of [
    ["IN before OUT", "15:00", "14:00", /must be after/],
    ["before the first punch", "09:30", "10:30", /inside the day's punches/],
    ["after the last punch", "21:30", "22:30", /inside the day's punches/],
  ]) {
    it(`refuses a break ${label}`, async () => {
      const { usecase, repo } = fakes();
      await assert.rejects(raise(usecase, { break_out_time: at(out), break_in_time: at(inn) }), pattern);
      assert.equal(repo.calls.created.length, 0);
    });
  }

  it("refuses a break overlapping one already recorded", async () => {
    const { usecase } = fakes({
      day: day({ punch_count: 4, effective_punches: [punch("10:00"), punch("13:00"), punch("14:00"), punch("22:00")] }),
    });
    await assert.rejects(raise(usecase, { break_out_time: at("13:30"), break_in_time: at("14:30") }), /overlaps/);
  });

  it("refuses an odd day: the missing punch is regularized first", async () => {
    const { usecase } = fakes({
      day: day({ punch_count: 3, effective_punches: [punch("10:00"), punch("13:00"), punch("14:00")] }),
    });
    await assert.rejects(raise(usecase), /regularize the missing punch first/);
  });

  it("refuses a payroll-locked month", async () => {
    const { usecase, repo } = fakes({ locked: [{ employee_id: 100, period_year: 2026, period_month: 9 }] });
    await assert.rejects(raise(usecase), /payroll|locked/i);
    assert.equal(repo.calls.created.length, 0);
  });

  it("refuses an ordinary MISSING PUNCH in a payroll-locked month at the raise too", async () => {
    const { usecase, repo } = fakes({
      locked: [{ employee_id: 100, year: 2026, month: 9 }],
      day: day({ punch_count: 1, status: "REVIEW_REQUIRED", effective_punches: [punch("10:09")] }),
      proposedDay: day({ punch_count: 2 }),
    });
    await assert.rejects(
      usecase.raiseRequest({
        actor: hr, requested_for_employee_id: 100, attendance_date: DATE,
        reason: "Forgot to punch out", punch_time: at("22:04"),
      }),
      /locked/i
    );
    assert.equal(repo.calls.created.length, 0);
  });

  it("refuses half a pair, and a missing punch and a break together", async () => {
    const { usecase } = fakes();
    await assert.rejects(raise(usecase, { break_in_time: null }), /both break_out_time and break_in_time/);
    await assert.rejects(raise(usecase, { punch_time: at("21:00") }), /not both/);
  });

  it("an open request on the date (a pending OT claim included) still refuses the raise", async () => {
    const { usecase } = fakes({ openRequest: { attendance_approval_request_id: 44, request_type: "OT" } });
    await assert.rejects(raise(usecase), /already an open request/);
  });
});

describe("deciding a missed-break regularization", () => {
  const pending = (overrides = {}) => ({
    attendance_approval_request_id: 900,
    request_type: REQUEST_TYPE.REGULARIZATION,
    requested_for_employee_id: 100,
    requested_by_employee_id: 7,
    attendance_date: DATE,
    outlet_id: 3,
    candidate_ot_minutes: 0,
    reason: "Took lunch 2-3pm, forgot to punch",
    status: REQUEST_STATUS.PENDING,
    current_stage_no: 1,
    total_stages: 1,
    steps: [{ stage_no: 1, approver_role: APPROVER_ROLE.HR, outlet_id: null, decision: "PENDING" }],
    regularized_punch: { attendance_regularized_punch_id: 31, punch_time: at("14:00") },
    regularized_punches: [
      { attendance_regularized_punch_id: 31, punch_time: at("14:00") },
      { attendance_regularized_punch_id: 32, punch_time: at("15:00") },
    ],
    ...overrides,
  });
  const hrApprover = { 8: { employee_id: 8, outlet_id: 3, approver_role: APPROVER_ROLE.HR, requester_class: "MANAGER" } };

  it("final approval settles BOTH punches with the recalculated day, in one decision", async () => {
    const { usecase, repo } = fakes({
      request: pending(),
      identities: hrApprover,
      day: day({ approved_ot_minutes: 90, candidate_ot_minutes: 90 }),
      assumedDay: day({ punch_count: 4, approved_ot_minutes: 60, candidate_ot_minutes: 60 }),
    });
    const result = await usecase.decide({ actor: { employee_id: 8, user_type: 1 }, request_id: 900, decision: STEP_DECISION.APPROVED });

    assert.equal(result.status, REQUEST_STATUS.APPROVED);
    assert.equal(result.regularization_kind, "MISSED_BREAK");
    const assumed = repo.calls.ranges.find((r) => r.assume).assume;
    assert.deepEqual(
      assumed.regularized_punches.map((p) => [p.punch_id, p.io_time]),
      [[31, at("14:00")], [32, at("15:00")]]
    );
    assert.equal(repo.calls.decided[0].calculations.length, 1, "the corrected day commits with the approval");
    assert.equal(result.ot_revalidation.approved_ot_minutes_before, 90);
    assert.equal(result.ot_revalidation.approved_ot_minutes_after, 60);
    assert.equal(result.ot_revalidation.approved_ot_reduced, true);
  });

  it("refuses the final approval when the day has changed so the pair no longer fits", async () => {
    const { usecase, repo } = fakes({
      request: pending(),
      identities: hrApprover,
      // The employee's real lunch punches arrived after the request was raised.
      day: day({ punch_count: 4, effective_punches: [punch("10:09"), punch("14:05"), punch("14:55"), punch("22:04")] }),
    });
    await assert.rejects(
      usecase.decide({ actor: { employee_id: 8, user_type: 1 }, request_id: 900, decision: STEP_DECISION.APPROVED }),
      /has changed since this break was requested/
    );
    assert.equal(repo.calls.decided.length, 0);
  });

  it("a rejection settles neither punch", async () => {
    const { usecase, repo } = fakes({ request: pending(), identities: hrApprover });
    await usecase.decide({
      actor: { employee_id: 8, user_type: 1 },
      request_id: 900,
      decision: STEP_DECISION.REJECTED,
      remarks: "No lunch was taken that day",
    });
    const assumed = repo.calls.ranges.find((r) => r.assume).assume;
    assert.deepEqual(assumed.regularized_punches, []);
  });

  it("refuses the approval in a payroll-locked month", async () => {
    const { usecase } = fakes({
      request: pending(),
      identities: hrApprover,
      locked: [{ employee_id: 100, period_year: 2026, period_month: 9 }],
    });
    await assert.rejects(
      usecase.decide({ actor: { employee_id: 8, user_type: 1 }, request_id: 900, decision: STEP_DECISION.APPROVED }),
      /payroll|locked/i
    );
  });
});

/**
 * THE SAME ENGINE. The real calculation usecase over a fake repository: the
 * raw punches 10:09 / 22:04 plus the pair become an ordinary four-punch day.
 * No other calculation path exists for a regularized break.
 */
describe("the pair feeds the ordinary attendance engine", () => {
  const weekly = Array.from({ length: 7 }, (_, d) => ({
    work_shift_weekly_schedule_id: 700 + d, work_shift_id: 7, day_of_week: d, is_working_day: 1,
    in_time: "10:00:00", out_time: "22:00:00", attendance_day_cutoff: "04:00:00",
    break_minutes: 60, normal_work_minutes: 660, ot_rate: 1,
  }));
  const config = {
    work_shift_id: 7, shift_code: "LATE", shift_name: "Late Shift", active: 1,
    overtime_allowed: 1, overtime_minimum_minutes: 0, overtime_rounding_method: "NONE",
    overtime_rounding_interval_minutes: 0, overtime_minimum_threshold_only: 0,
    maximum_ot_minutes_per_day: null, pre_shift_overtime_allowed: 0,
    pre_shift_overtime_minimum_minutes: 0, pre_shift_overtime_rounding_method: "NONE",
    pre_shift_overtime_rounding_interval_minutes: 0, late_offset_against_overtime: 0,
    early_exit_offset_against_overtime: 0,
  };
  const raw = (id, hm) => ({
    punch_id: id, employee_id: 100, io_time: at(hm), punch_date: DATE,
    ingest_attendance_date: DATE, dev_id: "DEV1", ingest_source: "DEVICE",
  });
  const calc = (regularized = []) =>
    buildCalculation({
      getShiftAssignmentHistory: async () => [
        { employee_work_shift_assignment_id: 1, employee_id: 100, work_shift_id: 7, effective_from: "2026-09-01" },
      ],
      getDateShiftOverrides: async () => [],
      getWorkShiftWithSchedule: async () => ({ config, schedule: weekly }),
      getWorkShiftConfigVersions: async () => [],
      getRawPunchesByCalendarWindow: async () => [raw(1, "10:09"), raw(2, "22:04")],
      getApprovedRegularizedPunches: async () => regularized,
      getBreakOverride: async () => null,
      getApprovalStateByDate: async () => [],
    });

  it("10:09 IN -> 14:00 OUT -> 15:15 IN -> 22:04 OUT, the 75-minute break charged", async () => {
    const before = (await calc().calculateRange({ employee_id: 100, from_date: DATE, to_date: DATE }))[0];
    const after = await calc().calculateProposedDay({
      employee_id: 100,
      attendance_date: DATE,
      punch_times: [at("14:00"), at("15:15")],
    });

    assert.equal(before.punch_count, 2);
    assert.equal(after.punch_count, 4);
    assert.deepEqual(
      after.effective_punches.map((p) => [String(p.io_time).slice(11, 16), p.source]),
      [["10:09", "BIOMAX"], ["14:00", "REGULARIZED"], ["15:15", "REGULARIZED"], ["22:04", "BIOMAX"]]
    );
    // The punched gap, not the two-punch allowance, is what is charged.
    assert.equal(after.break_charged_minutes, 75);
    assert.equal(after.worked_minutes, 715 - 75);
    assert.ok(after.worked_minutes < before.worked_minutes);
    assert.equal(after.status, "FINAL");
  });

  it("the stored pair of an EARLIER approved request stays when another request is decided", async () => {
    const earlier = [
      { punch_id: 31, employee_id: 100, attendance_date: DATE, io_time: at("14:00"), attendance_approval_request_id: 900 },
      { punch_id: 32, employee_id: 100, attendance_date: DATE, io_time: at("15:00"), attendance_approval_request_id: 900 },
    ];
    // A later request on the date being REJECTED must not withdraw them.
    const [rejected] = await calc(earlier).calculateRange({
      employee_id: 100, from_date: DATE, to_date: DATE,
      assume: { attendance_approval_request_id: 901, attendance_date: DATE, status: "REJECTED", regularized_punches: [] },
    });
    assert.equal(rejected.punch_count, 4);
    // Revoking the earlier request itself withdraws both of its punches.
    const [revoked] = await calc(earlier).calculateRange({
      employee_id: 100, from_date: DATE, to_date: DATE, exclude_request_id: 900,
    });
    assert.equal(revoked.punch_count, 2);
  });
});
