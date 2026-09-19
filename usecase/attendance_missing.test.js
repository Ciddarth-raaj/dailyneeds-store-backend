/**
 * THE MISSING ATTENDANCE POPULATION, end to end.
 *
 *   node --test usecase/attendance_missing.test.js
 *
 * No MySQL. The fake repository returns exactly the shapes the real
 * statements return - dates as `YYYY-MM-DD`, times as `YYYY-MM-DD HH:MM:SS`,
 * which is what DATE_FORMAT produces.
 *
 * THE DASHBOARD USECASE IS REAL, NOT FAKED. That is the point of the test:
 * the punch count these assertions turn on is the one
 * `computeDaysForEmployee` produces from re-dated, de-duplicated, un-voided
 * effective punches against the shift version dated to that day - the same
 * number every attendance screen shows. A fake day object would assert the
 * report's arithmetic and nothing about whether it counts the right punches.
 *
 * `today` is pinned in every test. A report whose contents depend on the hour
 * the suite happens to run is a report nobody can test.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildDashboard = require("../usecase/attendance_dashboard");
const buildMissing = require("../usecase/attendance_missing");

const TODAY = "2026-09-19";
const YESTERDAY = "2026-09-18";

/** An instant on an IST business date, as the epoch the punch rows carry. */
const istInstant = (date, hh, mm) =>
  Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), hh, mm) -
  (5 * 60 + 30) * 60 * 1000;

/** `YYYY-MM-DD HH:MM:SS` in IST, which is what DATE_FORMAT hands back. */
const ist = (date, hh, mm) =>
  `${date} ${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00`;

const scheduleRows = (workShiftId) =>
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
  }));

const shiftConfig = (id) => ({
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
});

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

/**
 * `n` punches for an employee on a date, spaced 30 minutes apart from 10:00.
 *
 * WELL CLEAR OF THE TEN-MINUTE DUPLICATE WINDOW, so `n` punches in means `n`
 * punches counted - otherwise the fixture, and not the rule, would decide
 * whether a day was odd.
 */
const punches = (employeeId, date, n, startHour = 10) =>
  Array.from({ length: n }, (_, i) => {
    const minutes = i * 30;
    const hh = startHour + Math.floor(minutes / 60);
    const mm = minutes % 60;
    return {
      punch_id: Number(`${employeeId}${date.slice(8, 10)}${i}`),
      employee_id: employeeId,
      io_time: ist(date, hh, mm),
      punch_date: date,
      dev_id: "G1",
      ingest_source: "BIOMAX",
      ingest_attendance_date: date,
      attendance_punch_void_id: null,
      void_reason: null,
    };
  });

