/**
 * THE PARITY GUARD: the dashboard's batched path and the existing
 * per-employee path must produce the SAME day.
 *
 *   node --test usecase/attendance_dashboard_parity.test.js
 *
 * WHY THIS TEST IS THE IMPORTANT ONE. The dashboard cannot call
 * `calculateRange` per employee - `buildContext` issues six queries each, so a
 * company-wide date would be eighteen hundred round trips. So it batches the
 * FETCHING and reuses the PURE engine functions, which means the ORCHESTRATION
 * (grouping the effective punch stream, re-dating punches by the shift's
 * cutoff, slotting the regularization and OT requests, deciding which
 * approvals are settled) is written twice.
 *
 * Written twice is a licence to drift, and drift here would be the worst kind
 * of defect this feature could have: a dashboard that quietly disagrees with
 * the employee's own attendance screen about the same date, with no error to
 * notice. So both paths are run over the same facts and the engine's own
 * output is compared field by field. If anybody edits the attendance
 * orchestration in `usecase/attendance_calculation.js` and not its counterpart
 * in `usecase/attendance_dashboard.js`, this fails.
 *
 * The two fakes below return the same data through the two different query
 * shapes each usecase asks for - per-employee for the calculation path,
 * batched for the dashboard - which is precisely the seam being tested.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildCalculation = require("../usecase/attendance_calculation");
const buildDashboard = require("../usecase/attendance_dashboard");

const EMP = 42;
const DATE = "2026-09-12";

const scheduleRows = (workShiftId, overrides = {}) =>
  Array.from({ length: 7 }, (_, day) => ({
    work_shift_weekly_schedule_id: workShiftId * 10 + day,
    work_shift_id: workShiftId,
    day_of_week: day,
    is_working_day: 1,
    in_time: "10:00:00",
    out_time: "22:00:00",
    attendance_day_cutoff: "04:00:00",
    break_minutes: 60,
    normal_work_minutes: 660,
    ot_rate: 1,
    ...overrides,
  }));

const shiftConfig = (id, overrides = {}) => ({
  work_shift_id: id,
  shift_code: `S${id}`,
  shift_name: `Shift ${id}`,
  active: 1,
  overtime_allowed: 1,
  overtime_minimum_minutes: 0,
  overtime_rounding_method: "NONE",
  overtime_rounding_interval_minutes: 0,
  overtime_minimum_threshold_only: 0,
  overtime_minimum_excluded: 0,
  maximum_ot_minutes_per_day: null,
  pre_shift_overtime_allowed: 0,
  pre_shift_overtime_minimum_minutes: 0,
  pre_shift_overtime_rounding_method: "NONE",
  pre_shift_overtime_rounding_interval_minutes: 0,
  pre_shift_overtime_minimum_excluded: 0,
  late_offset_against_overtime: 0,
  early_exit_offset_against_overtime: 0,
  late_grace_minutes: 0,
  late_deduction_interval_minutes: 0,
  late_deduct_minutes: 0,
  late_exclude_grace_from_deduction: 0,
  early_exit_grace_minutes: 0,
  early_exit_deduction_interval_minutes: 0,
  early_exit_deduct_minutes: 0,
  ...overrides,
});

const ASSIGNMENTS = [
  {
    employee_work_shift_assignment_id: 1,
    employee_id: EMP,
    work_shift_id: 7,
    effective_from: "2026-09-01",
    source: "MIGRATION_BACKFILL",
  },
];

const EMPLOYEE_ROW = {
  employee_id: EMP,
  employee_name: "Employee 42",
  store_id: 1,
  designation_id: 5,
  special_break_override_minutes: null,
  outlet_name: "Main Store",
  outlet_nickname: "MAIN",
  designation_name: "Cashier",
  resignation_date: null,
};

/** The calculation usecase's fake: per-employee queries. */
function calcRepo(facts) {
  return {
    getShiftAssignmentHistory: async () => facts.assignments,
    getDateShiftOverrides: async () => facts.overrides,
    getWorkShiftWithSchedule: async (id) => ({
      config: facts.configs.find((c) => Number(c.work_shift_id) === Number(id)) || null,
      schedule: facts.schedules.filter((s) => Number(s.work_shift_id) === Number(id)),
    }),
    getWorkShiftConfigVersions: async (id) =>
      facts.configVersions.filter((v) => Number(v.work_shift_id) === Number(id)),
    getRawPunchesByCalendarWindow: async (_id, from, to) =>
      facts.rawPunches.filter((p) => {
        const day = String(p.io_time).slice(0, 10);
        return day >= from && day <= to;
      }),
    getApprovedRegularizedPunches: async (_id, from, to) =>
      facts.regularized.filter((r) => r.attendance_date >= from && r.attendance_date <= to),
    // THE WHOLE EMPLOYEE ROW, as the real query returns it: both the override
    // and the Extra Break Hours come off the same row, and a fake that
    // dropped one would let the two paths disagree about it unnoticed.
    getBreakOverride: async () => ({
      special_break_override_minutes: facts.employee.special_break_override_minutes,
      extra_break_hours: facts.employee.extra_break_hours,
      attendance_required: facts.employee.attendance_required,
    }),
    getApprovalStateByDate: async (_id, from, to) =>
      facts.approvals.filter((a) => a.attendance_date >= from && a.attendance_date <= to),
    listCalculations: async ({ from_date, to_date }) =>
      (facts.stored || []).filter((r) => r.attendance_date >= from_date && r.attendance_date <= to_date),
  };
}

