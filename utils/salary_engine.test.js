/**
 * M2 — the salary engine.
 *
 *   node --test utils/salary_engine.test.js
 *
 * The cases that would be wrong SILENTLY, and are therefore tested hardest:
 *
 *   components that do not add up to the gross — a rupee out is invisible on a
 *     payslip and wrong in a filing
 *   a statutory contribution invented from a wage nobody supplied
 *   an employee PF added back into CTC, which overstates it by thousands
 *   a tri-state flag read as "No" when it means "nobody has said"
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const E = require("./salary_engine");
const CONFIG = require("../config/statutory");

/** Sum of the four components, to two decimals. */
const sum = (c) =>
  Math.round((c.basic + c.conveyance + c.hra + c.special_allowance) * 100) / 100;

/* ------------------------------------------------------- automatic breakup */

test("gross 8000 — below the threshold, Basic is the whole gross", () => {
  const c = E.calculateBreakup(8000);
  assert.deepEqual(c, { basic: 8000, conveyance: 0, hra: 0, special_allowance: 0 });
  assert.equal(sum(c), 8000);
});

test("gross 10000 — at the threshold, the Basic floor takes the whole gross", () => {
  const c = E.calculateBreakup(10000);
  assert.deepEqual(c, { basic: 10000, conveyance: 0, hra: 0, special_allowance: 0 });
  assert.equal(sum(c), 10000);
});

test("gross 15000 — floor Basic, Conveyance capped, HRA takes the rest", () => {
  const c = E.calculateBreakup(15000);
  assert.deepEqual(c, { basic: 10000, conveyance: 2500, hra: 2500, special_allowance: 0 });
  assert.equal(sum(c), 15000);
});

test("gross 20000 — 50% equals the floor; HRA still under its cap", () => {
  const c = E.calculateBreakup(20000);
  assert.deepEqual(c, { basic: 10000, conveyance: 2500, hra: 7500, special_allowance: 0 });
  assert.equal(sum(c), 20000);
});

test("gross 25000 — 50% beats the floor; HRA exactly at its cap", () => {
  const c = E.calculateBreakup(25000);
  assert.deepEqual(c, { basic: 12500, conveyance: 2500, hra: 10000, special_allowance: 0 });
  assert.equal(sum(c), 25000);
});

test("gross 50000 — both caps bind and Special Allowance takes the balance", () => {
  const c = E.calculateBreakup(50000);
  assert.deepEqual(c, { basic: 25000, conveyance: 2500, hra: 10000, special_allowance: 12500 });
  assert.equal(sum(c), 50000);
});

test("the components always add up to the gross, across the whole range", () => {
  for (let gross = 0; gross <= 120000; gross += 137) {
    const c = E.calculateBreakup(gross);
    assert.equal(sum(c), gross, `components must sum to ${gross}`);
    assert.ok(c.conveyance <= CONFIG.salary.conveyanceCap, `conveyance cap at ${gross}`);
    assert.ok(c.hra <= CONFIG.salary.hraCap, `HRA cap at ${gross}`);
    assert.ok(c.basic >= 0 && c.special_allowance >= 0, `no negative component at ${gross}`);
  }
});

test("an odd gross keeps the identity exactly — no floating point drift", () => {
  const c = E.calculateBreakup(30001.01);
  assert.equal(sum(c), 30001.01);
});

test("there is no DA component anywhere in the breakup", () => {
  const c = E.calculateBreakup(50000);
  assert.deepEqual(Object.keys(c).sort(), ["basic", "conveyance", "hra", "special_allowance"]);
});

test("a negative gross is refused rather than broken up", () => {
  assert.throws(() => E.calculateBreakup(-1));
});

/* ---------------------------------------------------------- daily salary */

test("daily salary is the gross over 26 salary days", () => {
  assert.equal(E.dailySalary(26000), 1000);
  assert.equal(E.dailySalary(10000), 384.62);
});

/* ------------------------------------------------------- manual override */

test("a manual breakup that adds up, within the caps, with Basic unchanged, needs no reason", () => {
  const r = E.validateManualBreakup(50000, {
    basic: 25000,
    conveyance: 2000,
    hra: 10000,
    special_allowance: 13000,
  });
  assert.equal(r.valid, true);
  assert.equal(r.requiresOverride, false);
});

test("components that do not add up to the gross are refused", () => {
  const r = E.validateManualBreakup(50000, {
    basic: 25000,
    conveyance: 2500,
    hra: 10000,
    special_allowance: 12499,
  });
  assert.equal(r.valid, false);
  assert.match(r.errors.join(" "), /add up to the monthly gross/);
});

test("Conveyance above 2500 is refused", () => {
  const r = E.validateManualBreakup(50000, {
    basic: 25000,
    conveyance: 3000,
    hra: 10000,
    special_allowance: 12000,
  });
  assert.equal(r.valid, false);
  assert.match(r.errors.join(" "), /Conveyance cannot exceed 2500/);
});

test("HRA above 10000 is refused", () => {
  const r = E.validateManualBreakup(50000, {
    basic: 25000,
    conveyance: 2500,
    hra: 12000,
    special_allowance: 10500,
  });
  assert.equal(r.valid, false);
  assert.match(r.errors.join(" "), /HRA cannot exceed 10000/);
});

test("a negative component is refused", () => {
  const r = E.validateManualBreakup(50000, {
    basic: 40000,
    conveyance: 2500,
    hra: 10000,
    special_allowance: -2500,
  });
  assert.equal(r.valid, false);
  assert.match(r.errors.join(" "), /cannot be negative/);
});

test("moving Basic without the override flag is refused", () => {
  const r = E.validateManualBreakup(50000, {
    basic: 20000,
    conveyance: 2500,
    hra: 10000,
    special_allowance: 17500,
  });
  assert.equal(r.valid, false);
  assert.equal(r.requiresOverride, true);
  assert.match(r.errors.join(" "), /manual override/);
});

test("moving Basic with the flag but no reason is refused", () => {
  const r = E.validateManualBreakup(
    50000,
    { basic: 20000, conveyance: 2500, hra: 10000, special_allowance: 17500 },
    { manual_override: true, override_reason: "   " }
  );
  assert.equal(r.valid, false);
  assert.match(r.errors.join(" "), /reason is required/);
});

test("moving Basic with the flag and a reason is accepted", () => {
  const r = E.validateManualBreakup(
    50000,
    { basic: 20000, conveyance: 2500, hra: 10000, special_allowance: 17500 },
    { manual_override: true, override_reason: "Retained structure from previous employer" }
  );
  assert.equal(r.valid, true);
  assert.equal(r.requiresOverride, true);
});

