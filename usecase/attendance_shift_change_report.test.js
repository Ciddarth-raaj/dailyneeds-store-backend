/**
 * THE SHIFT CHANGE ELIGIBILITY REPORT, end to end.
 *
 *   node --test usecase/attendance_shift_change_report.test.js
 *
 * No MySQL. The fake repositories return exactly the shapes the real
 * statements return - dates as `YYYY-MM-DD`, times as `YYYY-MM-DD HH:MM:SS`,
 * which is what DATE_FORMAT produces.
 *
 * THE DASHBOARD USECASE IS REAL, NOT FAKED, exactly as Missing Attendance's
 * suite keeps it real: the worked minutes these assertions turn on are the
 * ones `computeDaysForEmployee` produces from re-dated, de-duplicated,
 * un-voided effective punches against the shift version dated to that day -
 * the same number every attendance screen shows.
 *
 * AND THE ELIGIBILITY RULE IS THE PRODUCTION ONE. The last suite here builds
 * the real `raiseShiftChangeRequest` over the same fixtures and asserts the
 * two answers agree, case by case. It is the test that fails if anybody ever
 * gives the report an eligibility branch of its own.
 *
 * `today` is pinned in every test. A report whose contents depend on the hour
 * the suite happens to run is a report nobody can test.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildDashboard = require("../usecase/attendance_dashboard");
const buildReport = require("../usecase/attendance_shift_change_report");
const buildRegularization = require("../usecase/attendance_regularization");

const TODAY = "2026-09-19";
const YESTERDAY = "2026-09-18";

/** An instant on an IST business date, as the epoch the punch rows carry. */
const istInstant = (date, hh, mm) =>
  Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), hh, mm) -
  (5 * 60 + 30) * 60 * 1000;

/** `YYYY-MM-DD HH:MM:SS` in IST, which is what DATE_FORMAT hands back. */
const ist = (date, hh, mm) =>
  `${date} ${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00`;

/**
 * A seven-day schedule for a shift.
 *
 * SHIFT 7 is the SHORT one, 18:00-22:00, NRM 240. SHIFT 8 is the LONG one,
 * 10:00-22:00 less an hour, NRM 660. They are the two shifts in the brief's
 * own example, and every eligibility assertion below turns on which way round
 * an employee is assigned to them.
 */
const scheduleRows = (workShiftId, inTime, outTime, breakMinutes, nrm) =>
  Array.from({ length: 7 }, (_, day) => ({
    work_shift_weekly_schedule_id: workShiftId * 10 + day,
    work_shift_id: workShiftId,
    day_of_week: day,
    is_working_day: 1,
    in_time: inTime,
    out_time: outTime,
    attendance_day_cutoff: "04:00:00",
    break_minutes: breakMinutes,
    normal_work_minutes: nrm,
    ot_rate: 1,
  }));

const SHORT_SHIFT = 7; // 18:00-22:00, NRM 240
const LONG_SHIFT = 8; // 10:00-22:00 less 60, NRM 660

const shiftConfig = (id, name) => ({
  work_shift_id: id,
  shift_code: `S${id}`,
  shift_name: name,
  active: 1,
  overtime_allowed: 1,
  overtime_minimum_minutes: 0,
  overtime_rounding_method: "NONE",
  overtime_rounding_interval_minutes: 0,
  overtime_minimum_threshold_only: 0,
  overtime_minimum_excluded: 0,
  maximum_ot_minutes_per_day: null,
  pre_shift_overtime_allowed: 1,
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
});

const CONFIGS = [shiftConfig(SHORT_SHIFT, "Evening"), shiftConfig(LONG_SHIFT, "Full Day")];
const SCHEDULES = [
  ...scheduleRows(SHORT_SHIFT, "18:00:00", "22:00:00", 0, 240),
  ...scheduleRows(LONG_SHIFT, "10:00:00", "22:00:00", 60, 660),
];

const employee = (id, over = {}) => ({
  employee_id: id,
  employee_name: `Employee ${id}`,
  store_id: 1,
  designation_id: 5,
  department_id: 3,
  special_break_override_minutes: null,
  extra_break_hours: null,
  attendance_required: 1,
  outlet_name: "Main Store",
  outlet_nickname: "MAIN",
  designation_name: "Cashier",
  department_name: "Front End",
  joined_on: null,
  resignation_date: null,
  ...over,
});

