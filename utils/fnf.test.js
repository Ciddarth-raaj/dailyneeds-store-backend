/**
 * FULL & FINAL SETTLEMENT - the pure rules, the engine, the snapshot and the
 * PDF, without MySQL.
 *
 *   node --test utils/fnf.test.js
 *
 * What is proved here:
 *   - the exit-month rule (mid-month exit, month-end exit, later / earlier exits)
 *   - an ACTIVE employee's month calculates, hashes and snapshots EXACTLY as
 *     before (no F&F item can reach it; no hash moves)
 *   - F&F additions / recoveries join Total Earnings / Total Deductions and
 *     never the PF or ESI wage
 *   - advance recovery is the Adjustment's, recovered once
 *   - zero and negative F&F (recoverable from the employee)
 *   - the snapshot of an exit month is an F&F document; the PDF prints its
 *     stored figures, the declaration and the amount in words
 *   - no confidential HR field can be in a snapshot
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const fnf = require("./fnf");
const calc = require("./payrun_calculation");
const snap = require("./payslip_snapshot");
const pdf = require("../services/payslip_pdf");
const { COMPONENT } = require("../constants/payrun_adjustments");
const { NRM_SOURCE } = require("../constants/payrun_calculation");
const { DOCUMENT_TYPE, FNF_TEMPLATE_VERSION, FNF_COMPONENT, SETTLEMENT_STAGE } = require("../constants/fnf");
const { TEMPLATE_VERSION, notificationText } = require("../constants/payslip");

/* ============================================================ the rules */

describe("the exit-month rule", () => {
  it("a mid-month exit is that month's F&F", () => {
    assert.equal(fnf.isExitMonth({ year: 2026, month: 8, resignation_date: "2026-08-16" }), true);
  });
  it("the first and the last day of the month count", () => {
    assert.equal(fnf.isExitMonth({ year: 2026, month: 8, resignation_date: "2026-08-01" }), true);
    assert.equal(fnf.isExitMonth({ year: 2026, month: 8, resignation_date: "2026-08-31" }), true);
    assert.equal(fnf.isExitMonth({ year: 2026, month: 2, resignation_date: "2026-02-28" }), true);
  });
  it("an exit in another month, or none at all, is not", () => {
    assert.equal(fnf.isExitMonth({ year: 2026, month: 8, resignation_date: "2026-09-01" }), false);
    assert.equal(fnf.isExitMonth({ year: 2026, month: 8, resignation_date: "2026-07-31" }), false);
    assert.equal(fnf.isExitMonth({ year: 2026, month: 8, resignation_date: null }), false);
    assert.equal(fnf.isExitMonth({ year: 2026, month: 8, resignation_date: "" }), false);
  });
});

describe("amount in words (Indian grouping)", () => {
  it("matches the reference statement", () => {
    assert.equal(fnf.amountInWords("5031.00"), "Five Thousand Thirty One Rupees Only");
  });
  it("lakh, crore, paise and zero", () => {
    assert.equal(fnf.amountInWords("125000.00"), "One Lakh Twenty Five Thousand Rupees Only");
    assert.equal(fnf.amountInWords("10000000"), "One Crore Rupees Only");
    assert.equal(fnf.amountInWords("101.50"), "One Hundred One Rupees and Fifty Paise Only");
    assert.equal(fnf.amountInWords("0.00"), "Zero Rupees Only");
  });
  it("never spells a sign, and refuses what is not an amount", () => {
    assert.equal(fnf.amountInWords("-2500.00"), "Two Thousand Five Hundred Rupees Only");
    assert.equal(fnf.amountInWords("abc"), null);
    assert.equal(fnf.amountInWords(null), null);
  });
});