test("the gross is fixed — a manual breakup is validated against the gross it was given", () => {
  const r = E.validateManualBreakup(
    50000,
    { basic: 30000, conveyance: 2500, hra: 10000, special_allowance: 17500 },
    { manual_override: true, override_reason: "x" }
  );
  assert.equal(r.valid, false, "60000 of components against a 50000 gross must fail");
});

/* -------------------------------------------------------------------- PF */

const pfCtx = (over = {}) => ({
  basic: 15000,
  pf_applicable: 1,
  dob: "1990-05-10",
  date_of_joining: "2020-01-01",
  previous_eps_member: 1,
  as_of: "2026-04-01",
  ...over,
});

test("PF is computed on Basic only, capped at the wage ceiling", () => {
  const pf = E.calculatePf(pfCtx({ basic: 25000 }));
  assert.equal(pf.pf_wage, 15000, "the ceiling applies to Basic, not the gross");
  assert.equal(pf.employee_pf, 1800);
  assert.equal(pf.employer_pf_total, 1800);
});

test("the employer 12% splits into EPS 1250 and EPF 550 at the ceiling", () => {
  const pf = E.calculatePf(pfCtx({ basic: 15000 }));
  assert.equal(pf.employer_eps, 1250, "8.33% of 15000 rounds to the familiar 1250");
  assert.equal(pf.employer_epf, 550);
  assert.equal(pf.employer_epf + pf.employer_eps, pf.employer_pf_total, "the halves must sum to the total");
});

test("EDLI and the admin charge are 0.5% each on the ceiling wage", () => {
  const pf = E.calculatePf(pfCtx({ basic: 15000 }));
  assert.equal(pf.edli, 75);
  assert.equal(pf.pf_admin_charge, 75);
});

test("below the ceiling everything is computed on the actual Basic", () => {
  const pf = E.calculatePf(pfCtx({ basic: 10000 }));
  assert.equal(pf.pf_wage, 10000);
  assert.equal(pf.employee_pf, 1200);
  assert.equal(pf.employer_eps, 833);
  assert.equal(pf.employer_epf, 367);
  assert.equal(pf.employer_epf + pf.employer_eps, 1200);
  assert.equal(pf.edli, 50);
  assert.equal(pf.pf_admin_charge, 50);
});

test("PF not applicable means zeros, not pending", () => {
  const pf = E.calculatePf(pfCtx({ pf_applicable: 0 }));
  assert.equal(pf.status, E.STATUS.NOT_APPLICABLE);
  assert.equal(pf.employee_pf, 0);
  assert.equal(pf.employer_pf_total, 0);
  assert.deepEqual(pf.unresolved, []);
});

test("PF applicability not recorded is PENDING — never silently zero", () => {
  const pf = E.calculatePf(pfCtx({ pf_applicable: null }));
  assert.equal(pf.status, E.STATUS.PENDING);
  assert.equal(pf.employee_pf, null);
  assert.equal(pf.unresolved[0].code, E.UNRESOLVED.PF_APPLICABILITY_NOT_RECORDED);
});

test("at or past 58 the pension contribution stops and the whole 12% goes to EPF", () => {
  const pf = E.calculatePf(pfCtx({ dob: "1960-01-01", as_of: "2026-04-01" }));
  assert.equal(pf.employer_eps, 0);
  assert.equal(pf.employer_epf, pf.employer_pf_total);
});

test("the day before the 58th birthday EPS still applies", () => {
  const pf = E.calculatePf(pfCtx({ dob: "1968-04-02", as_of: "2026-04-01" }));
  assert.equal(pf.employer_eps, 1250);
});

test("a post-cutoff joiner above the EPS ceiling who was never an EPS member gets no EPS", () => {
  const pf = E.calculatePf(
    pfCtx({
      basic: 25000,
      date_of_joining: "2020-01-01",
      previous_eps_member: 0,
      pf_applicable: 1,
    })
  );
  // The ceiling test resolves first: the PF wage is capped to 15000, which is
  // AT the EPS ceiling, so this employee is eligible either way.
  assert.equal(pf.employer_eps, 1250);
});

test("with the ceiling lifted, a post-cutoff non-EPS-member above the ceiling gets no EPS", () => {
  const noCeiling = {
    ...CONFIG,
    pf: { ...CONFIG.pf, applyCeilingToWage: false },
  };
  const pf = E.calculatePf(
    pfCtx({ basic: 25000, date_of_joining: "2020-01-01", previous_eps_member: 0 }),
    noCeiling
  );
  assert.equal(pf.pf_wage, 25000);
  assert.equal(pf.employer_eps, 0, "not eligible to join EPS");
  assert.equal(pf.employer_epf, pf.employer_pf_total);
});

test("with the ceiling lifted, a previous EPS member above the ceiling keeps EPS on the capped wage", () => {
  const noCeiling = { ...CONFIG, pf: { ...CONFIG.pf, applyCeilingToWage: false } };
  const pf = E.calculatePf(
    pfCtx({ basic: 25000, date_of_joining: "2020-01-01", previous_eps_member: 1 }),
    noCeiling
  );
  assert.equal(pf.employer_eps, 1250, "EPS is still capped at the pension wage ceiling");
});

test("an unrecorded previous-EPS-member is UNRESOLVED where it can change the answer", () => {
  const noCeiling = { ...CONFIG, pf: { ...CONFIG.pf, applyCeilingToWage: false } };
  const pf = E.calculatePf(
    pfCtx({ basic: 25000, date_of_joining: "2020-01-01", previous_eps_member: null }),
    noCeiling
  );
  assert.equal(pf.employer_eps, null);
  assert.equal(pf.employer_epf, null);
  assert.equal(pf.unresolved[0].code, E.UNRESOLVED.EPS_MEMBERSHIP_NOT_RECORDED);
  assert.equal(pf.employer_pf_total, 3000, "the employer total is still known; only the split is not");
});

test("an unrecorded previous-EPS-member is NOT unresolved when the wage cannot trigger the rule", () => {
  const pf = E.calculatePf(pfCtx({ basic: 12000, previous_eps_member: null }));
  assert.deepEqual(pf.unresolved, []);
  assert.equal(pf.employer_eps, 1000, "8.33% of 12000 rounds to 1000");
});

test("a joiner from before the cutoff is eligible regardless of membership history", () => {
  const noCeiling = { ...CONFIG, pf: { ...CONFIG.pf, applyCeilingToWage: false } };
  const pf = E.calculatePf(
    pfCtx({ basic: 25000, date_of_joining: "2010-06-01", previous_eps_member: null }),
    noCeiling
  );
  assert.equal(pf.employer_eps, 1250);
  assert.deepEqual(pf.unresolved, []);
});

