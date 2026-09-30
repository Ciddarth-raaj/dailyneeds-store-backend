/**
 * EMPLOYEE ATTENDANCE CALCULATION TYPE, through the REAL usecases.
 *
 *   node --test usecase/attendance_calculation_mode.test.js
 *
 * Both calculating paths - `usecase/attendance_calculation.js` (preview,
 * recalculation, storage) and the batched `usecase/attendance_dashboard.js`
 * - are run over the same facts, with fake repositories standing in for
 * MySQL. What is asserted is that every path resolves the mode FOR THE DATE
 * from the dated history, never from the current setting, and that the two
 * paths agree.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildCalculation = require("./attendance_calculation");
const buildDashboard = require("./attendance_dashboard");
const buildModeUsecase = require("./employee_attendance_mode");
const { CALC_STATUS } = require("../utils/attendance_engine");
const {
  ATTENDANCE_CALCULATION_MODE: MODE,
  MODE_RESOLUTION_STATUS,
} = require("../utils/attendance_calculation_mode");
const { hydrateStoredDay } = require("../utils/attendance_stored_read");

const EMP = 42;

const scheduleRows = (workShiftId) =>
  Array.from({ length: 7 }, (_, day) => ({
    work_shift_weekly_schedule_id: workShiftId * 10 + day,
    work_shift_id: workShiftId,
    day_of_week: day,
    is_working_day: 1,
    in_time: "09:00:00",
    out_time: "21:00:00",
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

const ASSIGNED = [
  { employee_work_shift_assignment_id: 1, employee_id: EMP, work_shift_id: 7, effective_from: "2026-09-01", source: "MIGRATION_BACKFILL" },
];

const modeRow = (id, calculation_mode, effective_from) => ({
  employee_attendance_calculation_mode_id: id,
  employee_id: EMP,
  calculation_mode,
  effective_from,
});

/** The example from the request: Shift Based to 30/09, Present/Absent Only from 01/10. */
const FROM_OCTOBER = [modeRow(1, MODE.PRESENT_ABSENT_ONLY, "2026-10-01")];

let nextPunchId = 1;
const punch = (io_time) => ({
  punch_id: nextPunchId++,
  employee_id: EMP,
  punch_date: io_time.slice(0, 10),
  ingest_attendance_date: io_time.slice(0, 10),
  io_time,
  dev_id: "DEV1",
  ingest_source: "BIOMAX",
  attendance_punch_void_id: null,
  void_reason: null,
});

const EMPLOYEE_ROW = {
  employee_id: EMP,
  employee_name: "Employee 42",
  store_id: 1,
  designation_id: 5,
  special_break_override_minutes: null,
  extra_break_hours: null,
  attendance_required: 1,
  resignation_date: null,
};

const facts = (over = {}) => ({
  employee: EMPLOYEE_ROW,
  assignments: ASSIGNED,
  configs: [shiftConfig(7)],
  schedules: scheduleRows(7),
  rawPunches: [],
  modes: [],
  stored: [],
  saved: [],
  ...over,
});

function calcRepo(f) {
  const inWindow = (from, to) => (p) => p.io_time.slice(0, 10) >= from && p.io_time.slice(0, 10) <= to;
  return {
    getShiftAssignmentHistory: async () => f.assignments,
    getDateShiftOverrides: async () => [],
    getWorkShiftWithSchedule: async (id) => ({
      config: f.configs.find((c) => Number(c.work_shift_id) === Number(id)) || null,
      schedule: f.schedules.filter((s) => Number(s.work_shift_id) === Number(id)),
    }),
    getWorkShiftConfigVersions: async () => [],
    getRawPunchesByCalendarWindow: async (_id, from, to) => f.rawPunches.filter(inWindow(from, to)),
    getApprovedRegularizedPunches: async () => [],
    getBreakOverride: async () => f.employee,
    getApprovalStateByDate: async () => [],
    getAttendanceCalculationModeHistory: async () => f.modes,
    listCalculations: async ({ from_date, to_date }) =>
      f.stored.filter((r) => r.attendance_date >= from_date && r.attendance_date <= to_date),
    getEmploymentWindow: async () => ({ employee_id: EMP, date_of_joining: "2025-01-01", resignation_date: null }),
    findPayrollLockedPeriods: async () => [],
    saveCalculationsWithReconciliation: async ({ rows }) => {
      f.saved.push(...rows);
      return { written: rows.length, stale_removed: 0 };
    },
  };
}

