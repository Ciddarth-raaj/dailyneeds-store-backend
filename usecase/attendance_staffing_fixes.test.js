/**
 * THE THREE DASHBOARD FIXES, as regressions.
 *
 *   node --test usecase/attendance_staffing_fixes.test.js
 *
 * One file per fault, so a failure names the fault rather than the file:
 *
 *   1. NEEDS ATTENTION NOW IS GROUPED STORE-WISE. A flat list across eight
 *      branches is not a work list, and the counts must still add up.
 *   2. AN EMPLOYEE WHO WORKS ACROSS ALL OUTLETS CREATES NO OUTLET'S GAP.
 *      Their shift is nobody's branch to cover, and their ordinary visit to
 *      another branch is not a cross-location arrival needing verification.
 *   3. TODAY CANNOT SHOW "MISSING PUNCH". Somebody who has punched IN and not
 *      yet OUT has an odd punch count, and at one in the afternoon that is a
 *      person at work - not a broken attendance record.
 *
 * `now` is pinned in every test, in IST, because a snapshot whose answers
 * depend on the hour the suite runs is one nobody can test. The harness is the
 * one `usecase/attendance_staffing.test.js` uses.
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


/* ================================================================ 1. groups */

describe("Needs attention now is grouped store-wise", () => {
  /**
   * Four people at three different outlets, an hour into a shift none of them
   * punched for. Every one of them is a NO_CHECK_IN item, which is what makes
   * the grouping the only thing under test.
   */
  const fourOutlets = {
    employees: [
      employee(1, { store_id: 1, outlet_name: "Vallalar Salai" }),
      employee(2, { store_id: 1, outlet_name: "Vallalar Salai" }),
      employee(3, { store_id: 2, outlet_name: "Kathirkamam" }),
      employee(4, { store_id: 3, outlet_name: "Muthialpet" }),
    ],
    assignments: [assign(1, 1), assign(2, 1), assign(3, 1), assign(4, 1)],
    rawPunches: [],
  };

  const snapshotAtTen = () => build(fourOutlets).uc.getSnapshot({ now: ist(DATE, 10, 0) });

  it("returns one group per outlet, each with its own heading and count", async () => {
    const res = await snapshotAtTen();
    const byName = new Map(res.attention_groups.map((g) => [g.outlet_name, g]));
    assert.deepEqual(
      res.attention_groups.map((g) => g.outlet_name),
      ["Kathirkamam", "Muthialpet", "Vallalar Salai"],
      "outlets read in name order"
    );
    assert.equal(byName.get("Vallalar Salai").count, 2);
    assert.equal(byName.get("Kathirkamam").count, 1);
    assert.equal(byName.get("Muthialpet").count, 1);
  });

  it("carries the outlet id on the group, so a heading is not matched by its words", async () => {
    const res = await snapshotAtTen();
    const vallalar = res.attention_groups.find((g) => g.outlet_name === "Vallalar Salai");
    assert.equal(vallalar.store_id, 1);
  });

  /**
   * THE COUNTS MUST ADD UP. A grouped list whose groups do not sum to the
   * total it is shown beside is worse than no grouping: it looks authoritative
   * and is wrong, and the reader has no way to tell which figure to believe.
   */
  it("the group counts sum to exactly the rows that travelled", async () => {
    const res = await snapshotAtTen();
    const summed = res.attention_groups.reduce((a, g) => a + g.count, 0);
    assert.equal(summed, res.attention_preview.length);
    assert.equal(summed, res.attention_total, "nothing was truncated in this fixture");
  });

  it("puts every employee in exactly one group and drops none", async () => {
    const res = await snapshotAtTen();
    const ids = res.attention_groups.flatMap((g) => g.items.map((i) => i.employee_id));
    assert.deepEqual([...ids].sort(), [1, 2, 3, 4], "everybody, once");
    assert.equal(new Set(ids).size, ids.length, "nobody is in two groups");
  });

  it("keeps the flat preview as well, so nothing that read it before breaks", async () => {
    const res = await snapshotAtTen();
    assert.equal(res.attention_preview.length, 4);
  });

  /**
   * THE FILTERS STILL FILTER, and they filter the POPULATION - in SQL, long
   * before anything is grouped. So a store filter yields the groups for that
   * store and no others, and grouping can never widen what a viewer sees.
   */
  it("an outlet filter leaves exactly that outlet's group", async () => {
    const { uc } = build(fourOutlets);
    const res = await uc.getSnapshot({ store_ids: [2], now: ist(DATE, 10, 0) });
    assert.deepEqual(res.attention_groups.map((g) => g.outlet_name), ["Kathirkamam"]);
    assert.equal(res.attention_groups[0].count, 1);
  });

  it("a search narrows the groups to the people it matched", async () => {
    const { uc } = build(fourOutlets);
    const res = await uc.getSnapshot({ search: "Employee 3", now: ist(DATE, 10, 0) });
    assert.deepEqual(res.attention_groups.map((g) => g.outlet_name), ["Kathirkamam"]);
    assert.deepEqual(res.attention_groups[0].items.map((i) => i.employee_id), [3]);
  });

  it("an employee with no outlet on record gets a named group rather than vanishing", async () => {
    const { uc } = build({
      employees: [employee(1, { store_id: null, outlet_name: null, outlet_nickname: null })],
      assignments: [assign(1, 1)],
      rawPunches: [],
    });
    const res = await uc.getSnapshot({ now: ist(DATE, 10, 0) });
    assert.deepEqual(res.attention_groups.map((g) => g.outlet_name), ["No outlet on record"]);
    assert.equal(res.attention_groups[0].store_id, null);
  });
});

