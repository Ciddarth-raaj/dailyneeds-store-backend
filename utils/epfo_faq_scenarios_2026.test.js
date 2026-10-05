/**
 * THE EPFO WAGE CEILING FAQ - its three 20,000 examples, encoded exactly.
 *
 *   IS_TEST=true node --test utils/epfo_faq_scenarios_2026.test.js
 *
 * The three examples differ ONLY in what the employee was before 17-09-2026,
 * which is why September cannot be "prorated 15,000 then prorated 25,000" for
 * everybody:
 *
 *   A  excluded until 16-09, PF + EPS member from 17-09
 *   B  EPF + EDLI member already contributing on 20,000 (higher-wage basis),
 *      not an EPS member until 17-09
 *   C  EPF + EPS member capped at 15,000 until 16-09
 *
 * DNDS RULE: EPS IS PF APPLICABLE + AGE ONLY. A and C are reproduced exactly.
 * B's Period-1 NIL EPS needs an employee who is EPS-excluded before 17-09 -
 * a status DNDS does not model (Previous EPS Member is reference data, never
 * a payroll gate) - so a B-type higher-wage member under 58 is charged EPS in
 * BOTH periods. That case is asserted on its own below, against what DNDS
 * computes, and is NOT the FAQ's B figure.
 *
 * ROUNDING CONVENTION (documented in docs/epfo-wage-ceiling-2026.md): every
 * period is computed to the paisa, which is the precision of the FAQ's own
 * figures (`pf_exact` / `exact`). The payroll deduction and the ECR are those
 * monthly totals rounded ONCE to the nearest rupee, with the employer EPF
 * share = employer 12% (rounded) less EPS (rounded).
 *
 * The payrun's PF wage is earned Basic, so each employee here is on a
 * structure whose Basic is the whole 20,000 PF wage (gross 20,000).
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const CONFIG = require("../config/statutory");
const pfPeriod = require("./pf_period");
const calc = require("./payrun_calculation");
const ecr = require("./epfo_ecr");

/* ================================================================ helpers */

function septemberDays({ absent = [], from = "2026-09-01", to = "2026-09-30" } = {}) {
  const rows = [];
  for (let d = 1; d <= 30; d += 1) {
    const date = `2026-09-${String(d).padStart(2, "0")}`;
    if (date < from || date > to) continue;
    const off = [6, 13, 20, 27].includes(d) || absent.includes(d);
    rows.push({ attendance_date: date, attendance_day_count: off ? 0 : 1 });
  }
  return rows;
}

/** One employee's month through the payrun's own `computeCalculation`. */
function payrun({
  basic = 20000,
  as_of = "2026-09-30",
  salary_days = 26,
  base_days = 26,
  day_rows,
  snapshot = {},
  statutory = {},
} = {}) {
  const gross = basic;
  const daily = Math.round((gross / 26) * 100) / 100;
  return calc.computeCalculation({
    snapshot: {
      monthly_gross: gross,
      basic,
      conveyance: 0,
      hra: 0,
      special_allowance: 0,
      pf_applicable: 1,
      esi_applicable: 0,
      pay_type: "BANK",
      date_of_joining: "2020-01-01",
      resignation_date: null,
      ...snapshot,
    },
    attendance: {
      attendance_monthly_payroll_id: 1,
      payroll_version: 1,
      is_final: 1,
      salary_days,
      base_days,
      extra_days: 0,
      salary_day_earnings: Math.round(daily * salary_days * 100) / 100,
      extra_day_earnings: 0,
      shortage_minutes: 0,
      missing_minute_deduction: 0,
      approved_ot_minutes: 0,
      approved_ot_earnings: 0,
    },
    nrm: calc.resolveEffectiveNrm([{ nrm_minutes: 480, break_allowance_source: "SHIFT", day_count: 26, approved_ot_minutes: 0 }]),
    amounts: {},
    statutory: { dob: "1990-06-15", previous_eps_member: 1, ...statutory },
    as_of,
    coverage_entry_salary: { salary_id: 1, monthly_gross: gross, basic, conveyance: 0, hra: 0, special_allowance: 0 },
    day_rows: day_rows === undefined ? (as_of.startsWith("2026-09") ? septemberDays() : null) : day_rows,
  });
}

function ecrLine(result, name, uan) {
  const file = ecr.buildEcr({
    rows: [
      {
        employee: { employee_id: 1, employee_name: name, uan },
        calculation: { ...result, employee_id: 1, status: "APPROVED_LOCKED", is_complete: result.is_complete ? 1 : 0 },
      },
    ],
  });
  assert.deepEqual(file.errors, []);
  assert.equal(file.lines.length, 1, "one ECR line per member for the month");
  assert.deepEqual(ecr.validateEcrMember(file.members[0]), []);
  return file;
}

