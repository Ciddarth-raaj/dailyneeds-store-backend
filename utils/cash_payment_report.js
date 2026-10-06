const ExcelJS = require("exceljs");

const { monthLabel, MONTH_SHORT } = require("../constants/payslip");
const { PayrollReportError } = require("./payroll_report_query");
const denomination = require("./cash_denomination");

/**
 * Cash Payment report - the monthly workbook Accounts pays cash salaries from.
 *
 *   Sheet 1  Cash Denomination            employee-wise net pay with the note /
 *                                         coin count for each, and column totals
 *   Sheet 2  Denomination Total           the month's notes / coins required,
 *                                         Grand Cash Required = Total Net Pay
 *   Sheet 3  Cash Salary Acknowledgement  employee-wise net pay with a blank
 *                                         signature column
 *
 * THE LAYOUT IS THE AUGUST 2026 WORKBOOK ACCOUNTS ALREADY USED
 * ("PayrollSummaryReport for Aug26.xlsx"): company name and "<report> - <Mon
 * YYYY>" banners, one bordered header row with an autofilter, S.No restarting
 * per location, the denominations as live ROUNDDOWN formulas with a per-row
 * Total check, and a SUBTOTAL total row - so filtering one location gives that
 * location's cash. Added to it: S.No and Location on the denomination sheet,
 * Indian rupee formats, the Denomination Total sheet and the print setup.
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

const outletKey = (e) => (e.outlet || "").toLocaleUpperCase("en-IN");

/** Outlet, then employee code: the same order every time for the same month. */
const byOutletThenCode = (a, b) => {
  const oa = outletKey(a);
  const ob = outletKey(b);
  if (oa !== ob) {
    if (!oa) return 1; // an employee with no outlet goes last, not first
    if (!ob) return -1;
    return oa < ob ? -1 : 1;
  }
  return a.employee_id - b.employee_id;
};

/**
 * S.No restarts at 1 for each outlet, as on the August workbook Accounts
 * already uses: cash is counted out location by location.
 */
const numberWithinOutlet = (e, i, list) => {
  let sno = 1;
  for (let j = i - 1; j >= 0 && outletKey(list[j]) === outletKey(e); j -= 1) sno += 1;
  return { sno, ...e };
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
    .map(numberWithinOutlet)
    .map((e) => ({ ...e, counts: denomination.breakdown(e.net_pay) }));
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

// The August workbook's look: Calibri, thin black borders, no shading.
const FONT = "Calibri";
const THIN = { style: "thin", color: { argb: "FF000000" } };
const BORDER = { top: THIN, left: THIN, bottom: THIN, right: THIN };

const SHEET = Object.freeze({
  DENOMINATION: "Cash Denomination",
  TOTAL: "Denomination Total",
  ACKNOWLEDGEMENT: "Cash Salary Acknowledgement",
});

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

function style(ws, row, fromCol, toCol, props) {
  for (let c = fromCol; c <= toCol; c += 1) Object.assign(ws.getCell(row, c), props);
}

/** Row 1 the company, row 2 "<report> - <Mon YYYY>", both across the sheet, bordered, as in August. */
function banner(ws, lastCol, { company, title, period, sizes }) {
  const lines = [company, `${title} - ${MONTH_SHORT[period.month - 1]} ${period.year}`];
  lines.forEach((text, i) => {
    const row = i + 1;
    ws.mergeCells(row, 1, row, lastCol);
    style(ws, row, 1, lastCol, { border: BORDER });
    const cell = ws.getCell(row, 1);
    cell.value = safeText(text);
    cell.font = { name: FONT, bold: true, size: sizes[i] };
    cell.alignment = { horizontal: "center", vertical: "middle" };
    ws.getRow(row).height = sizes[i] + 5;
  });
}

function header(ws, row, columns, { size, height }) {
  columns.forEach((c, i) => {
    ws.getCell(row, i + 1).value = c.header;
    ws.getColumn(i + 1).width = c.width;
  });
  style(ws, row, 1, columns.length, {
    font: { name: FONT, bold: true, size },
    border: BORDER,
    alignment: { horizontal: "center", vertical: "middle", wrapText: true },
  });
  ws.getRow(row).height = height;
}

function pageSetup(ws, { orientation, lastCol, lastRow, headerRow }) {
  ws.pageSetup = {
    paperSize: 9, // A4, as August
    orientation,
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0, // as many pages tall as needed, never wider than one
    horizontalCentered: true,
    margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.6, header: 0.3, footer: 0.3 },
    printArea: `A1:${colLetter(lastCol)}${lastRow}`,
    printTitlesRow: `${headerRow}:${headerRow}`,
  };
  ws.headerFooter = { oddFooter: "&L&8&A&R&8Page &P of &N" };
}

