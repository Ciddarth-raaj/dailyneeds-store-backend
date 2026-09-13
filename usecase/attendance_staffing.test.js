/**
 * The operational snapshot, against a fake repository.
 *
 *   node --test usecase/attendance_staffing.test.js
 *
 * No MySQL. `now` is pinned in every test, because a snapshot whose answers
 * depend on the hour the suite runs is one nobody can test.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildDashboard = require("./attendance_dashboard");
const buildStaffing = require("./attendance_staffing");

const DATE = "2026-09-12";
const ist = (date, hh, mm) =>
  Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), hh, mm) -
  (5 * 60 + 30) * 60 * 1000;

/** A seven-day schedule with the given in-time and span, 04:00 cutoff. */
const scheduleRows = (workShiftId, inTime, spanHours) =>
  Array.from({ length: 7 }, (_, day) => ({
    work_shift_weekly_schedule_id: workShiftId * 10 + day,
    work_shift_id: workShiftId,
    day_of_week: day,
    is_working_day: 1,
    in_time: inTime,
    out_time: null,
    attendance_day_cutoff: "04:00:00",
    break_minutes: 60,
    normal_work_minutes: spanHours * 60 - 60,
    ot_rate: 1,
  })).map((r) => {
    const [h, m] = inTime.split(":").map(Number);
    const end = (h * 60 + m + spanHours * 60) % 1440;
    return {
      ...r,
      out_time: `${String(Math.floor(end / 60)).padStart(2, "0")}:${String(end % 60).padStart(2, "0")}:00`,
    };
  });

