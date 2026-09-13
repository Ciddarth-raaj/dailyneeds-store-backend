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
    /**
     * THE RANGE CANDIDATE QUERY the live snapshot uses.
     *
     * It answers "whose employment OVERLAPS this window", exactly as the real
     * SQL does - not resigned before it began, not joined after it ended - so a
     * yesterday-only employee and a tomorrow joiner both come back and the
     * usecase decides per date which of them belongs in which date's shift.
     */
    listApplicableEmployeesForRange: async (args) => {
      calls.populationRange = args;
      let rows = state.employees || [employee(1)];
      rows = rows.filter((r) => {
        if (r.resignation_date && r.resignation_date < args.from_date) return false;
        if (r.joined_on && r.joined_on > args.to_date) return false;
        return true;
      });
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
    listApplicableEmployees: async (args) => {
      calls.population = args;
      calls.populationDates = [...(calls.populationDates || []), args.attendance_date];
      // `employeesByDate` is how the per-date applicability tests express a
      // joiner or a leaver: the repository answers differently per date, exactly
      // as the real employment rule does.
      let rows =
        (state.employeesByDate && state.employeesByDate[args.attendance_date]) ||
        state.employees ||
        [employee(1)];
      // THE SAME TWO DATED FACTS THE REAL SQL APPLIES: not resigned before the
      // date, not joined after it. Without this the fake answers "everybody" to
      // every date, and a cross-date applicability test would pass whatever the
      // usecase did - which is no test at all.
      rows = rows.filter((r) => {
        if (r.resignation_date && r.resignation_date < args.attendance_date) return false;
        if (r.joined_on && r.joined_on > args.attendance_date) return false;
        return true;
      });
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
    listHistoricalPullsForRange: async () => {
      calls.pullRange = (calls.pullRange || 0) + 1;
      if (state.pullRangeThrows) throw new Error("pull status unreadable");
      return state.pulls || [];
    },
    listPendingApproversForRequests: async (ids) => {
      calls.approverRequests = ids;
      if (state.approversThrow) throw new Error("approver read failed");
      return (state.approvers || []).filter((a) =>
        ids.includes(Number(a.attendance_approval_request_id))
      );
    },
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
    assert.ok(!res.gap_preview.some((g) => g.employee_id === 1));
  });

  it("08:00, before anyone starts, expects nobody", async () => {
    assert.equal((await expectedAt(8, 0)).expected_now, 0);
  });

  it("exactly at the start the employee is expected; exactly at the end they are not", async () => {
    assert.equal((await expectedAt(9, 0)).expected_now, 1);
    const atNine = await expectedAt(21, 0);
    assert.ok(!atNine.gap_preview.some((g) => g.employee_id === 1));
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
    assert.equal(res.gap_preview[0].attendance_date, DATE, "yesterday's shift, still running");
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
    assert.match(res.gap_preview[0].explanation, /Recorded OUT — 60 minutes/);
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

  it("an approved regularized punch sets the STATE to IN, whatever it says about place", async () => {
    // The state half of the rule, on its own: an approved regularization is a
    // real recorded IN. What it is NOT is proof of a location - asserted in the
    // location suite below.
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
    assert.equal(res.expected_preview[0].recorded_state, "IN");
    assert.equal(res.expected_preview[0].recorded_since, "09:00");
    assert.equal(res.recorded_in_location_unverified, 1, "counted company-wide as recorded IN");
  });
});

/* ============================================================== the gap */

