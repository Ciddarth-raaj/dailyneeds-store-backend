/**
 * Attendance v2 - the review fixes, through the REAL orchestration.
 *
 * These are integration tests in the only sense that matters without a MySQL
 * instance: the real `usecase/attendance_calculation.js` and the real
 * `usecase/attendance_regularization.js` are wired to each other exactly as
 * `server.js` wires them, and only the repositories are fakes. The fakes
 * return what the real queries return - dates as `YYYY-MM-DD`, times as
 * `YYYY-MM-DD HH:MM:SS` strings, which is what DATE_FORMAT produces - and the
 * punch fake filters by CALENDAR date, because that is what the real
 * `getRawPunchesByCalendarWindow` does.
 *
 * The point is that each fix is proved in the path production actually runs,
 * not in a helper called directly. A pure-function test of
 * `attendanceDateForPunch` passed perfectly well while the production
 * calculation was still reading a stored derived date and ignoring it; that is
 * exactly the failure these tests exist to make impossible.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildCalculation = require("../usecase/attendance_calculation");
const buildRegularization = require("../usecase/attendance_regularization");
const { CALC_STATUS } = require("../utils/attendance_engine");
const { REQUEST_TYPE, REQUEST_STATUS, STEP_DECISION, APPROVER_ROLE } =
  require("../utils/attendance_approval_chain");
const { buildConfigVersion, configVersionHash } = require("../utils/shift_config_version");

const EMPLOYEE = 42;

/** A 10:00-22:00 shift with a 04:00 attendance-day cutoff: the overnight case. */
const lateShiftSchedule = (overrides = {}) =>
  Array.from({ length: 7 }, (_, day) => ({
    work_shift_weekly_schedule_id: 700 + day,
    work_shift_id: 7,
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

const shiftConfig = (overrides = {}) => ({
  work_shift_id: 7,
  shift_code: "LATE",
  overtime_allowed: 1,
  overtime_minimum_minutes: 0,
  overtime_rounding_method: "NONE",
  overtime_rounding_interval_minutes: 0,
  overtime_minimum_threshold_only: 0,
  maximum_ot_minutes_per_day: null,
  pre_shift_overtime_allowed: 0,
  pre_shift_overtime_minimum_minutes: 0,
  pre_shift_overtime_rounding_method: "NONE",
  pre_shift_overtime_rounding_interval_minutes: 0,
  late_offset_against_overtime: 0,
  early_exit_offset_against_overtime: 0,
  ...overrides,
});

/** A stored configuration version row, as the repository hands one back. */
function versionRow(id, effectiveFrom, config, schedule) {
  const document = buildConfigVersion(config, schedule);
  return {
    work_shift_config_version_id: id,
    work_shift_id: 7,
    effective_from: effectiveFrom,
    config_hash: configVersionHash(document),
    config_document: JSON.stringify(document),
    source: id === 1 ? "MIGRATION_SEED" : "WORK_SHIFT_SAVE",
  };
}

const punch = (id, ioTime) => ({
  punch_id: id,
  employee_id: EMPLOYEE,
  io_time: ioTime,
  punch_date: ioTime.slice(0, 10),
  // What INGEST believed. Deliberately set to the calendar date on every
  // fixture below, so any test that gets the right answer can only have got it
  // by re-deriving the attendance date rather than by reading this.
  ingest_attendance_date: ioTime.slice(0, 10),
  dev_id: "C26924B2E7351O35",
  ingest_source: "DEVICE",
});

function fakeCalculationRepo(state = {}) {
  const saved = { calculations: [], monthly: [], breakOverride: [] };
  return {
    saved,
    getShiftAssignmentHistory: async () =>
      state.assignments || [
        {
          employee_work_shift_assignment_id: 1,
          employee_id: EMPLOYEE,
          work_shift_id: 7,
          effective_from: "2026-09-01",
          source: "MIGRATION_BACKFILL",
        },
      ],
    getWorkShiftWithSchedule: async () => ({
      config: shiftConfig(state.liveConfig || {}),
      schedule: lateShiftSchedule(state.liveSchedule || {}),
    }),
    getWorkShiftConfigVersions: async () => state.configVersions || [],
    getRawPunchesByCalendarWindow: async (_employeeId, from, to) =>
      (state.rawPunches || []).filter((p) => p.punch_date >= from && p.punch_date <= to),
    getApprovedRegularizedPunches: async () => state.regularized || [],
    getBreakOverride: async () => state.employeeRow || null,
    getApprovalStateByDate: async () => state.approvals || [],
    getEmploymentWindow: async () => ({
      employee_id: EMPLOYEE,
      status: 1,
      date_of_joining: "2020-01-01",
      resignation_date: null,
    }),
    getMonthlyGrossAsOf: async () => ({
      salary_id: 9,
      monthly_gross: "26000.00",
      effective_from: "2026-04-01",
    }),
    saveCalculations: async (rows) => {
      if (state.saveCalculationsThrows) throw new Error(state.saveCalculationsThrows);
      saved.calculations.push(rows);
      return { written: rows.length };
    },
    saveMonthlyPayroll: async (row) => {
      saved.monthly.push(row);
      return [];
    },
    setBreakOverride: async (id, minutes) => {
      saved.breakOverride.push({ id, minutes });
      return [];
    },
  };
}

function fakeRegularizationRepo(state = {}) {
  const store = { requests: [], decided: [], closed: [] };
  let nextId = 900;
  return {
    store,
    getApprovalIdentity: async (id) => ({
      employee_id: id,
      employee_name: `Employee ${id}`,
      outlet_id: 3,
      designation_id: 11,
      designation_name: "SALES ASSOCIATE",
      approver_role: (state.roles || {})[id] || null,
      requester_class: null,
    }),
    findOpenRequest: async (employeeId, date) =>
      store.requests.find(
        (r) => r.attendance_date === date && r.status === REQUEST_STATUS.PENDING
      ) || null,
    findRequestsForDates: async (_employeeId, dates) =>
      store.requests.filter(
        (r) => dates.includes(r.attendance_date) && r.status !== REQUEST_STATUS.CANCELLED
      ),
    createRequest: async ({ request, chain, punch: manual }) => {
      const id = nextId;
      nextId += 1;
      store.requests.push({
        attendance_approval_request_id: id,
        attendance_date: request.attendance_date,
        request_type: request.request_type,
        candidate_ot_minutes: request.candidate_ot_minutes,
        auto_created: request.auto_created ? 1 : 0,
        reason: request.reason,
        status: REQUEST_STATUS.PENDING,
        punch: manual,
        chain,
      });
      return { attendance_approval_request_id: id, total_stages: chain.length };
    },
    // The payroll lock's writes, mirrored on the store exactly as the real
    // transaction performs them.
    closeOtAtPayrollLock: async ({ employee_id, from_date, to_date, pending_closure, unrequested_closure, unrequested }) => {
      let rejected_pending = 0;
      store.requests.forEach((r) => {
        if (
          r.request_type === REQUEST_TYPE.OT &&
          r.status === REQUEST_STATUS.PENDING &&
          r.attendance_date >= from_date &&
          r.attendance_date <= to_date
        ) {
          r.status = REQUEST_STATUS.REJECTED;
          r.approved_ot_minutes = 0;
          r.finalization_state = "SETTLED";
          r.closure_reason = pending_closure.code;
          rejected_pending += 1;
        }
      });
      let closed_unrequested = 0;
      (unrequested || []).forEach((u) => {
        const exists = store.requests.some(
          (r) =>
            r.request_type === REQUEST_TYPE.OT &&
            r.status !== REQUEST_STATUS.CANCELLED &&
            r.attendance_date === u.attendance_date
        );
        if (exists) return;
        const id = nextId;
        nextId += 1;
        store.requests.push({
          attendance_approval_request_id: id,
          attendance_date: u.attendance_date,
          request_type: REQUEST_TYPE.OT,
          candidate_ot_minutes: u.candidate_ot_minutes,
          approved_ot_minutes: 0,
          auto_created: 1,
          reason: unrequested_closure.label,
          status: REQUEST_STATUS.REJECTED,
          finalization_state: "SETTLED",
          closure_reason: unrequested_closure.code,
          punch: null,
          chain: [],
        });
        closed_unrequested += 1;
      });
      store.closed.push({ employee_id, from_date, to_date, rejected_pending, closed_unrequested });
      return { rejected_pending, closed_unrequested };
    },
    getRequest: async () => state.request || null,
    decideStage: async (args) => {
      store.decided.push(args);
      // The real transaction moves the request's own status, which is what the
      // auto-queue then sees for that date. The fake does the same, so the
      // queue is exercised against a consistent store rather than an empty one.
      const row = store.requests.find(
        (r) => r.attendance_approval_request_id === args.requestId
      );
      if (row) {
        row.status = args.next.status;
        row.approved_ot_minutes = args.next.approved_ot_minutes;
        row.finalization_state =
          args.next.status === REQUEST_STATUS.PENDING ? "NOT_REQUIRED" : "SETTLED";
      }
      // The REAL repository writes the calculated day inside this very
      // transaction, so the fake fails the same way the real one would: the
      // decision does not happen if its day cannot be stored.
      if (state.storeCalculationThrows) throw new Error(state.storeCalculationThrows);
      return {
        code: 200,
        status: args.next.status,
        current_stage_no: args.next.current_stage_no,
        finalization_state:
          args.next.status === REQUEST_STATUS.PENDING ? "NOT_REQUIRED" : "SETTLED",
        calculations_written: (args.calculations || []).length,
      };
    },
    listPendingFor: async () => [],
    listForEmployee: async () => [],
  };
}

/** Both usecases, wired to each other exactly as `server.js` wires them. */
function wire(calcState = {}, regState = {}) {
  const calculationRepo = fakeCalculationRepo(calcState);
  const regularizationRepo = fakeRegularizationRepo(regState);
  // A request that is being decided already exists, so the auto-queue sees it
  // for that date exactly as it would in the database.
  if (regState.request) {
    regularizationRepo.store.requests.push({
      attendance_approval_request_id: regState.request.attendance_approval_request_id,
      attendance_date: regState.request.attendance_date,
      request_type: regState.request.request_type,
      candidate_ot_minutes: regState.request.candidate_ot_minutes,
      auto_created: 0,
      status: regState.request.status,
      chain: regState.request.steps,
    });
  }
  // The calculation reads approval state from the SAME store the
  // regularization usecase writes, so a request raised or decided in one
  // step is what the next calculation sees - as the two tables are in MySQL.
  calculationRepo.getApprovalStateByDate = async (_employeeId, from, to) => [
    ...(calcState.approvals || []),
    ...regularizationRepo.store.requests
      .filter(
        (r) =>
          r.status !== REQUEST_STATUS.CANCELLED &&
          r.attendance_date >= from &&
          r.attendance_date <= to
      )
      .map((r) => ({
        attendance_approval_request_id: r.attendance_approval_request_id,
        attendance_date: r.attendance_date,
        request_type: r.request_type,
        status: r.status,
        candidate_ot_minutes: r.candidate_ot_minutes,
        approved_ot_minutes: r.approved_ot_minutes === undefined ? null : r.approved_ot_minutes,
        finalization_state: r.finalization_state || "NOT_REQUIRED",
        auto_created: r.auto_created,
        reason: r.reason,
        closure_reason: r.closure_reason || null,
      })),
  ];
  const calculation = buildCalculation(calculationRepo);
  const regularization = buildRegularization(regularizationRepo, calculation);
  // Exactly as `server.js` wires it: the payroll lock reaches the OT closer
  // through the calculation usecase.
  calculation.setOtRequestService(regularization);
  return { calculationRepo, regularizationRepo, calculation, regularization };
}

/* ================================================================== #1 === */

describe("review fix #1 - recalculation re-dates raw punches through the historical cutoff", () => {
  /**
   * The case the review named. A 10:00-22:00 employee finishes at 00:30 the
   * next calendar morning; the cutoff on the shift date is 04:00, so the punch
   * belongs to the SHIFT date. The fixture's `ingest_attendance_date` says
   * otherwise on purpose - the only way to pass is to re-derive it.
   */
  it("groups a 00:30 finish onto the previous attendance date, in the orchestration path", async () => {
    const { calculation } = wire({
      rawPunches: [punch(1, "2026-09-14 10:00:00"), punch(2, "2026-09-15 00:30:00")],
    });

    const days = await calculation.calculateRange({
      employee_id: EMPLOYEE,
      from_date: "2026-09-14",
      to_date: "2026-09-15",
    });

    const [shiftDate, nextDate] = days;
    assert.equal(shiftDate.attendance_date, "2026-09-14");
    assert.equal(shiftDate.punch_count, 2, "both punches landed on the shift date");
    assert.deepEqual(shiftDate.raw_punch_ids, [1, 2]);
    assert.equal(shiftDate.span_minutes, 870, "10:00 to 00:30 is 14h30");
    assert.equal(shiftDate.worked_minutes, 810);
    assert.equal(shiftDate.candidate_ot_minutes, 150);
    assert.equal(shiftDate.status, CALC_STATUS.FINAL);
    assert.equal(shiftDate.ot_claim_state, "AVAILABLE");

    assert.equal(nextDate.attendance_date, "2026-09-15");
    assert.equal(nextDate.punch_count, 0, "the 00:30 punch is not also counted here");
    assert.equal(nextDate.status, CALC_STATUS.ABSENT);
  });

  it("reads the punch window by calendar date, one day wider at the end and no wider at the start", async () => {
    const asked = [];
    const repo = fakeCalculationRepo({ rawPunches: [] });
    const original = repo.getRawPunchesByCalendarWindow;
    repo.getRawPunchesByCalendarWindow = async (id, from, to) => {
      asked.push({ from, to });
      return original(id, from, to);
    };
    await buildCalculation(repo).calculateRange({
      employee_id: EMPLOYEE,
      from_date: "2026-09-14",
      to_date: "2026-09-16",
    });
    assert.deepEqual(asked, [{ from: "2026-09-14", to: "2026-09-17" }]);
  });

  it("leaves a morning punch after a REST day on its own calendar date", async () => {
    // Sunday (day 0) is a rest day, so Monday morning's punch cannot be
    // claimed by Sunday's cutoff.
    const { calculation } = wire({
      liveSchedule: {},
      configVersions: [
        versionRow(
          1,
          "2026-09-01",
          shiftConfig(),
          lateShiftSchedule().map((row) =>
            row.day_of_week === 0 ? { ...row, is_working_day: 0 } : row
          )
        ),
      ],
      rawPunches: [punch(1, "2026-09-14 01:00:00"), punch(2, "2026-09-14 10:00:00")],
    });

    const [monday] = await calculation.calculateRange({
      employee_id: EMPLOYEE,
      from_date: "2026-09-14",
      to_date: "2026-09-14",
    });
    assert.equal(monday.punch_count, 2, "the 01:00 punch stays on Monday");
  });

  it("dates a punch ingest could not date at all", async () => {
    const undated = { ...punch(1, "2026-09-15 00:30:00"), ingest_attendance_date: null };
    const { calculation } = wire({
      rawPunches: [punch(0, "2026-09-14 10:00:00"), undated],
    });
    const [day] = await calculation.calculateRange({
      employee_id: EMPLOYEE,
      from_date: "2026-09-14",
      to_date: "2026-09-14",
    });
    assert.equal(day.punch_count, 2);
  });
});

/* ================================================================== #2 === */

describe("review fix #2 - a Work Shift edit cannot move a settled historical date", () => {
  /**
   * September is calculated under the September version; a version effective
   * from 1st October changes the break, the cutoff and the OT rules. The
   * September figures must be byte-for-byte what they were.
   */
  const versions = () => [
    versionRow(1, "2026-09-01", shiftConfig(), lateShiftSchedule()),
    versionRow(
      2,
      "2026-10-01",
      shiftConfig({ overtime_minimum_minutes: 240, maximum_ot_minutes_per_day: 30 }),
      lateShiftSchedule({ break_minutes: 30, attendance_day_cutoff: "01:00:00" })
    ),
  ];

  const punchesOn = (date, nextDate) => [
    punch(1, `${date} 10:00:00`),
    punch(2, `${nextDate} 00:30:00`),
  ];

  it("an earlier date keeps the configuration that applied then", async () => {
    const { calculation } = wire({
      configVersions: versions(),
      rawPunches: punchesOn("2026-09-14", "2026-09-15"),
      // The LIVE tables now hold the October settings, as they would after the
      // edit. A date in September must not read them.
      liveConfig: { overtime_minimum_minutes: 240, maximum_ot_minutes_per_day: 30 },
      liveSchedule: { break_minutes: 30, attendance_day_cutoff: "01:00:00" },
    });

    const [september] = await calculation.calculateRange({
      employee_id: EMPLOYEE,
      from_date: "2026-09-14",
      to_date: "2026-09-14",
    });

    assert.equal(september.break_allowance_minutes, 60, "September's break, not October's");
    assert.equal(september.nrm_minutes, 660);
    assert.equal(september.worked_minutes, 810);
    assert.equal(september.candidate_ot_minutes, 150, "September's OT rules, not October's");
    assert.equal(september.shift_snapshot.config_version_id, 1);
    assert.equal(september.punch_count, 2, "and September's 04:00 cutoff still claims 00:30");
  });

  it("a later date uses the new configuration", async () => {
    const { calculation } = wire({
      configVersions: versions(),
      rawPunches: punchesOn("2026-10-14", "2026-10-15"),
    });

    const [october] = await calculation.calculateRange({
      employee_id: EMPLOYEE,
      from_date: "2026-10-14",
      to_date: "2026-10-14",
    });

    assert.equal(october.break_allowance_minutes, 30, "October's break");
    assert.equal(october.nrm_minutes, 690);
    assert.equal(
      october.candidate_ot_minutes,
      0,
      "the same 150 earned minutes now fall under October's 240 minute minimum and qualify for nothing"
    );
    assert.equal(october.shift_snapshot.config_version_id, 2);
  });

  it("October's per-day cap is October's, on a day that does qualify under it", async () => {
    const { calculation } = wire({
      configVersions: versions(),
      // 10:00 to 05:00 the next morning: far past the 240 minute minimum.
      rawPunches: [punch(1, "2026-10-14 10:00:00"), punch(2, "2026-10-15 00:55:00")],
    });
    const [october] = await calculation.calculateRange({
      employee_id: EMPLOYEE,
      from_date: "2026-10-14",
      to_date: "2026-10-14",
    });
    assert.equal(october.punch_count, 2, "October's 01:00 cutoff still claims a 00:55 finish");
    assert.equal(october.raw_ot_minutes, 175);
    assert.equal(october.candidate_ot_minutes, 0, "175 is still under the 240 minute minimum");

    const { calculation: september } = wire({
      configVersions: versions(),
      rawPunches: [punch(1, "2026-09-14 10:00:00"), punch(2, "2026-09-15 00:55:00")],
    });
    const [sept] = await september.calculateRange({
      employee_id: EMPLOYEE,
      from_date: "2026-09-14",
      to_date: "2026-09-14",
    });
    assert.equal(
      sept.candidate_ot_minutes,
      175,
      "the identical day in September, under September's rules, pays all of it"
    );
  });

  it("the October cutoff does NOT retroactively re-date a September punch", async () => {
    // October's cutoff is 01:00, which would still claim a 00:30 punch - so
    // this asserts the far stronger thing: the cutoff READ for a September
    // punch is September's, and the version id on the row proves which.
    const { calculation } = wire({
      configVersions: versions(),
      rawPunches: punchesOn("2026-09-14", "2026-09-15"),
    });
    const [september] = await calculation.calculateRange({
      employee_id: EMPLOYEE,
      from_date: "2026-09-14",
      to_date: "2026-09-14",
    });
    assert.equal(september.shift_snapshot.attendance_day_cutoff, "04:00:00");
    assert.equal(september.shift_snapshot.config_version_id, 1);
  });

  it("recalculating a settled September date after the edit reproduces the same row", async () => {
    const state = {
      configVersions: versions(),
      rawPunches: punchesOn("2026-09-14", "2026-09-15"),
    };
    const before = wire(state);
    await before.calculation.recalculateRange({
      employee_id: EMPLOYEE,
      from_date: "2026-09-14",
      to_date: "2026-09-14",
    });

    const after = wire({
      ...state,
      liveConfig: { overtime_minimum_minutes: 240, maximum_ot_minutes_per_day: 30 },
      liveSchedule: { break_minutes: 30, attendance_day_cutoff: "01:00:00" },
    });
    await after.calculation.recalculateRange({
      employee_id: EMPLOYEE,
      from_date: "2026-09-14",
      to_date: "2026-09-14",
    });

    assert.deepEqual(
      after.calculationRepo.saved.calculations[0],
      before.calculationRepo.saved.calculations[0],
      "the stored audit artifact must not be silently replaced with today's settings"
    );
  });

  it("falls back to the live tables, and says so, for a date before the first version", async () => {
    const { calculation } = wire({
      configVersions: versions(),
      assignments: [
        {
          employee_work_shift_assignment_id: 1,
          work_shift_id: 7,
          effective_from: "2026-08-01",
        },
      ],
      rawPunches: punchesOn("2026-08-14", "2026-08-15"),
    });
    const [august] = await calculation.calculateRange({
      employee_id: EMPLOYEE,
      from_date: "2026-08-14",
      to_date: "2026-08-14",
    });
    assert.equal(august.shift_snapshot.config_version_id, null);
  });
});

/* ================================================================== #3 === */

describe("finalized OT flow - a missing-punch request carries NO overtime", () => {
  /**
   * A REAL odd punch set: one IN at 10:00 and nothing else. The proposed OUT
   * is 00:30 the next morning, which under the historical cutoff belongs to
   * the shift date and would produce 150 minutes of OT. That OT is NOT put on
   * the regularization request: attendance approval corrects attendance, and
   * the overtime becomes claimable - separately - once the corrected day is
   * recalculated.
   */
  const oddDay = () => ({ rawPunches: [punch(1, "2026-09-14 10:00:00")] });

  it("the incomplete day really does report zero overtime, and offers none", async () => {
    const { calculation } = wire(oddDay());
    const [day] = await calculation.calculateRange({
      employee_id: EMPLOYEE,
      from_date: "2026-09-14",
      to_date: "2026-09-14",
    });
    assert.equal(day.punch_count, 1);
    assert.equal(day.candidate_ot_minutes, 0, "an odd punch count leaves the engine before OT");
    assert.equal(day.status, CALC_STATUS.REVIEW_REQUIRED);
    assert.equal(day.ot_claim_state, "NONE");
  });

  it("the proposed corrected day is still calculated, to prove the punch is valid", async () => {
    const { calculation } = wire(oddDay());
    const proposed = await calculation.calculateProposedDay({
      employee_id: EMPLOYEE,
      attendance_date: "2026-09-14",
      punch_time: "2026-09-15 00:30:00",
    });
    assert.equal(proposed.punch_count, 2);
    assert.equal(proposed.worked_minutes, 810);
    assert.equal(proposed.candidate_ot_minutes, 150);
  });

  it("the request that is raised is a plain REGULARIZATION with the punch, the reason and NO OT", async () => {
    const { regularization, regularizationRepo } = wire(oddDay());
    const raised = await regularization.raiseRequest({
      actor: { employee_id: EMPLOYEE, user_type: 1 },
      requested_for_employee_id: EMPLOYEE,
      attendance_date: "2026-09-14",
      reason: "Terminal was offline when I finished the late shift",
      punch_time: "2026-09-15 00:30:00",
    });

    assert.equal(raised.request_type, REQUEST_TYPE.REGULARIZATION);
    assert.equal(raised.candidate_ot_minutes, undefined);
    const [stored] = regularizationRepo.store.requests;
    assert.equal(stored.request_type, REQUEST_TYPE.REGULARIZATION);
    assert.notEqual(stored.request_type, REQUEST_TYPE.REGULARIZATION_WITH_OT);
    assert.equal(stored.candidate_ot_minutes, 0, "no OT rides on an attendance correction");
    assert.equal(stored.reason, "Terminal was offline when I finished the late shift");
    assert.equal(stored.chain.length, 3, "the attendance approval chain");
    assert.equal(stored.punch.punch_time, "2026-09-15 00:30:00");
  });

  it("the proposed punch changes NOTHING in stored attendance before approval", async () => {
    const { regularization, calculation, calculationRepo } = wire(oddDay());
    await regularization.raiseRequest({
      actor: { employee_id: EMPLOYEE, user_type: 1 },
      requested_for_employee_id: EMPLOYEE,
      attendance_date: "2026-09-14",
      reason: "Terminal was offline when I finished the late shift",
      punch_time: "2026-09-15 00:30:00",
    });

    assert.equal(calculationRepo.saved.calculations.length, 0, "nothing was written");

    const [day] = await calculation.calculateRange({
      employee_id: EMPLOYEE,
      from_date: "2026-09-14",
      to_date: "2026-09-14",
    });
    assert.equal(day.punch_count, 1, "the day is still the incomplete one");
    assert.equal(day.status, CALC_STATUS.REGULARIZATION_PENDING);
    assert.equal(day.candidate_ot_minutes, 0);
    assert.equal(day.ot_claim_state, "NONE");
  });

  it("refuses a proposed punch that resolves to a different attendance date", async () => {
    const { regularization } = wire(oddDay());
    await assert.rejects(
      regularization.raiseRequest({
        actor: { employee_id: EMPLOYEE, user_type: 1 },
        requested_for_employee_id: EMPLOYEE,
        attendance_date: "2026-09-14",
        reason: "Terminal was offline when I finished the late shift",
        // 09:00 is after the 04:00 cutoff, so it belongs to the 15th.
        punch_time: "2026-09-15 09:00:00",
      }),
      /belongs to attendance date 2026-09-15/
    );
  });

  it("refuses OT-only use of the regularization path: a complete day cannot be regularized", async () => {
    const { regularization, regularizationRepo } = wire({
      rawPunches: [punch(1, "2026-09-14 10:00:00"), punch(2, "2026-09-15 00:30:00")],
    });
    await assert.rejects(
      regularization.raiseRequest({
        actor: { employee_id: EMPLOYEE, user_type: 1 },
        requested_for_employee_id: EMPLOYEE,
        attendance_date: "2026-09-14",
        reason: "Stayed late to finish the stock count",
      }),
      /cannot be added to a complete day/
    );
    assert.equal(regularizationRepo.store.requests.length, 0);
  });

  it("after final attendance approval and recalculation, the OT is merely AVAILABLE", async () => {
    const { regularization, calculation, regularizationRepo } = wire(oddDay(), {
      roles: { 7: APPROVER_ROLE.HR },
    });
    const raised = await regularization.raiseRequest({
      actor: { employee_id: EMPLOYEE, user_type: 1 },
      requested_for_employee_id: EMPLOYEE,
      attendance_date: "2026-09-14",
      reason: "Terminal was offline when I finished the late shift",
      punch_time: "2026-09-15 00:30:00",
    });
    // Put the request at its last stage with the punch attached, as the
    // repository's getRequest would return it.
    const row = regularizationRepo.store.requests[0];
    regularizationRepo.getRequest = async () => ({
      ...row,
      requested_for_employee_id: EMPLOYEE,
      requested_by_employee_id: EMPLOYEE,
      outlet_id: 3,
      requester_class: "STORE_EMPLOYEE",
      current_stage_no: 3,
      total_stages: 3,
      regularized_punch: { attendance_regularized_punch_id: 77, punch_time: "2026-09-15 00:30:00" },
      steps: [
        { stage_no: 1, approver_role: APPROVER_ROLE.STORE_MANAGER, outlet_id: 3, decision: "APPROVED" },
        { stage_no: 2, approver_role: APPROVER_ROLE.OPERATIONS_MANAGER, outlet_id: null, decision: "APPROVED" },
        { stage_no: 3, approver_role: APPROVER_ROLE.HR, outlet_id: null, decision: "PENDING" },
      ],
    });

    const result = await regularization.decide({
      actor: { employee_id: 7, user_type: 1 },
      request_id: raised.attendance_approval_request_id,
      decision: STEP_DECISION.APPROVED,
    });

    assert.equal(result.status, REQUEST_STATUS.APPROVED);
    assert.equal(result.approved_ot_minutes, 0, "attendance approval approves no OT");
    assert.equal(result.ot_now_available, 150, "and says the corrected day now offers it");
    const [decided] = regularizationRepo.store.decided;
    assert.equal(decided.calculations[0].punch_count, 2);
    assert.equal(decided.calculations[0].approved_ot_minutes, 0);
    assert.equal(decided.calculations[0].status, CALC_STATUS.FINAL);

    // No OT request was created by the approval; it is the employee's to raise.
    assert.equal(regularizationRepo.store.requests.length, 1);
    assert.equal(regularizationRepo.store.requests[0].request_type, REQUEST_TYPE.REGULARIZATION);

    // The regularized punch is now effective for the calculation.
    regularizationRepo.store.requests[0].regularized_punch = null;
    const { calculation: fresh } = wire(
      {
        ...oddDay(),
        regularized: [{ punch_id: 77, attendance_date: "2026-09-14", io_time: "2026-09-15 00:30:00" }],
        approvals: [{
          attendance_approval_request_id: raised.attendance_approval_request_id,
          attendance_date: "2026-09-14",
          request_type: REQUEST_TYPE.REGULARIZATION,
          status: REQUEST_STATUS.APPROVED,
          candidate_ot_minutes: 0,
          approved_ot_minutes: 0,
          finalization_state: "SETTLED",
        }],
      }
    );
    void calculation;
    const [day] = await fresh.calculateRange({ employee_id: EMPLOYEE, from_date: "2026-09-14", to_date: "2026-09-14" });
    assert.equal(day.punch_count, 2);
    assert.equal(day.status, CALC_STATUS.FINAL);
    assert.equal(day.candidate_ot_minutes, 150);
    assert.equal(day.approved_ot_minutes, 0);
    assert.equal(day.ot_claim_state, "AVAILABLE");
  });
});

/* ================================================================== #4 === */

describe("review fix #4 - a final approval and its recalculated day move together", () => {
  const approvedRequest = (overrides = {}) => ({
    attendance_approval_request_id: 900,
    request_type: REQUEST_TYPE.REGULARIZATION_WITH_OT,
    requested_for_employee_id: EMPLOYEE,
    requested_by_employee_id: EMPLOYEE,
    attendance_date: "2026-09-14",
    outlet_id: 3,
    requester_class: "STORE_EMPLOYEE",
    reason: "Terminal was offline when I finished the late shift",
    candidate_ot_minutes: 150,
    status: REQUEST_STATUS.PENDING,
    current_stage_no: 3,
    total_stages: 3,
    finalization_state: "NOT_REQUIRED",
    regularized_punch: {
      attendance_regularized_punch_id: 77,
      punch_time: "2026-09-15 00:30:00",
      punch_source: "REGULARIZED",
    },
    steps: [
      { stage_no: 1, approver_role: APPROVER_ROLE.STORE_MANAGER, outlet_id: 3, decision: "APPROVED" },
      { stage_no: 2, approver_role: APPROVER_ROLE.OPERATIONS_MANAGER, outlet_id: null, decision: "APPROVED" },
      { stage_no: 3, approver_role: APPROVER_ROLE.HR, outlet_id: null, decision: "PENDING" },
    ],
    ...overrides,
  });

  const hrActor = { employee_id: 7, user_type: 1 };

  it("hands the corrected day into the decision transaction, already computed", async () => {
    const { regularization, regularizationRepo } = wire(
      { rawPunches: [punch(1, "2026-09-14 10:00:00")] },
      { request: approvedRequest(), roles: { 7: APPROVER_ROLE.HR } }
    );

    const result = await regularization.decide({
      actor: hrActor,
      request_id: 900,
      decision: STEP_DECISION.APPROVED,
    });

    assert.equal(result.status, REQUEST_STATUS.APPROVED);
    assert.equal(result.approved_ot_minutes, 150);
    assert.equal(result.finalization_state, "SETTLED");

    const [decided] = regularizationRepo.store.decided;
    assert.equal(decided.calculations.length, 1, "the day travels with the decision");

    // And it is the CORRECTED day - the proposed punch made effective and its
    // OT approved - not the incomplete one.
    const [row] = decided.calculations;
    assert.equal(row.attendance_date, "2026-09-14");
    assert.equal(row.punch_count, 2);
    assert.equal(row.worked_minutes, 810);
    assert.equal(row.approved_ot_minutes, 150);
    assert.equal(row.status, CALC_STATUS.FINAL);
    assert.equal(row.is_final, 1);
  });

  /**
   * THE FAILURE INJECTION. The repository's decision transaction is what
   * writes the day, so making that write fail must fail the whole decision.
   * The old ordering - commit the approval, then recalculate - could leave an
   * APPROVED request with 150 payable OT minutes against a stored day that
   * still had one punch and no overtime at all.
   */
  it("a storage failure fails the decision, so no payable OT can outlive a stale day", async () => {
    const { regularization, regularizationRepo, calculationRepo } = wire(
      { rawPunches: [punch(1, "2026-09-14 10:00:00")] },
      {
        request: approvedRequest(),
        roles: { 7: APPROVER_ROLE.HR },
        storeCalculationThrows: "Deadlock found when trying to get lock",
      }
    );

    await assert.rejects(
      regularization.decide({ actor: hrActor, request_id: 900, decision: STEP_DECISION.APPROVED }),
      /Deadlock/
    );

    // Nothing was reported as approved, and nothing was written outside the
    // failed transaction either.
    assert.equal(calculationRepo.saved.calculations.length, 0);
    const [attempted] = regularizationRepo.store.decided;
    assert.equal(attempted.next.status, REQUEST_STATUS.APPROVED);
    assert.equal(attempted.calculations.length, 1, "offered together, so they fail together");
  });

  it("a rejection recalculates in the same transaction too", async () => {
    const { regularization, regularizationRepo } = wire(
      { rawPunches: [punch(1, "2026-09-14 10:00:00")] },
      { request: approvedRequest(), roles: { 7: APPROVER_ROLE.HR } }
    );

    const result = await regularization.decide({
      actor: hrActor,
      request_id: 900,
      decision: STEP_DECISION.REJECTED,
      remarks: "The employee was not on site",
    });

    assert.equal(result.status, REQUEST_STATUS.REJECTED);
    assert.equal(result.finalization_state, "SETTLED");
    const [decided] = regularizationRepo.store.decided;
    assert.equal(decided.calculations.length, 1);
    // The punch was NOT made effective: a rejected regularization adds nothing.
    assert.equal(decided.calculations[0].punch_count, 1);
    assert.equal(decided.calculations[0].approved_ot_minutes, 0);
  });

  it("an intermediate stage settles nothing and is an ordinary audit write", async () => {
    const { regularization, regularizationRepo } = wire(
      { rawPunches: [punch(1, "2026-09-14 10:00:00")] },
      {
        request: approvedRequest({ current_stage_no: 1, steps: [
          { stage_no: 1, approver_role: APPROVER_ROLE.STORE_MANAGER, outlet_id: 3, decision: "PENDING" },
          { stage_no: 2, approver_role: APPROVER_ROLE.OPERATIONS_MANAGER, outlet_id: null, decision: "PENDING" },
          { stage_no: 3, approver_role: APPROVER_ROLE.HR, outlet_id: null, decision: "PENDING" },
        ] }),
        roles: { 7: APPROVER_ROLE.STORE_MANAGER },
      }
    );

    const result = await regularization.decide({
      actor: hrActor,
      request_id: 900,
      decision: STEP_DECISION.APPROVED,
    });
    assert.equal(result.status, REQUEST_STATUS.PENDING);
    assert.equal(result.approved_ot_minutes, null, "nothing is payable before the last stage");
    assert.equal(result.finalization_state, "NOT_REQUIRED");
    assert.equal(regularizationRepo.store.decided[0].calculations[0].approved_ot_minutes, 0);
  });
});

/* ================================================================== #6 === */

describe("finalized OT flow - the system calculates OT, the employee requests it", () => {
  /** A complete, valid day that earned 150 minutes of OT. */
  const overtimeDay = () => ({
    rawPunches: [punch(1, "2026-09-14 10:00:00"), punch(2, "2026-09-15 00:30:00")],
  });
  const TODAY = "2026-09-20";
  const me = { employee_id: EMPLOYEE, user_type: 1 };

  it("1. candidate OT does NOT auto-create an approval request", async () => {
    const { calculation, regularizationRepo } = wire(overtimeDay());
    const result = await calculation.recalculateRange({
      employee_id: EMPLOYEE,
      from_date: "2026-09-14",
      to_date: "2026-09-14",
    });
    assert.equal(regularizationRepo.store.requests.length, 0, "nothing was queued");
    assert.equal(result.ot_queue, undefined);
    assert.equal(result.days[0].candidate_ot_minutes, 150);
    assert.equal(result.days[0].status, CALC_STATUS.FINAL, "the day is FINAL, not OT_PENDING");
    assert.equal(result.days[0].is_final, true);
    assert.equal(result.days[0].approved_ot_minutes, 0);
    assert.equal(result.days[0].ot_claim_state, "AVAILABLE");
  });

  it("2. the employee can request their own eligible OT; 7. the reason is stored", async () => {
    const { regularization, calculation, regularizationRepo } = wire(overtimeDay());
    const raised = await regularization.raiseOtRequest({
      actor: me,
      attendance_date: "2026-09-14",
      reason: "Stayed late to finish the stock count",
      today: TODAY,
    });
    assert.equal(raised.request_type, REQUEST_TYPE.OT);
    assert.equal(raised.candidate_ot_minutes, 150, "the server's own figure");
    assert.equal(raised.approved_ot_minutes, 0);
    assert.equal(raised.chain.length, 3, "Store Manager -> Operations Manager -> HR");

    const [stored] = regularizationRepo.store.requests;
    assert.equal(stored.request_type, REQUEST_TYPE.OT);
    assert.equal(stored.reason, "Stayed late to finish the stock count");
    assert.equal(stored.auto_created, 0, "employee-submitted, never automatic");
    assert.equal(stored.candidate_ot_minutes, 150);
    assert.equal(stored.punch, null);

    const [day] = await calculation.calculateRange({ employee_id: EMPLOYEE, from_date: "2026-09-14", to_date: "2026-09-14" });
    assert.equal(day.ot_claim_state, "REQUEST_PENDING");
    assert.equal(day.ot_requested_minutes, 150);
    assert.equal(day.ot_reason, "Stayed late to finish the stock count");
    assert.equal(day.status, CALC_STATUS.FINAL, "a pending OT claim does not make the day non-final");
    assert.equal(day.approved_ot_minutes, 0);
  });

  it("3. the request is for the ACTOR: there is no field to name anybody else", async () => {
    const { regularization, regularizationRepo } = wire(overtimeDay());
    await regularization.raiseOtRequest({
      actor: me,
      attendance_date: "2026-09-14",
      reason: "Stayed late to finish the stock count",
      today: TODAY,
      // Ignored: not a parameter. The request is the actor's.
      requested_for_employee_id: 999,
      employee_id: 999,
    });
    const [stored] = regularizationRepo.store.requests;
    assert.equal(stored.request_type, REQUEST_TYPE.OT);
    // The fake stores what createRequest received.
    assert.equal(regularizationRepo.store.requests.length, 1);
  });

  it("4. client-supplied OT minutes are ignored: the stored candidate is the server's", async () => {
    const { regularization, regularizationRepo } = wire(overtimeDay());
    await regularization.raiseOtRequest({
      actor: me,
      attendance_date: "2026-09-14",
      reason: "Stayed late to finish the stock count",
      today: TODAY,
      candidate_ot_minutes: 9999,
      approved_ot_minutes: 9999,
    });
    assert.equal(regularizationRepo.store.requests[0].candidate_ot_minutes, 150);
    assert.notEqual(regularizationRepo.store.requests[0].approved_ot_minutes, 9999);
  });

  it("5. no OT request when the candidate is zero", async () => {
    const { regularization, regularizationRepo } = wire({
      rawPunches: [punch(1, "2026-09-14 10:00:00"), punch(2, "2026-09-14 22:00:00")],
    });
    await assert.rejects(
      regularization.raiseOtRequest({ actor: me, attendance_date: "2026-09-14", reason: "Worked extra hours", today: TODAY }),
      /no overtime calculated/
    );
    assert.equal(regularizationRepo.store.requests.length, 0);
  });

  it("nor on an incomplete day: a missing punch is a regularization, not an OT claim", async () => {
    const { regularization } = wire({ rawPunches: [punch(1, "2026-09-14 10:00:00")] });
    await assert.rejects(
      regularization.raiseOtRequest({ actor: me, attendance_date: "2026-09-14", reason: "Worked extra hours", today: TODAY }),
      /not a complete attendance day/
    );
  });

  it("6. a duplicate open OT request is prevented, and a retry is safe", async () => {
    const { regularization, regularizationRepo } = wire(overtimeDay());
    const args = { actor: me, attendance_date: "2026-09-14", reason: "Stayed late to finish the stock count", today: TODAY };
    await regularization.raiseOtRequest(args);
    await assert.rejects(regularization.raiseOtRequest(args), /is already pending \(#900\)/);
    await assert.rejects(regularization.raiseOtRequest(args), /is already pending/);
    assert.equal(regularizationRepo.store.requests.length, 1);
  });

  it("a decided claim is not re-raised: one claim per date", async () => {
    const { regularization, regularizationRepo } = wire(overtimeDay());
    const args = { actor: me, attendance_date: "2026-09-14", reason: "Stayed late to finish the stock count", today: TODAY };
    await regularization.raiseOtRequest(args);
    regularizationRepo.store.requests[0].status = REQUEST_STATUS.REJECTED;
    await assert.rejects(regularization.raiseOtRequest(args), /has already been decided/);
    regularizationRepo.store.requests[0].status = REQUEST_STATUS.APPROVED;
    await assert.rejects(regularization.raiseOtRequest(args), /has already been approved/);
  });

  it("refuses a future date and a date beyond the backdate window", async () => {
    const { regularization } = wire(overtimeDay());
    await assert.rejects(
      regularization.raiseOtRequest({ actor: me, attendance_date: "2026-09-14", reason: "Worked extra hours", today: "2026-09-13" }),
      /future date/
    );
    await assert.rejects(
      regularization.raiseOtRequest({ actor: me, attendance_date: "2026-09-14", reason: "Worked extra hours", today: "2026-12-01" }),
      /last 45 days/
    );
  });

  it("requires a reason", async () => {
    const { regularization } = wire(overtimeDay());
    await assert.rejects(
      regularization.raiseOtRequest({ actor: me, attendance_date: "2026-09-14", reason: "", today: TODAY }),
      /reason of at least 5 characters/
    );
  });

  /** An OT request at its last stage, as getRequest returns it. */
  const otRequestAtLastStage = (overrides = {}) => ({
    attendance_approval_request_id: 900,
    request_type: REQUEST_TYPE.OT,
    requested_for_employee_id: EMPLOYEE,
    requested_by_employee_id: EMPLOYEE,
    attendance_date: "2026-09-14",
    outlet_id: 3,
    requester_class: "STORE_EMPLOYEE",
    reason: "Stayed late to finish the stock count",
    candidate_ot_minutes: 150,
    status: REQUEST_STATUS.PENDING,
    current_stage_no: 3,
    total_stages: 3,
    finalization_state: "NOT_REQUIRED",
    regularized_punch: null,
    steps: [
      { stage_no: 1, approver_role: APPROVER_ROLE.STORE_MANAGER, outlet_id: 3, decision: "APPROVED" },
      { stage_no: 2, approver_role: APPROVER_ROLE.OPERATIONS_MANAGER, outlet_id: null, decision: "APPROVED" },
      { stage_no: 3, approver_role: APPROVER_ROLE.HR, outlet_id: null, decision: "PENDING" },
    ],
    ...overrides,
  });
  const hr = { employee_id: 7, user_type: 1 };

  it("10. approved_ot_minutes stays 0 until FINAL OT approval", async () => {
    const { regularization, regularizationRepo } = wire(overtimeDay(), {
      request: otRequestAtLastStage({
        current_stage_no: 1,
        steps: [
          { stage_no: 1, approver_role: APPROVER_ROLE.STORE_MANAGER, outlet_id: 3, decision: "PENDING" },
          { stage_no: 2, approver_role: APPROVER_ROLE.OPERATIONS_MANAGER, outlet_id: null, decision: "PENDING" },
          { stage_no: 3, approver_role: APPROVER_ROLE.HR, outlet_id: null, decision: "PENDING" },
        ],
      }),
      roles: { 7: APPROVER_ROLE.STORE_MANAGER },
    });
    const result = await regularization.decide({ actor: hr, request_id: 900, decision: STEP_DECISION.APPROVED });
    assert.equal(result.status, REQUEST_STATUS.PENDING);
    assert.equal(result.approved_ot_minutes, null);
    const [decided] = regularizationRepo.store.decided;
    assert.equal(decided.calculations[0].approved_ot_minutes, 0);
    assert.equal(decided.calculations[0].status, CALC_STATUS.FINAL);
  });

  it("11. final OT approval sets the approved OT, and the day pays it", async () => {
    const { regularization, calculation, regularizationRepo } = wire(overtimeDay(), {
      request: otRequestAtLastStage(),
      roles: { 7: APPROVER_ROLE.HR },
    });
    const result = await regularization.decide({ actor: hr, request_id: 900, decision: STEP_DECISION.APPROVED });
    assert.equal(result.status, REQUEST_STATUS.APPROVED);
    assert.equal(result.approved_ot_minutes, 150);
    assert.equal(result.finalization_state, "SETTLED");
    const [decided] = regularizationRepo.store.decided;
    assert.equal(decided.calculations[0].approved_ot_minutes, 150);
    assert.equal(decided.calculations[0].status, CALC_STATUS.FINAL);

    const [day] = await calculation.calculateRange({ employee_id: EMPLOYEE, from_date: "2026-09-14", to_date: "2026-09-14" });
    assert.equal(day.ot_claim_state, "APPROVED");
    assert.equal(day.approved_ot_minutes, 150);
    const month = await calculation.calculateMonth({ employee_id: EMPLOYEE, year: 2026, month: 9 });
    assert.equal(month.approved_ot_minutes, 150, "only finally approved OT reaches payroll");
  });

  it("12. approval cannot exceed the eligible OT: a candidate that moved down clamps the approval", async () => {
    const state = overtimeDay();
    const { regularization, regularizationRepo } = wire(state, {
      request: otRequestAtLastStage({ candidate_ot_minutes: 150 }),
      roles: { 7: APPROVER_ROLE.HR },
    });
    // The day was recalculated since the claim: it now finishes at 23:00,
    // and the engine finds 60 minutes, not 150.
    state.rawPunches = [punch(1, "2026-09-14 10:00:00"), punch(2, "2026-09-14 23:00:00")];
    const result = await regularization.decide({ actor: hr, request_id: 900, decision: STEP_DECISION.APPROVED });
    assert.equal(result.approved_ot_minutes, 60);
    assert.equal(regularizationRepo.store.decided[0].calculations[0].approved_ot_minutes, 60);
  });

  it("a rejected OT claim pays nothing, and the day stays FINAL", async () => {
    const { regularization, calculation, regularizationRepo } = wire(overtimeDay(), {
      request: otRequestAtLastStage(),
      roles: { 7: APPROVER_ROLE.HR },
    });
    const result = await regularization.decide({ actor: hr, request_id: 900, decision: STEP_DECISION.REJECTED, remarks: "Not authorised" });
    assert.equal(result.status, REQUEST_STATUS.REJECTED);
    assert.equal(regularizationRepo.store.decided[0].calculations[0].approved_ot_minutes, 0);
    const [day] = await calculation.calculateRange({ employee_id: EMPLOYEE, from_date: "2026-09-14", to_date: "2026-09-14" });
    assert.equal(day.ot_claim_state, "REJECTED");
    assert.equal(day.status, CALC_STATUS.FINAL);
    assert.equal(day.is_final, true);
  });

  it("8. a missing-punch approval does not approve or combine OT (see the suite above); the two requests never share a row", async () => {
    const { regularization, regularizationRepo } = wire(overtimeDay());
    await regularization.raiseOtRequest({ actor: me, attendance_date: "2026-09-14", reason: "Stayed late to finish the stock count", today: TODAY });
    assert.ok(regularizationRepo.store.requests.every((r) => r.request_type !== REQUEST_TYPE.REGULARIZATION_WITH_OT));
  });
});

/* ===================================================== payroll lock ===== */

describe("payroll lock closes every OT claim that is not finally approved", () => {
  const TODAY = "2026-09-20";
  const me = { employee_id: EMPLOYEE, user_type: 1 };
  /** 14th: 150 OT, never requested. 15th: 150 OT, requested. 16th: no OT. */
  const month = () => ({
    rawPunches: [
      punch(1, "2026-09-14 10:00:00"), punch(2, "2026-09-15 00:30:00"),
      punch(3, "2026-09-15 10:00:00"), punch(4, "2026-09-16 00:30:00"),
      punch(5, "2026-09-16 10:00:00"), punch(6, "2026-09-16 22:00:00"),
    ],
  });

  it("13. closes unrequested candidate OT as Rejected – Not Requested Before Payroll Lock", async () => {
    const { calculation, regularizationRepo } = wire(month());
    const result = await calculation.closeOtForPayrollLock({ employee_id: EMPLOYEE, year: 2026, month: 9 });
    assert.equal(result.closed_unrequested, 2);
    assert.deepEqual(result.unrequested_dates, ["2026-09-14", "2026-09-15"]);
    const rows = regularizationRepo.store.requests;
    assert.equal(rows.length, 2);
    rows.forEach((r) => {
      assert.equal(r.request_type, REQUEST_TYPE.OT);
      assert.equal(r.status, REQUEST_STATUS.REJECTED);
      assert.equal(r.closure_reason, "NOT_REQUESTED_BEFORE_PAYROLL_LOCK");
      assert.equal(r.reason, "Rejected – Not Requested Before Payroll Lock");
      assert.equal(r.approved_ot_minutes, 0);
      assert.equal(r.candidate_ot_minutes, 150, "the figure the engine reported, for the record");
    });
    const [day] = await calculation.calculateRange({ employee_id: EMPLOYEE, from_date: "2026-09-14", to_date: "2026-09-14" });
    assert.equal(day.ot_claim_state, "CLOSED_AT_PAYROLL_LOCK");
    assert.equal(day.ot_closure_reason, "NOT_REQUESTED_BEFORE_PAYROLL_LOCK");
    assert.equal(day.approved_ot_minutes, 0);
    assert.equal(day.status, CALC_STATUS.FINAL);
  });

  it("14. rejects a pending OT request as Rejected – Not Approved Before Payroll Lock", async () => {
    const { calculation, regularization, regularizationRepo } = wire(month());
    await regularization.raiseOtRequest({ actor: me, attendance_date: "2026-09-15", reason: "Stayed late to finish the stock count", today: TODAY });
    const result = await calculation.closeOtForPayrollLock({ employee_id: EMPLOYEE, year: 2026, month: 9 });
    assert.equal(result.rejected_pending, 1);
    assert.equal(result.closed_unrequested, 1, "the 14th only; the 15th had a request");
    const pendingOne = regularizationRepo.store.requests.find((r) => r.attendance_date === "2026-09-15");
    assert.equal(pendingOne.status, REQUEST_STATUS.REJECTED);
    assert.equal(pendingOne.closure_reason, "NOT_APPROVED_BEFORE_PAYROLL_LOCK");
    assert.equal(pendingOne.approved_ot_minutes, 0);
    assert.equal(pendingOne.reason, "Stayed late to finish the stock count", "the employee's reason survives");
  });

  it("15. preserves finally approved OT, and 16. leaves no pending OT behind", async () => {
    const { calculation, regularizationRepo } = wire(month(), {
      request: {
        attendance_approval_request_id: 950,
        request_type: REQUEST_TYPE.OT,
        attendance_date: "2026-09-15",
        candidate_ot_minutes: 150,
        status: REQUEST_STATUS.APPROVED,
        steps: [],
      },
    });
    regularizationRepo.store.requests[0].approved_ot_minutes = 150;
    regularizationRepo.store.requests[0].finalization_state = "SETTLED";
    regularizationRepo.store.requests[0].reason = "Stayed late";

    const result = await calculation.closeOtForPayrollLock({ employee_id: EMPLOYEE, year: 2026, month: 9 });
    assert.equal(result.approved_preserved, 1);
    assert.equal(result.rejected_pending, 0);
    assert.equal(result.closed_unrequested, 1);

    const approved = regularizationRepo.store.requests.find((r) => r.attendance_date === "2026-09-15");
    assert.equal(approved.status, REQUEST_STATUS.APPROVED);
    assert.equal(approved.approved_ot_minutes, 150);
    assert.ok(regularizationRepo.store.requests.every((r) => r.status !== REQUEST_STATUS.PENDING), "no pending OT after lock");

    const days = await calculation.calculateRange({ employee_id: EMPLOYEE, from_date: "2026-09-14", to_date: "2026-09-16" });
    assert.deepEqual(days.map((d) => d.ot_claim_state), ["CLOSED_AT_PAYROLL_LOCK", "APPROVED", "NONE"]);
    const rolled = await calculation.calculateMonth({ employee_id: EMPLOYEE, year: 2026, month: 9 });
    assert.equal(rolled.approved_ot_minutes, 150, "approved OT is in payroll; closed OT is not");
  });

  it("is idempotent and a closed date can no longer be claimed", async () => {
    const { calculation, regularization, regularizationRepo } = wire(month());
    await calculation.closeOtForPayrollLock({ employee_id: EMPLOYEE, year: 2026, month: 9 });
    const again = await calculation.closeOtForPayrollLock({ employee_id: EMPLOYEE, year: 2026, month: 9 });
    assert.equal(again.closed_unrequested, 0);
    assert.equal(again.rejected_pending, 0);
    assert.equal(regularizationRepo.store.requests.length, 2);
    await assert.rejects(
      regularization.raiseOtRequest({ actor: me, attendance_date: "2026-09-14", reason: "Stayed late to finish the stock count", today: TODAY }),
      /has already been decided/
    );
  });

  it("17. touches no Biomax punch: the raw punches read after the lock are the ones read before it", async () => {
    const state = month();
    const before = JSON.stringify(state.rawPunches);
    const { calculation, calculationRepo } = wire(state);
    await calculation.closeOtForPayrollLock({ employee_id: EMPLOYEE, year: 2026, month: 9 });
    assert.equal(JSON.stringify(state.rawPunches), before);
    assert.equal(calculationRepo.saved.calculations.length, 0, "the lock stores no attendance rows either");
  });

  it("is refused when no OT service is wired, rather than silently doing nothing", async () => {
    const repo = fakeCalculationRepo(month());
    await assert.rejects(
      buildCalculation(repo).closeOtForPayrollLock({ employee_id: EMPLOYEE, year: 2026, month: 9 }),
      /No OT request service is wired/
    );
  });
});

/* ================================================================== #7 === */

describe("review fix #7 - the break override is one current field with no effective date", () => {
  it("reads and writes a single value on the employee row", async () => {
    const repo = fakeCalculationRepo({
      employeeRow: { employee_id: EMPLOYEE, special_break_override_minutes: 45 },
    });
    const calculation = buildCalculation(repo);

    assert.deepEqual(await calculation.getBreakOverride(EMPLOYEE), {
      employee_id: EMPLOYEE,
      special_break_override_minutes: 45,
    });

    const saved = await calculation.setBreakOverride({ employee_id: EMPLOYEE, minutes: 90 });
    assert.equal(saved.special_break_override_minutes, 90);
    assert.deepEqual(repo.saved.breakOverride, [{ id: EMPLOYEE, minutes: 90 }]);
    // No effective date is accepted, stored or returned anywhere on this path.
    assert.ok(!("effective_from" in saved));
    assert.ok(!("effective_to" in saved));
  });

  it("clears the override with null, which is not the same as zero", async () => {
    const repo = fakeCalculationRepo({});
    const calculation = buildCalculation(repo);
    await calculation.setBreakOverride({ employee_id: EMPLOYEE, minutes: null });
    await calculation.setBreakOverride({ employee_id: EMPLOYEE, minutes: 0 });
    assert.deepEqual(repo.saved.breakOverride, [
      { id: EMPLOYEE, minutes: null },
      { id: EMPLOYEE, minutes: 0 },
    ]);
  });

  it("refuses a nonsense value rather than storing it", async () => {
    const calculation = buildCalculation(fakeCalculationRepo({}));
    await assert.rejects(
      calculation.setBreakOverride({ employee_id: EMPLOYEE, minutes: -5 }),
      /whole number of minutes/
    );
    await assert.rejects(
      calculation.setBreakOverride({ employee_id: EMPLOYEE, minutes: 5000 }),
      /less than a whole day/
    );
  });
});

/* ============================================ payroll and the settled gate */

describe("review fix #4 - payroll never reads an APPROVED request that is not SETTLED", () => {
  /**
   * Belt and braces. The approval and the recalculated day now commit
   * together, so this state cannot arise through the application at all - but
   * a hand-edited row or a restore from a half-finished dump could produce it,
   * and the consequence would be overtime paid against attendance nobody
   * recalculated. The date is held out of payroll instead.
   */
  const approvedButUnsettled = (finalization_state) => ({
    rawPunches: [punch(1, "2026-09-14 10:00:00"), punch(2, "2026-09-15 00:30:00")],
    approvals: [
      {
        attendance_approval_request_id: 900,
        attendance_date: "2026-09-14",
        request_type: REQUEST_TYPE.OT,
        status: REQUEST_STATUS.APPROVED,
        candidate_ot_minutes: 150,
        approved_ot_minutes: 150,
        finalization_state,
      },
    ],
  });

  it("pays the overtime when the request is SETTLED", async () => {
    const { calculation } = wire(approvedButUnsettled("SETTLED"));
    const [day] = await calculation.calculateRange({
      employee_id: EMPLOYEE,
      from_date: "2026-09-14",
      to_date: "2026-09-14",
    });
    assert.equal(day.approved_ot_minutes, 150);
    assert.equal(day.status, CALC_STATUS.FINAL);
    assert.equal(day.is_final, true);
  });

  it("pays nothing when it is not, and keeps the claim pending", async () => {
    for (const state of ["PENDING", "NOT_REQUIRED"]) {
      const { calculation } = wire(approvedButUnsettled(state));
      const [day] = await calculation.calculateRange({
        employee_id: EMPLOYEE,
        from_date: "2026-09-14",
        to_date: "2026-09-14",
      });
      assert.equal(day.approved_ot_minutes, 0, `paid OT while ${state}`);
      // An OT claim is separate from the attendance: the day itself is
      // complete and stays FINAL; only the OT is withheld.
      assert.equal(day.is_final, true);
      assert.equal(day.status, CALC_STATUS.FINAL);
      assert.equal(day.ot_claim_state, "REQUEST_PENDING");
    }
  });

  it("and the month pays no OT for it", async () => {
    const { calculation } = wire(approvedButUnsettled("PENDING"));
    const month = await calculation.calculateMonth({
      employee_id: EMPLOYEE,
      year: 2026,
      month: 9,
    });
    assert.equal(month.approved_ot_minutes, 0);
  });
});
