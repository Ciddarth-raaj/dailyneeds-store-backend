/**
 * THE PAYSLIP PDF - rendered ON DEMAND from the frozen snapshot, streamed,
 * and never stored.
 *
 * IT READS THE SNAPSHOT AND NOTHING ELSE. No repository, no calculation, no
 * live table: the caller hands over the snapshot object that the Mini App
 * detail is also built from, so the PDF and the screen cannot disagree.
 *
 * NO EXTERNAL ASSET. No web font and no remote logo: the official DailyNeeds
 * logo (assets/payslip/dnds-logo.png - the same file the web app serves as
 * /assets/dnds-logo.png) is read from disk once and embedded as a data URI,
 * so a render needs no network at all. If the file cannot be read, the header
 * falls back to the company name as text.
 *
 * EVERY VALUE IS HTML-ESCAPED. Names and designations are database text.
 *
 * CONCURRENCY IS CAPPED for the whole process (`PDF_RENDER_CONCURRENCY`), so a
 * burst of employees opening their payslips on pay day queues rather than
 * launching a Chrome each. Launch, render and cleanup are `pdf_browser.js`'s
 * time-bounded `withBrowser`.
 */
const fs = require("fs");
const path = require("path");
const { PDF_RENDER_CONCURRENCY } = require("../constants/payslip");

const LOGO_PATH = path.join(__dirname, "..", "assets", "payslip", "dnds-logo.png");

/** The logo as a data URI, read once; null if it cannot be read (text fallback). */
let logoCache;
function logoDataUri(readFile = fs.readFileSync) {
  if (logoCache !== undefined && readFile === fs.readFileSync) return logoCache;
  let uri = null;
  try {
    const bytes = readFile(LOGO_PATH);
    // A PNG, or nothing: never embed something that is not the logo.
    if (Buffer.isBuffer(bytes) && bytes.length > 8 && bytes.slice(1, 4).toString("latin1") === "PNG") {
      uri = `data:image/png;base64,${bytes.toString("base64")}`;
    }
  } catch (err) {
    uri = null;
  }
  if (readFile === fs.readFileSync) logoCache = uri;
  return uri;
}

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
    : `<tr><td class="k">${esc(label)}</td><td class="c">:</td><td class="v">${esc(value)}</td></tr>`;

/*
 * THE BRAND. Purple (the logo's own #732f8d) carries the page: headers, section
 * titles, borders, Net Pay. Orange (the logo's #f15a22) is an ACCENT only -
 * thin rules and small marks, never a fill. Green belongs to Earnings and red
 * to Deductions, and to nothing else.
 */
const C = {
  purple: "#732f8d",
  purpleDark: "#4a1a63",
  purpleTint: "#f5effa",
  purpleLine: "#d9c6e6",
  orange: "#f15a22",
  green: "#1e7b3c",
  greenTint: "#e8f6ec",
  greenLine: "#bfe3cb",
  red: "#c0262d",
  redTint: "#fdecec",
  redLine: "#f3c4c6",
  ink: "#1f1a24",
  muted: "#5d5566",
};

/* Small inline icons (no external asset, no xmlns needed inside HTML). */
const ICON = {
  wallet: '<path d="M3 7h15a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V7z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 7l12-4 1.5 4" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="16.5" cy="13.5" r="1.6" fill="currentColor"/>',
  user: '<circle cx="12" cy="8" r="4" fill="currentColor"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7z" fill="currentColor"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 10h18M8 3v4M16 3v4" stroke="currentColor" stroke-width="2"/><path d="M7 13h2v2H7zM11 13h2v2h-2zM15 13h2v2h-2zM7 17h2v2H7zM11 17h2v2h-2z" fill="currentColor"/>',
  coins: '<ellipse cx="12" cy="6" rx="8" ry="3" fill="currentColor"/><path d="M4 10c0 1.7 3.6 3 8 3s8-1.3 8-3M4 14c0 1.7 3.6 3 8 3s8-1.3 8-3M4 18c0 1.7 3.6 3 8 3s8-1.3 8-3" fill="none" stroke="currentColor" stroke-width="2"/>',
  bank: '<path d="M2 9l10-6 10 6z" fill="currentColor"/><path d="M5 10v8M9.5 10v8M14.5 10v8M19 10v8" stroke="currentColor" stroke-width="2.2"/><path d="M3 20h18" stroke="currentColor" stroke-width="2.4"/>',
  hand: '<circle cx="14" cy="7" r="5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 5h4M12 7h4M13 5c2 0 2 3 0 3l2 2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M2 15h4l5 2h5a1.5 1.5 0 0 1 0 3H9M6 15v6H2" fill="none" stroke="currentColor" stroke-width="2"/>',
  people: '<circle cx="12" cy="7" r="3.2" fill="currentColor"/><circle cx="5" cy="9" r="2.4" fill="currentColor"/><circle cx="19" cy="9" r="2.4" fill="currentColor"/><path d="M6 20c0-3.6 2.7-6 6-6s6 2.4 6 6zM0.5 19c0-2.7 2-4.5 4.5-4.5 1 0 1.8.2 2.5.7-1 1-1.8 2.2-2 3.8zM23.5 19c0-2.7-2-4.5-4.5-4.5-1 0-1.8.2-2.5.7 1 1 1.8 2.2 2 3.8z" fill="currentColor"/>',
  rupee: '<circle cx="12" cy="12" r="10" fill="currentColor"/><path d="M8 7h8M8 10h8M9 7c5 0 5 6 0 6h-1l6 5" fill="none" stroke="#4a1a63" stroke-width="1.8" stroke-linejoin="round"/>',
};
const icon = (name, size = 18) =>
  `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">${ICON[name]}</svg>`;

