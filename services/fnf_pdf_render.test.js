/**
 * THE F&F STATEMENT, RENDERED FOR REAL - the production path end to end:
 * buildPayslipSnapshot -> freeze -> integrity-checked read -> renderPayslipPdf
 * (puppeteer through services/pdf_browser.js) -> the PDF bytes, then read back
 * with poppler's `pdfinfo` / `pdftotext`.
 *
 *   CHROME_PATH=/path/to/chrome node --test services/fnf_pdf_render.test.js
 *
 * SKIPPED unless a Chrome the renderer can launch AND `pdftotext` exist.
 *
 * What it proves: one A4 page; every amount printed is the snapshot's own and
 * the printed lines reconcile to the printed totals; the amount in words; the
 * Employee Declaration of receipt (printed unsigned, with signature and date
 * fields) and the signature blocks; the separate recoverable acknowledgement
 * for a negative F&F;
 * and that no confidential HR word and no full account number reaches the
 * document.
 */
const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const snap = require("../utils/payslip_snapshot");
const { renderPayslipPdf } = require("./payslip_pdf");
const { resolveChromeExecutable } = require("./pdf_browser");

const chrome = resolveChromeExecutable();
const hasChrome = Boolean(chrome.executablePath && fs.existsSync(chrome.executablePath));
let hasPoppler = false;
try {
  execFileSync("pdftotext", ["-v"], { stdio: "ignore" });
  hasPoppler = true;
} catch (err) {
  hasPoppler = false;
}
const skip = !(hasChrome && hasPoppler) && "needs a launchable Chrome (CHROME_PATH) and poppler's pdftotext";

const EMP = {
  payrun_employee_id: 77, employee_id: 2095, employee_name: "PREETHA .S", store_name: "Ecr",
  designation_name: "Customer Service Associate", date_of_joining: "2026-02-02", resignation_date: "2026-08-16",
  monthly_gross: "10000.00", basic: "8000.00", hra: "0.00", conveyance: "0.00", special_allowance: "2000.00",
  uan: "100200300400", pf_number: "PY/PDY/1/2095", esi_number: "3100000000", pay_type: "BANK",
  // Even if a caller put them on the row, nothing may print them.
  rehire_eligibility: "NO", feedback: "confidential remark",
};
const BASE = {
  payrun_calculation_id: 9001, payrun_employee_id: 77, employee_id: 2095, monthly_gross: "10000.00", daily_rate: "384.62",
  salary_days: 13, ncp_days: 3, salary_earnings: "4999.00", missing_hours_minutes: 0, missing_hours_deduction: "1.44",
  extra_days: 0, extra_day_amount: "0.00", approved_ot_hours: "0.4000", ot_hourly_rate: "48.08", ot_amount: "32.21",
  effective_nrm_minutes: 480, incentive: "0.00", bonus: "0.00", arrears: "0.00", advance_recovery: "0.00",
  shortage_recovery: "0.00", balance_advance: "0.00", pf_applicable: 0, esi_applicable: 0,
  total_earnings: "5031.21", total_employee_deductions: "1.44", net_pay: "5030.00", net_pay_rounding: "0.23",
  pay_type: "BANK", calculation_version: 4, calculation_revision: 1, calculation_hash: "b".repeat(32),
  approved_at: "2026-09-05 10:00:00",
};
const COMPANY = {
  name: "DAILY NEEDS DEPARTMENT STORE", address: "25 & 26, 45ft Road, Vallalar Salai Puducherry, 605011",
  source: "company_details:1", pf_establishment_code: "PY/PDY/0012345", esi_establishment_code: "51000123450001001",
};
const EXTRAS = { account_no: "7895383811", bank_name: "INDIAN BANK", department_name: "Front Office" };

const FULL = {
  pf_applicable: 1, esi_applicable: 1, pf_wage: "4999.00", employee_pf: "599.88", employer_pf_total: "599.88",
  employer_epf: "183.47", employer_eps: "416.41", edli: "25.00", pf_admin_charge: "25.00", 
  employee_esi: "37.74", employer_esi: "163.52", advance_recovery: "1000.00", shortage_recovery: "250.00",
  prior_month_ot_amount: "96.16",
  prior_month_ot: JSON.stringify([{ attendance_approval_request_id: 5, attendance_date: "2026-08-12", source_year: 2026, source_month: 8, approved_ot_minutes: 120, ot_hourly_rate: "48.08", amount: "96.16" }]),
  esi_wage: "5127.37",
  total_earnings: "5127.37", total_employee_deductions: "1889.06", net_pay: "3238.00", net_pay_rounding: "-0.31",
};
const NEGATIVE = { advance_recovery: "6000.00", total_employee_deductions: "6001.44", net_pay: "-970.00", net_pay_rounding: "0.23" };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dnds-fnf-pdf-"));
async function render(name, calc) {
  const built = snap.buildPayslipSnapshot({
    period: { year: 2026, month: 8 }, calculation: { ...BASE, ...calc }, employee: EMP, extras: EXTRAS, company: COMPANY,
  });
  const frozen = snap.freezeSnapshot(built);
  const s = snap.readFrozenSnapshot(frozen.text, frozen.sha256);
  const file = path.join(dir, `${name}.pdf`);
  fs.writeFileSync(file, await renderPayslipPdf(s));
  return {
    s,
    info: execFileSync("pdfinfo", [file]).toString(),
    text: execFileSync("pdftotext", ["-layout", file, "-"]).toString(),
  };
}
const grouped = (amount) => Number(String(amount).replace("-", "")).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const paise = (a) => Math.round(Number(a) * 100);