test("a missing date of birth leaves EPS unresolved rather than assumed", () => {
  const pf = E.calculatePf(pfCtx({ dob: null }));
  assert.equal(pf.employer_eps, null);
  assert.equal(pf.unresolved[0].code, E.UNRESOLVED.EPS_DOB_NOT_RECORDED);
});

/* ------------------------------- EPS membership is NOT the PF membership */

/*
 * The review fix these four exist for. Form 11 asks about prior EPF membership
 * and prior EPS membership separately because the answers differ, and the
 * engine must not turn one into the other in EITHER direction: a recorded EPF
 * history may not create a pension entitlement, and an absent one may not
 * remove one.
 */
const noCeilingCfg = { ...CONFIG, pf: { ...CONFIG.pf, applyCeilingToWage: false } };
const epsCtx = (over = {}) =>
  pfCtx({ basic: 25000, date_of_joining: "2020-01-01", previous_eps_member: null, ...over });

test("previous_pf_member = 1 does NOT by itself make somebody an EPS member", () => {
  const pf = E.calculatePf(epsCtx({ previous_pf_member: 1 }), noCeilingCfg);
  assert.equal(pf.employer_eps, null, "a prior EPF membership is not a prior EPS membership");
  assert.equal(pf.employer_epf, null);
  assert.equal(pf.unresolved[0].code, E.UNRESOLVED.EPS_MEMBERSHIP_NOT_RECORDED);
});

test("previous_pf_member = 0 does NOT by itself rule EPS membership out", () => {
  const pf = E.calculatePf(epsCtx({ previous_pf_member: 0 }), noCeilingCfg);
  assert.equal(pf.employer_eps, null, "the EPS question is still unanswered");
  assert.equal(pf.unresolved[0].code, E.UNRESOLVED.EPS_MEMBERSHIP_NOT_RECORDED);
});

test("the EPS answer decides it even when the PF answer contradicts it", () => {
  // Was in a previous employer's EPF but never in EPS - an excluded employee,
  // or somebody who joined above the pension ceiling after the cutoff.
  const notInEps = E.calculatePf(
    epsCtx({ previous_pf_member: 1, previous_eps_member: 0 }),
    noCeilingCfg
  );
  assert.equal(notInEps.employer_eps, 0);
  assert.equal(notInEps.employer_epf, notInEps.employer_pf_total, "the whole 12% goes to EPF");

  // And the other way round: the EPS fact is recorded, the EPF one is not.
  const inEps = E.calculatePf(
    epsCtx({ previous_pf_member: null, previous_eps_member: 1 }),
    noCeilingCfg
  );
  assert.equal(inEps.employer_eps, 1250, "capped at the pension wage ceiling");
  assert.deepEqual(inEps.unresolved, []);
});

test("calculateSalary carries the EPS fact through, and does not read the PF one for it", () => {
  const base = {
    monthly_gross: 50000,
    pf_applicable: 1,
    esi_applicable: 0,
    dob: "1990-05-10",
    date_of_joining: "2020-01-01",
    effective_from: "2026-04-01",
  };
  const onlyPf = E.calculateSalary({ ...base, previous_pf_member: 1 }, noCeilingCfg);
  assert.equal(onlyPf.pf.employer_eps, null);
  assert.equal(onlyPf.unresolved[0].code, E.UNRESOLVED.EPS_MEMBERSHIP_NOT_RECORDED);

  const withEps = E.calculateSalary(
    { ...base, previous_pf_member: 1, previous_eps_member: 1 },
    noCeilingCfg
  );
  assert.equal(withEps.pf.employer_eps, 1250);
  assert.deepEqual(withEps.unresolved, []);
});

/* --------------------------------------------- the statutory wage definition */

test("the wage definition excludes the Code's heads and includes everything else", () => {
  // The acceptance structure: 16000 gross as 10000 / 2500 / 3500 / 0.
  const w = E.statutoryWages(
    { basic: 10000, conveyance: 2500, hra: 3500, special_allowance: 0 },
    16000
  );
  assert.equal(w.total_remuneration, 16000);
  assert.equal(w.excluded_remuneration, 6000, "HRA 3500 + Conveyance 2500");
  assert.equal(w.included_remuneration, 10000, "Basic + Special Allowance");
  assert.equal(w.minimum_wages, 8000, "50% of total remuneration");
  assert.equal(w.add_back, 0, "6000 excluded is under the 8000 half, so nothing is added back");
  assert.equal(w.statutory_wages, 10000);
});

test("a component nobody excluded is wages, without anybody adding it to a list", () => {
  // The Code makes all remuneration wages EXCEPT what it excludes, so a head
  // of pay the structure grows tomorrow must land in the contribution base by
  // itself. Here 1000 of extra remuneration does exactly that.
  const w = E.statutoryWages(
    { basic: 10000, conveyance: 2500, hra: 3500, special_allowance: 0, night_allowance: 1000 },
    17000
  );
  assert.equal(w.excluded_remuneration, 6000);
  assert.equal(w.statutory_wages, 11000);
});

test("excluded heads at EXACTLY half of remuneration trigger no add-back", () => {
  // The proviso bites on "exceeds", so the boundary itself is not an excess.
  const w = E.statutoryWages(
    { basic: 8000, special_allowance: 2000, hra: 7500, conveyance: 2500 },
    20000
  );
  assert.equal(w.excluded_remuneration, 10000);
  assert.equal(w.minimum_wages, 10000);
  assert.equal(w.add_back, 0);
  assert.equal(w.statutory_wages, 10000);
});

test("above half, ONLY THE EXCESS over half is added back", () => {
  // 12500 excluded against a 10000 half: the excess is 2500, and that is what
  // comes back — not the whole 12500, which would make wages the gross again.
  const w = E.statutoryWages(
    { basic: 4000, special_allowance: 3500, hra: 10000, conveyance: 2500 },
    20000
  );
  assert.equal(w.excluded_remuneration, 12500);
  assert.equal(w.included_remuneration, 7500);
  assert.equal(w.minimum_wages, 10000);
  assert.equal(w.add_back, 2500);
  assert.equal(w.statutory_wages, 10000);
  assert.notEqual(w.statutory_wages, 20000, "the whole excluded amount is NOT added back");
  assert.notEqual(w.statutory_wages, 7500, "and the proviso is not ignored either");
});

test("the add-back floor holds however the structure is arranged", () => {
  // The proviso's purpose: no arrangement of excluded allowances can take
  // statutory wages below half of total remuneration.
  for (const hra of [0, 5000, 10000, 15000, 19000, 20000]) {
    const w = E.statutoryWages({ basic: 20000 - hra, hra }, 20000);
    assert.ok(w.statutory_wages >= 10000, `HRA ${hra} must not breach the half`);
  }
});