const shiftConfig = (id, code) => ({
  work_shift_id: id,
  shift_code: code,
  shift_name: code,
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

/** Shift 1 = 9-9, shift 2 = 10-10, shift 3 = 2-10, shift 4 = 22:00-06:00. */
const CONFIGS = [
  shiftConfig(1, "9-9"),
  shiftConfig(2, "10-10"),
  shiftConfig(3, "2-10"),
  shiftConfig(4, "10PM-6AM"),
];
const SCHEDULES = [
  ...scheduleRows(1, "09:00:00", 12),
  ...scheduleRows(2, "10:00:00", 12),
  ...scheduleRows(3, "14:00:00", 8),
  ...scheduleRows(4, "22:00:00", 8),
];

const employee = (id, over = {}) => ({
  employee_id: id,
  employee_name: `Employee ${id}`,
  store_id: 1,
  designation_id: 5,
  designation_name: "Cashier",
  special_break_override_minutes: null,
  outlet_name: "Moolakulam",
  outlet_nickname: "MOOL",
  joined_on: null,
  resignation_date: null,
  ...over,
});

/**
 * Effective from well before every date these tests use. A later
 * `effective_from` would leave earlier dates with NO resolvable shift, which
 * is correct behaviour but makes a fixture silently untestable.
 */
const assign = (employee_id, work_shift_id) => ({
  employee_work_shift_assignment_id: employee_id * 10 + work_shift_id,
  employee_id,
  work_shift_id,
  effective_from: "2026-01-01",
  source: "TEST",
});

const punch = (employee_id, io_time, punch_id, over = {}) => ({
  punch_id,
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

function fakeRepo(state = {}) {
  const calls = {};
  return {
    calls,
    listApplicableEmployees: async (args) => {
      calls.population = args;
      let rows = state.employees || [employee(1)];
      if (Array.isArray(args.store_ids)) {
        rows = args.store_ids.length
          ? rows.filter((r) => args.store_ids.map(Number).includes(Number(r.store_id)))
          : [];
      }
      if (args.designation_id) {
        rows = rows.filter((r) => Number(r.designation_id) === Number(args.designation_id));
      }
      if (args.search) {
        const q = String(args.search).toLowerCase();
        rows = rows.filter((r) => String(r.employee_name).toLowerCase().includes(q));
      }
      return rows;
    },
    getShiftAssignmentHistoryForEmployees: async (ids) =>
      (state.assignments || ids.map((id) => assign(id, 1))).filter((a) =>
        ids.includes(Number(a.employee_id))
      ),
    getDateShiftOverridesForEmployees: async () => state.overrides || [],
    listWorkShiftConfigs: async () => state.configs || CONFIGS,
    listWorkShiftSchedules: async () => (state.schedules === undefined ? SCHEDULES : state.schedules),
    listWorkShiftConfigVersions: async () => [],
    getRawPunchesForEmployees: async (ids, from, to) =>
      (state.rawPunches || []).filter((p) => {
        const day = String(p.io_time).slice(0, 10);
        return ids.includes(Number(p.employee_id)) && day >= from && day <= to;
      }),
    getApprovedRegularizedPunchesForEmployees: async () => state.regularized || [],
    getApprovalStateForEmployees: async () => state.approvals || [],
    listPunchesByIds: async (ids) => {
      calls.punchesByIds = ids;
      if (state.punchLocationsThrow) throw new Error("punch read failed");
      return (state.rawPunches || [])
        .filter((p) => ids.includes(p.punch_id))
        .map((p) => ({
          punch_id: p.punch_id,
          employee_id: p.employee_id,
          punch_outlet_id: p.outlet_id === undefined ? 1 : p.outlet_id,
          punch_outlet_name: p.outlet_name === undefined ? "Moolakulam" : p.outlet_name,
          device_label: "G1",
          dev_id: p.dev_id,
        }));
    },
    listHistoricalPullsForDate: async () => state.pulls || [],
    listHistoricalPullsForRange: async () => state.pulls || [],
    listDeviceSyncHealth: async () => state.devices || [],
    listOutlets: async () => state.outlets || [{ outlet_id: 1, outlet_name: "Moolakulam" }],
    listDesignations: async () => [{ designation_id: 5, designation_name: "Cashier" }],
    listActiveWorkShifts: async () => CONFIGS,
  };
}

const build = (state) => {
  const repo = fakeRepo(state);
  return { repo, uc: buildStaffing(repo, buildDashboard(repo)) };
};

/* ========================================================= expected now */

describe("Expected Now comes from the duty interval", () => {
  const threeShifts = {
    employees: [employee(1), employee(2), employee(3)],
    assignments: [assign(1, 1), assign(2, 2), assign(3, 3)],
    rawPunches: [],
  };

  const expectedAt = async (hh, mm) => {
    const { uc } = build(threeShifts);
    const res = await uc.getSnapshot({ now: ist(DATE, hh, mm) });
    return res;
  };

  it("09:30 expects only the 9-9 employee", async () => {
    const res = await expectedAt(9, 30);
    assert.equal(res.expected_now, 1);
  });

  it("10:30 expects the 9-9 and the 10-10", async () => {
    assert.equal((await expectedAt(10, 30)).expected_now, 2);
  });

  it("14:30 expects all three", async () => {
    assert.equal((await expectedAt(14, 30)).expected_now, 3);
  });

  it("21:15 no longer expects the 9-9 employee, whose shift ended at 21:00", async () => {
    const res = await expectedAt(21, 15);
    assert.equal(res.expected_now, 2);
    assert.ok(!res.gap_detail.some((g) => g.employee_id === 1));
  });

  it("08:00, before anyone starts, expects nobody", async () => {
    assert.equal((await expectedAt(8, 0)).expected_now, 0);
  });

  it("exactly at the start the employee is expected; exactly at the end they are not", async () => {
    assert.equal((await expectedAt(9, 0)).expected_now, 1);
    const atNine = await expectedAt(21, 0);
    assert.ok(!atNine.gap_detail.some((g) => g.employee_id === 1));
  });

  it("a break allowance does not remove anybody from the expected headcount", async () => {
    // These shifts carry a 60-minute break; the interval is still 12 hours.
    const res = await expectedAt(13, 0);
    assert.equal(res.expected_now, 2, "nobody is subtracted for a lunch nobody scheduled");
  });

  it("the as-of time is the server's, in the business timezone", async () => {
    const res = await expectedAt(14, 30);
    assert.equal(res.as_of, `${DATE} 14:30`);
    assert.equal(res.business_date, DATE);
  });
});

describe("the duty interval is not the attendance day", () => {
  it("a 9-9 employee stops being expected at 21:00 though their day runs to 04:00", async () => {
    const { uc } = build({ employees: [employee(1)], assignments: [assign(1, 1)], rawPunches: [] });
    const res = await uc.getSnapshot({ now: ist(DATE, 23, 0) });
    assert.equal(res.expected_now, 0, "using the cutoff would keep them expected for hours");
  });

  it("a shift that began yesterday is on duty after midnight", async () => {
    const { uc } = build({
      employees: [employee(1)],
      assignments: [assign(1, 4)], // 22:00 - 06:00
      rawPunches: [],
    });
    const res = await uc.getSnapshot({ now: ist("2026-09-13", 1, 0) });
    assert.equal(res.expected_now, 1);
    assert.equal(res.gap_detail[0].attendance_date, DATE, "yesterday's shift, still running");
  });

  it("an overnight employee is not expected once their 06:00 finish passes", async () => {
    const { uc } = build({ employees: [employee(1)], assignments: [assign(1, 4)], rawPunches: [] });
    const res = await uc.getSnapshot({ now: ist("2026-09-13", 6, 30) });
    assert.equal(res.expected_now, 0);
  });
});

describe("an unresolvable shift is 'expectation unknown', never zero expected", () => {
  it("reports it separately with a reason", async () => {
    const { uc } = build({ employees: [employee(1)], assignments: [], rawPunches: [] });
    const res = await uc.getSnapshot({ now: ist(DATE, 12, 0) });
    assert.equal(res.expected_now, 0);
    assert.equal(res.unknown_expectation.length, 1);
    assert.match(res.unknown_expectation[0].reason, /No shift assigned/);
  });

  it("a missing schedule row is reported too", async () => {
    const { uc } = build({
      employees: [employee(1)],
      assignments: [assign(1, 1)],
      schedules: [],
      rawPunches: [],
    });
    const res = await uc.getSnapshot({ now: ist(DATE, 12, 0) });
    assert.equal(res.unknown_expectation.length, 1);
    assert.match(res.unknown_expectation[0].reason, /no schedule row/);
  });
});

/* ========================================================= recorded in */

describe("Recorded IN is the state as of now, not 'punched at some point'", () => {
  const oneNineToNine = (rawPunches) => ({
    employees: [employee(1)],
    assignments: [assign(1, 1)],
    rawPunches,
  });

  it("a single IN mid-shift is recorded IN - a normal day, not a missing OUT", async () => {
    const { uc } = build(oneNineToNine([punch(1, `${DATE} 09:05:00`, 1)]));
    const res = await uc.getSnapshot({ now: ist(DATE, 12, 0) });
    assert.equal(res.recorded_in, 1);
    assert.equal(res.gap, 0);
  });

  it("IN then OUT is recorded OUT, and becomes a gap", async () => {
    const { uc } = build(
      oneNineToNine([punch(1, `${DATE} 09:00:00`, 1), punch(1, `${DATE} 13:00:00`, 2)])
    );
    const res = await uc.getSnapshot({ now: ist(DATE, 14, 0) });
    assert.equal(res.recorded_in, 0);
    assert.equal(res.gap, 1);
    assert.equal(res.gap_by_class.find((c) => c.key === "RECORDED_OUT").count, 1);
    assert.match(res.gap_detail[0].explanation, /Recorded OUT — 60 minutes/);
  });

  it("IN, OUT, IN is recorded IN again", async () => {
    const { uc } = build(
      oneNineToNine([
        punch(1, `${DATE} 09:00:00`, 1),
        punch(1, `${DATE} 13:00:00`, 2),
        punch(1, `${DATE} 13:45:00`, 3),
      ])
    );
    const res = await uc.getSnapshot({ now: ist(DATE, 14, 0) });
    assert.equal(res.recorded_in, 1);
  });

  it("four punches with a later OUT is recorded OUT", async () => {
    const { uc } = build(
      oneNineToNine([
        punch(1, `${DATE} 09:00:00`, 1),
        punch(1, `${DATE} 13:00:00`, 2),
        punch(1, `${DATE} 13:45:00`, 3),
        punch(1, `${DATE} 20:00:00`, 4),
      ])
    );
    const res = await uc.getSnapshot({ now: ist(DATE, 20, 30) });
    assert.equal(res.recorded_in, 0);
    assert.equal(res.gap_by_class.find((c) => c.key === "RECORDED_OUT").count, 1);
  });

  it("the SAME day gives different answers at different snapshots", async () => {
    const state = oneNineToNine([
      punch(1, `${DATE} 09:00:00`, 1),
      punch(1, `${DATE} 20:00:00`, 2),
    ]);
    assert.equal((await build(state).uc.getSnapshot({ now: ist(DATE, 12, 0) })).recorded_in, 1);
    assert.equal((await build(state).uc.getSnapshot({ now: ist(DATE, 20, 30) })).recorded_in, 0);
  });

  it("a duplicate within ten minutes does not flip the state", async () => {
    // Two frames four minutes apart: the engine suppresses the second, so the
    // employee stays recorded IN rather than appearing to have left.
    const { uc } = build(
      oneNineToNine([punch(1, `${DATE} 09:00:00`, 1), punch(1, `${DATE} 09:04:00`, 2)])
    );
    const res = await uc.getSnapshot({ now: ist(DATE, 12, 0) });
    assert.equal(res.recorded_in, 1);
  });

  it("a voided punch does not count", async () => {
    const { uc } = build(
      oneNineToNine([
        punch(1, `${DATE} 09:00:00`, 1, { attendance_punch_void_id: 7, void_reason: "Wrong person" }),
      ])
    );
    const res = await uc.getSnapshot({ now: ist(DATE, 12, 0) });
    assert.equal(res.recorded_in, 0);
    assert.equal(res.gap_by_class.find((c) => c.key === "NO_CHECK_IN").count, 1);
  });

  it("an approved regularized punch counts, keeping its source", async () => {
    const { uc } = build({
      employees: [employee(1)],
      assignments: [assign(1, 1)],
      rawPunches: [],
      regularized: [
        {
          punch_id: 900,
          employee_id: 1,
          attendance_date: DATE,
          io_time: `${DATE} 09:00:00`,
          punch_source: "REGULARIZED",
        },
      ],
    });
    const res = await uc.getSnapshot({ now: ist(DATE, 12, 0) });
    assert.equal(res.recorded_in, 1);
  });
});

/* ============================================================== the gap */

describe("the gap is named honestly and reconciles", () => {
  it("no punch at all is 'no check-in received', with elapsed time", async () => {
    const { uc } = build({ employees: [employee(1)], assignments: [assign(1, 1)], rawPunches: [] });
    const res = await uc.getSnapshot({ now: ist(DATE, 9, 35) });
    assert.equal(res.gap, 1);
    assert.equal(res.gap_by_class.find((c) => c.key === "NO_CHECK_IN").count, 1);
    assert.match(res.gap_detail[0].explanation, /No check-in received — 35 minutes since shift start/);
  });

  it("never uses the word absent, and never calls an OUT a lunch", async () => {
    const { uc } = build({
      employees: [employee(1), employee(2)],
      assignments: [assign(1, 1), assign(2, 1)],
      rawPunches: [punch(2, `${DATE} 09:00:00`, 1), punch(2, `${DATE} 13:00:00`, 2)],
    });
    const res = await uc.getSnapshot({ now: ist(DATE, 14, 0) });
    const text = JSON.stringify(res);
    assert.doesNotMatch(text, /\babsent\b/i);
    assert.doesNotMatch(text, /lunch|unauthoris|unauthoriz|early departure|late\b/i);
  });

  it("expected = recorded IN + every gap class, always", async () => {
    const { uc } = build({
      employees: [employee(1), employee(2), employee(3), employee(4)],
      assignments: [assign(1, 1), assign(2, 1), assign(3, 1), assign(4, 1)],
      rawPunches: [
        // 1 covered, 2 out, 3 elsewhere, 4 nothing
        punch(1, `${DATE} 09:00:00`, 1),
        punch(2, `${DATE} 09:00:00`, 2),
        punch(2, `${DATE} 13:00:00`, 3),
        punch(3, `${DATE} 09:00:00`, 4, { outlet_id: 99, outlet_name: "Другой" }),
      ],
    });
    const res = await uc.getSnapshot({ now: ist(DATE, 14, 0) });
    assert.equal(res.expected_now, 4);
    assert.equal(res.reconciles, true);
    const gapSum = res.gap_by_class.reduce((a, c) => a + c.count, 0);
    assert.equal(res.recorded_in + gapSum, res.expected_now);
  });

  it("nobody is counted in two gap classes", async () => {
    const { uc } = build({
      employees: [employee(1)],
      assignments: [assign(1, 1)],
      rawPunches: [punch(1, `${DATE} 09:00:00`, 1, { outlet_id: 99, outlet_name: "Elsewhere" })],
    });
    const res = await uc.getSnapshot({ now: ist(DATE, 12, 0) });
    const nonZero = res.gap_by_class.filter((c) => c.count > 0);
    assert.equal(nonZero.length, 1);
    assert.equal(nonZero[0].key, "IN_ELSEWHERE");
  });

  it("an unmapped terminal does not invent a cross-location finding", async () => {
    const { uc } = build({
      employees: [employee(1)],
      assignments: [assign(1, 1)],
      rawPunches: [punch(1, `${DATE} 09:00:00`, 1, { outlet_id: null, outlet_name: null })],
    });
    const res = await uc.getSnapshot({ now: ist(DATE, 12, 0) });
    assert.equal(res.recorded_in, 1, "the STATE is known even when the PLACE is not");
    assert.equal(res.gap, 0);
  });

  it("a failed punch-location read leaves everyone covered rather than elsewhere", async () => {
    const { uc } = build({
      employees: [employee(1)],
      assignments: [assign(1, 1)],
      rawPunches: [punch(1, `${DATE} 09:00:00`, 1)],
      punchLocationsThrow: true,
    });
    const res = await uc.getSnapshot({ now: ist(DATE, 12, 0) });
    assert.equal(res.recorded_in, 1, "under-claim rather than manufacture a finding");
  });
});

/* ================================================== cross location (D) */

describe("cross-location attendance", () => {
  const state = {
    employees: [employee(1)],
    assignments: [assign(1, 1)],
    rawPunches: [punch(1, `${DATE} 09:00:00`, 1, { outlet_id: 2, outlet_name: "Warehouse" })],
  };

  it("leaves the schedule uncovered and flags it for verification", async () => {
    const { uc } = build(state);
    const res = await uc.getSnapshot({ now: ist(DATE, 12, 0) });
    assert.equal(res.recorded_in, 0, "somebody elsewhere does not cover this schedule");
    assert.equal(res.gap_by_class.find((c) => c.key === "IN_ELSEWHERE").count, 1);
    const x = res.additional.cross_location_arrivals[0];
    assert.equal(x.expected_outlet_name, "Moolakulam");
    assert.equal(x.recorded_outlet_name, "Warehouse");
    assert.equal(x.verification_needed, true);
  });

  it("does not duplicate staffing credit", async () => {
    const { uc } = build(state);
    const res = await uc.getSnapshot({ now: ist(DATE, 12, 0) });
    assert.equal(res.expected_now, 1);
    assert.equal(res.recorded_in + res.gap, 1, "the person is counted once, as a gap");
  });
});

/* ======================================== additional people recorded IN */

describe("additional people recorded IN are shown separately", () => {
  it("an early arrival is not counted as expected cover", async () => {
    const { uc } = build({
      employees: [employee(1)],
      assignments: [assign(1, 1)],
      rawPunches: [punch(1, `${DATE} 08:30:00`, 1)],
    });
    const res = await uc.getSnapshot({ now: ist(DATE, 8, 45) });
    assert.equal(res.expected_now, 0, "their shift has not started");
    assert.equal(res.additional.early.length, 1);
    assert.equal(res.additional.early[0].scheduled_start, "09:00");
  });

  it("still recorded IN after the shift is a follow-up item, not live presence", async () => {
    const { uc } = build({
      employees: [employee(1)],
      assignments: [assign(1, 1)],
      rawPunches: [punch(1, `${DATE} 09:00:00`, 1)],
    });
    const res = await uc.getSnapshot({ now: ist(DATE, 21, 30) });
    assert.equal(res.expected_now, 0, "their shift finished at 21:00");
    assert.equal(res.additional.no_active_shift.length, 1);
  });

  it("an extra person in one role does not hide a gap in another", async () => {
    const { uc } = build({
      employees: [
        employee(1, { designation_id: 5, designation_name: "Cashier" }),
        employee(2, { designation_id: 6, designation_name: "Packer" }),
      ],
      assignments: [assign(1, 1), assign(2, 1)],
      rawPunches: [punch(1, `${DATE} 09:00:00`, 1)],
    });
    const res = await uc.getSnapshot({ now: ist(DATE, 12, 0) });
    const cashier = res.coverage.find((c) => c.designation_name === "Cashier");
    const packer = res.coverage.find((c) => c.designation_name === "Packer");
    assert.equal(cashier.gap, 0);
    assert.equal(packer.gap, 1, "the packer gap stands on its own");
  });
});

/* ==================================== location x role coverage + filters */

describe("location and role coverage", () => {
  it("reports expected, recorded IN and gap per location and role", async () => {
    const { uc } = build({
      employees: [
        employee(1),
        employee(2),
        employee(3),
        employee(4, { store_id: 2, outlet_name: "Warehouse" }),
      ],
      assignments: [assign(1, 1), assign(2, 1), assign(3, 1), assign(4, 1)],
      rawPunches: [punch(1, `${DATE} 09:00:00`, 1), punch(2, `${DATE} 09:00:00`, 2)],
    });
    const res = await uc.getSnapshot({ now: ist(DATE, 12, 0) });
    const mool = res.coverage.find((c) => c.outlet_name === "Moolakulam");
    assert.equal(mool.expected_now, 3);
    assert.equal(mool.recorded_in, 2);
    assert.equal(mool.gap, 1);
    assert.equal(mool.designation_name, "Cashier");
    assert.equal(mool.reconciles, true);
  });

  it("uses real designation data and invents no groupings", async () => {
    const { uc } = build({
      employees: [employee(1, { designation_id: 9, designation_name: "Floor Staff" })],
      assignments: [assign(1, 1)],
      rawPunches: [],
    });
    const res = await uc.getSnapshot({ now: ist(DATE, 12, 0) });
    assert.equal(res.coverage[0].designation_name, "Floor Staff");
  });

  it("honours the location, role, shift and search filters", async () => {
    const state = {
      employees: [
        employee(1),
        employee(2, { store_id: 2, outlet_name: "Warehouse" }),
        employee(3, { designation_id: 6, designation_name: "Packer" }),
      ],
      assignments: [assign(1, 1), assign(2, 1), assign(3, 2)],
      rawPunches: [],
    };
    const now = ist(DATE, 12, 0);
    assert.equal((await build(state).uc.getSnapshot({ now })).expected_now, 3);
    assert.equal((await build(state).uc.getSnapshot({ store_ids: [2], now })).expected_now, 1);
    assert.equal((await build(state).uc.getSnapshot({ designation_id: 6, now })).expected_now, 1);
    assert.equal((await build(state).uc.getSnapshot({ work_shift_id: 2, now })).expected_now, 1);
    assert.equal((await build(state).uc.getSnapshot({ search: "Employee 2", now })).expected_now, 1);
  });

  it("an empty authorized scope reads nothing", async () => {
    const { uc, repo } = build({ employees: [employee(1)], assignments: [assign(1, 1)] });
    const res = await uc.getSnapshot({ store_ids: [], now: ist(DATE, 12, 0) });
    assert.equal(res.expected_now, 0);
    assert.equal(res.reason, "NO_SCOPE");
    assert.equal(repo.calls.population, undefined, "it never reaches the database");
  });
});

/* ============================================== next 60 minutes (panel B) */

describe("the next hour is a schedule outlook", () => {
  it("names the next transition, who finishes and what remains", async () => {
    const { uc } = build({
      employees: [employee(1), employee(2), employee(3)],
      assignments: [assign(1, 1), assign(2, 1), assign(3, 2)],
      rawPunches: [],
    });
    const res = await uc.getSnapshot({ now: ist(DATE, 20, 30) });
    assert.equal(res.next_hour.next_change_at, "21:00");
    const t = res.next_hour.transitions[0];
    assert.equal(t.finishing, 2);
    assert.equal(t.remaining, 1);
    assert.deepEqual(t.remaining_by_role, [{ role: "Cashier", count: 1 }]);
  });

  it("says nothing when no shift changes in the window", async () => {
    const { uc } = build({ employees: [employee(1)], assignments: [assign(1, 1)], rawPunches: [] });
    const res = await uc.getSnapshot({ now: ist(DATE, 12, 0) });
    assert.equal(res.next_hour.next_change_at, null);
    assert.deepEqual(res.next_hour.transitions, []);
  });

  it("never judges whether the remaining cover is enough", async () => {
    const { uc } = build({
      employees: [employee(1), employee(2)],
      assignments: [assign(1, 1), assign(2, 2)],
      rawPunches: [],
    });
    const res = await uc.getSnapshot({ now: ist(DATE, 20, 30) });
    const text = JSON.stringify(res.next_hour);
    assert.doesNotMatch(text, /insufficient|short|understaffed|required|target/i);
  });
});

/* ==================================================== delivery + safety */

describe("the snapshot never claims verified presence or delivery", () => {
  it("says recorded IN does not mean working or available", async () => {
    const { uc } = build({ employees: [employee(1)], assignments: [assign(1, 1)], rawPunches: [] });
    const res = await uc.getSnapshot({ now: ist(DATE, 12, 0) });
    assert.match(res.definitions.recorded_in, /does NOT mean actively working/i);
    assert.match(res.definitions.gap, /not absence/i);
    assert.match(res.definitions.delivery, /never 'confirmed'/i);
  });

  it("reports delivery as unverified, and a running pull as in progress", async () => {
    const clean = build({ employees: [employee(1)], assignments: [assign(1, 1)], rawPunches: [] });
    const res = await clean.uc.getSnapshot({ now: ist(DATE, 12, 0) });
    assert.equal(res.delivery[0].delivery, "UNVERIFIED");

    const pulling = build({
      employees: [employee(1)],
      assignments: [assign(1, 1)],
      rawPunches: [],
      pulls: [
        {
          biomax_historical_pull_id: 1,
          status: "RECEIVING",
          requested_from: `${DATE} 00:00:00`,
          requested_to: `${DATE} 23:59:59`,
          outlet_id: 1,
        },
      ],
    });
    const res2 = await pulling.uc.getSnapshot({ now: ist(DATE, 12, 0) });
    assert.equal(res2.delivery[0].delivery, "IN_PROGRESS");
  });

  it("exposes no salary, bank or identity field", async () => {
    const { uc } = build({
      employees: [employee(1)],
      assignments: [assign(1, 1)],
      rawPunches: [punch(1, `${DATE} 09:00:00`, 1)],
    });
    const res = await uc.getSnapshot({ now: ist(DATE, 12, 0) });
    const text = JSON.stringify(res);
    [/\bsalary\b/i, /\bbank\b/i, /\baadhaar\b/i, /\bpan\b/i, /\bifsc\b/i].forEach((re) =>
      assert.ok(!re.test(text), `the snapshot leaks ${re}`)
    );
  });

  it("an empty population is empty, not an error", async () => {
    const { uc } = build({ employees: [] });
    const res = await uc.getSnapshot({ now: ist(DATE, 12, 0) });
    assert.equal(res.expected_now, 0);
    assert.equal(res.reason, "NO_POPULATION");
    assert.equal(res.reconciles, true);
  });
});

/* ====================================== recurring coverage gaps (panel E) */

describe("recurring coverage gaps show their evidence", () => {
  // 2026-09-12 is a Saturday; the comparable days are the Saturdays before it.
  const SATURDAYS = ["2026-09-05", "2026-08-29", "2026-08-22", "2026-08-15"];
  const now = ist(DATE, 12, 0);

  it("reports a repeated shortfall with the dates and counts behind it", async () => {
    // Two cashiers rostered 9-9; only one is recorded IN on three Saturdays.
    const rawPunches = [];
    SATURDAYS.slice(0, 3).forEach((d, i) => {
      rawPunches.push(punch(1, `${d} 09:00:00`, 100 + i));
    });
    const { uc } = build({
      employees: [employee(1), employee(2)],
      assignments: [assign(1, 1), assign(2, 1)],
      rawPunches,
    });
    const res = await uc.getRecurringGaps({ now });
    assert.equal(res.available, true);
    assert.ok(res.patterns.length > 0, "a repeated shortfall is reported");

    const p = res.patterns[0];
    assert.equal(p.designation_name, "Cashier");
    assert.equal(p.outlet_name, "Moolakulam");
    assert.ok(p.days_short >= 2, "it repeats");
    assert.ok(p.observations.length > 0, "and the days are listed");
    p.observations.forEach((o) => {
      assert.match(o.attendance_date, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(Number.isInteger(o.expected));
      assert.ok(Number.isInteger(o.recorded));
    });
    assert.match(res.basis, /Same weekday/);
  });

  it("compares like with like: only the same weekday", async () => {
    const { uc } = build({ employees: [employee(1)], assignments: [assign(1, 1)], rawPunches: [] });
    const res = await uc.getRecurringGaps({ now });
    res.dates_examined.forEach((d) => {
      assert.ok(SATURDAYS.includes(d), `${d} is not a comparable Saturday`);
    });
  });

  it("reports nothing when the shortfall does not repeat", async () => {
    // Recorded IN on every comparable day but one.
    const rawPunches = [];
    SATURDAYS.forEach((d, i) => {
      if (i === 0) return;
      rawPunches.push(punch(1, `${d} 09:00:00`, 200 + i));
    });
    const { uc } = build({ employees: [employee(1)], assignments: [assign(1, 1)], rawPunches });
    const res = await uc.getRecurringGaps({ now });
    assert.equal(res.patterns.length, 0);
    assert.equal(res.reason, "NO_REPEATED_PATTERN");
  });

  it("excludes days whose punch retrieval was unfinished or failed", async () => {
    const { uc } = build({
      employees: [employee(1)],
      assignments: [assign(1, 1)],
      rawPunches: [],
      pulls: [
        {
          biomax_historical_pull_id: 1,
          status: "FAILED",
          requested_from: "2026-09-05 00:00:00",
          requested_to: "2026-09-05 23:59:59",
          outlet_id: 1,
        },
      ],
    });
    const res = await uc.getRecurringGaps({ now });
    assert.ok(!res.dates_examined.includes("2026-09-05"), "a failed retrieval is not evidence");
    assert.ok(res.dates_excluded.includes("2026-09-05"));
  });

  it("says so rather than scoring when no day is usable", async () => {
    const { uc } = build({
      employees: [employee(1)],
      assignments: [assign(1, 1)],
      rawPunches: [],
      pulls: [
        {
          biomax_historical_pull_id: 1,
          status: "RECEIVING",
          requested_from: "2026-01-01 00:00:00",
          requested_to: "2026-12-31 23:59:59",
          outlet_id: 1,
        },
      ],
    });
    const res = await uc.getRecurringGaps({ now });
    assert.equal(res.available, false);
    assert.equal(res.reason, "NO_UNDISTURBED_DAYS");
    assert.deepEqual(res.patterns, []);
  });

  it("always carries the limitation, and never claims the schedule was wrong", async () => {
    const { uc } = build({ employees: [employee(1)], assignments: [assign(1, 1)], rawPunches: [] });
    const res = await uc.getRecurringGaps({ now });
    assert.match(res.limitation, /against the SCHEDULE - not whether the schedule was adequate/i);
    assert.match(res.limitation, /may be a gap in the data/i);
    const text = JSON.stringify(res);
    assert.doesNotMatch(text, /understaffed|insufficient staff|should have/i);
  });

  it("an empty scope reads nothing", async () => {
    const { uc, repo } = build({ employees: [employee(1)], assignments: [assign(1, 1)] });
    const res = await uc.getRecurringGaps({ store_ids: [], now });
    assert.equal(res.available, false);
    assert.equal(res.reason, "NO_SCOPE");
    assert.equal(repo.calls.population, undefined);
  });
});
