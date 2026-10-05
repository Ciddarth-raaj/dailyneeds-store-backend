/**
 * THE PAYSLIP SNAPSHOT - pure rules.
 *
 *   node --test utils/payslip_snapshot.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const s = require("./payslip_snapshot");
const { TEMPLATE_VERSION, SNAPSHOT_SCHEMA_VERSION } = require("../constants/payslip");

const PERIOD = { year: 2026, month: 9 };
const EMPLOYEE = {
  payrun_employee_id: 501,
  employee_id: 101,
  employee_name: "C. Saravanan",
  store_name: "Moolakulam",
  designation_name: "Billing Assistant",
  date_of_joining: "2018-04-01",
  basic: "13006.69",
  hra: "5000.00",
  conveyance: "2500.00",
  special_allowance: "5506.68",
  uan: "100200300400",
  pf_number: "TN/MAS/1/101",
  esi_number: "3100000000",
  pay_type: "BANK",
};
// A stored calculation as MySQL hands it over: DECIMALs as strings.
const STORED = () => ({
  payrun_calculation_id: 9001,
  payrun_employee_id: 501,
  employee_id: 101,
  monthly_gross: "26013.37",
  daily_rate: "1000.51",
  salary_days: 26,
  salary_earnings: "26013.26",
  missing_hours_minutes: 90,
  missing_hours_deduction: "187.60",
  extra_days: 1,
  extra_day_amount: "1000.51",
  approved_ot_hours: "2.5000",
  ot_hourly_rate: "125.06",
  ot_amount: "312.65",
  ot_groups: JSON.stringify([{ nrm_minutes: 480, approved_ot_minutes: 150, approved_ot_hours: 2.5, ot_hourly_rate: "125.06", ot_amount: "312.65" }]),
  effective_nrm_minutes: 480,
  incentive: "500.00",
  bonus: "0.00",
  arrears: "0.00",
  advance_recovery: "1000.00",
  shortage_recovery: "50.00",
  balance_advance: "3000.00",
  pf_applicable: 1,
  esi_applicable: 1,
  pf_wage: "13006.19",
  employee_pf: "1560.74",
  employer_pf_total: "1560.74",
  esi_wage: "25825.66",
  employee_esi: "193.69",
  employer_esi: "839.33",
  // 26013.26 + 1000.51 + 312.65 + 500 = 27826.42
  total_earnings: "27826.42",
  // 187.60 + 1560.74 + 193.69 + 1000 + 50 = 2992.03
  total_employee_deductions: "2992.03",
  // 24834.39 -> 24834.00, rounding -0.39
  net_pay: "24834.00",
  net_pay_rounding: "-0.39",
  pay_type: "BANK",
  calculation_version: 2,
  calculation_revision: 3,
  calculation_hash: "a".repeat(32),
  approved_at: "2026-10-02 10:00:00",
});
const EXTRAS = { account_no: "1234 5678 9012", pan_no: "abcde1234f", bank_name: "State Bank", department_name: "Grocery" };
const COMPANY = {
  name: "Daily Needs Departmental Store", address: "188/1, Iyyanar Koil Street", pf_establishment_code: "TN/MAS/0012345",
  esi_establishment_code: "51000123450001001", source: "company_details:1",
};
const build = (over = {}, company = COMPANY) =>
  s.buildPayslipSnapshot({ period: PERIOD, calculation: { ...STORED(), ...over }, employee: EMPLOYEE, extras: EXTRAS, company });

const sumPaise = (lines) => lines.reduce((t, l) => t + s.toPaise(l.amount), 0);

describe("the snapshot copies the stored approved calculation", () => {
  it("final Net Pay is the stored rounded figure, with the stored rounding and the exact pre-rounding figure", () => {
    const snap = build();
    assert.equal(snap.final.net_pay, "24834.00");
    assert.equal(snap.final.net_pay_rounding, "-0.39");
    assert.equal(snap.final.net_pay_before_rounding, "24834.39");
  });

  it("earnings lines add up to the stored Total Earnings exactly, in paise", () => {
    const snap = build();
    assert.equal(sumPaise(snap.earnings.lines), s.toPaise(STORED().total_earnings));
    assert.equal(snap.earnings.total, "27826.42");
  });

  it("Basic / HRA / Conveyance / Special add up to the stored Salary Earnings exactly", () => {
    const snap = build();
    const comps = snap.earnings.lines.filter((l) => ["basic", "hra", "conveyance", "special_allowance"].includes(l.key));
    assert.equal(comps.length, 4);
    assert.equal(sumPaise(comps), s.toPaise("26013.26"));
    assert.equal(snap.earnings.component_basis, "WHOLE_RUPEE_COMPONENTS_BALANCED");
    assert.equal(snap.earnings.balancing_component, "special_allowance");
  });

  it("deductions lines add up to the stored Total Deductions exactly", () => {
    const snap = build();
    assert.equal(sumPaise(snap.deductions.lines), s.toPaise("2992.03"));
    assert.deepEqual(snap.deductions.lines.map((l) => l.key), [
      "missing_hours_deduction", "employee_pf", "employee_esi", "advance_recovery", "shortage_recovery",
    ]);
  });

  it("attendance basis is copied, not derived", () => {
    const snap = build();
    assert.equal(snap.attendance.salary_days, 26);
    assert.equal(snap.attendance.daily_rate, "1000.51");
    assert.equal(snap.attendance.approved_ot_hours, 2.5);
    assert.equal(snap.attendance.ot_hourly_rate, "125.06");
    assert.equal(snap.attendance.ot_amount, "312.65");
    assert.equal(snap.attendance.extra_days, 1);
    assert.equal(snap.attendance.missing_hours, 1.5);
    assert.equal(snap.attendance.nrm_hours, 8);
  });

  it("records the calculation it was frozen from, and the template / schema version", () => {
    const snap = build();
    assert.deepEqual(snap.source, {
      payrun_employee_id: 501, payrun_calculation_id: 9001, calculation_version: 2,
      calculation_revision: 3, calculation_hash: "a".repeat(32), approved_at: "2026-10-02 10:00:00",
    });
    assert.equal(snap.template_version, TEMPLATE_VERSION);
    assert.equal(snap.schema_version, SNAPSHOT_SCHEMA_VERSION);
  });

  it("a structure with no components falls back to one Salary Earnings line, still exact", () => {
    const snap = s.buildPayslipSnapshot({
      period: PERIOD, calculation: STORED(), employee: { ...EMPLOYEE, basic: null }, extras: EXTRAS, company: COMPANY,
    });
    assert.equal(snap.earnings.lines[0].key, "salary_earnings");
    assert.equal(sumPaise(snap.earnings.lines), s.toPaise("27826.42"));
  });
});

describe("a snapshot that does not add up is REFUSED, never published", () => {
  it("earnings mismatch", () => {
    assert.throws(() => build({ total_earnings: "27826.43" }), (e) => e.code === "SNAPSHOT_EARNINGS_MISMATCH");
  });
  it("deductions mismatch", () => {
    assert.throws(() => build({ employee_pf: "1560.75" }), (e) => e.code === "SNAPSHOT_DEDUCTIONS_MISMATCH");
  });
  it("net pay mismatch (rounding must reconcile to the paisa)", () => {
    assert.throws(() => build({ net_pay_rounding: "-0.38" }), (e) => e.code === "SNAPSHOT_NET_PAY_MISMATCH");
  });
  it("no salary earnings", () => {
    assert.throws(() => build({ salary_earnings: null }), (e) => e.code === "SNAPSHOT_INCOMPLETE");
  });
  it("a calculation for another employee", () => {
    assert.throws(() => build({ employee_id: 102 }), (e) => e.code === "SNAPSHOT_EMPLOYEE_MISMATCH");
  });
});

describe("sensitive identifiers", () => {
  it("bank account: last 4 only; PAN: last 4 only; the full values appear nowhere in the frozen text", () => {
    const snap = build();
    assert.equal(snap.employee.bank_account_masked, "XXXXXX9012");
    assert.equal(snap.employee.pan_masked, "XXXXXX234F");
    const { text } = s.freezeSnapshot(snap);
    assert.ok(!text.includes("123456789012"));
    assert.ok(!text.includes("1234 5678 9012"));
    assert.ok(!text.toUpperCase().includes("ABCDE1234F"));
  });

  it("a CASH employee carries no bank details", () => {
    const snap = s.buildPayslipSnapshot({
      period: PERIOD, calculation: { ...STORED(), pay_type: "CASH" }, employee: EMPLOYEE, extras: EXTRAS, company: COMPANY,
    });
    assert.equal(snap.employee.bank_account_masked, null);
    assert.equal(snap.employee.bank_name, null);
  });

  it("UAN / ESI only where applicable; employer contributions are not on the employee payslip", () => {
    const snap = build({ esi_applicable: 0 });
    assert.equal(snap.statutory.uan_masked, "XXXXXXXX0400");
    assert.equal(snap.statutory.pf_number_masked, "XXXXXXXX/101");
    assert.equal(snap.statutory.esi_number_masked, null);
    const both = build();
    assert.equal(both.statutory.esi_number_masked, "XXXXXX0000");
    const { text: frozen } = s.freezeSnapshot(both);
    assert.ok(!frozen.includes("100200300400"), "full UAN never stored on the payslip");
    assert.ok(!frozen.includes("3100000000"), "full ESI number never stored on the payslip");
    assert.ok(!frozen.includes("TN/MAS/1/101"), "full PF number never stored on the payslip");
    const { text } = s.freezeSnapshot(build());
    assert.ok(!text.includes("employer"), "no employer_* key");
    assert.ok(!text.includes("839.33"), "no employer ESI figure");
  });

  it("masking helpers", () => {
    assert.equal(s.maskAccount("12"), "XXXX");
    assert.equal(s.maskAccount(""), null);
    assert.equal(s.maskPan(null), null);
  });
});

describe("freezing, integrity and the filename", () => {
  it("the frozen text is deterministic and its SHA-256 matches its contents", () => {
    const a = s.freezeSnapshot(build());
    const b = s.freezeSnapshot(build());
    assert.equal(a.text, b.text);
    assert.equal(a.sha256, b.sha256);
    assert.equal(a.sha256, require("crypto").createHash("sha256").update(a.text).digest("hex"));
    assert.deepEqual(s.readFrozenSnapshot(a.text, a.sha256), JSON.parse(a.text));
  });

  it("a tampered snapshot fails its integrity check and is not shown", () => {
    const a = s.freezeSnapshot(build());
    const tampered = a.text.replace('"24834.00"', '"94834.00"');
    assert.throws(() => s.readFrozenSnapshot(tampered, a.sha256), (e) => e.code === "SNAPSHOT_INTEGRITY");
  });

  it("filename: Payslip_Sep-2026_101_C-Saravanan.pdf, and nothing unsafe survives", () => {
    assert.equal(s.payslipFilename(build()), "Payslip_Sep-2026_101_C-Saravanan.pdf");
    const hostile = { period: PERIOD, employee: { employee_id: 7, employee_name: '../../etc/"passwd"\r\n;<x>' } };
    const name = s.payslipFilename(hostile);
    assert.match(name, /^[A-Za-z0-9_.-]+$/);
    assert.equal(name, "Payslip_Sep-2026_7_etc-passwd-x.pdf");
  });

  it("splitByWeights allocates whole paise and never loses one", () => {
    for (const total of [0, 1, 99, 2601326, 333333]) {
      const parts = s.splitByWeights(total, [1300669, 500000, 250000, 550668]);
      assert.equal(parts.reduce((x, y) => x + y, 0), total);
    }
  });
});

describe("SALARY COMPONENTS: whole rupees, one balancing component, exact total", () => {
  const comps = (snap) =>
    Object.fromEntries(snap.earnings.lines
      .filter((l) => ["basic", "hra", "conveyance", "special_allowance"].includes(l.key))
      .map((l) => [l.key, l.amount]));

  it("the sample month: HRA 5000.00 and Conveyance 2500.00 - not 4999.98 / 2499.99 - and Special Allowance carries the paise", () => {
    assert.deepEqual(comps(build()), {
      basic: "13007.00", hra: "5000.00", conveyance: "2500.00", special_allowance: "5506.26",
    });
  });

  it("the four always sum to the stored Salary Earnings exactly; Total Earnings and Net Pay are the stored figures", () => {
    // A spread of attendance: every salary-earnings figure from 0 to a full month in odd paise steps.
    for (let p = 0; p <= 2601326; p += 77777) {
      const se = s.money(p);
      const total = s.money(p + 100051 + 31265 + 50000);
      const net = s.money(p + 100051 + 31265 + 50000 - 299203);
      const snap = build({ salary_earnings: se, total_earnings: total, net_pay: net, net_pay_rounding: "0.00" });
      const sum = snap.earnings.lines
        .filter((l) => ["basic", "hra", "conveyance", "special_allowance"].includes(l.key))
        .reduce((t, l) => t + s.toPaise(l.amount), 0);
      assert.equal(sum, p, `salary earnings ${se}`);
      assert.equal(snap.earnings.total, total);
      assert.equal(snap.final.net_pay, net);
      for (const k of ["basic", "hra", "conveyance"]) {
        assert.equal(s.toPaise(comps(snap)[k]) % 100, 0, `${k} is whole rupees at ${se}`);
      }
    }
  });

  it("deterministic: the same stored figures always give the same lines", () => {
    assert.equal(s.freezeSnapshot(build()).text, s.freezeSnapshot(build()).text);
  });

  it("no Special Allowance in the structure: the last component with a value balances", () => {
    const r = s.balancedComponents(1000037, [600000, 400000, 0, 0]);
    assert.deepEqual(r.parts, [600000, 400037, 0, 0]);
    assert.equal(r.balancing, 1);
  });

  it("a balancing component that would go negative falls back to the exact paise split, still exact", () => {
    const r = s.balancedComponents(1060, [1000, 1000, 1000, 1]);
    assert.equal(r.basis, "SALARY_EARNINGS_EXACT_PAISE_SPLIT");
    assert.equal(r.parts.reduce((a, b) => a + b, 0), 1060);
    assert.ok(r.parts.every((x) => x >= 0));
  });

  it("PF / ESI figures are copied, never re-derived from the presentation split", () => {
    const snap = build();
    assert.equal(snap.statutory.pf_wage, "13006.19");
    assert.equal(snap.deductions.lines.find((l) => l.key === "employee_pf").amount, "1560.74");
    assert.equal(snap.deductions.lines.find((l) => l.key === "employee_esi").amount, "193.69");
  });
});

describe("company details", () => {
  it("are frozen into the snapshot exactly as resolved at Publish", () => {
    assert.deepEqual(build().company, COMPANY);
  });
  it("a payslip without a company is refused, not published with a made-up name", () => {
    assert.throws(() => build({}, {}), (e) => e.code === "SNAPSHOT_COMPANY_MISSING");
  });
});

describe("the establishment code is required only where it applies", () => {
  it("PF applicable without a PF code is refused; without PF it is not needed", () => {
    assert.throws(() => build({}, { ...COMPANY, pf_establishment_code: null }), (e) => e.code === "SNAPSHOT_COMPANY_PF_CODE_MISSING");
    assert.doesNotThrow(() => build({ pf_applicable: 0 }, { ...COMPANY, pf_establishment_code: null }));
  });

  it("ESI applicable without an ESI code is refused; without ESI it is not needed", () => {
    assert.throws(() => build({}, { ...COMPANY, esi_establishment_code: "" }), (e) => e.code === "SNAPSHOT_COMPANY_ESI_CODE_MISSING");
    assert.doesNotThrow(() => build({ esi_applicable: 0 }, { ...COMPANY, esi_establishment_code: "" }));
  });
});