/** An in and an out punch, at the given IST clock times. */
const pair = (employeeId, date, inHour, outHour) => [
  {
    punch_id: Number(`${employeeId}${date.slice(8, 10)}1`),
    employee_id: employeeId,
    io_time: ist(date, inHour, 0),
    punch_date: date,
    dev_id: "G1",
    ingest_source: "BIOMAX",
    ingest_attendance_date: date,
    attendance_punch_void_id: null,
    void_reason: null,
  },
  {
    punch_id: Number(`${employeeId}${date.slice(8, 10)}2`),
    employee_id: employeeId,
    io_time: ist(date, outHour, 0),
    punch_date: date,
    dev_id: "G1",
    ingest_source: "BIOMAX",
    ingest_attendance_date: date,
    attendance_punch_void_id: null,
    void_reason: null,
  },
];

/** The dashboard repository, faked at exactly the shapes the SQL returns. */
function fakeDashboardRepo(state = {}) {
  return {
    getShiftAssignmentHistoryForEmployees: async (ids) =>
      (state.assignments || []).filter((a) => ids.includes(Number(a.employee_id))),
    getDateShiftOverridesForEmployees: async () => state.overrides || [],
    listWorkShiftConfigs: async () => state.configs || CONFIGS,
    listWorkShiftSchedules: async () => state.schedules || SCHEDULES,
    listWorkShiftConfigVersions: async () => state.configVersions || [],
    getRawPunchesForEmployees: async (ids, from, to) =>
      (state.rawPunches || []).filter((p) => {
        const day = String(p.io_time).slice(0, 10);
        return ids.includes(Number(p.employee_id)) && day >= from && day <= to;
      }),
    getApprovedRegularizedPunchesForEmployees: async () => state.regularized || [],
    getApprovalStateForEmployees: async () => state.approvals || [],
    getStoredCalculationsForEmployees: async () => state.stored || [],
  };
}

/**
 * The report repository, faked - and it applies the SAME filters its SQL
 * applies, so a test asserting that a filter or a branch scope narrowed the
 * result is asserting something real rather than something the fake waved
 * through.
 */
function fakeReportRepo(state = {}) {
  const calls = { listCandidateEmployees: 0, listShiftChangeRequests: 0, lastFilters: null };
  return {
    calls,
    listCandidateEmployees: async (args) => {
      calls.listCandidateEmployees += 1;
      calls.lastFilters = args;
      let rows = state.employees === undefined ? [employee(42)] : state.employees;
      rows = rows.filter((r) => Number(r.attendance_required) !== 0);
      rows = rows.filter(
        (r) =>
          (r.resignation_date === null || r.resignation_date >= args.from_date) &&
          (r.joined_on === null || r.joined_on <= args.to_date)
      );
      if (args.store_ids !== null && args.store_ids !== undefined) {
        // `[]` means NO locations - the SQL answers `1 = 0`.
        rows =
          Array.isArray(args.store_ids) && args.store_ids.length
            ? rows.filter((r) => args.store_ids.map(Number).includes(Number(r.store_id)))
            : [];
      }
      if (args.designation_id) {
        rows = rows.filter((r) => Number(r.designation_id) === Number(args.designation_id));
      }
      if (args.employee_id) {
        rows = rows.filter((r) => Number(r.employee_id) === Number(args.employee_id));
      }
      return rows;
    },
    listShiftChangeRequests: async (args) => {
      calls.listShiftChangeRequests += 1;
      return (state.requests || []).filter(
        (r) =>
          args.employee_ids.includes(Number(r.employee_id)) &&
          r.attendance_date >= args.from_date &&
          r.attendance_date <= args.to_date &&
          r.status !== "CANCELLED"
      );
    },
  };
}