function dashRepo(f) {
  const inWindow = (from, to) => (p) => p.io_time.slice(0, 10) >= from && p.io_time.slice(0, 10) <= to;
  return {
    getShiftAssignmentHistoryForEmployees: async () => f.assignments,
    getDateShiftOverridesForEmployees: async () => [],
    listWorkShiftConfigs: async () => f.configs,
    listWorkShiftSchedules: async () => f.schedules,
    listWorkShiftConfigVersions: async () => [],
    getRawPunchesForEmployees: async (_ids, from, to) => f.rawPunches.filter(inWindow(from, to)),
    getApprovedRegularizedPunchesForEmployees: async () => [],
    getApprovalStateForEmployees: async () => [],
    getStoredCalculationsForEmployees: async () => f.stored,
    getAttendanceCalculationModeHistoryForEmployees: async () => f.modes,
  };
}

// Well after every date used, so every date is CLOSED and persistable.
const LATER = Date.parse("2026-12-15T12:00:00Z");

const calc = (f) => buildCalculation(calcRepo(f), { now: LATER });
const range = (f, from, to) => calc(f).calculateRange({ employee_id: EMP, from_date: from, to_date: to });
const byDate = (days) => new Map(days.map((d) => [d.attendance_date, d]));

/* =================================================== effective dating */

describe("effective date - the example from the request", () => {
  const f = facts({
    modes: FROM_OCTOBER,
    rawPunches: [
      // 30/09: late (10:30) and short (left 15:00)
      punch("2026-09-30 10:30:00"),
      punch("2026-09-30 15:00:00"),
      // 01/10: identical punches
      punch("2026-10-01 10:30:00"),
      punch("2026-10-01 15:00:00"),
    ],
  });

  it("the day BEFORE the effective date is calculated Shift Based: late and shortage", async () => {
    const d = byDate(await range(f, "2026-09-30", "2026-10-01")).get("2026-09-30");
    assert.equal(d.attendance_calculation_mode, MODE.SHIFT_BASED);
    assert.equal(d.late_minutes, 90);
    assert.ok(d.shortage_minutes > 0);
    assert.equal(d.work_shift_id, 7);
  });

  it("the effective date is Present/Absent Only: Present, no late, no shortage", async () => {
    const d = byDate(await range(f, "2026-09-30", "2026-10-01")).get("2026-10-01");
    assert.equal(d.attendance_calculation_mode, MODE.PRESENT_ABSENT_ONLY);
    assert.equal(d.status, CALC_STATUS.FINAL);
    assert.equal(d.attendance_day_count, 1);
    assert.equal(d.late_minutes, null);
    assert.equal(d.early_exit_minutes, null);
    assert.equal(d.shortage_minutes, 0);
    assert.equal(d.candidate_ot_minutes, 0);
    assert.equal(d.shift_resolution_status, MODE_RESOLUTION_STATUS, "never reported as a roster gap");
    assert.equal(d.shift_name, null);
  });
});

