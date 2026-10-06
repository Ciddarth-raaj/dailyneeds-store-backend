const ExcelJS = require("exceljs");

const { monthLabel, MONTH_SHORT } = require("../constants/payslip");
const { PayrollReportError } = require("./payroll_report_query");
const denomination = require("./cash_denomination");

/**
 * Cash Payment report - the monthly workbook Accounts pays cash salaries from.
 *
 *   Sheet 1  Cash Denomination   employee-wise net pay with the note / coin
 *                                count for each, column totals, and the
 *                                month's denomination summary
 *   Sheet 2  Acknowledgement     employee-wise net pay with a blank signature
 *                                column for the physical acknowledgement
 *
 * A PRESENTATION OF THE FINALIZED PAYRUN, NOTHING MORE. Net pay is the stored
 * `payrun_employee_calculation.net_pay` of an APPROVED_LOCKED row, as the
 * Payroll Register shows it. Nothing here prices payroll, re-reads attendance
 * or rounds a figure: a net pay that is not a whole rupee refuses the file.
 *
 * ALL OR NOTHING, like the statutory files. A month in which any Cash employee
 * is not yet approved & locked is refused, because a cash sheet that silently
 * leaves somebody out is a person who does not get paid. Every check in
 * `prepare` must pass or no workbook is produced.
 *
 * Pure apart from ExcelJS: `prepare` takes rows, `buildWorkbook` returns a
 * Buffer. The SQL lives in `repository/payroll_report.js`.
 */

const FINALIZED = "APPROVED_LOCKED";
const CASH = "CASH";

const MESSAGES = Object.freeze({
  NOT_FINALIZED: "Cash Payment Report can be generated only after payroll is finalized.",
  NO_CASH_EMPLOYEES: "No employees with Cash payment mode found for this payroll month.",
});

const money = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
const paise = (n) => Math.round(n * 100);
const employeeRef = (r) => ({
  employee_id: Number(r.employee_id),
  employee_name: r.employee_name || null,
  outlet: r.store_name || null,
});

/** Outlet, then employee code: the same order every time for the same month. */
const byOutletThenCode = (a, b) => {
  const oa = (a.outlet || "").toLocaleUpperCase("en-IN");
  const ob = (b.outlet || "").toLocaleUpperCase("en-IN");
  if (oa !== ob) {
    if (!oa) return 1; // an employee with no outlet goes last, not first
    if (!ob) return -1;
    return oa < ob ? -1 : 1;
  }
  return a.employee_id - b.employee_id;
};

const integrity = (message, detail = {}) => new PayrollReportError(500, "CASH_REPORT_INTEGRITY", message, detail);

/**
 * Validate the month's Cash population and produce everything the workbook shows.
 *
 * @param period     { year, month }
 * @param rows       every payrun employee of the month (in scope) whose pay type
 *                   is CASH - `repository/payroll_report.js#listCashPayRows`
 * @param reference  the payrun's own independent read of the same population -
 *                   `{ finalized, cash: { employees, net_pay } }`
 */