/** The calculation usecase, faked down to the two things the report asks of it. */
function fakeCalculation(state = {}) {
  const calls = { lockProbes: 0 };
  return {
    calls,
    listDateShiftOptions: async () =>
      (state.configs || CONFIGS)
        .filter((c) => Number(c.active) === 1)
        .map((c) => ({
          work_shift_id: c.work_shift_id,
          shift_code: c.shift_code,
          shift_name: c.shift_name,
        })),
    findPayrollLockedPeriodsBulk: async (rows) => {
      calls.lockProbes += 1;
      const locked = state.lockedMonths || [];
      const wanted = new Set();
      rows.forEach((r) => {
        const year = Number(r.attendance_date.slice(0, 4));
        const month = Number(r.attendance_date.slice(5, 7));
        locked.forEach((l) => {
          if (
            Number(l.employee_id) === Number(r.employee_id) &&
            Number(l.year) === year &&
            Number(l.month) === month
          ) {
            wanted.add(`${l.employee_id}:${l.year}:${l.month}`);
          }
        });
      });
      return [...wanted].map((k) => {
        const [employee_id, year, month] = k.split(":").map(Number);
        return { employee_id, year, month };
      });
    },
  };
}

const build = (state = {}) => {
  const reportRepo = fakeReportRepo(state);
  const calculation = fakeCalculation(state);
  const usecase = buildReport(reportRepo, buildDashboard(fakeDashboardRepo(state)), calculation, {
    now: () => istInstant(TODAY, 9, 0),
  });
  return { usecase, reportRepo, calculation };
};

const assignment = (employeeId, workShiftId, from = "2026-01-01") => ({
  employee_work_shift_assignment_id: employeeId * 100 + workShiftId,
  employee_id: employeeId,
  work_shift_id: workShiftId,
  effective_from: from,
  source: "MIGRATION_BACKFILL",
});

const oneDay = (over = {}) => ({
  from_date: YESTERDAY,
  to_date: YESTERDAY,
  store_ids: null,
  ...over,
});

const only = (rows) => {
  assert.equal(rows.length, 1, `expected exactly one row, got ${rows.length}`);
  return rows[0];
};

/* ========================================================================= */

describe("A. the rule: a shift change regularises a LONGER day, never a shorter one", () => {
  it("short assigned shift, longer actual hours -> can raise, and worked longer", async () => {
    // The brief's first example: assigned 18:00-22:00, punched 10:00-22:00.
    const { usecase } = build({
      employees: [employee(42)],
      assignments: [assignment(42, SHORT_SHIFT)],
      rawPunches: pair(42, YESTERDAY, 10, 22),
    });

    const row = only((await usecase.getReport(oneDay())).data);
    assert.equal(row.can_raise, true);
    assert.equal(row.eligibility_reason_code, "ELIGIBLE");
    assert.equal(row.worked_longer, true);
    assert.equal(row.assigned_nrm_minutes, 240);
    assert.equal(row.worked_minutes, 720);
    assert.equal(row.extra_minutes, 480);
    assert.equal(row.first_punch, "10:00");
    assert.equal(row.last_punch, "22:00");
  });

  it("long assigned shift, shorter actual hours -> NOT eligible, and the reason says why", async () => {
    // The brief's second example: assigned 10:00-22:00, punched 18:00-22:00.
    // There is no LONGER shift to move to, so production would refuse any
    // request for this date - and the report must say so rather than invent
    // one from the punches.
    const { usecase } = build({
      employees: [employee(42)],
      assignments: [assignment(42, LONG_SHIFT)],
      rawPunches: pair(42, YESTERDAY, 18, 22),
    });

    const row = only((await usecase.getReport(oneDay())).data);
    assert.equal(row.can_raise, false);
    assert.equal(row.eligibility_reason_code, "NO_LONGER_SHIFT");
    assert.match(row.eligibility_reason, /longer working hours than your normal shift/);
    assert.equal(row.worked_longer, false);
    assert.equal(row.extra_minutes, 0);
  });

  it("a long day on the longest shift may still not be raised - punches never create eligibility", async () => {
    const { usecase } = build({
      employees: [employee(42)],
      assignments: [assignment(42, LONG_SHIFT)],
      // Twelve and a half hours against an NRM of 660: genuinely longer.
      rawPunches: pair(42, YESTERDAY, 9, 22),
    });

    const row = only((await usecase.getReport(oneDay())).data);
    assert.equal(row.worked_longer, true);
    assert.equal(row.can_raise, false, "no longer shift exists, so production would refuse it");
    assert.equal(row.eligibility_reason_code, "NO_LONGER_SHIFT");
  });

  it("a date with no shift assigned at all is not raisable", async () => {
    const { usecase } = build({
      employees: [employee(42)],
      assignments: [],
      rawPunches: pair(42, YESTERDAY, 10, 22),
    });

    const row = only((await usecase.getReport(oneDay())).data);
    assert.equal(row.can_raise, false);
    assert.equal(row.eligibility_reason_code, "NO_BASE_SHIFT");
  });
});