const HEADER_ROW = 3;
const FIRST_DATA = HEADER_ROW + 1;

/** One employee's denomination cells as August had them: live formulas, each on what the larger ones left. */
function denominationFormula(r, k, firstDenomCol) {
  const denoms = denomination.DENOMINATIONS;
  const taken = denoms.slice(0, k).map((d, j) => `-${d}*${colLetter(firstDenomCol + j)}${r}`).join("");
  return `ROUNDDOWN((E${r}${taken})/${denoms[k]},0)`;
}

function denominationSheet(wb, data) {
  const denoms = denomination.DENOMINATIONS;
  const columns = [
    { header: "S.No", width: 6 },
    { header: "Employee Code", width: 9.5 },
    { header: "Employee Name", width: 27 },
    { header: "Location / Outlet", width: 15 },
    { header: "Net Pay", width: 11 },
    ...denoms.map((d) => ({ header: `₹${d}`, width: 7.5 })),
    { header: "Total", width: 11 },
  ];
  const firstDenomCol = 6;
  const totalCol = columns.length;
  const ws = wb.addWorksheet(SHEET.DENOMINATION, { views: [{ state: "frozen", ySplit: HEADER_ROW }] });

  banner(ws, totalCol, { company: data.company, title: "Cash Payment Denomination", period: data.period, sizes: [16, 12] });
  header(ws, HEADER_ROW, columns, { size: 11, height: 30 });

  data.employees.forEach((e, i) => {
    const r = FIRST_DATA + i;
    const row = ws.getRow(r);
    row.values = [e.sno, e.employee_id, safeText(e.employee_name), safeText(e.outlet), e.net_pay];
    denoms.forEach((d, k) => {
      row.getCell(firstDenomCol + k).value = { formula: denominationFormula(r, k, firstDenomCol), result: e.counts[d] };
    });
    const parts = denoms.map((d, k) => `${d}*${colLetter(firstDenomCol + k)}${r}`).join(",");
    row.getCell(totalCol).value = { formula: `SUM(${parts})`, result: e.net_pay };
    style(ws, r, 1, totalCol, { font: { name: FONT, size: 10 }, border: BORDER, alignment: { vertical: "middle" } });
    ws.getCell(r, 1).alignment = { horizontal: "center", vertical: "middle" };
    ws.getCell(r, 2).alignment = { horizontal: "left", vertical: "middle" };
    ws.getCell(r, 5).numFmt = INR;
    ws.getCell(r, 5).alignment = { horizontal: "center", vertical: "middle" };
    for (let c = firstDenomCol; c < totalCol; c += 1) {
      ws.getCell(r, c).numFmt = COUNT;
      ws.getCell(r, c).alignment = { horizontal: "center", vertical: "middle" };
    }
    ws.getCell(r, totalCol).numFmt = INR;
    ws.getCell(r, totalCol).alignment = { horizontal: "center", vertical: "middle" };
  });
  const lastData = FIRST_DATA + data.employees.length - 1;
  ws.autoFilter = { from: { row: HEADER_ROW, column: 1 }, to: { row: lastData, column: totalCol } };

  // SUBTOTAL, not SUM: with the autofilter on one location, the totals are
  // that location's cash - what August's SUBTOTAL row was there for.
  const totalRow = lastData + 1;
  const amountRow = lastData + 2;
  const subtotal = (c) => `SUBTOTAL(9,${colLetter(c)}${FIRST_DATA}:${colLetter(c)}${lastData})`;
  ws.mergeCells(totalRow, 1, totalRow, 4);
  ws.getCell(totalRow, 1).value = "Total";
  ws.getCell(totalRow, 5).value = { formula: subtotal(5), result: data.total_net_pay };
  data.denomination_totals.forEach((t, i) => {
    ws.getCell(totalRow, firstDenomCol + i).value = { formula: subtotal(firstDenomCol + i), result: t.count };
  });
  ws.getCell(totalRow, totalCol).value = { formula: subtotal(totalCol), result: data.denomination_amount };
  ws.mergeCells(amountRow, 1, amountRow, 5);
  ws.getCell(amountRow, 1).value = "Denomination Amount";
  data.denomination_totals.forEach((t, i) => {
    const col = colLetter(firstDenomCol + i);
    ws.getCell(amountRow, firstDenomCol + i).value = { formula: `${col}${totalRow}*${t.denomination}`, result: t.amount };
  });
  ws.getCell(amountRow, totalCol).value = {
    formula: `SUM(${colLetter(firstDenomCol)}${amountRow}:${colLetter(totalCol - 1)}${amountRow})`,
    result: data.denomination_amount,
  };
  for (const r of [totalRow, amountRow]) {
    style(ws, r, 1, totalCol, { font: { name: FONT, bold: true, size: 10 }, border: BORDER, alignment: { horizontal: "center", vertical: "middle" } });
    ws.getCell(r, 1).alignment = { horizontal: "left", vertical: "middle" };
    ws.getRow(r).height = 16;
  }
  ws.getCell(totalRow, 5).numFmt = INR;
  ws.getCell(totalRow, totalCol).numFmt = INR;
  ws.getCell(amountRow, totalCol).numFmt = INR;
  for (let c = firstDenomCol; c < totalCol; c += 1) {
    ws.getCell(totalRow, c).numFmt = COUNT;
    ws.getCell(amountRow, c).numFmt = INR;
    ws.getCell(amountRow, c).alignment = { horizontal: "center", vertical: "middle", shrinkToFit: true };
  }

  pageSetup(ws, { orientation: "landscape", lastCol: totalCol, lastRow: amountRow, headerRow: HEADER_ROW });
  return { ws, firstData: FIRST_DATA, lastData, netPayCol: 5, firstDenomCol };
}

