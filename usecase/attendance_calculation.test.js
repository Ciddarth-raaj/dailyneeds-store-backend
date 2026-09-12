/**
 * Attendance v2 - the orchestration between the repository and the pure
 * engines, against a fake repository.
 *
 * No MySQL. The fake returns exactly what the real repository's queries
 * return (dates as `YYYY-MM-DD`, times as `YYYY-MM-DD HH:MM:SS` strings, which
 * is what DATE_FORMAT produces), so what is exercised here is the wiring: that
 * the right shift is resolved for each date, that a break override reaches the
 * engine, that only APPROVED OT is consumed, and that the month rolls up from
 * the days rather than from a second calculation.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildUsecase = require("../usecase/attendance_calculation");
const { CALC_STATUS } = require("../utils/attendance_engine");

/** A 09:00-21:00, 60 minute break, seven-day working schedule. */
const scheduleRows = (workShiftId, overrides = {}) =>
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
    ...overrides,
  }));

function fakeRepo(state = {}) {
  const saved = { calculations: [], monthly: [] };
  return {
    saved,
    getShiftAssignmentHistory: async () =>
      state.assignments || [
        {
          employee_work_shift_assignment_id: 1,
          employee_id: 42,
          work_shift_id: 7,
          effective_from: "2026-09-01",
          source: "MIGRATION_BACKFILL",
        },
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
        ...(state.shiftConfig || {}),
      },
      schedule: (state.schedules && state.schedules[id]) || scheduleRows(id),
    }),
    getRawPunches: async () => state.rawPunches || [],
    getApprovedRegularizedPunches: async () => state.regularized || [],
    getBreakOverrides: async () => state.overrides || [],
    getApprovalStateByDate: async () => state.approvals || [],
    getEmploymentWindow: async () =>
      state.employment === undefined
        ? { employee_id: 42, status: 1, date_of_joining: "2020-01-01", resignation_date: null }
        : state.employment,
    getMonthlyGrossAsOf: async () =>
      state.salary === undefined
        ? { salary_id: 9, monthly_gross: "26000.00", effective_from: "2026-04-01" }
        : state.salary,
    saveCalculations: async (rows) => {
      saved.calculations.push(rows);
      return { written: rows.length };
    },
    saveMonthlyPayroll: async (row) => {
      saved.monthly.push(row);
      return [];
    },
  };
}

const punch = (id, ioTime) => ({
  punch_id: id,
  employee_id: 42,
  attendance_date: ioTime.slice(0, 10),
  io_time: ioTime,
  dev_id: "C26924B2E7351O35",
  ingest_source: "DEVICE",
});

