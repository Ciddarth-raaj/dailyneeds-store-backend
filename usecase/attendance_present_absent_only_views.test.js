/**
 * PRESENT/ABSENT ONLY across the views that used to treat "no shift" or "an
 * odd punch count" as a problem - through the REAL usecases.
 *
 *   node --test usecase/attendance_present_absent_only_views.test.js
 *
 *   - the Missing Attendance report and the 07:00 Telegram reminder: a
 *     one-punch Present/Absent Only day is PRESENT and is never chased;
 *   - the Attendance List and Punch Audit: the receiver's stored NO_SHIFT is
 *     left as it is, but on a Present/Absent Only date it is shown as the
 *     attendance mode, not as a fault, and is not in the review queue.
 *
 * The mode is always the DATE's, from the effective-dated history.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildDashboard = require("./attendance_dashboard");
const buildMissing = require("./attendance_missing");
const buildNotifier = require("./attendance_missing_telegram");
const buildRaw = require("./attendance_raw");

const TODAY = "2026-10-06";
const YESTERDAY = "2026-10-05";
const LATER = Date.parse("2026-10-06T06:00:00Z");

const schedule = (workShiftId) =>
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

const employee = (id) => ({
  employee_id: id,
  employee_name: `Employee ${id}`,
  store_id: 1,
  department_id: 2,
  designation_id: 5,
  attendance_required: 1,
  special_break_override_minutes: null,
  joined_on: null,
  resignation_date: null,
});

const assign = (employee_id) => ({
  employee_work_shift_assignment_id: employee_id,
  employee_id,
  work_shift_id: 1,
  effective_from: "2026-01-01",
  source: "TEST",
});

const pao = (employee_id, effective_from = "2026-10-01") => ({
  employee_attendance_calculation_mode_id: employee_id,
  employee_id,
  calculation_mode: "PRESENT_ABSENT_ONLY",
  effective_from,
});

let nextId = 1;
const onePunch = (employee_id, date = YESTERDAY) => ({
  punch_id: nextId++,
  employee_id,
  punch_date: date,
  ingest_attendance_date: date,
  io_time: `${date} 09:05:00`,
  dev_id: "DEV1",
  ingest_source: "BIOMAX",
  attendance_punch_void_id: null,
  void_reason: null,
});

/**
 * 41  Shift Based, shift assigned, one punch          -> Missing Attendance
 * 42  Present/Absent Only, shift assigned, one punch  -> Present
 * 43  Present/Absent Only, NO shift, one punch        -> Present
 * 44  Present/Absent Only only from TODAY, one punch  -> yesterday is Shift Based: Missing
 */
function world() {
  const state = {
    employees: [employee(41), employee(42), employee(43), employee(44)],
    assignments: [assign(41), assign(42), assign(44)],
    modes: [pao(42), pao(43), pao(44, TODAY)],
    rawPunches: [onePunch(41), onePunch(42), onePunch(43), onePunch(44)],
  };
  const repo = {
    listCandidateEmployees: async () => state.employees,
    getShiftAssignmentHistoryForEmployees: async (ids) => state.assignments.filter((a) => ids.includes(a.employee_id)),
    getDateShiftOverridesForEmployees: async () => [],
    listWorkShiftConfigs: async () => [{ work_shift_id: 1, shift_code: "GEN", shift_name: "General", active: 1 }],
    listWorkShiftSchedules: async () => schedule(1),
    listWorkShiftConfigVersions: async () => [],
    getRawPunchesForEmployees: async (ids, from, to) =>
      state.rawPunches.filter((p) => ids.includes(p.employee_id) && p.punch_date >= from && p.punch_date <= to),
    getApprovedRegularizedPunchesForEmployees: async () => [],
    getApprovalStateForEmployees: async () => [],
    getStoredCalculationsForEmployees: async () => [],
    getAttendanceCalculationModeHistoryForEmployees: async (ids) => state.modes.filter((m) => ids.includes(m.employee_id)),
  };
  const dashboard = buildDashboard(repo);
  const missingUsecase = buildMissing(repo, dashboard, { now: () => LATER });
  return { state, repo, dashboard, missingUsecase };
}

describe("Missing Attendance report", () => {
  it("a one-punch Present/Absent Only day is Present and NOT in the report - with or without a shift", async () => {
    const { missingUsecase } = world();
    const { data } = await missingUsecase.getReport({ from_date: YESTERDAY, to_date: YESTERDAY }, { today: TODAY });
    assert.deepEqual(data.map((r) => r.employee_id).sort(), [41, 44]);
  });

  it("the mode is the date's: a change effective TODAY does not excuse YESTERDAY", async () => {
    const { missingUsecase } = world();
    const { data } = await missingUsecase.getReport({ from_date: YESTERDAY, to_date: YESTERDAY }, { today: TODAY });
    assert.ok(data.some((r) => r.employee_id === 44));
  });
});