/** The dashboard's fake: the SAME facts through batched queries. */
function dashRepo(facts) {
  return {
    listApplicableEmployees: async () => [facts.employee],
    getShiftAssignmentHistoryForEmployees: async () => facts.assignments,
    getDateShiftOverridesForEmployees: async () => facts.overrides,
    listWorkShiftConfigs: async () => facts.configs,
    listWorkShiftSchedules: async () => facts.schedules,
    listWorkShiftConfigVersions: async () => facts.configVersions,
    getRawPunchesForEmployees: async (_ids, from, to) =>
      facts.rawPunches.filter((p) => {
        const day = String(p.io_time).slice(0, 10);
        return day >= from && day <= to;
      }),
    getApprovedRegularizedPunchesForEmployees: async (_ids, from, to) =>
      facts.regularized.filter((r) => r.attendance_date >= from && r.attendance_date <= to),
    getApprovalStateForEmployees: async (_ids, from, to) =>
      facts.approvals
        .filter((a) => a.attendance_date >= from && a.attendance_date <= to)
        .map((a) => ({ ...a, employee_id: a.requested_for_employee_id || EMP })),
    listRecentPunches: async () => [],
    listDeviceSyncHealth: async () => [],
    listOutlets: async () => [],
    listDesignations: async () => [],
    listActiveWorkShifts: async () => [],
    getStoredCalculationsForEmployees: async (_ids, from, to) =>
      (facts.stored || []).filter((r) => r.attendance_date >= from && r.attendance_date <= to),
  };
}

const baseFacts = (over = {}) => ({
  employee: EMPLOYEE_ROW,
  assignments: ASSIGNMENTS,
  overrides: [],
  configs: [shiftConfig(7)],
  schedules: scheduleRows(7),
  configVersions: [],
  rawPunches: [],
  regularized: [],
  approvals: [],
  stored: [],
  ...over,
});

const punch = (io_time, over = {}) => ({
  punch_id: over.punch_id,
  employee_id: EMP,
  punch_date: String(io_time).slice(0, 10),
  ingest_attendance_date: String(io_time).slice(0, 10),
  io_time,
  dev_id: "DEV1",
  ingest_source: "BIOMAX",
  attendance_punch_void_id: null,
  void_reason: null,
  ...over,
});

