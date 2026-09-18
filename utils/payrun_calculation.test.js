/**
 * Payrun Calculation & Review - every rule, proved as arithmetic.
 *
 *   node --test utils/payrun_calculation.test.js
 *
 * NO DATABASE, NO EXPRESS, NO CLOCK. `utils/payrun_calculation.js` is pure, so
 * the whole of the calculation contract is provable here - and a rule that
 * needed a MySQL connection to be exercised is a rule that gets exercised
 * once, by hand, in a browser.
 *
 * WHAT IS PROVED HERE rather than in `usecase/payrun_calculation.test.js`: the
 * FIGURES and the STATUSES. Who may calculate, what a bulk action does and
 * what a lock refuses are the stage's job and are proved there.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const calc = require("./payrun_calculation");
const { COMPONENT, ADJUSTMENT_STATE } = require("../constants/payrun_adjustments");
const { CALC_STATUS, RECALC_REASON, READY_BLOCKER, NRM_SOURCE } = require("../constants/payrun_calculation");

/* =========================================================== the fixtures */

/**
 * ONE ORDINARY EMPLOYEE, and every number in it is round on purpose so that a
 * failure reads as a business mistake rather than as arithmetic to unpick.
 *
 *   Gross 26,000  ->  Daily Rate 1,000 (Gross / 26)
 *   NRM 480 min   ->  OT hourly 125    (Daily Rate / 8 hours)
 */
const SNAPSHOT = {
  monthly_gross: 26000,
  basic: 13000,
  conveyance: 2500,
  hra: 5000,
  special_allowance: 5500,
  pf_applicable: 1,
  esi_applicable: 1,
  pay_type: "BANK",
  date_of_joining: "2018-04-01",
};

/** A full attended month with no shortage and no overtime. */
const ATTENDANCE = {
  attendance_monthly_payroll_id: 900,
  payroll_version: 1,
  calculated_at: "2026-09-01 02:00:00.000",
  is_final: 1,
  salary_days: 26,
  extra_days: 0,
  salary_day_earnings: 26000,
  extra_day_earnings: 0,
  shortage_minutes: 0,
  missing_minute_deduction: 0,
  approved_ot_minutes: 0,
  approved_ot_earnings: 0,
};

const NRM = { nrm_minutes: 480, nrm_source: NRM_SOURCE.SHIFT, nrm_is_mixed: false };

const STATUTORY = { dob: "1990-06-15", previous_eps_member: 0 };

const run = (overrides = {}) =>
  calc.computeCalculation({
    snapshot: { ...SNAPSHOT, ...(overrides.snapshot || {}) },
    attendance: { ...ATTENDANCE, ...(overrides.attendance || {}) },
    nrm: overrides.nrm === undefined ? NRM : overrides.nrm,
    amounts: overrides.amounts || {},
    statutory: { ...STATUTORY, ...(overrides.statutory || {}) },
    as_of: "2026-08-31",
  });

/* ======================================================== the calculation */

describe("calculating one employee's month from the initialized snapshot", () => {
  it("prices the day at Gross / 26 and takes the day counts from attendance", () => {
    const r = run();
    assert.equal(r.daily_rate, 1000);
    assert.equal(r.salary_days, 26);
    assert.equal(r.salary_earnings, 26000);
  });

  /**
   * THE RULE THIS FEATURE IS BUILT ON. Salary Days is CONSUMED. If this file
   * ever re-derived it from a punch count or a base-day arithmetic, an
   * attendance result saying 22 would be silently overruled - which is the
   * whole of "do not recreate attendance logic inside Payrun".
   */
  it("consumes Salary Days rather than re-deriving them", () => {
    const r = run({ attendance: { salary_days: 22, salary_day_earnings: 22000 } });
    assert.equal(r.salary_days, 22);
    assert.equal(r.salary_earnings, 22000);
  });

  it("applies the Missing Hours Deduction attendance computed", () => {
    const r = run({
      attendance: { shortage_minutes: 120, missing_minute_deduction: 250 },
    });
    assert.equal(r.missing_hours_minutes, 120);
    assert.equal(r.missing_hours, 2);
    assert.equal(r.missing_hours_deduction, 250);
    // 26,000 earned less the 250 that was not worked, before anything else.
    assert.equal(r.total_earnings, 26000);
    assert.ok(r.total_employee_deductions >= 250);
  });

  it("pays Extra Days separately and excludes them from PF and ESI", () => {
    const plain = run();
    const withExtra = run({
      attendance: { extra_days: 2, extra_day_earnings: 2000 },
    });

    assert.equal(withExtra.extra_days, 2);
    assert.equal(withExtra.extra_day_amount, 2000);
    assert.equal(withExtra.total_earnings, plain.total_earnings + 2000);

    // THE POINT OF THE TEST: not one rupee of the extra day reached either
    // statutory base.
    assert.equal(withExtra.pf_wage, plain.pf_wage);
    assert.equal(withExtra.employee_pf, plain.employee_pf);
    assert.equal(withExtra.esi_wage, plain.esi_wage);
    assert.equal(withExtra.employee_esi, plain.employee_esi);
  });
});

