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
  resignation_date: null,
  ...over,
});

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
    listOutlets: async () => state.outlets || [{ outlet_id: 1, outlet_name: "Main Store", outlet_nickname: "MAIN" }],
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
    const res = await uc.getRecentPunches({ now: ist(DATE, 12, 0) });
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
    const res = await uc.getRecentPunches({ now: ist(DATE, 12, 0) });
    assert.equal(res.devices[0].sync_known, false);
    assert.equal(res.devices[0].last_seen_age_minutes, null);
    assert.ok(!("online" in res.devices[0]), "no online/offline verdict is invented");
  });

  it("does not claim a direction it cannot establish, and labels an excluded punch", async () => {
    const uc = buildUsecase(
      fakeRepo({
        recentPunches: [
          {
            punch_id: 1,
            employee_id: 42,
            employee_name: "Employee 42",
            io_time: `${DATE} 10:00:00`,
            received_at: `${DATE} 10:00:02`,
            ingest_attendance_date: DATE,
            derivation_status: "OK",
            dev_id: "DEV1",
            ingest_source: "BIOMAX",
            device_label: "Main - G1",
            punch_outlet_id: 1,
            punch_outlet_name: "Main Store",
            attendance_punch_void_id: 5,
          },
        ],
      })
    );
    const res = await uc.getRecentPunches({ now: ist(DATE, 12, 0) });
    assert.equal(res.punches[0].direction, "PUNCH", "the device flag is not a direction flag");
    assert.equal(res.punches[0].excluded, true);
    assert.match(res.punches[0].excluded_reason, /Voided/);
  });

  it("fetched_at is labelled as the response time, not a sync time", async () => {
    const uc = buildUsecase(fakeRepo({}));
    const res = await uc.getRecentPunches({ now: ist(DATE, 12, 34) });
    assert.equal(res.fetched_at, `${DATE} 12:34`);
    assert.match(res.note, /fetched_at is when this response was built/);
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