/**
 * The engine fields both paths must agree on, exactly.
 *
 * These are every number payroll or a manager would read off the day. The
 * presentation extras each path adds on top (the dashboard's slice, the
 * calculation path's OT claim label) are deliberately not compared - they are
 * different views, and the point is that the CALCULATION underneath is one.
 */
const ENGINE_FIELDS = [
  "attendance_date",
  "punch_count",
  "attendance_day_count",
  "nrm_minutes",
  "span_minutes",
  "break_allowance_minutes",
  "break_allowance_source",
  "actual_gap_minutes",
  "break_charged_minutes",
  "worked_minutes",
  "shortage_minutes",
  "late_minutes",
  "early_exit_minutes",
  "pre_shift_minutes",
  "post_shift_minutes",
  "raw_ot_minutes",
  "ot_offset_minutes",
  "pre_shift_ot_minutes",
  "post_shift_ot_minutes",
  "candidate_ot_minutes",
  "approved_ot_minutes",
  "status",
  "is_final",
  "shift_resolution_status",
  "shift_snapshot_hash",
  // The two employee-specific settings AS APPLIED, and which answer each
  // path gave. A dashboard that read the stored row while the employee's own
  // screen recalculated would differ in exactly these.
  "break_override_minutes_applied",
  "extra_break_minutes_applied",
  "calculation_source",
];

const pick = (day) => {
  const out = {};
  ENGINE_FIELDS.forEach((f) => {
    out[f] = day[f] === undefined ? null : day[f];
  });
  return out;
};

async function bothPaths(facts, date = DATE) {
  const calc = buildCalculation(calcRepo(facts));
  const dash = buildDashboard(dashRepo(facts));

  const [calcDay] = await calc.calculateRange({
    employee_id: EMP,
    from_date: date,
    to_date: date,
  });

  const batch = await dash.loadBatch({ employees: [facts.employee], from: date, to: date });
  const [dashDay] = dash.computeDaysForEmployee({
    employee: facts.employee,
    dates: [date],
    batch,
  });

  return { calcDay, dashDay };
}

/**
 * The same two paths, asked to READ a date rather than calculate it - which
 * is what a screen does, and which is where a stored historical row is
 * supposed to win on both sides.
 */
async function bothReadPaths(facts, date, now) {
  const calc = buildCalculation(calcRepo(facts));
  const dash = buildDashboard(dashRepo(facts));

  const [calcDay] = await calc.readRange({
    employee_id: EMP,
    from_date: date,
    to_date: date,
    now,
  });

  const batch = await dash.loadBatch({ employees: [facts.employee], from: date, to: date });
  const [dashDay] = dash.computeDaysForEmployee({
    employee: facts.employee,
    dates: [date],
    batch,
    now,
  });

  return { calcDay, dashDay };
}