/** The FAQ scenario as the payrun stores it, for assertion. */
const SCENARIOS = {
  A: () =>
    payrun({ snapshot: { pf_applicable: 1 }, statutory: { pf_applicable_from: "2026-09-17", previous_eps_member: 0 } }),
  B: () => payrun({ statutory: { pf_contribution_basis: "ACTUAL_WAGE", previous_eps_member: 0 } }),
  C: () => payrun({ statutory: { previous_eps_member: 1 } }),
};

/* ========================================================= the scenarios */

const FAQ = {
  A: {
    scenario: "FAQ_A:EXCLUDED>EPF_EPS|CEILING",
    p1: { epf: 0, eps: 0 },
    p2: { epf: 9333.33, eps: 9333.33 },
    total: { epf: 9333.33, eps: 9333.33 },
    exact: { employee_pf: 1120, employer_eps: 777.47, employer_epf: 342.53, edli: 46.67, pf_admin_charge: 46.67, total_remittance: 2333.34 },
    filed: { employee_pf: 1120, employer_eps: 777, employer_epf: 343, edli: 47, pf_admin_charge: 47, total_remittance: 2334 },
    ecr: ["100000000001", "SCENARIO A", 20000, 9333, 9333, 9333, 1120, 777, 343, 0, 0],
  },
  C: {
    scenario: "FAQ_C:EPF_EPS>EPF_EPS|CEILING",
    p1: { epf: 8000, eps: 8000 },
    p2: { epf: 9333.33, eps: 9333.33 },
    total: { epf: 17333.33, eps: 17333.33 },
    exact: { employee_pf: 2080, employer_eps: 1443.87, employer_epf: 636.13, edli: 86.67, pf_admin_charge: 86.67, total_remittance: 4333.34 },
    filed: { employee_pf: 2080, employer_eps: 1444, employer_epf: 636, edli: 87, pf_admin_charge: 87, total_remittance: 4334 },
    ecr: ["100000000003", "SCENARIO C", 20000, 17333, 17333, 17333, 2080, 1444, 636, 0, 0],
  },
};

Object.entries(FAQ).forEach(([letter, want]) => {
  describe(`EPFO FAQ Scenario ${letter} - September 2026, PF wage 20,000`, () => {
    const r = SCENARIOS[letter]();
    const [p1, p2] = r.pf_segments;

    it("is recognised as that scenario", () => {
      assert.equal(r.pf_scenario, want.scenario);
      assert.equal(r.is_complete, true);
    });

    it("Period 1 (01-16) EPF and EPS wages", () => {
      assert.deepEqual([p1.from, p1.to], ["2026-09-01", "2026-09-16"]);
      assert.equal(p1.pf_wage, want.p1.epf);
      assert.equal(p1.eps_wage, want.p1.eps);
    });

    it("Period 2 (17-30) EPF and EPS wages", () => {
      assert.deepEqual([p2.from, p2.to], ["2026-09-17", "2026-09-30"]);
      assert.equal(p2.pf_wage, want.p2.epf);
      assert.equal(p2.eps_wage, want.p2.eps);
    });

    it("total EPF and EPS wages", () => {
      assert.equal(r.pf_wage, want.total.epf);
      assert.equal(r.eps_wage, want.total.eps);
    });

    it("employee PF, employer EPS, employer EPF, EDLI, admin and total remittance - exactly as the FAQ", () => {
      Object.entries(want.exact).forEach(([k, v]) => assert.equal(r.pf_exact[k], v, k));
    });

    it("the same, as deducted and filed (rounded once to whole rupees)", () => {
      assert.equal(r.employee_pf, want.filed.employee_pf);
      assert.equal(r.employer_eps, want.filed.employer_eps);
      assert.equal(r.employer_epf, want.filed.employer_epf);
      assert.equal(r.edli, want.filed.edli);
      assert.equal(r.pf_admin_charge, want.filed.pf_admin_charge);
      assert.equal(r.pf_total_remittance, want.filed.total_remittance);
      assert.equal(r.employer_pf_total, r.employer_eps + r.employer_epf);
    });

    it("one ECR line with the final values", () => {
      const file = ecrLine(r, `Scenario ${letter}`, want.ecr[0]);
      assert.equal(file.lines[0], want.ecr.join("#~#"));
    });
  });
});