describe("the settlement stage", () => {
  const stage = (x) => fnf.settlementStage(x).stage;
  it("is derived from payroll state, SETTLED winning", () => {
    assert.equal(stage({ initialized: false }), SETTLEMENT_STAGE.NOT_IN_PAYROLL);
    assert.equal(stage({ initialized: true, calc_status: null }), SETTLEMENT_STAGE.IN_PAYROLL);
    assert.equal(stage({ initialized: true, calc_status: "CALCULATED" }), SETTLEMENT_STAGE.IN_PAYROLL);
    assert.equal(stage({ initialized: true, calc_status: "APPROVED_LOCKED" }), SETTLEMENT_STAGE.APPROVED);
    assert.equal(stage({ initialized: true, calc_status: "PUBLISHED" }), SETTLEMENT_STAGE.PUBLISHED);
    assert.equal(stage({ initialized: true, calc_status: "PUBLISHED", settlement_status: "SETTLED" }), SETTLEMENT_STAGE.SETTLED);
  });
});

/* ========================================================== the engine */

const SNAPSHOT = {
  monthly_gross: 10000,
  basic: 8000,
  conveyance: 0,
  hra: 0,
  special_allowance: 2000,
  pf_applicable: 1,
  esi_applicable: 1,
  pay_type: "BANK",
  date_of_joining: "2026-02-02",
};
const ATTENDANCE = {
  attendance_monthly_payroll_id: 900,
  payroll_version: 1,
  calculated_at: "2026-09-01 02:00:00.000",
  is_final: 1,
  salary_days: 13,
  extra_days: 0,
  base_days: 16,
  salary_day_earnings: 5000,
  extra_day_earnings: 0,
  shortage_minutes: 0,
  missing_minute_deduction: 0,
  approved_ot_minutes: 0,
  approved_ot_earnings: 0,
};
const ENTRY_SALARY = { salary_id: 41, monthly_gross: 10000, basic: 8000, conveyance: 0, hra: 0, special_allowance: 2000 };
const run = ({ amounts = {}, fnf_items = [], attendance = {}, snapshot = {} } = {}) => {
  const a = { ...ATTENDANCE, ...attendance };
  return calc.computeCalculation({
    snapshot: { ...SNAPSHOT, ...snapshot },
    attendance: a,
    nrm: calc.resolveEffectiveNrm([
      { nrm_minutes: 480, break_allowance_source: NRM_SOURCE.SHIFT, day_count: 13, approved_ot_minutes: a.approved_ot_minutes || 0 },
    ]),
    amounts,
    statutory: { dob: "1998-06-15", previous_eps_member: 0 },
    as_of: "2026-08-31",
    coverage_entry_salary: ENTRY_SALARY,
    fnf_items,
  });
};
const paise = (v) => Math.round(Number(v) * 100);

describe("the engine: an active employee is untouched", () => {
  it("no F&F items: the same figures and the SAME calculation hash as before the feature", () => {
    const before = run();
    // The pre-feature call shape: no `fnf_items` key at all.
    const legacy = calc.computeCalculation({
      snapshot: SNAPSHOT,
      attendance: ATTENDANCE,
      nrm: calc.resolveEffectiveNrm([{ nrm_minutes: 480, break_allowance_source: NRM_SOURCE.SHIFT, day_count: 13, approved_ot_minutes: 0 }]),
      amounts: {},
      statutory: { dob: "1998-06-15", previous_eps_member: 0 },
      as_of: "2026-08-31",
      coverage_entry_salary: ENTRY_SALARY,
    });
    assert.equal(before.net_pay, legacy.net_pay);
    assert.equal(calc.calculationHash(before), calc.calculationHash(legacy));
    assert.deepEqual(before.fnf_items, []);
    assert.equal(before.fnf_additions, 0);
    assert.equal(before.fnf_deductions, 0);
  });

  it("the inputs hash with no F&F items is the hash an existing calculation was stored with", () => {
    const amounts = { [COMPONENT.INCENTIVE]: 500 };
    assert.equal(
      calc.inputsHash({ amounts, pay_type: "BANK", prior_month_ot: [], fnf_items: [] }),
      calc.inputsHash({ amounts, pay_type: "BANK", prior_month_ot: [] })
    );
  });

  it("entering an F&F amount moves the inputs hash (the stored month becomes stale)", () => {
    const base = calc.inputsHash({ amounts: {}, pay_type: "BANK" });
    const withItem = calc.inputsHash({ amounts: {}, pay_type: "BANK", fnf_items: [{ component: FNF_COMPONENT.GRATUITY, amount: 1000 }] });
    const changed = calc.inputsHash({ amounts: {}, pay_type: "BANK", fnf_items: [{ component: FNF_COMPONENT.GRATUITY, amount: 1001 }] });
    assert.notEqual(base, withItem);
    assert.notEqual(withItem, changed);
  });
});