describe("the batched dashboard path agrees with calculateRange", () => {
  const cases = {
    "a clean two-punch day": baseFacts({
      rawPunches: [
        punch(`${DATE} 10:00:00`, { punch_id: 1 }),
        punch(`${DATE} 22:00:00`, { punch_id: 2 }),
      ],
    }),

    "a four-punch day with a short lunch feeding OT": baseFacts({
      rawPunches: [
        punch(`${DATE} 10:00:00`, { punch_id: 1 }),
        punch(`${DATE} 14:00:00`, { punch_id: 2 }),
        punch(`${DATE} 14:20:00`, { punch_id: 3 }),
        punch(`${DATE} 22:30:00`, { punch_id: 4 }),
      ],
    }),

    "an overnight OUT dated back by the 04:00 cutoff": baseFacts({
      rawPunches: [
        punch(`${DATE} 10:00:00`, { punch_id: 1 }),
        punch("2026-09-13 00:45:00", { punch_id: 2 }),
      ],
    }),

    "a within-10-minute duplicate suppressed": baseFacts({
      rawPunches: [
        punch(`${DATE} 10:00:00`, { punch_id: 1 }),
        punch(`${DATE} 10:07:00`, { punch_id: 2 }),
        punch(`${DATE} 22:00:00`, { punch_id: 3 }),
      ],
    }),

    "a duplicate chain across midnight": baseFacts({
      rawPunches: [
        punch(`${DATE} 10:00:00`, { punch_id: 1 }),
        punch(`${DATE} 23:58:00`, { punch_id: 2 }),
        punch("2026-09-13 00:04:00", { punch_id: 3 }),
      ],
    }),

    "a voided punch excluded": baseFacts({
      rawPunches: [
        punch(`${DATE} 09:00:00`, { punch_id: 1, attendance_punch_void_id: 5, void_reason: "Wrong person" }),
        punch(`${DATE} 10:00:00`, { punch_id: 2 }),
        punch(`${DATE} 22:00:00`, { punch_id: 3 }),
      ],
    }),

    "an odd punch count": baseFacts({
      rawPunches: [punch(`${DATE} 10:00:00`, { punch_id: 1 })],
    }),

    "nobody punched at all": baseFacts({}),

    "no assignment history for the date": baseFacts({ assignments: [] }),

    "no schedule row for the weekday": baseFacts({ schedules: [] }),

    "a rest day the employee worked anyway": baseFacts({
      schedules: scheduleRows(7, { is_working_day: 0 }),
      rawPunches: [
        punch(`${DATE} 10:00:00`, { punch_id: 1 }),
        punch(`${DATE} 18:00:00`, { punch_id: 2 }),
      ],
    }),

    "an employee break override, with four punches": baseFacts({
      employee: { ...EMPLOYEE_ROW, special_break_override_minutes: 30 },
      rawPunches: [
        punch(`${DATE} 10:00:00`, { punch_id: 1 }),
        punch(`${DATE} 14:00:00`, { punch_id: 2 }),
        punch(`${DATE} 14:30:00`, { punch_id: 3 }),
        punch(`${DATE} 22:00:00`, { punch_id: 4 }),
      ],
    }),

    "a PENDING regularization holding the day": baseFacts({
      rawPunches: [punch(`${DATE} 10:00:00`, { punch_id: 1 })],
      approvals: [
        {
          attendance_approval_request_id: 77,
          requested_for_employee_id: EMP,
          attendance_date: DATE,
          request_type: "REGULARIZATION",
          status: "PENDING",
          finalization_state: "NOT_REQUIRED",
          candidate_ot_minutes: 0,
          approved_ot_minutes: 0,
          reason: "Forgot to punch out",
        },
      ],
    }),

    "a SETTLED regularization with its approved punch": baseFacts({
      rawPunches: [punch(`${DATE} 10:00:00`, { punch_id: 1 })],
      regularized: [
        {
          punch_id: 900,
          employee_id: EMP,
          attendance_date: DATE,
          io_time: `${DATE} 22:00:00`,
          punch_source: "REGULARIZED",
        },
      ],
      approvals: [
        {
          attendance_approval_request_id: 78,
          requested_for_employee_id: EMP,
          attendance_date: DATE,
          request_type: "REGULARIZATION",
          status: "APPROVED",
          finalization_state: "SETTLED",
          candidate_ot_minutes: 0,
          approved_ot_minutes: 0,
        },
      ],
    }),

    "an APPROVED but NOT SETTLED OT request pays nothing": baseFacts({
      rawPunches: [
        punch(`${DATE} 10:00:00`, { punch_id: 1 }),
        punch(`${DATE} 23:30:00`, { punch_id: 2 }),
      ],
      approvals: [
        {
          attendance_approval_request_id: 79,
          requested_for_employee_id: EMP,
          attendance_date: DATE,
          request_type: "OT",
          status: "APPROVED",
          finalization_state: "PENDING",
          candidate_ot_minutes: 90,
          approved_ot_minutes: 90,
        },
      ],
    }),

    "a SETTLED OT approval pays what it approved": baseFacts({
      rawPunches: [
        punch(`${DATE} 10:00:00`, { punch_id: 1 }),
        punch(`${DATE} 23:30:00`, { punch_id: 2 }),
      ],
      approvals: [
        {
          attendance_approval_request_id: 80,
          requested_for_employee_id: EMP,
          attendance_date: DATE,
          request_type: "OT",
          status: "APPROVED",
          finalization_state: "SETTLED",
          candidate_ot_minutes: 90,
          approved_ot_minutes: 60,
        },
      ],
    }),

    "a single-date shift override wins over the history": baseFacts({
      configs: [shiftConfig(7), shiftConfig(8)],
      schedules: [...scheduleRows(7), ...scheduleRows(8, { in_time: "14:00:00", out_time: "22:00:00" })],
      overrides: [
        {
          attendance_date_shift_override_id: 3,
          employee_id: EMP,
          work_shift_id: 8,
          attendance_date: DATE,
        },
      ],
      rawPunches: [
        punch(`${DATE} 14:00:00`, { punch_id: 1 }),
        punch(`${DATE} 22:00:00`, { punch_id: 2 }),
      ],
    }),
  };

  Object.entries(cases).forEach(([name, facts]) => {
    it(name, async () => {
      const { calcDay, dashDay } = await bothPaths(facts);
      assert.deepEqual(
        pick(dashDay),
        pick(calcDay),
        `the dashboard disagrees with the employee's own attendance screen for: ${name}`
      );
    });
  });

  it("agrees across a whole fourteen-day window, day by day", async () => {
    // The trend calculates many dates at once from one batch; a grouping
    // mistake there would show up as one wrong day in the middle.
    const facts = baseFacts({
      rawPunches: [
        punch("2026-09-02 10:00:00", { punch_id: 1 }),
        punch("2026-09-02 22:00:00", { punch_id: 2 }),
        punch("2026-09-05 10:00:00", { punch_id: 3 }),
        punch("2026-09-06 01:00:00", { punch_id: 4 }),
        punch("2026-09-08 10:00:00", { punch_id: 5 }),
        punch("2026-09-08 10:05:00", { punch_id: 6 }),
        punch("2026-09-08 22:00:00", { punch_id: 7 }),
        punch("2026-09-11 10:00:00", { punch_id: 8 }),
      ],
    });

    const calc = buildCalculation(calcRepo(facts));
    const dash = buildDashboard(dashRepo(facts));

    const calcDays = await calc.calculateRange({
      employee_id: EMP,
      from_date: "2026-09-01",
      to_date: "2026-09-14",
    });
    const dates = calcDays.map((d) => d.attendance_date);
    const batch = await dash.loadBatch({ employees: [facts.employee], from: "2026-09-01", to: "2026-09-14" });
    const dashDays = dash.computeDaysForEmployee({ employee: facts.employee, dates, batch });

    assert.equal(dashDays.length, calcDays.length, "same number of days");
    dashDays.forEach((day, i) => {
      assert.deepEqual(pick(day), pick(calcDays[i]), `day ${dates[i]} differs between the two paths`);
    });
  });
});