describe("historical change - a later setting never reinterprets an earlier date", () => {
  const f = facts({
    modes: [...FROM_OCTOBER, modeRow(2, MODE.SHIFT_BASED, "2026-11-01")],
    rawPunches: ["2026-09-15", "2026-10-15", "2026-11-16"].flatMap((d) => [
      punch(`${d} 11:00:00`),
      punch(`${d} 14:00:00`),
    ]),
  });

  it("September stays Shift Based, October Present/Absent Only, November Shift Based again", async () => {
    // Month by month, as a screen asks.
    const sep = byDate(await range(f, "2026-09-15", "2026-09-15")).get("2026-09-15");
    const oct = byDate(await range(f, "2026-10-15", "2026-10-15")).get("2026-10-15");
    const nov = byDate(await range(f, "2026-11-16", "2026-11-16")).get("2026-11-16");
    assert.equal(sep.attendance_calculation_mode, MODE.SHIFT_BASED);
    assert.ok(sep.shortage_minutes > 0);
    assert.equal(oct.attendance_calculation_mode, MODE.PRESENT_ABSENT_ONLY);
    assert.equal(oct.shortage_minutes, 0);
    assert.equal(nov.attendance_calculation_mode, MODE.SHIFT_BASED);
    assert.ok(nov.shortage_minutes > 0);
  });
});

/* ======================================================= recalculation */

describe("recalculation resolves the mode applicable ON EACH DATE", () => {
  it("recalculating September while the CURRENT mode is Present/Absent Only stores Shift Based rows", async () => {
    // Present/Absent Only since 01/10, and "today" is in December, so the
    // CURRENT setting is Present/Absent Only. September must not read it.
    const f = facts({
      modes: FROM_OCTOBER,
      rawPunches: [punch("2026-09-10 10:00:00"), punch("2026-09-10 13:00:00")],
    });
    const result = await calc(f).recalculateRange({ employee_id: EMP, from_date: "2026-09-10", to_date: "2026-09-10" });
    assert.equal(result.days.length, 1);
    assert.equal(f.saved[0].attendance_calculation_mode, MODE.SHIFT_BASED);
    assert.ok(f.saved[0].shortage_minutes > 0, "September keeps its Shift Based shortage");
  });

  it("recalculating October stores Present/Absent Only rows, provenance on the row", async () => {
    const f = facts({
      modes: FROM_OCTOBER,
      rawPunches: [punch("2026-10-10 10:00:00")],
    });
    await calc(f).recalculateRange({ employee_id: EMP, from_date: "2026-10-09", to_date: "2026-10-10" });
    const rows = byDate(f.saved);
    assert.equal(rows.get("2026-10-10").attendance_calculation_mode, MODE.PRESENT_ABSENT_ONLY);
    assert.equal(rows.get("2026-10-10").status, CALC_STATUS.FINAL);
    assert.equal(rows.get("2026-10-10").attendance_day_count, 1);
    assert.equal(rows.get("2026-10-10").shortage_minutes, 0);
    assert.equal(rows.get("2026-10-10").work_shift_id, null);
    assert.equal(rows.get("2026-10-09").status, CALC_STATUS.ABSENT, "no attendance is Absent");
    assert.equal(rows.get("2026-10-09").attendance_calculation_mode, MODE.PRESENT_ABSENT_ONLY);
  });

  it("an employee with no history at all stores SHIFT_BASED rows - opt-in, no behaviour change", async () => {
    const f = facts({ rawPunches: [punch("2026-10-10 10:00:00"), punch("2026-10-10 13:00:00")] });
    await calc(f).recalculateRange({ employee_id: EMP, from_date: "2026-10-10", to_date: "2026-10-10" });
    assert.equal(f.saved[0].attendance_calculation_mode, MODE.SHIFT_BASED);
    assert.ok(f.saved[0].shortage_minutes > 0);
  });

  it("a repository without the history reader behaves exactly as before (SHIFT_BASED)", async () => {
    const f = facts({ modes: FROM_OCTOBER, rawPunches: [punch("2026-10-10 10:00:00"), punch("2026-10-10 13:00:00")] });
    const repo = calcRepo(f);
    delete repo.getAttendanceCalculationModeHistory;
    const [d] = await buildCalculation(repo, { now: LATER }).calculateRange({
      employee_id: EMP,
      from_date: "2026-10-10",
      to_date: "2026-10-10",
    });
    assert.equal(d.attendance_calculation_mode, MODE.SHIFT_BASED);
  });

  it("a stored Present/Absent Only row reads back with its mode", () => {
    const f = facts({ modes: FROM_OCTOBER });
    const storage = calc(f).toStorageRow(
      require("../utils/attendance_engine").calculateAttendanceDay({
        employee_id: EMP,
        attendance_date: "2026-10-10",
        punches: [{ punch_id: 1, io_time: "2026-10-10 09:00:00" }],
        attendance_calculation_mode: MODE.PRESENT_ABSENT_ONLY,
      })
    );
    assert.equal(storage.attendance_calculation_mode, MODE.PRESENT_ABSENT_ONLY);
    const hydrated = hydrateStoredDay({ ...storage, calculated_at: null });
    assert.equal(hydrated.attendance_calculation_mode, MODE.PRESENT_ABSENT_ONLY);
    assert.equal(hydrated.status, CALC_STATUS.FINAL);
    // A row stored before the column existed reads its default.
    const { attendance_calculation_mode, ...legacy } = storage;
    assert.equal(hydrateStoredDay(legacy).attendance_calculation_mode, MODE.SHIFT_BASED);
  });
});