describe("the F&F statement, rendered with the production renderer", { skip }, () => {
  const out = {};
  before(async () => {
    out.full = await render("full", FULL);
    out.negative = await render("negative", NEGATIVE);
  });

  it("is ONE A4 page", () => {
    for (const r of Object.values(out)) {
      assert.match(r.info, /Pages:\s+1\b/);
      assert.match(r.info, /Page size:\s+594\.\d+ x 841\.\d+ pts \(A4\)/);
    }
  });

  it("prints every earnings and deduction line at the snapshot's own figure, and they reconcile to the printed totals", () => {
    const { s, text } = out.full;
    const earnings = s.earnings.lines.filter((l) => Number(l.amount) !== 0);
    const deductions = s.deductions.lines.filter((l) => Number(l.amount) !== 0);
    for (const l of [...earnings, ...deductions]) assert.ok(text.includes(grouped(l.amount)), `${l.label} ${l.amount}`);
    assert.equal(earnings.reduce((n, l) => n + paise(l.amount), 0), paise(s.earnings.total));
    assert.equal(deductions.reduce((n, l) => n + paise(l.amount), 0), paise(s.deductions.total));
    assert.equal(paise(s.earnings.total) - paise(s.deductions.total) + paise(s.final.net_pay_rounding), paise(s.final.net_pay));
    assert.match(text, /Gross Earnings\s+5,127\.37/);
    assert.match(text, /Total Deductions\s+1,889\.06/);
    assert.match(text, /Total Net Payable\s+3,238\.00/);
    assert.match(text, /Three Thousand Two Hundred Thirty Eight Rupees Only/);
  });

  it("carries the ordinary payroll lines, the exit facts and the statutory numbers that apply - and no F&F-only component", () => {
    const { text } = out.full;
    for (const label of ["Advance Recovery", "OT Approved After Lock"]) {
      assert.ok(text.includes(label), label);
    }
    // No F&F-only LINE: gratuity / leave encashment / notice are not payroll lines...
    const { s: snapshot } = out.full;
    for (const l of [...snapshot.earnings.lines, ...snapshot.deductions.lines]) {
      assert.doesNotMatch(l.label, /gratuity|encashment|notice/i, l.label);
    }
    for (const label of ["Notice Pay", "Notice Period Recovery"]) assert.ok(!text.includes(label), label);
    assert.equal((text.match(/gratuity|encashment/gi) || []).length, 0);
    assert.match(text, /Last Working Day\s+:\s*2026-08-16/);
    assert.match(text, /LOP Days\s+:\s*3\b/);
    assert.match(text, /UAN\s+:\s*100200300400/);
  });

  it("payable: the Employee Declaration of receipt with the printed amount and words, signed only after payment, with signature and date fields", () => {
    const { text } = out.full;
    const flat = text.replace(/\s+/g, " ");
    for (const label of ["Employee Declaration", "Prepared By :", "Authorized By :", "Employee Signature :", "Date :"]) {
      assert.ok(text.includes(label), label);
    }
    for (const { text: t } of Object.values(out)) assert.ok(!t.includes("Checked By"), "only Prepared By and Authorized By");
    assert.match(flat, /I hereby declare that I have received ₹3,238\.00 \(Three Thousand Two Hundred Thirty Eight Rupees Only\), being my Full & Final Settlement amount stated above/);
    assert.match(flat, /To be signed by the employee only after the amount has been received\./);
    assert.doesNotMatch(text, /^\s*PAN\s+:\s*$/m, "an empty PAN row is not printed");
  });

  it("neither statement mentions gratuity, leave encashment or statutory dues, and neither waives anything", () => {
    for (const { text } of Object.values(out)) {
      const flat = text.replace(/\s+/g, " ");
      for (const w of [/gratuity/i, /encashment/i, /statutory dues/i, /grievance/i, /dispute/i, /back wages/i, /reinstatement/i, /reemployment/i, /free will/i]) {
        assert.doesNotMatch(flat, w, String(w));
      }
    }
  });

  it("a negative F&F is RECOVERABLE: amount without sign, the right label and formula, and a separate acknowledgement - not a declaration of receipt", () => {
    const { text } = out.negative;
    const flat = text.replace(/\s+/g, " ");
    assert.match(text, /Total Recoverable from Employee\s+970\.00/);
    assert.match(text, /Nine Hundred Seventy Rupees Only/);
    assert.match(text, /\(Total Deductions - Gross Earnings\) - Round-off/);
    assert.match(flat, /Employee Acknowledgement of Recoverable Amount/);
    assert.match(flat, /I acknowledge that, as calculated in the monthly payroll for my final month of service, ₹970\.00 \(Nine Hundred Seventy Rupees Only\) stated above is recoverable from me\./);
    assert.doesNotMatch(flat, /I hereby declare|have received/);
    assert.match(flat, /Employee Signature :/);
    assert.match(flat, /Date :/);
    assert.doesNotMatch(text, /-970/);
  });

  it("no confidential HR word and no full bank account number reaches the document", () => {
    for (const { text } of Object.values(out)) {
      for (const forbidden of ["rehire", "Rehire", "confidential", "interview", "7895383811"]) {
        assert.ok(!text.includes(forbidden), forbidden);
      }
      assert.ok(text.includes("XXXXXX3811"));
    }
  });
});