describe("B. the request status comes from the workflow, and is never derived", () => {
  const eligibleState = (requests) => ({
    employees: [employee(42)],
    assignments: [assignment(42, SHORT_SHIFT)],
    rawPunches: pair(42, YESTERDAY, 10, 22),
    requests,
  });

  const request = (status, id = 900) => [
    {
      attendance_approval_request_id: id,
      employee_id: 42,
      attendance_date: YESTERDAY,
      status,
      current_stage_no: 1,
      total_stages: 2,
      requested_work_shift_id: LONG_SHIFT,
      base_work_shift_id: SHORT_SHIFT,
      created_at: `${YESTERDAY} 20:00:00`,
    },
  ];

  it("an eligible employee with no request reads Not Raised, with no request id", async () => {
    const { usecase } = build(eligibleState([]));
    const row = only((await usecase.getReport(oneDay())).data);
    assert.equal(row.can_raise, true);
    assert.equal(row.request_status, "Not Raised");
    assert.equal(row.request_id, null);
  });

  it("a pending request reads Pending, carries its id, and makes the date not raisable again", async () => {
    const { usecase } = build(eligibleState(request("PENDING")));
    const row = only((await usecase.getReport(oneDay())).data);
    assert.equal(row.request_status, "Pending");
    assert.equal(row.request_id, 900);
    assert.equal(row.can_raise, false);
    assert.equal(row.eligibility_reason_code, "ALREADY_PENDING");
  });

  it("an approved request reads Approved and blocks a second one", async () => {
    const { usecase } = build(eligibleState(request("APPROVED", 901)));
    const row = only((await usecase.getReport(oneDay())).data);
    assert.equal(row.request_status, "Approved");
    assert.equal(row.request_id, 901);
    assert.equal(row.can_raise, false);
    assert.equal(row.eligibility_reason_code, "ALREADY_APPROVED");
  });

  it("a REJECTED request reads Rejected and does NOT block a fresh attempt", async () => {
    const { usecase } = build(eligibleState(request("REJECTED", 902)));
    const row = only((await usecase.getReport(oneDay())).data);
    assert.equal(row.request_status, "Rejected");
    assert.equal(row.request_id, 902);
    assert.equal(row.can_raise, true, "a rejection is not a standing request");
  });

  it("one statement answers the whole population - no per-row request lookup", async () => {
    const { usecase, reportRepo } = build({
      employees: [employee(42), employee(43), employee(44)],
      assignments: [assignment(42, SHORT_SHIFT), assignment(43, SHORT_SHIFT), assignment(44, SHORT_SHIFT)],
      rawPunches: [...pair(42, YESTERDAY, 10, 22), ...pair(43, YESTERDAY, 10, 22)],
    });
    const { data } = await usecase.getReport(oneDay());
    assert.equal(data.length, 3);
    assert.equal(reportRepo.calls.listShiftChangeRequests, 1);
  });
});