/* ======================================================== no shift */

describe("an employee with NO shift assignment at all", () => {
  const f = facts({
    assignments: [],
    modes: FROM_OCTOBER,
    rawPunches: [punch("2026-10-12 09:05:00")],
  });

  it("Present on a date with attendance, not No Shift", async () => {
    const d = byDate(await range(f, "2026-10-12", "2026-10-13")).get("2026-10-12");
    assert.equal(d.status, CALC_STATUS.FINAL);
    assert.equal(d.attendance_day_count, 1);
    assert.equal(d.shift_resolution_status, MODE_RESOLUTION_STATUS);
  });

  it("Absent on a date without, not No Shift", async () => {
    const d = byDate(await range(f, "2026-10-12", "2026-10-13")).get("2026-10-13");
    assert.equal(d.status, CALC_STATUS.ABSENT);
    assert.equal(d.is_final, true);
  });

  it("a date BEFORE the effective date is still NO_SHIFT_FOR_DATE under Shift Based", async () => {
    const d = byDate(await range(f, "2026-09-30", "2026-09-30")).get("2026-09-30");
    assert.equal(d.status, CALC_STATUS.NO_SHIFT_FOR_DATE);
  });
});

/* ===================================================== punch dating */

describe("an after-midnight punch", () => {
  it("is dated by the calendar on a Present/Absent Only date (no shift cutoff claims it)", async () => {
    const f = facts({ modes: FROM_OCTOBER, rawPunches: [punch("2026-10-11 01:30:00")] });
    const days = byDate(await range(f, "2026-10-10", "2026-10-11"));
    assert.equal(days.get("2026-10-10").status, CALC_STATUS.ABSENT);
    assert.equal(days.get("2026-10-11").status, CALC_STATUS.FINAL);
  });

  it("still belongs to the last Shift Based night across the transition", async () => {
    const f = facts({
      modes: FROM_OCTOBER,
      rawPunches: [punch("2026-09-30 13:00:00"), punch("2026-10-01 00:30:00")],
    });
    const days = byDate(await range(f, "2026-09-30", "2026-10-01"));
    assert.equal(days.get("2026-09-30").punch_count, 2, "the 00:30 OUT stays on 30/09");
    assert.equal(days.get("2026-10-01").status, CALC_STATUS.ABSENT);
  });
});

/* =================================================== dashboard parity */

