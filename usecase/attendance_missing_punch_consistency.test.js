/**
 * THE MODAL AND THE GUARD COUNT THE SAME PUNCHES.
 *
 *   node --test usecase/attendance_missing_punch_consistency.test.js
 *
 * The bug this file exists for: the Regularize Missing Punch modal listed one
 * punch for a date and the submission came back "<date> has 2 punches - a
 * punch cannot be added to a complete day". The screen reads a closed date
 * through the read path (the STORED row and its stored `effective_punches`);
 * the guard recalculated the same date LIVE. While the two agree nobody
 * notices; when a punch is imported after the date was calculated they do
 * not, and the employee is refused over punches they were never shown.
 *
 * Both sides now resolve the date through ONE path - `readRange` - and apply
 * ONE rule - `utils/attendance_missing_punch.js`. The real calculation
 * usecase runs here over a fake repository so the stored row, the raw punch
 * stream, the duplicate rule and the cutoff are all the production ones.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildCalculation = require("./attendance_calculation");
const buildRegularization = require("./attendance_regularization");
const { missingPunchEligibility } = require("../utils/attendance_missing_punch");

const EMPLOYEE = 42;
const DATE = "2026-09-17";

const scheduleRows = (workShiftId) =>
  Array.from({ length: 7 }, (_, day) => ({
    work_shift_weekly_schedule_id: workShiftId * 10 + day,
    work_shift_id: workShiftId,
    day_of_week: day,
    is_working_day: 1,
    in_time: "08:45:00",
    out_time: "22:30:00",
    attendance_day_cutoff: "04:00:00",
    break_minutes: 60,
    normal_work_minutes: 660,
    ot_rate: 1,
  }));

/** A raw row exactly as `getRawPunchesByCalendarWindow` hands it back. */
const raw = (id, ioTime, extra = {}) => ({
  punch_id: id,
  employee_id: EMPLOYEE,
  punch_date: ioTime.slice(0, 10),
  ingest_attendance_date: ioTime.slice(0, 10),
  io_time: ioTime,
  dev_id: "C26924B2E7351O35",
  ingest_source: "LIVE",
  attendance_punch_void_id: null,
  void_reason: null,
  voided_by_employee_id: null,
  voided_at: null,
  ...extra,
});

function fakeCalculationRepo(state = {}) {
  const rawPunches = state.rawPunches || [];
  return {
    getShiftAssignmentHistory: async () => [
      {
        employee_work_shift_assignment_id: 1,
        employee_id: EMPLOYEE,
        work_shift_id: 7,
        effective_from: "2026-09-01",
        source: "MIGRATION_BACKFILL",
      },
    ],
    getWorkShiftWithSchedule: async (id) => ({
      config: {
        work_shift_id: id,
        shift_code: `S${id}`,
        overtime_allowed: 1,
        overtime_minimum_minutes: 0,
        overtime_rounding_method: "NONE",
        overtime_rounding_interval_minutes: 0,
        overtime_minimum_threshold_only: 0,
        maximum_ot_minutes_per_day: null,
      },
      schedule: scheduleRows(id),
    }),
    getWorkShiftConfigVersions: async () => [],
    getRawPunchesByCalendarWindow: async (_id, from, to) =>
      rawPunches.filter((p) => p.punch_date >= from && p.punch_date <= to),
    getApprovedRegularizedPunches: async () => state.regularized || [],
    getBreakOverride: async () => ({ employee_id: EMPLOYEE, special_break_override_minutes: null }),
    getApprovalStateByDate: async () => state.approvals || [],
    getEmploymentWindow: async () => ({
      employee_id: EMPLOYEE,
      status: 1,
      date_of_joining: "2020-01-01",
      resignation_date: null,
    }),
    listCalculations: async () => state.stored || [],
    saveCalculations: async (rows) => ({ written: rows.length }),
    saveCalculationsWithReconciliation: async ({ rows }) => ({ written: rows.length, stale_removed: 0 }),
  };
}