/* =============================================================== 2. roaming */

describe("an employee who works across all outlets creates no outlet's gap", () => {
  /**
   * TWO PEOPLE AT THE WAREHOUSE. One is an ordinary warehouse employee; the
   * other's duty is the whole chain. Nothing about the second is expressed by
   * their name or their designation - both carry the same designation here on
   * purpose, so a rule that keyed off the title would fail this test.
   */
  const warehouse = (over = {}) => ({
    store_id: 9,
    outlet_name: "Warehouse",
    designation_id: 5,
    designation_name: "Cashier",
    ...over,
  });
  const pair = {
    employees: [
      employee(1, warehouse()),
      employee(2, warehouse({ works_all_locations: 1 })),
    ],
    assignments: [assign(1, 1), assign(2, 1)],
    rawPunches: [],
  };

  it("does not count the roaming employee into Expected Now", async () => {
    const { uc } = build(pair);
    const res = await uc.getSnapshot({ now: ist(DATE, 10, 0) });
    assert.equal(res.expected_now, 1, "only the warehouse's own employee");
    assert.equal(res.gap, 1);
  });

  it("does not count them into the warehouse's coverage row", async () => {
    const { uc } = build(pair);
    const res = await uc.getSnapshot({ now: ist(DATE, 10, 0) });
    const row = res.coverage.find((c) => Number(c.store_id) === 9);
    assert.equal(row.expected_now, 1);
    assert.equal(row.gap, 1, "the gap is the one person the warehouse is actually short");
  });

  it("reports them separately, under their own name, rather than hiding them", async () => {
    const { uc } = build(pair);
    const res = await uc.getSnapshot({ now: ist(DATE, 10, 0) });
    assert.equal(res.roaming.total, 1);
    assert.equal(res.roaming.expected_now, 1);
    assert.equal(res.roaming.label, "All Locations / Roaming");
    assert.deepEqual(res.roaming.preview.map((r) => r.employee_id), [2]);
  });

  it("still keeps their owning branch on the row, because scope reads it", async () => {
    const { uc } = build(pair);
    const res = await uc.getSnapshot({ now: ist(DATE, 10, 0) });
    assert.equal(res.roaming.preview[0].store_id, 9, "store_id is the owning branch, not an expectation");
    const scoped = await uc.getSnapshot({ store_ids: [9], now: ist(DATE, 10, 0) });
    assert.equal(scoped.roaming.total, 1, "a warehouse manager still sees their own person");
  });

  /**
   * THE CROSS-LOCATION FAULT, which is the visible half of the same bug. A
   * chain-wide employee punching in at a branch is doing their job; the fixed
   * classifier calls that "recorded IN elsewhere - verification needed" every
   * single day.
   */
  it("a punch at another outlet is ordinary cover, not a cross-location arrival", async () => {
    const { uc } = build({
      ...pair,
      rawPunches: [
        punch(2, `${DATE} 09:05:00`, 21, { outlet_id: 3, outlet_name: "Muthialpet" }),
      ],
    });
    const res = await uc.getSnapshot({ now: ist(DATE, 10, 0) });
    assert.equal(res.roaming.gap, 0, "recorded IN anywhere is recorded IN for them");
    assert.equal(res.roaming.recorded_in, 1);
    assert.equal(res.additional.cross_location_total, 0, "no verification is needed");
    assert.equal(res.gap, 1, "and the warehouse's own gap is untouched");
  });

  it("they are still chased when they have not punched at all", async () => {
    const { uc } = build(pair);
    const res = await uc.getSnapshot({ now: ist(DATE, 10, 0) });
    const roamingGroup = res.attention_groups.find((g) => g.works_all_locations);
    assert.ok(roamingGroup, "a roaming employee with no check-in is somebody's problem");
    assert.equal(roamingGroup.outlet_name, "All Locations / Roaming");
    assert.equal(roamingGroup.store_id, null, "the group is not an outlet");
    assert.deepEqual(roamingGroup.items.map((i) => i.employee_id), [2]);
  });

  it("the roaming heading reads last, after every real outlet", async () => {
    const { uc } = build(pair);
    const res = await uc.getSnapshot({ now: ist(DATE, 10, 0) });
    assert.equal(res.attention_groups[res.attention_groups.length - 1].works_all_locations, true);
  });

  it("an unmarked employee is unaffected, whatever their designation", async () => {
    const { uc } = build({
      employees: [employee(1, warehouse({ designation_name: "Operations Manager" }))],
      assignments: [assign(1, 1)],
      rawPunches: [],
    });
    const res = await uc.getSnapshot({ now: ist(DATE, 10, 0) });
    assert.equal(res.expected_now, 1, "the title decides nothing; only the flag does");
    assert.equal(res.roaming.total, 0);
  });

  /**
   * THE FILTER MUST NOT UNDO THE FLAG.
   *
   * The outlet filter is applied to the POPULATION in SQL, on `store_id` -
   * which a roaming employee still has, because it is the branch that owns
   * their record. So selecting the Warehouse legitimately LOADS them. What
   * must not then happen is the narrowed view quietly putting them back into
   * that outlet's Expected and Gap, which is the same fault the flag exists to
   * remove, reachable by a different route.
   */
  it("an outlet filter loads the roaming employee but still counts them nowhere", async () => {
    const { uc } = build(pair);
    const res = await uc.getSnapshot({ store_ids: [9], now: ist(DATE, 10, 0) });
    assert.equal(res.expected_now, 1, "only the warehouse's own employee");
    assert.equal(res.gap, 1);
    assert.equal(res.roaming.total, 1, "and they are still visible, apart");
    const row = res.coverage.find((c) => Number(c.store_id) === 9);
    assert.equal(row.expected_now, 1);
    assert.equal(row.gap, 1);
  });

  it("every coverage row sums to Expected Now, with the roaming employee in none of them", async () => {
    const { uc } = build({
      employees: [
        employee(1, warehouse()),
        employee(2, warehouse({ works_all_locations: 1 })),
        employee(3, { store_id: 1, outlet_name: "Vallalar Salai" }),
      ],
      assignments: [assign(1, 1), assign(2, 1), assign(3, 1)],
      rawPunches: [],
    });
    const res = await uc.getSnapshot({ now: ist(DATE, 10, 0) });
    const summed = res.coverage.reduce((a, c) => a + c.expected_now, 0);
    assert.equal(summed, res.expected_now, "the grid explains exactly the headline");
    assert.equal(res.expected_now, 2, "and the roaming employee is in neither");
    assert.equal(res.roaming.expected_now, 1);
  });

  /**
   * A DESIGNATION FILTER IS THE OTHER ROUTE IN, and it behaves the same way:
   * it narrows who is loaded and decides nothing about where they are counted.
   */
  it("a designation filter does not count them into an outlet either", async () => {
    const { uc } = build(pair);
    const res = await uc.getSnapshot({ designation_id: 5, now: ist(DATE, 10, 0) });
    assert.equal(res.expected_now, 1);
    assert.equal(res.roaming.total, 1);
  });

  /**
   * THE EXPECTED-NOW DRILLDOWN is the list a manager opens FROM the card, so
   * it must name the same people the card counted and no others.
   */
  it("the Expected Now drilldown does not list the roaming employee", async () => {
    const { uc } = build(pair);
    const res = await uc.getStaffingDrilldown({
      bucket: "EXPECTED",
      store_ids: [9],
      now: ist(DATE, 10, 0),
    });
    assert.equal(res.total, 1);
    assert.deepEqual(res.rows.map((r) => r.employee_id), [1]);
  });

  it("nor does the Gap drilldown", async () => {
    const { uc } = build(pair);
    const res = await uc.getStaffingDrilldown({
      bucket: "GAP",
      store_ids: [9],
      now: ist(DATE, 10, 0),
    });
    assert.deepEqual(res.rows.map((r) => r.employee_id), [1]);
  });

  it("the roaming drilldown bucket pages the same rows", async () => {
    const { uc } = build(pair);
    const res = await uc.getStaffingDrilldown({ bucket: "ROAMING", now: ist(DATE, 10, 0) });
    assert.equal(res.total, 1);
    assert.deepEqual(res.rows.map((r) => r.employee_id), [2]);
  });
});

