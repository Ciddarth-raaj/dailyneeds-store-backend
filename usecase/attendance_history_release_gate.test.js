/**
 * THE RELEASE GATE: stored history is what a read returns, and a locked month
 * cannot be touched.
 *
 *   node --test usecase/attendance_history_release_gate.test.js
 *
 * The whole sequence the release turns on, run end to end against an
 * in-memory world:
 *
 *   1  the employee has no Extra Break Hours
 *   2  a historical four-punch day is calculated and STORED
 *   3  its allowance and NRM are recorded
 *   4  HR sets Extra Break Hours to 0.50
 *   5  a normal READ still returns the stored allowance and NRM
 *   6  a LIVE preview shows what a recalculation would produce
 *   7  an explicit Recalculate on an UNLOCKED month persists the new figures
 *   8  the normal read now returns those
 *   9  the month is locked
 *  10  Extra Break Hours changes again
 *  11  the normal read still returns the stored history
 *  12  Recalculate is REFUSED
 *  13  the stored row is byte-for-byte what it was
 *
 * The lock itself is enforced in the repository, on the connection, in front
 * of every write - `attendance_payroll_lock.test.js` drives the real SQL gate
 * against a fake connection. Here the fake repository refuses with the same
 * error, so this file can prove what the USECASE and the read paths do about
 * it.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildUsecase = require("./attendance_calculation");
const { CALCULATION_SOURCE } = require("../utils/attendance_stored_read");
const { payrollLockedError, periodsTouched } = require("../utils/attendance_payroll_lock");

/** A fixed "now": mid-September, so every August date has long since closed. */
const NOW = Date.parse("2026-09-18T12:00:00+05:30");

/** The historical date under test, and its four punches. */
const DATE = "2026-08-10"; // a Monday
const PUNCHES = [
  ["09:00:00", 1],
  ["13:00:00", 2],
  ["14:30:00", 3],
  ["21:00:00", 4],
].map(([time, id]) => ({
  punch_id: id,
  employee_id: 42,
  attendance_date: DATE,
  io_time: `${DATE} ${time}`,
  dev_id: "C26924B2E7351O35",
  ingest_source: "DEVICE",
}));

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

/**
 * One in-memory world: the employee row HR edits, the stored attendance
 * table, and the payrun's lock.
 */
function world() {
  const state = {
    employee: {
      employee_id: 42,
      special_break_override_minutes: null,
      extra_break_hours: null,
      attendance_required: 1,
    },
    storedByDate: new Map(),
    lockedMonths: new Set(), // "2026-8"
  };

  const assertNotLocked = (rows) => {
    const { periods } = periodsTouched(rows);
    const hits = periods.filter((p) => state.lockedMonths.has(`${p.year}-${p.month}`));
    // THE SAME ERROR THE REPOSITORY GATE RAISES. The usecase does not catch
    // it, so what a caller sees here is what they see in production.
    if (hits.length > 0) throw payrollLockedError(hits);
  };

  const repo = {
    state,
    getShiftAssignmentHistory: async () => [
      {
        employee_work_shift_assignment_id: 1,
        employee_id: 42,
        work_shift_id: 7,
        effective_from: "2026-01-01",
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
      },
      schedule: schedule(id),
    }),
    getWorkShiftConfigVersions: async () => [],
    getRawPunchesByCalendarWindow: async (_id, from, to) =>
      PUNCHES.filter((p) => {
        const day = String(p.io_time).slice(0, 10);
        return day >= from && day <= to;
      }),
    getApprovedRegularizedPunches: async () => [],
    getApprovalStateByDate: async () => [],
    getBreakOverride: async () => ({ ...state.employee }),
    getEmploymentWindow: async () => ({
      employee_id: 42,
      status: 1,
      attendance_required: 1,
      date_of_joining: "2020-01-01",
      resignation_date: null,
    }),
    getMonthlyGrossAsOf: async () => null,
    getDateShiftOverrides: async () => [],

    /** The stored table, read the way the real repository reads it. */
    listCalculations: async ({ from_date, to_date }) =>
      [...state.storedByDate.values()]
        .filter((r) => r.attendance_date >= from_date && r.attendance_date <= to_date)
        .sort((a, b) => (a.attendance_date < b.attendance_date ? -1 : 1))
        .map((r) => ({ ...r })),

    saveCalculationsWithReconciliation: async ({ rows, ineligible_dates }) => {
      assertNotLocked(rows);
      assertNotLocked(
        (ineligible_dates || []).map((date) => ({ employee_id: 42, attendance_date: date }))
      );
      rows.forEach((row) => state.storedByDate.set(row.attendance_date, { ...row }));
      return { written: rows.length, stale_removed: 0 };
    },
    saveCalculations: async (rows) => {
      assertNotLocked(rows);
      rows.forEach((row) => state.storedByDate.set(row.attendance_date, { ...row }));
      return { written: rows.length };
    },
    // The month, persisted as one thing - and gated by the same lock, because
    // the real repository takes it once and holds it across both writes.
    saveMonthWithPayroll: async ({ employee_id, period_year, period_month, rows, monthly }) => {
      assertNotLocked([
        { employee_id, attendance_date: `${period_year}-${String(period_month).padStart(2, "0")}-01` },
        ...rows,
      ]);
      rows.forEach((row) => state.storedByDate.set(row.attendance_date, { ...row }));
      if (monthly) state.monthly = { ...monthly };
      return { written: rows.length, monthly_written: monthly ? 1 : 0 };
    },
  };

  return { state, repo, usecase: buildUsecase(repo) };
}

