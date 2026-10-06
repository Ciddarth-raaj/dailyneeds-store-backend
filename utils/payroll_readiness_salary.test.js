/**
 * ATTENDANCE_SALARY_STALE - the attendance month was priced on a different
 * salary from the one payroll prices the month on.
 *
 *   node --test utils/payroll_readiness_salary.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { evaluatePayrollReadiness, READINESS_REASON } = require("./payroll_readiness");

const judge = (attendanceGross, approvedGross) =>
  evaluatePayrollReadiness({
    year: 2026, month: 9,
    snapshot: { monthly_gross: approvedGross, basic: 10000, date_of_joining: "2020-01-01" },
    monthly: { is_final: 1, payroll_version: 1, monthly_gross: attendanceGross, salary_days: 26 },
    day_rows: [],
    closed_for_payroll: true,
  });
const stale = (r) => r.reasons.find((x) => x.code === READINESS_REASON.ATTENDANCE_SALARY_STALE);

describe("ATTENDANCE_SALARY_STALE", () => {
  it("blocks when the attendance month was priced on ₹10,500 and the month's approved salary is ₹11,500", () => {
    const r = judge("10500.00", 11500);
    const x = stale(r);
    assert.ok(x);
    assert.equal(r.calculable, false);
    assert.equal(x.processable, true, "Process Attendance re-prices it");
    assert.equal(x.accepted_by_close, false, "closing attendance does not accept two salaries");
    assert.match(x.message, /₹10,500\.00.*₹11,500\.00/);
  });
  it("does not fire when both are the same salary (compared in paise, any formatting)", () => {
    assert.equal(stale(judge("11500.00", 11500)), undefined);
    assert.equal(stale(judge(11500, "11500")), undefined);
  });
  it("does not judge a month stored without its gross", () => {
    assert.equal(stale(judge(null, 11500)), undefined);
    assert.equal(stale(judge(undefined, 11500)), undefined);
  });
});