test("which heads are excluded is configuration, not arithmetic", () => {
  const cfg = {
    ...CONFIG,
    wages: { ...CONFIG.wages, excludedComponents: ["conveyance"] },
  };
  const w = E.statutoryWages(
    { basic: 10000, conveyance: 2500, hra: 3500, special_allowance: 0 },
    16000,
    cfg
  );
  assert.equal(w.excluded_remuneration, 2500, "HRA is wages under this configuration");
  assert.equal(w.statutory_wages, 13500);
});

test("a structure that overspends its remuneration cannot produce a negative wage", () => {
  const w = E.statutoryWages({ hra: 30000, conveyance: 5000 }, 20000);
  assert.ok(w.statutory_wages >= 0);
  assert.equal(w.statutory_wages, 10000, "the proviso's half still holds");
});

/* ------------------------------------------- the ESI contribution period */

test("the two contribution periods, including the one that spans a year end", () => {
  assert.deepEqual(E.contributionPeriodFor("2026-04-01"), {
    start: "2026-04-01",
    end: "2026-09-30",
  });
  assert.deepEqual(E.contributionPeriodFor("2026-09-30"), {
    start: "2026-04-01",
    end: "2026-09-30",
  });
  assert.deepEqual(E.contributionPeriodFor("2026-10-01"), {
    start: "2026-10-01",
    end: "2027-03-31",
  });
  // The case worth writing down: a January date belongs to the period that
  // began the PREVIOUS October, and ends on the 31 March after it.
  assert.deepEqual(E.contributionPeriodFor("2027-01-15"), {
    start: "2026-10-01",
    end: "2027-03-31",
  });
  assert.deepEqual(E.contributionPeriodFor("2027-03-31"), {
    start: "2026-10-01",
    end: "2027-03-31",
  });
});

test("coverage is decided at the period start, or at entry for a mid-period joiner", () => {
  const entry = (as_of, date_of_joining) =>
    E.contributionPeriodEntryDate({ as_of, date_of_joining });

  assert.equal(entry("2026-07-01", "2019-06-01"), "2026-04-01", "an old hand: the period start");
  assert.equal(entry("2026-07-01", "2026-06-15"), "2026-06-15", "a joiner part-way through");
  assert.equal(entry("2026-07-01", null), "2026-04-01", "no DOJ recorded: the period start");
  // A date of joining AFTER the date being calculated is not an entry into
  // this period, and must not be read as one.
  assert.equal(entry("2026-07-01", "2026-12-01"), "2026-04-01");
});

/*
 * THE SIX CASES THE RULE EXISTS FOR. Each is the whole calculation, because
 * what matters is the contribution that comes out of it.
 */
const COVERED = {
  pf_applicable: 1,
  esi_applicable: 1,
  previous_eps_member: 1,
  dob: "1990-05-10",
  date_of_joining: "2020-01-01",
};

/** An approved record as the server would hand one over, at a given gross. */
const approvedAt = (gross) => ({ monthly_gross: gross, ...E.calculateBreakup(gross) });

test("1. covered at the period start, wages cross the ceiling mid-period: ESI CONTINUES", () => {
  // 16000 on 1 April is wages of 10000 — covered. A revision to 60000 from
  // 1 July puts them well above the 21000 ceiling, and coverage still runs to
  // 30 September because that is when the contribution period ends.
  const r = E.calculateSalary({
    ...COVERED,
    monthly_gross: 60000,
    effective_from: "2026-07-01",
    coverage_entry_salary: approvedAt(16000),
  });
  assert.equal(r.esi.status, E.STATUS.APPLIED);
  assert.ok(r.esi.employer_esi > 0, "the employer goes on contributing for the period");
  assert.equal(r.esi_coverage.basis, "COVERED_AT_ENTRY");
  assert.equal(r.esi_coverage.entry_date, "2026-04-01");
  assert.equal(r.esi_coverage.period.end, "2026-09-30");
  // And it is charged on the statutory wages of the NEW salary, not on the old
  // ones: continuation keeps somebody covered, it does not freeze their wage.
  assert.equal(r.esi.esi_wage, 47500);
});

test("2. the same employee at the NEXT period start, still above: NOT APPLICABLE", () => {
  // 1 October asks the question afresh. They are above the ceiling that day,
  // so nothing carries over from the period that just ended.
  const r = E.calculateSalary({
    ...COVERED,
    monthly_gross: 60000,
    effective_from: "2026-10-01",
    coverage_entry_salary: approvedAt(60000),
  });
  assert.equal(r.esi.status, E.STATUS.NOT_APPLICABLE);
  assert.equal(r.esi.employer_esi, 0);
  assert.equal(r.esi_coverage.basis, "ABOVE_CEILING_AT_ENTRY");
  assert.equal(r.esi_coverage.entry_date, "2026-10-01");
});

test("3. a mid-period joiner below the ceiling who then crosses it: CONTINUES", () => {
  // Joined 15 June on 16000, revised to 60000 from 1 August. Entry into the
  // period was the day they joined, and they were covered on it.
  const r = E.calculateSalary({
    ...COVERED,
    date_of_joining: "2026-06-15",
    monthly_gross: 60000,
    effective_from: "2026-08-01",
    coverage_entry_salary: approvedAt(16000),
  });
  assert.equal(r.esi.status, E.STATUS.APPLIED);
  assert.equal(r.esi_coverage.entry_date, "2026-06-15");
  assert.equal(r.esi_coverage.period.end, "2026-09-30");
});

test("4. somebody who joins ALREADY above the ceiling: NOT APPLICABLE", () => {
  // No approved history at all — the opening salary IS the salary in force at
  // entry, so the rule is answered without one.
  const r = E.calculateSalary({
    ...COVERED,
    date_of_joining: "2026-06-15",
    monthly_gross: 60000,
    effective_from: "2026-06-15",
  });
  assert.equal(r.esi.status, E.STATUS.NOT_APPLICABLE);
  assert.equal(r.esi_coverage.basis, "ABOVE_CEILING_AT_ENTRY");
  assert.equal(r.esi_coverage.entry_date, "2026-06-15");
});

test("5. somebody who stays below the ceiling is APPLIED, and the 16000 case is untouched", () => {
  const r = E.calculateSalary({
    ...COVERED,
    monthly_gross: 16000,
    effective_from: "2026-04-01",
  });
  assert.equal(r.esi.status, E.STATUS.APPLIED);
  assert.equal(r.esi.esi_wage, 10000);
  assert.equal(r.esi.employee_esi, 75);
  assert.equal(r.esi.employer_esi, 325);
  assert.equal(r.monthly_ctc, 17625);
});