/**
 * The month's totals on a sheet of their own: the notes / coins Accounts
 * must draw, and the check that they add up to the net pay being paid. Read
 * from the denomination sheet with SUM, not SUBTOTAL, so a location filter
 * there never changes the month's total here.
 */
function totalSheet(wb, data, grid) {
  const columns = [
    { header: "Denomination", width: 16 },
    { header: "Qty", width: 16 },
    { header: "Amount", width: 18 },
  ];
  const lastCol = columns.length;
  const ws = wb.addWorksheet(SHEET.TOTAL, { views: [{ state: "frozen", ySplit: HEADER_ROW }] });
  banner(ws, lastCol, { company: data.company, title: "Total Notes / Coins Required", period: data.period, sizes: [14, 12] });
  header(ws, HEADER_ROW, columns, { size: 11, height: 20 });

  const source = `'${SHEET.DENOMINATION}'!`;
  const range = (col) => `${source}${colLetter(col)}${grid.firstData}:${colLetter(col)}${grid.lastData}`;
  const figure = (r, c, value, numFmt, bold = false) => {
    const cell = ws.getCell(r, c);
    cell.value = value;
    cell.numFmt = numFmt;
    cell.font = { name: FONT, size: 11, bold };
    cell.border = BORDER;
    cell.alignment = { horizontal: "center", vertical: "middle" };
  };

  data.denomination_totals.forEach((t, i) => {
    const r = FIRST_DATA + i;
    const label = ws.getCell(r, 1);
    label.value = `₹${t.denomination}`;
    label.font = { name: FONT, size: 11, bold: true };
    label.border = BORDER;
    label.alignment = { horizontal: "center", vertical: "middle" };
    figure(r, 2, { formula: `SUM(${range(grid.firstDenomCol + i)})`, result: t.count }, COUNT);
    figure(r, 3, { formula: `B${r}*${t.denomination}`, result: t.amount }, INR);
    ws.getRow(r).height = 18;
  });
  const lastDenom = FIRST_DATA + data.denomination_totals.length - 1;
  const grandRow = lastDenom + 1;
  const netRow = grandRow + 1;
  const diffRow = grandRow + 2;
  [
    [grandRow, "Grand Cash Required", { formula: `SUM(C${FIRST_DATA}:C${lastDenom})`, result: data.denomination_amount }, INR],
    [netRow, "Total Net Pay", { formula: `SUM(${range(grid.netPayCol)})`, result: data.total_net_pay }, INR],
    [diffRow, "Difference (must be 0)", { formula: `C${grandRow}-C${netRow}`, result: data.denomination_amount - data.total_net_pay }, INR],
  ].forEach(([r, label, value, numFmt]) => {
    ws.mergeCells(r, 1, r, 2);
    style(ws, r, 1, 2, { border: BORDER });
    const cell = ws.getCell(r, 1);
    cell.value = label;
    cell.font = { name: FONT, size: 11, bold: true };
    cell.alignment = { horizontal: "right", vertical: "middle" };
    figure(r, 3, value, numFmt, true);
    ws.getRow(r).height = 20;
  });
  let lastRow = diffRow;

  if (data.excluded.length) {
    lastRow += 2;
    ws.mergeCells(lastRow, 1, lastRow, lastCol);
    ws.getCell(lastRow, 1).value = `Not included - zero or negative Net Pay (nothing payable in cash): ${data.excluded
      .map((e) => `${e.employee_id} ${safeText(e.employee_name)} (${e.net_pay})`)
      .join(", ")}`;
    ws.getCell(lastRow, 1).font = { name: FONT, italic: true, size: 9 };
    ws.getCell(lastRow, 1).alignment = { wrapText: true, vertical: "top" };
    ws.getRow(lastRow).height = 15 * Math.min(6, Math.ceil(data.excluded.length / 2) + 1);
  }

  pageSetup(ws, { orientation: "portrait", lastCol, lastRow, headerRow: HEADER_ROW });
  return ws;
}