describe("the engine: statutory treatment is never assumed", () => {
  const { FNF_COMPONENT_BY_KEY, FNF_STATUTORY_UNRESOLVED } = require("../constants/fnf");
  it("every F&F component starts UNCONFIRMED and none is priced into a PF / ESI wage", () => {
    for (const def of Object.values(FNF_COMPONENT_BY_KEY)) {
      assert.equal(def.statutory, "UNCONFIRMED", def.key);
      assert.equal(def.pf, false);
      assert.equal(def.esi, false);
    }
  });
  it("an UNCONFIRMED component makes the calculation incomplete (cannot be approved), naming the component", () => {
    const r = run({ fnf_items: [{ component: FNF_COMPONENT.LEAVE_ENCASHMENT, amount: 1000 }] });
    assert.equal(r.is_complete, false);
    assert.deepEqual(
      r.unresolved.filter((u) => u.code === FNF_STATUTORY_UNRESOLVED).map((u) => u.component),
      [FNF_COMPONENT.LEAVE_ENCASHMENT]
    );
    // The figures are still computed and shown - only approval is held.
    assert.ok(r.net_pay !== null);
  });
  it("once the business CONFIRMS the treatment, the same calculation is complete", () => {
    const def = FNF_COMPONENT_BY_KEY[FNF_COMPONENT.LEAVE_ENCASHMENT];
    def.statutory = "CONFIRMED";
    try {
      const r = run({ fnf_items: [{ component: FNF_COMPONENT.LEAVE_ENCASHMENT, amount: 1000 }] });
      assert.equal(r.unresolved.some((u) => u.code === FNF_STATUTORY_UNRESOLVED), false);
      assert.equal(r.is_complete, true);
    } finally {
      def.statutory = "UNCONFIRMED";
    }
  });
  it("a month with no F&F item has no such question", () => {
    assert.equal(run().unresolved.some((u) => u.code === FNF_STATUTORY_UNRESOLVED), false);
  });
});