function prepare({ period, rows, reference }) {
  if (!reference || !(Number(reference.finalized) > 0)) {
    throw new PayrollReportError(409, "PAYROLL_NOT_FINALIZED", MESSAGES.NOT_FINALIZED, { pending: [] });
  }
  if (rows.length === 0) {
    throw new PayrollReportError(404, "NO_CASH_EMPLOYEES", MESSAGES.NO_CASH_EMPLOYEES);
  }

  // 6. No Bank-transfer employee: the query asked for CASH; prove it.
  const notCash = rows.filter((r) => r.pay_type !== CASH);
  if (notCash.length) throw integrity("A non-Cash employee reached the Cash Payment report", { employees: notCash.map(employeeRef) });

  // 7. No duplicate employee.
  const seen = new Set();
  const duplicates = [];
  for (const r of rows) {
    const id = Number(r.employee_id);
    if (seen.has(id)) duplicates.push(employeeRef(r));
    seen.add(id);
  }
  if (duplicates.length) throw integrity("An employee appears more than once in the Cash population", { employees: duplicates });

  // Every Cash employee's month must be approved & locked.
  const pending = rows.filter((r) => r.status !== FINALIZED);
  if (pending.length) {
    throw new PayrollReportError(409, "PAYROLL_NOT_FINALIZED", MESSAGES.NOT_FINALIZED, {
      pending: pending.map((r) => ({ ...employeeRef(r), status: r.status || "NOT_CALCULATED" })),
    });
  }

  // A finalized row must carry a usable figure, already in whole rupees.
  const invalid = rows.filter((r) => !Number.isFinite(money(r.net_pay)));
  if (invalid.length) {
    throw new PayrollReportError(422, "INVALID_NET_PAY", "Some finalized Cash employees have no Net Pay recorded.", {
      employees: invalid.map(employeeRef),
    });
  }
  const fractional = rows.filter((r) => paise(money(r.net_pay)) % 100 !== 0);
  if (fractional.length) {
    throw new PayrollReportError(
      422,
      "NET_PAY_NOT_WHOLE_RUPEES",
      "Some finalized Net Pay figures are not in whole rupees, so they cannot be paid in cash. Recalculate and re-approve these employees so payroll's rupee rounding applies.",
      { employees: fractional.map((r) => ({ ...employeeRef(r), net_pay: money(r.net_pay) })) }
    );
  }

  // 8. Nothing to pay is not a cash payment: zero / negative net pay is left
  // out, and the file says how many and who.
  const excluded = rows
    .filter((r) => money(r.net_pay) <= 0)
    .map((r) => ({ ...employeeRef(r), net_pay: money(r.net_pay) }))
    .sort(byOutletThenCode);
  const employees = rows
    .filter((r) => money(r.net_pay) > 0)
    .map((r) => ({ ...employeeRef(r), net_pay: paise(money(r.net_pay)) / 100 }))
    .sort(byOutletThenCode)
    .map((e, i) => ({ sno: i + 1, ...e, counts: denomination.breakdown(e.net_pay) }));
  if (employees.length === 0) {
    throw new PayrollReportError(404, "NO_CASH_EMPLOYEES", MESSAGES.NO_CASH_EMPLOYEES, { excluded });
  }

  // 4. Each employee's breakup equals their net pay (breakdown checks it; so
  // does this, independently).
  for (const e of employees) {
    if (denomination.valueOf(e.counts) !== e.net_pay) throw integrity(`Denomination breakup for employee ${e.employee_id} does not equal Net Pay`);
  }

  const totalNetPay = employees.reduce((s, e) => s + e.net_pay, 0);
  const denominationTotals = denomination.totals(employees.map((e) => e.counts));
  const denominationAmount = denominationTotals.reduce((s, d) => s + d.amount, 0);

  // 5. Σ denomination value = report total.
  if (denominationAmount !== totalNetPay) {
    throw integrity("Total denomination amount does not equal Total Net Pay", { denomination_amount: denominationAmount, total_net_pay: totalNetPay });
  }
  // 1-3. Same employees and the same money as the payrun's own independent read.
  const refEmployees = Number(reference.cash && reference.cash.employees);
  const refNetPay = paise(Number(reference.cash && reference.cash.net_pay));
  if (refEmployees !== employees.length || refNetPay !== paise(totalNetPay)) {
    throw integrity("The Cash Payment report does not reconcile with finalized payroll", {
      report: { employees: employees.length, net_pay: totalNetPay },
      payroll: { employees: refEmployees, net_pay: refNetPay / 100 },
    });
  }

  return {
    period: { year: period.year, month: period.month, label: monthLabel(period.year, period.month) },
    employees,
    excluded,
    total_net_pay: totalNetPay,
    denomination_totals: denominationTotals,
    denomination_amount: denominationAmount,
  };
}

/** `Cash Payment - Aug 2026.xlsx` */
const filename = (period) => `Cash Payment - ${MONTH_SHORT[period.month - 1]} ${period.year}.xlsx`;

/* ============================================================== workbook */

/** Indian digit grouping (12,34,567) in Excel's own number-format language. */
const INR = '[>=10000000]"₹"##\\,##\\,##\\,##0;[>=100000]"₹"##\\,##\\,##0;"₹"##,##0';
const COUNT = '#,##0;-#,##0;"-"';

const FONT = "Calibri";
const THIN = { style: "thin", color: { argb: "FF808080" } };
const BORDER = { top: THIN, left: THIN, bottom: THIN, right: THIN };
const HEADER_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9E1F2" } };
const TOTAL_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF2F2F2" } };

/** Text a spreadsheet must never evaluate: a leading = + - @ is neutralised. */
const safeText = (v) => {
  if (v === null || v === undefined) return "";
  const t = String(v);
  return /^[=+\-@\t\r]/.test(t) ? `'${t}` : t;
};

const colLetter = (n) => {
  let s = "";
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
};