/* =================================================================== OT */

describe("overtime", () => {
  it("prices OT at Daily Rate / Effective NRM and pays approved hours only", () => {
    const r = run({ attendance: { approved_ot_minutes: 120 } });
    assert.equal(r.approved_ot_hours, 2);
    assert.equal(r.effective_nrm_minutes, 480);
    assert.equal(r.ot_hourly_rate, 125); // 1000 / 8
    assert.equal(r.ot_amount, 250);
  });

  /**
   * ONLY APPROVED OT ENTERS PAYROLL, and the proof is structural: the input
   * carries candidate and raw minutes as well, and the calculation is
   * identical to one that carries neither. No field but `approved_ot_minutes`
   * is read.
   */
  it("ignores candidate and raw OT entirely", () => {
    const approvedOnly = run({ attendance: { approved_ot_minutes: 60 } });
    const withCandidates = run({
      attendance: {
        approved_ot_minutes: 60,
        candidate_ot_minutes: 600,
        raw_ot_minutes: 900,
        post_shift_ot_minutes: 600,
      },
    });
    assert.equal(withCandidates.ot_amount, approvedOnly.ot_amount);
    assert.equal(withCandidates.ot_amount, 125);
  });

  it("excludes OT from PF and from ESI", () => {
    const plain = run();
    const withOt = run({ attendance: { approved_ot_minutes: 600 } });
    assert.ok(withOt.ot_amount > 0);
    assert.equal(withOt.pf_wage, plain.pf_wage);
    assert.equal(withOt.employee_pf, plain.employee_pf);
    assert.equal(withOt.esi_wage, plain.esi_wage);
  });

  /**
   * AN APPROVED OT THAT CANNOT BE PRICED IS AN ERROR, NEVER A ZERO. A zero is
   * an employee quietly not paid for overtime somebody approved, which is the
   * kind of mistake nobody notices until they complain.
   */
  it("refuses to price approved OT with no effective NRM, rather than paying nothing", () => {
    const r = run({ attendance: { approved_ot_minutes: 120 }, nrm: { nrm_minutes: null } });
    assert.equal(r.is_complete, false);
    assert.ok(r.errors.some((e) => /effective NRM/i.test(e)));
  });
});

/* ====================================================== the effective NRM */

