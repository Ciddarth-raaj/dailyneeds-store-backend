/**
 * Attendance v2 / A4 - the monthly payroll consumption.
 *
 * Fixed day counts and fixed salaries, so every rupee below is arithmetic a
 * reviewer can check by hand. No database, no clock.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  availableDates,
  splitSalaryAndExtraDays,
  perMinutePaise,
  computeMonthlyAttendancePayroll,
} = require("../utils/attendance_payroll");

/** A settled, fully worked day on a 660 minute NRM. */
const workedDay = (date, overrides = {}) => ({
  attendance_date: date,
  attendance_day_count: 1,
  nrm_minutes: 660,
  shortage_minutes: 0,
  approved_ot_minutes: 0,
  ot_rate: 1,
  is_final: true,
  ...overrides,
});

const pad = (n) => String(n).padStart(2, "0");
const daysOf = (count, overrides = {}) =>
  Array.from({ length: count }, (_, i) => workedDay(`2026-09-${pad(i + 1)}`, overrides));

describe("the available-dates window", () => {
  it("a whole month is every day of it", () => {
    assert.equal(availableDates({ year: 2026, month: 9 }).count, 30);
    assert.equal(availableDates({ year: 2026, month: 2 }).count, 28);
    assert.equal(availableDates({ year: 2028, month: 2 }).count, 29, "a leap February");
  });

  it("a mid-month joiner is bounded by their joining date", () => {
    const window = availableDates({ year: 2026, month: 9, joined_on: "2026-09-16" });
    assert.equal(window.count, 15);
    assert.equal(window.from, "2026-09-16");
  });

  it("a leaver is bounded by their last working date", () => {
    const window = availableDates({ year: 2026, month: 9, ended_on: "2026-09-10" });
    assert.equal(window.count, 10);
    assert.equal(window.to, "2026-09-10");
  });

  it("a joining date after the month gives nothing", () => {
    assert.equal(availableDates({ year: 2026, month: 9, joined_on: "2026-10-01" }).count, 0);
  });

  it("a joining date before the month does not extend it", () => {
    assert.equal(availableDates({ year: 2026, month: 9, joined_on: "2020-01-01" }).count, 30);
  });
});

describe("the salary-day / extra-day split", () => {
  it("30 available dates give 4 notional offs and 26 base days", () => {
    const split = splitSalaryAndExtraDays(26, 30);
    assert.equal(split.notional_offs, 4);
    assert.equal(split.base_days, 26);
    assert.equal(split.salary_days, 26);
    assert.equal(split.extra_days, 0);
  });

  it("attending more than the base days produces extra days", () => {
    const split = splitSalaryAndExtraDays(30, 30);
    assert.equal(split.salary_days, 26);
    assert.equal(split.extra_days, 4);
  });

  it("attending fewer caps salary days at what was attended", () => {
    const split = splitSalaryAndExtraDays(20, 30);
    assert.equal(split.salary_days, 20);
    assert.equal(split.extra_days, 0);
  });

  it("a half month is bounded by its own availability", () => {
    const split = splitSalaryAndExtraDays(15, 15);
    assert.equal(split.notional_offs, 2);
    assert.equal(split.base_days, 13);
    assert.equal(split.salary_days, 13);
    assert.equal(split.extra_days, 2);
  });
});

