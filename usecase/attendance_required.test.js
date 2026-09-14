/**
 * `Attendance Required = No` - an employee who is exempt from biometric
 * attendance, across every path that reads attendance.
 *
 *   node --test usecase/attendance_required.test.js
 *
 * WHAT THE FLAG IS NOT is the important half, and most of these tests pin
 * that: exempt is not resigned, not inactive, not payroll-inactive and not
 * unpaid. What changes is only that the absence of a biometric punch stops
 * being evidence of anything.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { calculateAttendanceDay, CALC_STATUS } = require("../utils/attendance_engine");
const { computeMonthlyAttendancePayroll } = require("../utils/attendance_payroll");
const { dayIssueKey } = require("../utils/attendance_dashboard");
const { attendanceRequired } = require("./attendance_calculation")({});

describe("attendanceRequired", () => {
  it("defaults to true whenever the column was not read", () => {
    assert.equal(attendanceRequired(null), true);
    assert.equal(attendanceRequired({}), true);
    assert.equal(attendanceRequired({ attendance_required: null }), true);
  });

  it("reads 1/0 and true/false", () => {
    assert.equal(attendanceRequired({ attendance_required: 1 }), true);
    assert.equal(attendanceRequired({ attendance_required: true }), true);
    assert.equal(attendanceRequired({ attendance_required: 0 }), false);
    assert.equal(attendanceRequired({ attendance_required: false }), false);
  });
});

describe("the engine day", () => {
  const day = (over = {}) =>
    calculateAttendanceDay({
      employee_id: 4242,
      attendance_date: "2026-09-15",
      shift: null,
      shift_status: "NO_SHIFT_FOR_DATE",
      punches: [],
      attendance_required: false,
      ...over,
    });

  it("is settled, not a review state, and names why", () => {
    const d = day();
    assert.equal(d.status, CALC_STATUS.ATTENDANCE_NOT_REQUIRED);
    assert.equal(d.is_final, true);
    assert.deepEqual(d.review_reasons, []);
    assert.match(d.notes.join(" "), /not required/i);
  });

  it("does NOT report No Shift, even with no shift resolvable at all", () => {
    const d = day();
    assert.notEqual(d.status, CALC_STATUS.NO_SHIFT_FOR_DATE);
    assert.ok(!d.review_reasons.includes("NO_SHIFT_FOR_DATE"));
  });

  it("raises no missing-punch exception on an odd punch count", () => {
    const d = day({ punches: [{ punch_id: 1, io_time: "2026-09-15 09:02:00", source: "BIOMAX" }] });
    assert.equal(d.status, CALC_STATUS.ATTENDANCE_NOT_REQUIRED);
    assert.deepEqual(d.review_reasons, []);
  });

  it("charges no shortage", () => {
    assert.equal(day().shortage_minutes, 0);
  });

  it("is never an attendance ISSUE on the dashboard", () => {
    assert.equal(dayIssueKey(day()), null);
  });

  it("leaves everybody else exactly as they were", () => {
    const required = calculateAttendanceDay({
      employee_id: 1,
      attendance_date: "2026-09-15",
      shift: null,
      shift_status: "NO_SHIFT_FOR_DATE",
      punches: [],
    });
    assert.equal(required.status, CALC_STATUS.NO_SHIFT_FOR_DATE);
    assert.deepEqual(required.review_reasons, ["NO_SHIFT_FOR_DATE"]);
  });
});

describe("the payroll month", () => {
  const month = (over = {}) =>
    computeMonthlyAttendancePayroll({
      employee_id: 4242,
      year: 2026,
      month: 9,
      monthly_gross: 26000,
      days: [],
      joined_on: null,
      ended_on: null,
      ...over,
    });

  const exempt = (over = {}) => month({ attendance_required: false, ...over });

  /* ------------------------------------------- the 26-day basis holds */

  it("pays EXACTLY one month's gross for a full month, whatever the month's length", () => {
    // THE REGRESSION. Paying `base_days` outright gave 27 days in a 31-day
    // month (extra salary the exemption invented) and 24 in February (an
    // underpayment caused by the very missing punches the flag exists to
    // stop being read as evidence). Both are the same bug seen from two
    // sides, and both are fixed by paying the established 26-day basis.
    for (const [m, days] of [[9, 30], [10, 31], [2, 28], [1, 31], [4, 30]]) {
      const r = exempt({ month: m });
      assert.equal(r.available_dates, days, `month ${m} window`);
      assert.equal(Number(r.total_attendance_payable), 26000, `month ${m} must pay one gross`);
      assert.equal(r.salary_days, 26, `month ${m} salary days`);
    }
  });

  it("never pays MORE than a month's gross - the exemption creates no extra salary", () => {
    for (let m = 1; m <= 12; m += 1) {
      const r = exempt({ month: m });
      assert.ok(
        Number(r.total_attendance_payable) <= 26000,
        `month ${m} paid ${r.total_attendance_payable}`
      );
      assert.equal(r.extra_days, 0, `month ${m} must create no extra days`);
      assert.equal(Number(r.extra_day_earnings), 0, `month ${m} must pay no extra days`);
    }
  });

  it("uses the shared salary-day basis rather than a literal", () => {
    const basis = require("../config/statutory").salary.salaryDaysPerMonth;
    assert.equal(exempt({ month: 10 }).salary_days, basis);
    assert.equal(Number(exempt({ month: 10 }).daily_rate), 26000 / basis);
  });

  /* ---------------------------------- the employment period still binds */

  it("respects the JOINING date - a mid-month joiner is pro-rated, not given a full month", () => {
    const r = exempt({ month: 10, joined_on: "2026-10-20" });
    assert.equal(r.available_from, "2026-10-20");
    assert.equal(r.available_dates, 12);
    assert.equal(r.salary_days, 11);
    assert.equal(Number(r.total_attendance_payable), 11000);
  });

  it("respects the RESIGNATION / last working date", () => {
    const r = exempt({ month: 10, ended_on: "2026-10-10" });
    assert.equal(r.available_to, "2026-10-10");
    assert.equal(r.available_dates, 10);
    assert.equal(r.salary_days, 9);
    assert.equal(Number(r.total_attendance_payable), 9000);
  });

  it("pays NOTHING for a month the employee was not employed in at all", () => {
    for (const bounds of [{ joined_on: "2026-11-01" }, { ended_on: "2026-08-31" }]) {
      const r = exempt({ month: 10, ...bounds });
      assert.equal(r.available_dates, 0);
      assert.equal(r.salary_days, 0);
      assert.equal(Number(r.total_attendance_payable), 0);
    }
  });

  it("bounds an exempt employee with the SAME window as everybody else", () => {
    // Not a second, laxer rule: the identical `availableDates` output.
    const bounds = { month: 10, joined_on: "2026-10-05", ended_on: "2026-10-25" };
    const e = exempt(bounds);
    const ordinary = month(bounds);
    assert.equal(e.available_from, ordinary.available_from);
    assert.equal(e.available_to, ordinary.available_to);
    assert.equal(e.available_dates, ordinary.available_dates);
    assert.equal(e.notional_offs, ordinary.notional_offs);
    assert.equal(e.base_days, ordinary.base_days);
  });

  /* --------------------------------------------- no attendance effects */

  it("takes NO deduction for the absence of punches", () => {
    const r = exempt();
    assert.equal(r.shortage_minutes, 0);
    assert.equal(Number(r.missing_minute_deduction), 0);
    assert.deepEqual(r.held_dates, []);
    assert.equal(r.is_final, true);
  });

  it("pays no overtime - an exempt day reports no candidate OT for one to be raised from", () => {
    const r = exempt();
    assert.equal(r.approved_ot_minutes, 0);
    assert.equal(Number(r.approved_ot_earnings), 0);
  });

  it("says out loud why the month carries no derived attendance", () => {
    assert.match(exempt().attendance_exemption, /not required/i);
    assert.match(exempt().attendance_exemption, /joining and last working date/i);
  });

  /* ---------------------------------------- nothing else is bypassed */

  it("still pays nothing when there is no approved salary record", () => {
    // An exempt employee with no salary is not paid a guessed one.
    const r = exempt({ monthly_gross: null });
    assert.equal(r.total_attendance_payable, null);
    assert.equal(r.monthly_gross, null);
  });

  it("carries the same keys as an ordinary month, so no caller special-cases it", () => {
    const exemptKeys = Object.keys(exempt()).sort();
    const ordinary = Object.keys(month()).sort();
    assert.deepEqual(
      ordinary.filter((k) => !exemptKeys.includes(k)),
      [],
      "an exempt month is missing keys an ordinary one has"
    );
  });

  it("asserts nothing about PF or ESI - the statutory handoff is unchanged", () => {
    assert.equal(exempt().statutory_handoff, month().statutory_handoff);
    assert.match(exempt().statutory_handoff, /salary_engine\.js remains the statutory authority/);
  });

  it("without the flag, an employee with no days is still paid nothing", () => {
    // The unchanged rule, pinned so the exemption cannot leak into it: pay
    // follows attendance for everybody who is required to record it.
    const ordinary = month();
    assert.equal(ordinary.attendance_days, 0);
    assert.equal(Number(ordinary.total_attendance_payable), 0);
    assert.equal(ordinary.attendance_required, true);
  });

  it("leaves an ATTENDING employee's month arithmetic exactly as it was", () => {
    // The 31-day / 27-base-day behaviour is the established v2 model for
    // somebody who actually attended 27 days, and the exemption fix must
    // not have touched it.
    const days = Array.from({ length: 27 }, (_, i) => ({
      attendance_date: `2026-10-${String(i + 1).padStart(2, "0")}`,
      attendance_day_count: 1,
      is_final: true,
      nrm_minutes: 480,
      shortage_minutes: 0,
      approved_ot_minutes: 0,
      ot_rate: 1,
    }));
    const r = month({ month: 10, days });
    assert.equal(r.base_days, 27);
    assert.equal(r.salary_days, 27);
    assert.equal(Number(r.total_attendance_payable), 27000);
  });
});