/**
 * A stored `attendance_day_calculation` row, as the driver returns one: the
 * JSON columns as strings, which is how they were written.
 */
const storedRow = (punchTimes, overrides = {}) => ({
  employee_id: EMPLOYEE,
  attendance_date: DATE,
  work_shift_id: 7,
  work_shift_weekly_schedule_id: 74,
  shift_snapshot: JSON.stringify({
    work_shift_id: 7,
    shift_code: "S7",
    in_time: "08:45:00",
    out_time: "22:30:00",
    attendance_day_cutoff: "04:00:00",
    break_minutes: 60,
    normal_work_minutes: 660,
    is_working_day: 1,
    ot_rate: 1,
  }),
  shift_snapshot_hash: "hash",
  raw_punch_ids: JSON.stringify([1]),
  effective_punches: JSON.stringify(
    punchTimes.map((t, i) => ({ punch_id: i + 1, source: "BIOMAX", io_time: `${DATE} ${t}:00` }))
  ),
  punch_count: punchTimes.length,
  attendance_day_count: 0,
  status: punchTimes.length % 2 === 1 ? "REVIEW_REQUIRED" : "FINAL",
  is_final: punchTimes.length % 2 === 1 ? 0 : 1,
  review_reasons: JSON.stringify(punchTimes.length % 2 === 1 ? ["MISSING_PUNCH"] : []),
  ...overrides,
});

function fakeRegularizationRepo(state = {}) {
  const created = [];
  return {
    created,
    getApprovalIdentity: async (id) => ({
      employee_id: id,
      employee_name: `Employee ${id}`,
      outlet_id: 3,
      designation_id: 11,
      designation_name: "SALES ASSOCIATE",
      approver_role: null,
      requester_class: null,
    }),
    findOpenRequest: async () => state.openRequest || null,
    createRequest: async ({ request, chain, punch }) => {
      created.push({ request, chain, punch });
      return { attendance_approval_request_id: 501, total_stages: chain.length };
    },
    getRequest: async () => null,
    listPendingFor: async () => [],
    listForEmployee: async () => [],
    findRequestsForDates: async () => [],
  };
}

/** The production wiring, over fakes: read path and guard from one usecase. */
function wire(state = {}) {
  const calculation = buildCalculation(fakeCalculationRepo(state));
  const repo = fakeRegularizationRepo(state);
  return { calculation, repo, usecase: buildRegularization(repo, calculation) };
}

/** What the employee's screen - and therefore the modal - is given. */
const readDay = async (calculation) => {
  const [day] = await calculation.readRange({
    employee_id: EMPLOYEE,
    from_date: DATE,
    to_date: DATE,
  });
  return day;
};

const raiseAt = (usecase, punchTime) =>
  usecase.raiseRequest({
    actor: { employee_id: EMPLOYEE, user_type: 1 },
    requested_for_employee_id: EMPLOYEE,
    attendance_date: DATE,
    reason: "Forgot to punch out at closing",
    punch_time: punchTime,
  });

describe("one effective punch: the reported case", () => {
  const state = () => ({ rawPunches: [raw(1, `${DATE} 08:45:00`)] });

  it("the modal shows exactly one punch, and 08:45 IN + 22:20 OUT is accepted", async () => {
    const { calculation, repo, usecase } = wire(state());
    const day = await readDay(calculation);
    assert.deepEqual(
      day.effective_punches.map((p) => p.io_time.slice(11, 16)),
      ["08:45"]
    );
    assert.equal(day.punch_count, 1);
    assert.equal(missingPunchEligibility(day).allowed, true);

    const result = await raiseAt(usecase, `${DATE} 22:20:00`);
    assert.equal(result.attendance_approval_request_id, 501);
    assert.equal(repo.created.length, 1);
    assert.equal(repo.created[0].punch.punch_time, `${DATE} 22:20:00`);
  });

  it("the same day stored and unchanged reads and validates identically", async () => {
    const { calculation, usecase } = wire({ ...state(), stored: [storedRow(["08:45"])] });
    const day = await readDay(calculation);
    assert.equal(day.calculation_source, "STORED");
    assert.equal(day.punch_count, 1);
    assert.equal(day.punch_evidence_stale, false);
    assert.equal(missingPunchEligibility(day).allowed, true);
    const result = await raiseAt(usecase, `${DATE} 22:20:00`);
    assert.equal(result.attendance_approval_request_id, 501);
  });
});