test("6. esi_applicable = false is NOT APPLICABLE, and no period reasoning applies", () => {
  const r = E.calculateSalary({
    ...COVERED,
    esi_applicable: 0,
    monthly_gross: 16000,
    effective_from: "2026-04-01",
  });
  assert.equal(r.esi.status, E.STATUS.NOT_APPLICABLE);
  assert.equal(r.esi_coverage.basis, "NOT_APPLICABLE_AT_ENTRY");
});

test("the ceiling comparison at entry uses STATUTORY WAGES, not the gross", () => {
  // 40000 gross is 20000 / 2500 / 10000 / 7500: the gross is above the 21000
  // ceiling but statutory wages are 27500... still above. 25000 gross is the
  // case that separates them - wages of 12500 against a gross of 25000 - and
  // that employee is covered at entry, so a later crossing continues.
  const r = E.calculateSalary({
    ...COVERED,
    monthly_gross: 60000,
    effective_from: "2026-07-01",
    coverage_entry_salary: approvedAt(25000),
  });
  assert.equal(r.esi_coverage.wages_at_entry, 12500);
  assert.equal(r.esi_coverage.basis, "COVERED_AT_ENTRY");
  assert.equal(r.esi.status, E.STATUS.APPLIED);
});

test("an unprovable position above the ceiling is PENDING, never a zero", () => {
  // No approved salary at entry, and the record being calculated starts after
  // it — so whether they were covered when the period began is genuinely open,
  // and a contribution that quietly stops is the one answer not allowed.
  const r = E.calculateSalary({
    ...COVERED,
    monthly_gross: 60000,
    effective_from: "2026-08-01",
  });
  assert.equal(r.esi_coverage.continues, null);
  assert.equal(r.esi_coverage.basis, "NO_SALARY_AT_ENTRY");
  assert.equal(r.esi.status, E.STATUS.PENDING);
  assert.equal(r.esi.employer_esi, null);
  assert.equal(r.esi.unresolved[0].code, E.UNRESOLVED.ESI_CONTRIBUTION_PERIOD_UNRESOLVED);
});

test("the same unprovable position BELOW the ceiling decides nothing and is APPLIED", () => {
  // Continuation only matters above the ceiling. Somebody plainly inside it is
  // covered whatever happened at the start of the period.
  const r = E.calculateSalary({
    ...COVERED,
    monthly_gross: 16000,
    effective_from: "2026-08-01",
  });
  assert.equal(r.esi.status, E.STATUS.APPLIED);
  assert.equal(r.esi.employer_esi, 325);
});

test("A TRUSTED CALLER'S OWN ANSWER IS NOT SECOND-GUESSED", () => {
  // A payrun that established the position from the wage register passes it,
  // and the derived rule must not overrule it.
  const r = E.calculateSalary({
    ...COVERED,
    monthly_gross: 60000,
    effective_from: "2026-10-01",
    coverage_entry_salary: approvedAt(60000),
    contribution_period_continues: true,
  });
  assert.equal(r.esi.status, E.STATUS.APPLIED, "the caller's fact wins over the derivation");
  assert.ok(r.esi.employer_esi > 0);
});

/* ------------------------------------------------------------------- ESI */

test("ESI not applicable means zeros, not pending", () => {
  const esi = E.calculateEsi({ esi_applicable: 0, gross: 15000, conveyance: 2500 });
  assert.equal(esi.status, E.STATUS.NOT_APPLICABLE);
  assert.equal(esi.employee_esi, 0);
  assert.equal(esi.employer_esi, 0);
});

test("with no payroll wage the STANDARD monthly contribution is computed, not PENDING", () => {
  // The Salary Master case, on the whole approved structure: a 15000 gross is
  // 10000 / 2500 / 2500 / 0, so 5000 is excluded and the statutory wage is the
  // 10000 of Basic and Special Allowance. 0.75% is 75 and 3.25% is 325.
  const esi = E.calculateEsi({
    esi_applicable: 1,
    gross: 15000,
    ...E.calculateBreakup(15000),
  });
  assert.equal(esi.status, E.STATUS.APPLIED);
  assert.equal(esi.esi_wage, 10000);
  assert.equal(esi.esi_wage_basis, E.ESI_WAGE_BASIS.STANDARD);
  assert.equal(esi.employee_esi, 75);
  assert.equal(esi.employer_esi, 325);
  assert.deepEqual(esi.unresolved, []);
  // The wage says where it came from, so a contribution can be reconciled
  // without re-deriving the definition.
  assert.equal(esi.wage_definition.statutory_wages, 10000);
  assert.equal(esi.wage_definition.add_back, 0);
});

test("the STANDARD wage is the statutory wage, never the old conservative bound", () => {
  // The bound this replaced was gross less Conveyance, and it is not the
  // contribution wage: for this structure it would have charged 12500.
  const esi = E.calculateEsi({ esi_applicable: 1, gross: 15000, ...E.calculateBreakup(15000) });
  assert.notEqual(esi.esi_wage, 12500, "gross less Conveyance is a bound, not a wage");
  assert.equal(esi.esi_wage, 10000);
});

test("the standard wage carries the 50% add-back through to the contribution", () => {
  // A structure arranged into excluded allowances: 12500 of a 20000 gross is
  // HRA and Conveyance, so 2500 comes back and wages are 10000, not 7500.
  const esi = E.calculateEsi({
    esi_applicable: 1,
    gross: 20000,
    basic: 4000,
    special_allowance: 3500,
    hra: 10000,
    conveyance: 2500,
  });
  assert.equal(esi.wage_definition.add_back, 2500);
  assert.equal(esi.esi_wage, 10000);
  assert.equal(esi.employer_esi, 325);
});

test("the STANDARD wage never overrides a wage a payrun worked out", () => {
  // Same structure, but payroll says only 9000 was payable this month. The
  // actual wage wins and is labelled as the actual one.
  const actual = E.calculateEsi({
    esi_applicable: 1,
    gross: 15000,
    ...E.calculateBreakup(15000),
    esi_wage: 9000,
  });
  assert.equal(actual.esi_wage, 9000);
  assert.equal(actual.esi_wage_basis, E.ESI_WAGE_BASIS.PAYROLL);
  assert.equal(actual.employer_esi, 293);
});

