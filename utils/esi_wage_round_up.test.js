/**
 * The ESI wage is always a whole rupee, ROUNDED UP.
 *
 *   node --test utils/esi_wage_round_up.test.js
 *
 * ₹12,345.01 is ₹12,346 - never rounded down, never to the nearest. It is
 * rounded once, in `salary_engine.js#calculateEsi`, so the payrun, the Salary
 * Master and the payslip all show and charge the same whole-rupee figure.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const E = require("./salary_engine");
const calc = require("./payrun_calculation");

const esi = (esi_wage, extra = {}) => E.calculateEsi({ esi_applicable: 1, esi_wage, ...extra });

describe("the ESI wage is rounded UP to the next whole rupee", () => {
  it("any paise at all round up, including one paisa", () => {
    assert.equal(esi("12345.01").esi_wage, 12346);
    assert.equal(esi(12345.5).esi_wage, 12346);
    assert.equal(esi(12345.99).esi_wage, 12346);
    assert.equal(esi(16960.26).esi_wage, 16961, "below .50 still goes UP, not to the nearest");
  });

  it("a whole-rupee wage is unchanged", () => {
    assert.equal(esi(12345).esi_wage, 12345);
    assert.equal(esi("18500.00").esi_wage, 18500);
  });

  it("the contributions are charged on the rounded-up wage", () => {
    const rounded = esi(12345.01);
    const whole = esi(12346);
    assert.equal(rounded.employee_esi, whole.employee_esi);
    assert.equal(rounded.employer_esi, whole.employer_esi);
  });

  it("the standard (Salary Master) wage is rounded up the same way", () => {
    // No esi_wage: the engine derives the standard wage from the structure.
    const r = E.calculateEsi({ esi_applicable: 1, gross: 15000.4, ...E.calculateBreakup(15000.4) });
    assert.equal(r.esi_wage_basis, "STANDARD");
    assert.ok(Number.isInteger(Number(r.esi_wage)), `whole rupees, got ${r.esi_wage}`);
  });
});

describe("rounding up never changes who is covered or exempt", () => {
  it("exactly at the 21,000 ceiling is covered; any paise above it is not", () => {
    assert.equal(esi(21000).status, "APPLIED");
    assert.equal(esi(20999.01).status, "APPLIED");
    assert.equal(esi(20999.01).esi_wage, 21000);
    assert.equal(esi(21000.01).status, "NOT_APPLICABLE");
  });

  it("the employee exemption (176 a day x 26 = 4,576) is decided the same", () => {
    assert.equal(esi(4575.2).employee_contribution_exempt, true);
    assert.equal(esi(4575.2).esi_wage, 4576);
    assert.equal(esi(4576.01).employee_contribution_exempt, false);
  });

  it("not applicable is still zero", () => {
    assert.equal(E.calculateEsi({ esi_applicable: 0, esi_wage: 12345.01 }).esi_wage, 0);
  });
});

describe("the payrun stores the rounded-up wage", () => {
  const SNAPSHOT = {
    monthly_gross: 26000, basic: 13000, conveyance: 2500, hra: 5000, special_allowance: 5500,
    pf_applicable: 1, esi_applicable: 1, pay_type: "BANK", date_of_joining: "2018-04-01",
  };
  const ATTENDANCE = {
    attendance_monthly_payroll_id: 900, payroll_version: 1, calculated_at: "2026-09-01 02:00:00.000",
    is_final: 1, salary_days: 24, extra_days: 0, salary_day_earnings: 24000, extra_day_earnings: 0,
    shortage_minutes: 7, missing_minute_deduction: 116.67, approved_ot_minutes: 0, approved_ot_earnings: 0,
  };

  it("a month whose ESI wage works out to 16,960.26 is stored as 16,961", () => {
    const r = calc.computeCalculation({
      snapshot: SNAPSHOT,
      attendance: ATTENDANCE,
      nrm: null,
      amounts: {},
      statutory: { dob: "1990-06-15", previous_eps_member: 0 },
      as_of: "2026-08-31",
      coverage_entry_salary: { ...SNAPSHOT },
    });
    assert.equal(r.esi_wage_definition.statutory_wages, 16960.26, "the unrounded definition is still reported");
    assert.equal(Number(r.esi_wage), 16961);
    assert.deepEqual(
      [r.employee_esi, r.employer_esi].map(Number),
      [E.calculateEsi({ esi_applicable: 1, esi_wage: 16961 }).employee_esi, E.calculateEsi({ esi_applicable: 1, esi_wage: 16961 }).employer_esi]
    );
  });
});