describe("two effective punches: a complete day", () => {
  const state = () => ({
    rawPunches: [raw(1, `${DATE} 08:45:00`), raw(2, `${DATE} 22:20:00`)],
  });

  it("both punches are shown, the day is not offered for regularization, and the guard refuses", async () => {
    const { calculation, usecase } = wire(state());
    const day = await readDay(calculation);
    assert.deepEqual(
      day.effective_punches.map((p) => p.io_time.slice(11, 16)),
      ["08:45", "22:20"]
    );
    const eligibility = missingPunchEligibility(day);
    assert.equal(eligibility.allowed, false);
    assert.match(eligibility.message, /cannot be added to a complete day/);
    await assert.rejects(raiseAt(usecase, `${DATE} 22:30:00`), /cannot be added to a complete day/);
  });
});

describe("the frontend/backend mismatch itself", () => {
  /**
   * The stored row was calculated when only the 08:45 punch existed; the
   * 22:20 punch was imported afterwards and the date was never recalculated.
   * The modal listed one punch; the guard counted two.
   */
  const state = () => ({
    rawPunches: [raw(1, `${DATE} 08:45:00`), raw(2, `${DATE} 22:20:00`)],
    stored: [storedRow(["08:45"])],
  });

  it("the drift is reported on the day the employee is shown, instead of only inside the guard", async () => {
    const { calculation } = wire(state());
    const day = await readDay(calculation);
    assert.equal(day.punch_count, 1, "the stored row still rules the figures");
    assert.equal(day.punch_evidence_stale, true);
    assert.equal(day.live_punch_count, 2);
  });

  it("the day is not offered for regularization, and the refusal names the real problem", async () => {
    const { calculation, usecase } = wire(state());
    const eligibility = missingPunchEligibility(await readDay(calculation));
    assert.equal(eligibility.allowed, false);
    assert.equal(eligibility.reason, "STALE_PUNCH_EVIDENCE");
    await assert.rejects(raiseAt(usecase, `${DATE} 22:20:00`), /has to be recalculated/);
    // and never over punches the employee was not shown
    await assert.rejects(
      raiseAt(usecase, `${DATE} 22:20:00`),
      (err) => !/cannot be added to a complete day/.test(err.message)
    );
  });

  it("once the date is recalculated the stored row and the live day agree again", async () => {
    const { calculation } = wire({
      rawPunches: [raw(1, `${DATE} 08:45:00`), raw(2, `${DATE} 22:20:00`)],
      stored: [storedRow(["08:45", "22:20"])],
    });
    const day = await readDay(calculation);
    assert.equal(day.punch_evidence_stale, false);
    assert.equal(day.punch_count, 2);
    assert.match(missingPunchEligibility(day).message, /cannot be added to a complete day/);
  });
});

