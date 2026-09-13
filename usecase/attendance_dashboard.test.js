/**
 * The Attendance Dashboard orchestration, against a fake repository.
 *
 *   node --test usecase/attendance_dashboard.test.js
 *
 * No MySQL. The fake returns exactly the shapes the real statements return -
 * dates as `YYYY-MM-DD` and times as `YYYY-MM-DD HH:MM:SS`, which is what
 * DATE_FORMAT produces - so what is exercised here is the wiring and the
 * counting: that duplicate and voided punches cannot inflate a headcount,
 * that an open day withholds the verdicts it has not earned, that the slices
 * reconcile to the population, and that a drilldown lists exactly what its
 * card counted.
 *
 * `now` is pinned in every test. A dashboard whose answers depend on the hour
 * the suite happens to run is a dashboard nobody can test.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildUsecase = require("../usecase/attendance_dashboard");

const DATE = "2026-09-12"; // a Saturday
const ist = (date, hh, mm) =>
  Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), hh, mm) -
  (5 * 60 + 30) * 60 * 1000;

/** A seven-day 10:00-22:00 schedule with a 04:00 attendance-day cutoff. */
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

const employee = (id, over = {}) => ({
  employee_id: id,
  employee_name: `Employee ${id}`,
  store_id: 1,
  designation_id: 5,
  special_break_override_minutes: null,
  outlet_name: "Main Store",
  outlet_nickname: "MAIN",
  designation_name: "Cashier",
  // The two dated facts the range query returns, so per-date applicability can
  // be decided. Null = unbounded, which is what most production rows look like.
  joined_on: null,
  resignation_date: null,
  ...over,
});

/**
 * Terminals whose last contact is long after any close, at every outlet these
 * tests use - so coverage is COMPLETE unless a test says otherwise.
 */
const DEFAULT_DEVICE_COVERAGE = [1, 2, 9].map((outlet_id) => ({
  outlet_id,
  biomax_device_id: outlet_id,
  dev_id: `DEV${outlet_id}`,
  label: `Fixture G${outlet_id}`,
  last_seen_at: "2026-09-20 10:00:00",
  last_punch_at: "2026-09-12 22:00:00",
}));

const DEFAULT_DEVICE_COVERAGE_RANGE = DEFAULT_DEVICE_COVERAGE.map((d) => ({
  ...d,
  effective_from: "2020-01-01 00:00:00",
  effective_to: null,
}));

function fakeRepo(state = {}) {
  const calls = { listApplicableEmployees: 0, rawPunches: 0 };
  return {
    calls,
    listApplicableEmployees: async (args) => {
      calls.listApplicableEmployees += 1;
      calls.lastFilters = args;
      let rows = state.employees === undefined ? [employee(42)] : state.employees;
      // The fake applies the same filters the SQL does, so a test that
      // asserts a filter narrowed the result is asserting something real.
      if (args.store_ids && args.store_ids.length) {
        rows = rows.filter((r) => args.store_ids.map(Number).includes(Number(r.store_id)));
      }
      if (args.designation_id) {
        rows = rows.filter((r) => Number(r.designation_id) === Number(args.designation_id));
      }
      if (args.search) {
        const q = String(args.search).toLowerCase();
        rows = rows.filter(
          (r) =>
            String(r.employee_name).toLowerCase().includes(q) ||
            String(r.employee_id).includes(q)
        );
      }
      return rows;
    },
    getShiftAssignmentHistoryForEmployees: async (ids) =>
      (state.assignments ||
        ids.map((id, i) => ({
          employee_work_shift_assignment_id: i + 1,
          employee_id: id,
          work_shift_id: 7,
          effective_from: "2026-09-01",
          source: "MIGRATION_BACKFILL",
        }))
      ).filter((a) => ids.includes(Number(a.employee_id))),
    getDateShiftOverridesForEmployees: async () => state.overrides || [],
    listWorkShiftConfigs: async () => state.configs || [shiftConfig(7)],
    listWorkShiftSchedules: async () => state.schedules || scheduleRows(7),
    listWorkShiftConfigVersions: async () => state.configVersions || [],
    getRawPunchesForEmployees: async (ids, from, to) => {
      calls.rawPunches += 1;
      return (state.rawPunches || []).filter((p) => {
        const day = String(p.io_time).slice(0, 10);
        return ids.includes(Number(p.employee_id)) && day >= from && day <= to;
      });
    },
    getApprovedRegularizedPunchesForEmployees: async () => state.regularized || [],
    getApprovalStateForEmployees: async () => state.approvals || [],
    listRecentPunches: async () => state.recentPunches || [],
    listDeviceSyncHealth: async () => state.devices || [],
    listPunchesByIds: async (ids) => {
      calls.punchesByIds = ids;
      if (state.punchesByIdsThrows) throw new Error("punch read failed");
      return (state.rawPunches || [])
        .filter((p) => ids.includes(p.punch_id))
        .map((p) => ({
          punch_id: p.punch_id,
          employee_id: p.employee_id,
          employee_name: `Employee ${p.employee_id}`,
          io_time: p.io_time,
          received_at: p.io_time,
          ingest_attendance_date: p.punch_date,
          derivation_status: "OK",
          dev_id: p.dev_id,
          ingest_source: p.ingest_source,
          device_label: "Fixture G1",
          punch_outlet_id: 1,
          punch_outlet_name: "Main Store",
          attendance_punch_void_id: p.attendance_punch_void_id,
        }));
    },
    /**
     * DELIVERY EVIDENCE. The default is a terminal at outlet 1 (and 2, and 9)
     * last seen well after any close, i.e. COMPLETE - because most tests are
     * about something else and a feed nobody has vouched for would withhold
     * every absence and drown the assertion under test.
     */
    listDeviceCoverageForDate: async (args) => {
      calls.coverageForDate = args;
      if (state.coverageThrows) throw new Error("device read failed");
      return state.deviceCoverage === undefined ? DEFAULT_DEVICE_COVERAGE : state.deviceCoverage;
    },
    listOpenHistoricalPullsForDate: async () => state.openPulls || [],
    listDeviceCoverageForRange: async (args) => {
      calls.coverageForRange = args;
      if (state.coverageThrows) throw new Error("device read failed");
      return state.deviceCoverageRange === undefined
        ? DEFAULT_DEVICE_COVERAGE_RANGE
        : state.deviceCoverageRange;
    },
    listOpenHistoricalPullsForRange: async () => state.openPulls || [],
    listApplicableEmployeesForRange: async (args) => {
      calls.rangePopulation = args;
      let rows = state.rangeEmployees === undefined
        ? (state.employees === undefined ? [employee(42)] : state.employees)
        : state.rangeEmployees;
      if (args.store_ids && args.store_ids.length) {
        rows = rows.filter((r) => args.store_ids.map(Number).includes(Number(r.store_id)));
      } else if (Array.isArray(args.store_ids)) {
        rows = [];
      }
      if (args.designation_id) {
        rows = rows.filter((r) => Number(r.designation_id) === Number(args.designation_id));
      }
      if (args.search) {
        const q = String(args.search).toLowerCase();
        rows = rows.filter(
          (r) =>
            String(r.employee_name).toLowerCase().includes(q) || String(r.employee_id).includes(q)
        );
      }
      return rows;
    },
    listOutlets: async (args) => {
      calls.outletArgs = args;
      const all = state.outlets || [{ outlet_id: 1, outlet_name: "Main Store", outlet_nickname: "MAIN" }];
      const ids = args && args.store_ids;
      if (ids === null || ids === undefined) return all;
      return all.filter((o) => ids.map(Number).includes(Number(o.outlet_id)));
    },
    listDesignations: async () => state.designations || [{ designation_id: 5, designation_name: "Cashier" }],
    listActiveWorkShifts: async () =>
      state.activeShifts || [{ work_shift_id: 7, shift_code: "10-10", shift_name: "Shift 7" }],
  };
}