test("ESI applicability nobody has recorded is still PENDING, and is not guessed", () => {
  // The one ESI question a salary structure genuinely cannot answer.
  const esi = E.calculateEsi({ gross: 15000, ...E.calculateBreakup(15000) });
  assert.equal(esi.status, E.STATUS.PENDING);
  assert.equal(esi.employee_esi, null);
  assert.equal(esi.employer_esi, null);
  assert.equal(esi.unresolved[0].code, E.UNRESOLVED.ESI_APPLICABILITY_NOT_RECORDED);
});

test("somebody too well paid to be covered is resolved without a payroll wage", () => {
  // 50000 gross is 25000 / 2500 / 10000 / 12500, so statutory wages are 37500
  // — above the 21000 ceiling however the structure is read.
  const esi = E.calculateEsi({ esi_applicable: 1, gross: 50000, ...E.calculateBreakup(50000) });
  assert.equal(esi.status, E.STATUS.NOT_APPLICABLE);
  assert.equal(esi.employer_esi, 0);
  assert.deepEqual(esi.unresolved, []);
});

test("THE COVERAGE CEILING IS A CEILING ON WAGES, not on the gross", () => {
  // A 25000 gross is 12500 / 2500 / 10000 / 0: statutory wages are 12500, well
  // inside the 21000 ceiling, so this employee IS covered. Comparing the gross
  // — or the old gross-less-Conveyance bound of 22500 — would have put them
  // outside the scheme and charged nobody anything.
  const esi = E.calculateEsi({ esi_applicable: 1, gross: 25000, ...E.calculateBreakup(25000) });
  assert.equal(esi.status, E.STATUS.APPLIED);
  assert.equal(esi.esi_wage, 12500);
  assert.equal(esi.employer_esi, 406);
});

test("a continuing contribution period keeps somebody covered above the ceiling", () => {
  // Coverage runs to the end of a contribution period even once wages pass the
  // ceiling, and the standard path must not short-circuit that.
  const base = { esi_applicable: 1, gross: 60000, ...E.calculateBreakup(60000) };
  assert.equal(E.calculateEsi(base).status, E.STATUS.NOT_APPLICABLE);

  const continuing = E.calculateEsi({ ...base, contribution_period_continues: true });
  assert.equal(continuing.status, E.STATUS.APPLIED);
  assert.equal(continuing.esi_wage_basis, E.ESI_WAGE_BASIS.STANDARD);
  assert.ok(continuing.employer_esi > 0, "the employer still contributes for the period");
});

test("a borderline gross is decided on its statutory wages", () => {
  // 23000 gross is 11500 / 2500 / 9000 / 0. Excluded is 11500 against a half
  // of 11500 — the boundary, so no add-back — and wages are 11500.
  const esi = E.calculateEsi({ esi_applicable: 1, gross: 23000, ...E.calculateBreakup(23000) });
  assert.equal(esi.status, E.STATUS.APPLIED);
  assert.equal(esi.esi_wage, 11500);
  assert.equal(esi.wage_definition.add_back, 0);
});

test("a supplied ESI wage is what gets used", () => {
  const esi = E.calculateEsi({ esi_applicable: 1, gross: 20000, conveyance: 2500, esi_wage: 18000 });
  assert.equal(esi.status, E.STATUS.APPLIED);
  assert.equal(esi.esi_wage, 18000);
  assert.equal(esi.employee_esi, 135, "0.75% of 18000");
  assert.equal(esi.employer_esi, 585, "3.25% of 18000");
});

test("a supplied wage above the ceiling is not covered", () => {
  const esi = E.calculateEsi({ esi_applicable: 1, gross: 30000, conveyance: 2500, esi_wage: 25000 });
  assert.equal(esi.status, E.STATUS.NOT_APPLICABLE);
  assert.equal(esi.employer_esi, 0);
});

test("contribution-period continuation keeps a risen wage covered", () => {
  const esi = E.calculateEsi({
    esi_applicable: 1,
    gross: 30000,
    conveyance: 2500,
    esi_wage: 25000,
    contribution_period_continues: true,
  });
  assert.equal(esi.status, E.STATUS.APPLIED);
  assert.equal(esi.employer_esi, 813, "3.25% of 25000 rounds to 813");
});

test("the low-wage exemption zeroes the EMPLOYEE share and keeps the employer's", () => {
  const esi = E.calculateEsi({ esi_applicable: 1, gross: 4000, conveyance: 0, esi_wage: 4000 });
  assert.equal(esi.employee_contribution_exempt, true, "4000/26 is under the daily threshold");
  assert.equal(esi.employee_esi, 0);
  assert.equal(esi.employer_esi, 130, "3.25% of 4000");
});

test("ESI applicability not recorded is PENDING where it could matter", () => {
  const esi = E.calculateEsi({ esi_applicable: null, gross: 15000, conveyance: 2500 });
  assert.equal(esi.status, E.STATUS.PENDING);
  assert.equal(esi.unresolved[0].code, E.UNRESOLVED.ESI_APPLICABILITY_NOT_RECORDED);
});

test("ESI applicability not recorded still resolves when nobody could be covered", () => {
  const esi = E.calculateEsi({ esi_applicable: null, gross: 50000, conveyance: 2500 });
  assert.equal(esi.status, E.STATUS.NOT_APPLICABLE);
  assert.deepEqual(esi.unresolved, []);
});

/* ------------------------------------------------------------------- CTC */

test("CTC adds only the EMPLOYER statutory costs to the gross", () => {
  const r = E.calculateSalary({
    monthly_gross: 50000,
    pf_applicable: 1,
    esi_applicable: 1,
    previous_eps_member: 1,
    dob: "1990-05-10",
    date_of_joining: "2020-01-01",
    effective_from: "2026-04-01",
  });
  assert.equal(r.valid, true);
  // 50000 + employer PF 1800 + EDLI 75 + admin 75 + ESI 0 (not covered)
  assert.equal(r.monthly_ctc, 51950);
  assert.equal(r.ctc_status, E.STATUS.APPLIED);
});

test("the employee's own PF and ESI are NOT added back into CTC", () => {
  const r = E.calculateSalary({
    monthly_gross: 50000,
    pf_applicable: 1,
    esi_applicable: 1,
    previous_eps_member: 1,
    dob: "1990-05-10",
    date_of_joining: "2020-01-01",
    effective_from: "2026-04-01",
  });
  const wrong = 50000 + 1800 + 75 + 75 + r.pf.employee_pf;
  assert.notEqual(r.monthly_ctc, wrong, "employee PF is a deduction from gross, already inside it");
});