describe("the effective NRM", () => {
  it("uses the shift's NRM when the employee has no override", () => {
    const resolved = calc.resolveEffectiveNrm([
      { nrm_minutes: 480, break_allowance_source: "SHIFT", day_count: 26, approved_ot_minutes: 300 },
    ]);
    assert.equal(resolved.nrm_minutes, 480);
    assert.equal(resolved.nrm_source, NRM_SOURCE.SHIFT);
  });

  /**
   * TWO EMPLOYEES ON THE SAME SHIFT MAY HAVE DIFFERENT OT RATES, AND ONLY FOR
   * THIS REASON. Attendance resolved a different NRM for this person because
   * their lunch/break is overridden, and the payrun consumes that answer
   * rather than reading the shift master back.
   */
  it("uses the employee-specific NRM when attendance resolved an override", () => {
    const resolved = calc.resolveEffectiveNrm([
      { nrm_minutes: 450, break_allowance_source: "EMPLOYEE_OVERRIDE", day_count: 26, approved_ot_minutes: 300 },
    ]);
    assert.equal(resolved.nrm_minutes, 450);
    assert.equal(resolved.nrm_source, NRM_SOURCE.EMPLOYEE_OVERRIDE);

    const sameShift = run({ nrm: resolved, attendance: { approved_ot_minutes: 60 } });
    // 1000 / 7.5 hours, rounded to the rupee - a different rate from the
    // colleague above, and the row says exactly why.
    assert.equal(sameShift.ot_hourly_rate, 133.33);
  });

  it("prefers the NRM the approved overtime was actually worked against", () => {
    const resolved = calc.resolveEffectiveNrm([
      { nrm_minutes: 480, break_allowance_source: "SHIFT", day_count: 24, approved_ot_minutes: 0 },
      { nrm_minutes: 600, break_allowance_source: "SHIFT", day_count: 2, approved_ot_minutes: 180 },
    ]);
    assert.equal(resolved.nrm_minutes, 600);
    assert.equal(resolved.nrm_is_mixed, true);
  });

  it("falls back to the month's ordinary pattern when nobody worked overtime", () => {
    const resolved = calc.resolveEffectiveNrm([
      { nrm_minutes: 480, break_allowance_source: "SHIFT", day_count: 24, approved_ot_minutes: 0 },
      { nrm_minutes: 600, break_allowance_source: "SHIFT", day_count: 2, approved_ot_minutes: 0 },
    ]);
    assert.equal(resolved.nrm_minutes, 480);
  });

  it("has no answer at all when attendance resolved none, rather than inventing one", () => {
    assert.deepEqual(calc.resolveEffectiveNrm([]), { nrm_minutes: null, nrm_source: null });
  });
});

/* ========================================================== adjustments */

describe("adjustments", () => {
  it("adds Incentive, Bonus and Arrears to net pay and to neither statutory base", () => {
    const plain = run();
    const adjusted = run({
      amounts: { [COMPONENT.INCENTIVE]: 1000, [COMPONENT.BONUS]: 500, [COMPONENT.ARREARS]: 250 },
    });

    assert.equal(adjusted.additions_total, 1750);
    assert.equal(adjusted.net_pay, plain.net_pay + 1750);
    assert.equal(adjusted.pf_wage, plain.pf_wage);
    assert.equal(adjusted.employee_pf, plain.employee_pf);
    assert.equal(adjusted.esi_wage, plain.esi_wage);
    assert.equal(adjusted.employee_esi, plain.employee_esi);
  });

  /**
   * A RECOVERY REDUCES NET PAY ONLY. Recovering money somebody was already
   * paid is not a change to what they EARNED, so it must not reduce a PF or
   * ESI wage - which would quietly reduce their own pension over an advance
   * repayment.
   */
  it("takes Advance and Shortage Recovery off net pay only", () => {
    const plain = run();
    const recovered = run({
      amounts: { [COMPONENT.ADVANCE_RECOVERY]: 2000, [COMPONENT.SHORTAGE_RECOVERY]: 300 },
    });

    assert.equal(recovered.deductions_total, 2300);
    assert.equal(recovered.net_pay, plain.net_pay - 2300);
    assert.equal(recovered.total_earnings, plain.total_earnings);
    assert.equal(recovered.pf_wage, plain.pf_wage);
    assert.equal(recovered.employee_pf, plain.employee_pf);
    assert.equal(recovered.esi_wage, plain.esi_wage);
    assert.equal(recovered.employee_esi, plain.employee_esi);
  });

  /**
   * THE BALANCE ADVANCE MOVES NOTHING. Not net pay, not gross, not a
   * contribution, not a total. Asserted field by field against an identical
   * month without one, because "informational" is only true if every figure is
   * identical.
   */
  it("gives a Balance Advance zero effect on every figure", () => {
    const plain = run();
    const withBalance = run({ amounts: { [COMPONENT.BALANCE_ADVANCE]: 8500 } });

    assert.equal(withBalance.balance_advance, 8500);
    for (const field of [
      "salary_earnings", "extra_day_amount", "missing_hours_deduction", "ot_amount",
      "additions_total", "deductions_total", "pf_wage", "employee_pf", "employer_epf",
      "employer_eps", "esi_wage", "employee_esi", "employer_esi",
      "total_earnings", "total_employee_deductions", "net_pay",
    ]) {
      assert.equal(withBalance[field], plain[field], `${field} moved`);
    }
  });
});