/** The dashboard repository, faked at exactly the shapes the SQL returns. */
function fakeDashboardRepo(state = {}) {
  return {
    getShiftAssignmentHistoryForEmployees: async (ids) =>
      (state.assignments ||
        ids.map((id, i) => ({
          employee_work_shift_assignment_id: i + 1,
          employee_id: id,
          work_shift_id: 7,
          effective_from: "2026-01-01",
          source: "MIGRATION_BACKFILL",
        }))
      ).filter((a) => ids.includes(Number(a.employee_id))),
    getDateShiftOverridesForEmployees: async () => state.overrides || [],
    listWorkShiftConfigs: async () => state.configs || [shiftConfig(7), shiftConfig(8)],
    listWorkShiftSchedules: async () => state.schedules || [...scheduleRows(7), ...scheduleRows(8)],
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
 * The Missing Attendance repository, faked - and it applies the SAME filters
 * its SQL applies, so a test asserting that a filter narrowed the result is
 * asserting something real rather than something the fake waved through.
 */
function fakeMissingRepo(state = {}) {
  const calls = { listCandidateEmployees: 0, lastFilters: null };
  return {
    calls,
    listCandidateEmployees: async (args) => {
      calls.listCandidateEmployees += 1;
      calls.lastFilters = args;
      let rows = state.employees === undefined ? [employee(42)] : state.employees;
      // `attendance_required` is filtered in the SQL as well as in the rule.
      rows = rows.filter((r) => Number(r.attendance_required) !== 0);
      // Employment overlapping the window, exactly as the WHERE clause says.
      rows = rows.filter(
        (r) =>
          (r.resignation_date === null || r.resignation_date >= args.from_date) &&
          (r.joined_on === null || r.joined_on <= args.to_date)
      );
      if (args.store_ids !== null && args.store_ids !== undefined) {
        // `[]` means NO locations - the SQL answers `1 = 0`.
        rows = Array.isArray(args.store_ids) && args.store_ids.length
          ? rows.filter((r) => args.store_ids.map(Number).includes(Number(r.store_id)))
          : [];
      }
      if (args.department_id) {
        rows = rows.filter((r) => Number(r.department_id) === Number(args.department_id));
      }
      if (args.employee_id) {
        rows = rows.filter((r) => Number(r.employee_id) === Number(args.employee_id));
      }
      return rows;
    },
    getActiveTelegramChats: async () => state.chats || [],
    listNotificationsForDate: async () => state.notifications || [],
    claim: async () => ({ claimed: true }),
    settle: async () => ({}),
    releaseClaim: async () => ({}),
  };
}

const build = (state = {}) => {
  const missingRepo = fakeMissingRepo(state);
  const usecase = buildMissing(missingRepo, buildDashboard(fakeDashboardRepo(state)), {
    now: () => istInstant(TODAY, 9, 0),
  });
  return { usecase, missingRepo };
};

const report = (state, query = {}) =>
  build(state).usecase.getReport(
    { from_date: "2026-09-01", to_date: TODAY, ...query },
    { today: TODAY }
  );

describe("the punch-count rule, over real computed days", () => {
  const counts = [0, 1, 2, 3, 4, 5, 6, 7];

  counts.forEach((count) => {
    const included = count > 0 && count % 2 === 1;
    it(`${count} punch(es) on a completed date is ${included ? "INCLUDED" : "EXCLUDED"}`, async () => {
      const { data } = await report({
        employees: [employee(42)],
        rawPunches: punches(42, YESTERDAY, count),
      });
      assert.equal(data.length, included ? 1 : 0, `${count} punches`);
      if (included) {
        assert.equal(data[0].punch_count, count);
        assert.equal(data[0].attendance_date, YESTERDAY);
        assert.equal(data[0].status, "Missing Attendance");
      }
    });
  });

  it("reports the punch times and the dated shift on the row", async () => {
    const { data } = await report({
      employees: [employee(42)],
      rawPunches: punches(42, YESTERDAY, 3),
    });
    assert.deepEqual(data[0].punch_times, ["10:00", "10:30", "11:00"]);
    assert.equal(data[0].shift_name, "Shift 7");
    assert.equal(data[0].work_shift_id, 7);
    assert.equal(data[0].employee_name, "Employee 42");
    assert.equal(data[0].outlet_name, "MAIN");
    assert.equal(data[0].department_name, "Front End");
    assert.equal(data[0].designation_name, "Cashier");
  });
});

describe("the date rules", () => {
  it("NEVER includes the current attendance date, even with an odd count", async () => {
    const { meta, data } = await report({
      employees: [employee(42)],
      rawPunches: [...punches(42, TODAY, 1), ...punches(42, YESTERDAY, 3)],
    });
    assert.deepEqual(data.map((r) => r.attendance_date), [YESTERDAY]);
    assert.equal(meta.latest_reportable_date, YESTERDAY);
    assert.equal(meta.effective_to_date, YESTERDAY);
    assert.equal(meta.clamped_to_completed_dates, true);
  });

  it("includes yesterday with an odd count", async () => {
    const { data } = await report({
      employees: [employee(42)],
      rawPunches: punches(42, YESTERDAY, 1),
    });
    assert.equal(data.length, 1);
    assert.equal(data[0].attendance_date, YESTERDAY);
  });

  it("excludes a future date outright", async () => {
    const { meta, data } = await report(
      { employees: [employee(42)], rawPunches: punches(42, "2026-09-25", 3) },
      { from_date: "2026-09-20", to_date: "2026-09-30" }
    );
    assert.equal(data.length, 0);
    assert.equal(meta.effective_from_date, null);
    assert.equal(meta.clamped_to_completed_dates, true);
  });
});

describe("employee eligibility, per date", () => {
  it("excludes dates before the date of joining", async () => {
    const { data } = await report({
      employees: [employee(42, { joined_on: YESTERDAY })],
      rawPunches: [...punches(42, "2026-09-16", 3), ...punches(42, YESTERDAY, 3)],
    });
    assert.deepEqual(data.map((r) => r.attendance_date), [YESTERDAY]);
  });

  it("excludes dates after the resignation/relieving date", async () => {
    const { data } = await report({
      employees: [employee(42, { resignation_date: "2026-09-16" })],
      rawPunches: [...punches(42, "2026-09-16", 3), ...punches(42, YESTERDAY, 3)],
    });
    assert.deepEqual(data.map((r) => r.attendance_date), ["2026-09-16"]);
  });

  it("excludes an attendance-exempt employee entirely", async () => {
    const { data } = await report({
      employees: [employee(42, { attendance_required: 0 })],
      rawPunches: punches(42, YESTERDAY, 3),
    });
    assert.equal(data.length, 0);
  });

  it("does not treat an old leaver as currently working, whatever `status` says", async () => {
    const { data } = await report({
      employees: [employee(42, { status: 1, resignation_date: "2020-01-01" })],
      rawPunches: punches(42, YESTERDAY, 3),
    });
    assert.equal(data.length, 0);
  });
});

describe("the dated shift assignment", () => {
  it("resolves the shift DATED to each attendance date, not the current one", async () => {
    const { data } = await report({
      employees: [employee(42)],
      assignments: [
        { employee_work_shift_assignment_id: 1, employee_id: 42, work_shift_id: 7, effective_from: "2026-01-01", source: "MIGRATION_BACKFILL" },
        { employee_work_shift_assignment_id: 2, employee_id: 42, work_shift_id: 8, effective_from: "2026-09-17", source: "HR" },
      ],
      rawPunches: [...punches(42, "2026-09-16", 3), ...punches(42, YESTERDAY, 3)],
    });
    assert.deepEqual(
      data.map((r) => [r.attendance_date, r.work_shift_id]),
      [["2026-09-16", 7], [YESTERDAY, 8]]
    );
  });

  it("the shift filter selects on the DATED shift, so the older date drops out", async () => {
    const { data } = await report(
      {
        employees: [employee(42)],
        assignments: [
          { employee_work_shift_assignment_id: 1, employee_id: 42, work_shift_id: 7, effective_from: "2026-01-01", source: "MIGRATION_BACKFILL" },
          { employee_work_shift_assignment_id: 2, employee_id: 42, work_shift_id: 8, effective_from: "2026-09-17", source: "HR" },
        ],
        rawPunches: [...punches(42, "2026-09-16", 3), ...punches(42, YESTERDAY, 3)],
      },
      { work_shift_id: 8 }
    );
    assert.deepEqual(data.map((r) => [r.attendance_date, r.work_shift_id]), [[YESTERDAY, 8]]);
  });
});

describe("filters and permission scope", () => {
  const population = [
    employee(42, { store_id: 1, department_id: 3 }),
    employee(43, { store_id: 2, department_id: 3, outlet_nickname: "BRANCH" }),
    employee(44, { store_id: 1, department_id: 9, department_name: "Back End" }),
  ];
  const allPunches = [
    ...punches(42, YESTERDAY, 3),
    ...punches(43, YESTERDAY, 1),
    ...punches(44, YESTERDAY, 5),
  ];

  it("a branch-scoped caller sees their own branch only", async () => {
    const { data } = await report(
      { employees: population, rawPunches: allPunches },
      { store_ids: [2] }
    );
    assert.deepEqual(data.map((r) => r.employee_id), [43]);
  });

  it("an EMPTY authorized scope returns nothing - it never degrades to everything", async () => {
    const { data } = await report({ employees: population, rawPunches: allPunches }, { store_ids: [] });
    assert.equal(data.length, 0);
  });

  it("a null scope is company-wide, which is the route's decision and not this file's", async () => {
    const { data } = await report({ employees: population, rawPunches: allPunches }, { store_ids: null });
    assert.deepEqual(data.map((r) => r.employee_id), [42, 43, 44]);
  });

  it("filters by department and by employee", async () => {
    const byDepartment = await report(
      { employees: population, rawPunches: allPunches },
      { department_id: 9 }
    );
    assert.deepEqual(byDepartment.data.map((r) => r.employee_id), [44]);

    const byEmployee = await report(
      { employees: population, rawPunches: allPunches },
      { employee_id: 43 }
    );
    assert.deepEqual(byEmployee.data.map((r) => r.employee_id), [43]);
  });

  it("refuses a range wider than the limit rather than silently truncating it", async () => {
    await assert.rejects(
      () => report({ employees: [employee(42)] }, { from_date: "2026-01-01", to_date: TODAY }),
      /at most 92 days/
    );
  });
});

describe("the Telegram candidates are the report's own population", () => {
  it("returns exactly what the report shows for yesterday - the same rule, one builder", async () => {
    const state = {
      employees: [
        employee(42),
        employee(43),
        employee(44, { attendance_required: 0 }),
        employee(45, { resignation_date: "2020-01-01" }),
      ],
      rawPunches: [
        ...punches(42, YESTERDAY, 3),
        ...punches(43, YESTERDAY, 2),
        ...punches(44, YESTERDAY, 1),
        ...punches(45, YESTERDAY, 1),
        // Today's odd day must reach neither the report nor the alert.
        ...punches(43, TODAY, 1),
      ],
    };

    const { usecase } = build(state);
    const reported = await usecase.getReport(
      { from_date: YESTERDAY, to_date: YESTERDAY },
      { today: TODAY }
    );
    const candidates = await usecase.getTelegramCandidates({ today: TODAY });

    const key = (r) => `${r.employee_id}:${r.attendance_date}:${r.punch_count}`;
    assert.deepEqual(candidates.data.map(key), reported.data.map(key));
    assert.deepEqual(candidates.data.map(key), ["42:2026-09-18:3"]);
  });

  it("asks only for yesterday, whatever else has happened since", async () => {
    const { usecase } = build({
      employees: [employee(42)],
      rawPunches: [...punches(42, "2026-09-16", 3), ...punches(42, YESTERDAY, 5)],
    });
    const candidates = await usecase.getTelegramCandidates({ today: TODAY });
    assert.deepEqual(
      candidates.data.map((r) => [r.attendance_date, r.punch_count]),
      [[YESTERDAY, 5]]
    );
  });
});