const punch = (employee_id, io_time, over = {}) => ({
  punch_id: over.punch_id || Number(`${employee_id}${String(io_time).replace(/\D/g, "").slice(-6)}`),
  employee_id,
  punch_date: String(io_time).slice(0, 10),
  ingest_attendance_date: String(io_time).slice(0, 10),
  io_time,
  dev_id: "DEV1",
  ingest_source: "BIOMAX",
  attendance_punch_void_id: null,
  void_reason: null,
  ...over,
});

/* ============================================================ the cards */

describe("Checked In counts DISTINCT EMPLOYEES with a valid punch", () => {
  it("counts an employee once however many punches they made", async () => {
    const uc = buildUsecase(
      fakeRepo({
        rawPunches: [
          punch(42, `${DATE} 10:02:00`, { punch_id: 1 }),
          punch(42, `${DATE} 14:00:00`, { punch_id: 2 }),
          punch(42, `${DATE} 15:00:00`, { punch_id: 3 }),
          punch(42, `${DATE} 22:05:00`, { punch_id: 4 }),
        ],
      })
    );
    const res = await uc.getOverview({ attendance_date: DATE, now: ist("2026-09-13", 6, 0) });
    assert.equal(res.cards.total_employees.count, 1);
    assert.equal(res.cards.checked_in.count, 1);
  });

  it("a within-10-minute DUPLICATE cannot create a check-in on its own", async () => {
    // Two frames four minutes apart: the second is suppressed by the
    // canonical effective-punch rule, so this is ONE punch, an odd count.
    const uc = buildUsecase(
      fakeRepo({
        rawPunches: [
          punch(42, `${DATE} 10:00:00`, { punch_id: 1 }),
          punch(42, `${DATE} 10:04:00`, { punch_id: 2 }),
        ],
      })
    );
    const res = await uc.getOverview({ attendance_date: DATE, now: ist("2026-09-13", 6, 0) });
    assert.equal(res.cards.checked_in.count, 1, "still one employee, not two");
    const { rows } = await uc.buildPopulation({ attendance_date: DATE, now: ist("2026-09-13", 6, 0) });
    assert.equal(rows[0].punch_count, 1, "the duplicate is excluded from the effective stream");
  });

  it("a VOIDED punch is not a check-in", async () => {
    const uc = buildUsecase(
      fakeRepo({
        rawPunches: [
          punch(42, `${DATE} 10:00:00`, { punch_id: 1, attendance_punch_void_id: 9, void_reason: "Wrong person" }),
        ],
      })
    );
    const res = await uc.getOverview({ attendance_date: DATE, now: ist("2026-09-13", 6, 0) });
    assert.equal(res.cards.checked_in.count, 0);
    assert.equal(res.cards.absent.count, 1, "no valid punch on a closed day is the engine's ABSENT");
  });

  it("an APPROVED regularized punch does count", async () => {
    const uc = buildUsecase(
      fakeRepo({
        rawPunches: [],
        regularized: [
          {
            punch_id: 500,
            employee_id: 42,
            attendance_date: DATE,
            io_time: `${DATE} 10:00:00`,
            punch_source: "REGULARIZED",
          },
        ],
      })
    );
    const res = await uc.getOverview({ attendance_date: DATE, now: ist("2026-09-13", 6, 0) });
    assert.equal(res.cards.checked_in.count, 1);
  });
});

describe("an OPEN day withholds the verdicts it has not earned", () => {
  const single = { rawPunches: [punch(42, `${DATE} 10:05:00`, { punch_id: 1 })] };

  it("a single punch on an ongoing shift is Checked In, NOT a missing punch", async () => {
    const uc = buildUsecase(fakeRepo(single));
    const res = await uc.getOverview({ attendance_date: DATE, now: ist(DATE, 15, 0) });
    assert.equal(res.is_open_day, true);
    assert.equal(res.cards.checked_in.count, 1);
    assert.equal(res.cards.need_action.count, 0, "still at work is not a correction to make");
  });

  it("the SAME single punch becomes a Missing Punch once the day closes", async () => {
    const uc = buildUsecase(fakeRepo(single));
    const res = await uc.getOverview({ attendance_date: DATE, now: ist("2026-09-13", 4, 0) });
    assert.equal(res.is_open_day, false);
    assert.equal(res.cards.need_action.count, 1);
    const missing = res.cards.need_action.by_issue.find((i) => i.key === "MISSING_PUNCH");
    assert.equal(missing.count, 1);
  });

  it("nobody is absent before their shift has started", async () => {
    const uc = buildUsecase(fakeRepo({ rawPunches: [] }));
    const res = await uc.getOverview({ attendance_date: DATE, now: ist(DATE, 8, 0) });
    assert.equal(res.cards.absent.count, 0);
    assert.equal(res.cards.not_yet_checked_in.count, 0, "the shift has not begun");
    assert.equal(res.overview.slices.find((s) => s.slice === "SHIFT_NOT_STARTED").count, 1);
  });

  it("after in-time with no punch, the open-day answer is Not Yet Checked In", async () => {
    const uc = buildUsecase(fakeRepo({ rawPunches: [] }));
    const res = await uc.getOverview({ attendance_date: DATE, now: ist(DATE, 12, 0) });
    assert.equal(res.cards.not_yet_checked_in.count, 1);
    assert.equal(res.cards.absent.count, 0, "the day can still be worked");
  });

  it("a genuine closed-day absence IS reported", async () => {
    const uc = buildUsecase(fakeRepo({ rawPunches: [] }));
    const res = await uc.getOverview({ attendance_date: DATE, now: ist("2026-09-13", 5, 0) });
    assert.equal(res.cards.absent.count, 1);
    assert.equal(res.cards.not_yet_checked_in.count, 0);
  });

  it("the 04:00 cutoff boundary: 03:59 is still open, 04:00 is closed", async () => {
    const uc = buildUsecase(fakeRepo({ rawPunches: [] }));
    const open = await uc.getOverview({ attendance_date: DATE, now: ist("2026-09-13", 3, 59) });
    const closed = await uc.getOverview({ attendance_date: DATE, now: ist("2026-09-13", 4, 0) });
    assert.equal(open.cards.absent.count, 0);
    assert.equal(closed.cards.absent.count, 1);
  });

  it("a punch after midnight still belongs to the previous attendance date", async () => {
    const uc = buildUsecase(
      fakeRepo({
        rawPunches: [
          punch(42, `${DATE} 10:00:00`, { punch_id: 1 }),
          // 00:30 the next morning, inside the 04:00 cutoff.
          punch(42, "2026-09-13 00:30:00", { punch_id: 2 }),
        ],
      })
    );
    const { rows } = await uc.buildPopulation({ attendance_date: DATE, now: ist("2026-09-13", 6, 0) });
    assert.equal(rows[0].punch_count, 2, "the overnight OUT is dated to the shift date");
    assert.equal(rows[0].status, "FINAL");
  });
});