/* ============================================================= statutory */

describe("PF and ESI", () => {
  /**
   * PF IS CHARGED ON EARNED BASIC FOR SALARY DAYS ONLY. Half a month's salary
   * days is half the Basic, and the contribution follows it.
   */
  it("charges PF on the earned Basic for the Salary Days worked", () => {
    const full = run();
    assert.equal(full.pf_wage, 13000);
    assert.equal(full.employee_pf, 1560); // 12% of 13,000

    const half = run({ attendance: { salary_days: 13, salary_day_earnings: 13000 } });
    assert.equal(half.pf_wage, 6500);
    assert.equal(half.employee_pf, 780);
  });

  it("splits the employer's contribution into EPF and EPS through the salary engine", () => {
    const r = run();
    assert.equal(r.employer_pf_total, 1560);
    assert.equal(Number(r.employer_epf) + Number(r.employer_eps), 1560);
    assert.ok(Number(r.employer_eps) > 0);
  });

  it("charges nothing when PF is not applicable", () => {
    const r = run({ snapshot: { pf_applicable: 0 } });
    assert.equal(r.pf_wage, 0);
    assert.equal(r.employee_pf, 0);
  });

  /**
   * ESI IS CHARGED ON NORMAL SALARY EARNINGS ONLY. The wage is the Code's
   * definition applied to what was EARNED: the excluded heads come out in the
   * proportion they were earned in, and the deduction for minutes not worked
   * comes off the remuneration first.
   */
  it("charges ESI on eligible normal salary earnings, less the missing-hours deduction", () => {
    const full = run();
    assert.equal(full.esi_wage, 18500); // 26,000 less HRA 5,000 and Conveyance 2,500

    const short = run({ attendance: { shortage_minutes: 60, missing_minute_deduction: 1000 } });
    assert.ok(Number(short.esi_wage) < Number(full.esi_wage));
  });

  it("charges nothing when ESI is not applicable", () => {
    const r = run({ snapshot: { esi_applicable: 0 } });
    assert.equal(r.esi_wage, 0);
    assert.equal(r.employee_esi, 0);
  });
});

/* ================================================================ net pay */

describe("the net pay identity", () => {
  it("adds and subtracts exactly what the contract says, in that order", () => {
    const r = run({
      attendance: {
        salary_days: 25,
        salary_day_earnings: 25000,
        extra_days: 1,
        extra_day_earnings: 1000,
        shortage_minutes: 60,
        missing_minute_deduction: 125,
        approved_ot_minutes: 120,
      },
      amounts: {
        [COMPONENT.INCENTIVE]: 1000,
        [COMPONENT.BONUS]: 500,
        [COMPONENT.ARREARS]: 250,
        [COMPONENT.ADVANCE_RECOVERY]: 2000,
        [COMPONENT.SHORTAGE_RECOVERY]: 300,
        [COMPONENT.BALANCE_ADVANCE]: 9000,
      },
    });

    const expected =
      25000 + 1000 - 125 + Number(r.ot_amount) + 1000 + 500 + 250 -
      Number(r.employee_pf) - Number(r.employee_esi) - 2000 - 300;

    assert.equal(r.net_pay, Number(expected.toFixed(2)));
    assert.equal(
      Number(r.total_earnings) - Number(r.total_employee_deductions),
      Number(r.net_pay)
    );
  });
});

/* ================================================= source change detection */