describe("C. HR's default view, and the filters that open it back up", () => {
  /**
   * Four employees on one date, one per quadrant of the two questions:
   *
   *   42  can raise, worked longer, nothing raised   <- the actionable one
   *   43  can raise, did NOT work longer
   *   44  can raise, worked longer, already pending
   *   45  cannot raise (already on the longest shift)
   */
  const world = () => ({
    employees: [employee(42), employee(43), employee(44), employee(45)],
    assignments: [
      assignment(42, SHORT_SHIFT),
      assignment(43, SHORT_SHIFT),
      assignment(44, SHORT_SHIFT),
      assignment(45, LONG_SHIFT),
    ],
    rawPunches: [
      ...pair(42, YESTERDAY, 10, 22),
      ...pair(43, YESTERDAY, 18, 22),
      ...pair(44, YESTERDAY, 10, 22),
      ...pair(45, YESTERDAY, 18, 22),
    ],
    requests: [
      {
        attendance_approval_request_id: 910,
        employee_id: 44,
        attendance_date: YESTERDAY,
        status: "PENDING",
        current_stage_no: 1,
        total_stages: 2,
        requested_work_shift_id: LONG_SHIFT,
        base_work_shift_id: SHORT_SHIFT,
        created_at: `${YESTERDAY} 20:00:00`,
      },
    ],
  });

  it("the actionable cut is exactly the employee who may raise one and looks like they need to", async () => {
    const { usecase } = build(world());
    const { data, meta } = await usecase.getReport(
      oneDay({ can_raise: "YES", worked_longer: "YES", request_status: "NOT_RAISED" })
    );
    assert.deepEqual(data.map((r) => r.employee_id), [42]);
    assert.equal(meta.actionable_count, 1);
  });

  it("nothing is permanently hidden - every record is still reachable", async () => {
    const { usecase } = build(world());
    const all = await usecase.getReport(oneDay());
    assert.deepEqual(all.data.map((r) => r.employee_id), [42, 43, 44, 45]);
    // ... and the actionable count is reported even while looking at all of them.
    assert.equal(all.meta.actionable_count, 1);

    const canButNot = await usecase.getReport(oneDay({ can_raise: "YES", worked_longer: "NO" }));
    assert.deepEqual(canButNot.data.map((r) => r.employee_id), [43]);

    const cannot = await usecase.getReport(oneDay({ can_raise: "NO" }));
    assert.deepEqual(cannot.data.map((r) => r.employee_id), [44, 45]);

    const pending = await usecase.getReport(oneDay({ request_status: "PENDING" }));
    assert.deepEqual(pending.data.map((r) => r.employee_id), [44]);
  });

  it("an unknown filter value is refused rather than quietly ignored", async () => {
    const { usecase } = build(world());
    await assert.rejects(() => usecase.getReport(oneDay({ request_status: "MAYBE" })), /request_status/);
  });
});

describe("D. branch scope, which the server decides and a filter can only narrow", () => {
  const twoOutlets = () => ({
    employees: [employee(42, { store_id: 1 }), employee(55, { store_id: 2, employee_name: "Other Branch" })],
    assignments: [assignment(42, SHORT_SHIFT), assignment(55, SHORT_SHIFT)],
    rawPunches: [...pair(42, YESTERDAY, 10, 22), ...pair(55, YESTERDAY, 10, 22)],
  });

  it("a branch user cannot see another outlet's employees", async () => {
    const { usecase } = build(twoOutlets());
    // `store_ids` arrives ALREADY narrowed by the route to what the server
    // decided this caller may see. Outlet 2 is not in it.
    const { data } = await usecase.getReport(oneDay({ store_ids: [1] }));
    assert.deepEqual(data.map((r) => r.employee_id), [42]);
  });

  it("an empty authorized set serves nobody, rather than everybody", async () => {
    const { usecase } = build(twoOutlets());
    const { data } = await usecase.getReport(oneDay({ store_ids: [] }));
    assert.deepEqual(data, []);
  });

  it("a company-wide caller sees every permitted outlet", async () => {
    const { usecase } = build(twoOutlets());
    const { data } = await usecase.getReport(oneDay({ store_ids: null }));
    assert.deepEqual(data.map((r) => r.employee_id), [42, 55]);
  });

  it("the designation filter reaches the SQL rather than being applied after the fact", async () => {
    const { usecase, reportRepo } = build({
      employees: [employee(42, { designation_id: 5 }), employee(43, { designation_id: 9 })],
      assignments: [assignment(42, SHORT_SHIFT), assignment(43, SHORT_SHIFT)],
      rawPunches: [...pair(42, YESTERDAY, 10, 22), ...pair(43, YESTERDAY, 10, 22)],
    });
    const { data } = await usecase.getReport(oneDay({ designation_id: 9 }));
    assert.deepEqual(data.map((r) => r.employee_id), [43]);
    assert.equal(reportRepo.calls.lastFilters.designation_id, 9);
  });
});

