/**
 * THE DNDS PF / EPS RULE: PF APPLICABLE + AGE, NOTHING ELSE.
 *
 *   IS_TEST=true node --test utils/pf_eps_pf_applicable_age.test.js
 *
 *   PF Applicable = No            no employee EPF, no employer EPF, no EPS
 *   PF Applicable = Yes, age < 58 employee EPF; employer share split EPS / EPF
 *   PF Applicable = Yes, age >= 58 employee EPF; EPS 0, employer share to EPF
 *   PF Applicable = Yes, no DOB   employee EPF and the employer 12% are
 *                                 calculated; only the EPS age decision is
 *                                 unresolved
 *
 * Previous PF Member / Previous EPS Member are onboarding reference facts and
 * never gate a month - for an existing employee or a new joiner. The
 * effective-dated ceiling (15,000 to 16-09-2026, 25,000 from 17-09-2026) is
 * unchanged and still splits September 2026.
 *
 * The full payrun path (calculate -> complete -> approve) for the
 * Vanitha / Desappan / Subash types is in usecase/payrun_calculation.test.js.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const engine = require("./salary_engine");
const pfPeriod = require("./pf_period");

const EXISTING = { date_of_joining: "2019-04-01" };
const AGE_40 = { dob: "1986-01-15" };
const AGE_60 = { dob: "1966-01-15" };

const month = (m, basic, extra = {}) =>
  pfPeriod.calculatePfForMonth({
    year: 2026,
    month: m,
    monthly_basic: basic,
    earned_basic: basic,
    pf_applicable: 1,
    ...EXISTING,
    ...AGE_40,
    ...extra,
  });

const triple = (r) => [r.employee_pf, r.employer_eps, r.employer_epf];

describe("PF / EPS eligibility is PF Applicable + age", () => {
  it("1. existing employee, PF Yes, age 40, Previous EPS blank -> EPF + EPS", () => {
    const r = month(8, 12000, { previous_eps_member: null, previous_pf_member: null });
    assert.deepEqual(triple(r), [1440, 1000, 440]);
    assert.deepEqual(r.unresolved, []);
  });

  it("2. existing employee, PF Yes, age 40, Previous EPS = No -> EPF + EPS still", () => {
    const r = month(8, 12000, { previous_eps_member: 0, previous_pf_member: 1 });
    assert.deepEqual(triple(r), [1440, 1000, 440]);
    assert.deepEqual(r.unresolved, []);
    // Above the old ceiling, too - the case the old rule excluded.
    assert.deepEqual(triple(month(8, 20000, { previous_eps_member: 0 })), [1800, 1250, 550]);
  });

  it("3. existing employee, PF Yes, age 58+ -> EPF yes, EPS 0", () => {
    const r = month(8, 12000, AGE_60);
    assert.deepEqual(triple(r), [1440, 0, 1440]);
    assert.deepEqual(r.unresolved, []);
  });

  it("4. PF Applicable = No, age below 58 -> no PF, no EPS", () => {
    const r = month(8, 12000, { pf_applicable: 0 });
    assert.equal(r.status, "NOT_APPLICABLE");
    assert.deepEqual([r.employee_pf, r.employer_pf_total, r.employer_eps, r.employer_epf], [0, 0, 0, 0]);
  });

  it("5. new joiner, PF Yes, age below 58 -> EPF + EPS (no Previous PF / EPS needed)", () => {
    const r = month(10, 12000, { date_of_joining: "2026-10-01", previous_pf_member: null, previous_eps_member: null });
    assert.deepEqual(triple(r), [1440, 1000, 440]);
    assert.deepEqual(r.unresolved, []);
  });

  it("6. new joiner, PF Applicable = No -> no PF, no EPS", () => {
    const r = month(10, 12000, { date_of_joining: "2026-10-01", pf_applicable: 0 });
    assert.deepEqual([r.employee_pf, r.employer_pf_total, r.employer_eps], [0, 0, 0]);
  });

  it("7. missing DOB, PF Yes -> employee PF and employer 12% calculated; only the EPS age decision unresolved", () => {
    const r = month(10, 12000, { dob: null });
    assert.equal(r.employee_pf, 1440);
    assert.equal(r.employer_pf_total, 1440);
    assert.equal(r.employer_eps, null);
    assert.deepEqual(r.unresolved.map((u) => u.code), [engine.UNRESOLVED.EPS_DOB_NOT_RECORDED]);
  });
});

/*
 * 8-10. Existing PF members filed with EPS in the August 2026 ECR, Basic above
 * 15,000, joined after 01-09-2014, Previous EPS Member blank in DNDS. Under the
 * old rule their September EPS was UNRESOLVED and approval was blocked.
 * (Synthetic DOBs; the Basic / DOJ shapes are the real cases'.)
 */