describe("source changes", () => {
  const markers = (over = {}) =>
    calc.sourceMarkers({
      salary: { salary_id: 5, effective_from: "2026-04-01", monthly_gross: 26000 },
      attendance: { ...ATTENDANCE },
      nrm: NRM,
      statutory: { pf_applicable: 1, esi_applicable: 1 },
      ...over,
    });

  it("names a salary revision as the reason", () => {
    const before = markers();
    const after = markers({ salary: { salary_id: 6, effective_from: "2026-08-01", monthly_gross: 28000 } });
    assert.deepEqual(calc.detectChanges(before, after), [RECALC_REASON.SALARY_CHANGED]);
    assert.notEqual(calc.sourceHash(before), calc.sourceHash(after));
  });

  it("names an attendance re-run, an OT approval and an NRM change apart", () => {
    const before = markers();
    assert.deepEqual(
      calc.detectChanges(before, markers({ attendance: { ...ATTENDANCE, payroll_version: 2 } })),
      [RECALC_REASON.ATTENDANCE_CHANGED]
    );
    assert.deepEqual(
      calc.detectChanges(before, markers({ attendance: { ...ATTENDANCE, approved_ot_minutes: 120 } })),
      [RECALC_REASON.APPROVED_OT_CHANGED]
    );
    assert.deepEqual(
      calc.detectChanges(before, markers({ nrm: { nrm_minutes: 450, nrm_source: NRM_SOURCE.EMPLOYEE_OVERRIDE } })),
      [RECALC_REASON.EFFECTIVE_NRM_CHANGED]
    );
  });

  it("is silent when nothing moved", () => {
    assert.deepEqual(calc.detectChanges(markers(), markers()), []);
    assert.equal(calc.sourceHash(markers()), calc.sourceHash(markers()));
  });

  /**
   * THE PAYRUN'S OWN INPUTS ARE A SEPARATE FINGERPRINT. An adjustment edited
   * after the calculation makes the stored net pay stale just as a salary
   * revision does - but it is a different event, with a different person to go
   * and talk to, so it is hashed apart.
   */
  it("notices an adjustment or a pay type change through the inputs hash", () => {
    const base = calc.inputsHash({ amounts: {}, pay_type: "BANK" });
    assert.notEqual(base, calc.inputsHash({ amounts: { [COMPONENT.INCENTIVE]: 100 }, pay_type: "BANK" }));
    assert.notEqual(base, calc.inputsHash({ amounts: {}, pay_type: "CASH" }));
    // A Balance Advance is informational for MONEY, but it is still a stored
    // value the calculation carried, so changing it does require a refresh.
    assert.notEqual(base, calc.inputsHash({ amounts: { [COMPONENT.BALANCE_ADVANCE]: 500 }, pay_type: "BANK" }));
  });
});

/* ================================================================ statuses */

