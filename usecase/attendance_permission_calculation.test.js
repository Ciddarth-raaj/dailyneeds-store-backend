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