describe("a B-type member under the DNDS rule: higher-wage basis (20,000), PF applicable, under 58", () => {
  const b = SCENARIOS.B();
  it("EPS in BOTH periods - Previous EPS Member = No does not exclude anybody", () => {
    assert.equal(b.pf_scenario, "EPF_EPS>EPF_EPS|ACTUAL_WAGE");
    assert.deepEqual(b.pf_segments.map((s) => [s.pf_wage, s.eps_wage]), [[10666.67, 8000], [9333.33, 9333.33]]);
    assert.equal(b.is_complete, true);
  });
  it("EE 2,400, EPS 1,443.87 (1,444 filed), ER EPF 956.13 (956), EDLI 100, admin 100, total 5,000", () => {
    assert.deepEqual(
      [b.pf_exact.employee_pf, b.pf_exact.employer_eps, b.pf_exact.employer_epf, b.pf_exact.edli, b.pf_exact.pf_admin_charge, b.pf_exact.total_remittance],
      [2400, 1443.87, 956.13, 100, 100, 5000]
    );
    assert.deepEqual([b.employee_pf, b.employer_eps, b.employer_epf], [2400, 1444, 956]);
  });
});

describe("the FAQ scenarios DNDS reproduces are different answers - none is the other", () => {
  const [a, c] = ["A", "C"].map((k) => SCENARIOS[k]());
  it("employee PF 1,120 / 2,080 and EPS wages 9,333.33 / 17,333.33", () => {
    assert.deepEqual([a.employee_pf, c.employee_pf], [1120, 2080]);
    assert.deepEqual([a.eps_wage, c.eps_wage], [9333.33, 17333.33]);
  });
});

/* ================================================== the additional cases */

const BASE = { pf_applicable: 1, dob: "1990-06-15", date_of_joining: "2020-01-01", previous_eps_member: 1 };
const month = (m, basic, extra = {}) =>
  pfPeriod.calculatePfForMonth({ ...BASE, year: 2026, month: m, monthly_basic: basic, earned_basic: basic, ...extra });

describe("the employee states, one by one", () => {
  it("excluded employee 20,000, not enrolled: no PF at all (enrolment is a separate, approved step)", () => {
    const r = payrun({ snapshot: { pf_applicable: 0 } });
    assert.equal(r.pf_status, "NOT_APPLICABLE");
    assert.equal(r.employee_pf, 0);
    assert.equal(r.pf_scenario, "EXCLUDED>EXCLUDED|CEILING");
  });

  it("Previous EPS Member = No or blank changes nothing: still Scenario C", () => {
    [0, null].forEach((previous_eps_member) => {
      const r = month(9, 20000, { previous_eps_member });
      assert.equal(r.pf_scenario, "FAQ_C:EPF_EPS>EPF_EPS|CEILING");
      assert.deepEqual([r.employee_pf, r.exact.employer_eps], [2080, 1443.87]);
      assert.deepEqual(r.unresolved, []);
    });
  });

  it("EPF + EPS capped employee 20,000 is Scenario C", () => {
    assert.equal(month(9, 20000).pf_scenario, "FAQ_C:EPF_EPS>EPF_EPS|CEILING");
  });

  it("existing higher-wage contributor ABOVE 25,000: EPF on the actual wage, EPS capped per period", () => {
    const r = month(9, 30000, { pf_contribution_basis: "ACTUAL_WAGE" });
    // EPF 30,000 x 16/30 = 16,000 + 14,000; EPS min(.., 8,000) + min(.., 11,666.67)
    assert.deepEqual(r.segments.map((s) => [s.pf_wage, s.eps_wage]), [[16000, 8000], [14000, 11666.67]]);
    assert.equal(r.employee_pf, 3600);
    assert.equal(month(10, 30000, { pf_contribution_basis: "ACTUAL_WAGE" }).eps_wage, 25000);
  });

  [
    [10000, 1200, 1200, 1200],
    [15000, 1800, 1800, 1800],
    [25000, 1800, 2360, 3000],
    [30000, 1800, 2360, 3000],
  ].forEach(([wage, aug, sep, oct]) =>
    it(`PF wage ${wage} (ceiling basis): August ${aug}, September ${sep}, October ${oct}`, () => {
      assert.deepEqual([month(8, wage).employee_pf, month(9, wage).employee_pf, month(10, wage).employee_pf], [aug, sep, oct]);
    })
  );

  it("Previous EPS Member makes no difference (post-2014 joiner, under 58)", () => {
    [1, 0, null].forEach((previous_eps_member) => {
      assert.equal(month(8, 20000, { previous_eps_member }).employer_eps, 1250);
      assert.equal(month(10, 20000, { previous_eps_member }).employer_eps, 1666);
      assert.equal(month(10, 30000, { previous_eps_member }).employer_eps, 2083, "EPS capped at 25,000 from October");
    });
  });

  it("age 58+: no EPS in either period, the whole employer share to EPF", () => {
    const r = month(9, 20000, { dob: "1960-01-01" });
    assert.deepEqual(r.segments.map((s) => s.state), ["EPF_ONLY", "EPF_ONLY"]);
    assert.deepEqual([r.employer_eps, r.employer_epf], [0, 2080]);
  });
});