describe("the status rules", () => {
  const CALCULATED = { status: "CALCULATED", source_hash: "aaa", inputs_hash: "bbb", is_complete: true };
  const ready = (over = {}) =>
    calc.deriveStatus({
      calculation: CALCULATED,
      current_source_hash: "aaa",
      current_inputs_hash: "bbb",
      attendance: { is_final: 1 },
      pending_regularizations: 0,
      pending_ot: 0,
      adjustment_state: ADJUSTMENT_STATE.NO_ADJUSTMENT_CONFIRMED,
      statutory_setup_complete: true,
      ...over,
    });

  it("is NOT_CALCULATED before anything has been computed", () => {
    const v = calc.deriveStatus({ calculation: null });
    assert.equal(v.status, CALC_STATUS.NOT_CALCULATED);
    assert.equal(v.payslip_eligible, false);
  });

  /**
   * A MOVED SOURCE DOES NOT CHANGE A SINGLE FIGURE. It changes the STATUS, and
   * the employee cannot be approved until somebody recalculates them - which
   * is the whole of "source changes must never silently mutate payroll".
   */
  it("is RECALCULATION_REQUIRED when a source moved, and blocks approval", () => {
    const v = ready({
      current_source_hash: "zzz",
      change_reasons: [RECALC_REASON.SALARY_CHANGED],
    });
    assert.equal(v.status, CALC_STATUS.RECALCULATION_REQUIRED);
    assert.equal(v.recalculation_reasons[0].code, RECALC_REASON.SALARY_CHANGED);
    assert.ok(v.blockers.some((b) => b.code === READY_BLOCKER.RECALCULATION_REQUIRED));
    assert.equal(v.payslip_eligible, false);
  });

  it("is READY_FOR_APPROVAL only when every rule is satisfied", () => {
    const v = ready();
    assert.equal(v.status, CALC_STATUS.READY_FOR_APPROVAL);
    assert.deepEqual(v.blockers, []);
  });

  it("blocks approval on each outstanding thing, by name", () => {
    const cases = [
      [{ attendance: { is_final: 0 } }, READY_BLOCKER.ATTENDANCE_INCOMPLETE],
      [{ pending_regularizations: 1 }, READY_BLOCKER.PENDING_ATTENDANCE_REGULARIZATION],
      [{ pending_ot: 1 }, READY_BLOCKER.PENDING_OT_APPROVAL],
      [
        { adjustment_state: ADJUSTMENT_STATE.NO_ADJUSTMENT_PENDING_CONFIRMATION },
        READY_BLOCKER.ADJUSTMENT_PENDING_CONFIRMATION,
      ],
      [{ statutory_setup_complete: false }, READY_BLOCKER.STATUTORY_SETUP_INCOMPLETE],
      [
        { calculation: { ...CALCULATED, is_complete: false } },
        READY_BLOCKER.CALCULATION_INCOMPLETE,
      ],
    ];
    for (const [over, code] of cases) {
      const v = ready(over);
      assert.equal(v.status, CALC_STATUS.CALCULATED, `${code} should not be ready`);
      assert.ok(v.blockers.some((b) => b.code === code), `expected ${code}`);
    }
  });

  /**
   * AN EMPLOYEE WHOSE ADJUSTMENT STAGE IS COMPLETE EITHER WAY IS ALLOWED.
   * HAS_ADJUSTMENT and NO_ADJUSTMENT_CONFIRMED are both "somebody dealt with
   * this person"; only the pending state means nobody has.
   */
  it("accepts either completed adjustment state", () => {
    assert.equal(
      ready({ adjustment_state: ADJUSTMENT_STATE.HAS_ADJUSTMENT }).status,
      CALC_STATUS.READY_FOR_APPROVAL
    );
    assert.equal(
      ready({ adjustment_state: ADJUSTMENT_STATE.NO_ADJUSTMENT_CONFIRMED }).status,
      CALC_STATUS.READY_FOR_APPROVAL
    );
  });

  /** THE PAYSLIP ELIGIBILITY CONTRACT, in both directions. */
  it("makes an APPROVED_LOCKED employee payslip eligible and nobody else", () => {
    const locked = calc.deriveStatus({
      calculation: { status: CALC_STATUS.APPROVED_LOCKED },
      current_source_hash: "zzz",
      current_inputs_hash: "yyy",
    });
    assert.equal(locked.status, CALC_STATUS.APPROVED_LOCKED);
    assert.equal(locked.payslip_eligible, true);

    assert.equal(ready().payslip_eligible, false);
    assert.equal(calc.deriveStatus({ calculation: null }).payslip_eligible, false);
  });

  /**
   * A LOCKED EMPLOYEE STAYS LOCKED WHATEVER MOVED. There is nothing anybody
   * may do about a source that changed under an approved month until the
   * future unlock path exists, so reporting it as stale would be a badge with
   * no action behind it.
   */
  it("keeps a locked employee locked even when a source has moved", () => {
    const v = calc.deriveStatus({
      calculation: { status: CALC_STATUS.APPROVED_LOCKED, source_hash: "a", inputs_hash: "b" },
      current_source_hash: "different",
      current_inputs_hash: "different",
    });
    assert.equal(v.status, CALC_STATUS.APPROVED_LOCKED);
  });
});

describe("the month's counts", () => {
  it("counts every state over the current initialized population", () => {
    const summary = calc.summarize([
      { status: CALC_STATUS.NOT_CALCULATED, payslip_eligible: false },
      { status: CALC_STATUS.CALCULATED, payslip_eligible: false },
      { status: CALC_STATUS.RECALCULATION_REQUIRED, payslip_eligible: false },
      { status: CALC_STATUS.READY_FOR_APPROVAL, payslip_eligible: false },
      { status: CALC_STATUS.APPROVED_LOCKED, payslip_eligible: true },
    ]);
    assert.deepEqual(summary, {
      initialized: 5,
      not_calculated: 1,
      calculated: 1,
      recalculation_required: 1,
      ready_for_approval: 1,
      approved_locked: 1,
      payslip_eligible: 1,
    });
  });
});

describe("the calculation hash", () => {
  it("fingerprints the ANSWER, so a changed figure is a changed hash", () => {
    const a = run();
    const b = run({ amounts: { [COMPONENT.INCENTIVE]: 1 } });
    assert.equal(calc.calculationHash(a), calc.calculationHash(run()));
    assert.notEqual(calc.calculationHash(a), calc.calculationHash(b));
  });
});
