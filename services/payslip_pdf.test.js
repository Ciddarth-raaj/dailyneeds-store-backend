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
    company: { name: "Daily Needs" },
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
    assert.match(html, /\.logo \{ display: block; width: 150px; height: auto; \}/, "fixed width, height follows");
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

  it("UAN / PF / ESI print masked; the full numbers are not on the PDF", () => {
    const html = payslipHtml(snapshot());
    assert.ok(html.includes("XXXXXXXX0400"));
    assert.ok(!html.includes("100200300400"));
  });
});