describe("the batched dashboard path agrees with calculateRange", () => {
  const FIELDS = [
    "attendance_date", "status", "is_final", "attendance_day_count", "punch_count",
    "shortage_minutes", "late_minutes", "early_exit_minutes", "nrm_minutes",
    "candidate_ot_minutes", "approved_ot_minutes", "attendance_calculation_mode",
    "shift_resolution_status", "work_shift_id",
  ];
  const pick = (d) => Object.fromEntries(FIELDS.map((k) => [k, d[k] === undefined ? null : d[k]]));

  const cases = {
    "a present Present/Absent Only date with a shift": facts({ modes: FROM_OCTOBER, rawPunches: [punch("2026-10-05 12:00:00")] }),
    "a present Present/Absent Only date without a shift": facts({ assignments: [], modes: FROM_OCTOBER, rawPunches: [punch("2026-10-05 12:00:00")] }),
    "an absent Present/Absent Only date": facts({ modes: FROM_OCTOBER }),
    "a Shift Based date of the same employee": facts({ modes: [modeRow(1, MODE.PRESENT_ABSENT_ONLY, "2026-10-06")], rawPunches: [punch("2026-10-05 12:00:00")] }),
  };
  for (const [name, f] of Object.entries(cases)) {
    it(name, async () => {
      const [calcDay] = await range(f, "2026-10-05", "2026-10-05");
      const dash = buildDashboard(dashRepo(f));
      const batch = await dash.loadBatch({ employees: [f.employee], from: "2026-10-05", to: "2026-10-05" });
      const [dashDay] = dash.computeDaysForEmployee({ employee: f.employee, dates: ["2026-10-05"], batch, now: LATER });
      assert.deepEqual(pick(dashDay), pick(calcDay));
    });
  }
});

/* ======================================== the Employee Master usecase */

describe("the Employee Master setting (employee_attendance_mode usecase)", () => {
  const fakeModeRepo = (history = []) => {
    const appended = [];
    return {
      appended,
      listHistory: async () => [...history].sort((a, b) => (a.effective_from < b.effective_from ? 1 : -1)),
      appendMode: async (row) => {
        appended.push(row);
        return {
          code: 200,
          employee_id: row.employeeId,
          calculation_mode: row.calculationMode,
          effective_from: row.effectiveFrom,
          affected_from: row.effectiveFrom,
          affected_to: null,
        };
      },
    };
  };

  it("a new employee reads Shift Based by default", async () => {
    const u = buildModeUsecase(fakeModeRepo());
    const r = await u.getMode(EMP, { today: "2026-09-30" });
    assert.equal(r.current_mode, MODE.SHIFT_BASED);
    assert.equal(r.current_mode_label, "Shift Based");
    assert.deepEqual(r.history, []);
  });

  it("a future-dated change is shown as upcoming; today it is still Shift Based", async () => {
    const u = buildModeUsecase(fakeModeRepo(FROM_OCTOBER));
    const r = await u.getMode(EMP, { today: "2026-09-30" });
    assert.equal(r.current_mode, MODE.SHIFT_BASED);
    assert.equal(r.upcoming.calculation_mode, MODE.PRESENT_ABSENT_ONLY);
    assert.equal(r.upcoming.effective_from, "2026-10-01");
    assert.equal(await u.getEmployeeAttendanceCalculationType(EMP, "2026-09-30"), MODE.SHIFT_BASED);
    assert.equal(await u.getEmployeeAttendanceCalculationType(EMP, "2026-10-01"), MODE.PRESENT_ABSENT_ONLY);
  });

  it("the change from the request (effective tomorrow) appends one row and asks for no recalculation", async () => {
    const repo = fakeModeRepo();
    const u = buildModeUsecase(repo);
    const r = await u.changeMode({
      employee_id: EMP,
      calculation_mode: MODE.PRESENT_ABSENT_ONLY,
      effective_from: "2026-10-01",
      actor_employee_id: 7,
      today: "2026-09-30",
    });
    assert.equal(r.code, 200);
    assert.equal(repo.appended.length, 1);
    assert.equal(repo.appended[0].createdBy, 7);
    assert.equal(r.recalculation_required, false);
  });

  it("a backdated change reports exactly the stored range that needs recalculating", async () => {
    const u = buildModeUsecase(fakeModeRepo());
    const r = await u.changeMode({
      employee_id: EMP,
      calculation_mode: MODE.PRESENT_ABSENT_ONLY,
      effective_from: "2026-09-20",
      today: "2026-09-30",
    });
    assert.equal(r.recalculation_required, true);
    assert.deepEqual(r.recalculation_range, { from: "2026-09-20", to: "2026-09-29" });
  });

  it("refuses a change that changes nothing, an unknown mode, and a missing date", async () => {
    const u = buildModeUsecase(fakeModeRepo(FROM_OCTOBER));
    const same = await u.changeMode({ employee_id: EMP, calculation_mode: MODE.PRESENT_ABSENT_ONLY, effective_from: "2026-10-15" });
    assert.equal(same.code, 422);
    await assert.rejects(() => u.changeMode({ employee_id: EMP, calculation_mode: "HOUSEKEEPING", effective_from: "2026-10-15" }), /calculation_mode/);
    await assert.rejects(() => u.changeMode({ employee_id: EMP, calculation_mode: MODE.SHIFT_BASED }), /effective_from/);
  });

  it("refuses a change reaching a payroll-locked month, before anything is written", async () => {
    const repo = fakeModeRepo();
    const probes = [];
    const u = buildModeUsecase(repo, {
      findPayrollLockedPeriods: async (rows) => {
        probes.push(...rows);
        return rows.some((r) => r.attendance_date.startsWith("2026-09"))
          ? [{ employee_id: EMP, year: 2026, month: 9 }]
          : [];
      },
    });
    await assert.rejects(
      () => u.changeMode({ employee_id: EMP, calculation_mode: MODE.PRESENT_ABSENT_ONLY, effective_from: "2026-09-15", today: "2026-10-05" }),
      (err) => err.code === "PAYROLL_MONTH_LOCKED" && /09\/2026/.test(err.message)
    );
    assert.equal(repo.appended.length, 0, "nothing was appended");
    assert.deepEqual(probes.map((p) => p.attendance_date), ["2026-09-01", "2026-10-01"]);

    // The same change dated into the open month is allowed.
    const ok = await u.changeMode({ employee_id: EMP, calculation_mode: MODE.PRESENT_ABSENT_ONLY, effective_from: "2026-10-01", today: "2026-10-05" });
    assert.equal(ok.code, 200);
  });
});

