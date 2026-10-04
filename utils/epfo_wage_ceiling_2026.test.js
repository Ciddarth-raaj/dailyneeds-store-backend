/**
 * EPFO STATUTORY WAGE CEILING REVISION - 15,000 -> 25,000 w.e.f. 17-09-2026.
 *
 *   IS_TEST=true node --test utils/epfo_wage_ceiling_2026.test.js
 *
 * The twenty mandatory cases from the change request, numbered as they were
 * asked for, plus the configuration and report checks. Every figure is worked
 * by hand in the comment beside it. The PF wage basis is BASIC ONLY
 * (`config/statutory.js#pf`), so "PF wage" below is the monthly Basic.
 *
 * September 2026 has 30 days: Period 1 is 01-16 (16 days) on the 15,000
 * ceiling, Period 2 is 17-30 (14 days) on 25,000. A monthly ceiling applied to
 * part of a month is prorated by the period's calendar length:
 *
 *   Period 1 ceiling  15,000 x 16/30 =  8,000.00
 *   Period 2 ceiling  25,000 x 14/30 = 11,666.67
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const CONFIG = require("../config/statutory");
const engine = require("./salary_engine");
const pfPeriod = require("./pf_period");
const calc = require("./payrun_calculation");
const ecr = require("./epfo_ecr");
const impact = require("./pf_ceiling_impact");
const payslip = require("./payslip_snapshot");

/* ================================================================ helpers */

const BASE = {
  pf_applicable: 1,
  dob: "1990-06-15",
  date_of_joining: "2020-01-01", // after the 01-09-2014 new-member cutoff
  previous_eps_member: 1,
};

/** A standard (full attendance) month of PF for a Basic. */
const month = (year, m, basic, extra = {}) =>
  pfPeriod.calculatePfForMonth({ ...BASE, year, month: m, monthly_basic: basic, earned_basic: basic, ...extra });

const sep = (basic, extra) => month(2026, 9, basic, extra);
const oct = (basic, extra) => month(2026, 10, basic, extra);
const aug = (basic, extra) => month(2026, 8, basic, extra);

/**
 * September 2026 attendance day rows: every day attended except Sundays
 * (6, 13, 20, 27), minus any `absent` dates, within the employed window.
 */
function septemberDays({ absent = [], from = "2026-09-01", to = "2026-09-30" } = {}) {
  const rows = [];
  for (let d = 1; d <= 30; d += 1) {
    const date = `2026-09-${String(d).padStart(2, "0")}`;
    if (date < from || date > to) continue;
    const sunday = [6, 13, 20, 27].includes(d);
    rows.push({ attendance_date: date, attendance_day_count: sunday || absent.includes(d) ? 0 : 1 });
  }
  return rows;
}

/**
 * One employee's whole payrun month through `computeCalculation` - the same
 * function the payrun runs. Gross = Basic x 2 so the structure is realistic;
 * ESI is off so the PF arithmetic is the only statutory figure in play.
 */