test("an unresolved employer cost makes the CTC PENDING rather than a subtotal", () => {
  // `esi_applicable` is deliberately absent: nobody has recorded whether this
  // employee is in the scheme, so the employer's ESI is genuinely unknown and
  // the CTC that would contain it is not a CTC.
  const r = E.calculateSalary({
    monthly_gross: 20000,
    pf_applicable: 1,
    previous_eps_member: 1,
    dob: "1990-05-10",
    date_of_joining: "2020-01-01",
    effective_from: "2026-04-01",
  });
  assert.equal(r.ctc_status, E.STATUS.PENDING);
  assert.equal(r.monthly_ctc, null);
  assert.deepEqual(r.ctc_pending_components, ["employer_esi"]);
});

test("an approved 16000 salary states its standard ESI and CTC with no payrun", () => {
  // The Salary Master case end to end: gross 16000 breaks up as 10000 / 2500 /
  // 3500 / 0, the standard ESI wage is 13500, and the CTC is the gross plus
  // the employer's costs only — 16000 + 1200 + 50 + 50 + 439.
  const r = E.calculateSalary({
    monthly_gross: 16000,
    pf_applicable: 1,
    esi_applicable: 1,
    previous_eps_member: 1,
    dob: "1990-05-10",
    date_of_joining: "2020-01-01",
    effective_from: "2026-04-01",
  });
  assert.deepEqual(r.components, {
    basic: 10000,
    conveyance: 2500,
    hra: 3500,
    special_allowance: 0,
  });
  assert.equal(r.esi.status, E.STATUS.APPLIED);
  assert.equal(r.esi.esi_wage, 10000, "Basic + Special Allowance; HRA and Conveyance are out");
  assert.equal(r.esi.employee_esi, 75);
  assert.equal(r.esi.employer_esi, 325);
  assert.equal(r.ctc_status, E.STATUS.APPLIED);
  assert.equal(r.monthly_ctc, 17625);
  assert.deepEqual(r.unresolved, []);
  // The PF side is untouched by the ESI change.
  assert.equal(r.pf.employee_pf, 1200);
  assert.equal(r.pf.employer_pf_total, 1200);
  assert.equal(r.pf.edli, 50);
  assert.equal(r.pf.pf_admin_charge, 50);
});

test("with ESI out of scope the CTC for a 20000 gross resolves", () => {
  const r = E.calculateSalary({
    monthly_gross: 20000,
    pf_applicable: 1,
    esi_applicable: 0,
    previous_eps_member: 1,
    dob: "1990-05-10",
    date_of_joining: "2020-01-01",
    effective_from: "2026-04-01",
  });
  // 20000 + 1200 + 50 + 50
  assert.equal(r.monthly_ctc, 21300);
});

test("an unresolved EPS SPLIT does not block the CTC — the employer total is known", () => {
  const noCeiling = { ...CONFIG, pf: { ...CONFIG.pf, applyCeilingToWage: false } };
  const r = E.calculateSalary(
    {
      monthly_gross: 50000,
      pf_applicable: 1,
      esi_applicable: 0,
      previous_eps_member: null,
      dob: "1990-05-10",
      date_of_joining: "2020-01-01",
      effective_from: "2026-04-01",
    },
    noCeiling
  );
  assert.equal(r.pf.employer_eps, null);
  assert.equal(r.ctc_status, E.STATUS.APPLIED);
  assert.ok(r.unresolved.some((u) => u.code === E.UNRESOLVED.EPS_MEMBERSHIP_NOT_RECORDED));
});

/* ------------------------------------------------------ effective dating */

test("the first record is dated the later of the opening floor and the DOJ", () => {
  assert.equal(E.resolveOpeningEffectiveFrom("2019-06-01"), "2026-04-01", "an old joiner starts at the floor");
  assert.equal(E.resolveOpeningEffectiveFrom("2026-07-15"), "2026-07-15", "a later joiner starts at their DOJ");
  assert.equal(E.resolveOpeningEffectiveFrom("2026-04-01"), "2026-04-01", "exactly the floor");
  assert.equal(E.resolveOpeningEffectiveFrom(null), "2026-04-01", "no DOJ falls back to the floor");
});

test("a DOJ that arrives as a Date or a timestamp string is handled", () => {
  assert.equal(E.resolveOpeningEffectiveFrom(new Date(Date.UTC(2026, 7, 3))), "2026-08-03");
  assert.equal(E.resolveOpeningEffectiveFrom("2026-08-03T00:00:00.000Z"), "2026-08-03");
});

/* -------------------------------------------------- the whole calculation */

test("a manual override flows through to the statutory calculation", () => {
  const r = E.calculateSalary({
    monthly_gross: 50000,
    manual_components: { basic: 20000, conveyance: 2500, hra: 10000, special_allowance: 17500 },
    manual_override: true,
    override_reason: "Retained structure from previous employer",
    pf_applicable: 1,
    esi_applicable: 0,
    previous_eps_member: 1,
    dob: "1990-05-10",
    date_of_joining: "2020-01-01",
    effective_from: "2026-04-01",
  });
  assert.equal(r.valid, true);
  assert.equal(r.manual_override, true);
  assert.equal(r.components.basic, 20000);
  assert.equal(r.pf.pf_wage, 15000, "statutory rules still apply to an overridden Basic");
  assert.equal(r.pf.employee_pf, 1800);
});

test("an invalid manual override is refused by the whole calculation, not just the validator", () => {
  const r = E.calculateSalary({
    monthly_gross: 50000,
    manual_components: { basic: 20000, conveyance: 2500, hra: 10000, special_allowance: 17500 },
    pf_applicable: 1,
    esi_applicable: 0,
  });
  assert.equal(r.valid, false);
  assert.ok(r.errors.length > 0);
});

test("every record carries the statutory snapshot that explains it", () => {
  const r = E.calculateSalary({
    monthly_gross: 15000,
    pf_applicable: 1,
    esi_applicable: 0,
    previous_eps_member: 1,
    dob: "1990-05-10",
    date_of_joining: "2020-01-01",
    effective_from: "2026-04-01",
  });
  const s = r.statutory_snapshot;
  assert.equal(s.pf_wage_ceiling, 15000);
  assert.equal(s.pf_eps_rate_percent, 8.33);
  assert.equal(s.esi_coverage_ceiling, 21000);
  assert.equal(s.basic_floor, 10000);
  assert.equal(s.salary_days_per_month, 26);
  // WHICH DEFINITION OF WAGES produced it, not only which rates.
  assert.deepEqual(s.wage_excluded_components, ["hra", "conveyance"]);
  assert.equal(s.wage_minimum_percent_of_remuneration, 50);
  assert.equal(s.wage_definition_effective_from, "2025-11-21");
  assert.ok(s.config_version, "a version stamp makes a whole generation of records findable");
});