/* ========================================= stored history, read path */

describe("a stored closed row is returned as it was calculated", () => {
  it("a Shift Based row stored before a backdated change still reads Shift Based, with its shift", async () => {
    const buildStored = (mode) =>
      calc(facts({ modes: [] })).toStorageRow(
        require("../utils/attendance_engine").calculateAttendanceDay({
          employee_id: EMP,
          attendance_date: "2026-10-05",
          shift: null,
          shift_status: "NO_SHIFT_FOR_DATE",
          punches: [],
          attendance_calculation_mode: mode,
        })
      );
    const stored = { ...buildStored(MODE.SHIFT_BASED), work_shift_id: 7, status: "ABSENT", calculated_at: null };
    // The mode was changed LATER, backdated to 01/10, and October was not
    // recalculated: the screen must show the stored truth until it is.
    const f = facts({ modes: FROM_OCTOBER, stored: [stored] });
    const [calcDay] = await calc(f).readRange({ employee_id: EMP, from_date: "2026-10-05", to_date: "2026-10-05", now: LATER });
    assert.equal(calcDay.calculation_source, "STORED");
    assert.equal(calcDay.attendance_calculation_mode, MODE.SHIFT_BASED);
    assert.equal(calcDay.shift_resolution_status, "OK");

    const dash = buildDashboard(dashRepo(f));
    const batch = await dash.loadBatch({ employees: [f.employee], from: "2026-10-05", to: "2026-10-05" });
    const [dashDay] = dash.computeDaysForEmployee({ employee: f.employee, dates: ["2026-10-05"], batch, now: LATER });
    assert.equal(dashDay.attendance_calculation_mode, MODE.SHIFT_BASED);
    assert.equal(dashDay.shift_resolution_status, "OK");
    assert.equal(dashDay.work_shift_id, 7);
  });
});