describe("the gap is named honestly and reconciles", () => {
  it("no punch at all is 'no check-in received', with elapsed time", async () => {
    const { uc } = build({ employees: [employee(1)], assignments: [assign(1, 1)], rawPunches: [] });
    const res = await uc.getSnapshot({ now: ist(DATE, 9, 35) });
    assert.equal(res.gap, 1);
    assert.equal(res.gap_by_class.find((c) => c.key === "NO_CHECK_IN").count, 1);
    assert.match(res.gap_preview[0].explanation, /No check-in received — 35 minutes since shift start/);
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

  it("AN UNMAPPED TERMINAL IS NOT COVERAGE OF THE SCHEDULED OUTLET", async () => {
    // The corrected rule. The STATE is known - this person's latest punch opened
    // a session - but WHERE is not, so Moolakulam's cover stays unverified. It is
    // not IN_ELSEWHERE either: unknown is not "somewhere else".
    const { uc } = build({
      employees: [employee(1)],
      assignments: [assign(1, 1)],
      rawPunches: [punch(1, `${DATE} 09:00:00`, 1, { outlet_id: null, outlet_name: null })],
    });
    const res = await uc.getSnapshot({ now: ist(DATE, 12, 0) });
    assert.equal(res.recorded_in, 0, "recorded IN AT THE EXPECTED LOCATION is 0");
    assert.equal(res.gap, 1);
    const named = res.gap_by_class.filter((c) => c.count > 0);
    assert.equal(named.length, 1);
    assert.equal(named[0].key, "IN_LOCATION_UNKNOWN");
    // And the person is still reported as recorded IN somewhere, company-wide,
    // allocated to no outlet.
    assert.equal(res.recorded_in_location_unverified, 1);
    assert.equal(res.additional.location_unverified_total, 1);
    assert.equal(res.additional.cross_location_arrivals.length, 0, "nobody was placed elsewhere");
  });

  it("the scheduled outlet's OWN row shows the gap, not silent cover", async () => {
    const { uc } = build({
      employees: [employee(1)],
      assignments: [assign(1, 1)],
      rawPunches: [punch(1, `${DATE} 09:00:00`, 1, { outlet_id: null, outlet_name: null })],
    });
    const res = await uc.getSnapshot({ now: ist(DATE, 12, 0) });
    const row = res.coverage[0];
    assert.equal(row.expected_now, 1);
    assert.equal(row.recorded_in, 0, "the outlet's gap was not reduced by an unknown place");
    assert.equal(row.recorded_in_location_unverified, 1);
    assert.equal(row.reconciles, true);
  });

  it("A FAILED PUNCH-LOCATION READ GIVES NO EXPECTED-LOCATION CREDIT", async () => {
    // The defect: the lookup's catch block swallowed the failure, so every IN
    // became coverage of its scheduled outlet on the strength of a query that
    // never answered. Failure now means the place is not established.
    const { uc } = build({
      employees: [employee(1)],
      assignments: [assign(1, 1)],
      rawPunches: [punch(1, `${DATE} 09:00:00`, 1)],
      punchLocationsThrow: true,
    });
    const res = await uc.getSnapshot({ now: ist(DATE, 12, 0) });
    assert.equal(res.recorded_in, 0);
    assert.equal(res.gap_by_class.find((c) => c.key === "IN_LOCATION_UNKNOWN").count, 1);
    assert.equal(res.punch_locations_available, false, "and the screen is told why");
  });

  it("an employee with NO OUTLET ON RECORD is a setup gap, not cover", async () => {
    const { uc } = build({
      employees: [{ ...employee(1), store_id: null, outlet_name: null }],
      assignments: [assign(1, 1)],
      rawPunches: [punch(1, `${DATE} 09:00:00`, 1)],
    });
    const res = await uc.getSnapshot({ now: ist(DATE, 12, 0) });
    assert.equal(res.recorded_in, 0);
    assert.equal(res.gap_by_class.find((c) => c.key === "EXPECTED_LOCATION_UNKNOWN").count, 1);
  });

  it("AN APPROVED REGULARIZATION DOES NOT PROVE A PLACE", async () => {
    // The corrected rule, replacing the shortcut that credited one to the
    // scheduled outlet. An approver accepted a TIME and a STATE for this
    // employee-date; nothing in that decision says which outlet the person
    // physically stood in, and no field in the data records one.
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
    assert.equal(res.recorded_in, 0, "not recorded IN AT THE EXPECTED LOCATION");
    assert.equal(res.gap, 1);
    assert.equal(res.gap_by_class.find((c) => c.key === "IN_LOCATION_UNKNOWN").count, 1);
    // The basis is still reported, because HOW the state arose is worth showing
    // even though it settles nothing about where.
    assert.equal(res.expected_preview[0].location_basis, "APPROVED_REGULARIZATION");
    assert.equal(res.expected_preview[0].location_known, false);
  });

  it("a regularization does NOT reduce the scheduled outlet's gap", async () => {
    const { uc } = build({
      employees: [employee(1), employee(2)],
      assignments: [assign(1, 1), assign(2, 1)],
      rawPunches: [punch(2, `${DATE} 09:00:00`, 1)],
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
    const row = res.coverage[0];
    assert.equal(row.expected_now, 2);
    assert.equal(row.recorded_in, 1, "only the device-mapped punch is cover of this outlet");
    assert.equal(row.gap, 1);
    assert.equal(row.recorded_in_location_unverified, 1);
    assert.equal(row.reconciles, true);
    assert.equal(res.reconciles, true, "and the headline still reconciles");
  });

  it("the regularized employee appears in the verification bucket of the drilldown", async () => {
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
    const now = ist(DATE, 12, 0);
    const bucket = await uc.getStaffingDrilldown({ bucket: "IN_LOCATION_UNKNOWN", now });
    assert.equal(bucket.total, 1);
    assert.equal(bucket.rows[0].employee_id, 1);
    const unverified = await uc.getStaffingDrilldown({
      bucket: "RECORDED_IN_LOCATION_UNVERIFIED",
      now,
    });
    assert.equal(unverified.total, 1);
    const covered = await uc.getStaffingDrilldown({
      bucket: "RECORDED_IN_EXPECTED_LOCATION",
      now,
    });
    assert.equal(covered.total, 0);
  });

  it("Needs Attention Now surfaces it as a verification item, not a fault", async () => {
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
    const item = res.attention_preview.find((a) => a.reason_key === "IN_LOCATION_UNKNOWN");
    assert.ok(item, "it is something to verify");
    assert.match(item.detail, /verification needed/i);
    assert.doesNotMatch(JSON.stringify(item), /absent|penalt|misconduct/i);
  });

  it("ONLY A DEVICE ESTABLISHES A PLACE - the whole matrix in one assertion", async () => {
    const { uc } = build({
      employees: [employee(1), employee(2), employee(3), employee(4)],
      assignments: [assign(1, 1), assign(2, 1), assign(3, 1), assign(4, 1)],
      rawPunches: [
        punch(1, `${DATE} 09:00:00`, 1), // device, mapped to outlet 1 = expected
        punch(2, `${DATE} 09:00:00`, 2, { outlet_id: 99, outlet_name: "Elsewhere" }),
        punch(3, `${DATE} 09:00:00`, 3, { outlet_id: null, outlet_name: null }),
      ],
      regularized: [
        {
          punch_id: 900,
          employee_id: 4,
          attendance_date: DATE,
          io_time: `${DATE} 09:00:00`,
          punch_source: "REGULARIZED",
        },
      ],
    });
    const res = await uc.getSnapshot({ now: ist(DATE, 12, 0) });
    const by = (id) => res.expected_preview.find((r) => r.employee_id === id).gap_class;
    assert.equal(by(1), "COVERED", "device, matching outlet");
    assert.equal(by(2), "IN_ELSEWHERE", "device, different outlet");
    assert.equal(by(3), "IN_LOCATION_UNKNOWN", "device, unmapped terminal");
    assert.equal(by(4), "IN_LOCATION_UNKNOWN", "regularization, no location at all");
    assert.equal(res.recorded_in, 1, "exactly one is cover of the expected location");
    assert.equal(res.reconciles, true);
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

/* ==================================================================== */
/* D1. THE NEXT 60 MINUTES - built from the whole relevant schedule.     */
/*                                                                      */
/* The defect: it was built from the Expected Now population only, so    */
/* anybody whose shift had not started yet was invisible - which is      */
/* precisely who a "next 60 minutes" view exists to show.                */
/* ==================================================================== */

describe("the next 60 minutes shows shifts that have not started yet", () => {
  const everyShift = {
    employees: [employee(1), employee(2), employee(3), employee(4)],
    assignments: [assign(1, 1), assign(2, 2), assign(3, 3), assign(4, 4)],
    rawPunches: [],
  };

  const at = async (hh, mm, state = everyShift, date = DATE) => {
    const { uc } = build(state);
    return uc.getSnapshot({ now: ist(date, hh, mm) });
  };

  it("09:30 -> 10:00, THE 10-10 STARTER, though it is not yet expected", async () => {
    const res = await at(9, 30);
    assert.equal(res.expected_now, 1, "only the 9-9 is on duty");
    assert.equal(res.next_hour.next_change_at, "10:00");
    const first = res.next_hour.transitions[0];
    assert.equal(first.starting, 1, "the 10-10 employee, absent from the old view");
    assert.equal(first.finishing, 0);
    assert.equal(first.remaining, 2, "the 9-9 plus the starter");
  });

  it("13:30 -> 14:00, the 2-10 starter", async () => {
    const res = await at(13, 30);
    assert.equal(res.next_hour.next_change_at, "14:00");
    assert.equal(res.next_hour.transitions[0].starting, 1);
    assert.equal(res.next_hour.transitions[0].remaining, 3);
  });

  it("20:30 -> 21:00, the 9-9 finisher", async () => {
    const res = await at(20, 30);
    assert.equal(res.next_hour.next_change_at, "21:00");
    assert.equal(res.next_hour.transitions[0].finishing, 1);
    assert.equal(res.next_hour.transitions[0].starting, 0);
    assert.equal(res.next_hour.transitions[0].remaining, 2, "the 10-10 and the 2-10");
  });

  it("21:30 -> 22:00, two finishers AND the night starter at the same minute", async () => {
    const res = await at(21, 30);
    assert.equal(res.next_hour.next_change_at, "22:00");
    const t = res.next_hour.transitions[0];
    assert.equal(t.finishing, 2, "the 10-10 and the 2-10 both end at 22:00");
    assert.equal(t.starting, 1, "and the night shift begins");
    assert.equal(t.remaining, 1, "only the night shift is rostered past 22:00");
  });

  it("carries a role AND a location breakdown for each transition", async () => {
    const res = await at(21, 30, {
      employees: [
        employee(1),
        employee(2, { designation_id: 6, designation_name: "Packer" }),
        employee(3, { store_id: 2, outlet_name: "Warehouse" }),
        employee(4),
      ],
      assignments: [assign(1, 1), assign(2, 2), assign(3, 3), assign(4, 4)],
      rawPunches: [],
    });
    const t = res.next_hour.transitions[0];
    assert.deepEqual(
      t.finishing_by_role.map((r) => r.role).sort(),
      ["Cashier", "Packer"],
      "the 10-10 Packer and the 2-10 Cashier"
    );
    assert.deepEqual(
      t.finishing_by_location.map((r) => r.location).sort(),
      ["Moolakulam", "Warehouse"]
    );
    assert.equal(t.starting_by_role[0].count, 1);
  });

  it("AN OVERNIGHT FINISH AFTER MIDNIGHT is found on the shared timeline", async () => {
    // 05:30 on the 13th. The shift began 22:00 on the 12th and ends 06:00 - a
    // transition half an hour away, on yesterday's attendance date. Comparing it
    // on today's axis is what the one-timeline conversion is for.
    const res = await at(5, 30, everyShift, "2026-09-13");
    assert.equal(res.expected_now, 1, "the night shift is still on duty");
    assert.equal(res.next_hour.next_change_at, "06:00");
    assert.equal(res.next_hour.transitions[0].finishing, 1);
    assert.equal(res.next_hour.transitions[0].remaining, 0);
  });

  it("A SHIFT STARTING JUST AFTER MIDNIGHT appears from the evening before", async () => {
    // 23:30. The next change is tomorrow's 09:00 start... unless somebody starts
    // sooner. With a 9-9 population the window is genuinely empty, and the view
    // says so rather than reporting a stale transition.
    const res = await at(23, 30, {
      employees: [employee(1)],
      assignments: [assign(1, 1)],
      rawPunches: [],
    });
    assert.equal(res.next_hour.next_change_at, null);
    assert.deepEqual(res.next_hour.transitions, []);
  });

  it("the window edge is inclusive at exactly +60 minutes", async () => {
    // 09:00 exactly: the 10-10 starts in exactly 60 minutes and is inside the
    // window; 08:59 would put it outside.
    const res = await at(9, 0);
    assert.equal(res.next_hour.next_change_at, "10:00");
    const before = await at(8, 59);
    assert.equal(before.next_hour.next_change_at, "09:00", "the 9-9's own start");
  });

  it("reports the window it used, and never judges whether cover is enough", async () => {
    const res = await at(20, 30);
    assert.equal(res.next_hour.window_minutes, 60);
    const text = JSON.stringify(res.next_hour);
    assert.doesNotMatch(text, /short|insufficient|required|understaff|need\b|enough/i);
  });

  it("respects the effective shift filter", async () => {
    const res = await at(9, 30, {
      ...everyShift,
    });
    assert.equal(res.next_hour.transitions[0].starting, 1);

    const { uc } = build(everyShift);
    const filtered = await uc.getSnapshot({ now: ist(DATE, 9, 30), work_shift_id: 1 });
    assert.equal(
      filtered.next_hour.next_change_at,
      null,
      "with only the 9-9 in view nothing changes before 21:00, which is outside the window"
    );
    assert.equal(filtered.next_hour.transitions.length, 0);
  });
});

/* ==================================================================== */
/* D3. SESSION SELECTION across yesterday and today, end to end.         */
/* ==================================================================== */

describe("the session that describes an employee now, across midnight", () => {
  const nightStaff = {
    employees: [employee(1)],
    assignments: [assign(1, 4)], // 22:00 -> 06:00, cutoff 04:00
  };
  const dayStaff = { employees: [employee(1)], assignments: [assign(1, 1)] };

  it("YESTERDAY'S COMPLETED DAY DOES NOT SPEAK FOR TODAY", async () => {
    // IN 09:00 and OUT 21:00 yesterday, nothing today, 14:00 now. The employee
    // is on duty (9-9) and has no punch in today's session, so the answer is
    // NO_CHECK_IN - not "recorded OUT" carried over from a finished day.
    const { uc } = build({
      ...dayStaff,
      rawPunches: [
        punch(1, "2026-09-12 09:00:00", 1),
        punch(1, "2026-09-12 21:00:00", 2),
      ],
    });
    const res = await uc.getSnapshot({ now: ist("2026-09-13", 14, 0) });
    assert.equal(res.expected_now, 1);
    assert.equal(res.gap_by_class.find((c) => c.key === "NO_CHECK_IN").count, 1);
    assert.equal(res.gap_by_class.find((c) => c.key === "RECORDED_OUT").count, 0);
  });

  it("AN UNMATCHED IN FROM A CLOSED SESSION IS NOT CARRIED FORWARD", async () => {
    // A single IN at 09:00 yesterday with no OUT. Yesterday's session closed at
    // 04:00 this morning. At 14:00 today this employee must not read as IN - the
    // exact defect. It is a missing punch on a closed day, reported as such.
    const { uc } = build({
      ...dayStaff,
      rawPunches: [punch(1, "2026-09-12 09:00:00", 1)],
    });
    const res = await uc.getSnapshot({ now: ist("2026-09-13", 14, 0) });
    assert.equal(res.recorded_in, 0, "not recorded IN today on yesterday's evidence");
    assert.equal(res.gap_by_class.find((c) => c.key === "NO_CHECK_IN").count, 1);
    const missing = res.attention_preview.filter((a) => a.reason_key === "MISSING_PUNCH");
    assert.equal(missing.length, 1, "and the odd count on the closed day is surfaced");
    assert.equal(missing[0].attendance_date, "2026-09-12");
  });

  it("TODAY'S NEWER OUT BEATS YESTERDAY'S IN", async () => {
    const { uc } = build({
      ...dayStaff,
      rawPunches: [
        punch(1, "2026-09-12 09:00:00", 1), // yesterday's unmatched IN
        punch(1, "2026-09-13 09:00:00", 2),
        punch(1, "2026-09-13 13:00:00", 3), // today: IN then OUT
      ],
    });
    const res = await uc.getSnapshot({ now: ist("2026-09-13", 14, 0) });
    assert.equal(res.gap_by_class.find((c) => c.key === "RECORDED_OUT").count, 1);
    assert.equal(res.recorded_in, 0);
  });

  it("an overnight shift still running after midnight reads its OWN session", async () => {
    // 01:30 on the 13th, IN at 22:00 on the 12th. On duty, recorded IN, and the
    // session is yesterday's - by duty, not by recency.
    const { uc } = build({
      ...nightStaff,
      rawPunches: [punch(1, "2026-09-12 22:00:00", 1)],
    });
    const res = await uc.getSnapshot({ now: ist("2026-09-13", 1, 30) });
    assert.equal(res.expected_now, 1);
    assert.equal(res.recorded_in, 1);
    assert.equal(res.expected_preview[0].attendance_date, "2026-09-12");
    assert.equal(res.expected_preview[0].session_date, "2026-09-12");
  });

  it("punches split across midnight stay in the session that owns them", async () => {
    // IN 22:00 on the 12th, OUT 00:30 on the 13th - which the cutoff gives to the
    // 12th. At 01:00 the pair reads OUT, from one session.
    const { uc } = build({
      ...nightStaff,
      rawPunches: [
        punch(1, "2026-09-12 22:00:00", 1),
        punch(1, "2026-09-13 00:30:00", 2),
      ],
    });
    const res = await uc.getSnapshot({ now: ist("2026-09-13", 1, 0) });
    assert.equal(res.expected_now, 1, "still on duty until 06:00");
    assert.equal(res.gap_by_class.find((c) => c.key === "RECORDED_OUT").count, 1);
  });

  it("an early arrival before today's shift uses TODAY'S session", async () => {
    // 08:30, punched IN at 08:20 today, and a complete day yesterday. Not on
    // duty yet, so this is an early arrival - read from today, not yesterday.
    const { uc } = build({
      ...dayStaff,
      rawPunches: [
        punch(1, "2026-09-12 09:00:00", 1),
        punch(1, "2026-09-12 21:00:00", 2),
        punch(1, "2026-09-13 08:20:00", 3),
      ],
    });
    const res = await uc.getSnapshot({ now: ist("2026-09-13", 8, 30) });
    assert.equal(res.expected_now, 0);
    assert.equal(res.additional.early.length, 1);
    assert.equal(res.additional.early[0].recorded_since, "08:20");
    assert.equal(res.additional.early[0].session_date, "2026-09-13");
    assert.equal(res.additional.no_active_shift.length, 0);
  });

  it("a delayed punch inside the open window is still attributed to its session", async () => {
    // 03:00 on the 13th. A 02:50 punch is before the 04:00 cutoff, so it belongs
    // to the 12th and closes the night session that started at 22:00.
    const { uc } = build({
      ...nightStaff,
      rawPunches: [
        punch(1, "2026-09-12 22:00:00", 1),
        punch(1, "2026-09-13 02:50:00", 2),
      ],
    });
    const res = await uc.getSnapshot({ now: ist("2026-09-13", 3, 0) });
    assert.equal(res.gap_by_class.find((c) => c.key === "RECORDED_OUT").count, 1);
    assert.equal(res.expected_preview[0].recorded_since, "02:50");
  });

  it("no punch anywhere is NO_CHECK_IN, never Indeterminate", async () => {
    const { uc } = build({ ...dayStaff, rawPunches: [] });
    const res = await uc.getSnapshot({ now: ist("2026-09-13", 14, 0) });
    assert.equal(res.gap_by_class.find((c) => c.key === "NO_CHECK_IN").count, 1);
    assert.equal(res.gap_by_class.find((c) => c.key === "INDETERMINATE").count, 0);
  });
});

/* ==================================================================== */
/* D5. THE DRILLDOWN - the count and the list are one computation.        */
/* ==================================================================== */

describe("the staffing drilldown pages the real population", () => {
  /** 250 employees, all 9-9 at Moolakulam; the first `withPunch` are recorded IN. */
  const manyPeople = (total, withPunch) => ({
    employees: Array.from({ length: total }, (_, i) => employee(i + 1)),
    assignments: Array.from({ length: total }, (_, i) => assign(i + 1, 1)),
    rawPunches: Array.from({ length: withPunch }, (_, i) =>
      punch(i + 1, `${DATE} 09:00:00`, 1000 + i)
    ),
  });

  it("THE HEADLINE COUNT EQUALS THE DRILLDOWN TOTAL above 200 employees", async () => {
    // The defect: the snapshot's own list was sliced at 200, so a screen built
    // from it showed 200 rows under a card reading 250.
    const { uc } = build(manyPeople(250, 150));
    const now = ist(DATE, 12, 0);
    const snap = await uc.getSnapshot({ now });
    assert.equal(snap.expected_now, 250);

    const expected = await uc.getStaffingDrilldown({ bucket: "EXPECTED", limit: 50, now });
    assert.equal(expected.total, 250, "the total is the population, not the page");

    const gap = await uc.getStaffingDrilldown({ bucket: "GAP", limit: 50, now });
    assert.equal(gap.total, snap.gap);
    assert.equal(gap.total, 100);

    const covered = await uc.getStaffingDrilldown({
      bucket: "RECORDED_IN_EXPECTED_LOCATION",
      limit: 50,
      now,
    });
    assert.equal(covered.total, snap.recorded_in);
    assert.equal(covered.total + gap.total, expected.total, "and they still reconcile");
  });

  it("the snapshot's own lists are named as PREVIEWS and say they are cut", async () => {
    const { uc } = build(manyPeople(250, 150));
    const snap = await uc.getSnapshot({ now: ist(DATE, 12, 0) });
    assert.equal(snap.expected_preview.length, snap.preview_limit);
    assert.equal(snap.expected_preview_truncated, true);
    assert.equal(snap.gap_preview_truncated, true);
    assert.equal(snap.expected_detail, undefined, "the silently-truncated field is gone");
    assert.equal(snap.gap_detail, undefined);
  });

  it("pages without repeating or dropping anybody", async () => {
    const { uc } = build(manyPeople(250, 150));
    const now = ist(DATE, 12, 0);
    const page = (offset) =>
      uc.getStaffingDrilldown({ bucket: "EXPECTED", limit: 100, offset, now });

    const [p1, p2, p3] = [await page(0), await page(100), await page(200)];
    assert.equal(p1.rows.length, 100);
    assert.equal(p2.rows.length, 100);
    assert.equal(p3.rows.length, 50);
    assert.equal(p1.has_more, true);
    assert.equal(p3.has_more, false);

    const ids = [...p1.rows, ...p2.rows, ...p3.rows].map((r) => r.employee_id);
    assert.equal(ids.length, 250);
    assert.equal(new Set(ids).size, 250, "no duplicate across pages");
    assert.deepEqual(
      [...new Set(ids)].sort((a, b) => a - b),
      Array.from({ length: 250 }, (_, i) => i + 1),
      "and nobody dropped"
    );
  });

  it("keeps its filters across pages, and reports them back", async () => {
    const state = manyPeople(60, 0);
    state.employees = state.employees.map((e, i) =>
      i < 20 ? { ...e, designation_id: 6, designation_name: "Packer" } : e
    );
    const { uc } = build(state);
    const now = ist(DATE, 12, 0);
    const page = (offset) =>
      uc.getStaffingDrilldown({ bucket: "EXPECTED", designation_id: 6, limit: 15, offset, now });

    const p1 = await page(0);
    const p2 = await page(15);
    assert.equal(p1.total, 20, "the filter applies to the total too");
    assert.equal(p2.total, 20);
    assert.equal(p2.rows.length, 5);
    assert.equal(p1.applied_filters.designation_id, 6);
    assert.ok([...p1.rows, ...p2.rows].every((r) => r.designation_name === "Packer"));
  });

  it("serves every gap reason as its own bucket, summing to the gap", async () => {
    const { uc } = build({
      employees: [employee(1), employee(2), employee(3), employee(4)],
      assignments: [assign(1, 1), assign(2, 1), assign(3, 1), assign(4, 1)],
      rawPunches: [
        punch(2, `${DATE} 09:00:00`, 1),
        punch(2, `${DATE} 13:00:00`, 2), // OUT
        punch(3, `${DATE} 09:00:00`, 3, { outlet_id: 99, outlet_name: "Elsewhere" }),
        punch(4, `${DATE} 09:00:00`, 4, { outlet_id: null, outlet_name: null }),
      ],
    });
    const now = ist(DATE, 14, 0);
    const total = async (bucket) => (await uc.getStaffingDrilldown({ bucket, now })).total;
    assert.equal(await total("NO_CHECK_IN"), 1);
    assert.equal(await total("RECORDED_OUT"), 1);
    assert.equal(await total("IN_ELSEWHERE"), 1);
    assert.equal(await total("IN_LOCATION_UNKNOWN"), 1);
    assert.equal(await total("GAP"), 4);
    assert.equal(await total("RECORDED_IN_LOCATION_UNVERIFIED"), 2, "elsewhere + unknown place");
  });

  it("narrows a bucket further by gap_class when asked", async () => {
    const { uc } = build({
      employees: [employee(1), employee(2)],
      assignments: [assign(1, 1), assign(2, 1)],
      rawPunches: [punch(2, `${DATE} 09:00:00`, 1), punch(2, `${DATE} 13:00:00`, 2)],
    });
    const res = await uc.getStaffingDrilldown({
      bucket: "GAP",
      gap_class: "RECORDED_OUT",
      now: ist(DATE, 14, 0),
    });
    assert.equal(res.total, 1);
    assert.equal(res.rows[0].employee_id, 2);
  });

  it("returns its OWN as_of and does not pretend to be the card's", async () => {
    const { uc } = build(manyPeople(5, 0));
    const res = await uc.getStaffingDrilldown({ bucket: "EXPECTED", now: ist(DATE, 12, 34) });
    assert.equal(res.as_of, `${DATE} 12:34`);
    assert.match(res.note, /new observation/i);
  });

  it("refuses a bucket it does not know, rather than answering something else", async () => {
    const { uc } = build(manyPeople(5, 0));
    await assert.rejects(() => uc.getStaffingDrilldown({ bucket: "EVERYBODY" }), /bucket/);
    await assert.rejects(
      () => uc.getStaffingDrilldown({ bucket: "GAP", gap_class: "MADE_UP" }),
      /gap_class/
    );
  });

  it("A REQUESTED LOCATION CANNOT WIDEN THE CALLER'S SCOPE", async () => {
    const { uc } = build({
      employees: [employee(1), employee(2, { store_id: 2, outlet_name: "Warehouse" })],
      assignments: [assign(1, 1), assign(2, 1)],
      rawPunches: [],
    });
    const now = ist(DATE, 12, 0);

    // A caller scoped to outlet 1 asking for outlet 2 gets nothing - not outlet 2.
    const outside = await uc.getStaffingDrilldown({
      bucket: "EXPECTED",
      store_ids: [1],
      store_id: 2,
      now,
    });
    assert.equal(outside.total, 0);
    assert.deepEqual(outside.applied_filters.store_ids, []);

    const inside = await uc.getStaffingDrilldown({
      bucket: "EXPECTED",
      store_ids: [1],
      store_id: 1,
      now,
    });
    assert.equal(inside.total, 1);
    assert.equal(inside.rows[0].store_id, 1);
  });

  it("an empty authorized scope reads nothing at any offset", async () => {
    const { uc } = build(manyPeople(10, 0));
    const res = await uc.getStaffingDrilldown({ bucket: "EXPECTED", store_ids: [], now: ist(DATE, 12, 0) });
    assert.equal(res.total, 0);
    assert.deepEqual(res.rows, []);
    assert.equal(res.reason, "NO_SCOPE");
  });

  it("caps the page size rather than letting a caller ask for everything", async () => {
    const { uc } = build(manyPeople(250, 0));
    const res = await uc.getStaffingDrilldown({ bucket: "EXPECTED", limit: 5000, now: ist(DATE, 12, 0) });
    assert.equal(res.limit, 200);
    assert.equal(res.rows.length, 200);
    assert.equal(res.total, 250);
  });
});

/* ==================================================================== */
/* D6. NEEDS ATTENTION NOW - existing states, existing screens.           */
/* ==================================================================== */

describe("needs attention now", () => {
  const now = ist(DATE, 14, 0);

  it("lists a no-check-in after shift start, with its elapsed time", async () => {
    const { uc } = build({
      employees: [employee(1)],
      assignments: [assign(1, 1)],
      rawPunches: [],
    });
    const res = await uc.getSnapshot({ now });
    const item = res.attention_preview.find((a) => a.reason_key === "NO_CHECK_IN");
    assert.ok(item);
    assert.equal(item.employee_name, "Employee 1");
    assert.equal(item.outlet_name, "Moolakulam");
    assert.equal(item.designation_name, "Cashier");
    assert.equal(item.age_minutes, 300, "09:00 to 14:00");
    assert.equal(item.target, "ATTENDANCE_DETAIL");
    assert.equal(item.owner_name, null, "the system names nobody for this, so nobody is named");
  });

  it("lists a shift-setup fault FIRST, since nothing can be judged without it", async () => {
    const { uc } = build({
      employees: [employee(1), employee(2)],
      assignments: [assign(1, 1)], // employee 2 has no assignment at all
      rawPunches: [],
    });
    const res = await uc.getSnapshot({ now });
    assert.equal(res.attention_preview[0].reason_key, "SHIFT_SETUP");
    assert.equal(res.attention_preview[0].employee_id, 2);
    assert.equal(res.attention_preview[0].target, "SHIFT_ASSIGNMENT");
  });

  it("lists a cross-location IN and an unestablished punch location separately", async () => {
    const { uc } = build({
      employees: [employee(1), employee(2)],
      assignments: [assign(1, 1), assign(2, 1)],
      rawPunches: [
        punch(1, `${DATE} 09:00:00`, 1, { outlet_id: 99, outlet_name: "Warehouse" }),
        punch(2, `${DATE} 09:00:00`, 2, { outlet_id: null, outlet_name: null }),
      ],
    });
    const res = await uc.getSnapshot({ now });
    const keys = res.attention_preview.map((a) => a.reason_key);
    assert.ok(keys.includes("IN_ELSEWHERE"));
    assert.ok(keys.includes("IN_LOCATION_UNKNOWN"));
  });

  it("NAMES THE APPROVER THE SYSTEM ITSELF NAMES for a waiting regularization", async () => {
    const { uc, repo } = build({
      employees: [employee(1)],
      assignments: [assign(1, 1)],
      rawPunches: [],
      approvals: [
        {
          attendance_approval_request_id: 77,
          employee_id: 1,
          attendance_date: DATE,
          request_type: "REGULARIZATION",
          status: "PENDING",
          current_stage_no: 1,
          total_stages: 2,
          finalization_state: null,
          created_at: `${DATE} 10:00:00`,
        },
      ],
      approvers: [
        {
          attendance_approval_request_id: 77,
          created_at: `${DATE} 10:00:00`,
          stage_no: 1,
          approver_employee_id: 42,
          approver_name: "Store Manager",
        },
      ],
    });
    const res = await uc.getSnapshot({ now });
    const item = res.attention_preview.find((a) => a.reason_key === "REGULARIZATION_PENDING");
    assert.ok(item, "the waiting request is listed");
    assert.equal(item.owner_name, "Store Manager");
    assert.equal(item.age_minutes, 240, "10:00 to 14:00");
    assert.equal(item.target, "APPROVAL_QUEUE");
    assert.deepEqual(repo.calls.approverRequests, [77]);
  });

  it("shows a waiting item with NO owner rather than guessing one", async () => {
    // A role-based approval step names no employee. The item still appears.
    const { uc } = build({
      employees: [employee(1)],
      assignments: [assign(1, 1)],
      rawPunches: [],
      approvals: [
        {
          attendance_approval_request_id: 78,
          employee_id: 1,
          attendance_date: DATE,
          request_type: "REGULARIZATION",
          status: "PENDING",
          current_stage_no: 1,
          total_stages: 1,
          finalization_state: null,
          created_at: `${DATE} 11:00:00`,
        },
      ],
      approvers: [
        {
          attendance_approval_request_id: 78,
          created_at: `${DATE} 11:00:00`,
          stage_no: 1,
          approver_employee_id: null,
          approver_name: null,
        },
      ],
    });
    const res = await uc.getSnapshot({ now });
    const item = res.attention_preview.find((a) => a.reason_key === "REGULARIZATION_PENDING");
    assert.ok(item);
    assert.equal(item.owner_name, null);
    assert.equal(item.age_minutes, 180);
  });

  it("an approver read that FAILS loses the name, never the item", async () => {
    const { uc } = build({
      employees: [employee(1)],
      assignments: [assign(1, 1)],
      rawPunches: [],
      approvals: [
        {
          attendance_approval_request_id: 79,
          employee_id: 1,
          attendance_date: DATE,
          request_type: "REGULARIZATION",
          status: "PENDING",
          current_stage_no: 1,
          total_stages: 1,
          finalization_state: null,
          created_at: `${DATE} 11:00:00`,
        },
      ],
      approversThrow: true,
    });
    const res = await uc.getSnapshot({ now });
    const item = res.attention_preview.find((a) => a.reason_key === "REGULARIZATION_PENDING");
    assert.ok(item, "the task is still surfaced");
    assert.equal(item.owner_name, null);
  });

  it("lists a pending OT claim, which is never an attendance issue", async () => {
    const { uc } = build({
      employees: [employee(1)],
      assignments: [assign(1, 1)],
      rawPunches: [punch(1, `${DATE} 09:00:00`, 1)],
      approvals: [
        {
          attendance_approval_request_id: 80,
          employee_id: 1,
          attendance_date: DATE,
          request_type: "OT",
          status: "PENDING",
          current_stage_no: 1,
          total_stages: 1,
          candidate_ot_minutes: 60,
          finalization_state: null,
          created_at: `${DATE} 12:00:00`,
        },
      ],
      approvers: [
        {
          attendance_approval_request_id: 80,
          created_at: `${DATE} 12:00:00`,
          stage_no: 1,
          approver_employee_id: 9,
          approver_name: "Ops Head",
        },
      ],
    });
    const res = await uc.getSnapshot({ now });
    const item = res.attention_preview.find((a) => a.reason_key === "OT_PENDING");
    assert.ok(item);
    assert.equal(item.owner_name, "Ops Head");
    assert.equal(item.target, "OT_APPROVAL_QUEUE");
  });

  it("WITHHOLDS MISSING PUNCH WHILE THE DAY IS STILL OPEN", async () => {
    // A single IN at 09:00 during a running 9-9 shift is somebody at work.
    const { uc } = build({
      employees: [employee(1)],
      assignments: [assign(1, 1)],
      rawPunches: [punch(1, `${DATE} 09:00:00`, 1)],
    });
    const res = await uc.getSnapshot({ now });
    assert.equal(res.attention_preview.filter((a) => a.reason_key === "MISSING_PUNCH").length, 0);
  });

  it("approves, rejects and regularizes NOTHING - it only points at screens", async () => {
    const { uc } = build({ employees: [employee(1)], assignments: [assign(1, 1)], rawPunches: [] });
    const res = await uc.getSnapshot({ now });
    const targets = new Set(res.attention_preview.map((a) => a.target));
    [...targets].forEach((t) =>
      assert.ok(
        ["ATTENDANCE_DETAIL", "APPROVAL_QUEUE", "OT_APPROVAL_QUEUE", "SHIFT_ASSIGNMENT"].includes(t),
        t
      )
    );
    const text = JSON.stringify(res.attention_preview);
    assert.doesNotMatch(text, /approve|reject|regulariz.*now|penalt/i);
  });

  it("carries no payroll-readiness item, because no readiness state exists to read", async () => {
    const { uc } = build({ employees: [employee(1)], assignments: [assign(1, 1)], rawPunches: [] });
    const res = await uc.getSnapshot({ now });
    assert.doesNotMatch(JSON.stringify(res.attention_preview), /payroll|salary|readiness/i);
  });

  it("is previewed on the snapshot and paged through the drilldown like any bucket", async () => {
    const many = {
      employees: Array.from({ length: 40 }, (_, i) => employee(i + 1)),
      assignments: Array.from({ length: 40 }, (_, i) => assign(i + 1, 1)),
      rawPunches: [],
    };
    const { uc } = build(many);
    const res = await uc.getSnapshot({ now });
    assert.equal(res.attention_total, 40);
    assert.equal(res.attention_preview.length, res.preview_limit);
    assert.equal(res.attention_preview_truncated, true);

    const paged = await uc.getStaffingDrilldown({ bucket: "NEEDS_ATTENTION", limit: 40, now });
    assert.equal(paged.total, 40);
    assert.equal(paged.rows.length, 40);
  });
});

/* ==================================================================== */
/* D4. RECURRING COVERAGE GAPS - per-date population, one instant,       */
/*     evidence that fails closed.                                       */
/* ==================================================================== */

describe("recurring coverage gaps: the population is resolved per date", () => {
  // Today is Saturday 2026-09-12; the comparable Saturdays are the 5th, the
  // 29th of August, the 22nd and the 15th.
  const now = ist(DATE, 14, 0);
  const SATURDAYS = ["2026-09-05", "2026-08-29", "2026-08-22", "2026-08-15"];

  it("asks the repository for EVERY comparison date, not just the newest", async () => {
    const { uc, repo } = build({
      employees: [employee(1)],
      assignments: [assign(1, 1)],
      rawPunches: [],
    });
    await uc.getRecurringGaps({ now });
    SATURDAYS.forEach((d) =>
      assert.ok(repo.calls.populationDates.includes(d), `${d} was resolved on its own`)
    );
  });

  it("A MID-WINDOW JOINER IS NOT EXPECTED ON DAYS BEFORE THEY JOINED", async () => {
    // Employee 2 exists only from 2026-09-05. The defect resolved the population
    // once, for the newest date, and reused it - so employee 2 was counted as
    // expected on August Saturdays and short on every one of them.
    const joiner = employee(2);
    const { uc } = build({
      employeesByDate: {
        "2026-09-05": [employee(1), joiner],
        "2026-08-29": [employee(1)],
        "2026-08-22": [employee(1)],
        "2026-08-15": [employee(1)],
      },
      assignments: [assign(1, 1), assign(2, 1)],
      rawPunches: [],
    });
    const res = await uc.getRecurringGaps({ now });
    const band = res.patterns.find((p) => p.band_from === "10:00");
    assert.ok(band, "the 10:00-12:00 band covers a 9-9 shift's midpoint");
    const sept5 = band.observations.find((o) => o.attendance_date === "2026-09-05");
    const aug29 = band.observations.find((o) => o.attendance_date === "2026-08-29");
    assert.equal(sept5.expected, 2, "both, on the date the joiner was applicable");
    assert.equal(aug29.expected, 1, "and only one before that");
  });

  it("A MID-WINDOW LEAVER IS NOT EXPECTED AFTER THEY LEFT", async () => {
    const { uc } = build({
      employeesByDate: {
        "2026-09-05": [employee(1)],
        "2026-08-29": [employee(1)],
        "2026-08-22": [employee(1), employee(3)],
        "2026-08-15": [employee(1), employee(3)],
      },
      assignments: [assign(1, 1), assign(3, 1)],
      rawPunches: [],
    });
    const res = await uc.getRecurringGaps({ now });
    const band = res.patterns.find((p) => p.band_from === "10:00");
    assert.equal(band.observations.find((o) => o.attendance_date === "2026-08-22").expected, 2);
    assert.equal(band.observations.find((o) => o.attendance_date === "2026-09-05").expected, 1);
  });
});

describe("recurring coverage gaps: expectation and observation at ONE instant", () => {
  const now = ist(DATE, 14, 0);

  it("AN EMPLOYEE STARTING HALFWAY THROUGH A BAND IS NOT EXPECTED AT ITS MIDPOINT", async () => {
    // The defect, stated as a test. A 10-10 employee overlaps the 08:00-10:00
    // band, and the band is judged at its 09:00 midpoint - half an hour before
    // they start. They must not be in the denominator, and their absence at
    // 09:00 must not be a shortfall.
    const { uc } = build({
      employees: [employee(2)],
      assignments: [assign(2, 2)], // 10-10
      rawPunches: [],
    });
    const res = await uc.getRecurringGaps({ now });
    const early = res.patterns.find((p) => p.band_from === "08:00");
    assert.equal(early, undefined, "no 08:00 band at all - nobody is on duty at 09:00");
    const own = res.patterns.find((p) => p.band_from === "10:00");
    assert.ok(own, "their own band, whose 11:00 midpoint their shift does contain");
  });

  it("an employee finishing halfway through a band is not expected at its midpoint", async () => {
    // A 2-10 shift ends at 22:00. The 22:00-00:00 band's midpoint is 23:00.
    const { uc } = build({
      employees: [employee(3)],
      assignments: [assign(3, 3)],
      rawPunches: [],
    });
    const res = await uc.getRecurringGaps({ now });
    assert.equal(res.patterns.find((p) => p.band_from === "22:00"), undefined);
    assert.ok(res.patterns.find((p) => p.band_from === "20:00"), "21:00 is inside their shift");
  });

  it("counts an overnight shift's small hours on the date that OWNS them", async () => {
    // 22:00 -> 06:00. The 00:00-02:00 band's 01:00 midpoint is minute 1500 of the
    // attendance date, which the interval contains, so it is observed there and
    // labelled by the clock time it happened at.
    const { uc } = build({
      employees: [employee(4)],
      assignments: [assign(4, 4)],
      rawPunches: [],
    });
    const res = await uc.getRecurringGaps({ now });
    const small = res.patterns.find((p) => p.band_from === "00:00");
    assert.ok(small, "the small hours are attributed, not dropped");
    assert.equal(small.band_to, "02:00");
    assert.ok(res.patterns.find((p) => p.band_from === "22:00"), "and so is the evening half");
  });

  it("a shortfall is recorded only when the SAME midpoint shows fewer recorded", async () => {
    // Employee 1 is 9-9 and punched IN at 09:00 on two of the four Saturdays, so
    // the 10:00-12:00 band (midpoint 11:00) is short on the other two.
    const { uc } = build({
      employees: [employee(1)],
      assignments: [assign(1, 1)],
      rawPunches: [
        punch(1, "2026-09-05 09:00:00", 1),
        punch(1, "2026-08-29 09:00:00", 2),
      ],
    });
    const res = await uc.getRecurringGaps({ now });
    const band = res.patterns.find((p) => p.band_from === "10:00");
    assert.equal(band.days_examined, 4);
    assert.equal(band.days_short, 2);
    band.observations.forEach((o) => assert.equal(o.expected, 1));
  });

  it("respects the role, location and effective-shift filters", async () => {
    const state = {
      employees: [employee(1), employee(2, { store_id: 2, outlet_name: "Warehouse" })],
      assignments: [assign(1, 1), assign(2, 2)],
      rawPunches: [],
    };
    const { uc } = build(state);
    const byShift = await uc.getRecurringGaps({ now, work_shift_id: 2 });
    assert.ok(byShift.patterns.length > 0);
    assert.ok(
      byShift.patterns.every((p) => p.outlet_name === "Warehouse"),
      "only the 10-10 employee's rows survive the shift filter"
    );
    assert.equal(byShift.applied_filters.work_shift_id, 2);

    const byStore = await uc.getRecurringGaps({ now, store_ids: [1] });
    assert.ok(byStore.patterns.every((p) => p.store_id === 1));
  });
});

describe("recurring coverage gaps: the evidence fails closed", () => {
  const now = ist(DATE, 14, 0);
  const base = { employees: [employee(1)], assignments: [assign(1, 1)], rawPunches: [] };

  it("A FAILED PULL EXCLUDES THE DATE IT COVERS", async () => {
    const { uc } = build({
      ...base,
      pulls: [{ status: "FAILED", requested_from: "2026-09-05", requested_to: "2026-09-05" }],
    });
    const res = await uc.getRecurringGaps({ now });
    assert.ok(!res.dates_examined.includes("2026-09-05"));
    assert.ok(res.dates_excluded.includes("2026-09-05"));
    assert.equal(res.dates_examined.length, 3);
  });

  it("AN OPEN PULL EXCLUDES ITS DATE TOO", async () => {
    const { uc } = build({
      ...base,
      pulls: [{ status: "IN_PROGRESS", requested_from: "2026-08-29", requested_to: "2026-08-29" }],
    });
    const res = await uc.getRecurringGaps({ now });
    assert.ok(res.dates_excluded.includes("2026-08-29"));
    assert.ok(!res.dates_examined.includes("2026-08-29"));
  });

  it("PULL STATUS THAT CANNOT BE READ MAKES THE PANEL UNAVAILABLE, not optimistic", async () => {
    // The defect swallowed the error and carried on as though every date were
    // clean, which is the one reading the data cannot support.
    const { uc, repo } = build({ ...base, pullRangeThrows: true });
    const res = await uc.getRecurringGaps({ now });
    assert.equal(res.available, false);
    assert.equal(res.reason, "PULL_STATUS_UNREADABLE");
    assert.deepEqual(res.patterns, []);
    assert.equal(repo.calls.populationDates, undefined, "and it does not even read the population");
  });

  it("every date excluded means nothing is reported", async () => {
    const { uc } = build({
      ...base,
      pulls: [{ status: "FAILED", requested_from: "2026-01-01", requested_to: "2026-12-31" }],
    });
    const res = await uc.getRecurringGaps({ now });
    assert.equal(res.available, false);
    assert.equal(res.reason, "NO_UNDISTURBED_DAYS");
  });

  it("states its basis, its limitation, and the rejoin caveat", async () => {
    const { uc } = build(base);
    const res = await uc.getRecurringGaps({ now });
    assert.match(res.basis, /its own applicable employees/i);
    assert.match(res.basis, /ON DUTY at that same midpoint/i);
    assert.match(res.limitation, /punch delivery completeness cannot be verified/i);
    assert.match(res.limitation, /Rejoin history is not reconstructed/i);
    assert.doesNotMatch(res.limitation, /performance score/i);
    assert.match(res.limitation, /not any employee's performance/i);
  });
});

/* ==================================================================== */
/* CROSS-DATE APPLICABILITY.                                            */
/*                                                                      */
/* The candidate population is the RANGE previousDate -> nextDate, and   */
/* applicability is then decided PER DATE. The defect this replaces      */
/* loaded only employees applicable on the business date, so a valid     */
/* shift belonging to another attendance date could never be found.      */
/* ==================================================================== */

describe("employees are resolved per date, not once for the business date", () => {
  const SEP12 = "2026-09-12";
  const SEP13 = "2026-09-13";
  const SEP14 = "2026-09-14";

  it("asks for the whole window, previous through next", async () => {
    const { uc, repo } = build({
      employees: [employee(1)],
      assignments: [assign(1, 1)],
      rawPunches: [],
    });
    await uc.getSnapshot({ now: ist(SEP13, 14, 0) });
    assert.deepEqual(
      { from: repo.calls.populationRange.from_date, to: repo.calls.populationRange.to_date },
      { from: SEP12, to: SEP14 }
    );
  });

  it("AN OVERNIGHT EMPLOYEE WHOSE EMPLOYMENT ENDED YESTERDAY IS STILL EXPECTED NOW", async () => {
    // Employment ends 12 Sep. Their 22:00-06:00 shift is DATED 12 Sep and at
    // 01:00 on the 13th it is two hours in. The duty interval is live, and the
    // date it belongs to is one they were employed on - so they are on duty.
    // The old population query, asking only about the 13th, lost them entirely.
    const { uc } = build({
      employees: [employee(1, { resignation_date: SEP12 })],
      assignments: [assign(1, 4)], // 22:00 -> 06:00
      rawPunches: [punch(1, `${SEP12} 22:00:00`, 1)],
    });
    const res = await uc.getSnapshot({ now: ist(SEP13, 1, 0) });
    assert.equal(res.expected_now, 1);
    assert.equal(res.expected_preview[0].attendance_date, SEP12, "yesterday's shift");
    assert.equal(res.recorded_in, 1);
  });

  it("and stops being expected the moment that duty interval ends", async () => {
    const { uc } = build({
      employees: [employee(1, { resignation_date: SEP12 })],
      assignments: [assign(1, 4)],
      rawPunches: [],
    });
    // 06:30 on the 13th: the 06:00 finish has passed.
    const res = await uc.getSnapshot({ now: ist(SEP13, 6, 30) });
    assert.equal(res.expected_now, 0);
    // And they are NOT reported as a shift-setup fault for a day they were not
    // employed on - having no shift today is not a missing shift.
    assert.equal(res.unknown_expectation_total, 0);
    assert.equal(res.attention_total, 0);
  });

  it("A TOMORROW JOINER APPEARS IN THE NEXT 60 MINUTES, after midnight", async () => {
    // 23:40 on the 13th. The employee joins on the 14th; their first shift
    // starts at 00:15 that day - thirty-five minutes away. The old population,
    // scoped to the 13th, never considered them.
    const { uc } = build({
      employees: [employee(1, { joined_on: SEP14 })],
      assignments: [assign(1, 5)], // 00:15 -> 08:15
      configs: [...CONFIGS, shiftConfig(5, "00:15-08:15")],
      schedules: [...SCHEDULES, ...scheduleRows(5, "00:15:00", 8)],
      rawPunches: [],
    });
    const res = await uc.getSnapshot({ now: ist(SEP13, 23, 40) });
    assert.equal(res.expected_now, 0, "they have not joined yet and are not on duty");
    assert.equal(res.next_hour.next_change_at, "00:15");
    assert.equal(res.next_hour.transitions[0].starting, 1);
    assert.equal(res.next_hour.transitions[0].remaining, 1);
  });

  it("but a tomorrow joiner is NOT counted today, before their joining date", async () => {
    const { uc } = build({
      employees: [employee(1, { joined_on: SEP14 })],
      assignments: [assign(1, 1)], // an ordinary 9-9
      rawPunches: [],
    });
    const res = await uc.getSnapshot({ now: ist(SEP13, 14, 0) });
    assert.equal(res.expected_now, 0, "not employed on the 13th");
    assert.equal(res.unknown_expectation_total, 0, "and not a setup fault either");
  });

  it("an employee joining TODAY is counted from today", async () => {
    const { uc } = build({
      employees: [employee(1, { joined_on: SEP13 })],
      assignments: [assign(1, 1)],
      rawPunches: [],
    });
    assert.equal((await uc.getSnapshot({ now: ist(SEP13, 14, 0) })).expected_now, 1);
    assert.equal((await uc.getSnapshot({ now: ist(SEP12, 14, 0) })).expected_now, 0);
  });

  it("an employee resigned BEFORE the relevant attendance date is excluded", async () => {
    const { uc } = build({
      employees: [employee(1, { resignation_date: "2026-09-11" })],
      assignments: [assign(1, 1)],
      rawPunches: [],
    });
    const res = await uc.getSnapshot({ now: ist(SEP13, 14, 0) });
    assert.equal(res.expected_now, 0);
  });

  it("an employee resigning ON the date follows the existing single-date boundary", async () => {
    // `resignation_date >= date` is applicable, the same direction the SQL and
    // the trend use. The last day is worked, not lost.
    const { uc } = build({
      employees: [employee(1, { resignation_date: SEP13 })],
      assignments: [assign(1, 1)],
      rawPunches: [],
    });
    assert.equal((await uc.getSnapshot({ now: ist(SEP13, 14, 0) })).expected_now, 1);
  });

  it("being inside the range puts nobody in a date they were not employed on", async () => {
    // Two employees returned by one range query; each belongs to one date only.
    const { uc } = build({
      employees: [
        employee(1, { resignation_date: SEP12 }),
        employee(2, { joined_on: SEP14 }),
      ],
      assignments: [assign(1, 1), assign(2, 1)],
      rawPunches: [],
    });
    const res = await uc.getSnapshot({ now: ist(SEP13, 14, 0) });
    assert.equal(res.expected_now, 0, "neither is employed on the 13th");
    assert.equal(res.unknown_expectation_total, 0);
  });

  it("THE LOCATION SCOPE STILL APPLIES to the range query", async () => {
    const { uc, repo } = build({
      employees: [
        employee(1),
        employee(2, { store_id: 2, outlet_name: "Warehouse", resignation_date: SEP12 }),
      ],
      assignments: [assign(1, 1), assign(2, 4)],
      rawPunches: [],
    });
    const res = await uc.getSnapshot({ store_ids: [1], now: ist(SEP13, 1, 0) });
    assert.deepEqual(repo.calls.populationRange.store_ids, [1]);
    // The warehouse employee's overnight shift is live at 01:00, and a caller
    // scoped to outlet 1 must not see them or their outlet's name anywhere.
    assert.doesNotMatch(JSON.stringify(res), /Warehouse/);
    assert.ok(res.coverage.every((c) => c.store_id === 1));
  });

  it("an empty authorized scope still reads nothing across the range", async () => {
    const { uc } = build({
      employees: [employee(1)],
      assignments: [assign(1, 1)],
      rawPunches: [],
    });
    const res = await uc.getSnapshot({ store_ids: [], now: ist(SEP13, 14, 0) });
    assert.equal(res.reason, "NO_SCOPE");
    assert.equal(res.expected_now, 0);
  });

  it("the shift, designation and search filters still apply", async () => {
    const state = {
      employees: [employee(1), employee(2, { designation_id: 6, designation_name: "Packer" })],
      assignments: [assign(1, 1), assign(2, 2)],
      rawPunches: [],
    };
    const { uc } = build(state);
    const now = ist(SEP13, 14, 0);
    assert.equal((await uc.getSnapshot({ now, work_shift_id: 1 })).expected_now, 1);
    assert.equal((await uc.getSnapshot({ now, designation_id: 6 })).expected_now, 1);
    assert.equal((await uc.getSnapshot({ now, search: "Employee 2" })).expected_now, 1);
    assert.equal((await uc.getSnapshot({ now })).expected_now, 2);
  });

  it("the drilldown totals agree with the cards across the date boundary", async () => {
    const { uc } = build({
      employees: [employee(1, { resignation_date: SEP12 }), employee(2)],
      assignments: [assign(1, 4), assign(2, 4)],
      rawPunches: [punch(1, `${SEP12} 22:00:00`, 1)],
    });
    const now = ist(SEP13, 1, 0);
    const snap = await uc.getSnapshot({ now });
    assert.equal(snap.expected_now, 2, "both are inside yesterday's overnight interval");
    const expected = await uc.getStaffingDrilldown({ bucket: "EXPECTED", now });
    const gap = await uc.getStaffingDrilldown({ bucket: "GAP", now });
    const covered = await uc.getStaffingDrilldown({
      bucket: "RECORDED_IN_EXPECTED_LOCATION",
      now,
    });
    assert.equal(expected.total, snap.expected_now);
    assert.equal(gap.total, snap.gap);
    assert.equal(covered.total, snap.recorded_in);
    assert.equal(covered.total + gap.total, expected.total);
  });

  it("uses the SHARED applicability rule rather than one of its own", async () => {
    // Not a behaviour assertion but an architecture one: a second copy of the
    // joining/resignation rule is how the live view and the trend begin to
    // disagree about who was employed when.
    const repo = fakeRepo({ employees: [employee(1)], assignments: [assign(1, 1)] });
    const dashboard = buildDashboard(repo);
    assert.equal(typeof dashboard.applicableOn, "function");
    assert.equal(dashboard.applicableOn({ joined_on: SEP14 }, SEP13), false);
    assert.equal(dashboard.applicableOn({ joined_on: SEP13 }, SEP13), true);
    assert.equal(dashboard.applicableOn({ resignation_date: SEP12 }, SEP13), false);
    assert.equal(dashboard.applicableOn({ resignation_date: SEP13 }, SEP13), true);
    assert.equal(dashboard.applicableOn({}, SEP13), true, "unreadable dates leave it unbounded");
  });
});