/* ================== the same STORED historical date, read by both paths === */

/**
 * A settled date the two screens must agree about.
 *
 * The dashboard aggregates thousands of days into counts a manager acts on,
 * so "the dashboard recomputed it and the employee's screen read the stored
 * row" would not be a cosmetic difference - it would be a headcount and a
 * Need Action queue that contradict the screen opened next. Both sides go
 * through `utils/attendance_stored_read.js`, and this is what holds them to
 * it.
 */
describe("a stored historical date reads the same on both paths", () => {
  // A date inside the assignment history this file already sets up, read a
  // week later: settled, closed, and long since calculated.
  const PAST = DATE;
  const NOW = Date.parse("2026-09-18T12:00:00+05:30");

  /** What August was calculated as: the shift's own break, NRM 660. */
  const storedRow = {
    employee_id: EMP,
    attendance_date: PAST,
    work_shift_id: 7,
    work_shift_weekly_schedule_id: 70,
    shift_snapshot: JSON.stringify({ work_shift_id: 7, break_minutes: 60, shift_span_minutes: 720 }),
    shift_snapshot_hash: "stored-hash",
    raw_punch_ids: JSON.stringify([1, 2, 3, 4]),
    effective_punches: JSON.stringify([]),
    punch_count: 4,
    attendance_day_count: 1,
    nrm_minutes: 660,
    span_minutes: 720,
    break_allowance_minutes: 60,
    break_allowance_source: "SHIFT",
    break_override_minutes_applied: null,
    extra_break_minutes_applied: 0,
    actual_gap_minutes: 60,
    break_charged_minutes: 60,
    worked_minutes: 660,
    shortage_minutes: 0,
    late_minutes: 0,
    early_exit_minutes: 0,
    pre_shift_minutes: 0,
    post_shift_minutes: 0,
    raw_ot_minutes: 0,
    ot_offset_minutes: 0,
    pre_shift_ot_minutes: 0,
    post_shift_ot_minutes: 0,
    candidate_ot_minutes: 0,
    approved_ot_minutes: 0,
    ot_rate: 1,
    status: "FINAL",
    is_final: 1,
    review_reasons: JSON.stringify([]),
    approval_request_id: null,
    calculation_version: 7,
  };

  // The employee has SINCE been given half an hour of Extra Break Hours, so a
  // recalculation of this date would now produce 90 / 630. Neither screen may
  // show that until somebody recalculates.
  const facts = () =>
    baseFacts({
      employee: { ...EMPLOYEE_ROW, extra_break_hours: "0.50" },
      stored: [storedRow],
      rawPunches: [
        punch(`${PAST} 10:00:00`, { punch_id: 1 }),
        punch(`${PAST} 14:00:00`, { punch_id: 2 }),
        punch(`${PAST} 15:00:00`, { punch_id: 3 }),
        punch(`${PAST} 22:00:00`, { punch_id: 4 }),
      ],
    });

  it("both return the STORED figures, field for field", async () => {
    const { calcDay, dashDay } = await bothReadPaths(facts(), PAST, NOW);
    assert.deepEqual(pick(dashDay), pick(calcDay));
    assert.equal(calcDay.calculation_source, "STORED");
  });

  it("and those figures are the stored ones, not a recalculation", async () => {
    const { calcDay, dashDay } = await bothReadPaths(facts(), PAST, NOW);
    for (const day of [calcDay, dashDay]) {
      assert.equal(day.punch_count, 4);
      assert.equal(day.break_allowance_minutes, 60, "not the 90 a recalculation would give");
      assert.equal(day.extra_break_minutes_applied, 0);
      assert.equal(day.nrm_minutes, 660);
      assert.equal(day.worked_minutes, 660);
      assert.equal(day.shortage_minutes, 0);
      assert.equal(day.candidate_ot_minutes, 0);
      assert.equal(day.approved_ot_minutes, 0);
      assert.equal(day.status, "FINAL");
    }
  });

  it("with NO stored row, both fall back to the engine - and both say so", async () => {
    const withoutStored = { ...facts(), stored: [] };
    const { calcDay, dashDay } = await bothReadPaths(withoutStored, PAST, NOW);
    assert.deepEqual(pick(dashDay), pick(calcDay));
    assert.equal(calcDay.calculation_source, "LIVE_PREVIEW");
    assert.equal(calcDay.break_allowance_minutes, 90, "the extra half hour, as it would apply");
    assert.equal(calcDay.extra_break_minutes_applied, 30);
  });

  it("while the day is still OPEN, both recompute it - a provisional day is not history", async () => {
    const duringTheDay = Date.parse(`${PAST}T16:00:00+05:30`);
    const { calcDay, dashDay } = await bothReadPaths(facts(), PAST, duringTheDay);
    assert.deepEqual(pick(dashDay), pick(calcDay));
    assert.equal(calcDay.calculation_source, "LIVE_PREVIEW");
  });
});
