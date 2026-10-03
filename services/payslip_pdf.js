/**
 * THE PAYSLIP PDF - rendered ON DEMAND from the frozen snapshot, streamed,
 * and never stored.
 *
 * IT READS THE SNAPSHOT AND NOTHING ELSE. No repository, no calculation, no
 * live table: the caller hands over the snapshot object that the Mini App
 * detail is also built from, so the PDF and the screen cannot disagree.
 *
 * NO EXTERNAL ASSET. No web font, no remote logo - a payslip render does not
 * depend on, or leak a request to, any other host.
 *
 * EVERY VALUE IS HTML-ESCAPED. Names and designations are database text.
 *
 * CONCURRENCY IS CAPPED for the whole process (`PDF_RENDER_CONCURRENCY`), so a
 * burst of employees opening their payslips on pay day queues rather than
 * launching a Chrome each. Launch, render and cleanup are `pdf_browser.js`'s
 * time-bounded `withBrowser`.
 */
const { PDF_RENDER_CONCURRENCY } = require("../constants/payslip");

const A4 = {
  format: "A4",
  printBackground: true,
  margin: { top: "12mm", right: "12mm", bottom: "12mm", left: "12mm" },
  preferCSSPageSize: true,
};

const esc = (value) =>
  String(value === null || value === undefined ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** "12345.50" -> "12,345.50" (Indian grouping), sign kept. */
function inr(amount) {
  if (amount === null || amount === undefined || amount === "") return "—";
  const text = String(amount);
  const negative = text.startsWith("-");
  const [whole, frac = "00"] = text.replace("-", "").split(".");
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last3}` : last3;
  return `${negative ? "-" : ""}₹${grouped}.${frac.padEnd(2, "0").slice(0, 2)}`;
}

const isZero = (amount) => amount === null || amount === undefined || Number(amount) === 0;

/** The lines a payslip prints: every non-optional line, and optional ones only when non-zero. */
const printable = (lines) => (lines || []).filter((l) => !l.optional || !isZero(l.amount));

const row = (label, value) =>
  value === null || value === undefined || value === ""
    ? ""
    : `<tr><td class="k">${esc(label)}</td><td class="v">${esc(value)}</td></tr>`;

function payslipHtml(s) {
  const e = s.employee || {};
  const a = s.attendance || {};
  const st = s.statutory || {};
  const f = s.final || {};
  const earnings = printable(s.earnings && s.earnings.lines);
  const deductions = printable(s.deductions && s.deductions.lines);
  const rows = Math.max(earnings.length, deductions.length);
  const pair = [];
  for (let i = 0; i < rows; i += 1) {
    const er = earnings[i];
    const dr = deductions[i];
    pair.push(
      `<tr><td>${er ? esc(er.label) : ""}</td><td class="num">${er ? esc(inr(er.amount)) : ""}</td>` +
        `<td>${dr ? esc(dr.label) : ""}</td><td class="num">${dr ? esc(inr(dr.amount)) : ""}</td></tr>`
    );
  }
  const otLine =
    Number(a.approved_ot_hours) > 0
      ? row("Approved OT", `${a.approved_ot_hours} h${a.ot_hourly_rate ? ` @ ${inr(a.ot_hourly_rate)}/h` : ""} = ${inr(a.ot_amount)}`)
      : "";

  return `<!doctype html><html><head><meta charset="utf-8"><title>Payslip</title><style>
  @page { size: A4; margin: 12mm; }
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 11px; color: #1a202c; margin: 0; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #2d3748; padding-bottom: 8px; }
  .co { font-size: 18px; font-weight: bold; }
  .addr { color: #4a5568; margin-top: 2px; white-space: pre-line; }
  .title { text-align: right; font-size: 14px; font-weight: bold; }
  .net { margin: 12px 0; padding: 10px 12px; background: #f0fff4; border: 1px solid #9ae6b4; display: flex; justify-content: space-between; align-items: center; }
  .net .amt { font-size: 20px; font-weight: bold; }
  h3 { font-size: 12px; margin: 14px 0 4px; text-transform: uppercase; letter-spacing: .04em; color: #2d3748; }
  table { width: 100%; border-collapse: collapse; }
  .kv td { padding: 2px 4px; }
  .kv .k { color: #4a5568; width: 45%; }
  .grid { display: flex; gap: 16px; }
  .grid > div { flex: 1; }
  .ed th, .ed td { border: 1px solid #cbd5e0; padding: 4px 6px; }
  .ed th { background: #edf2f7; text-align: left; }
  .num { text-align: right; white-space: nowrap; }
  .tot td { font-weight: bold; background: #f7fafc; }
  .fin td { padding: 3px 6px; }
  .foot { margin-top: 18px; color: #718096; font-size: 9px; border-top: 1px solid #e2e8f0; padding-top: 6px; }
</style></head><body>
<div class="head">
  <div><div class="co">${esc((s.company && s.company.name) || "")}</div>${s.company && s.company.address ? `<div class="addr">${esc(s.company.address)}</div>` : ""}</div>
  <div class="title">Payslip<br>${esc(s.period && s.period.label)}</div>
</div>
<div class="net"><div>Net Pay${e.pay_type ? ` (${esc(e.pay_type === "BANK" ? "Bank" : e.pay_type === "CASH" ? "Cash" : e.pay_type)})` : ""}</div><div class="amt">${esc(inr(f.net_pay))}</div></div>
<div class="grid">
  <div><h3>Employee</h3><table class="kv">
    ${row("Name", e.employee_name)}${row("Employee ID", e.employee_id)}${row("Designation", e.designation_name)}
    ${row("Outlet", e.store_name)}${row("Department", e.department_name)}${row("Date of Joining", e.date_of_joining)}
    ${row("Payroll Month", s.period && s.period.label)}${row("Payment Type", e.pay_type === "BANK" ? "Bank" : e.pay_type === "CASH" ? "Cash" : e.pay_type)}
    ${row("Bank", e.bank_name)}${row("Bank Account", e.bank_account_masked)}${row("PAN", e.pan_masked)}
  </table></div>
  <div><h3>Attendance / Salary Basis</h3><table class="kv">
    ${row("Monthly Gross", inr(a.monthly_gross))}${row("Salary Days", a.salary_days)}${row("Daily Rate", inr(a.daily_rate))}
    ${row("NRM (hours / day)", a.nrm_hours)}${Number(a.missing_hours) > 0 ? row("Missing Hours", `${a.missing_hours} h = ${inr(a.missing_hours_deduction)}`) : ""}
    ${Number(a.extra_days) > 0 ? row("Extra Days", `${a.extra_days} = ${inr(a.extra_day_amount)}`) : ""}${otLine}
  </table></div>
</div>
<h3>Earnings and Deductions</h3>
<table class="ed">
  <tr><th>Earnings</th><th class="num">Amount</th><th>Deductions</th><th class="num">Amount</th></tr>
  ${pair.join("")}
  <tr class="tot"><td>Total Earnings</td><td class="num">${esc(inr(s.earnings && s.earnings.total))}</td><td>Total Deductions</td><td class="num">${esc(inr(s.deductions && s.deductions.total))}</td></tr>
</table>
${st.pf_applicable || st.esi_applicable ? `<h3>Statutory</h3><table class="kv">
  ${st.pf_applicable ? `${row("UAN", st.uan)}${row("PF Number", st.pf_number)}${row("PF Wage", st.pf_wage ? inr(st.pf_wage) : null)}` : ""}
  ${st.esi_applicable ? `${row("ESI Number", st.esi_number)}${row("ESI Wage", st.esi_wage ? inr(st.esi_wage) : null)}` : ""}
</table>` : ""}
<h3>Net Pay</h3>
<table class="kv fin">
  ${row("Net Pay before rounding", inr(f.net_pay_before_rounding))}
  ${row("Net Pay Rounding", inr(f.net_pay_rounding))}
  <tr><td class="k"><b>Final Net Pay</b></td><td class="v"><b>${esc(inr(f.net_pay))}</b></td></tr>
</table>
<div class="foot">This is a system-generated payslip and does not require a signature. ${esc(s.template_version || "")}</div>
</body></html>`;
}

/* ------------------------------------------------- render, capped */

let active = 0;
const waiting = [];
function acquire() {
  if (active < PDF_RENDER_CONCURRENCY) {
    active += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
}
function release() {
  const next = waiting.shift();
  if (next) next();
  else active -= 1;
}

/**
 * @param {object} snapshot  the frozen payslip snapshot
 * @param {object} [deps]    { withBrowser } - injected in tests
 * @returns {Promise<Buffer>}
 */
async function renderPayslipPdf(snapshot, deps = {}) {
  const withBrowser = deps.withBrowser || require("./pdf_browser").withBrowser;
  const html = payslipHtml(snapshot);
  await acquire();
  try {
    return await withBrowser((session) => session.renderPdf(html, A4));
  } finally {
    release();
  }
}

module.exports = { payslipHtml, renderPayslipPdf, inr, printable, esc };
