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

/* ------------------------------------------------------------------- ESI */

test("ESI not applicable means zeros, not pending", () => {
  const esi = E.calculateEsi({ esi_applicable: 0, gross: 15000, conveyance: 2500 });
  assert.equal(esi.status, E.STATUS.NOT_APPLICABLE);
  assert.equal(esi.employee_esi, 0);
  assert.equal(esi.employer_esi, 0);
});

test("ESI does NOT assume the wage is the gross — it returns PENDING with a reason", () => {
  const esi = E.calculateEsi({ esi_applicable: 1, gross: 15000, conveyance: 2500 });
  assert.equal(esi.status, E.STATUS.PENDING);
  assert.equal(esi.employee_esi, null);
  assert.equal(esi.employer_esi, null);
  assert.equal(esi.unresolved[0].code, E.UNRESOLVED.ESI_WAGE_CONTEXT_UNAVAILABLE);
});

test("somebody too well paid to be covered is resolved without a payroll wage", () => {
  const esi = E.calculateEsi({ esi_applicable: 1, gross: 50000, conveyance: 2500 });
  assert.equal(esi.status, E.STATUS.NOT_APPLICABLE);
  assert.equal(esi.employer_esi, 0);
  assert.deepEqual(esi.unresolved, []);
});

test("the coverage bound excludes Conveyance, so a borderline gross stays pending", () => {
  // 23000 gross less 2500 conveyance is 20500, under the 21000 ceiling: the
  // employee might be covered, so the answer is pending rather than "no".
  const esi = E.calculateEsi({ esi_applicable: 1, gross: 23000, conveyance: 2500 });
  assert.equal(esi.status, E.STATUS.PENDING);
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
  const r = E.calculateSalary({
    monthly_gross: 20000,
    pf_applicable: 1,
    esi_applicable: 1,
    previous_eps_member: 1,
    dob: "1990-05-10",
    date_of_joining: "2020-01-01",
    effective_from: "2026-04-01",
  });
  assert.equal(r.ctc_status, E.STATUS.PENDING);
  assert.equal(r.monthly_ctc, null);
  assert.deepEqual(r.ctc_pending_components, ["employer_esi"]);
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