describe("8-10. a blank Previous EPS Member does not block payroll", () => {
  [
    ["8. Vanitha-type", 18750, "2018-12-31", [2010, 1395, 615], [[8000, 8000], [8750, 8750]]],
    ["9. Desappan-type", 17500, "2018-01-22", [1940, 1347, 593], [[8000, 8000], [8166.67, 8166.67]]],
    ["10. Subash-type", 16000, "2020-09-18", [1856, 1288, 568], [[8000, 8000], [7466.67, 7466.67]]],
  ].forEach(([label, basic, doj, september, periods]) =>
    it(`${label}: Basic ${basic}, joined ${doj} - September EPF + EPS, resolved (Scenario C)`, () => {
      const r = month(9, basic, { date_of_joining: doj, previous_eps_member: null, previous_pf_member: null });
      assert.deepEqual(r.unresolved, [], "nothing unresolved, so nothing blocks approval");
      assert.equal(r.pf_scenario, "FAQ_C:EPF_EPS>EPF_EPS|CEILING");
      assert.deepEqual(r.segments.map((s) => [s.pf_wage, s.eps_wage]), periods);
      assert.deepEqual(triple(r), september);
    })
  );
});

describe("the EPFO wage-ceiling logic is unchanged", () => {
  it("11. September 2026 still splits exactly as the approved Scenario C (PF wage 20,000)", () => {
    const r = month(9, 20000);
    assert.equal(r.pf_scenario, "FAQ_C:EPF_EPS>EPF_EPS|CEILING");
    assert.equal(r.ceiling_version, "EPFO-CEILING-15000-2014-09-01+EPFO-CEILING-25000-2026-09-17");
    assert.deepEqual(r.segments.map((s) => [s.from, s.to, s.pf_wage, s.eps_wage]), [
      ["2026-09-01", "2026-09-16", 8000, 8000],
      ["2026-09-17", "2026-09-30", 9333.33, 9333.33],
    ]);
    assert.deepEqual(
      [r.exact.employee_pf, r.exact.employer_eps, r.exact.employer_epf, r.exact.edli, r.exact.pf_admin_charge, r.exact.total_remittance],
      [2080, 1443.87, 636.13, 86.67, 86.67, 4333.34]
    );
    assert.deepEqual(
      [r.employee_pf, r.employer_eps, r.employer_epf, r.edli, r.pf_admin_charge, r.total_remittance],
      [2080, 1444, 636, 87, 87, 4334]
    );
  });

  it("12. an employee below 15,000 is unchanged across August, September and October", () => {
    const [aug, sep, oct] = [8, 9, 10].map((m) => triple(month(m, 12000)));
    assert.deepEqual(aug, [1440, 1000, 440]);
    assert.deepEqual(sep, aug);
    assert.deepEqual(oct, aug);
  });

  it("13. an employee aged 58+ has EPS 0 in August, both September periods and October", () => {
    [8, 9, 10].forEach((m) => {
      const r = month(m, 20000, AGE_60);
      assert.equal(r.employer_eps, 0, `month ${m}`);
      assert.equal(r.employer_epf, r.employer_pf_total);
    });
    assert.deepEqual(month(9, 20000, AGE_60).segments.map((s) => s.state), ["EPF_ONLY", "EPF_ONLY"]);
  });
});