describe("calculating a range", () => {
  it("returns one row per date, present or not", async () => {
    const usecase = buildUsecase(fakeRepo());
    const days = await usecase.calculateRange({
      employee_id: 42,
      from_date: "2026-09-14",
      to_date: "2026-09-16",
    });
    assert.equal(days.length, 3);
    assert.deepEqual(days.map((d) => d.attendance_date), [
      "2026-09-14",
      "2026-09-15",
      "2026-09-16",
    ]);
    days.forEach((d) => assert.equal(d.status, CALC_STATUS.ABSENT));
  });

  it("calculates worked minutes from the punches of that date only", async () => {
    const usecase = buildUsecase(
      fakeRepo({
        rawPunches: [
          punch(1, "2026-09-14 09:00:00"),
          punch(2, "2026-09-14 21:00:00"),
          punch(3, "2026-09-15 09:00:00"),
          punch(4, "2026-09-15 15:30:00"),
        ],
      })
    );
    const days = await usecase.calculateRange({
      employee_id: 42,
      from_date: "2026-09-14",
      to_date: "2026-09-15",
    });

    assert.equal(days[0].worked_minutes, 660);
    assert.equal(days[1].worked_minutes, 360);
    assert.equal(days[1].shortage_minutes, 300);
  });

  it("resolves the shift that applied on each date, not the current one", async () => {
    const usecase = buildUsecase(
      fakeRepo({
        assignments: [
          { employee_work_shift_assignment_id: 1, work_shift_id: 7, effective_from: "2026-09-01" },
          { employee_work_shift_assignment_id: 2, work_shift_id: 9, effective_from: "2026-09-15" },
        ],
      })
    );
    const days = await usecase.calculateRange({
      employee_id: 42,
      from_date: "2026-09-14",
      to_date: "2026-09-15",
    });

    assert.equal(days[0].work_shift_id, 7);
    assert.equal(days[1].work_shift_id, 9);
  });

  it("produces no numbers for a date before the first assignment", async () => {
    const usecase = buildUsecase(fakeRepo());
    const [day] = await usecase.calculateRange({
      employee_id: 42,
      from_date: "2026-08-31",
      to_date: "2026-08-31",
    });
    assert.equal(day.status, CALC_STATUS.NO_SHIFT_FOR_DATE);
    assert.equal(day.nrm_minutes, 0);
    assert.equal(day.is_final, false);
  });

  it("applies an employee break override that covers the date, and not one that does not", async () => {
    const usecase = buildUsecase(
      fakeRepo({
        rawPunches: [punch(1, "2026-09-14 09:00:00"), punch(2, "2026-09-14 21:00:00")],
        overrides: [
          {
            employee_break_override_id: 1,
            break_minutes: 90,
            effective_from: "2026-09-10",
            effective_to: "2026-09-14",
          },
        ],
      })
    );

    const [covered] = await usecase.calculateRange({
      employee_id: 42,
      from_date: "2026-09-14",
      to_date: "2026-09-14",
    });
    assert.equal(covered.nrm_minutes, 630);
    assert.equal(covered.break_allowance_source, "EMPLOYEE_OVERRIDE");

    const [after] = await usecase.calculateRange({
      employee_id: 42,
      from_date: "2026-09-15",
      to_date: "2026-09-15",
    });
    assert.equal(after.nrm_minutes, 660);
    assert.equal(after.break_allowance_source, "SHIFT");
  });

  it("consumes only FULLY APPROVED OT, never a pending figure", async () => {
    const punches = [
      punch(1, "2026-09-14 09:00:00"),
      punch(2, "2026-09-14 13:00:00"),
      punch(3, "2026-09-14 13:45:00"),
      punch(4, "2026-09-14 21:00:00"),
    ];

    const pending = buildUsecase(
      fakeRepo({
        rawPunches: punches,
        approvals: [
          {
            attendance_approval_request_id: 5,
            attendance_date: "2026-09-14",
            request_type: "OT",
            status: "PENDING",
            candidate_ot_minutes: 15,
            approved_ot_minutes: null,
          },
        ],
      })
    );
    const [held] = await pending.calculateRange({
      employee_id: 42,
      from_date: "2026-09-14",
      to_date: "2026-09-14",
    });
    assert.equal(held.candidate_ot_minutes, 15);
    assert.equal(held.approved_ot_minutes, 0);
    assert.equal(held.status, CALC_STATUS.REGULARIZATION_PENDING);
    assert.equal(held.is_final, false);

    const approved = buildUsecase(
      fakeRepo({
        rawPunches: punches,
        approvals: [
          {
            attendance_approval_request_id: 5,
            attendance_date: "2026-09-14",
            request_type: "OT",
            status: "APPROVED",
            candidate_ot_minutes: 15,
            approved_ot_minutes: 15,
          },
        ],
      })
    );
    const [settled] = await approved.calculateRange({
      employee_id: 42,
      from_date: "2026-09-14",
      to_date: "2026-09-14",
    });
    assert.equal(settled.approved_ot_minutes, 15);
    assert.equal(settled.status, CALC_STATUS.FINAL);
  });

  it("completes an odd punch count with an approved regularized punch", async () => {
    const usecase = buildUsecase(
      fakeRepo({
        rawPunches: [punch(1, "2026-09-14 09:00:00")],
        regularized: [
          {
            punch_id: 500,
            employee_id: 42,
            attendance_date: "2026-09-14",
            io_time: "2026-09-14 21:00:00",
            punch_source: "REGULARIZED",
          },
        ],
      })
    );
    const [day] = await usecase.calculateRange({
      employee_id: 42,
      from_date: "2026-09-14",
      to_date: "2026-09-14",
    });

    assert.equal(day.punch_count, 2);
    assert.deepEqual(day.raw_punch_ids, [1], "the raw punch list is unchanged");
    assert.equal(day.worked_minutes, 660);
    assert.equal(day.status, CALC_STATUS.FINAL);
  });

  it("refuses a range longer than the cap, and a backwards one", async () => {
    const usecase = buildUsecase(fakeRepo());
    await assert.rejects(
      usecase.calculateRange({ employee_id: 42, from_date: "2026-01-01", to_date: "2026-12-31" }),
      /at most/
    );
    await assert.rejects(
      usecase.calculateRange({ employee_id: 42, from_date: "2026-09-15", to_date: "2026-09-14" }),
      /must not be after/
    );
  });
});