function styleRange(ws, row, fromCol, toCol, style) {
  for (let c = fromCol; c <= toCol; c += 1) Object.assign(ws.getCell(row, c), style);
}

function titleBlock(ws, lastCol, lines) {
  lines.forEach((line, i) => {
    const row = i + 1;
    ws.mergeCells(row, 1, row, lastCol);
    const cell = ws.getCell(row, 1);
    cell.value = line.text;
    cell.font = { name: FONT, bold: Boolean(line.bold), size: line.size || 10, italic: Boolean(line.italic) };
    cell.alignment = { horizontal: "center", vertical: "middle" };
    ws.getRow(row).height = line.height || 16;
  });
}

function pageSetup(ws, { orientation, lastCol, lastRow, titleRows }) {
  ws.pageSetup = {
    paperSize: 9, // A4
    orientation,
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0, // as many pages tall as needed, never wider than one
    horizontalCentered: true,
    margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.6, header: 0.3, footer: 0.3 },
    printArea: `A1:${colLetter(lastCol)}${lastRow}`,
    printTitlesRow: titleRows,
  };
  ws.headerFooter = { oddFooter: "&L&8&A&R&8Page &P of &N" };
}

const EMPLOYEE_COLUMNS = [
  { header: "S.No", width: 6 },
  { header: "Employee Code", width: 11 },
  { header: "Employee Name", width: 28 },
  { header: "Location / Outlet", width: 22 },
  { header: "Net Pay", width: 13 },
];

