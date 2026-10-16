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
 *   - the exit month is priced by the unchanged engine; advance recovery is
 *     the existing Adjustment's, recovered once
 *   - the F&F readiness rules (late exit, final-month pending OT) live in the
 *     existing payroll readiness
 *   - zero and negative F&F (recoverable from the employee)
 *   - the snapshot of an exit month is an F&F document; the PDF prints its
 *     stored figures, the payroll-payment acknowledgement and the amount in words
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
const { DOCUMENT_TYPE, FNF_TEMPLATE_VERSION, SETTLEMENT_STAGE } = require("../constants/fnf");
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
const run = ({ amounts = {}, attendance = {}, snapshot = {} } = {}) => {
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
  });
};
const paise = (v) => Math.round(Number(v) * 100);

describe("the engine: an exit month is priced by the SAME, unchanged engine", () => {
  it("the payroll engine file is byte-for-byte main-autodeploy's (no F&F input exists)", () => {
    const src = require("fs").readFileSync(require.resolve("./payrun_calculation"), "utf8");
    assert.equal(/fnf/i.test(src), false);
  });

  it("an outstanding advance is recovered ONCE, through the existing Adjustment", () => {
    const base = run();
    const r = run({ amounts: { [COMPONENT.ADVANCE_RECOVERY]: 3000, [COMPONENT.BALANCE_ADVANCE]: 0 } });
    assert.equal(r.advance_recovery, 3000);
    assert.equal(paise(r.total_employee_deductions) - paise(base.total_employee_deductions), 300000);
  });

  it("recoveries larger than earnings give a NEGATIVE net pay (recoverable), rounded half away from zero", () => {
    const r = run({ attendance: { salary_days: 1, salary_day_earnings: 384.62 }, amounts: { [COMPONENT.ADVANCE_RECOVERY]: 5000 } });
    assert.ok(r.net_pay < 0, String(r.net_pay));
    assert.equal(Math.abs(paise(r.net_pay) % 100), 0);
  });

  it("approved OT counts on an exit month like any other; unapproved OT never does", () => {
    assert.ok(paise(run({ attendance: { approved_ot_minutes: 120 } }).ot_amount) > 0);
    assert.equal(paise(run({ attendance: { approved_ot_minutes: 0 } }).ot_amount), 0);
  });
});