describe("requests that are open, and requests that were refused", () => {
  it("a pending regularization blocks a second request and leaves the counts alone", async () => {
    const { calculation, usecase } = wire({
      rawPunches: [raw(1, `${DATE} 08:45:00`)],
      approvals: [
        {
          attendance_approval_request_id: 440,
          attendance_date: DATE,
          request_type: "REGULARIZATION",
          status: "PENDING",
          approved_ot_minutes: 0,
        },
      ],
      openRequest: { attendance_approval_request_id: 440 },
    });
    const day = await readDay(calculation);
    // A pending request adds NO punch: the day is still the one-punch day,
    // and both sides still see one punch.
    assert.equal(day.punch_count, 1);
    assert.equal(day.punch_evidence_stale, false);
    assert.equal(day.status, "REGULARIZATION_PENDING");
    await assert.rejects(raiseAt(usecase, `${DATE} 22:20:00`), /already an open request/);
  });

  it("a REJECTED request does not make the day complete", async () => {
    const { calculation, usecase } = wire({
      rawPunches: [raw(1, `${DATE} 08:45:00`)],
      approvals: [
        {
          attendance_approval_request_id: 441,
          attendance_date: DATE,
          request_type: "REGULARIZATION",
          status: "REJECTED",
          approved_ot_minutes: 0,
        },
      ],
    });
    const day = await readDay(calculation);
    assert.equal(day.punch_count, 1);
    assert.equal(missingPunchEligibility(day).allowed, true);
    const result = await raiseAt(usecase, `${DATE} 22:20:00`);
    assert.equal(result.attendance_approval_request_id, 501);
  });
});

describe("duplicate raw punches", () => {
  it("a duplicate within ten minutes is not a third punch: the day stays complete and is refused", async () => {
    const { calculation, usecase } = wire({
      rawPunches: [
        raw(1, `${DATE} 08:45:00`),
        raw(2, `${DATE} 08:49:00`),
        raw(3, `${DATE} 22:20:00`),
      ],
    });
    const day = await readDay(calculation);
    assert.equal(day.punch_count, 2);
    assert.equal(day.excluded_punches.length, 1);
    await assert.rejects(raiseAt(usecase, `${DATE} 22:35:00`), /cannot be added to a complete day/);
  });

  it("a duplicate beside a single punch still leaves ONE effective punch, shown and counted the same", async () => {
    const { calculation, usecase } = wire({
      rawPunches: [raw(1, `${DATE} 08:45:00`), raw(2, `${DATE} 08:49:00`)],
    });
    const day = await readDay(calculation);
    assert.equal(day.punch_count, 1);
    assert.equal(day.effective_punches.length, day.punch_count);
    const result = await raiseAt(usecase, `${DATE} 22:20:00`);
    assert.equal(result.attendance_approval_request_id, 501);
  });
});

describe("the attendance date boundary", () => {
  it("a 00:30 punch belongs to the previous attendance date, so that date is the complete one", async () => {
    // 00:30 on the 18th is before the 04:00 cutoff: it is the 17th's OUT.
    const { calculation, usecase } = wire({
      rawPunches: [raw(1, `${DATE} 08:45:00`), raw(2, "2026-09-18 00:30:00")],
    });
    const day = await readDay(calculation);
    assert.equal(day.attendance_date, DATE);
    assert.deepEqual(
      day.effective_punches.map((p) => p.io_time),
      [`${DATE} 08:45:00`, "2026-09-18 00:30:00"]
    );
    await assert.rejects(raiseAt(usecase, "2026-09-18 00:45:00"), /cannot be added to a complete day/);
  });

  it("a proposed punch past the cutoff belongs to another date and is refused as such", async () => {
    const { usecase } = wire({ rawPunches: [raw(1, `${DATE} 08:45:00`)] });
    await assert.rejects(
      raiseAt(usecase, "2026-09-18 09:00:00"),
      /belongs to attendance date 2026-09-18/
    );
  });

  it("a cross-midnight OUT inside the cutoff is accepted for the date being regularized", async () => {
    const { repo, usecase } = wire({ rawPunches: [raw(1, `${DATE} 08:45:00`)] });
    const result = await raiseAt(usecase, "2026-09-18 00:30:00");
    assert.equal(result.attendance_approval_request_id, 501);
    assert.equal(repo.created[0].request.attendance_date, DATE);
  });
});