function denominationSheet(wb, data) {
  const denoms = denomination.DENOMINATIONS;
  const firstDenomCol = EMPLOYEE_COLUMNS.length + 1;
  const lastCol = EMPLOYEE_COLUMNS.length + denoms.length;
  const ws = wb.addWorksheet("Cash Denomination", { views: [{ state: "frozen", xSplit: 3, ySplit: 5 }] });

  titleBlock(ws, lastCol, [
    { text: "CASH SALARY PAYMENT - DENOMINATION", bold: true, size: 14, height: 22 },
    { text: `Payroll Month: ${data.period.label}`, bold: true, size: 11, height: 18 },
    { text: `Finalized payroll (Approved & Locked) - Cash payment mode only. Employees: ${data.employees.length}.`, italic: true, size: 9 },
  ]);

  // Two header rows: the employee columns span both, the denominations sit
  // under one "No. of Notes / Coins" band.
  const H1 = 4;
  const H2 = 5;
  EMPLOYEE_COLUMNS.forEach((c, i) => {
    ws.mergeCells(H1, i + 1, H2, i + 1);
    ws.getCell(H1, i + 1).value = c.header;
    ws.getColumn(i + 1).width = c.width;
  });
  ws.mergeCells(H1, firstDenomCol, H1, lastCol);
  ws.getCell(H1, firstDenomCol).value = "Denomination (No. of Notes / Coins)";
  denoms.forEach((d, i) => {
    ws.getCell(H2, firstDenomCol + i).value = `₹${d}`;
    ws.getColumn(firstDenomCol + i).width = 9.5;
  });
  for (const r of [H1, H2]) {
    styleRange(ws, r, 1, lastCol, {
      font: { name: FONT, bold: true, size: 10 },
      fill: HEADER_FILL,
      border: BORDER,
      alignment: { horizontal: "center", vertical: "middle", wrapText: true },
    });
    ws.getRow(r).height = 18;
  }

  const firstData = H2 + 1;
  data.employees.forEach((e, i) => {
    const r = firstData + i;
    const row = ws.getRow(r);
    row.values = [e.sno, e.employee_id, safeText(e.employee_name), safeText(e.outlet), e.net_pay, ...denoms.map((d) => e.counts[d])];
    row.height = 16;
    styleRange(ws, r, 1, lastCol, { font: { name: FONT, size: 10 }, border: BORDER });
    ws.getCell(r, 1).alignment = { horizontal: "center" };
    ws.getCell(r, 2).alignment = { horizontal: "center" };
    ws.getCell(r, 3).alignment = { indent: 1 };
    ws.getCell(r, 4).alignment = { indent: 1 };
    ws.getCell(r, 5).numFmt = INR;
    for (let c = firstDenomCol; c <= lastCol; c += 1) {
      ws.getCell(r, c).numFmt = COUNT;
      ws.getCell(r, c).alignment = { horizontal: "center" };
    }
  });
  const lastData = firstData + data.employees.length - 1;

  // Column totals: the count of each denomination, then what that count is worth.
  const totalRow = lastData + 1;
  const amountRow = lastData + 2;
  ws.mergeCells(totalRow, 1, totalRow, 4);
  ws.getCell(totalRow, 1).value = "Total";
  ws.getCell(totalRow, 5).value = { formula: `SUM(E${firstData}:E${lastData})`, result: data.total_net_pay };
  ws.mergeCells(amountRow, 1, amountRow, 5);
  ws.getCell(amountRow, 1).value = "Denomination Amount (₹)";
  data.denomination_totals.forEach((t, i) => {
    const col = colLetter(firstDenomCol + i);
    ws.getCell(totalRow, firstDenomCol + i).value = { formula: `SUM(${col}${firstData}:${col}${lastData})`, result: t.count };
    ws.getCell(amountRow, firstDenomCol + i).value = { formula: `${col}${totalRow}*${t.denomination}`, result: t.amount };
  });
  for (const r of [totalRow, amountRow]) {
    styleRange(ws, r, 1, lastCol, { font: { name: FONT, bold: true, size: 10 }, fill: TOTAL_FILL, border: BORDER });
    ws.getCell(r, 1).alignment = { horizontal: "right" };
    ws.getRow(r).height = 18;
  }
  ws.getCell(totalRow, 5).numFmt = INR;
  for (let c = firstDenomCol; c <= lastCol; c += 1) {
    ws.getCell(totalRow, c).numFmt = COUNT;
    ws.getCell(totalRow, c).alignment = { horizontal: "center" };
    ws.getCell(amountRow, c).numFmt = INR;
    ws.getCell(amountRow, c).alignment = { horizontal: "right", shrinkToFit: true };
  }

  // The month's summary: total notes / coins Accounts must draw, and the check
  // that they add up to the net pay being paid.
  const S = amountRow + 2;
  ws.mergeCells(S, 3, S, 5);
  ws.getCell(S, 3).value = "Total Notes / Coins Required";
  ws.getCell(S, 3).font = { name: FONT, bold: true, size: 11 };
  const SH = S + 1;
  ["Denomination", "Qty", "Amount"].forEach((h, i) => {
    ws.getCell(SH, 3 + i).value = h;
  });
  styleRange(ws, SH, 3, 5, {
    font: { name: FONT, bold: true, size: 10 },
    fill: HEADER_FILL,
    border: BORDER,
    alignment: { horizontal: "center" },
  });
  data.denomination_totals.forEach((t, i) => {
    const r = SH + 1 + i;
    const col = colLetter(firstDenomCol + i);
    ws.getCell(r, 3).value = `₹${t.denomination}`;
    ws.getCell(r, 4).value = { formula: `${col}${totalRow}`, result: t.count };
    ws.getCell(r, 5).value = { formula: `D${r}*${t.denomination}`, result: t.amount };
    styleRange(ws, r, 3, 5, { font: { name: FONT, size: 10 }, border: BORDER });
    ws.getCell(r, 3).alignment = { horizontal: "center" };
    ws.getCell(r, 4).numFmt = COUNT;
    ws.getCell(r, 4).alignment = { horizontal: "center" };
    ws.getCell(r, 5).numFmt = INR;
  });
  const firstSummary = SH + 1;
  const lastSummary = SH + data.denomination_totals.length;
  const grandRow = lastSummary + 1;
  const netRow = grandRow + 1;
  const diffRow = grandRow + 2;
  const summaryTotals = [
    [grandRow, "Grand Cash Required", { formula: `SUM(E${firstSummary}:E${lastSummary})`, result: data.denomination_amount }],
    [netRow, "Total Net Pay", { formula: `E${totalRow}`, result: data.total_net_pay }],
    [diffRow, "Difference (must be 0)", { formula: `E${grandRow}-E${netRow}`, result: data.denomination_amount - data.total_net_pay }],
  ];
  for (const [r, label, value] of summaryTotals) {
    ws.mergeCells(r, 3, r, 4);
    ws.getCell(r, 3).value = label;
    ws.getCell(r, 5).value = value;
    styleRange(ws, r, 3, 5, { font: { name: FONT, bold: true, size: 10 }, fill: TOTAL_FILL, border: BORDER });
    ws.getCell(r, 3).alignment = { horizontal: "right" };
    ws.getCell(r, 5).numFmt = INR;
  }
  let lastRow = diffRow;

  if (data.excluded.length) {
    lastRow += 2;
    ws.mergeCells(lastRow, 1, lastRow, lastCol);
    ws.getCell(lastRow, 1).value = `Not included - zero or negative Net Pay (nothing payable in cash): ${data.excluded
      .map((e) => `${e.employee_id} ${safeText(e.employee_name)} (${e.net_pay})`)
      .join(", ")}`;
    ws.getCell(lastRow, 1).font = { name: FONT, italic: true, size: 9 };
    ws.getCell(lastRow, 1).alignment = { wrapText: true, vertical: "top" };
    ws.getRow(lastRow).height = 30;
  }

  pageSetup(ws, { orientation: "landscape", lastCol, lastRow, titleRows: `${H1}:${H2}` });
  return ws;
}