function payrun({ basic, as_of = "2026-09-30", salary_days = 26, base_days = 26, day_rows, snapshot = {}, statutory = {} }) {
  const gross = basic * 2;
  const daily = Math.round((gross / 26) * 100) / 100;
  return calc.computeCalculation({
    snapshot: {
      monthly_gross: gross,
      basic,
      conveyance: 2500,
      hra: Math.min(10000, gross - basic - 2500),
      special_allowance: gross - basic - 2500 - Math.min(10000, gross - basic - 2500),
      pf_applicable: 1,
      esi_applicable: 0,
      pay_type: "BANK",
      date_of_joining: BASE.date_of_joining,
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
    statutory: { dob: BASE.dob, previous_eps_member: BASE.previous_eps_member, ...statutory },
    as_of,
    // The approved salary in force when the ESI contribution period began -
    // the same structure - so the ESI coverage rule has its evidence.
    coverage_entry_salary: {
      salary_id: 1,
      monthly_gross: gross,
      basic,
      conveyance: 2500,
      hra: Math.min(10000, gross - basic - 2500),
      special_allowance: gross - basic - 2500 - Math.min(10000, gross - basic - 2500),
    },
    day_rows: day_rows === undefined ? (as_of.startsWith("2026-09") ? septemberDays() : null) : day_rows,
  });
}

const r2 = (n) => Math.round(n * 100) / 100;

/* ============================================ the configuration, effective-dated */

describe("the statutory ceiling is configuration, effective-dated", () => {
  it("15,000 up to 16-09-2026 and 25,000 from 17-09-2026, each with its own version", () => {
    assert.equal(engine.pfCeilingOn("2026-09-16").wageCeiling, 15000);
    assert.equal(engine.pfCeilingOn("2026-09-17").wageCeiling, 25000);
    assert.equal(engine.pfCeilingOn("2026-09-17").epsWageCeiling, 25000);
    assert.equal(engine.pfCeilingOn("2026-09-17").edliWageCeiling, 25000);
    assert.notEqual(engine.pfCeilingOn("2026-09-16").version, engine.pfCeilingOn("2026-09-17").version);
  });

  it("a FUTURE revision is a new schedule row, not new payroll logic", () => {
    const future = {
      ...CONFIG,
      pf: {
        ...CONFIG.pf,
        ceilingSchedule: [
          ...CONFIG.pf.ceilingSchedule,
          { effectiveFrom: "2030-04-11", wageCeiling: 30000, epsWageCeiling: 30000, edliWageCeiling: 30000, version: "TEST-30000" },
        ],
      },
    };
    const segs = pfPeriod.segmentMonth({ from: "2030-04-01", to: "2030-04-30" }, future);
    assert.deepEqual(segs.map((s) => [s.from, s.to, s.wage_ceiling]), [
      ["2030-04-01", "2030-04-10", 25000],
      ["2030-04-11", "2030-04-30", 30000],
    ]);
  });

  it("September 2026 is the only month of 2026 that splits", () => {
    for (let m = 1; m <= 12; m += 1) {
      const { from, to } = pfPeriod.monthBounds(2026, m);
      assert.equal(pfPeriod.segmentMonth({ from, to }).length, m === 9 ? 2 : 1, `month ${m}`);
    }
  });
});

/* =========================================================== the twenty cases */

describe("mandatory cases 1-5: the employee PF on each PF wage, October onward", () => {
  // Full month on 25,000: employee PF = 12% of min(PF wage, 25,000).
  [
    [10000, 1200],
    [15000, 1800],
    [20000, 2400],
    [25000, 3000],
    [30000, 3000], // above the ceiling: the ceiling applies
  ].forEach(([wage, expected], i) => {
    it(`${i + 1}. PF wage ${wage} -> employee PF ${expected}`, () => {
      const pf = oct(wage);
      assert.equal(pf.employee_pf, expected);
      assert.equal(pf.pf_wage, Math.min(wage, 25000));
      assert.equal(pf.split, false);
      assert.equal(pf.ceiling_version, "EPFO-CEILING-25000-2026-09-17");
    });
  });

  it("the same wages in August (before the revision) are still capped at 15,000", () => {
    assert.deepEqual([10000, 15000, 20000, 25000, 30000].map((w) => aug(w).employee_pf), [1200, 1800, 1800, 1800, 1800]);
  });

  it("is never a flat 3,000: the actual eligible PF wage decides it", () => {
    assert.equal(oct(18750).employee_pf, 2250);
    assert.equal(oct(0).employee_pf, 0);
  });
});

describe("6. an existing PF + EPS member previously capped at 15,000 (PF wage 20,000)", () => {
  const member = { previous_eps_member: 1 };

  it("August: EE 1,800, EPS 1,250, EPF 550 - unchanged", () => {
    const pf = aug(20000, member);
    assert.deepEqual([pf.employee_pf, pf.employer_eps, pf.employer_epf], [1800, 1250, 550]);
  });

  it("September is FAQ Scenario C: EPF + EPS 8,000 then 9,333.33 - EE 2,080, EPS 1,443.87 exact (1,444 filed)", () => {
    // P1  8,000.00: EE 960.00, EPS 666.40;  P2  9,333.33: EE 1,120.00, EPS 777.47
    const pf = sep(20000, member);
    assert.equal(pf.pf_scenario, "FAQ_C:EPF_EPS>EPF_EPS|CEILING");
    assert.equal(pf.employee_pf, 2080);
    assert.equal(pf.exact.employer_eps, 1443.87);
    assert.equal(pf.employer_eps, 1444);
    assert.equal(pf.employer_epf, 2080 - 1444);
    assert.deepEqual(pf.segments.map((s) => s.employer_eps), [666.4, 777.47]);
  });

  it("October: EE 2,400, EPS 1,666 (8.33% of 20,000), EPF 734", () => {
    const pf = oct(20000, member);
    assert.deepEqual([pf.employee_pf, pf.employer_eps, pf.employer_epf], [2400, 1666, 734]);
  });
});

describe("7. a previously PF-excluded employee with PF wage 20,000", () => {
  it("is NOT enrolled automatically: recorded as not applicable, no PF is charged", () => {
    const r = payrun({ basic: 20000, snapshot: { pf_applicable: 0 } });
    assert.equal(r.pf_status, "NOT_APPLICABLE");
    assert.equal(r.employee_pf, 0);
    assert.equal(r.employer_pf_total, 0);
  });

  it("is FLAGGED in the affected-employee report as possibly needing enrolment from 17-09-2026", () => {
    const e = impact.assessEmployee({ employee_id: 7, basic: 20000, monthly_gross: 40000, ...BASE, pf_applicable: 0, previous_eps_member: 0 });
    assert.equal(e.category, impact.CATEGORY.FROM_15001_TO_25000);
    assert.ok(e.flags.includes(impact.FLAG.MAY_REQUIRE_PF_ENROLMENT));
    assert.equal(e.september.employee_pf, 0, "the recorded position is reported as it is");
    assert.equal(e.monthly_employer_cost_increase, 0);
  });

  it("if HR enrols them from 17-09-2026: no PF for 01-16, Period 2 only, EPS from 17-09", () => {
    const pf = sep(20000, { pf_applicable: 1, pf_applicable_from: "2026-09-17", previous_eps_member: 0 });
    assert.equal(pf.segments[0].pf_covered, false);
    assert.equal(pf.segments[0].employee_pf, 0);
    assert.equal(pf.employee_pf, 1120); // 9,333.33 x 12%
    assert.equal(pf.employer_eps, 777);
    const e = impact.assessEmployee({ employee_id: 7, basic: 20000, monthly_gross: 40000, ...BASE, pf_applicable: 0, previous_eps_member: 0 });
    assert.equal(e.if_enrolled.september.employee_pf, 1120);
    assert.equal(e.if_enrolled.october.employee_pf, 2400);
  });
});

describe("8. an existing EPF member who is NOT an EPS member, PF wage 20,000", () => {
  const pfOnly = { previous_eps_member: 0 };

  it("August: no EPS - joined after 01-09-2014 above the 15,000 pension ceiling", () => {
    const pf = aug(20000, pfOnly);
    assert.equal(pf.employer_eps, 0);
    assert.equal(pf.employer_epf, 1800);
  });

  it("from 17-09-2026 they are inside the 25,000 ceiling and become EPS members", () => {
    const pf = sep(20000, pfOnly);
    assert.deepEqual(pf.segments.map((s) => s.state), ["EPF_ONLY", "EPF_EPS"]);
    assert.equal(oct(20000, pfOnly).employer_eps, 1666);
  });

  it("on the HIGHER-WAGE basis this is FAQ Scenario B: EPF 10,666.67 + 9,333.33, EE 2,400 (not 2,080)", () => {
    const b = sep(20000, { ...pfOnly, pf_contribution_basis: "ACTUAL_WAGE" });
    assert.equal(b.pf_scenario, "FAQ_B:EPF_ONLY>EPF_EPS|ACTUAL_WAGE");
    assert.equal(b.employee_pf, 2400);
  });

  it("on the CEILING basis it is NOT a FAQ case: EPF 8,000 + 9,333.33, EE 2,080, EPS only from 17-09", () => {
    // An EPF-only member whose EPF was capped at 15,000. The FAQ has no such
    // example; the rule applied is the FAQ's own (old ceiling, then new).
    const c = sep(20000, pfOnly);
    assert.equal(c.pf_scenario, "EPF_ONLY>EPF_EPS|CEILING");
    assert.deepEqual(c.segments.map((s) => [s.pf_wage, s.eps_wage]), [[8000, 0], [9333.33, 9333.33]]);
    assert.equal(c.employee_pf, 2080);
    assert.equal(c.exact.employer_eps, 777.47);
  });

  it("PF and EPS stay separate: PF Applicable alone never decides EPS", () => {
    const withHistory = sep(20000, { previous_eps_member: 1 });
    const without = sep(20000, { previous_eps_member: 0 });
    assert.equal(withHistory.employee_pf, without.employee_pf, "the PF side is identical");
    assert.notEqual(withHistory.segments[0].employer_eps, without.segments[0].employer_eps, "the EPS side is not");
    const unknown = sep(20000, { previous_eps_member: null });
    assert.ok(
      unknown.unresolved.some((u) => u.code === engine.UNRESOLVED.EPS_MEMBERSHIP_NOT_RECORDED && u.period_to === "2026-09-16"),
      "an unrecorded EPS history is a question for Period 1, not a guess"
    );
    assert.equal(unknown.employer_eps, null);
    const r = payrun({ basic: 20000, statutory: { previous_eps_member: null } });
    assert.equal(r.is_complete, false, "and the month cannot be approved until it is answered");
    assert.equal(unknown.employee_pf, 2080, "the employee share is still known");
  });
});

describe("9. age 58+", () => {
  it("58 before the month: no EPS in either period, the whole employer 12% is EPF", () => {
    const pf = sep(20000, { dob: "1967-05-01" });
    assert.equal(pf.employee_pf, 2080);
    assert.equal(pf.employer_eps, 0);
    assert.equal(pf.employer_epf, 2080);
    assert.equal(pf.eps_wage, 0);
    assert.equal(oct(20000, { dob: "1967-05-01" }).employer_eps, 0);
  });

  it("58 on 20-09-2026: EPS in Period 1 (age 57 on 16-09), none in Period 2", () => {
    const pf = sep(20000, { dob: "1968-09-20" });
    assert.deepEqual(pf.segments.map((s) => s.eps_eligible), [true, false]);
    assert.equal(pf.employer_eps, 666);
  });

  it("is flagged in the report", () => {
    const e = impact.assessEmployee({ employee_id: 9, basic: 20000, ...BASE, dob: "1960-01-01" });
    assert.ok(e.flags.includes(impact.FLAG.AGE_58_PLUS));
  });
});

describe("10. joining BEFORE 17 September (10-09-2026, PF wage 20,000)", () => {
  // Employed 10-30: 21 dates, 3 notional offs, 18 base days. Full attendance:
  // earned Basic = 20,000 x 18/26 = 13,846.15, apportioned 7 : 14 paid days.
  const r = payrun({
    basic: 20000,
    salary_days: 18,
    base_days: 18,
    day_rows: septemberDays({ from: "2026-09-10" }),
    snapshot: { date_of_joining: "2026-09-10" },
    statutory: { previous_eps_member: 0 },
  });
  const segs = r.pf_segments;

  it("is charged in both periods, in proportion to the days employed in each", () => {
    assert.equal(r.pf_split, true);
    assert.equal(segs[0].employed_days, 7);
    assert.equal(segs[1].employed_days, 14);
    assert.equal(r2(segs[0].earned_basic_share + segs[1].earned_basic_share), 13846.15);
    assert.equal(segs[0].earned_basic_share, 4615.38);
    assert.equal(segs[0].pf_wage, 4615.38, "below the prorated 8,000 ceiling");
    assert.equal(segs[1].pf_wage, 9230.77);
    assert.equal(r.employee_pf, 554 + 1108);
  });

  it("a new member above 15,000: no EPS for 10-16, EPS from 17-09", () => {
    assert.deepEqual(segs.map((s) => s.eps_eligible), [false, true]);
    assert.equal(r.is_complete, true);
  });
});

describe("11. joining ON / AFTER 17 September (17-09-2026, PF wage 30,000)", () => {
  // Employed 17-30: 14 dates, 2 offs, 12 base days -> earned 30,000 x 12/26 = 13,846.15
  const r = payrun({
    basic: 30000,
    salary_days: 12,
    base_days: 12,
    day_rows: septemberDays({ from: "2026-09-17" }),
    snapshot: { date_of_joining: "2026-09-17" },
    statutory: { previous_eps_member: 1 },
  });

  it("nothing is charged in Period 1, and Period 2 is on the 25,000 ceiling prorated to 11,666.67", () => {
    assert.equal(r.pf_segments[0].status, "NOT_APPLICABLE");
    assert.equal(r.pf_segments[0].employee_pf, 0);
    assert.equal(r.pf_segments[1].pf_wage, 11666.67);
    assert.equal(r.employee_pf, 1400);
    assert.equal(r.pf_status, "APPLIED");
  });

  it("an empty Period 1 raises no EPS question of its own", () => {
    const unknown = payrun({
      basic: 20000,
      salary_days: 12,
      base_days: 12,
      day_rows: septemberDays({ from: "2026-09-17" }),
      snapshot: { date_of_joining: "2026-09-17" },
      statutory: { previous_eps_member: null },
    });
    assert.equal(unknown.is_complete, true, "20,000 is within 25,000: eligible whatever the history");
  });
});

describe("12. resigning during September (last day 10-09-2026, PF wage 20,000)", () => {
  // Employed 01-10: 10 dates, 1 off, 9 base days -> earned 20,000 x 9/26 = 6,923.08, all Period 1
  const r = payrun({
    basic: 20000,
    salary_days: 9,
    base_days: 9,
    day_rows: septemberDays({ to: "2026-09-10" }),
    snapshot: { resignation_date: "2026-09-10" },
  });

  it("is charged in Period 1 only, on the old ceiling", () => {
    assert.equal(r.pf_segments[1].status, "NOT_APPLICABLE");
    assert.equal(r.pf_segments[0].pf_wage, 6923.08);
    assert.equal(r.employee_pf, 831);
    assert.equal(r.pf_wage, 6923.08);
  });
});

describe("13-14. loss of pay lands in the period it fell in", () => {
  // Basic 12,000: below both prorated ceilings, so every rupee of earned wage counts.
  const full = payrun({ basic: 12000 });
  const lopEarly = payrun({ basic: 12000, salary_days: 23, day_rows: septemberDays({ absent: [2, 3, 4] }) });
  const lopLate = payrun({ basic: 12000, salary_days: 23, day_rows: septemberDays({ absent: [22, 23, 24] }) });

  it("full attendance splits exactly 16/30 and 14/30", () => {
    assert.equal(full.pf_segments[0].earned_basic_share, 6400);
    assert.equal(full.pf_segments[1].earned_basic_share, 5600);
    assert.equal(full.pf_segments[0].lop_days, 0);
    assert.equal(full.pf_segments[1].lop_days, 0);
    assert.equal(full.employee_pf, 1440);
  });

  it("13. LOP during 01-16: Period 1 shrinks, the earned month total is unchanged", () => {
    const [p1, p2] = lopEarly.pf_segments;
    assert.equal(r2(p1.earned_basic_share + p2.earned_basic_share), r2((12000 * 23) / 26));
    assert.ok(p1.lop_days > p2.lop_days);
    assert.ok(p1.earned_basic_share < 6400 * (23 / 26), "Period 1 bears the loss");
    assert.ok(p2.earned_basic_share > 5600 * (23 / 26));
    assert.equal(lopEarly.ncp_days, 3);
  });

  it("14. LOP during 17-30: Period 2 shrinks instead", () => {
    const [p1, p2] = lopLate.pf_segments;
    assert.ok(p2.lop_days > p1.lop_days);
    assert.ok(p2.earned_basic_share < 5600 * (23 / 26));
    assert.ok(p1.earned_basic_share > 6400 * (23 / 26));
  });

  it("where the LOP fell matters once the wage reaches a period ceiling (PF wage 20,000)", () => {
    // 20,000 early-LOP: Period 1 share still above 8,000 -> capped either way.
    const early = payrun({ basic: 20000, salary_days: 23, day_rows: septemberDays({ absent: [2, 3, 4] }) });
    const late = payrun({ basic: 20000, salary_days: 23, day_rows: septemberDays({ absent: [22, 23, 24] }) });
    assert.equal(early.pf_segments[0].pf_wage, 8000);
    assert.equal(late.pf_segments[0].pf_wage, 8000);
    assert.ok(late.employee_pf < early.employee_pf, "uncapped Period 2 loses more when the LOP is in it");
  });
});

describe("15. the September split-period calculation (the FAQ's own figures are in epfo_faq_scenarios_2026.test.js)", () => {
  // An EPF-only member on the CEILING basis - not one of the FAQ's three.
  const r = payrun({ basic: 20000, statutory: { previous_eps_member: 0 } });
  const [p1, p2] = r.pf_segments;

  it("Period 1: 01-16 on the 15,000 ceiling prorated to 8,000", () => {
    assert.deepEqual([p1.from, p1.to, p1.monthly_wage_ceiling, p1.applied_wage_ceiling], ["2026-09-01", "2026-09-16", 15000, 8000]);
    assert.deepEqual([p1.pf_wage, p1.eps_wage, p1.state], [8000, 0, "EPF_ONLY"]);
  });

  it("Period 2: 17-30 on the 25,000 ceiling, EPF and EPS wages 9,333.33 (exact contributions)", () => {
    assert.deepEqual([p2.from, p2.to, p2.monthly_wage_ceiling], ["2026-09-17", "2026-09-30", 25000]);
    assert.deepEqual([p2.pf_wage, p2.eps_wage, p2.state], [9333.33, 9333.33, "EPF_EPS"]);
    assert.deepEqual([p2.employee_pf, p2.employer_eps, p2.employer_epf], [1120, 777.47, 342.53]);
  });

  it("ONE September result: exact sums, rounded once to file", () => {
    assert.equal(r.pf_wage, 17333.33);
    assert.equal(r.eps_wage, 9333.33);
    assert.deepEqual([r.employee_pf, r.employer_pf_total, r.employer_eps, r.employer_epf], [2080, 2080, 777, 1303]);
    assert.equal(r.pf_exact.employer_epf, 1302.53);
    assert.equal(r.is_complete, true);
  });

  it("carries the audit trail: both ceiling versions, the scenario and the statutory config version", () => {
    assert.equal(r.pf_ceiling_version, "EPFO-CEILING-15000-2014-09-01+EPFO-CEILING-25000-2026-09-17");
    assert.equal(r.pf_scenario, "EPF_ONLY>EPF_EPS|CEILING");
    assert.equal(r.statutory_config_version, CONFIG.configVersion);
    assert.deepEqual(r.pf_segments.map((s) => s.ceiling_version), ["EPFO-CEILING-15000-2014-09-01", "EPFO-CEILING-25000-2026-09-17"]);
  });
});

describe("16. October 2026: the full month on 25,000", () => {
  const r = payrun({ basic: 20000, as_of: "2026-10-31", statutory: { previous_eps_member: 0 } });
  it("one period, no proration, EE 2,400, EPS 1,666, EPF 734", () => {
    assert.equal(r.pf_split, false);
    assert.equal(r.pf_segments.length, 1);
    assert.equal(r.pf_segments[0].prorated, false);
    assert.deepEqual([r.pf_wage, r.employee_pf, r.employer_eps, r.employer_epf], [20000, 2400, 1666, 734]);
    assert.equal(r.pf_ceiling_version, "EPFO-CEILING-25000-2026-09-17");
  });
});

/** The stored-row shape a payrun calculation is persisted as. */
function stored(result, over = {}) {
  return {
    ...result,
    payrun_employee_id: 1,
    payrun_calculation_id: 1,
    employee_id: 101,
    calculation_revision: 1,
    calculation_hash: calc.calculationHash(result),
    pf_applicable: 1,
    esi_applicable: 0,
    ot_groups: JSON.stringify(result.ot_groups || []),
    pf_segments: JSON.stringify(result.pf_segments || []),
    status: "APPROVED_LOCKED",
    is_complete: result.is_complete ? 1 : 0,
    ...over,
  };
}

describe("17. the September ECR", () => {
  // An EPF-only member on the CEILING basis (not a FAQ case; the FAQ ECRs are in epfo_faq_scenarios_2026.test.js).
  const epfOnlyCapped = payrun({ basic: 20000, statutory: { previous_eps_member: 0 } });
  const low = payrun({ basic: 12000 });
  const excluded = payrun({ basic: 22000, snapshot: { pf_applicable: 0 } });
  const file = ecr.buildEcr({
    rows: [
      { employee: { employee_id: 101, employee_name: "Example Member", uan: "100200300400" }, calculation: stored(epfOnlyCapped) },
      { employee: { employee_id: 102, employee_name: "Low Wage", uan: "100200300401" }, calculation: stored(low, { employee_id: 102 }) },
      { employee: { employee_id: 103, employee_name: "Excluded", uan: null }, calculation: stored(excluded, { employee_id: 103 }) },
      { employee: { employee_id: 104, employee_name: "No Uan" }, calculation: stored(low, { employee_id: 104 }) },
      { employee: { employee_id: 105, employee_name: "Not Approved", uan: "100200300405" }, calculation: stored(low, { employee_id: 105, status: "CALCULATED" }) },
    ],
  });

  it("ONE line per member for the month, with the two periods summed", () => {
    assert.equal(file.lines.length, 2);
    assert.equal(
      file.lines[0],
      ["100200300400", "EXAMPLE MEMBER", 40000, 17333, 9333, 17333, 2080, 777, 1303, 0, 0].join("#~#")
    );
    assert.equal(file.lines.filter((l) => l.startsWith("100200300400")).length, 1);
  });

  it("passes the portal's arithmetic checks (12% EE, 8.33% EPS, difference)", () => {
    file.members.forEach((m) => assert.deepEqual(ecr.validateEcrMember(m), [], `member ${m.employee_id}`));
  });

  it("leaves out non-members, and refuses rather than files a missing UAN or an unapproved month", () => {
    assert.ok(!file.lines.some((l) => l.includes("EXCLUDED")));
    assert.deepEqual(file.errors.map((e) => [e.employee_id, e.code]), [[104, "UAN_MISSING"], [105, "NOT_APPROVED"]]);
  });

  it("totals the contributions it files", () => {
    assert.equal(file.totals.members, 2);
    assert.equal(file.totals.ee_share, 2080 + low.employee_pf);
    assert.equal(file.totals.eps_share, 777 + low.employer_eps);
  });
});

describe("18. the payslip PF figures", () => {
  const r = payrun({ basic: 20000, statutory: { previous_eps_member: 0 } });
  const snap = payslip.buildPayslipSnapshot({
    period: { year: 2026, month: 9 },
    calculation: stored(r),
    employee: { employee_id: 101, employee_name: "Example Member", uan: "100200300400", pf_number: "TN/MAS/1/101", basic: 20000, hra: 10000, conveyance: 2500, special_allowance: 7500 },
    extras: {},
    company: { name: "Daily Needs Departmental Store" },
  });

  it("deducts the one September employee PF, 2,080", () => {
    const line = snap.deductions.lines.find((l) => l.key === "employee_pf");
    assert.equal(line.amount, "2080.00");
  });

  it("shows the PF wage and both periods, each with its own ceiling", () => {
    assert.equal(snap.statutory.pf_wage, "17333.33");
    assert.deepEqual(
      snap.statutory.pf_periods.map((p) => [p.from, p.to, p.monthly_wage_ceiling, p.pf_wage, p.employee_pf]),
      [
        ["2026-09-01", "2026-09-16", "15000.00", "8000.00", "960.00"],
        ["2026-09-17", "2026-09-30", "25000.00", "9333.33", "1120.00"],
      ]
    );
  });

  it("an ordinary month's payslip has no period breakdown", () => {
    const o = payrun({ basic: 20000, as_of: "2026-10-31" });
    const s2 = payslip.buildPayslipSnapshot({
      period: { year: 2026, month: 10 },
      calculation: stored(o),
      employee: { employee_id: 101, employee_name: "X", uan: "100200300400", basic: 20000, hra: 10000, conveyance: 2500, special_allowance: 7500 },
      extras: {},
      company: { name: "Daily Needs Departmental Store" },
    });
    assert.deepEqual(s2.statutory.pf_periods, []);
    assert.equal(s2.deductions.lines.find((l) => l.key === "employee_pf").amount, "2400.00");
  });
});

describe("19. employer contribution totals", () => {
  it("employer 12% = EPS + EPF exactly, in every period and in the month", () => {
    [10000, 15000, 20000, 25000, 30000].forEach((w) =>
      [0, 1].forEach((eps) => {
        const pf = sep(w, { previous_eps_member: eps });
        assert.equal(r2(pf.employer_eps + pf.employer_epf), pf.employer_pf_total, `${w}/${eps}`);
        pf.segments.forEach((s) => assert.equal(r2(s.employer_eps + s.employer_epf), s.employer_pf_total));
      })
    );
  });

  it("EDLI and admin are 0.5% each of the EDLI / PF wage, and the maximum EPS is 2,083", () => {
    const pf = oct(30000);
    assert.equal(pf.edli_wage, 25000);
    assert.equal(pf.edli, 125);
    assert.equal(pf.pf_admin_charge, 125);
    assert.equal(pf.employer_eps, 2083); // 25,000 x 8.33% = 2,082.50 -> 2,083
    assert.equal(pf.employer_epf, 917);
  });

  it("the report totals the monthly employer cost increase by category", () => {
    const report = impact.assessPopulation([
      { employee_id: 1, basic: 10000, ...BASE },
      { employee_id: 2, basic: 20000, ...BASE, previous_eps_member: 0 },
      { employee_id: 3, basic: 30000, ...BASE },
      { employee_id: 4, basic: 20000, ...BASE, pf_applicable: 0 },
    ]);
    const c = report.summary.by_category;
    assert.equal(c[impact.CATEGORY.UP_TO_15000].monthly_employer_cost_increase, 0);
    // 20,000: (2,400 + 100 + 100) - (1,800 + 75 + 75) = 650
    assert.equal(c[impact.CATEGORY.FROM_15001_TO_25000].monthly_employer_cost_increase, 650);
    // 30,000: (3,000 + 125 + 125) - 1,950 = 1,300
    assert.equal(c[impact.CATEGORY.ABOVE_25000].monthly_employer_cost_increase, 1300);
    assert.equal(report.summary.monthly_employer_cost_increase, 1950);
    assert.equal(report.summary.may_require_enrolment, 1);
    assert.equal(report.summary.potential_monthly_employer_cost_if_enrolled, 2600);
  });
});

describe("20. no regression for employees at or below 15,000", () => {
  // The pre-revision engine: 12% of min(Basic, 15,000), EPS 8.33% of it.
  [5000, 9999.5, 10000, 12345, 15000].forEach((w) =>
    it(`PF wage ${w}: identical employee and employer PF in August, September and October`, () => {
      const ee = Math.round(w * 0.12);
      const eps = Math.round(w * 0.0833);
      [aug(w), sep(w), oct(w)].forEach((pf, i) => {
        assert.equal(pf.employee_pf, ee, `month ${i}`);
        assert.equal(pf.employer_pf_total, ee);
        assert.equal(pf.pf_wage, w);
      });
      assert.equal(aug(w).employer_eps, eps);
      assert.equal(oct(w).employer_eps, eps);
    })
  );

  it("a whole payrun below 15,000 keeps its net pay across the revision", () => {
    const a = payrun({ basic: 13000, as_of: "2026-08-31", day_rows: null });
    const o = payrun({ basic: 13000, as_of: "2026-10-31", day_rows: null });
    assert.equal(a.employee_pf, 1560);
    assert.equal(o.employee_pf, 1560);
    assert.equal(a.net_pay, o.net_pay);
  });

  it("the Salary Master preview is unchanged at or below 15,000, and uses the ceiling in force on its date", () => {
    const ctx = { pf_applicable: 1, dob: "1990-01-01", date_of_joining: "2010-01-01", previous_eps_member: 1 };
    assert.equal(engine.calculatePf({ ...ctx, basic: 14000, as_of: "2026-08-01" }).employee_pf, 1680);
    assert.equal(engine.calculatePf({ ...ctx, basic: 14000, as_of: "2026-10-01" }).employee_pf, 1680);
    assert.equal(engine.calculatePf({ ...ctx, basic: 20000, as_of: "2026-08-01" }).employee_pf, 1800);
    assert.equal(engine.calculatePf({ ...ctx, basic: 20000, as_of: "2026-10-01" }).employee_pf, 2400);
  });
});

describe("history before 17-09-2026 is not re-charged on the new ceiling", () => {
  it("every month up to August 2026 uses the 15,000 ceiling version", () => {
    for (let m = 1; m <= 8; m += 1) {
      const pf = month(2026, m, 30000);
      assert.equal(pf.employee_pf, 1800, `2026-${m}`);
      assert.equal(pf.ceiling_version, "EPFO-CEILING-15000-2014-09-01");
    }
  });
});