describe("the 07:00 Telegram missing-attendance reminder", () => {
  it("has the same population, and messages nobody who is Present/Absent Only", async () => {
    const { missingUsecase } = world();
    const candidates = await missingUsecase.getTelegramCandidates({ today: TODAY });
    assert.deepEqual(candidates.data.map((r) => r.employee_id).sort(), [41, 44]);

    const sent = [];
    const claimed = new Set();
    const notifier = buildNotifier({
      attendanceMissingUsecase: missingUsecase,
      attendanceMissingRepo: {
        getActiveTelegramChats: async (ids) => ids.map((id) => ({ employee_id: id, private_chat_id: 1000 + id })),
        claim: async ({ employee_id, attendance_date }) => {
          const key = `${employee_id}:${attendance_date}`;
          if (claimed.has(key)) return { claimed: false };
          claimed.add(key);
          return { claimed: true, insert_id: claimed.size };
        },
        settle: async () => ({}),
        releaseClaim: async () => ({}),
      },
      telegramService: {
        isConfigured: () => true,
        sendMessage: async (chat_id) => {
          sent.push(chat_id);
          return { code: 200 };
        },
      },
      log: { info: () => {}, error: () => {} },
    });
    const summary = await notifier.run({ today: TODAY });
    assert.equal(summary.attendance_date, YESTERDAY);
    assert.deepEqual(sent.sort(), [1041, 1044]);
    assert.ok(!sent.includes(1042) && !sent.includes(1043));
  });
});

/* ====================================================== raw punch views */

/** A raw punch row as `repository/biomax_punch.js` returns it. */
const rawRow = (id, employee_id, calendar_date, derivation_status, over = {}) => ({
  biomax_punch_id: id,
  dev_id: "DEV1",
  user_id: String(employee_id),
  io_time: `${calendar_date} 09:0${id % 10}:00`,
  clock_time: `09:0${id % 10}`,
  calendar_date,
  attendance_date: derivation_status === "OK" ? calendar_date : null,
  derivation_status,
  employee_id,
  employee_name: `Employee ${employee_id}`,
  device_status: "REGISTERED",
  ingest_source: "LIVE",
  ...over,
});

function rawWorld() {
  // 50 Shift Based, no shift      -> a genuine NO_SHIFT fault
  // 51 Present/Absent Only        -> expected, not a fault
  // 52 Present/Absent Only only from 02/10: its 01/10 punch is still a fault
  const noShift = [
    rawRow(1, 50, "2026-10-01", "NO_SHIFT"),
    rawRow(2, 51, "2026-10-01", "NO_SHIFT"),
    rawRow(3, 52, "2026-10-01", "NO_SHIFT"),
    rawRow(4, 52, "2026-10-02", "NO_SHIFT"),
    // A Present/Absent Only punch from an UNREGISTERED device is still a
    // review item - for the device, not for the shift.
    rawRow(5, 51, "2026-10-02", "NO_SHIFT", { device_status: "UNREGISTERED_DEVICE" }),
  ];
  const dated = [rawRow(6, 60, "2026-10-01", "OK")];
  const punchRepo = {
    summary: async () => ({
      groups: [
        { derivation_status: "NO_SHIFT", device_status: "REGISTERED", punches: 4 },
        { derivation_status: "NO_SHIFT", device_status: "UNREGISTERED_DEVICE", punches: 1 },
        { derivation_status: "OK", device_status: "REGISTERED", punches: 1 },
      ],
      unregistered: [],
    }),
    summaryNoShiftDays: async () => [
      { employee_id: 50, calendar_date: "2026-10-01", punches: 1 },
      { employee_id: 51, calendar_date: "2026-10-01", punches: 1 },
      { employee_id: 51, calendar_date: "2026-10-02", punches: 1 },
      { employee_id: 52, calendar_date: "2026-10-01", punches: 1 },
      { employee_id: 52, calendar_date: "2026-10-02", punches: 1 },
    ],
    listDated: async () => dated,
    // Calendar-window candidates the dated query did not return (all undated here).
    listCalendarCandidates: async () => noShift,
    // The SQL's own review / issue conditions, as the real query applies them.
    listPunches: async (f) =>
      [...noShift, ...dated].filter((p) => {
        const deviceIssue = p.device_status === "UNREGISTERED_DEVICE" || p.device_status === "INACTIVE_DEVICE";
        if (f.review === "needs_review" && !(p.derivation_status !== "OK" || deviceIssue)) return false;
        if (f.issue === "NO_SHIFT" && p.derivation_status !== "NO_SHIFT") return false;
        return true;
      }),
    listPunchStreamForEmployees: async () => [],
  };
  const modes = [pao(51, "2026-09-01"), pao(52, "2026-10-02")];
  const modeRepo = {
    getAttendanceCalculationModeHistoryForEmployees: async (ids) => modes.filter((m) => ids.includes(m.employee_id)),
  };
  return { punchRepo, modeRepo };
}