describe("E. a closed payroll month stays closed, and reads as not raisable", () => {
  it("a locked month is reported, with the lock as the reason, and nothing is written", async () => {
    const locked_date = "2026-08-20";
    const { usecase } = build({
      employees: [employee(42)],
      assignments: [assignment(42, SHORT_SHIFT)],
      rawPunches: pair(42, locked_date, 10, 22),
      lockedMonths: [{ employee_id: 42, year: 2026, month: 8 }],
    });

    const { data } = await usecase.getReport({
      from_date: locked_date,
      to_date: locked_date,
      store_ids: null,
    });
    const row = only(data);
    assert.equal(row.can_raise, false);
    assert.equal(row.eligibility_reason_code, "PAYROLL_LOCKED");
    assert.match(row.eligibility_reason, /08\/2026 is approved and locked/);
    // The day is still described honestly - the report reads the closed month,
    // it does not refuse to show it.
    assert.equal(row.worked_longer, true);
  });

  it("the payroll lock is asked once for the whole report, not once per row", async () => {
    const { usecase, calculation } = build({
      employees: [employee(42), employee(43)],
      assignments: [assignment(42, SHORT_SHIFT), assignment(43, SHORT_SHIFT)],
      rawPunches: [...pair(42, YESTERDAY, 10, 22), ...pair(43, YESTERDAY, 10, 22)],
    });
    await usecase.getReport(oneDay());
    assert.equal(calculation.calls.lockProbes, 1);
  });

  it("the repositories this report uses expose no write method at all", () => {
    const repo = require("../repository/attendance_shift_change_report").AttendanceShiftChangeReportRepository;
    const methods = Object.getOwnPropertyNames(repo.prototype);
    const writes = methods.filter((m) => /create|insert|update|delete|save|claim|settle|close/i.test(m));
    assert.deepEqual(writes, [], `unexpected write methods: ${writes.join(", ")}`);
  });
});

describe("F. the shape of the result", () => {
  it("one row per employee per date - a join can never duplicate one", async () => {
    // Two dates, two employees, and an employee carrying TWO assignment rows
    // and a REJECTED request beside a later one: every shape that would
    // duplicate a row if these were joined in SQL instead of indexed in memory.
    const { usecase } = build({
      employees: [employee(42), employee(43)],
      assignments: [
        assignment(42, SHORT_SHIFT, "2026-01-01"),
        assignment(42, SHORT_SHIFT, "2026-06-01"),
        assignment(43, SHORT_SHIFT),
      ],
      rawPunches: [
        ...pair(42, "2026-09-17", 10, 22),
        ...pair(42, YESTERDAY, 10, 22),
        ...pair(43, "2026-09-17", 10, 22),
        ...pair(43, YESTERDAY, 10, 22),
      ],
      requests: [
        {
          attendance_approval_request_id: 920,
          employee_id: 42,
          attendance_date: YESTERDAY,
          status: "REJECTED",
          current_stage_no: 1,
          total_stages: 1,
          requested_work_shift_id: LONG_SHIFT,
          base_work_shift_id: SHORT_SHIFT,
          created_at: `${YESTERDAY} 19:00:00`,
        },
        {
          attendance_approval_request_id: 921,
          employee_id: 42,
          attendance_date: YESTERDAY,
          status: "PENDING",
          current_stage_no: 1,
          total_stages: 1,
          requested_work_shift_id: LONG_SHIFT,
          base_work_shift_id: SHORT_SHIFT,
          created_at: `${YESTERDAY} 20:00:00`,
        },
      ],
    });

    const { data, meta } = await usecase.getReport({
      from_date: "2026-09-17",
      to_date: YESTERDAY,
      store_ids: null,
    });

    const keys = data.map((r) => `${r.employee_id}:${r.attendance_date}`);
    assert.equal(keys.length, 4);
    assert.equal(new Set(keys).size, 4, "a duplicated employee/date row");
    assert.equal(meta.row_count, 4);
    assert.equal(meta.employee_count, 2);

    // The LATER request is the current one; the rejected attempt does not win.
    const contested = data.find((r) => r.employee_id === 42 && r.attendance_date === YESTERDAY);
    assert.equal(contested.request_id, 921);
    assert.equal(contested.request_status, "Pending");
  });

  it("a leaver is off the dates after they left, and a joiner off the ones before they came", async () => {
    const { usecase } = build({
      employees: [
        employee(42, { resignation_date: "2026-09-17" }),
        employee(43, { joined_on: YESTERDAY }),
      ],
      assignments: [assignment(42, SHORT_SHIFT), assignment(43, SHORT_SHIFT)],
      rawPunches: [],
    });
    const { data } = await usecase.getReport({
      from_date: "2026-09-16",
      to_date: YESTERDAY,
      store_ids: null,
    });
    const keys = data.map((r) => `${r.employee_id}:${r.attendance_date}`).sort();
    assert.deepEqual(keys, ["42:2026-09-16", "42:2026-09-17", "43:2026-09-18"]);
  });

  it("refuses a range wider than the limit rather than scanning the year", async () => {
    const { usecase } = build({});
    await assert.rejects(
      () => usecase.getReport({ from_date: "2026-01-01", to_date: "2026-12-31", store_ids: null }),
      /at most 92 days/
    );
  });
});

