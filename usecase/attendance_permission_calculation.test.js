/**
 * PERMISSION through the real calculation usecase, against a fake repository.
 *
 * Proves the wiring rather than the arithmetic (that is
 * `utils/attendance_permission.test.js`): which permission rows reach the
 * engine in which state, that a PERMISSION request never holds a date as a
 * pending correction, that an in-transaction change is calculated as it will
 * read once committed, and that the stored row carries what was applied.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildUsecase = require("./attendance_calculation");
const { CALC_STATUS } = require("../utils/attendance_engine");

const DATE = "2026-09-14";
const EMP = 42;

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

function fakeRepo(state = {}) {
  const saved = { calculations: [] };
  return {
    saved,
    getShiftAssignmentHistory: async () => [
      { employee_work_shift_assignment_id: 1, employee_id: EMP, work_shift_id: 7, effective_from: "2026-09-01", source: "MIGRATION_BACKFILL" },
    ],
    getWorkShiftWithSchedule: async (id) => ({
      config: {
        work_shift_id: id,
        shift_code: `S${id}`,
        overtime_allowed: 1,
        overtime_minimum_minutes: 0,
        overtime_rounding_method: "NONE",
        overtime_rounding_interval_minutes: 0,
        overtime_minimum_threshold_only: 0,
        maximum_ot_minutes_per_day: null,
      },
      schedule: scheduleRows(id),
    }),
    getWorkShiftConfigVersions: async () => [],
    getRawPunchesByCalendarWindow: async (_e, from, to) =>
      (state.rawPunches || []).filter((p) => {
        const day = String(p.io_time).slice(0, 10);
        return day >= from && day <= to;
      }),
    getApprovedRegularizedPunches: async () => [],
    getBreakOverride: async () => ({ employee_id: EMP, special_break_override_minutes: null }),
    getApprovalStateByDate: async () => state.approvals || [],
    getPermissionsForRange: async () => state.permissions || [],
    getEmploymentWindow: async () => ({ employee_id: EMP, status: 1, date_of_joining: "2020-01-01", resignation_date: null }),
    getMonthlyGrossAsOf: async () => ({ salary_id: 9, monthly_gross: "26000.00", effective_from: "2026-04-01" }),
    saveCalculationsWithReconciliation: async ({ rows }) => {
      saved.calculations.push(rows);
      return { written: rows.length, stale_removed: 0 };
    },
    saveMonthWithPayroll: async ({ rows, monthly }) => {
      saved.calculations.push(rows);
      saved.monthly = monthly;
      return { written: (rows || []).length, monthly_written: monthly ? 1 : 0 };
    },
  };
}

const punch = (id, ioTime) => ({
  punch_id: id,
  employee_id: EMP,
  attendance_date: ioTime.slice(0, 10),
  io_time: ioTime,
  dev_id: "D1",
  ingest_source: "LIVE",
});
const LEFT_AT_20 = [punch(1, `${DATE} 10:00:00`), punch(2, `${DATE} 20:00:00`)];

const direct = (over = {}) => ({
  attendance_permission_id: 11,
  employee_id: EMP,
  attendance_date: DATE,
  permission_from: `${DATE} 20:00:00`,
  permission_to: `${DATE} 22:00:00`,
  to_shift_end: 1,
  permission_minutes: 120,
  reason: "Festival early release",
  source: "DIRECT",
  attendance_approval_request_id: null,
  bulk_operation_id: "op-1",
  revoked_at: null,
  ...over,
});
const requested = (status, over = {}) =>
  direct({
    attendance_permission_id: 12,
    source: "REQUEST",
    attendance_approval_request_id: 77,
    bulk_operation_id: null,
    request_status: status,
    finalization_state: status === "APPROVED" ? "SETTLED" : "NOT_REQUIRED",
    ...over,
  });

const one = async (state, extra = {}) => {
  const usecase = buildUsecase(fakeRepo(state));
  const [day] = await usecase.calculateRange({ employee_id: EMP, from_date: DATE, to_date: DATE, ...extra });
  return day;
};

describe("which permission rows reach the calculation", () => {
  it("an unrevoked DIRECT grant is applied; worked stays what was worked", async () => {
    const day = await one({ rawPunches: LEFT_AT_20, permissions: [direct()] });
    assert.equal(day.worked_minutes, 540);
    assert.equal(day.permission_minutes, 120);
    assert.equal(day.shortage_minutes, 0);
    assert.equal(day.shortage_before_permission_minutes, 120);
    assert.equal(day.payable_minutes, 660);
    assert.deepEqual(day.permission_ids, [11]);
    assert.equal(day.permissions.length, 1);
    assert.equal(day.permissions[0].state, "APPROVED");
    assert.equal(day.permissions[0].from_time, "20:00");
    assert.equal(day.permissions[0].to_shift_end, true);
  });

  it("a REVOKED DIRECT grant is shown and not applied", async () => {
    const day = await one({ rawPunches: LEFT_AT_20, permissions: [direct({ revoked_at: "2026-09-14 12:00:00" })] });
    assert.equal(day.permission_minutes, 0);
    assert.equal(day.shortage_minutes, 120);
    assert.equal(day.permissions[0].state, "REVOKED");
  });

  it("an APPROVED + SETTLED request is applied; APPROVED but unsettled is not", async () => {
    assert.equal((await one({ rawPunches: LEFT_AT_20, permissions: [requested("APPROVED")] })).permission_minutes, 120);
    const unsettled = await one({
      rawPunches: LEFT_AT_20,
      permissions: [requested("APPROVED", { finalization_state: "PENDING" })],
    });
    assert.equal(unsettled.permission_minutes, 0);
  });

  it("a REJECTED or payroll-closed request is shown and not applied", async () => {
    const closed = await one({
      rawPunches: LEFT_AT_20,
      permissions: [requested("REJECTED", { closure_reason: "NOT_APPROVED_BEFORE_PAYROLL_LOCK" })],
    });
    assert.equal(closed.permission_minutes, 0);
    assert.equal(closed.permissions[0].state, "CLOSED_AT_PAYROLL_LOCK");
  });
});

describe("A PENDING PERMISSION REQUEST IS NOT A PENDING CORRECTION", () => {
  it("the date stays FINAL and is charged; the request is shown as pending", async () => {
    const day = await one({
      rawPunches: LEFT_AT_20,
      approvals: [
        { attendance_approval_request_id: 77, attendance_date: DATE, request_type: "PERMISSION", status: "PENDING", finalization_state: "NOT_REQUIRED" },
      ],
      permissions: [requested("PENDING")],
    });
    assert.equal(day.status, CALC_STATUS.FINAL, "not REGULARIZATION_PENDING");
    assert.equal(day.is_final, true);
    assert.equal(day.correction_state === "PENDING", false);
    assert.equal(day.shortage_minutes, 120);
    assert.equal(day.permissions[0].state, "PENDING");
  });

  it("an approved PERMISSION request never masquerades as the date's correction", async () => {
    const day = await one({
      rawPunches: LEFT_AT_20,
      approvals: [
        { attendance_approval_request_id: 77, attendance_date: DATE, request_type: "PERMISSION", status: "APPROVED", finalization_state: "SETTLED" },
      ],
      permissions: [requested("APPROVED")],
    });
    assert.equal(day.approval_request_id, null);
    assert.equal(day.status, CALC_STATUS.FINAL);
  });
});

describe("a change committed in the caller's own transaction", () => {
  it("assume APPROVED on the PERMISSION request applies its windows before the row says so", async () => {
    const day = await one(
      { rawPunches: LEFT_AT_20, permissions: [requested("PENDING")] },
      { assume: { attendance_date: DATE, request_type: "PERMISSION", status: "APPROVED", attendance_approval_request_id: 77 } }
    );
    assert.equal(day.permission_minutes, 120);
    assert.equal(day.status, CALC_STATUS.FINAL);
  });

  it("exclude_request_id withdraws an approved request's windows (a revoke)", async () => {
    const day = await one({ rawPunches: LEFT_AT_20, permissions: [requested("APPROVED")] }, { exclude_request_id: 77 });
    assert.equal(day.permission_minutes, 0);
    assert.equal(day.permissions[0].state, "REVOKED");
  });

  it("assume_permissions.add grants, assume_permissions.exclude_ids revokes", async () => {
    const granted = await one(
      { rawPunches: LEFT_AT_20, permissions: [] },
      { assume_permissions: { add: [direct({ attendance_permission_id: null })] } }
    );
    assert.equal(granted.permission_minutes, 120);
    const revoked = await one({ rawPunches: LEFT_AT_20, permissions: [direct()] }, { assume_permissions: { exclude_ids: [11] } });
    assert.equal(revoked.permission_minutes, 0);
  });
});

describe("what is stored", () => {
  it("the stored row carries the permission figures beside the unchanged worked minutes", async () => {
    const repo = fakeRepo({ rawPunches: LEFT_AT_20, permissions: [direct()] });
    const usecase = buildUsecase(repo);
    const [day] = await usecase.calculateRange({ employee_id: EMP, from_date: DATE, to_date: DATE });
    const row = usecase.toStorageRow(day);
    assert.equal(row.worked_minutes, 540);
    assert.equal(row.shortage_minutes, 0);
    assert.equal(row.permission_minutes, 120);
    assert.equal(row.permission_early_minutes, 120);
    assert.equal(row.shortage_before_permission_minutes, 120);
    assert.equal(row.payable_minutes, 660);
    assert.equal(row.permission_ids, "[11]");
    assert.equal(row.calculation_version, 11);
  });
});

/* ======== the monthly summary carries the APPLIED Permission, never NULL === */