function acknowledgementSheet(wb, data) {
  // August's columns and widths; "Category Name" there is the location.
  const columns = [
    { header: "S.No", width: 9 },
    { header: "Employee Code", width: 17.8 },
    { header: "Employee Name", width: 27 },
    { header: "Location / Outlet", width: 17.7 },
    { header: "Net Pay", width: 11.6 },
    { header: "Employee Signature", width: 27.6 },
  ];
  const lastCol = columns.length;
  const ws = wb.addWorksheet(SHEET.ACKNOWLEDGEMENT, { views: [{ state: "frozen", ySplit: HEADER_ROW }] });

  banner(ws, lastCol, { company: data.company, title: "Cash Salary Acknowledgement", period: data.period, sizes: [14, 14] });
  header(ws, HEADER_ROW, columns, { size: 10, height: 19.2 });

  data.employees.forEach((e, i) => {
    const r = FIRST_DATA + i;
    ws.getRow(r).values = [e.sno, e.employee_id, safeText(e.employee_name), safeText(e.outlet), e.net_pay, null];
    // Room for a signature.
    ws.getRow(r).height = 24;
    style(ws, r, 1, lastCol, { font: { name: FONT, size: 10 }, border: BORDER, alignment: { horizontal: "left", vertical: "middle" } });
    ws.getCell(r, 1).alignment = { horizontal: "center", vertical: "middle" };
    ws.getCell(r, 5).alignment = { horizontal: "center", vertical: "middle" };
    ws.getCell(r, 5).numFmt = INR;
  });
  const lastData = FIRST_DATA + data.employees.length - 1;
  ws.autoFilter = { from: { row: HEADER_ROW, column: 1 }, to: { row: lastData, column: lastCol } };

  const totalRow = lastData + 1;
  ws.mergeCells(totalRow, 1, totalRow, 4);
  ws.getCell(totalRow, 1).value = "Total";
  ws.getCell(totalRow, 5).value = { formula: `SUBTOTAL(9,E${FIRST_DATA}:E${lastData})`, result: data.total_net_pay };
  style(ws, totalRow, 1, lastCol, { font: { name: FONT, bold: true, size: 10 }, border: BORDER, alignment: { horizontal: "left", vertical: "middle" } });
  ws.getCell(totalRow, 5).alignment = { horizontal: "center", vertical: "middle" };
  ws.getCell(totalRow, 5).numFmt = INR;
  ws.getRow(totalRow).height = 18;

  pageSetup(ws, { orientation: "landscape", lastCol, lastRow: totalRow, headerRow: HEADER_ROW });
  return ws;
}

/** @param data `prepare`'s result plus `company`, the name for the banner. */
async function buildWorkbook(data) {
  const wb = new ExcelJS.Workbook();
  // Fixed metadata: the same month exports the same workbook.
  const stamp = new Date(Date.UTC(data.period.year, data.period.month - 1, 1));
  wb.creator = "Payroll";
  wb.created = stamp;
  wb.modified = stamp;
  const content = { ...data, company: data.company || "Cash Salary Payment" };
  const grid = denominationSheet(wb, content);
  totalSheet(wb, content, grid);
  acknowledgementSheet(wb, content);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { MESSAGES, SHEET, prepare, buildWorkbook, filename, INR, COUNT };