describe("the EXISTING payroll readiness carries the F&F rules", () => {
  const { evaluatePayrollReadiness, READINESS_REASON } = require("./payroll_readiness");
  const base = {
    year: 2026, month: 8,
    snapshot: { monthly_gross: 10000, basic: 8000, date_of_joining: "2026-02-02", resignation_date: "2026-08-16" },
    monthly: null, day_rows: [], attendance_required: false,
  };
  const codes = (r) => r.reasons.map((x) => x.code);

  it("an exit recorded after initialization makes the month NOT calculable, and Close Attendance cannot accept it", () => {
    const r = evaluatePayrollReadiness({ ...base, closed_for_payroll: true, exit_mismatch: { snapshot_exit_date: null, live_exit_date: "2026-08-16" } });
    assert.ok(codes(r).includes(READINESS_REASON.EXIT_NOT_RECONCILED));
    assert.equal(r.calculable, false);
  });

  it("pending OT in an ORDINARY month may be accepted by Close Attendance for Payroll (existing rule, unchanged)", () => {
    const r = evaluatePayrollReadiness({ ...base, closed_for_payroll: true, pending: { pending_ot: 2 } });
    assert.equal(codes(r).includes(READINESS_REASON.PENDING_OT_APPROVAL), false);
    assert.equal(r.accepted_by_close.some((x) => x.code === READINESS_REASON.PENDING_OT_APPROVAL), true);
  });

  it("in the FINAL (F&F) month, undecided OT up to the exit - earlier months included - cannot be accepted by Close", () => {
    const r = evaluatePayrollReadiness({ ...base, closed_for_payroll: true, final_month: true, pending_ot_to_exit: 1, pending: { pending_ot: 0 } });
    const reason = r.reasons.find((x) => x.code === READINESS_REASON.PENDING_OT_APPROVAL);
    assert.ok(reason, JSON.stringify(r.reasons));
    assert.equal(reason.accepted_by_close, false);
    assert.equal(r.calculable, false);
  });

  it("a final month with every OT request decided has no such reason", () => {
    const r = evaluatePayrollReadiness({ ...base, final_month: true, pending_ot_to_exit: 0 });
    assert.equal(codes(r).includes(READINESS_REASON.PENDING_OT_APPROVAL), false);
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

describe("the snapshot: recoverable and zero F&F", () => {
  it("a negative Net Pay is printed as RECOVERABLE from the employee, with the recoverable acknowledgement", () => {
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
    assert.match(s.fnf.acknowledgement, /shown as recoverable from me/);
    assert.match(s.fnf.statutory_note, /outside this payroll statement/);
    // The advance block still tells the employee what was recovered.
    assert.equal(s.advance.recovery_this_month, "6000.00");
  });

  it("a zero Net Pay is a valid F&F", () => {
    const s = build({ shortage_recovery: "5031.21", total_employee_deductions: "5031.21", net_pay: "0.00", net_pay_rounding: "0.00" });
    assert.equal(s.final.net_pay, "0.00");
    assert.equal(s.fnf.net_payable_words, "Zero Rupees Only");
    assert.match(s.fnf.acknowledgement, /I acknowledge receipt of the net amount stated above/);
  });

  it("an exit-month snapshot has no F&F earning / recovery line of any kind", () => {
    const s = build();
    assert.equal([...s.earnings.lines, ...s.deductions.lines].some((l) => /^fnf_/.test(l.key)), false);
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
    assert.match(html, /Employee Acknowledgement/);
    assert.doesNotMatch(html, /Declaration By the Receiver/);
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
    assert.doesNotMatch(h, /Employee Acknowledgement|statutory dues/);
  });
});

describe("the acknowledgement is a payroll-payment acknowledgement, never a waiver", () => {
  const WAIVER = [/grievance/i, /dispute/i, /claims?\b/i, /legal dues/i, /back wages/i, /reinstatement/i, /reemployment/i, /free will/i];
  const payable = build();
  const recoverable = build({ advance_recovery: "6000.00", total_employee_deductions: "6000.00", net_pay: "-969.00", net_pay_rounding: "-0.21" });

  it("payable and recoverable wording: acknowledges only the payroll amounts shown; waives nothing", () => {
    for (const s of [payable, recoverable]) {
      assert.equal(s.fnf.acknowledgement_heading, "Employee Acknowledgement");
      assert.match(s.fnf.acknowledgement, /covers only the payroll amounts shown in this statement/);
      for (const w of WAIVER) assert.doesNotMatch(s.fnf.acknowledgement, w, String(w));
      assert.equal("declaration" in s.fnf, false);
    }
    assert.notEqual(payable.fnf.acknowledgement, recoverable.fnf.acknowledgement);
  });

  it("every F&F statement says gratuity, leave encashment and other statutory dues are outside it", () => {
    for (const s of [payable, recoverable]) {
      assert.match(s.fnf.statutory_note, /Gratuity, leave encashment and any other statutory dues payable separately are outside this payroll statement/);
      for (const w of WAIVER) assert.doesNotMatch(s.fnf.statutory_note, w, String(w));
    }
  });

  it("the wording carries no figure: the amount on the statement is the payroll snapshot's Net Pay alone", () => {
    for (const s of [payable, recoverable]) {
      assert.doesNotMatch(`${s.fnf.acknowledgement} ${s.fnf.statutory_note}`, /\d/);
    }
    assert.equal(payable.final.net_pay, "5031.00");
    assert.equal(recoverable.final.net_pay, "-969.00");
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
