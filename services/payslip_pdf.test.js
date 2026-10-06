/**
 * THE ON-DEMAND PAYSLIP PDF.
 *
 *   node --test services/payslip_pdf.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const { payslipHtml, renderPayslipPdf, inr } = require("./payslip_pdf");
const { buildPayslipSnapshot, freezeSnapshot, readFrozenSnapshot } = require("../utils/payslip_snapshot");

const snapshot = () => {
  const snap = buildPayslipSnapshot({
    period: { year: 2026, month: 9 },
    calculation: {
      payrun_calculation_id: 1, payrun_employee_id: 2, employee_id: 101,
      monthly_gross: "26013.37", daily_rate: "1000.51", salary_days: 26, salary_earnings: "26013.26",
      missing_hours_minutes: 0, missing_hours_deduction: "0.00", extra_days: 0, extra_day_amount: "0.00",
      approved_ot_hours: "0", ot_amount: "0.00", incentive: "500.00", bonus: "0.00", arrears: "0.00",
      advance_recovery: "0.00", shortage_recovery: "0.00", pf_applicable: 1, esi_applicable: 0,
      employee_pf: "1560.74", employee_esi: "0.00", employer_pf_total: "1560.74",
      total_earnings: "26513.26", total_employee_deductions: "1560.74",
      net_pay: "24953.00", net_pay_rounding: "0.48", pay_type: "BANK",
      calculation_version: 2, calculation_revision: 1, calculation_hash: "b".repeat(32),
    },
    employee: {
      employee_id: 101, employee_name: "<script>alert(1)</script> Kavi", basic: "13006.69", hra: "5000",
      conveyance: "2500", special_allowance: "5506.68", uan: "100200300400",
    },
    extras: { account_no: "123456789012", pan_no: "ABCDE1234F" },
    company: { name: "Daily Needs", pf_establishment_code: "TN/MAS/0012345" },
  });
  return readFrozenSnapshot(freezeSnapshot(snap).text, freezeSnapshot(snap).sha256);
};

describe("the PDF is the snapshot, rendered", () => {
  it("shows the same final, total and line figures as the snapshot (the Mini App detail's source)", () => {
    const snap = snapshot();
    const html = payslipHtml(snap);
    for (const amount of [snap.final.net_pay, snap.final.net_pay_rounding, snap.final.net_pay_before_rounding,
      snap.earnings.total, snap.deductions.total, ...snap.earnings.lines.filter((l) => Number(l.amount) !== 0).map((l) => l.amount)]) {
      assert.ok(html.includes(inr(amount)), `missing ${amount}`);
    }
    assert.ok(html.includes("₹24,953.00"), "rounded Net Pay exactly");
    assert.ok(html.includes("September 2026"));
  });

  it("escapes database text; carries no external asset; only masked identifiers", () => {
    const html = payslipHtml(snapshot());
    assert.ok(!html.includes("<script>alert(1)</script>"));
    assert.ok(html.includes("&lt;script&gt;"));
    assert.ok(!/https?:\/\//.test(html), "no remote font, logo or link");
    assert.ok(!html.includes("123456789012"));
    assert.ok(!html.includes("ABCDE1234F"));
    assert.ok(html.includes("XXXXXX9012"));
  });

  it("Indian grouping", () => {
    assert.equal(inr("1234567.5"), "₹12,34,567.50");
    assert.equal(inr("-0.39"), "-₹0.39");
    assert.equal(inr("999.00"), "₹999.00");
  });
});

describe("rendering", () => {
  it("renders through withBrowser from the snapshot and writes nothing to disk", async () => {
    const writes = [];
    const origWrite = fs.writeFile;
    const origWriteSync = fs.writeFileSync;
    fs.writeFile = (...a) => { writes.push(a[0]); return origWrite(...a); };
    fs.writeFileSync = (...a) => { writes.push(a[0]); return origWriteSync(...a); };
    try {
      let seenHtml = null;
      const buf = await renderPayslipPdf(snapshot(), {
        withBrowser: async (fn) => fn({ renderPdf: async (html) => { seenHtml = html; return Buffer.from("%PDF-1.4 fake"); } }),
      });
      assert.ok(Buffer.isBuffer(buf));
      assert.ok(seenHtml.includes("₹24,953.00"));
      assert.deepEqual(writes, []);
    } finally {
      fs.writeFile = origWrite;
      fs.writeFileSync = origWriteSync;
    }
  });

  it("at most two renders run at once; the rest queue", async () => {
    let running = 0;
    let peak = 0;
    const withBrowser = async (fn) => fn({
      renderPdf: async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 15));
        running -= 1;
        return Buffer.from("x");
      },
    });
    await Promise.all(Array.from({ length: 6 }, () => renderPayslipPdf(snapshot(), { withBrowser })));
    assert.equal(peak, 2);
  });

  it("a failed render releases its slot", async () => {
    const bad = async () => { throw new Error("chrome died"); };
    await assert.rejects(renderPayslipPdf(snapshot(), { withBrowser: bad }));
    await assert.rejects(renderPayslipPdf(snapshot(), { withBrowser: bad }));
    await assert.rejects(renderPayslipPdf(snapshot(), { withBrowser: bad }));
    const ok = await renderPayslipPdf(snapshot(), { withBrowser: async (fn) => fn({ renderPdf: async () => Buffer.from("y") }) });
    assert.equal(ok.toString(), "y");
  });
});

describe("header, wording and identifiers (final layout)", () => {
  const { logoDataUri, LOGO_PATH } = require("./payslip_pdf");

  it("the official logo is embedded as a PNG data URI from the repo - no external URL; aspect ratio kept", () => {
    const html = payslipHtml(snapshot());
    const bytes = fs.readFileSync(LOGO_PATH);
    assert.equal(bytes.slice(1, 4).toString("latin1"), "PNG");
    // 600 x 120 - the same file the web app serves as /assets/dnds-logo.png
    assert.equal(bytes.readUInt32BE(16), 600);
    assert.equal(bytes.readUInt32BE(20), 120);
    assert.ok(html.includes(`<img class="logo" src="data:image/png;base64,${bytes.toString("base64")}"`));
    assert.match(html, /\.logo \{ display: block; width: 190px; height: auto; \}/, "fixed width, height follows");
    assert.ok(!/https?:\/\//.test(html), "no network");
  });

  it("if the logo cannot be read, the header falls back to the company name as text", () => {
    assert.equal(logoDataUri(() => { throw new Error("ENOENT"); }), null);
    assert.equal(logoDataUri(() => Buffer.from("not a png at all")), null);
    const html = payslipHtml(snapshot(), { logo: null });
    assert.ok(!html.includes("<img"));
    assert.match(html, /<div class="co">Daily Needs<\/div>/);
  });

  it("Salary Payslip + the month top-right; Standard Working Hours / Day; no visible template version", () => {
    const html = payslipHtml(snapshot());
    assert.match(html, /<div class="t1">Salary Payslip<\/div><div class="t2">September 2026<\/div>/);
    assert.ok(!html.includes("NRM"));
    assert.ok(!html.includes("payslip-v1"), "kept in the snapshot, not printed");
    assert.ok(html.includes("This is a system-generated payslip and does not require a signature."));
  });

  it("UAN / PF / ESI print in full; bank account and PAN stay masked", () => {
    const html = payslipHtml(snapshot());
    assert.ok(html.includes("100200300400"));
    assert.ok(!html.includes("XXXXXXXX0400"));
    assert.ok(html.includes("XXXXXX9012"));
    assert.ok(!html.includes("ABCDE1234F"));
  });

  it("a version-1 snapshot (masked numbers only, no advance / CTC block) still renders", () => {
    const v1 = snapshot();
    delete v1.statutory.uan;
    delete v1.statutory.pf_number;
    delete v1.statutory.esi_number;
    delete v1.advance;
    delete v1.employer_contribution;
    const html = payslipHtml(v1);
    assert.ok(html.includes("XXXXXXXX0400"), "falls back to the masked number it carries");
    assert.ok(!html.includes("Advance Details"));
    assert.ok(!html.includes("CTC / Employer Contribution"));
    assert.ok(html.includes("₹24,953.00"));
  });
});

describe("renderPayslipPdfs - the admin bulk export", () => {
  const { renderPayslipPdfs } = require("./payslip_pdf");

  it("renders every snapshot in ONE browser, in order, as the same payslipHtml", async () => {
    let launches = 0;
    const seen = [];
    const withBrowser = async (fn) => {
      launches += 1;
      return fn({ renderPdf: async (html) => { seen.push(html); return Buffer.from(`pdf${seen.length}`); } });
    };
    const out = await renderPayslipPdfs([snapshot(), snapshot(), snapshot()], { withBrowser });
    assert.equal(launches, 1);
    assert.deepEqual(out.map((b) => b.toString()), ["pdf1", "pdf2", "pdf3"]);
    assert.equal(seen[0], payslipHtml(snapshot()));
  });

  it("an empty batch launches nothing", async () => {
    let launches = 0;
    assert.deepEqual(await renderPayslipPdfs([], { withBrowser: async () => { launches += 1; } }), []);
    assert.equal(launches, 0);
  });

  it("a failed batch releases its slot", async () => {
    await assert.rejects(renderPayslipPdfs([snapshot()], { withBrowser: async () => { throw new Error("chrome died"); } }));
    await assert.rejects(renderPayslipPdfs([snapshot()], { withBrowser: async () => { throw new Error("chrome died"); } }));
    const ok = await renderPayslipPdfs([snapshot()], { withBrowser: async (fn) => fn({ renderPdf: async () => Buffer.from("z") }) });
    assert.equal(ok[0].toString(), "z");
  });
});

describe("sections: shown only when they apply", () => {
  const rich = (over = {}) => {
    const snap = buildPayslipSnapshot({
      period: { year: 2026, month: 9 },
      calculation: {
        payrun_calculation_id: 1, payrun_employee_id: 2, employee_id: 101,
        monthly_gross: "26013.37", daily_rate: "1000.51", salary_days: 26, salary_earnings: "26013.26",
        missing_hours_minutes: 0, missing_hours_deduction: "0.00", extra_days: 0, extra_day_amount: "0.00",
        approved_ot_hours: "0", ot_amount: "0.00", incentive: "500.00", bonus: "0.00", arrears: "0.00",
        advance_recovery: "1000.00", shortage_recovery: "0.00", balance_advance: "149000.00",
        pf_applicable: 1, esi_applicable: 1, pf_wage: "13006.19", esi_wage: "25825.66",
        employee_pf: "1560.74", employee_esi: "193.69", employer_pf_total: "1560.74", employer_esi: "839.33",
        edli: "0.00", pf_admin_charge: "0.00",
        total_earnings: "26513.26", total_employee_deductions: "2754.43",
        net_pay: "23759.00", net_pay_rounding: "0.17", pay_type: "BANK",
        calculation_version: 4, calculation_revision: 1, calculation_hash: "c".repeat(32),
        ...over,
      },
      employee: {
        employee_id: 101, employee_name: "Kavi", basic: "13006.69", hra: "5000", conveyance: "2500",
        special_allowance: "5506.68", uan: "100200300400", pf_number: "PYDPU123456/101", esi_number: "3912345670",
      },
      extras: { account_no: "123456789012", pan_no: "ABCDE1234F" },
      company: { name: "Daily Needs", pf_establishment_code: "PYPDY0012345000", esi_establishment_code: "51000123450001001" },
    });
    return readFrozenSnapshot(freezeSnapshot(snap).text, freezeSnapshot(snap).sha256);
  };

  it("advance details with the exact labels; opening = closing + recovery", () => {
    const html = payslipHtml(rich());
    assert.ok(html.includes("Advance Details"));
    assert.match(html, /Advance Opening Balance<\/td><td class="c">:<\/td><td class="v">₹1,50,000.00/);
    assert.match(html, /Recovery This Month<\/td><td class="c">:<\/td><td class="v">₹1,000.00/);
    assert.match(html, /Advance Closing Balance<\/span><b>₹1,49,000.00/);
  });

  it("no advance -> no advance section", () => {
    const html = payslipHtml(rich({ advance_recovery: "0.00", balance_advance: "0.00",
      total_employee_deductions: "1754.43", net_pay: "24759.00", net_pay_rounding: "0.17" }));
    assert.ok(!html.includes("Advance Details"));
    assert.ok(!html.includes("Advance Opening Balance"));
  });

  it("CTC = Monthly Gross + Employer PF + Employer ESI, Annual = x12; zero rows hidden", () => {
    const html = payslipHtml(rich());
    assert.ok(html.includes("CTC / Employer Contribution"));
    assert.ok(html.includes("₹2,400.07"), "total employer contribution");
    assert.ok(html.includes("₹28,413.44"), "monthly CTC = 26,013.37 + 2,400.07");
    assert.ok(html.includes("₹3,40,961.28"), "annual CTC = monthly x 12");
    assert.ok(!html.includes("Other Employer Contribution"), "zero other contribution is hidden");
  });

  it("no PF and no ESI -> no statutory section and no CTC section", () => {
    const html = payslipHtml(rich({ pf_applicable: 0, esi_applicable: 0, employee_pf: "0.00", employee_esi: "0.00",
      total_employee_deductions: "1000.00", net_pay: "25513.00", net_pay_rounding: "-0.26" }));
    assert.ok(!html.includes("Statutory Information"));
    assert.ok(!html.includes("UAN"));
    assert.ok(!html.includes("Employer PF Contribution"));
    assert.ok(!html.includes("Employer ESI Contribution"));
    assert.ok(!html.includes("CTC / Employer Contribution"), "no employer cost -> no CTC section");
    assert.ok(!html.includes("Total Employer Contribution"));
    assert.ok(!html.includes("Monthly CTC"));
  });

  it("Net Pay footer: before rounding, round-off, final", () => {
    const html = payslipHtml(rich());
    assert.ok(html.includes("Net Pay Before Rounding"));
    assert.ok(html.includes("Round-off"));
    assert.match(html, /<div class="l">Final Net Pay<\/div><div class="amt">₹23,759.00<\/div>/);
  });

  it("green for earnings, red for deductions, purple brand", () => {
    const html = payslipHtml(rich());
    assert.ok(html.includes('class="money earn"') && html.includes("Earnings / Additions"));
    assert.ok(html.includes('class="money ded"') && html.includes("Deductions / Less"));
    assert.ok(html.includes("#732f8d"));
  });
});

describe("PF ceiling periods are not printed", () => {
  it("a split month shows the PF Wage only, not the per-period breakdown", () => {
    const snap = snapshot();
    snap.statutory.pf_periods = [
      { from: "2026-09-01", to: "2026-09-16", monthly_wage_ceiling: "15000.00", pf_wage: "7003.72", employee_pf: "840.45" },
      { from: "2026-09-17", to: "2026-09-30", monthly_wage_ceiling: "25000.00", pf_wage: "6002.47", employee_pf: "720.29" },
    ];
    const html = payslipHtml(snap);
    assert.ok(!html.includes("ceiling"));
    assert.ok(!html.includes("₹7,003.72"));
    assert.ok(html.includes("Statutory Information") && html.includes("100200300400"), "the card itself still prints");
  });
});