/* ========================================================= 3. missing punch */

describe("today cannot show Missing Punch while the day is still running", () => {
  /**
   * THE SCREENSHOT, REPRODUCED. 09:00 shift, punched IN at 09:02 and not out.
   * One punch is an odd count and the engine calls that MISSING_PUNCH, because
   * from its point of view the pair is incomplete. At 13:08 that person is
   * standing at the counter.
   */
  const inNotOut = {
    employees: [employee(1)],
    assignments: [assign(1, 1)],
    rawPunches: [punch(1, `${DATE} 09:02:00`, 11)],
  };

  it("does not label an open IN/OUT sequence a Missing Punch at 13:08", async () => {
    const { uc } = build(inNotOut);
    const res = await uc.getSnapshot({ now: ist(DATE, 13, 8) });
    const missing = res.attention_preview.filter((i) => i.reason_key === "MISSING_PUNCH");
    assert.deepEqual(missing, [], "an odd count on a running day is a person at work");
  });

  it("nor at any other hour of the current day, including just before midnight", async () => {
    for (const [hh, mm] of [[9, 3], [12, 0], [18, 30], [23, 59]]) {
      const { uc } = build(inNotOut);
      const res = await uc.getSnapshot({ now: ist(DATE, hh, mm) });
      assert.equal(
        res.attention_preview.filter(
          (i) => i.reason_key === "MISSING_PUNCH" && i.attendance_date === DATE
        ).length,
        0,
        `${hh}:${mm}`
      );
    }
  });

  it("shows the live state instead: no check-in after the shift started", async () => {
    const { uc } = build({ ...inNotOut, rawPunches: [] });
    const res = await uc.getSnapshot({ now: ist(DATE, 13, 8) });
    const item = res.attention_preview.find((i) => i.employee_id === 1);
    assert.equal(item.reason_key, "NO_CHECK_IN");
    assert.equal(item.attendance_date, DATE);
  });

  it("and no item at all for somebody recorded IN with a pair still open", async () => {
    const { uc } = build(inNotOut);
    const res = await uc.getSnapshot({ now: ist(DATE, 13, 8) });
    assert.equal(res.attention_preview.filter((i) => i.employee_id === 1).length, 0);
    assert.equal(res.gap, 0, "they are recorded IN at their own outlet");
  });

  /**
   * THREE PUNCHES IS THE SAME FAULT AS ONE, and the reason it needs its own
   * case is that 1 is easy to special-case and 3 is not. Somebody who punched
   * IN, OUT for a break and IN again has an odd count and is at work.
   */
  it("does not label THREE punches on a running day a Missing Punch either", async () => {
    const { uc } = build({
      employees: [employee(1)],
      assignments: [assign(1, 1)],
      rawPunches: [
        punch(1, `${DATE} 09:02:00`, 11),
        punch(1, `${DATE} 13:00:00`, 12),
        punch(1, `${DATE} 14:05:00`, 13),
      ],
    });
    const res = await uc.getSnapshot({ now: ist(DATE, 15, 0) });
    assert.deepEqual(
      res.attention_preview.filter((i) => i.reason_key === "MISSING_PUNCH"),
      [],
      "7, 9 and 101 behave the same way; none of them is a list entry"
    );
    assert.equal(res.gap, 0, "they are recorded IN at their own outlet");
  });

  /**
   * THE VERDICT IS NOT ABOLISHED - IT BELONGS TO ANOTHER SCREEN.
   *
   * An odd punch count on a FINISHED day is a real attendance exception, and
   * the Missing Attendance Report exists for exactly it: it reports it and the
   * 06:00 job chases it. What must not happen is this live staffing board
   * ALSO carrying it, which made a reader decide, row by row, which of two
   * workflows a row belonged to. A date chip made that legible; it did not
   * make it one workflow.
   *
   * So the assertion is the absence, and it is checked on the whole list and
   * on the grouped one - a row that slipped into a group without being in the
   * preview would be invisible to a test that only read one of them.
   */
  it("does NOT put a completed earlier date's Missing Punch on this panel", async () => {
    const yesterday = "2026-09-11";
    const { uc } = build({
      employees: [employee(1)],
      assignments: [assign(1, 1)],
      rawPunches: [punch(1, `${yesterday} 09:02:00`, 11)],
    });
    const res = await uc.getSnapshot({ now: ist(DATE, 13, 8) });
    assert.deepEqual(
      res.attention_preview.filter((i) => i.reason_key === "MISSING_PUNCH"),
      [],
      "completed-day exceptions are the Missing Attendance Report's"
    );
    assert.deepEqual(
      res.attention_groups.flatMap((g) => g.items).filter((i) => i.reason_key === "MISSING_PUNCH"),
      [],
      "and not in a group either"
    );
  });

  it("does not put THREE punches on a completed earlier date here either", async () => {
    const yesterday = "2026-09-11";
    const { uc } = build({
      employees: [employee(1)],
      assignments: [assign(1, 1)],
      rawPunches: [
        punch(1, `${yesterday} 09:02:00`, 11),
        punch(1, `${yesterday} 13:00:00`, 12),
        punch(1, `${yesterday} 14:05:00`, 13),
      ],
    });
    const res = await uc.getSnapshot({ now: ist(DATE, 13, 8) });
    assert.deepEqual(
      res.attention_preview.filter((i) => i.reason_key === "MISSING_PUNCH"),
      []
    );
  });

  /**
   * THE WHOLE PANEL IS ONE DATE, and this is the assertion that keeps it that
   * way as items are added. A future reason that quietly reached back a day
   * fails here even if nobody thinks to test that reason specifically.
   */
  it("every row on the panel is about the current business date", async () => {
    const yesterday = "2026-09-11";
    const { uc } = build({
      employees: [employee(1), employee(2), employee(3)],
      assignments: [assign(1, 1), assign(2, 1), assign(3, 1)],
      rawPunches: [
        // 1: an odd sequence on a completed day.
        punch(1, `${yesterday} 09:02:00`, 11),
        // 2: IN today, no OUT yet.
        punch(2, `${DATE} 09:02:00`, 21),
        // 3: nothing at all today.
      ],
    });
    const res = await uc.getSnapshot({ now: ist(DATE, 13, 8) });
    const dates = [...new Set(res.attention_preview.map((i) => i.attendance_date).filter(Boolean))];
    assert.deepEqual(dates, [DATE]);
    assert.deepEqual(
      res.attention_groups.flatMap((g) => g.items).map((i) => i.attendance_date),
      res.attention_groups.flatMap((g) => g.items).map(() => DATE)
    );
  });

  /**
   * AND THE PANEL'S VOCABULARY NO LONGER CONTAINS THE REASON AT ALL, which is
   * different from gating it. A gate is a line somebody can move; an absent
   * key has to be reintroduced deliberately, and this fails when it is.
   */
  it("MISSING_PUNCH is not a reason this panel can produce", async () => {
    // The factory exposes its vocabulary; build one to read it.
    const { ATTENTION, ATTENTION_LABEL, ATTENTION_TARGET, ATTENTION_ORDER } = build({}).uc;
    assert.equal(ATTENTION.MISSING_PUNCH, undefined);
    assert.equal(ATTENTION_LABEL.MISSING_PUNCH, undefined);
    assert.equal(ATTENTION_TARGET.MISSING_PUNCH, undefined);
    assert.ok(!ATTENTION_ORDER.includes("MISSING_PUNCH"));
  });

  /**
   * THE BOUNDARY IS IST, NOT UTC. At 01:00 IST the UTC date is still
   * yesterday's, so a UTC boundary would let the day that has barely started
   * be treated as a completed one for five and a half hours every night.
   */
  it("uses the IST business date for the boundary, not a UTC one", async () => {
    const { uc } = build({
      employees: [employee(1)],
      assignments: [assign(1, 1)],
      // 00:30 IST on DATE is 19:00 UTC on the PREVIOUS calendar day.
      rawPunches: [punch(1, `${DATE} 00:30:00`, 11)],
    });
    const res = await uc.getSnapshot({ now: ist(DATE, 1, 0) });
    assert.equal(res.business_date, DATE, "the business date is IST's");
    assert.equal(
      res.attention_preview.filter(
        (i) => i.reason_key === "MISSING_PUNCH" && i.attendance_date === DATE
      ).length,
      0
    );
  });
});