const RANGE = { from: "2026-10-01", to: "2026-10-02" };

describe("Attendance List", () => {
  it("the 'without an assigned shift' warning no longer counts Present/Absent Only punches", async () => {
    const { punchRepo, modeRepo } = rawWorld();
    const { meta } = await buildRaw(punchRepo, null, modeRepo).list(RANGE);
    // 5 NO_SHIFT punches: 51's two and 52's 02/10 one are expected.
    assert.equal(meta.no_shift_punches, 2, "50 on 01/10 and 52 on 01/10 (before its effective date)");
    assert.equal(meta.present_absent_only_punches, 3);
    assert.equal(meta.undated_punches, 2);
  });

  it("lists a Present/Absent Only employee's punches on their CALENDAR date, labelled with the mode", async () => {
    const { punchRepo, modeRepo } = rawWorld();
    const { data } = await buildRaw(punchRepo, null, modeRepo).list(RANGE);
    const rows = data.map((r) => `${r.employee_id}@${r.clock_date}:${r.attendance_calculation_mode}`).sort();
    assert.deepEqual(rows, [
      "51@2026-10-01:PRESENT_ABSENT_ONLY",
      "51@2026-10-02:PRESENT_ABSENT_ONLY",
      "52@2026-10-02:PRESENT_ABSENT_ONLY",
      "60@2026-10-01:SHIFT_BASED",
    ]);
  });

  it("without the mode reader it behaves exactly as before", async () => {
    const { punchRepo } = rawWorld();
    const { meta, data } = await buildRaw(punchRepo, null).list(RANGE);
    assert.equal(meta.no_shift_punches, 5);
    assert.deepEqual(data.map((r) => r.employee_id), [60]);
  });
});

describe("Punch Audit", () => {
  it("the stored NO_SHIFT is kept, but a Present/Absent Only date is SHOWN as the mode", async () => {
    const { punchRepo, modeRepo } = rawWorld();
    const { data } = await buildRaw(punchRepo, null, modeRepo).audit(RANGE);
    const byId = new Map(data.map((p) => [p.biomax_punch_id, p]));
    assert.equal(byId.get(2).derivation_status, "NO_SHIFT", "the raw value is untouched");
    assert.equal(byId.get(2).derivation_display, "Attendance Mode: Present/Absent Only");
    assert.equal(byId.get(1).derivation_display, null, "Shift Based: still a no-shift fault");
    assert.equal(byId.get(3).derivation_display, null, "01/10 is before 52's effective date");
    assert.equal(byId.get(4).derivation_display, "Attendance Mode: Present/Absent Only");
  });

  it("the review queue and the NO_SHIFT issue list leave Present/Absent Only punches out - except a device problem", async () => {
    const { punchRepo, modeRepo } = rawWorld();
    const raw = buildRaw(punchRepo, null, modeRepo);
    const review = await raw.audit({ ...RANGE, review: "needs_review" });
    // 1 and 3 are genuine no-shift faults; 5 stays for its device.
    assert.deepEqual(review.data.map((p) => p.biomax_punch_id).sort(), [1, 3, 5]);
    const issue = await raw.audit({ ...RANGE, issue: "NO_SHIFT" });
    assert.deepEqual(issue.data.map((p) => p.biomax_punch_id).sort(), [1, 3]);
  });

  it("the CSV's Derivation Status says the mode, never NO_SHIFT, for those punches", async () => {
    const { punchRepo, modeRepo } = rawWorld();
    const { header, rows } = await buildRaw(punchRepo, null, modeRepo).auditCsv(RANGE);
    const col = header.indexOf("Derivation Status");
    const idCol = header.indexOf("Punch ID");
    const byId = new Map(rows.map((r) => [r[idCol], r[col]]));
    assert.equal(byId.get("2"), "Attendance Mode: Present/Absent Only");
    assert.equal(byId.get("1"), "NO_SHIFT");
  });
});
