/**
 * THE EPS ELIGIBILITY CORRECTION - kept separate from the 2026 ceiling change.
 *
 *   IS_TEST=true node --test utils/eps_eligibility_correction.test.js
 *
 * OLD BEHAVIOUR (`PF_EPS_ELIGIBILITY_ON_UNCAPPED_WAGE=false`): "is the pension
 * wage at or below the EPS ceiling?" was asked of the ALREADY-CAPPED PF wage.
 * On the CEILING basis that wage can never exceed the ceiling, so the answer
 * was always yes and `previous_eps_member` / the 01-09-2014 cutoff were never
 * consulted.
 *
 * CORRECTED (`true`, the default): the question is asked of the wage the
 * employee is paid at (the contractual Basic).
 *
 * WHO IT CHANGES: PF applicable, under 58, CEILING basis, Basic ABOVE the
 * ceiling, joined ON/AFTER 01-09-2014, and
 *   previous_eps_member = 0     -> EPS 1,250 becomes 0 (whole 12% to EPF)
 *   previous_eps_member = NULL  -> EPS 1,250 becomes UNRESOLVED (blocks approval)
 * Nobody else: at or below the ceiling, pre-2014 joiners, previous EPS members,
 * age 58+ and ACTUAL_WAGE (higher-wage) contributors come out the same.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const CONFIG = require("../config/statutory");
const engine = require("./salary_engine");
const pfPeriod = require("./pf_period");

const OLD = { ...CONFIG, pf: { ...CONFIG.pf, epsEligibilityOnUncappedWage: false } };
const NEW = { ...CONFIG, pf: { ...CONFIG.pf, epsEligibilityOnUncappedWage: true } };

const ctx = (over = {}) => ({
  basic: 20000,
  pf_applicable: 1,
  dob: "1990-01-01",
  date_of_joining: "2020-01-01",
  previous_eps_member: 0,
  as_of: "2026-08-31",
  ...over,
});

describe("old vs corrected behaviour, August 2026 (before the ceiling change)", () => {
  it("the defect: post-2014 joiner, 20,000, never an EPS member", () => {
    const old = engine.calculatePf(ctx(), OLD);
    const fixed = engine.calculatePf(ctx(), NEW);
    assert.deepEqual([old.employer_eps, old.employer_epf], [1250, 550], "OLD: wrongly in EPS");
    assert.deepEqual([fixed.employer_eps, fixed.employer_epf], [0, 1800], "CORRECTED: not eligible");
    assert.equal(old.employee_pf, fixed.employee_pf, "the employee share is unaffected");
    assert.equal(old.employer_pf_total, fixed.employer_pf_total, "so is the employer total - only its split moves");
  });

  it("the same employee with EPS history unrecorded: OLD 1,250, CORRECTED unresolved", () => {
    const old = engine.calculatePf(ctx({ previous_eps_member: null }), OLD);
    const fixed = engine.calculatePf(ctx({ previous_eps_member: null }), NEW);
    assert.equal(old.employer_eps, 1250);
    assert.equal(fixed.employer_eps, null);
    assert.equal(fixed.unresolved[0].code, engine.UNRESOLVED.EPS_MEMBERSHIP_NOT_RECORDED);
  });

  [
    ["at or below the ceiling", { basic: 15000 }],
    ["joined before 01-09-2014", { date_of_joining: "2010-01-01" }],
    ["a previous EPS member", { previous_eps_member: 1 }],
    ["aged 58+", { dob: "1960-01-01" }],
  ].forEach(([label, over]) =>
    it(`unchanged when ${label}`, () => {
      const old = engine.calculatePf(ctx(over), OLD);
      const fixed = engine.calculatePf(ctx(over), NEW);
      assert.deepEqual([fixed.employer_eps, fixed.employer_epf], [old.employer_eps, old.employer_epf]);
    })
  );

  it("unchanged for an ACTUAL_WAGE (higher-wage) contributor: the old code already tested the uncapped wage", () => {
    const m = (cfg) =>
      pfPeriod.calculatePfForMonth(
        { pf_applicable: 1, dob: "1990-01-01", date_of_joining: "2020-01-01", previous_eps_member: 0, pf_contribution_basis: "ACTUAL_WAGE", year: 2026, month: 8, monthly_basic: 20000, earned_basic: 20000 },
        cfg
      );
    assert.equal(m(OLD).employer_eps, m(NEW).employer_eps);
    assert.equal(m(NEW).employer_eps, 0);
  });
});

describe("why the correction is a prerequisite for the FAQ", () => {
  const sep = (cfg) =>
    pfPeriod.calculatePfForMonth(
      { pf_applicable: 1, dob: "1990-01-01", date_of_joining: "2020-01-01", previous_eps_member: 0, year: 2026, month: 9, monthly_basic: 20000, earned_basic: 20000 },
      cfg
    );
  it("OLD would put an EPF-only member into EPS for 01-16 Sep; CORRECTED gives the NIL Period-1 EPS wage", () => {
    assert.equal(sep(OLD).segments[0].eps_wage, 8000);
    assert.equal(sep(NEW).segments[0].eps_wage, 0);
  });
  it("from October both agree for wages within 25,000 - the new ceiling makes the question moot", () => {
    const oct = (cfg) =>
      pfPeriod.calculatePfForMonth(
        { pf_applicable: 1, dob: "1990-01-01", date_of_joining: "2020-01-01", previous_eps_member: 0, year: 2026, month: 10, monthly_basic: 20000, earned_basic: 20000 },
        cfg
      );
    assert.equal(oct(OLD).employer_eps, oct(NEW).employer_eps);
  });
  it("above 25,000 it still matters from October: OLD 2,083, CORRECTED 0", () => {
    const oct = (cfg) =>
      pfPeriod.calculatePfForMonth(
        { pf_applicable: 1, dob: "1990-01-01", date_of_joining: "2020-01-01", previous_eps_member: 0, year: 2026, month: 10, monthly_basic: 30000, earned_basic: 30000 },
        cfg
      );
    assert.equal(oct(OLD).employer_eps, 2083);
    assert.equal(oct(NEW).employer_eps, 0);
  });
});

describe("the switch is configuration", () => {
  it("defaults to the corrected rule", () => {
    assert.equal(CONFIG.pf.epsEligibilityOnUncappedWage, true);
  });
});