/* ========================================================================= */

describe("G. THE PARITY TEST: the report's verdict IS the production rule's", () => {
  /**
   * The one that matters.
   *
   * It builds the REAL `raiseShiftChangeRequest` over the same fixtures and,
   * for each case, asks both: would production accept a request for this
   * date, and what does the report's "Can Raise Shift Change?" column say.
   * They must agree, and when both say no they must say it in the same words.
   *
   * IT FAILS IF ANYBODY EVER GIVES THE REPORT A RULE OF ITS OWN - which is
   * exactly the failure this report was asked not to have.
   */
  const productionFor = (state) => {
    const dashboard = buildDashboard(fakeDashboardRepo(state));
    const calculation = fakeCalculation(state);

    // The calculation usecase as `raiseShiftChangeRequest` consumes it:
    // `shiftForDate` over the same shift cache and the same assignments the
    // report's days were built from, so the two see one roster.
    const shiftForDate = async ({ employee_id, attendance_date, work_shift_id = null }) => {
      const batch = await dashboard.loadBatch({
        employees: [{ employee_id }],
        from: attendance_date,
        to: attendance_date,
      });
      const key = String(employee_id);
      const withOverride = work_shift_id
        ? [
            {
              attendance_date_shift_override_id: -1,
              employee_id,
              work_shift_id,
              attendance_date,
              shift_change_approved: 0,
              attendance_approval_request_id: null,
            },
          ]
        : [];
      const resolver = dashboard.employeeResolver({
        shiftCache: batch.shiftCache,
        assignments: batch.assignmentsByEmployee.get(key) || [],
        overrides: withOverride,
      });
      const resolution = resolver.resolutionFor(attendance_date);
      const base = resolver.baseResolutionFor(attendance_date);
      const nrm = (snapshot) =>
        snapshot ? Math.max(0, (snapshot.shift_span_minutes || 0) - (snapshot.break_minutes || 0)) : null;
      return {
        employee_id,
        attendance_date,
        status: resolution.status,
        work_shift_id: resolution.work_shift_id,
        shift_code: resolution.snapshot ? resolution.snapshot.shift_code : null,
        shift_name: resolution.work_shift_id ? resolver.shiftNameFor(resolution.work_shift_id) : null,
        in_time: resolution.snapshot ? resolution.snapshot.in_time : null,
        out_time: resolution.snapshot ? resolution.snapshot.out_time : null,
        is_working_day: resolution.snapshot ? resolution.snapshot.is_working_day : null,
        nrm_minutes: nrm(resolution.snapshot),
        base: {
          status: base.status,
          work_shift_id: base.work_shift_id,
          shift_code: base.snapshot ? base.snapshot.shift_code : null,
          shift_name: base.work_shift_id ? resolver.shiftNameFor(base.work_shift_id) : null,
          in_time: base.snapshot ? base.snapshot.in_time : null,
          out_time: base.snapshot ? base.snapshot.out_time : null,
          is_working_day: base.snapshot ? base.snapshot.is_working_day : null,
          nrm_minutes: nrm(base.snapshot),
        },
      };
    };

    // POSITIONAL, exactly as `server.js` constructs it: the request store,
    // the calculation usecase, and the employee-level approver setup.
    return buildRegularization(
      {
        getApprovalIdentity: async (id) => {
          const found = (state.employees || []).find((e) => Number(e.employee_id) === Number(id));
          if (!found) return null;
          return {
            employee_id: found.employee_id,
            employee_name: found.employee_name,
            outlet_id: found.store_id,
            outlet_name: found.outlet_name,
            designation_id: found.designation_id,
            designation_name: found.designation_name,
            approver_role: null,
          };
        },
        findRequestsForDates: async (employeeId, dates) =>
          (state.requests || [])
            .filter(
              (r) => Number(r.employee_id) === Number(employeeId) && dates.includes(r.attendance_date)
            )
            .map((r) => ({ ...r, request_type: "SHIFT_CHANGE" })),
        createRequest: async () => ({ attendance_approval_request_id: 1, chain: [] }),
      },
      {
        shiftForDate,
        listDateShiftOptions: async () => [],
        findPayrollLockedPeriods: async (rows) => calculation.findPayrollLockedPeriodsBulk(rows),
      },
      {
        getActiveSetup: async (employeeId) => ({
          employee_id: employeeId,
          first_level_approver_employee_id: 7,
          second_level_approver_employee_id: null,
          final_approver_employee_id: 8,
        }),
      }
    );
  };

  /**
   * Would production accept a request for this date? Asked by actually
   * calling it and reading whether it threw - not by re-reading its source.
   */
  const productionWouldAccept = async (state, { employee_id, attendance_date }) => {
    const usecase = productionFor(state);
    const refusals = [];
    // EVERY SHIFT IS OFFERED, one at a time, because that is the question the
    // report asks: is there ANY shift this person could ask for on this date.
    // "That is already your shift" is not a refusal of the DATE - it is a
    // refusal of that one choice - so it is not collected as one.
    for (const work_shift_id of [SHORT_SHIFT, LONG_SHIFT]) {
      try {
        /* eslint-disable no-await-in-loop */
        await usecase.raiseShiftChangeRequest({
          actor: { employee_id },
          attendance_date,
          work_shift_id,
          reason: "covering the evening delivery",
          today: TODAY,
        });
        /* eslint-enable no-await-in-loop */
        return { accepted: true, message: null };
      } catch (err) {
        if (!/is already your shift for/.test(err.message)) refusals.push(err.message);
      }
    }
    return { accepted: false, message: refusals[0] || null };
  };

  const CASES = [
    {
      name: "a short shift with a longer one available",
      state: () => ({
        employees: [employee(42)],
        assignments: [assignment(42, SHORT_SHIFT)],
        rawPunches: pair(42, YESTERDAY, 10, 22),
      }),
      date: YESTERDAY,
    },
    {
      name: "already on the longest shift",
      state: () => ({
        employees: [employee(42)],
        assignments: [assignment(42, LONG_SHIFT)],
        rawPunches: pair(42, YESTERDAY, 9, 22),
      }),
      date: YESTERDAY,
    },
    {
      name: "a date beyond the backdating window",
      state: () => ({
        employees: [employee(42)],
        assignments: [assignment(42, SHORT_SHIFT)],
        rawPunches: [],
      }),
      date: "2026-06-01",
    },
    {
      name: "a month payroll has closed",
      state: () => ({
        employees: [employee(42)],
        assignments: [assignment(42, SHORT_SHIFT)],
        rawPunches: [],
        lockedMonths: [{ employee_id: 42, year: 2026, month: 8 }],
      }),
      date: "2026-08-20",
    },
    {
      name: "a date with a request already pending",
      state: () => ({
        employees: [employee(42)],
        assignments: [assignment(42, SHORT_SHIFT)],
        rawPunches: pair(42, YESTERDAY, 10, 22),
        requests: [
          {
            attendance_approval_request_id: 930,
            employee_id: 42,
            attendance_date: YESTERDAY,
            status: "PENDING",
            current_stage_no: 1,
            total_stages: 1,
            requested_work_shift_id: LONG_SHIFT,
            base_work_shift_id: SHORT_SHIFT,
            created_at: `${YESTERDAY} 20:00:00`,
          },
        ],
      }),
      date: YESTERDAY,
    },
  ];

  CASES.forEach((testCase) => {
    it(`agrees with production: ${testCase.name}`, async () => {
      const state = testCase.state();

      const { usecase } = build(state);
      const { data } = await usecase.getReport({
        from_date: testCase.date,
        to_date: testCase.date,
        store_ids: null,
      });
      const row = only(data);

      const production = await productionWouldAccept(state, {
        employee_id: 42,
        attendance_date: testCase.date,
      });

      assert.equal(
        row.can_raise,
        production.accepted,
        `report says ${row.can_raise} ("${row.eligibility_reason}"), production says ${production.accepted} ("${production.message}")`
      );
      if (!production.accepted) {
        assert.equal(
          row.eligibility_reason,
          production.message,
          "the report must refuse in production's own words"
        );
      }
    });
  });
});
