/**
 * THE DNDS MONTHLY PF / EPS RULE: PF APPLICABLE + AGE, NOTHING ELSE.
 *
 *   IS_TEST=true node --test utils/pf_eps_pf_applicable_age.test.js
 *
 *   PF Applicable = No             no employee EPF, no employer EPF, no EPS
 *   PF Applicable = Yes, age < 58  employee EPF; employer share split EPS / EPF
 *   PF Applicable = Yes, age >= 58 employee EPF; EPS 0, employer share to EPF
 *   PF Applicable = Yes, no DOB    PF calculated; only the EPS split is
 *                                  unresolved, and approval waits for the DOB
 *   PF Applicable blank            PF unresolved
 *
 * Previous PF Member / Previous EPS Member are onboarding reference facts:
 * they never change, block, hold or force recalculation of a month. The
 * effective-dated ceiling (15,000 to 16-09-2026, 25,000 from 17-09-2026) and
 * the September 2026 split are unchanged.
 *
 * ALL FIXTURES ARE SYNTHETIC. The end-to-end payrun path (calculate ->
 * complete -> approve, and the recalculation marker through the usecase) is
 * in usecase/payrun_calculation.test.js.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const engine = require("./salary_engine");
const pfPeriod = require("./pf_period");
const calc = require("./payrun_calculation");
const { statutorySetupGaps } = require("./payrun_eligibility");

/* ----------------------------------------------------- synthetic fixtures */

const EXISTING_UNDER_58 = { pf_applicable: 1, date_of_joining: "2019-04-01", dob: "1986-01-15" }; // 40
const EXISTING_58_PLUS = { pf_applicable: 1, date_of_joining: "2012-04-01", dob: "1966-01-15" }; // 60
const PF_NO = { pf_applicable: 0, date_of_joining: "2019-04-01", dob: "1986-01-15" };
const PF_BLANK = { pf_applicable: null, date_of_joining: "2019-04-01", dob: "1986-01-15" };
const DOB_MISSING = { pf_applicable: 1, date_of_joining: "2019-04-01", dob: null };
const NEW_JOINER = { pf_applicable: 1, date_of_joining: "2026-10-01", dob: "1998-03-10" };
const PREV_EPS = { blank: { previous_eps_member: null }, yes: { previous_eps_member: 1 }, no: { previous_eps_member: 0 } };

const month = (m, basic, who, extra = {}) =>
  pfPeriod.calculatePfForMonth({ year: 2026, month: m, monthly_basic: basic, earned_basic: basic, ...who, ...extra });
const triple = (r) => [r.employee_pf, r.employer_eps, r.employer_epf];

/* ----------------------------------------------------------------- 1-7 */

describe("PF / EPS eligibility is PF Applicable + age", () => {
  it("1. PF Yes + age 40 + Previous EPS blank -> EPF + EPS", () => {
    const r = month(8, 12000, EXISTING_UNDER_58, PREV_EPS.blank);
    assert.deepEqual(triple(r), [1440, 1000, 440]);
    assert.deepEqual(r.unresolved, []);
    // Above the old ceiling too - the case the old rule left unresolved.
    assert.deepEqual(triple(month(8, 20000, EXISTING_UNDER_58, PREV_EPS.blank)), [1800, 1250, 550]);
  });

  it("2. PF Yes + age 40 + Previous EPS No -> EPF + EPS", () => {
    assert.deepEqual(triple(month(8, 12000, EXISTING_UNDER_58, PREV_EPS.no)), [1440, 1000, 440]);
    assert.deepEqual(triple(month(8, 20000, EXISTING_UNDER_58, PREV_EPS.no)), [1800, 1250, 550]);
  });

  it("3. PF Yes + age 40 + Previous EPS Yes -> EPF + EPS (identical to blank and No)", () => {
    const yes = month(8, 20000, EXISTING_UNDER_58, PREV_EPS.yes);
    assert.deepEqual(triple(yes), [1800, 1250, 550]);
    assert.deepEqual(triple(yes), triple(month(8, 20000, EXISTING_UNDER_58, PREV_EPS.blank)));
  });

  it("4. PF Yes + age 58+ -> EPF, EPS 0", () => {
    const r = month(8, 12000, EXISTING_58_PLUS, PREV_EPS.yes);
    assert.deepEqual(triple(r), [1440, 0, 1440]);
    assert.deepEqual(r.unresolved, []);
  });

  it("5. PF Applicable No -> no PF, no EPS (existing employee and new joiner)", () => {
    [PF_NO, { ...NEW_JOINER, pf_applicable: 0 }].forEach((who) => {
      const r = month(10, 12000, who, PREV_EPS.yes);
      assert.equal(r.status, "NOT_APPLICABLE");
      assert.deepEqual([r.employee_pf, r.employer_pf_total, r.employer_eps, r.employer_epf], [0, 0, 0, 0]);
    });
  });

  it("6. PF Applicable blank -> PF unresolved", () => {
    const r = month(8, 12000, PF_BLANK);
    assert.equal(r.employee_pf, null);
    assert.ok(r.unresolved.some((u) => u.code === engine.UNRESOLVED.PF_APPLICABILITY_NOT_RECORDED));
  });

  it("7. PF Yes + DOB missing -> PF calculates, only the EPS split is unresolved", () => {
    const r = month(10, 12000, DOB_MISSING, PREV_EPS.yes);
    assert.equal(r.employee_pf, 1440);
    assert.equal(r.employer_pf_total, 1440);
    assert.equal(r.employer_eps, null);
    assert.deepEqual(r.unresolved.map((u) => u.code), [engine.UNRESOLVED.EPS_DOB_NOT_RECORDED]);
  });

  it("a new joiner with PF Yes, under 58, Previous PF / EPS blank -> EPF + EPS", () => {
    const r = month(10, 12000, NEW_JOINER, { previous_pf_member: null, ...PREV_EPS.blank });
    assert.deepEqual(triple(r), [1440, 1000, 440]);
    assert.deepEqual(r.unresolved, []);
  });
});

