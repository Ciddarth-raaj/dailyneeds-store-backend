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

  it("pays an exempt employee the month's base days, not nothing", () => {
    const exempt = month({ attendance_required: false });
    assert.equal(exempt.base_days > 0, true);
    assert.equal(exempt.attendance_days, exempt.base_days);
    assert.equal(exempt.salary_days, exempt.base_days);
    assert.equal(Number(exempt.total_attendance_payable) > 0, true);
  });

  it("takes NO deduction from them for the absence of punches", () => {
    const exempt = month({ attendance_required: false });
    assert.equal(exempt.shortage_minutes, 0);
    assert.equal(Number(exempt.missing_minute_deduction), 0);
    assert.deepEqual(exempt.held_dates, []);
    assert.equal(exempt.is_final, true);
  });

  it("pays them no extra days and no overtime - neither has any evidence", () => {
    const exempt = month({ attendance_required: false });
    assert.equal(exempt.extra_days, 0);
    assert.equal(exempt.approved_ot_minutes, 0);
    assert.equal(Number(exempt.extra_day_earnings), 0);
    assert.equal(Number(exempt.approved_ot_earnings), 0);
  });

  it("says out loud why the month carries no derived attendance", () => {
    assert.match(month({ attendance_required: false }).attendance_exemption, /not required/i);
  });

  it("carries the same keys as an ordinary month, so no caller special-cases it", () => {
    const exempt = Object.keys(month({ attendance_required: false })).sort();
    const ordinary = Object.keys(month()).sort();
    assert.deepEqual(
      ordinary.filter((k) => !exempt.includes(k)),
      [],
      "an exempt month is missing keys an ordinary one has"
    );
  });

  it("without the flag, an employee with no days is still paid nothing", () => {
    // The unchanged rule, pinned so the exemption cannot leak into it: pay
    // follows attendance for everybody who is required to record it.
    const ordinary = month();
    assert.equal(ordinary.attendance_days, 0);
    assert.equal(Number(ordinary.total_attendance_payable), 0);
    assert.equal(ordinary.attendance_required, true);
  });
});