describe("the engine: F&F earnings and recoveries", () => {
  const items = [
    { component: FNF_COMPONENT.LEAVE_ENCASHMENT, amount: "1500.00" },
    { component: FNF_COMPONENT.GRATUITY, amount: 0 },
    { component: FNF_COMPONENT.NOTICE_PERIOD_RECOVERY, amount: "400.50" },
  ];

  it("additions join Total Earnings, recoveries join Total Deductions, net pay follows exactly", () => {
    const base = run();
    const r = run({ fnf_items: items });
    assert.equal(paise(r.total_earnings) - paise(base.total_earnings), 150000);
    assert.equal(paise(r.total_employee_deductions) - paise(base.total_employee_deductions), 40050);
    const exact = paise(r.total_earnings) - paise(r.total_employee_deductions);
    assert.equal(paise(r.net_pay), calc.roundToRupeePaise(exact));
    assert.equal(paise(r.net_pay) - exact, paise(r.net_pay_rounding));
  });

  it("they never touch the PF or ESI wage, nor the contributions", () => {
    const base = run();
    const r = run({ fnf_items: items });
    for (const k of ["pf_wage", "employee_pf", "employer_epf", "employer_eps", "esi_wage", "employee_esi", "employer_esi"]) {
      assert.equal(r[k], base[k], k);
    }
  });

  it("zero amounts are dropped; lines come back in catalogue order with their kind", () => {
    const r = run({ fnf_items: items });
    assert.deepEqual(r.fnf_items.map((l) => [l.component, l.kind, l.amount]), [
      [FNF_COMPONENT.LEAVE_ENCASHMENT, "ADDITION", 1500],
      [FNF_COMPONENT.NOTICE_PERIOD_RECOVERY, "DEDUCTION", 400.5],
    ]);
    assert.equal(r.fnf_additions, 1500);
    assert.equal(r.fnf_deductions, 400.5);
  });

  it("the calculation hash moves with an F&F item (a changed F&F is a changed calculation)", () => {
    assert.notEqual(calc.calculationHash(run()), calc.calculationHash(run({ fnf_items: items })));
  });

  it("an unknown component or a negative amount is an ERROR, never a zero", () => {
    const bad = run({ fnf_items: [{ component: "OTHER_DEDUCTION", amount: 10 }] });
    assert.equal(bad.is_complete, false);
    assert.ok(bad.errors.some((e) => /Unknown F&F component/.test(e)));
    const neg = run({ fnf_items: [{ component: FNF_COMPONENT.GRATUITY, amount: -5 }] });
    assert.ok(neg.errors.some((e) => /Gratuity/.test(e)));
  });

  it("an outstanding advance is recovered ONCE, through the Adjustment, alongside F&F items", () => {
    const r = run({
      amounts: { [COMPONENT.ADVANCE_RECOVERY]: 3000, [COMPONENT.BALANCE_ADVANCE]: 0 },
      fnf_items: [{ component: FNF_COMPONENT.NOTICE_PERIOD_RECOVERY, amount: 500 }],
    });
    const base = run();
    assert.equal(r.advance_recovery, 3000);
    assert.equal(paise(r.total_employee_deductions) - paise(base.total_employee_deductions), 350000);
  });

  it("recoveries larger than earnings give a NEGATIVE net pay (recoverable), rounded half away from zero", () => {
    const r = run({
      attendance: { salary_days: 1, salary_day_earnings: 384.62 },
      amounts: { [COMPONENT.ADVANCE_RECOVERY]: 5000 },
      fnf_items: [{ component: FNF_COMPONENT.NOTICE_PERIOD_RECOVERY, amount: "1000.40" }],
    });
    assert.ok(r.net_pay < 0, String(r.net_pay));
    assert.equal(Math.abs(paise(r.net_pay) % 100), 0);
  });

  it("recoveries exactly equal to earnings give a ZERO net pay", () => {
    const base = run();
    const r = run({ fnf_items: [{ component: FNF_COMPONENT.NOTICE_PERIOD_RECOVERY, amount: (paise(base.net_pay) + paise(base.net_pay_rounding) * -1) / 100 }] });
    assert.equal(r.net_pay, 0);
  });

  it("approved OT counts on an exit month like any other; rejected (unapproved) OT never does", () => {
    const withOt = run({ attendance: { approved_ot_minutes: 120 } });
    const without = run({ attendance: { approved_ot_minutes: 0 } });
    assert.ok(paise(withOt.ot_amount) > 0);
    assert.equal(paise(without.ot_amount), 0);
  });
});

/* ======================================================== the snapshot */

const PERIOD = { year: 2026, month: 8 };
const EMPLOYEE = {
  payrun_employee_id: 77,
  employee_id: 2095,
  employee_name: "PREETHA .S",
  store_name: "Ecr",
  designation_name: "Customer Service Associate",
  date_of_joining: "2026-02-02",
  resignation_date: "2026-08-16",
  monthly_gross: "10000.00",
  basic: "8000.00",
  hra: "0.00",
  conveyance: "0.00",
  special_allowance: "2000.00",
  uan: null,
  pay_type: "BANK",
};
// The reference statement: 3,999 + 1,000 + 32.21 OT = 5,031.21 -> 5,031.
const STORED = (over = {}) => ({
  payrun_calculation_id: 9001,
  payrun_employee_id: 77,
  employee_id: 2095,
  monthly_gross: "10000.00",
  daily_rate: "384.62",
  salary_days: 13,
  ncp_days: 3,
  salary_earnings: "4999.00",
  missing_hours_minutes: 0,
  missing_hours_deduction: "0.00",
  extra_days: 0,
  extra_day_amount: "0.00",
  approved_ot_hours: "0.4000",
  ot_hourly_rate: "48.08",
  ot_amount: "32.21",
  effective_nrm_minutes: 480,
  incentive: "0.00",
  bonus: "0.00",
  arrears: "0.00",
  advance_recovery: "0.00",
  shortage_recovery: "0.00",
  balance_advance: "0.00",
  pf_applicable: 0,
  esi_applicable: 0,
  total_earnings: "5031.21",
  total_employee_deductions: "0.00",
  net_pay: "5031.00",
  net_pay_rounding: "-0.21",
  pay_type: "BANK",
  calculation_version: 4,
  calculation_revision: 1,
  calculation_hash: "b".repeat(32),
  approved_at: "2026-09-05 10:00:00",
  ...over,
});
const EXTRAS = { account_no: "7895383811", bank_name: "INDIAN BANK", department_name: "Front Office" };
const COMPANY = {
  name: "DAILY NEEDS DEPARTMENT STORE",
  address: "25 & 26, 45ft Road, Vallalar Salai Puducherry, 605011",
  source: "company_details:1",
};
const build = (calcOver = {}, empOver = {}) =>
  snap.buildPayslipSnapshot({
    period: PERIOD,
    calculation: STORED(calcOver),
    employee: { ...EMPLOYEE, ...empOver },
    extras: EXTRAS,
    company: COMPANY,
  });