describe("storing a calculation", () => {
  it("writes one row per date, with the JSON columns stringified", async () => {
    const repo = fakeRepo({
      rawPunches: [punch(1, "2026-09-14 09:00:00"), punch(2, "2026-09-14 21:00:00")],
    });
    const usecase = buildUsecase(repo);
    await usecase.recalculateRange({
      employee_id: 42,
      from_date: "2026-09-14",
      to_date: "2026-09-14",
    });

    const [batch] = repo.saved.calculations;
    assert.equal(batch.length, 1);
    assert.equal(typeof batch[0].shift_snapshot, "string");
    assert.deepEqual(JSON.parse(batch[0].raw_punch_ids), [1, 2]);
    assert.equal(batch[0].is_final, 1);
    assert.equal(batch[0].worked_minutes, 660);
  });

  it("is deterministic, so a second run writes identical rows", async () => {
    const state = {
      rawPunches: [punch(1, "2026-09-14 09:00:00"), punch(2, "2026-09-14 21:00:00")],
    };
    const repo = fakeRepo(state);
    const usecase = buildUsecase(repo);
    await usecase.recalculateRange({ employee_id: 42, from_date: "2026-09-14", to_date: "2026-09-14" });
    await usecase.recalculateRange({ employee_id: 42, from_date: "2026-09-14", to_date: "2026-09-14" });

    assert.deepEqual(repo.saved.calculations[0], repo.saved.calculations[1]);
  });
});

describe("the monthly roll-up", () => {
  const fullMonth = () => {
    const rows = [];
    for (let d = 1; d <= 30; d += 1) {
      const date = `2026-09-${String(d).padStart(2, "0")}`;
      rows.push(punch(d * 2 - 1, `${date} 09:00:00`));
      rows.push(punch(d * 2, `${date} 21:00:00`));
    }
    return rows;
  };

  it("rolls thirty attended days into 26 salary days and 4 extra days", async () => {
    const usecase = buildUsecase(fakeRepo({ rawPunches: fullMonth() }));
    const result = await usecase.calculateMonth({ employee_id: 42, year: 2026, month: 9 });

    assert.equal(result.available_dates, 30);
    assert.equal(result.notional_offs, 4);
    assert.equal(result.base_days, 26);
    assert.equal(result.attendance_days, 30);
    assert.equal(result.salary_days, 26);
    assert.equal(result.extra_days, 4);
    assert.equal(result.daily_rate, 1000);
    assert.equal(result.salary_earnings, 26000);
    assert.equal(result.extra_day_earnings, 4000);
    assert.equal(result.statutory_base_earnings, 26000);
    assert.equal(result.total_attendance_payable, 30000);
    assert.equal(result.salary_record_id, 9);
  });

  it("bounds the window by the joining date", async () => {
    const usecase = buildUsecase(
      fakeRepo({
        rawPunches: fullMonth(),
        employment: { employee_id: 42, status: 1, date_of_joining: "2026-09-16", resignation_date: null },
      })
    );
    const result = await usecase.calculateMonth({ employee_id: 42, year: 2026, month: 9 });
    assert.equal(result.available_dates, 15);
    assert.equal(result.base_days, 13);
    assert.equal(result.salary_days, 13);
  });

  it("stores the month and its days only when asked to", async () => {
    const repo = fakeRepo({ rawPunches: fullMonth() });
    const usecase = buildUsecase(repo);

    await usecase.calculateMonth({ employee_id: 42, year: 2026, month: 9 });
    assert.equal(repo.saved.monthly.length, 0);
    assert.equal(repo.saved.calculations.length, 0);

    await usecase.calculateMonth({ employee_id: 42, year: 2026, month: 9, persist: true });
    assert.equal(repo.saved.monthly.length, 1);
    assert.equal(repo.saved.calculations.length, 1);
    assert.equal(repo.saved.monthly[0].salary_days, 26);
    assert.equal(typeof repo.saved.monthly[0].held_dates, "string");
  });

  it("reports no salary as null rather than as a month of nil pay", async () => {
    const usecase = buildUsecase(fakeRepo({ rawPunches: fullMonth(), salary: null }));
    const result = await usecase.calculateMonth({ employee_id: 42, year: 2026, month: 9 });
    assert.equal(result.daily_rate, null);
    assert.equal(result.total_attendance_payable, null);
    assert.equal(result.attendance_days, 30);
  });

  it("refuses a month outside 1-12", async () => {
    const usecase = buildUsecase(fakeRepo());
    await assert.rejects(
      usecase.calculateMonth({ employee_id: 42, year: 2026, month: 13 }),
      /month 1-12/
    );
  });
});