/* ---------------------------- the exception still has a home: the report ---- */

/**
 * REMOVING A ROW FROM ONE SCREEN MUST NOT REMOVE THE WORK.
 *
 * The staffing panel no longer shows a completed-day odd sequence. That is
 * only correct if the Missing Attendance Report still does - otherwise this
 * change has quietly stopped anybody being asked to fix those days, which is
 * the worst possible outcome and exactly the kind of thing a per-screen test
 * cannot notice. So the same employee, the same date and the same punch is
 * put through BOTH usecases and asserted in opposite directions.
 */
describe("a completed-day odd sequence leaves the panel and stays on the report", () => {
  const buildMissing = require("./attendance_missing");

  const REPORT_TODAY = DATE;
  const REPORT_YESTERDAY = "2026-09-11";

  /** The dashboard repo the report reads, with one employee and one punch. */
  const reportState = {
    employees: [employee(1)],
    assignments: [assign(1, 1)],
    rawPunches: [punch(1, `${REPORT_YESTERDAY} 09:02:00`, 11)],
  };

  const missingUsecase = () => {
    const repo = fakeRepo(reportState);
    const missingRepo = {
      listCandidateEmployees: async () => reportState.employees,
      getActiveTelegramChats: async () => [],
      listNotificationsForDate: async () => [],
      claim: async () => ({ claimed: true }),
      settle: async () => ({}),
      releaseClaim: async () => ({}),
    };
    return buildMissing(missingRepo, buildDashboard(repo), {
      now: () => ist(REPORT_TODAY, 9, 0),
    });
  };

  it("is NOT on the staffing panel", async () => {
    const { uc } = build(reportState);
    const res = await uc.getSnapshot({ now: ist(REPORT_TODAY, 13, 8) });
    assert.deepEqual(
      res.attention_preview.filter((i) => i.reason_key === "MISSING_PUNCH"),
      []
    );
  });

  it("IS on the Missing Attendance Report, with the date and the count", async () => {
    const { data } = await missingUsecase().getReport(
      { from_date: "2026-09-01", to_date: REPORT_TODAY },
      { today: REPORT_TODAY }
    );
    assert.equal(data.length, 1, "the work did not disappear with the row");
    assert.equal(data[0].employee_id, 1);
    assert.equal(data[0].attendance_date, REPORT_YESTERDAY);
    assert.equal(data[0].punch_count, 1);
    assert.equal(data[0].status, "Missing Attendance");
  });

  it("and TODAY is still not on the report either - the rule is unchanged there", async () => {
    const todayOnly = {
      employees: [employee(1)],
      assignments: [assign(1, 1)],
      rawPunches: [punch(1, `${REPORT_TODAY} 09:02:00`, 11)],
    };
    const repo = fakeRepo(todayOnly);
    const uc = buildMissing(
      {
        listCandidateEmployees: async () => todayOnly.employees,
        getActiveTelegramChats: async () => [],
        listNotificationsForDate: async () => [],
        claim: async () => ({ claimed: true }),
        settle: async () => ({}),
        releaseClaim: async () => ({}),
      },
      buildDashboard(repo),
      { now: () => ist(REPORT_TODAY, 9, 0) }
    );
    const { data } = await uc.getReport(
      { from_date: "2026-09-01", to_date: REPORT_TODAY },
      { today: REPORT_TODAY }
    );
    assert.deepEqual(data, [], "an employee still at work is on neither screen");
  });
});