describe("calculateMonth(persist=true): the monthly permission_minutes", () => {
  const { MONTHLY_PAYROLL_COLUMNS } = require("../repository/attendance_calculation");
  const { computeMonthlyAttendancePayroll } = require("../utils/attendance_payroll");
  // After September has closed, so every date is stored and final.
  const AFTER_MONTH = new Date("2026-10-05T00:00:00+05:30");
  const leftAt20 = (date, id) => [punch(id, `${date} 10:00:00`), punch(id + 1, `${date} 20:00:00`)];
  const window = (id, date, from, to, over = {}) =>
    direct({
      attendance_permission_id: id,
      attendance_date: date,
      permission_from: `${date} ${from}:00`,
      permission_to: `${date} ${to}:00`,
      to_shift_end: to === "22:00" ? 1 : 0,
      permission_minutes: (Number(to.slice(0, 2)) * 60 + Number(to.slice(3))) - (Number(from.slice(0, 2)) * 60 + Number(from.slice(3))),
      ...over,
    });

  const persistMonth = async (state) => {
    const repo = fakeRepo(state);
    const result = await buildUsecase(repo).calculateMonth({ employee_id: EMP, year: 2026, month: 9, persist: true, now: AFTER_MONTH });
    return { result, monthly: repo.saved.monthly, days: result.days };
  };

  it("1. no Permission in the month: stored as 0, not NULL", async () => {
    const { monthly } = await persistMonth({ rawPunches: leftAt20("2026-09-14", 1) });
    assert.equal(monthly.permission_minutes, 0);
  });

  it("every column the month write sends is supplied (only the fingerprint is the repository's)", async () => {
    const { monthly } = await persistMonth({ rawPunches: leftAt20("2026-09-14", 1) });
    for (const col of MONTHLY_PAYROLL_COLUMNS.filter((c) => c !== "day_rows_fingerprint")) {
      assert.notEqual(monthly[col], undefined, `${col} is missing from the monthly row`);
    }
  });

  it("2. Permission on one day: the month carries that day's applied minutes", async () => {
    const { monthly, days } = await persistMonth({ rawPunches: leftAt20(DATE, 1), permissions: [direct()] });
    const applied = days.find((d) => d.attendance_date === DATE).permission_minutes;
    assert.equal(applied, 120);
    assert.equal(monthly.permission_minutes, 120);
  });

  it("3. Permission on several days: the sum of applied minutes; revoked, rejected and pending add nothing", async () => {
    const { monthly, days } = await persistMonth({
      rawPunches: [
        ...leftAt20("2026-09-14", 1),
        ...leftAt20("2026-09-15", 3),
        ...leftAt20("2026-09-16", 5),
        ...leftAt20("2026-09-17", 7),
      ],
      permissions: [
        window(21, "2026-09-14", "20:00", "22:00"),
        window(22, "2026-09-15", "21:00", "22:00"),
        window(23, "2026-09-16", "21:30", "22:00"),
        window(24, "2026-09-17", "20:00", "22:00", { revoked_at: "2026-09-17 12:00:00" }),
        requested("REJECTED", { attendance_permission_id: 25, attendance_date: "2026-09-17", permission_from: "2026-09-17 20:00:00", permission_to: "2026-09-17 22:00:00" }),
        requested("PENDING", { attendance_permission_id: 26, attendance_date: "2026-09-17", permission_from: "2026-09-17 20:00:00", permission_to: "2026-09-17 22:00:00" }),
      ],
    });
    const byDate = Object.fromEntries(days.map((d) => [d.attendance_date, d.permission_minutes]));
    assert.deepEqual([byDate["2026-09-14"], byDate["2026-09-15"], byDate["2026-09-16"], byDate["2026-09-17"]], [120, 60, 30, 0]);
    assert.equal(monthly.permission_minutes, 210);
  });

  it("4. more requested than chargeable: only the engine-applied minutes count", async () => {
    // 18:00-22:00 is 240 minutes of window, but she worked until 20:00:
    // only the 120 minutes of actual shortage can be forgiven.
    const { monthly, days } = await persistMonth({ rawPunches: leftAt20(DATE, 1), permissions: [window(31, DATE, "18:00", "22:00")] });
    const day = days.find((d) => d.attendance_date === DATE);
    assert.equal(day.permission_window_minutes, 240);
    assert.equal(day.permission_minutes, 120);
    assert.equal(monthly.permission_minutes, 120);
  });

  it("5. every other monthly figure is exactly the payroll roll-up's, as before", async () => {
    for (const state of [
      { rawPunches: leftAt20(DATE, 1) },
      { rawPunches: leftAt20(DATE, 1), permissions: [direct()] },
    ]) {
      const { result, monthly, days } = await persistMonth(state);
      const payroll = computeMonthlyAttendancePayroll({
        employee_id: EMP, year: 2026, month: 9, monthly_gross: "26000.00", days,
        joined_on: "2020-01-01", ended_on: null, attendance_required: true,
      });
      for (const col of [
        "available_from", "available_to", "available_dates", "notional_offs", "base_days", "attendance_days",
        "salary_days", "extra_days", "monthly_gross", "daily_rate", "salary_day_earnings", "extra_day_earnings",
        "shortage_minutes", "missing_minute_deduction", "approved_ot_minutes", "approved_ot_earnings",
        "total_attendance_payable", "permission_minutes",
      ]) {
        assert.deepEqual(monthly[col], payroll[col], col);
        assert.deepEqual(monthly[col], result[col], `${col} as returned`);
      }
      assert.equal(monthly.held_dates, JSON.stringify(payroll.held_dates || []));
    }
  });

  it("the Permission lowers the monthly shortage and leaves worked minutes and OT alone", async () => {
    const without = await persistMonth({ rawPunches: leftAt20(DATE, 1) });
    const withIt = await persistMonth({ rawPunches: leftAt20(DATE, 1), permissions: [direct()] });
    assert.equal(without.monthly.shortage_minutes - withIt.monthly.shortage_minutes, 120);
    assert.equal(withIt.monthly.approved_ot_minutes, without.monthly.approved_ot_minutes);
    const worked = (r) => r.days.reduce((n, d) => n + (d.worked_minutes || 0), 0);
    assert.equal(worked(withIt), worked(without));
  });
});
