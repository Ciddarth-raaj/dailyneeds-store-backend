/**
 * ATTENDANCE LIST: on a Present/Absent Only date the punch's CALENDAR date is
 * authoritative - whatever shift the employee has, had or will have - and it
 * agrees with the attendance engine.
 *
 *   node --test usecase/attendance_list_calendar_date.test.js
 *
 * The punch repository is faked with the SAME two conditions its SQL applies
 * (`listDated`: ingest date in range; `listCalendarCandidates`: calendar date
 * in range and ingest date null or outside it). The real statements are run
 * against MariaDB in `repository/employee_attendance_mode.mysql.test.js`.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildRaw = require("./attendance_raw");
const buildCalculation = require("./attendance_calculation");
const { presentedAttendanceDate, modeResolver } = require("../utils/attendance_calculation_mode");
const { CALC_STATUS } = require("../utils/attendance_engine");

const PAO = "PRESENT_ABSENT_ONLY";
const SB = "SHIFT_BASED";
const mode = (id, employee_id, calculation_mode, effective_from) => ({
  employee_attendance_calculation_mode_id: id,
  employee_id,
  calculation_mode,
  effective_from,
});

/*
 * 1  PAO, NO shift                    - ingest could not date either punch
 * 2  PAO, ACTIVE shift (cutoff 04:00) - ingest put 02:00 on 01/10
 * 3  PAO, an OLD shift (since ended)  - ingest dated them under it
 * 4  SHIFT BASED, shift               - the control: 02:00 stays on 01/10
 * 5  SB to 30/09, PAO from 01/10      - transition INTO the mode
 * 6  PAO 01/10-15/10, SB from 16/10   - transition BACK
 */
const MODES = [
  mode(1, 1, PAO, "2026-09-01"),
  mode(2, 2, PAO, "2026-09-01"),
  mode(3, 3, PAO, "2026-09-01"),
  mode(5, 5, PAO, "2026-10-01"),
  mode(6, 6, PAO, "2026-10-01"),
  mode(7, 6, SB, "2026-10-16"),
];

let nextId = 1;
const raw = (employee_id, io_time, ingest_attendance_date) => {
  const calendar_date = io_time.slice(0, 10);
  return {
    biomax_punch_id: nextId++,
    dev_id: "DEV1",
    user_id: String(employee_id),
    io_time,
    clock_time: io_time.slice(11, 16),
    calendar_date,
    attendance_date: ingest_attendance_date,
    derivation_status: ingest_attendance_date ? "OK" : "NO_SHIFT",
    employee_id,
    employee_name: `Employee ${employee_id}`,
    device_status: "REGISTERED",
    ingest_source: "LIVE",
  };
};

const PUNCHES = [
  raw(1, "2026-10-01 22:00:00", null),
  raw(1, "2026-10-02 02:00:00", null),
  raw(2, "2026-10-01 22:00:00", "2026-10-01"),
  raw(2, "2026-10-02 02:00:00", "2026-10-01"),
  raw(3, "2026-10-01 22:00:00", "2026-10-01"),
  raw(3, "2026-10-02 02:00:00", "2026-10-01"),
  raw(4, "2026-10-01 22:00:00", "2026-10-01"),
  raw(4, "2026-10-02 02:00:00", "2026-10-01"),
  raw(5, "2026-09-30 22:00:00", "2026-09-30"),
  raw(5, "2026-10-01 02:00:00", "2026-09-30"),
  raw(5, "2026-10-01 22:00:00", "2026-10-01"),
  raw(5, "2026-10-02 02:00:00", "2026-10-01"),
  raw(6, "2026-10-15 22:00:00", "2026-10-15"),
  raw(6, "2026-10-16 02:00:00", "2026-10-15"),
  raw(6, "2026-10-16 22:00:00", "2026-10-16"),
  raw(6, "2026-10-17 02:00:00", "2026-10-16"),
];

const inRange = (d, f) => d !== null && d >= f.from && d <= f.to;
const punchRepo = {
  listDated: async (f) => PUNCHES.filter((p) => inRange(p.attendance_date, f)),
  listCalendarCandidates: async (f) =>
    PUNCHES.filter((p) => inRange(p.calendar_date, f) && !inRange(p.attendance_date, f)),
  summary: async () => ({ groups: [], unregistered: [] }),
  summaryNoShiftDays: async () => [],
  listPunches: async (f) =>
    PUNCHES.filter(
      (p) =>
        inRange(p.calendar_date, f) &&
        (f.employee_id === undefined || f.employee_id === null || p.employee_id === f.employee_id) &&
        (!f.attendance_date || p.attendance_date === f.attendance_date)
    ),
  listPunchStreamForEmployees: async () => [],
};
const modeRepo = {
  getAttendanceCalculationModeHistoryForEmployees: async (ids) => MODES.filter((m) => ids.includes(m.employee_id)),
};
const raws = () => buildRaw(punchRepo, null, modeRepo);