const card = (iconName, title, body, cls = "") =>
  `<section class="card ${cls}"><h3>${icon(iconName)}<span>${esc(title)}</span></h3><div class="body">${body}</div></section>`;

const payTypeLabel = (t) => (t === "BANK" ? "Bank" : t === "CASH" ? "Cash" : t);
const hasAmount = (v) => v !== null && v !== undefined && v !== "" && Number(v) !== 0;

/** Earnings or deductions as their own coloured table; blank rows keep the two the same height. */
function moneyTable(kind, title, lines, total, totalLabel, height) {
  const body = lines
    .map((l) => `<tr><td>${esc(l.label)}</td><td class="num">${esc(inr(l.amount))}</td></tr>`)
    .concat(Array.from({ length: Math.max(0, height - lines.length) }, () => '<tr class="blank"><td>&nbsp;</td><td></td></tr>'))
    .join("");
  return `<div class="money ${kind}"><div class="mh">${esc(title)}</div><table>
  <thead><tr><th>Description</th><th class="num">Amount (₹)</th></tr></thead>
  <tbody>${body}</tbody>
  <tfoot><tr><td>${esc(totalLabel)}</td><td class="num">${esc(inr(total))}</td></tr></tfoot>
</table></div>`;
}

function payslipHtml(s, { logo = logoDataUri() } = {}) {
  const e = s.employee || {};
  const a = s.attendance || {};
  const st = s.statutory || {};
  const f = s.final || {};
  const co = s.company || {};
  const adv = s.advance || null;
  const ctc = s.employer_contribution || null;
  const earnings = printable(s.earnings && s.earnings.lines);
  const deductions = printable(s.deductions && s.deductions.lines);
  const height = Math.max(earnings.length, deductions.length);
  const payType = payTypeLabel(e.pay_type);

  /* ---- attendance / salary basis: the optional lines only when they apply ---- */
  const otLine =
    Number(a.approved_ot_hours) > 0
      ? row("Approved OT", `${a.approved_ot_hours} h${a.ot_hourly_rate ? ` @ ${inr(a.ot_hourly_rate)}/h` : ""} = ${inr(a.ot_amount)}`)
      : "";
  const basis = `<table class="kv">
    ${row("Monthly Gross (Fixed)", inr(a.monthly_gross))}${row("Salary Days", a.salary_days)}${row("Daily Rate", inr(a.daily_rate))}
    ${row("Standard Working Hours / Day", a.nrm_hours === null || a.nrm_hours === undefined ? null : `${a.nrm_hours} h`)}
    ${Number(a.missing_hours) > 0 ? row("Missing Hours", `${a.missing_hours} h = ${inr(a.missing_hours_deduction)}`) : ""}
    ${Number(a.extra_days) > 0 ? row("Extra Days", `${a.extra_days} = ${inr(a.extra_day_amount)}`) : ""}${otLine}
  </table>`;

  const employee = `<table class="kv">
    ${row("Name", e.employee_name)}${row("Employee ID", e.employee_id)}${row("Designation", e.designation_name)}
    ${row("Department", e.department_name)}${row("Outlet", e.store_name)}${row("Date of Joining", e.date_of_joining)}
    ${row("Payroll Month", s.period && s.period.label)}${row("Payment Type", payType)}
    ${row("Bank Name", e.bank_name)}${row("Bank Account", e.bank_account_masked)}${row("PAN", e.pan_masked)}
  </table>`;

  /* ---- the three informational cards: each only when it applies ---- */
  const cards = [];
  if (st.pf_applicable || st.esi_applicable) {
    // Schema version 1 carried only the masked numbers; print what it has.
    const pick = (full, masked) => (full !== undefined ? full : masked);
    // The per-period PF split of a month cut by a ceiling change stays in the
    // snapshot for payroll; the payslip prints only the month's PF Wage.
    cards.push(card("bank", "Statutory Information", `<table class="kv">
      ${st.pf_applicable ? `${row("UAN", pick(st.uan, st.uan_masked))}${row("PF Number", pick(st.pf_number, st.pf_number_masked))}${row("PF Wage", hasAmount(st.pf_wage) ? inr(st.pf_wage) : null)}` : ""}
      ${st.esi_applicable ? `${row("ESI Number", pick(st.esi_number, st.esi_number_masked))}${row("ESI Wage", hasAmount(st.esi_wage) ? inr(st.esi_wage) : null)}` : ""}
      ${row("PF Establishment Code", st.pf_applicable ? co.pf_establishment_code : null)}
      ${row("ESI Establishment Code", st.esi_applicable ? co.esi_establishment_code : null)}
    </table>`, "stat"));
  }
  if (adv && (hasAmount(adv.closing_balance) || hasAmount(adv.recovery_this_month))) {
    cards.push(card("hand", "Advance Details", `<table class="kv">
      ${row("Advance Opening Balance", inr(adv.opening_balance))}
      ${row("Recovery This Month", inr(adv.recovery_this_month))}
    </table><div class="hl"><span>Advance Closing Balance</span><b>${esc(inr(adv.closing_balance))}</b></div>`));
  }
  /*
   * TWO BOXES, TWO DIFFERENT FIGURES.
   *
   * EMPLOYER CONTRIBUTION is THIS MONTH'S (it moves with the wages earned) and
   * sits with the other informational cards. CTC & TAKE HOME are FIXED by the
   * salary structure and move only on a revision; that box sits under the
   * Salary Basis it belongs to. With no employer cost at all the CTC is just the
   * Monthly Gross already printed, and the CTC box is left out.
   */
  let ctcBox = "";
  if (ctc) {
    if (hasAmount(ctc.total)) {
      cards.push(card("people", "Employer Contribution", `<table class="kv">
      ${hasAmount(ctc.employer_pf) ? row("Employer PF Contribution", inr(ctc.employer_pf)) : ""}
      ${hasAmount(ctc.employer_esi) ? row("Employer ESI Contribution", inr(ctc.employer_esi)) : ""}
      ${hasAmount(ctc.other) ? row("Other Employer Contribution", inr(ctc.other)) : ""}
    </table><div class="hl"><span>Total Employer Contribution</span><b>${esc(inr(ctc.total))}</b></div>
    <div class="note">This month's, paid by the company over and above your salary; not part of Earnings or Deductions.</div>`, "contrib"));
    }
    const fixedCtc = hasAmount(ctc.monthly_ctc) ? ctc.monthly_ctc : null;
    if (fixedCtc !== null && Number(fixedCtc) !== Number(a.monthly_gross)) {
      ctcBox = card("wallet", "CTC & Take Home", `<table class="kv">
      ${row("Monthly CTC", inr(fixedCtc))}
      ${row("Annual CTC", inr(ctc.annual_ctc))}
      ${hasAmount(ctc.monthly_take_home) ? row("Monthly Take Home", inr(ctc.monthly_take_home)) : ""}
    </table><div class="note">Fixed by your salary structure; changes only on a salary revision.</div>`, "basis fixed");
    }
  }

  return `<!doctype html><html><head><meta charset="utf-8"><title>Salary Payslip</title><style>
  @page { size: A4; margin: 10mm 11mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 10px; line-height: 1.35; color: ${C.ink};
    -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  table { width: 100%; border-collapse: collapse; }
  section, table, tr, .netbar, .final { page-break-inside: avoid; break-inside: avoid; }
  .num { text-align: right; white-space: nowrap; }
  .ic { flex-shrink: 0; color: ${C.purple}; }

  /* header */
  .head { display: flex; justify-content: space-between; align-items: stretch; border-bottom: 2px solid ${C.purple}; }
  .brand { min-width: 0; padding: 0 12px 6px 0; }
  .logo { display: block; width: 190px; height: auto; }
  .co { font-size: 18px; font-weight: bold; color: ${C.purple}; }
  .addr { color: ${C.muted}; margin-top: 4px; font-size: 9px; max-width: 380px; white-space: pre-line; }
  .title { position: relative; flex-shrink: 0; width: 230px; color: #fff; text-align: right; padding: 12px 14px 10px 44px;
    background: linear-gradient(135deg, ${C.purple}, ${C.purpleDark}); clip-path: polygon(30px 0, 100% 0, 100% 100%, 0 100%); }
  .title::before { content: ""; position: absolute; left: 22px; top: 0; bottom: 0; width: 5px; background: ${C.orange};
    transform: skewX(-16deg); transform-origin: top; }
  .title .t1 { font-size: 17px; font-weight: bold; letter-spacing: .03em; text-transform: uppercase; }
  .title .t2 { font-size: 12px; margin-top: 3px; }
  .title .t2::after { content: ""; display: block; margin: 4px 0 0 auto; width: 90px; height: 2px; background: ${C.orange}; }

  /* prominent net pay */
  .netbar { display: flex; justify-content: space-between; align-items: center; margin: 7px 0; padding: 4px 4px 4px 12px;
    background: ${C.purpleTint}; border: 1px solid ${C.purpleLine}; border-radius: 6px; }
  .netbar .lab { display: flex; align-items: center; gap: 8px; font-size: 15px; font-weight: bold; color: ${C.purpleDark}; }
  .netbar .amt { font-size: 20px; font-weight: bold; color: #fff; background: ${C.purpleDark}; padding: 4px 16px; border-radius: 5px;
    border-left: 4px solid ${C.orange}; }

  /* cards */
  .grid { display: flex; gap: 7px; margin-bottom: 7px; }
  .grid > .card, .grid > .col { flex: 1 1 0; min-width: 0; }
  .col { display: flex; flex-direction: column; gap: 7px; }
  .col > .card:first-child { flex: 1 1 auto; }
  .card { border: 1px solid ${C.purpleLine}; border-radius: 6px; overflow: hidden; }
  .card h3 { display: flex; align-items: center; gap: 7px; margin: 0; padding: 4px 10px; font-size: 10.5px; text-transform: uppercase;
    letter-spacing: .03em; color: ${C.purpleDark}; background: ${C.purpleTint}; border-bottom: 1px solid ${C.purpleLine}; }
  .card .body { padding: 4px 9px 5px; }
  .kv td { padding: 1px 0; vertical-align: top; }
  .kv .k { color: ${C.muted}; width: 40%; }
  .kv .c { color: ${C.muted}; width: 10px; padding: 1px 4px; }
  .kv .v { font-weight: 600; word-break: break-word; }
  .grid3 { font-size: 9.5px; }
  .grid3 .kv .k { width: auto; white-space: nowrap; }
  .grid3 .kv .v { white-space: nowrap; text-align: right; }
  .hl span { white-space: nowrap; }
  .basis .kv .k { width: 52%; }
  .hl { display: flex; justify-content: space-between; gap: 6px; margin: 3px 0; padding: 3px 6px; border-radius: 4px; font-weight: bold;
    color: ${C.purpleDark}; background: ${C.purpleTint}; border-left: 3px solid ${C.purple}; }
  .hl b { white-space: nowrap; }
  .note { color: ${C.muted}; font-size: 8px; margin-top: 3px; }

  /* earnings and deductions, side by side */
  .ed { border: 1px solid ${C.purpleLine}; border-radius: 6px; overflow: hidden; margin-bottom: 7px; }
  .ed > h3 { display: flex; align-items: center; gap: 7px; margin: 0; padding: 4px 10px; font-size: 11.5px; text-transform: uppercase;
    letter-spacing: .03em; color: #fff; background: ${C.purple}; border-bottom: 2px solid ${C.orange}; }
  .ed > h3 .ic { color: #fff; }
  .pair { display: flex; gap: 6px; padding: 5px; }
  .money { flex: 1 1 0; min-width: 0; border-radius: 4px; overflow: hidden; }
  .money .mh { padding: 3px 8px; font-size: 11px; font-weight: bold; text-transform: uppercase; }
  .money th, .money td { padding: 2px 8px; text-align: left; }
  .money th { font-size: 9.5px; }
  .money th.num, .money td.num { text-align: right; }
  .money tbody td { border-top: 1px solid; }
  .money tfoot td { font-size: 12px; font-weight: bold; padding: 4px 8px; border-top: 1.5px solid; }
  .earn { border: 1px solid ${C.greenLine}; }
  .earn .mh, .earn th, .earn tfoot td { color: ${C.green}; background: ${C.greenTint}; }
  .earn tbody td, .earn tfoot td { border-color: ${C.greenLine}; }
  .ded { border: 1px solid ${C.redLine}; }
  .ded .mh, .ded th, .ded tfoot td { color: ${C.red}; background: ${C.redTint}; }
  .ded tbody td, .ded tfoot td { border-color: ${C.redLine}; }

  /* net pay */
  .final { display: flex; align-items: center; gap: 14px; padding: 6px 8px 6px 14px; border-radius: 6px; color: #fff;
    background: linear-gradient(135deg, ${C.purple}, ${C.purpleDark}); }
  .final .ic { color: #fff; }
  .final .calc { flex: 1; }
  .final .calc table td { padding: 2px 0; font-size: 11px; }
  .final .calc .k { width: 50%; }
  .final .calc .c { width: 12px; }
  .final .calc .v { font-weight: bold; }
  .final .box { text-align: center; padding: 4px 18px; border-radius: 6px; border: 1px solid rgba(255,255,255,.55);
    border-bottom: 3px solid ${C.orange}; background: rgba(255,255,255,.08); }
  .final .box .l { font-size: 12px; font-weight: bold; }
  .final .box .amt { font-size: 24px; font-weight: bold; margin-top: 2px; white-space: nowrap; }

  .foot { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-top: 8px; padding-top: 5px;
    border-top: 1.5px solid ${C.orange}; font-size: 8.5px; color: ${C.muted}; }
  .foot .tag { color: ${C.purple}; font-weight: bold; letter-spacing: .05em; white-space: nowrap; }
  .foot .tag i { color: ${C.orange}; font-style: normal; padding: 0 5px; }
</style></head><body>
<header class="head">
  <div class="brand">${logo ? `<img class="logo" src="${logo}" alt="${esc(co.name || "DailyNeeds")}">` : `<div class="co">${esc(co.name || "")}</div>`}${co.address ? `<div class="addr">${esc(co.address)}</div>` : ""}</div>
  <div class="title"><div class="t1">Salary Payslip</div><div class="t2">${esc(s.period && s.period.label)}</div></div>
</header>
<div class="netbar"><div class="lab">${icon("wallet", 24)}<span>Net Pay${payType ? ` (${esc(payType)})` : ""}</span></div><div class="amt">${esc(inr(f.net_pay))}</div></div>
<div class="grid">
  ${card("user", "Employee Details", employee)}
  <div class="col">${card("calendar", "Attendance / Salary Basis", basis, "basis")}${ctcBox}</div>
</div>
<section class="ed"><h3>${icon("coins")}<span>Earnings &amp; Deductions</span></h3><div class="pair">
  ${moneyTable("earn", "Earnings / Additions", earnings, s.earnings && s.earnings.total, "Total Earnings", height)}
  ${moneyTable("ded", "Deductions / Less", deductions, s.deductions && s.deductions.total, "Total Deductions", height)}
</div></section>
${cards.length ? `<div class="grid grid3">${cards.join("")}</div>` : ""}
<section class="final">
  ${icon("rupee", 34)}
  <div class="calc"><table>
    <tr><td class="k">Net Pay Before Rounding</td><td class="c">:</td><td class="v">${esc(inr(f.net_pay_before_rounding))}</td></tr>
    <tr><td class="k">Round-off</td><td class="c">:</td><td class="v">${esc(inr(f.net_pay_rounding))}</td></tr>
  </table></div>
  <div class="box"><div class="l">Final Net Pay</div><div class="amt">${esc(inr(f.net_pay))}</div></div>
</section>
<footer class="foot"><span>This is a system-generated payslip and does not require a signature.</span><span class="tag">THANK YOU<i>|</i>STAY SAFE<i>|</i>GROW TOGETHER</span></footer>
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

/**
 * SEVERAL PAYSLIPS IN ONE CHROME - the admin bulk export.
 *
 * One launch for the whole batch rather than one per payslip, under ONE slot
 * of the process-wide cap, so an export of twenty-five payslips costs one
 * browser and leaves the other slot for employees opening theirs. Each page is
 * the same `payslipHtml` the single download renders, so the PDFs are
 * byte-for-byte the same document the employee gets.
 *
 * @param {object[]} snapshots  frozen payslip snapshots
 * @returns {Promise<Buffer[]>}  one PDF per snapshot, in order
 */
async function renderPayslipPdfs(snapshots, deps = {}) {
  const withBrowser = deps.withBrowser || require("./pdf_browser").withBrowser;
  const pages = (snapshots || []).map((s) => payslipHtml(s));
  if (pages.length === 0) return [];
  await acquire();
  try {
    return await withBrowser(async (session) => {
      const out = [];
      for (const html of pages) out.push(await session.renderPdf(html, A4));
      return out;
    });
  } finally {
    release();
  }
}

module.exports = { payslipHtml, renderPayslipPdf, renderPayslipPdfs, inr, printable, esc, logoDataUri, LOGO_PATH };