describe("setup faults are surfaced, never counted as absence", () => {
  it("no assignment history for the date is No Shift Assigned", async () => {
    const uc = buildUsecase(fakeRepo({ assignments: [], rawPunches: [] }));
    const res = await uc.getOverview({ attendance_date: DATE, now: ist("2026-09-13", 6, 0) });
    assert.equal(res.cards.absent.count, 0, "we do not know what they were rostered for");
    assert.equal(res.cards.need_action.count, 1);
    assert.equal(res.cards.need_action.by_issue.find((i) => i.key === "NO_SHIFT").count, 1);
    assert.equal(res.overview.slices.find((s) => s.slice === "UNRESOLVED").count, 1);
  });

  it("a missing schedule row is a Shift Setup Issue, and the employee is not lost", async () => {
    const uc = buildUsecase(fakeRepo({ schedules: [], rawPunches: [] }));
    const res = await uc.getOverview({ attendance_date: DATE, now: ist("2026-09-13", 6, 0) });
    assert.equal(res.cards.need_action.by_issue.find((i) => i.key === "SHIFT_SETUP").count, 1);
    const gap = res.by_shift.find((s) => s.setup_gap);
    assert.ok(gap, "an unresolvable shift gets its own visible row");
    assert.equal(gap.expected, 1);
    assert.equal(
      res.by_shift.reduce((a, s) => a + s.expected, 0),
      res.cards.total_employees.count,
      "the shift panel still adds up to the whole population"
    );
  });
});

describe("pending requests", () => {
  it("a PENDING regularization puts the day in Need Action", async () => {
    const uc = buildUsecase(
      fakeRepo({
        rawPunches: [punch(42, `${DATE} 10:00:00`, { punch_id: 1 })],
        approvals: [
          {
            attendance_approval_request_id: 77,
            employee_id: 42,
            attendance_date: DATE,
            request_type: "REGULARIZATION",
            status: "PENDING",
            finalization_state: "NOT_REQUIRED",
            candidate_ot_minutes: 0,
            approved_ot_minutes: 0,
          },
        ],
      })
    );
    const res = await uc.getOverview({ attendance_date: DATE, now: ist(DATE, 15, 0) });
    assert.equal(
      res.cards.need_action.by_issue.find((i) => i.key === "REGULARIZATION_PENDING").count,
      1,
      "a waiting request is reported even while the day is open"
    );
  });

  it("OT pending alone does NOT move a normal day into Need Action", async () => {
    const uc = buildUsecase(
      fakeRepo({
        rawPunches: [
          punch(42, `${DATE} 10:00:00`, { punch_id: 1 }),
          punch(42, `${DATE} 23:30:00`, { punch_id: 2 }),
        ],
        approvals: [
          {
            attendance_approval_request_id: 88,
            employee_id: 42,
            attendance_date: DATE,
            request_type: "OT",
            status: "PENDING",
            finalization_state: "NOT_REQUIRED",
            candidate_ot_minutes: 90,
            approved_ot_minutes: 0,
          },
        ],
      })
    );
    const res = await uc.getOverview({ attendance_date: DATE, now: ist("2026-09-13", 6, 0) });
    assert.equal(res.cards.need_action.count, 0, "OT is a claim on a worked day, not a defect in it");
    assert.equal(res.cards.checked_in.count, 1);
    assert.equal(res.cards.ot_requests_pending.count, 1);
    assert.equal(res.cards.ot_requests_pending.minutes, 90, "the engine's minutes, from the request");
    assert.equal(res.cards.ot_requests_pending.employees, 1);
  });
});

describe("the slices reconcile to the population", () => {
  it("always sum to the filtered total", async () => {
    const uc = buildUsecase(
      fakeRepo({
        employees: [
          employee(1),
          employee(2),
          employee(3, { store_id: 2, outlet_name: "Warehouse" }),
          employee(4),
        ],
        assignments: [
          { employee_work_shift_assignment_id: 1, employee_id: 1, work_shift_id: 7, effective_from: "2026-09-01" },
          { employee_work_shift_assignment_id: 2, employee_id: 2, work_shift_id: 7, effective_from: "2026-09-01" },
          { employee_work_shift_assignment_id: 3, employee_id: 3, work_shift_id: 7, effective_from: "2026-09-01" },
          // employee 4 has NO assignment: an unresolved shift.
        ],
        rawPunches: [
          punch(1, `${DATE} 10:00:00`, { punch_id: 1 }),
          punch(1, `${DATE} 22:00:00`, { punch_id: 2 }),
          punch(2, `${DATE} 10:10:00`, { punch_id: 3 }),
        ],
      })
    );
    const res = await uc.getOverview({ attendance_date: DATE, now: ist("2026-09-13", 6, 0) });
    assert.equal(res.cards.total_employees.count, 4);
    assert.equal(res.overview.reconciles, true);
    assert.equal(
      res.overview.slices.reduce((a, s) => a + s.count, 0),
      4
    );
    assert.equal(
      res.by_location.reduce((a, l) => a + l.total, 0),
      4,
      "the location panel covers everybody too"
    );
  });
});