test("the engine never reads a component, contribution or CTC from the caller", () => {
  const r = E.calculateSalary({
    monthly_gross: 15000,
    // Everything below is a lie a client might send. None of it may survive.
    basic: 99999,
    employee_pf: 1,
    employer_epf: 2,
    monthly_ctc: 3,
    daily_salary: 4,
    pf_applicable: 1,
    esi_applicable: 0,
    previous_eps_member: 1,
    dob: "1990-05-10",
    date_of_joining: "2020-01-01",
    effective_from: "2026-04-01",
  });
  assert.equal(r.components.basic, 10000);
  assert.equal(r.pf.employee_pf, 1200);
  assert.equal(r.daily_salary, 576.92);
  assert.notEqual(r.monthly_ctc, 3);
});

/* -------------------------------------------------------- tri-state flags */

test("a tri-state flag distinguishes No from nobody-has-said", () => {
  assert.equal(E.triState(1), true);
  assert.equal(E.triState(0), false);
  assert.equal(E.triState(null), null);
  assert.equal(E.triState(undefined), null);
  assert.equal(E.triState(""), null);
});

/* ------------------------------- records stored before the standard basis */

const LEGACY_ROW = {
  monthly_gross: 16000,
  basic: 10000,
  conveyance: 2500,
  hra: 3500,
  special_allowance: 0,
  pf_status: "APPLIED",
  employee_pf: 1200,
  employer_pf_total: 1200,
  employer_epf: 367,
  employer_eps: 833,
  edli: 50,
  pf_admin_charge: 50,
  esi_status: "PENDING",
  esi_wage: null,
  employee_esi: null,
  employer_esi: null,
  monthly_ctc: null,
  ctc_status: "PENDING",
  unresolved_notes: [{ code: "ESI_WAGE_CONTEXT_UNAVAILABLE", component: "esi" }],
  /*
   * A snapshot as the EARLIER engine wrote one: it carries the rates but no
   * wage definition, because ESI had no wage to define when this row was
   * stored. The fill honours the rates it finds and falls back to the current
   * wage definition, which is the only one this record has ever been under.
   */
  statutory_snapshot: {
    esi_employee_rate_percent: 0.75,
    esi_employer_rate_percent: 3.25,
    esi_coverage_ceiling: 21000,
    esi_employee_exemption_daily_wage: 176,
    salary_days_per_month: 26,
    contribution_rounding: "NEAREST_RUPEE",
  },
};

test("a record stored before the standard basis reads as the standard amount", () => {
  const filled = E.fillStandardEsi(LEGACY_ROW);
  assert.equal(filled.esi_status, E.STATUS.APPLIED);
  // The same statutory wage a record created today gets on these numbers.
  assert.equal(filled.esi_wage, 10000);
  assert.equal(filled.employee_esi, 75);
  assert.equal(filled.employer_esi, 325);
  assert.equal(filled.monthly_ctc, 17625);
  assert.equal(filled.ctc_status, E.STATUS.APPLIED);
  assert.deepEqual(filled.unresolved_notes, []);
  // The stored row itself is untouched: this completes a record, it does not
  // rewrite history.
  assert.equal(LEGACY_ROW.employer_esi, null);
  assert.equal(LEGACY_ROW.esi_status, "PENDING");
});

test("the fill uses the RECORD'S OWN rates, not today's", () => {
  const filled = E.fillStandardEsi({
    ...LEGACY_ROW,
    statutory_snapshot: { ...LEGACY_ROW.statutory_snapshot, esi_employer_rate_percent: 4.75 },
  });
  // 4.75% of the 10000 statutory wage is 475.
  assert.equal(filled.employer_esi, 475);
});

test("the fill applies the SAME wage definition as a fresh calculation", () => {
  const filled = E.fillStandardEsi(LEGACY_ROW);
  const fresh = E.calculateSalary({
    monthly_gross: LEGACY_ROW.monthly_gross,
    pf_applicable: 1,
    esi_applicable: 1,
    previous_eps_member: 1,
    dob: "1990-05-10",
    date_of_joining: "2020-01-01",
    effective_from: "2026-04-01",
  });
  assert.equal(filled.esi_wage, fresh.esi.esi_wage);
  assert.equal(filled.employee_esi, fresh.esi.employee_esi);
  assert.equal(filled.employer_esi, fresh.esi.employer_esi);
  assert.equal(filled.monthly_ctc, fresh.monthly_ctc);
});

test("the fill honours a wage definition the record DOES carry", () => {
  // A record stamped with a definition that excluded Conveyance alone is
  // recomputed under that definition, not under today's.
  const filled = E.fillStandardEsi({
    ...LEGACY_ROW,
    statutory_snapshot: {
      ...LEGACY_ROW.statutory_snapshot,
      wage_excluded_components: ["conveyance"],
      wage_minimum_percent_of_remuneration: 50,
    },
  });
  assert.equal(filled.esi_wage, 13500, "HRA is wages under that definition");
  assert.equal(filled.employer_esi, 439);
});

test("a genuinely open ESI question is left open by the fill", () => {
  const unrecorded = E.fillStandardEsi({
    ...LEGACY_ROW,
    unresolved_notes: [{ code: "ESI_APPLICABILITY_NOT_RECORDED", component: "esi" }],
  });
  assert.equal(unrecorded.esi_status, E.STATUS.PENDING);
  assert.equal(unrecorded.employer_esi, null);
  assert.equal(unrecorded.monthly_ctc, null);
});

test("the fill touches neither PF nor an unresolved PF note", () => {
  const withPfNote = E.fillStandardEsi({
    ...LEGACY_ROW,
    employer_eps: null,
    unresolved_notes: [
      { code: "ESI_WAGE_CONTEXT_UNAVAILABLE", component: "esi" },
      { code: "EPS_MEMBERSHIP_NOT_RECORDED", component: "employer_eps" },
    ],
  });
  assert.equal(withPfNote.employer_esi, 325);
  assert.equal(withPfNote.employee_pf, 1200);
  assert.equal(withPfNote.employer_pf_total, 1200);
  assert.deepEqual(withPfNote.unresolved_notes, [
    { code: "EPS_MEMBERSHIP_NOT_RECORDED", component: "employer_eps" },
  ]);
});

test("an already-resolved or not-applicable record is returned unchanged", () => {
  const applied = { ...LEGACY_ROW, esi_status: "APPLIED", employer_esi: 325, unresolved_notes: [] };
  assert.equal(E.fillStandardEsi(applied), applied);
  const na = { ...LEGACY_ROW, esi_status: "NOT_APPLICABLE", employer_esi: 0, unresolved_notes: [] };
  assert.equal(E.fillStandardEsi(na), na);
});