describe("the snapshot: which document", () => {
  it("an exit month is a FULL & FINAL document, frozen for the F&F renderer", () => {
    const s = build();
    assert.equal(s.document_type, DOCUMENT_TYPE.FNF);
    assert.equal(s.template_version, FNF_TEMPLATE_VERSION);
    assert.equal(s.fnf.last_working_day, "2026-08-16");
    assert.equal(s.fnf.lop_days, 3);
    assert.equal(s.fnf.actual_working_days, 13);
    assert.equal(s.fnf.net_payable_words, "Five Thousand Thirty One Rupees Only");
    assert.equal(s.fnf.recoverable, false);
    assert.equal(s.final.net_pay, "5031.00");
  });

  it("an active employee's month is still a Salary Payslip, with no F&F block", () => {
    const s = build({}, { resignation_date: null });
    assert.equal(s.document_type, DOCUMENT_TYPE.PAYSLIP);
    assert.equal(s.template_version, TEMPLATE_VERSION);
    assert.equal(s.fnf, null);
    assert.equal(snap.payslipFilename(s), "Payslip_Aug-2026_2095_PREETHA-S.pdf");
  });

  it("an employee who exits NEXT month is paid an ordinary payslip this month", () => {
    assert.equal(build({}, { resignation_date: "2026-09-03" }).document_type, DOCUMENT_TYPE.PAYSLIP);
  });

  it("the F&F filename says so", () => {
    assert.equal(snap.payslipFilename(build()), "FnF_Settlement_Aug-2026_2095_PREETHA-S.pdf");
  });

  it("the Actual column is the full-month structure, beside the earned amount", () => {
    const s = build();
    assert.equal(s.fnf.actual.basic, "8000.00");
    assert.equal(s.fnf.actual.special_allowance, "2000.00");
    assert.equal(s.fnf.actual_monthly_gross, "10000.00");
  });
});