describe("filters and drilldowns agree with the cards", () => {
  const state = {
    employees: [
      employee(1),
      employee(2),
      employee(3, { store_id: 2, outlet_name: "Warehouse" }),
      employee(4, { designation_id: 6, designation_name: "Packer" }),
    ],
    rawPunches: [
      punch(1, `${DATE} 10:00:00`, { punch_id: 1 }),
      punch(1, `${DATE} 22:00:00`, { punch_id: 2 }),
      punch(3, `${DATE} 10:00:00`, { punch_id: 3 }),
      punch(3, `${DATE} 22:00:00`, { punch_id: 4 }),
    ],
  };

  it("an outlet filter narrows every card and every panel", async () => {
    const uc = buildUsecase(fakeRepo(state));
    const res = await uc.getOverview({
      attendance_date: DATE,
      store_ids: [2],
      now: ist("2026-09-13", 6, 0),
    });
    assert.equal(res.cards.total_employees.count, 1);
    assert.equal(res.cards.checked_in.count, 1);
    assert.equal(res.by_location.length, 1);
    assert.equal(res.by_location[0].outlet_name, "Warehouse");
  });

  it("a designation filter narrows the population", async () => {
    const uc = buildUsecase(fakeRepo(state));
    const res = await uc.getOverview({
      attendance_date: DATE,
      designation_id: 6,
      now: ist("2026-09-13", 6, 0),
    });
    assert.equal(res.cards.total_employees.count, 1);
    assert.equal(res.cards.checked_in.count, 0);
  });

  it("the drilldown total equals the card it came from, under the same filters", async () => {
    const uc = buildUsecase(fakeRepo(state));
    const now = ist("2026-09-13", 6, 0);
    const res = await uc.getOverview({ attendance_date: DATE, now });
    const drill = await uc.getDrilldown({ attendance_date: DATE, bucket: "CHECKED_IN", now });
    assert.equal(drill.total, res.cards.checked_in.count);
    assert.equal(drill.employees.length, drill.total);
    assert.deepEqual(
      drill.employees.map((e) => e.employee_id).sort(),
      [1, 3]
    );
  });

  it("the ABSENT drilldown lists the absent employees and nobody else", async () => {
    const uc = buildUsecase(fakeRepo(state));
    const now = ist("2026-09-13", 6, 0);
    const res = await uc.getOverview({ attendance_date: DATE, now });
    const drill = await uc.getDrilldown({ attendance_date: DATE, bucket: "ABSENT", now });
    assert.equal(drill.total, res.cards.absent.count);
    assert.deepEqual(drill.employees.map((e) => e.employee_id).sort(), [2, 4]);
  });

  it("paginates and never returns more than asked", async () => {
    const uc = buildUsecase(fakeRepo(state));
    const now = ist("2026-09-13", 6, 0);
    const page = await uc.getDrilldown({ attendance_date: DATE, bucket: "TOTAL", limit: 2, offset: 0, now });
    assert.equal(page.total, 4);
    assert.equal(page.employees.length, 2);
    const next = await uc.getDrilldown({ attendance_date: DATE, bucket: "TOTAL", limit: 2, offset: 2, now });
    assert.equal(next.employees.length, 2);
    const overlap = page.employees.filter((e) =>
      next.employees.some((n) => n.employee_id === e.employee_id)
    );
    assert.equal(overlap.length, 0, "pages do not repeat an employee");
  });

  it("refuses an unknown drilldown bucket rather than returning everybody", async () => {
    const uc = buildUsecase(fakeRepo(state));
    await assert.rejects(
      () => uc.getDrilldown({ attendance_date: DATE, bucket: "EVERYTHING", now: ist(DATE, 12, 0) }),
      /Unknown drilldown bucket/
    );
  });

  it("the search is a filter over the scoped population", async () => {
    const uc = buildUsecase(fakeRepo(state));
    const res = await uc.getOverview({
      attendance_date: DATE,
      search: "Employee 3",
      now: ist("2026-09-13", 6, 0),
    });
    assert.equal(res.cards.total_employees.count, 1);
  });
});

describe("an empty population is empty, not zero-percent", () => {
  it("reports no employees and an unavailable rate", async () => {
    const uc = buildUsecase(fakeRepo({ employees: [] }));
    const res = await uc.getOverview({ attendance_date: DATE, now: ist(DATE, 12, 0) });
    assert.equal(res.cards.total_employees.count, 0);
    assert.equal(res.cards.checked_in.count, 0);
    assert.equal(res.cards.checked_in.rate.available, false);
    assert.equal(res.cards.checked_in.rate.percent, null);
    assert.equal(res.overview.reconciles, true);
    assert.deepEqual(res.by_location, []);
  });

  it("the trend says NO_POPULATION rather than drawing a flat zero line", async () => {
    const uc = buildUsecase(fakeRepo({ employees: [] }));
    const res = await uc.getTrend({ attendance_date: DATE, now: ist(DATE, 12, 0) });
    assert.equal(res.available, false);
    assert.equal(res.reason, "NO_POPULATION");
    assert.deepEqual(res.days, []);
  });
});

describe("the trend plots COMPLETED days only", () => {
  it("excludes the still-open selected day", async () => {
    const uc = buildUsecase(fakeRepo({ rawPunches: [] }));
    // 15:00 on the selected date: that date is open, the ones before are not.
    const res = await uc.getTrend({ attendance_date: DATE, days: 5, now: ist(DATE, 15, 0) });
    assert.ok(res.days.length > 0);
    assert.ok(
      res.days.every((d) => d.attendance_date < DATE),
      "an in-progress day's provisional rate is never shown beside finished days"
    );
  });

  it("honours the requested window and reports a partial history honestly", async () => {
    const uc = buildUsecase(fakeRepo({ rawPunches: [] }));
    const res = await uc.getTrend({ attendance_date: DATE, days: 3, now: ist("2026-09-13", 6, 0) });
    assert.equal(res.requested_days, 3);
    assert.ok(res.days.length <= 3);
    assert.ok(res.days.every((d) => d.check_in_rate.denominator === 1));
  });

  it("each trend point carries its own numerator and denominator", async () => {
    const uc = buildUsecase(
      fakeRepo({
        rawPunches: [
          punch(42, "2026-09-11 10:00:00", { punch_id: 1 }),
          punch(42, "2026-09-11 22:00:00", { punch_id: 2 }),
        ],
      })
    );
    const res = await uc.getTrend({ attendance_date: DATE, days: 4, now: ist("2026-09-13", 6, 0) });
    const day = res.days.find((d) => d.attendance_date === "2026-09-11");
    assert.equal(day.checked_in, 1);
    assert.equal(day.applicable, 1);
    assert.equal(day.check_in_rate.percent, 100);
  });
});