describe("the money", () => {
  const base = { employee_id: 1, year: 2026, month: 9, monthly_gross: 26000 };

  it("the daily rate is Monthly Gross over 26", () => {
    const result = computeMonthlyAttendancePayroll({ ...base, days: daysOf(26) });
    assert.equal(result.daily_rate, 1000);
  });

  it("total attendance pay is attended days times the daily rate, split or not", () => {
    const result = computeMonthlyAttendancePayroll({ ...base, days: daysOf(30) });

    assert.equal(result.attendance_days, 30);
    assert.equal(result.salary_days, 26);
    assert.equal(result.extra_days, 4);
    assert.equal(result.salary_earnings, 26000);
    assert.equal(result.extra_day_earnings, 4000);
    assert.equal(result.salary_earnings + result.extra_day_earnings, 30 * 1000);
    assert.equal(result.total_attendance_payable, 30000);
  });

  it("the statutory base is the Salary Days line and excludes extra days", () => {
    const result = computeMonthlyAttendancePayroll({ ...base, days: daysOf(30) });
    assert.equal(result.statutory_base_days, 26);
    assert.equal(result.statutory_base_earnings, 26000);
    assert.notEqual(result.statutory_base_earnings, result.total_attendance_payable);
  });

  it("the shortage is deducted by the minute, at that date's own rate", () => {
    // 66 minutes short on a 660 minute NRM is a tenth of a 1000 rupee day.
    const days = daysOf(26);
    days[0] = workedDay("2026-09-01", { shortage_minutes: 66 });
    const result = computeMonthlyAttendancePayroll({ ...base, days });

    assert.equal(result.shortage_minutes, 66);
    assert.equal(result.missing_minute_deduction, 100);
    assert.equal(result.total_attendance_payable, 26000 - 100);
    // The day itself is still a whole day. No half day, ever.
    assert.equal(result.attendance_days, 26);
  });

  it("a shorter NRM makes each missing minute worth more", () => {
    const short = daysOf(26);
    short[0] = workedDay("2026-09-01", { nrm_minutes: 480, shortage_minutes: 48 });
    const result = computeMonthlyAttendancePayroll({ ...base, days: short });
    assert.equal(result.missing_minute_deduction, 100, "48 of 480 minutes is a tenth of the day");
  });

  it("approved OT is paid at the daily rate per NRM minute, times the weekday rate", () => {
    const days = daysOf(26);
    days[0] = workedDay("2026-09-01", { approved_ot_minutes: 66, ot_rate: 1 });
    const single = computeMonthlyAttendancePayroll({ ...base, days });
    assert.equal(single.approved_ot_minutes, 66);
    assert.equal(single.approved_ot_earnings, 100);

    days[0] = workedDay("2026-09-01", { approved_ot_minutes: 66, ot_rate: 2 });
    const double = computeMonthlyAttendancePayroll({ ...base, days });
    assert.equal(double.approved_ot_earnings, 200);
  });

  it("an extra day and approved OT can both land on one date and stay separate", () => {
    const days = daysOf(30);
    days[29] = workedDay("2026-09-30", { approved_ot_minutes: 66 });
    const result = computeMonthlyAttendancePayroll({ ...base, days });

    assert.equal(result.extra_days, 4);
    assert.equal(result.extra_day_earnings, 4000);
    assert.equal(result.approved_ot_earnings, 100);
    assert.equal(result.total_attendance_payable, 26000 + 4000 + 100);
  });

  it("nothing is paid for a day nobody attended", () => {
    const days = [...daysOf(20), workedDay("2026-09-21", { attendance_day_count: 0, shortage_minutes: 0 })];
    const result = computeMonthlyAttendancePayroll({ ...base, days });
    assert.equal(result.attendance_days, 20);
    assert.equal(result.total_attendance_payable, 20000);
  });
});

describe("dates that are not settled are held, not guessed", () => {
  const base = { employee_id: 1, year: 2026, month: 9, monthly_gross: 26000 };

  it("a non-final date counts as present but contributes no shortage and no OT", () => {
    const days = daysOf(26);
    days[0] = workedDay("2026-09-01", {
      is_final: false,
      shortage_minutes: 300,
      approved_ot_minutes: 60,
    });
    const result = computeMonthlyAttendancePayroll({ ...base, days });

    assert.equal(result.attendance_days, 26, "they were demonstrably at work");
    assert.equal(result.shortage_minutes, 0);
    assert.equal(result.approved_ot_minutes, 0);
    assert.deepEqual(result.held_dates, ["2026-09-01"]);
    assert.equal(result.is_final, false, "the month is not closeable");
  });

  it("a clean month is final", () => {
    const result = computeMonthlyAttendancePayroll({ ...base, days: daysOf(26) });
    assert.deepEqual(result.held_dates, []);
    assert.equal(result.is_final, true);
  });

  it("a zero NRM is reported rather than divided by", () => {
    const days = [workedDay("2026-09-01", { nrm_minutes: 0, shortage_minutes: 30 })];
    const result = computeMonthlyAttendancePayroll({ ...base, days });
    assert.deepEqual(result.unrated_dates, ["2026-09-01"]);
    assert.equal(result.missing_minute_deduction, 0);
  });

  it("no salary on record produces nulls, never a plausible zero", () => {
    const result = computeMonthlyAttendancePayroll({
      employee_id: 1,
      year: 2026,
      month: 9,
      monthly_gross: null,
      days: daysOf(26),
    });
    assert.equal(result.daily_rate, null);
    assert.equal(result.salary_earnings, null);
    assert.equal(result.total_attendance_payable, null);
    assert.equal(result.attendance_days, 26, "the days are still counted");
  });
});

describe("per-minute pricing", () => {
  it("is the daily rate over that date's NRM minutes", () => {
    assert.equal(perMinutePaise(100000, 500), 200);
  });

  it("refuses to divide by a zero or negative NRM", () => {
    assert.equal(perMinutePaise(100000, 0), null);
    assert.equal(perMinutePaise(100000, -5), null);
  });
});

describe("recomputation is deterministic", () => {
  it("the same month computed twice is identical", () => {
    const input = { employee_id: 1, year: 2026, month: 9, monthly_gross: 26000, days: daysOf(30) };
    assert.deepEqual(
      computeMonthlyAttendancePayroll(input),
      computeMonthlyAttendancePayroll(input)
    );
  });
});