/** `employee@date: times` for the rows of one list response. */
const layout = (data, employeeId) =>
  data
    .filter((r) => r.employee_id === employeeId)
    .map((r) => `${r.clock_date}: ${r.punches.map((p) => p.time).join(" ")}`);

describe("presentedAttendanceDate - the rule", () => {
  const modeFor = modeResolver(MODES.filter((m) => m.employee_id === 6));
  it("a Present/Absent Only ingest date gives way to the calendar date", () => {
    assert.equal(presentedAttendanceDate({ calendar_date: "2026-10-16", ingest_attendance_date: "2026-10-15", modeFor }), "2026-10-16");
  });
  it("a Shift Based ingest date is kept", () => {
    assert.equal(presentedAttendanceDate({ calendar_date: "2026-10-17", ingest_attendance_date: "2026-10-16", modeFor }), "2026-10-16");
  });
  it("an undated punch is placed only on a Present/Absent Only calendar date", () => {
    assert.equal(presentedAttendanceDate({ calendar_date: "2026-10-05", ingest_attendance_date: null, modeFor }), "2026-10-05");
    assert.equal(presentedAttendanceDate({ calendar_date: "2026-10-20", ingest_attendance_date: null, modeFor }), null);
  });
});

describe("Attendance List - 22:00 on 01/10 and 02:00 on 02/10", () => {
  const RANGE = { from: "2026-10-01", to: "2026-10-02" };

  it("1. Present/Absent Only, NO shift: each punch on its calendar date", async () => {
    const { data } = await raws().list(RANGE);
    assert.deepEqual(layout(data, 1), ["2026-10-01: 22:00", "2026-10-02: 02:00"]);
  });

  it("2. Present/Absent Only with an ACTIVE shift: each punch on its calendar date (the shift cutoff is ignored)", async () => {
    const { data } = await raws().list(RANGE);
    assert.deepEqual(layout(data, 2), ["2026-10-01: 22:00", "2026-10-02: 02:00"]);
    assert.ok(data.filter((r) => r.employee_id === 2).every((r) => r.attendance_calculation_mode === PAO));
  });

  it("3. Present/Absent Only with an OLD shift assignment: the same", async () => {
    const { data } = await raws().list(RANGE);
    assert.deepEqual(layout(data, 3), ["2026-10-01: 22:00", "2026-10-02: 02:00"]);
  });

  it("4. Shift Based with the same punches: unchanged - the 02:00 OUT stays on 01/10", async () => {
    const { data } = await raws().list(RANGE);
    assert.deepEqual(layout(data, 4), ["2026-10-01: 22:00 02:00"]);
    assert.equal(data.find((r) => r.employee_id === 4).attendance_calculation_mode, SB);
  });

  it("a one-day range still finds the 02:00 punch on 02/10, and 01/10 alone does not show it", async () => {
    const only02 = await raws().list({ from: "2026-10-02", to: "2026-10-02" });
    for (const id of [1, 2, 3]) assert.deepEqual(layout(only02.data, id), ["2026-10-02: 02:00"], `employee ${id}`);
    assert.deepEqual(layout(only02.data, 4), [], "a Shift Based 02:00 still belongs to 01/10");
    const only01 = await raws().list({ from: "2026-10-01", to: "2026-10-01" });
    for (const id of [1, 2, 3]) assert.deepEqual(layout(only01.data, id), ["2026-10-01: 22:00"], `employee ${id}`);
    assert.deepEqual(layout(only01.data, 4), ["2026-10-01: 22:00 02:00"]);
  });
});

describe("effective-date transitions", () => {
  it("5. INTO the mode on 01/10: 30/09's shift still claims 01/10 00:00-04:00; 02/10 02:00 is 02/10's", async () => {
    const { data } = await raws().list({ from: "2026-09-30", to: "2026-10-02" });
    assert.deepEqual(layout(data, 5), [
      "2026-09-30: 22:00 02:00",
      "2026-10-01: 22:00",
      "2026-10-02: 02:00",
    ]);
  });

  it("6. BACK to Shift Based on 16/10: 15/10 claims nothing; 16/10's shift claims 17/10 02:00", async () => {
    const { data } = await raws().list({ from: "2026-10-15", to: "2026-10-17" });
    assert.deepEqual(layout(data, 6), [
      "2026-10-15: 22:00",
      "2026-10-16: 02:00 22:00 02:00",
    ]);
    const rows = data.filter((r) => r.employee_id === 6);
    assert.equal(rows[0].attendance_calculation_mode, PAO);
    assert.equal(rows[1].attendance_calculation_mode, SB);
  });
});