describe("device sync is evidence, not a verdict", () => {
  it("reports last_seen_at and last_punch_at separately, with ages", async () => {
    const uc = buildUsecase(
      fakeRepo({
        devices: [
          {
            biomax_device_id: 1,
            dev_id: "DEV1",
            label: "Main - G1",
            last_seen_at: `${DATE} 11:00:00`,
            last_punch_at: `${DATE} 10:00:00`,
            outlet_id: 1,
            outlet_name: "Main Store",
          },
        ],
      })
    );
    const res = await uc.getRecentPunches({ attendance_date: DATE, now: ist(DATE, 12, 0) });
    const dev = res.devices[0];
    assert.equal(dev.sync_known, true);
    assert.equal(dev.last_seen_age_minutes, 60);
    assert.equal(dev.last_punch_age_minutes, 120);
    assert.notEqual(
      dev.last_seen_at,
      dev.last_punch_at,
      "a quiet terminal is not the same as an absent one"
    );
  });

  it("an unknown sync state is UNKNOWN, never 'offline'", async () => {
    const uc = buildUsecase(
      fakeRepo({
        devices: [
          { biomax_device_id: 2, dev_id: "DEV2", label: "Warehouse - G2", last_seen_at: null, last_punch_at: null },
        ],
      })
    );
    const res = await uc.getRecentPunches({ attendance_date: DATE, now: ist(DATE, 12, 0) });
    assert.equal(res.devices[0].sync_known, false);
    assert.equal(res.devices[0].last_seen_age_minutes, null);
    assert.ok(!("online" in res.devices[0]), "no online/offline verdict is invented");
  });

  it("does not claim a direction it cannot establish, and labels an excluded punch", async () => {
    const uc = buildUsecase(
      fakeRepo({
        rawPunches: [
          punch(42, `${DATE} 10:00:00`, { punch_id: 1 }),
          punch(42, `${DATE} 22:00:00`, {
            punch_id: 2,
            attendance_punch_void_id: 5,
            void_reason: "Wrong person",
          }),
        ],
      })
    );
    const res = await uc.getRecentPunches({ attendance_date: DATE, now: ist("2026-09-13", 6, 0) });
    assert.ok(res.punches.length >= 1);
    assert.ok(
      res.punches.every((p) => p.direction === "PUNCH"),
      "the device flag is not a direction flag"
    );
    const voided = res.punches.find((p) => p.punch_id === 2);
    assert.ok(voided, "a voided punch is still shown, for diagnosis");
    assert.equal(voided.excluded, true);
    assert.match(voided.excluded_reason, /Voided/);
  });

  it("observed_at is the terminal reading's time, distinct from the attendance date", async () => {
    const uc = buildUsecase(fakeRepo({}));
    const res = await uc.getRecentPunches({ attendance_date: DATE, now: ist("2026-09-20", 12, 34) });
    assert.equal(res.attendance_date, DATE);
    assert.equal(res.observed_at, "2026-09-20 12:34");
    assert.match(res.note, /OBSERVED NOW \(observed_at\) and is not evidence about the selected date/);
  });

  it("the punch feed is the SELECTED attendance day, not the latest punches anywhere", async () => {
    const uc = buildUsecase(
      fakeRepo({
        rawPunches: [
          punch(42, "2026-09-10 10:00:00", { punch_id: 1 }),
          punch(42, "2026-09-10 22:00:00", { punch_id: 2 }),
          punch(42, `${DATE} 10:00:00`, { punch_id: 3 }),
          punch(42, `${DATE} 22:00:00`, { punch_id: 4 }),
        ],
      })
    );
    const res = await uc.getRecentPunches({ attendance_date: DATE, now: ist("2026-09-13", 6, 0) });
    assert.deepEqual(
      res.punches.map((p) => p.punch_id).sort((a, b) => a - b),
      [3, 4],
      "punches from another day must not appear under this one"
    );
  });

  it("an overnight punch belongs to the shift date, not the calendar date it landed on", async () => {
    const uc = buildUsecase(
      fakeRepo({
        rawPunches: [
          punch(42, `${DATE} 10:00:00`, { punch_id: 1 }),
          // 00:30 the next morning, inside the 04:00 cutoff.
          punch(42, "2026-09-13 00:30:00", { punch_id: 2 }),
        ],
      })
    );
    const res = await uc.getRecentPunches({ attendance_date: DATE, now: ist("2026-09-13", 6, 0) });
    assert.deepEqual(
      res.punches.map((p) => p.punch_id).sort((a, b) => a - b),
      [1, 2],
      "a midnight-to-midnight filter would have dropped the OUT"
    );
  });

  it("the feed honours the employee search, like every other panel", async () => {
    const uc = buildUsecase(
      fakeRepo({
        employees: [employee(1), employee(2)],
        rawPunches: [
          punch(1, `${DATE} 10:00:00`, { punch_id: 1 }),
          punch(1, `${DATE} 22:00:00`, { punch_id: 2 }),
          punch(2, `${DATE} 10:00:00`, { punch_id: 3 }),
          punch(2, `${DATE} 22:00:00`, { punch_id: 4 }),
        ],
      })
    );
    const res = await uc.getRecentPunches({
      attendance_date: DATE,
      search: "Employee 2",
      now: ist("2026-09-13", 6, 0),
    });
    assert.deepEqual(res.punches.map((p) => p.punch_id).sort((a, b) => a - b), [3, 4]);
  });

  it("a punch-read failure is reported, not rendered as an empty feed", async () => {
    const uc = buildUsecase(
      fakeRepo({
        punchesByIdsThrows: true,
        rawPunches: [
          punch(42, `${DATE} 10:00:00`, { punch_id: 1 }),
          punch(42, `${DATE} 22:00:00`, { punch_id: 2 }),
        ],
      })
    );
    const res = await uc.getRecentPunches({ attendance_date: DATE, now: ist("2026-09-13", 6, 0) });
    assert.equal(res.punches_available, false);
    assert.deepEqual(res.punches, []);
  });
});