/* ---------------------------------------------------------------- 8-10 */

describe("Previous PF / EPS Member never force recalculation or create holds", () => {
  const markersWith = (statutory) =>
    calc.sourceMarkers({ statutory: { ...EXISTING_UNDER_58, uan: "100000000001", ...statutory } });

  it("8. a Previous PF Member change does not trigger recalculation", () => {
    const before = markersWith({ previous_pf_member: null });
    [0, 1].forEach((v) => assert.deepEqual(calc.detectChanges(before, markersWith({ previous_pf_member: v })), []));
  });

  it("9. a Previous EPS Member change does not trigger recalculation", () => {
    const before = markersWith({ previous_eps_member: null });
    [0, 1].forEach((v) => assert.deepEqual(calc.detectChanges(before, markersWith({ previous_eps_member: v })), []));
    // A fact payroll does read still does.
    assert.ok(calc.detectChanges(before, markersWith({ dob: "1966-01-15" })).includes("STATUTORY_CONTEXT_CHANGED"));
  });

  it("10. Previous PF / EPS blanks do not create a statutory hold - existing employee or new joiner", () => {
    const blanks = { previous_pf_member: null, previous_eps_member: null, esi_applicable: 0, uan: "100000000001" };
    assert.deepEqual(statutorySetupGaps({ ...EXISTING_UNDER_58, ...blanks }, { year: 2026, month: 9 }), []);
    assert.deepEqual(statutorySetupGaps({ ...NEW_JOINER, ...blanks }, { year: 2026, month: 10 }), []);
  });
});

/* --------------------------------------------------------------- 11-13 */

describe("the EPFO wage-ceiling logic is unchanged", () => {
  it("11. September 2026 Scenario C (PF wage 20,000) is unchanged", () => {
    const r = month(9, 20000, EXISTING_UNDER_58, PREV_EPS.blank);
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
    // Synthetic Scenario C members with Basic between 15,000 and 25,000, Previous EPS blank:
    [
      [19000, [2024, 1405, 619], 8866.67],
      [17200, [1923, 1335, 588], 8026.67],
      [16400, [1878, 1304, 574], 7653.33],
    ].forEach(([basic, sep, p2]) => {
      const c = month(9, basic, { ...EXISTING_UNDER_58, date_of_joining: "2018-06-01" }, PREV_EPS.blank);
      assert.deepEqual(c.unresolved, []);
      assert.deepEqual(c.segments.map((s) => [s.pf_wage, s.eps_wage]), [[8000, 8000], [p2, p2]]);
      assert.deepEqual(triple(c), sep);
    });
  });

  it("12. employees at or below 15,000 are unchanged across August, September and October", () => {
    [10000, 12000, 15000].forEach((basic) => {
      const [aug, sep, oct] = [8, 9, 10].map((m) => triple(month(m, basic, EXISTING_UNDER_58)));
      assert.deepEqual(sep, aug, `${basic} September`);
      assert.deepEqual(oct, aug, `${basic} October`);
    });
  });

  it("13. October is one full month on the 25,000 ceiling", () => {
    const r = month(10, 20000, EXISTING_UNDER_58);
    assert.equal(r.split, false);
    assert.equal(r.ceiling_version, "EPFO-CEILING-25000-2026-09-17");
    assert.deepEqual([r.pf_wage, r.eps_wage, ...triple(r)], [20000, 20000, 2400, 1666, 734]);
    const above = month(10, 30000, EXISTING_UNDER_58);
    assert.deepEqual([above.pf_wage, above.eps_wage, ...triple(above)], [25000, 25000, 3000, 2083, 917]);
    const older = month(10, 30000, EXISTING_58_PLUS);
    assert.deepEqual(triple(older), [3000, 0, 3000], "58+ still EPS 0 on the new ceiling");
  });
});