describe("the export and the audit use the same date", () => {
  it("8. the Attendance List CSV's Clock Date is the presented date", async () => {
    const { header, rows } = await raws().listCsv({ from: "2026-10-01", to: "2026-10-02" });
    const date = header.indexOf("Clock Date");
    const code = header.indexOf("Employee Code");
    const t1 = header.indexOf("Clock Time-1");
    const forTwo = rows.filter((r) => r[code] === "2").map((r) => `${r[date]} ${r[t1]}`);
    assert.deepEqual(forTwo, ["01/10/2026 22:00", "02/10/2026 02:00"]);
    const forFour = rows.filter((r) => r[code] === "4").map((r) => r[date]);
    assert.deepEqual(forFour, ["01/10/2026"]);
  });

  it("the row's Punch Audit link (attendance_date = the row's date) finds the same punches", async () => {
    const audit = await raws().audit({ from: "2026-10-02", to: "2026-10-02", employee_id: 2, attendance_date: "2026-10-02" });
    assert.deepEqual(audit.data.map((p) => [p.employee_id, p.clock_time, p.attendance_date]), [[2, "02:00", "2026-10-02"]]);
    assert.equal(audit.data[0].ingest_attendance_date, "2026-10-01", "what ingest stored is still reported");
  });
});

/* ======================================= 7. agreement with the engine */

describe("7. the Attendance List agrees with the canonical attendance calculation", () => {
  const schedule = Array.from({ length: 7 }, (_, day) => ({
    work_shift_weekly_schedule_id: 10 + day,
    work_shift_id: 1,
    day_of_week: day,
    is_working_day: 1,
    in_time: "14:00:00",
    out_time: "23:00:00",
    attendance_day_cutoff: "04:00:00",
    break_minutes: 60,
    normal_work_minutes: 480,
    ot_rate: 1,
  }));
  const calcFor = (employeeId) =>
    buildCalculation({
      getShiftAssignmentHistory: async () => [
        { employee_work_shift_assignment_id: 1, employee_id: employeeId, work_shift_id: 1, effective_from: "2026-01-01", source: "TEST" },
      ],
      getDateShiftOverrides: async () => [],
      getWorkShiftWithSchedule: async () => ({ config: { work_shift_id: 1, shift_code: "EVE", shift_name: "Evening", active: 1 }, schedule }),
      getWorkShiftConfigVersions: async () => [],
      getRawPunchesByCalendarWindow: async (_id, from, to) =>
        PUNCHES.filter((p) => p.employee_id === employeeId && p.calendar_date >= from && p.calendar_date <= to).map((p) => ({
          punch_id: p.biomax_punch_id,
          employee_id: p.employee_id,
          punch_date: p.calendar_date,
          ingest_attendance_date: p.attendance_date,
          io_time: p.io_time,
          dev_id: p.dev_id,
          ingest_source: "LIVE",
        })),
      getApprovedRegularizedPunches: async () => [],
      getBreakOverride: async () => ({ attendance_required: 1 }),
      getApprovalStateByDate: async () => [],
      getAttendanceCalculationModeHistory: async () => MODES.filter((m) => m.employee_id === employeeId),
    });

  for (const [employeeId, from, to] of [[2, "2026-10-01", "2026-10-02"], [4, "2026-10-01", "2026-10-02"], [5, "2026-09-30", "2026-10-02"], [6, "2026-10-15", "2026-10-17"]]) {
    it(`employee ${employeeId}: the same punches on the same dates`, async () => {
      const days = await calcFor(employeeId).calculateRange({ employee_id: employeeId, from_date: from, to_date: to });
      const engine = days
        .filter((d) => d.punch_count > 0)
        .map((d) => `${d.attendance_date}: ${d.effective_punches.map((p) => p.io_time.slice(11, 16)).join(" ")}`);
      const { data } = await raws().list({ from, to });
      assert.deepEqual(layout(data, employeeId), engine);
    });
  }

  it("both Present/Absent Only dates qualify as Present, independently", async () => {
    const days = await calcFor(2).calculateRange({ employee_id: 2, from_date: "2026-10-01", to_date: "2026-10-02" });
    assert.deepEqual(days.map((d) => [d.attendance_date, d.status, d.attendance_day_count]), [
      ["2026-10-01", CALC_STATUS.FINAL, 1],
      ["2026-10-02", CALC_STATUS.FINAL, 1],
    ]);
  });
});