describe("filters come from real master data", () => {
  it("offers Shift Management's own active shifts and nothing invented", async () => {
    const uc = buildUsecase(
      fakeRepo({
        activeShifts: [
          { work_shift_id: 1, shift_code: "9-9", shift_name: "Nine to Nine" },
          { work_shift_id: 2, shift_code: "10-10", shift_name: "Ten to Ten" },
          { work_shift_id: 3, shift_code: "2-10", shift_name: "Two to Ten" },
        ],
      })
    );
    const res = await uc.getFilters();
    assert.deepEqual(res.shifts.map((s) => s.shift_code), ["9-9", "10-10", "2-10"]);
    assert.ok(!res.shifts.some((s) => /Morning|General|Night/.test(s.shift_name)));
    assert.match(res.today, /^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("applicability is the dated fact, and the query is asked for it", () => {
  it("passes the selected date as the applicability bound, not today", async () => {
    const repo = fakeRepo({});
    const uc = buildUsecase(repo);
    await uc.getOverview({ attendance_date: "2026-03-04", now: ist(DATE, 12, 0) });
    assert.equal(
      repo.calls.lastFilters.attendance_date,
      "2026-03-04",
      "a historical date is judged by who was employed THEN"
    );
  });

  it("refuses a population larger than the cap instead of melting the pool", async () => {
    const many = Array.from({ length: 2001 }, (_, i) => employee(i + 1));
    const uc = buildUsecase(fakeRepo({ employees: many }));
    await assert.rejects(
      () => uc.getOverview({ attendance_date: DATE, now: ist(DATE, 12, 0) }),
      /narrow the filters/
    );
  });

  it("rejects a malformed date rather than guessing one", async () => {
    const uc = buildUsecase(fakeRepo({}));
    await assert.rejects(
      () => uc.getOverview({ attendance_date: "12-09-2026", now: ist(DATE, 12, 0) }),
      /attendance_date must be a date/
    );
  });
});

describe("the reads are batched", () => {
  it("one punch query for the whole population, not one per employee", async () => {
    const repo = fakeRepo({ employees: Array.from({ length: 50 }, (_, i) => employee(i + 1)) });
    const uc = buildUsecase(repo);
    await uc.getOverview({ attendance_date: DATE, now: ist(DATE, 12, 0) });
    assert.equal(repo.calls.rawPunches, 1, "fifty employees must not mean fifty queries");
  });
});

/* ================================ delivery completeness (finding 4) ==== */

describe("a closed day is not a complete one", () => {
  const closedNow = ist("2026-09-13", 6, 0);

  it("confirms absence when every terminal was in contact after the close", async () => {
    const uc = buildUsecase(fakeRepo({ rawPunches: [] }));
    const res = await uc.getOverview({ attendance_date: DATE, now: closedNow });
    assert.equal(res.cards.absent.count, 1);
    assert.equal(res.delivery_confirmed, true);
  });

  it("withholds absence when the terminal has not been heard from since the close", async () => {
    const uc = buildUsecase(
      fakeRepo({
        rawPunches: [],
        deviceCoverage: [
          {
            outlet_id: 1,
            biomax_device_id: 1,
            dev_id: "DEV1",
            label: "Main - G1",
            // Before the 04:00 cutoff on the 13th: it may still hold punches.
            last_seen_at: `${DATE} 20:00:00`,
            last_punch_at: `${DATE} 20:00:00`,
          },
        ],
      })
    );
    const res = await uc.getOverview({ attendance_date: DATE, now: closedNow });
    assert.equal(res.cards.absent.count, 0, "this is a gap in the feed, not an absence");
    assert.equal(res.overview.slices.find((s) => s.slice === "UNRESOLVED").count, 1);
    assert.equal(res.overview.unconfirmed_absence, 1);
    assert.equal(res.delivery_confirmed, false);
  });

  it("withholds absence while a historical pull covering the date is still running", async () => {
    const uc = buildUsecase(
      fakeRepo({
        rawPunches: [],
        openPulls: [
          {
            biomax_historical_pull_id: 1,
            biomax_device_id: 1,
            dev_id: "DEV1",
            status: "RECEIVING",
            requested_from: `${DATE} 00:00:00`,
            requested_to: `${DATE} 23:59:59`,
            outlet_id: 1,
          },
        ],
      })
    );
    const res = await uc.getOverview({ attendance_date: DATE, now: closedNow });
    assert.equal(res.cards.absent.count, 0);
    assert.equal(res.coverage.find((c) => c.store_id === 1).coverage, "INCOMPLETE");
  });

  it("a device-health FAILURE withholds absence rather than confirming it", async () => {
    const uc = buildUsecase(fakeRepo({ rawPunches: [], coverageThrows: true }));
    const res = await uc.getOverview({ attendance_date: DATE, now: closedNow });
    assert.equal(res.cards.absent.count, 0, "unknown must fail towards under-claiming absence");
    assert.equal(res.coverage_available, false);
  });

  it("punches still count as check-ins when delivery is unconfirmed", async () => {
    const uc = buildUsecase(
      fakeRepo({
        rawPunches: [
          punch(42, `${DATE} 10:00:00`, { punch_id: 1 }),
          punch(42, `${DATE} 22:00:00`, { punch_id: 2 }),
        ],
        coverageThrows: true,
      })
    );
    const res = await uc.getOverview({ attendance_date: DATE, now: closedNow });
    assert.equal(res.cards.checked_in.count, 1, "what arrived is not in doubt");
  });

  it("one healthy location does not vouch for another", async () => {
    const uc = buildUsecase(
      fakeRepo({
        employees: [employee(1, { store_id: 1 }), employee(2, { store_id: 2, outlet_name: "Warehouse" })],
        rawPunches: [],
        deviceCoverage: [
          // Outlet 1 healthy; outlet 2 silent since before the close.
          { outlet_id: 1, biomax_device_id: 1, dev_id: "D1", label: "G1", last_seen_at: "2026-09-20 10:00:00", last_punch_at: null },
          { outlet_id: 2, biomax_device_id: 2, dev_id: "D2", label: "G2", last_seen_at: `${DATE} 18:00:00`, last_punch_at: null },
        ],
      })
    );
    const res = await uc.getOverview({ attendance_date: DATE, now: closedNow });
    assert.equal(res.cards.absent.count, 1, "only the covered location's absence is confirmed");
    const drill = await uc.getDrilldown({ attendance_date: DATE, bucket: "ABSENT", now: closedNow });
    assert.deepEqual(drill.employees.map((e) => e.employee_id), [1]);
    assert.equal(res.coverage.find((c) => c.store_id === 2).coverage, "UNKNOWN");
  });

  it("a late punch arriving turns an unconfirmed day into a check-in", async () => {
    // Same date, same silent terminal - but the punch has now been delivered.
    const silent = [
      { outlet_id: 1, biomax_device_id: 1, dev_id: "D1", label: "G1", last_seen_at: `${DATE} 18:00:00`, last_punch_at: null },
    ];
    const before = await buildUsecase(
      fakeRepo({ rawPunches: [], deviceCoverage: silent })
    ).getOverview({ attendance_date: DATE, now: closedNow });
    assert.equal(before.cards.checked_in.count, 0);
    assert.equal(before.cards.absent.count, 0);

    const after = await buildUsecase(
      fakeRepo({
        deviceCoverage: silent,
        rawPunches: [
          punch(42, `${DATE} 10:00:00`, { punch_id: 1 }),
          punch(42, `${DATE} 22:00:00`, { punch_id: 2 }),
        ],
      })
    ).getOverview({ attendance_date: DATE, now: closedNow });
    assert.equal(after.cards.checked_in.count, 1);
    assert.equal(after.cards.absent.count, 0);
  });

  it("the UNCONFIRMED_ABSENCE drilldown lists exactly who is being held", async () => {
    const uc = buildUsecase(
      fakeRepo({
        rawPunches: [],
        deviceCoverage: [
          { outlet_id: 1, biomax_device_id: 1, dev_id: "D1", label: "G1", last_seen_at: `${DATE} 18:00:00`, last_punch_at: null },
        ],
      })
    );
    const drill = await uc.getDrilldown({
      attendance_date: DATE,
      bucket: "UNCONFIRMED_ABSENCE",
      now: closedNow,
    });
    assert.equal(drill.total, 1);
    assert.match(drill.employees[0].unresolved_reason, /has not been in contact/);
  });
});

/* ================================ per-date populations (finding 2) ==== */

describe("the trend resolves its population PER DATE", () => {
  const closedNow = ist("2026-09-13", 6, 0);

  it("does not count a mid-window joiner before they joined", async () => {
    const uc = buildUsecase(
      fakeRepo({
        rangeEmployees: [employee(1, { joined_on: "2026-09-10" })],
        employees: [employee(1, { joined_on: "2026-09-10" })],
        rawPunches: [],
      })
    );
    const res = await uc.getTrend({ attendance_date: DATE, days: 10, now: closedNow });
    const before = res.days.filter((d) => d.attendance_date < "2026-09-10");
    assert.equal(before.length, 0, "days before somebody joined have no population at all");
    assert.ok(res.days.every((d) => d.attendance_date >= "2026-09-10"));
    assert.ok(res.days.every((d) => d.applicable === 1));
  });

  it("still counts a mid-window leaver on the days they actually worked", async () => {
    const uc = buildUsecase(
      fakeRepo({
        // Resigned before the selected date: the OLD code dropped them from
        // every day of the window, including the ones they worked.
        rangeEmployees: [employee(1, { resignation_date: "2026-09-08" })],
        employees: [],
        rawPunches: [
          punch(1, "2026-09-07 10:00:00", { punch_id: 1 }),
          punch(1, "2026-09-07 22:00:00", { punch_id: 2 }),
        ],
      })
    );
    const res = await uc.getTrend({ attendance_date: DATE, days: 12, now: closedNow });
    const worked = res.days.find((d) => d.attendance_date === "2026-09-07");
    assert.ok(worked, "the day they worked is in the trend");
    assert.equal(worked.applicable, 1);
    assert.equal(worked.checked_in, 1);
    assert.ok(
      res.days.every((d) => d.attendance_date <= "2026-09-08"),
      "and they are gone from every day after they left"
    );
  });

  it("the resignation date itself is still an applicable day", async () => {
    const uc = buildUsecase(
      fakeRepo({ rangeEmployees: [employee(1, { resignation_date: "2026-09-08" })], employees: [], rawPunches: [] })
    );
    const res = await uc.getTrend({ attendance_date: DATE, days: 12, now: closedNow });
    assert.ok(
      res.days.some((d) => d.attendance_date === "2026-09-08"),
      "resigned ON the 8th means the 8th counts, matching the single-date rule"
    );
  });

  it("an unreadable joining date leaves the start unbounded, as the SQL does", async () => {
    const uc = buildUsecase(
      fakeRepo({ rangeEmployees: [employee(1, { joined_on: null })], employees: [employee(1)], rawPunches: [] })
    );
    const res = await uc.getTrend({ attendance_date: DATE, days: 5, now: closedNow });
    assert.ok(res.days.length > 0);
    assert.ok(res.days.every((d) => d.applicable === 1));
  });

  it("agrees with the single-date overview for a date they both cover", async () => {
    const state = {
      employees: [employee(1), employee(2)],
      rangeEmployees: [employee(1), employee(2)],
      rawPunches: [
        punch(1, "2026-09-11 10:00:00", { punch_id: 1 }),
        punch(1, "2026-09-11 22:00:00", { punch_id: 2 }),
      ],
    };
    const overview = await buildUsecase(fakeRepo(state)).getOverview({
      attendance_date: "2026-09-11",
      now: closedNow,
    });
    const trend = await buildUsecase(fakeRepo(state)).getTrend({
      attendance_date: DATE,
      days: 5,
      now: closedNow,
    });
    const day = trend.days.find((d) => d.attendance_date === "2026-09-11");
    assert.ok(day, "the date is in the trend");
    assert.equal(day.applicable, overview.cards.total_employees.count);
    assert.equal(day.checked_in, overview.cards.checked_in.count);
    assert.equal(day.absent, overview.cards.absent.count);
  });

  it("honours the employee search, which the first version dropped", async () => {
    const uc = buildUsecase(
      fakeRepo({
        employees: [employee(1), employee(2)],
        rangeEmployees: [employee(1), employee(2)],
        rawPunches: [],
      })
    );
    const all = await uc.getTrend({ attendance_date: DATE, days: 5, now: closedNow });
    const one = await uc.getTrend({ attendance_date: DATE, days: 5, search: "Employee 2", now: closedNow });
    assert.equal(all.days[0].applicable, 2);
    assert.equal(one.days[0].applicable, 1, "the chart must describe the same people as the cards");
  });

  it("withholds the rate for a day whose delivery is unconfirmed", async () => {
    const uc = buildUsecase(
      fakeRepo({
        rawPunches: [],
        deviceCoverageRange: [
          {
            outlet_id: 1,
            biomax_device_id: 1,
            dev_id: "D1",
            label: "G1",
            effective_from: "2020-01-01 00:00:00",
            effective_to: null,
            last_seen_at: "2026-09-05 10:00:00",
          },
        ],
      })
    );
    const res = await uc.getTrend({ attendance_date: DATE, days: 5, now: closedNow });
    assert.ok(res.days.length > 0);
    assert.ok(
      res.days.every((d) => d.check_in_rate.available === false),
      "a rate built on an unconfirmed feed is a lower bound, not a measurement"
    );
    assert.equal(res.available, false);
    assert.equal(res.reason, "NO_CONFIRMED_DELIVERY");
    assert.ok(res.days.every((d) => d.unavailable_reason));
  });

  it("still batches: one range population read and one punch read", async () => {
    const repo = fakeRepo({
      employees: Array.from({ length: 40 }, (_, i) => employee(i + 1)),
      rangeEmployees: Array.from({ length: 40 }, (_, i) => employee(i + 1)),
    });
    const uc = buildUsecase(repo);
    await uc.getTrend({ attendance_date: DATE, days: 14, now: closedNow });
    assert.equal(repo.calls.rawPunches, 1, "forty employees over fourteen days is still one read");
  });
});

/* ================================= exact drilldowns (finding 3) ==== */

describe("a drilldown lists the exact group that was clicked", () => {
  const closedNow = ist("2026-09-13", 6, 0);

  it("finds a CHECKED-IN employee whose shift has no schedule row", async () => {
    // The employee this panel most needs to show: they turned up, and their
    // roster is broken. Their slice is CHECKED_IN, so a slice-based drilldown
    // could never find them.
    const uc = buildUsecase(
      fakeRepo({
        schedules: [],
        rawPunches: [
          punch(42, `${DATE} 10:00:00`, { punch_id: 1 }),
          punch(42, `${DATE} 22:00:00`, { punch_id: 2 }),
        ],
      })
    );
    const overview = await uc.getOverview({ attendance_date: DATE, now: closedNow });
    assert.equal(overview.cards.checked_in.count, 1, "they are checked in");
    assert.equal(
      overview.cards.need_action.by_issue.find((i) => i.key === "SHIFT_SETUP").count,
      1,
      "and they need action"
    );

    const bySlice = await uc.getDrilldown({ attendance_date: DATE, bucket: "UNRESOLVED", now: closedNow });
    assert.equal(bySlice.total, 0, "the old slice-based drilldown would have missed them");

    const byIssue = await uc.getDrilldown({ attendance_date: DATE, bucket: "SHIFT_SETUP", now: closedNow });
    assert.equal(byIssue.total, 1);
    assert.equal(byIssue.employees[0].employee_id, 42);
  });

  it("separates No Shift Assigned from Shift Setup Issue", async () => {
    const uc = buildUsecase(
      fakeRepo({
        employees: [employee(1), employee(2)],
        // employee 1 has an assignment, employee 2 does not
        assignments: [
          { employee_work_shift_assignment_id: 1, employee_id: 1, work_shift_id: 7, effective_from: "2026-09-01" },
        ],
        schedules: [],
        rawPunches: [],
      })
    );
    const setup = await uc.getDrilldown({ attendance_date: DATE, bucket: "SHIFT_SETUP", now: closedNow });
    const noShift = await uc.getDrilldown({ attendance_date: DATE, bucket: "NO_SHIFT", now: closedNow });
    assert.deepEqual(setup.employees.map((e) => e.employee_id), [1]);
    assert.deepEqual(noShift.employees.map((e) => e.employee_id), [2]);
  });

  it("combines an issue bucket with the shift filter to name one panel row", async () => {
    const uc = buildUsecase(
      fakeRepo({
        employees: [employee(1), employee(2)],
        assignments: [
          { employee_work_shift_assignment_id: 1, employee_id: 1, work_shift_id: 7, effective_from: "2026-09-01" },
          { employee_work_shift_assignment_id: 2, employee_id: 2, work_shift_id: 8, effective_from: "2026-09-01" },
        ],
        configs: [shiftConfig(7), shiftConfig(8)],
        schedules: scheduleRows(7),
        rawPunches: [],
      })
    );
    // Only shift 8 lacks a schedule row.
    const all = await uc.getDrilldown({ attendance_date: DATE, bucket: "SHIFT_SETUP", now: closedNow });
    assert.equal(all.total, 1);
    const scoped = await uc.getDrilldown({
      attendance_date: DATE,
      bucket: "SHIFT_SETUP",
      work_shift_id: 8,
      now: closedNow,
    });
    assert.equal(scoped.total, 1);
    assert.equal(scoped.applied_filters.work_shift_id, 8);
    const other = await uc.getDrilldown({
      attendance_date: DATE,
      bucket: "SHIFT_SETUP",
      work_shift_id: 7,
      now: closedNow,
    });
    assert.equal(other.total, 0, "the other shift's row is a different group");
  });

  it("selects the no-outlet group explicitly rather than returning everybody", async () => {
    const uc = buildUsecase(
      fakeRepo({
        employees: [
          employee(1, { store_id: 1 }),
          employee(2, { store_id: null, outlet_name: null }),
        ],
        rawPunches: [],
      })
    );
    const everyone = await uc.getDrilldown({ attendance_date: DATE, bucket: "TOTAL", now: closedNow });
    assert.equal(everyone.total, 2);
    const unassigned = await uc.getDrilldown({
      attendance_date: DATE,
      bucket: "TOTAL",
      store_unassigned: true,
      now: closedNow,
    });
    assert.deepEqual(unassigned.employees.map((e) => e.employee_id), [2]);
    assert.equal(unassigned.applied_filters.store_unassigned, true);
  });

  it("echoes the filters back, so pagination carries the same group", async () => {
    const uc = buildUsecase(fakeRepo({ employees: [employee(1)], rawPunches: [] }));
    const res = await uc.getDrilldown({
      attendance_date: DATE,
      bucket: "TOTAL",
      designation_id: 5,
      search: "Employee",
      now: closedNow,
    });
    assert.equal(res.applied_filters.designation_id, 5);
    assert.equal(res.applied_filters.search, "Employee");
  });
});

/* ============================== authorized scope (finding 1) ==== */

describe("an empty authorized scope reads nothing", () => {
  it("returns no population and never queries", async () => {
    const repo = fakeRepo({ employees: [employee(1), employee(2)] });
    const uc = buildUsecase(repo);
    const res = await uc.getOverview({
      attendance_date: DATE,
      store_ids: [],
      now: ist(DATE, 12, 0),
    });
    assert.equal(res.cards.total_employees.count, 0);
    assert.equal(repo.calls.listApplicableEmployees, 0, "an empty scope never reaches the database");
  });

  it("the trend and the filter options are empty too", async () => {
    const uc = buildUsecase(fakeRepo({ employees: [employee(1)] }));
    const trend = await uc.getTrend({ attendance_date: DATE, store_ids: [], now: ist(DATE, 12, 0) });
    assert.equal(trend.available, false);
    assert.deepEqual(trend.days, []);
    const filters = await uc.getFilters({ store_ids: [] });
    assert.deepEqual(filters.outlets, []);
  });

  it("a specific scope narrows the filter options to it", async () => {
    const uc = buildUsecase(
      fakeRepo({
        outlets: [
          { outlet_id: 1, outlet_name: "Main Store" },
          { outlet_id: 2, outlet_name: "Warehouse" },
        ],
      })
    );
    const filters = await uc.getFilters({ store_ids: [2] });
    assert.deepEqual(filters.outlets.map((o) => o.store_id), [2]);
  });
});