describe("joining, leaving and loss of pay in September", () => {
  it("joining before 17 Sep (10-09): both periods, in proportion to employed days", () => {
    const r = payrun({ salary_days: 18, base_days: 18, day_rows: septemberDays({ from: "2026-09-10" }), snapshot: { date_of_joining: "2026-09-10" } });
    assert.deepEqual(r.pf_segments.map((s) => s.employed_days), [7, 14]);
    assert.deepEqual(r.pf_segments.map((s) => s.state), ["EPF_EPS", "EPF_EPS"]);
  });

  it("joining ON 17 Sep: Period 1 not employed, Period 2 only", () => {
    const r = payrun({ salary_days: 12, base_days: 12, day_rows: septemberDays({ from: "2026-09-17" }), snapshot: { date_of_joining: "2026-09-17" } });
    assert.deepEqual(r.pf_segments.map((s) => s.state), ["NOT_EMPLOYED", "EPF_EPS"]);
    assert.equal(r.pf_segments[0].pf_wage, 0);
    assert.equal(r.pf_wage, r.pf_segments[1].pf_wage);
  });

  it("joining AFTER 17 Sep (21-09): Period 2 only, fewer employed days", () => {
    const r = payrun({ salary_days: 9, base_days: 9, day_rows: septemberDays({ from: "2026-09-21" }), snapshot: { date_of_joining: "2026-09-21" } });
    assert.deepEqual(r.pf_segments.map((s) => s.employed_days), [0, 10]);
    assert.equal(r.pf_segments[0].employee_pf, 0);
  });

  it("resignation during September (10-09): Period 1 only", () => {
    const r = payrun({ salary_days: 9, base_days: 9, day_rows: septemberDays({ to: "2026-09-10" }), snapshot: { resignation_date: "2026-09-10" } });
    assert.deepEqual(r.pf_segments.map((s) => s.state), ["EPF_EPS", "NOT_EMPLOYED"]);
    assert.equal(r.pf_segments[1].employee_pf, 0);
  });

  it("LOP before 17 Sep shrinks Period 1; LOP after shrinks Period 2", () => {
    const early = payrun({ basic: 12000, salary_days: 23, day_rows: septemberDays({ absent: [2, 3, 4] }) });
    const late = payrun({ basic: 12000, salary_days: 23, day_rows: septemberDays({ absent: [22, 23, 24] }) });
    assert.ok(early.pf_segments[0].lop_days > early.pf_segments[1].lop_days);
    assert.ok(late.pf_segments[1].lop_days > late.pf_segments[0].lop_days);
    assert.equal(early.ncp_days, 3);
  });
});

describe("October and the months before September", () => {
  it("October: one full period on 25,000 - EPF 20,000, EPS 20,000, EE 2,400, total remittance 5,000", () => {
    const r = payrun({ as_of: "2026-10-31" });
    assert.equal(r.pf_split, false);
    assert.deepEqual([r.pf_wage, r.eps_wage, r.employee_pf, r.employer_eps, r.employer_epf, r.edli, r.pf_admin_charge], [20000, 20000, 2400, 1666, 734, 100, 100]);
    assert.equal(r.pf_total_remittance, 5000);
  });

  it("August (before September) is unchanged: 15,000 ceiling, EE 1,800, EPS 1,250, EPF 550, EDLI 75, admin 75", () => {
    const r = payrun({ as_of: "2026-08-31" });
    assert.deepEqual([r.pf_wage, r.employee_pf, r.employer_eps, r.employer_epf, r.edli, r.pf_admin_charge], [15000, 1800, 1250, 550, 75, 75]);
    assert.equal(r.pf_ceiling_version, "EPFO-CEILING-15000-2014-09-01");
  });

  it("a higher-wage contributor's August is unchanged too (EPF on 20,000)", () => {
    const r = payrun({ as_of: "2026-08-31", statutory: { pf_contribution_basis: "ACTUAL_WAGE", previous_eps_member: 1 } });
    assert.deepEqual([r.pf_wage, r.employee_pf, r.employer_eps], [20000, 2400, 1250]);
  });

  it("the configured default basis is the ceiling", () => {
    assert.equal(pfPeriod.resolveBasis(null, CONFIG), "CEILING");
  });
});