const readDay = async (usecase) => {
  const days = await usecase.readRange({
    employee_id: 42,
    from_date: DATE,
    to_date: DATE,
    now: NOW,
  });
  return days[0];
};

const previewDay = async (usecase) => {
  const days = await usecase.calculateRange({ employee_id: 42, from_date: DATE, to_date: DATE });
  return days[0];
};

describe("THE RELEASE GATE - a stored historical date is not restated by an Employee Master edit", () => {
  it("runs the whole sequence", async () => {
    const { state, usecase } = world();

    /* 1-2. no Extra Break Hours, and the date is calculated and STORED. */
    assert.equal(state.employee.extra_break_hours, null);
    await usecase.recalculateRange({ employee_id: 42, from_date: DATE, to_date: DATE });

    /* 3. what was stored. */
    const stored = state.storedByDate.get(DATE);
    assert.equal(stored.break_allowance_minutes, 60, "the shift's own break");
    assert.equal(stored.nrm_minutes, 660);
    assert.equal(stored.extra_break_minutes_applied, 0, "provenance: nothing extra was applied");
    assert.equal(stored.break_override_minutes_applied, null, "provenance: no override applied");
    const storedJson = JSON.stringify(stored);

    const before = await readDay(usecase);
    assert.equal(before.calculation_source, CALCULATION_SOURCE.STORED);
    assert.equal(before.break_allowance_minutes, 60);
    assert.equal(before.nrm_minutes, 660);

    /* 4. HR sets Extra Break Hours to 0.50. */
    state.employee.extra_break_hours = "0.50";

    /* 5. THE READ IS UNMOVED. This is the release blocker, proven fixed. */
    const after = await readDay(usecase);
    assert.equal(after.calculation_source, CALCULATION_SOURCE.STORED);
    assert.equal(after.break_allowance_minutes, 60, "a settled date is not restated by an edit");
    assert.equal(after.nrm_minutes, 660);
    assert.equal(after.worked_minutes, before.worked_minutes);
    assert.equal(after.shortage_minutes, before.shortage_minutes);
    assert.equal(after.candidate_ot_minutes, before.candidate_ot_minutes);
    assert.equal(after.status, before.status);
    assert.equal(JSON.stringify(state.storedByDate.get(DATE)), storedJson, "and nothing was written");

    /* 6. THE PREVIEW SHOWS WHAT A RECALCULATION WOULD DO. */
    const preview = await previewDay(usecase);
    assert.equal(preview.calculation_source, CALCULATION_SOURCE.LIVE_PREVIEW);
    assert.equal(preview.break_allowance_minutes, 90, "60 + the new 30");
    assert.equal(preview.nrm_minutes, 630);
    assert.equal(JSON.stringify(state.storedByDate.get(DATE)), storedJson, "a preview stores nothing");

    /* 7. EXPLICIT RECALCULATE on an unlocked month persists the new figures. */
    await usecase.recalculateRange({ employee_id: 42, from_date: DATE, to_date: DATE });
    const restored = state.storedByDate.get(DATE);
    assert.equal(restored.break_allowance_minutes, 90);
    assert.equal(restored.nrm_minutes, 630);
    assert.equal(restored.extra_break_minutes_applied, 30, "provenance: 30 minutes were applied");
    assert.equal(restored.break_override_minutes_applied, null);

    /* 8. and the normal read now returns THOSE. */
    const afterRecalc = await readDay(usecase);
    assert.equal(afterRecalc.calculation_source, CALCULATION_SOURCE.STORED);
    assert.equal(afterRecalc.break_allowance_minutes, 90);
    assert.equal(afterRecalc.nrm_minutes, 630);
    assert.equal(afterRecalc.extra_break_minutes_applied, 30);
    const lockedJson = JSON.stringify(restored);

    /* 9-10. the month is locked, and the setting changes again. */
    state.lockedMonths.add("2026-8");
    state.employee.extra_break_hours = "2.00";

    /* 11. the read is still the stored history. */
    const afterLock = await readDay(usecase);
    assert.equal(afterLock.calculation_source, CALCULATION_SOURCE.STORED);
    assert.equal(afterLock.break_allowance_minutes, 90);
    assert.equal(afterLock.nrm_minutes, 630);

    /* 12. Recalculate is REFUSED, with a business error naming the month. */
    await assert.rejects(
      () => usecase.recalculateRange({ employee_id: 42, from_date: DATE, to_date: DATE }),
      (err) => {
        assert.equal(err.name, "ValidationError", "a refusal, not a crash");
        assert.equal(err.code, "PAYROLL_MONTH_LOCKED");
        assert.match(err.message, /approved and locked/);
        assert.match(err.message, /08\/2026/);
        return true;
      }
    );

    /* 13. and the stored row is exactly what it was. */
    assert.equal(JSON.stringify(state.storedByDate.get(DATE)), lockedJson);
  });

  it("a historical date with NO stored row is a live preview, and is labelled one", async () => {
    const { usecase } = world();
    const day = await readDay(usecase);
    assert.equal(day.calculation_source, CALCULATION_SOURCE.LIVE_PREVIEW);
    assert.equal(day.nrm_minutes, 660);
  });

  it("TODAY is never answered from a stored row: an open day is provisional", async () => {
    const { state, usecase } = world();
    await usecase.recalculateRange({ employee_id: 42, from_date: DATE, to_date: DATE });
    state.employee.extra_break_hours = "0.50";

    // The same date, read as though the clock were still inside it. The
    // stored row exists and is deliberately NOT used: people are still
    // punching, and a snapshot of a half-finished day is not history.
    const [day] = await usecase.readRange({
      employee_id: 42,
      from_date: DATE,
      to_date: DATE,
      now: Date.parse("2026-08-10T15:00:00+05:30"),
    });
    assert.equal(day.calculation_source, CALCULATION_SOURCE.LIVE_PREVIEW);
    assert.equal(day.break_allowance_minutes, 90);
  });

  it("the monthly read is stored-first, and only persist=true calculates", async () => {
    const { state, usecase } = world();
    await usecase.recalculateRange({ employee_id: 42, from_date: DATE, to_date: DATE });
    state.employee.extra_break_hours = "0.50";

    const read = await usecase.calculateMonth({ employee_id: 42, year: 2026, month: 8 });
    const readDate = read.days.find((d) => d.attendance_date === DATE);
    assert.equal(readDate.calculation_source, CALCULATION_SOURCE.STORED);
    assert.equal(readDate.nrm_minutes, 660);
    assert.equal(state.storedByDate.get(DATE).nrm_minutes, 660, "a read stored nothing");
  });
});