function acknowledgementSheet(wb, data) {
  const columns = [...EMPLOYEE_COLUMNS, { header: "Employee Signature", width: 30 }];
  const lastCol = columns.length;
  const ws = wb.addWorksheet("Acknowledgement", { views: [{ state: "frozen", ySplit: 4 }] });

  titleBlock(ws, lastCol, [
    { text: "CASH SALARY ACKNOWLEDGEMENT", bold: true, size: 14, height: 22 },
    { text: `Payroll Month: ${data.period.label}`, bold: true, size: 11, height: 18 },
    { text: "Received the Net Pay shown against my name in cash.", italic: true, size: 9 },
  ]);

  const H = 4;
  columns.forEach((c, i) => {
    ws.getCell(H, i + 1).value = c.header;
    ws.getColumn(i + 1).width = c.width;
  });
  styleRange(ws, H, 1, lastCol, {
    font: { name: FONT, bold: true, size: 10 },
    fill: HEADER_FILL,
    border: BORDER,
    alignment: { horizontal: "center", vertical: "middle", wrapText: true },
  });
  ws.getRow(H).height = 20;

  const firstData = H + 1;
  data.employees.forEach((e, i) => {
    const r = firstData + i;
    ws.getRow(r).values = [e.sno, e.employee_id, safeText(e.employee_name), safeText(e.outlet), e.net_pay, null];
    // Tall enough to sign in.
    ws.getRow(r).height = 30;
    styleRange(ws, r, 1, lastCol, { font: { name: FONT, size: 10 }, border: BORDER, alignment: { vertical: "middle" } });
    ws.getCell(r, 1).alignment = { horizontal: "center", vertical: "middle" };
    ws.getCell(r, 2).alignment = { horizontal: "center", vertical: "middle" };
    ws.getCell(r, 3).alignment = { vertical: "middle", indent: 1 };
    ws.getCell(r, 4).alignment = { vertical: "middle", indent: 1 };
    ws.getCell(r, 5).numFmt = INR;
  });
  const lastData = firstData + data.employees.length - 1;

  const totalRow = lastData + 1;
  ws.mergeCells(totalRow, 1, totalRow, 4);
  ws.getCell(totalRow, 1).value = "Total";
  ws.getCell(totalRow, 5).value = { formula: `SUM(E${firstData}:E${lastData})`, result: data.total_net_pay };
  styleRange(ws, totalRow, 1, lastCol, { font: { name: FONT, bold: true, size: 10 }, fill: TOTAL_FILL, border: BORDER });
  ws.getCell(totalRow, 1).alignment = { horizontal: "right" };
  ws.getCell(totalRow, 5).numFmt = INR;
  ws.getRow(totalRow).height = 20;

  // Who paid it out and who checked it.
  const signRow = totalRow + 3;
  [
    [1, 2, "Paid by"],
    [3, 4, "Verified by"],
    [5, 6, "Approved by"],
  ].forEach(([from, to, label]) => {
    ws.mergeCells(signRow, from, signRow, to);
    const cell = ws.getCell(signRow, from);
    cell.value = label;
    cell.font = { name: FONT, bold: true, size: 10 };
    cell.alignment = { horizontal: "center" };
    cell.border = { top: THIN };
  });

  pageSetup(ws, { orientation: "portrait", lastCol, lastRow: signRow, titleRows: `${H}:${H}` });
  return ws;
}

async function buildWorkbook(data) {
  const wb = new ExcelJS.Workbook();
  // Fixed metadata: the same month exports the same workbook.
  const stamp = new Date(Date.UTC(data.period.year, data.period.month - 1, 1));
  wb.creator = "Payroll";
  wb.created = stamp;
  wb.modified = stamp;
  denominationSheet(wb, data);
  acknowledgementSheet(wb, data);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { MESSAGES, prepare, buildWorkbook, filename, INR, COUNT };