describe("the snapshot: F&F lines", () => {
  const items = JSON.stringify([
    { component: "LEAVE_ENCASHMENT", label: "Leave Encashment", kind: "ADDITION", amount: 1500 },
    { component: "NOTICE_PERIOD_RECOVERY", label: "Notice Period Recovery", kind: "DEDUCTION", amount: 400.5 },
  ]);
  const withItems = (over = {}) =>
    build({
      fnf_items: items,
      fnf_additions: "1500.00",
      fnf_deductions: "400.50",
      total_earnings: "6531.21",
      total_employee_deductions: "400.50",
      net_pay: "6131.00",
      net_pay_rounding: "0.29",
      ...over,
    });

  it("print one line each, inside the stored totals", () => {
    const s = withItems();
    assert.ok(s.earnings.lines.some((l) => l.key === "fnf_leave_encashment" && l.amount === "1500.00"));
    assert.ok(s.deductions.lines.some((l) => l.key === "fnf_notice_period_recovery" && l.amount === "400.50"));
    assert.equal(s.earnings.total, "6531.21");
    assert.equal(s.fnf.additions_total, "1500.00");
  });

  it("a stored F&F total that does not match its items is REFUSED, never published", () => {
    assert.throws(() => withItems({ fnf_additions: "1499.00" }), /F&F earnings/);
    assert.throws(() => withItems({ fnf_deductions: "0.00" }), /F&F recoveries/);
  });

  it("a negative Net Pay is printed as RECOVERABLE from the employee", () => {
    const s = build({
      advance_recovery: "6000.00",
      total_employee_deductions: "6000.00",
      // 5031.21 - 6000 = -968.79 -> -969 (half away from zero), rounding -0.21
      net_pay: "-969.00",
      net_pay_rounding: "-0.21",
    });
    assert.equal(s.fnf.recoverable, true);
    assert.equal(s.fnf.net_payable_label, "Total Recoverable from Employee");
    assert.equal(s.fnf.net_payable_words, "Nine Hundred Sixty Nine Rupees Only");
    // The advance block still tells the employee what was recovered.
    assert.equal(s.advance.recovery_this_month, "6000.00");
  });

  it("a zero Net Pay is a valid F&F", () => {
    const s = build({ shortage_recovery: "5031.21", total_employee_deductions: "5031.21", net_pay: "0.00", net_pay_rounding: "0.00" });
    assert.equal(s.final.net_pay, "0.00");
    assert.equal(s.fnf.net_payable_words, "Zero Rupees Only");
  });
});

describe("confidential HR assessments never reach an employee document", () => {
  it("no interview answer, rehire assessment or settlement-internal field can be in a snapshot", () => {
    const s = build({}, {
      // Even if a caller handed them over on the employee row, nothing copies them.
      rehire_eligibility: "NO",
      primary_reason: "MANAGER_RELATIONSHIP",
      feedback: "confidential",
    });
    const text = JSON.stringify(s);
    for (const forbidden of ["rehire", "eligibility", "primary_reason", "feedback", "suggestions", "confidential", "would_return", "interview"]) {
      assert.equal(text.toLowerCase().includes(forbidden), false, forbidden);
    }
  });
});

describe("the F&F PDF", () => {
  const html = pdf.payslipHtml(build(), { logo: null });

  it("is the Full & Final statement, not a Salary Payslip", () => {
    assert.match(html, /Full &amp; Final Settlement/);
    assert.match(html, /Employee Pay Summary/);
    assert.match(html, /Declaration By the Receiver/);
    assert.doesNotMatch(html, /Salary Payslip/);
  });

  it("prints the snapshot's own figures and words", () => {
    assert.match(html, /5,031\.00/);
    assert.match(html, /5,031\.21/);
    assert.match(html, /Five Thousand Thirty One Rupees Only/);
    assert.match(html, /2026-08-16/);
    assert.match(html, /INDIAN BANK/);
    assert.match(html, /XXXXXX3811/);
    assert.doesNotMatch(html, /7895383811/, "the full account number is never printed");
  });

  it("escapes database text", () => {
    const h = pdf.payslipHtml(build({}, { employee_name: "<script>x</script>" }), { logo: null });
    assert.doesNotMatch(h, /<script>x/);
  });

  it("an ordinary month still renders the Salary Payslip", () => {
    const h = pdf.payslipHtml(build({}, { resignation_date: null }), { logo: null });
    assert.match(h, /Salary Payslip/);
    assert.doesNotMatch(h, /Declaration By the Receiver/);
  });
});

describe("the Telegram text", () => {
  it("names the F&F statement and carries no figure", () => {
    const t = notificationText(2026, 8, "FNF");
    assert.equal(t, "Your Full & Final Settlement statement for August 2026 is now available in My Payslips.");
    assert.doesNotMatch(t, /₹|\d+\.\d\d/);
  });
  it("is unchanged for a payslip", () => {
    assert.equal(notificationText(2026, 8), "Your payslip for August 2026 is now available in My Payslips.");
    assert.equal(notificationText(2026, 8, "PAYSLIP"), "Your payslip for August 2026 is now available in My Payslips.");
  });
});
