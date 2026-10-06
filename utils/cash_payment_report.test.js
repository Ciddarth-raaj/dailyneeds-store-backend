/**
 * Cash Payment report - the checks and the workbook.
 *
 *   node --test utils/cash_payment_report.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const ExcelJS = require("exceljs");

const cash = require("./cash_payment_report");

const AUG = { year: 2026, month: 8 };

const row = (id, net_pay, over = {}) => ({
  employee_id: id,
  employee_name: `Employee ${id}`,
  store_name: "Anna Nagar",
  status: "APPROVED_LOCKED",
  pay_type: "CASH",
  net_pay: net_pay === null ? null : Number(net_pay).toFixed(2), // DECIMAL(12,2) arrives as a string
  ...over,
});

/** The payrun's own independent read, consistent with the rows. */
const referenceFor = (rows) => {
  const payable = rows.filter(
    (r) => r.status === "APPROVED_LOCKED" && r.pay_type === "CASH" && Number(r.net_pay) > 0 && r.employment_type !== "Contract"
  );
  return {
    finalized: Math.max(1, payable.length),
    cash: { employees: payable.length, net_pay: payable.reduce((s, r) => s + Number(r.net_pay), 0) },
  };
};

const prepare = (rows, reference = referenceFor(rows)) => cash.prepare({ period: AUG, rows, reference });

describe("prepare - population and order", () => {
  it("lists every finalized Cash employee, sorted by outlet then employee code, S.No restarting per outlet", () => {
    const rows = [row(30, 12345, { store_name: "Velachery" }), row(12, 18760), row(5, 700, { store_name: "velachery" }), row(7, 500)];
    const data = prepare(rows);
    assert.deepEqual(
      data.employees.map((e) => [e.sno, e.employee_id, e.outlet]),
      [
        [1, 7, "Anna Nagar"],
        [2, 12, "Anna Nagar"],
        [1, 5, "velachery"],
        [2, 30, "Velachery"],
      ]
    );
    assert.equal(data.period.label, "August 2026");
  });

  it("is deterministic: any input order gives the same output", () => {
    const rows = [row(3, 999, { store_name: "B" }), row(1, 500, { store_name: "A" }), row(2, 1, { store_name: null })];
    const a = prepare(rows);
    const b = prepare([...rows].reverse());
    assert.deepEqual(a, b);
    assert.equal(a.employees[2].employee_id, 2, "an employee with no outlet is listed last");
  });

  it("uses the stored net pay as is", () => {
    const data = prepare([row(1, 18760)]);
    assert.equal(data.employees[0].net_pay, 18760);
    assert.deepEqual(data.employees[0].counts, { 500: 37, 200: 1, 100: 0, 50: 1, 20: 0, 10: 1, 5: 0, 2: 0, 1: 0 });
  });
});

describe("prepare - totals", () => {
  it("totals net pay and every denomination across employees, and they agree", () => {
    const data = prepare([row(1, 18760), row(2, 12345), row(3, 999), row(4, 700), row(5, 500), row(6, 1)]);
    const expected = 18760 + 12345 + 999 + 700 + 500 + 1;
    assert.equal(data.total_net_pay, expected);
    assert.equal(data.denomination_amount, expected);
    const byD = Object.fromEntries(data.denomination_totals.map((t) => [t.denomination, t.count]));
    assert.deepEqual(byD, { 500: 37 + 24 + 1 + 1 + 1, 200: 1 + 1 + 2 + 1, 100: 1, 50: 1 + 1, 20: 2 + 2, 10: 1, 5: 1 + 1, 2: 2, 1: 1 });
    for (const t of data.denomination_totals) assert.equal(t.amount, t.count * t.denomination);
  });
});

describe("prepare - refusals", () => {
  const refused = (fn, code, status) => assert.throws(fn, (e) => e.code === code && (status === undefined || e.httpCode === status));

  it("a month with nothing finalized is refused with the finalization message", () => {
    assert.throws(
      () => prepare([row(1, 500)], { finalized: 0, cash: { employees: 0, net_pay: 0 } }),
      (e) => e.code === "PAYROLL_NOT_FINALIZED" && e.httpCode === 409 && e.message === cash.MESSAGES.NOT_FINALIZED
    );
  });

  it("any Cash employee not yet approved & locked refuses the whole file, naming them", () => {
    const rows = [row(1, 500), row(2, null, { status: "CALCULATED" }), row(3, null, { status: null })];
    assert.throws(
      () => prepare(rows),
      (e) =>
        e.code === "PAYROLL_NOT_FINALIZED" &&
        e.message === cash.MESSAGES.NOT_FINALIZED &&
        e.detail.pending.map((p) => [p.employee_id, p.status]).join() === "2,CALCULATED,3,NOT_CALCULATED"
    );
  });

  it("no Cash employees gives the no-employees message, not an empty workbook", () => {
    assert.throws(() => prepare([]), (e) => e.code === "NO_CASH_EMPLOYEES" && e.message === cash.MESSAGES.NO_CASH_EMPLOYEES);
  });

  it("a Bank employee reaching the report is an integrity failure", () => {
    refused(() => prepare([row(1, 500), row(2, 700, { pay_type: "BANK" })]), "CASH_REPORT_INTEGRITY", 500);
  });

  it("a duplicate employee is an integrity failure", () => {
    refused(() => prepare([row(1, 500), row(1, 500)]), "CASH_REPORT_INTEGRITY");
  });

  it("a net pay in paise is refused, not rounded", () => {
    assert.throws(
      () => prepare([row(1, 500), row(2, 700.5)]),
      (e) => e.code === "NET_PAY_NOT_WHOLE_RUPEES" && e.detail.employees[0].employee_id === 2 && e.detail.employees[0].net_pay === 700.5
    );
  });

  it("a finalized row without a net pay is refused", () => {
    refused(() => prepare([row(1, null)]), "INVALID_NET_PAY", 422);
  });

  it("zero and negative net pay are left out and listed, not paid", () => {
    const data = prepare([row(1, 500), row(2, 0), row(3, -250)]);
    assert.deepEqual(data.employees.map((e) => e.employee_id), [1]);
    assert.deepEqual(data.excluded.map((e) => [e.employee_id, e.net_pay]), [[2, 0], [3, -250]]);
  });

  it("only zero net pay Cash employees: nothing to pay, no workbook", () => {
    refused(() => prepare([row(1, 0)]), "NO_CASH_EMPLOYEES", 404);
  });

  it("a count or total that disagrees with the payrun's own read is refused", () => {
    const rows = [row(1, 500), row(2, 700)];
    refused(() => prepare(rows, { finalized: 2, cash: { employees: 3, net_pay: 1200 } }), "CASH_REPORT_INTEGRITY");
    refused(() => prepare(rows, { finalized: 2, cash: { employees: 2, net_pay: 1201 } }), "CASH_REPORT_INTEGRITY");
  });
});

describe("prepare - Contract employees are paid by their contractor", () => {
  it("a Contract employee is left out of the cash and named; Permanent and not-recorded stay", () => {
    const data = prepare([
      row(1, 18760, { employment_type: "Permanent" }),
      row(2, 12345, { employment_type: "Contract" }),
      row(3, 700, { employment_type: null }),
    ]);
    assert.deepEqual(data.employees.map((e) => e.employee_id), [1, 3]);
    assert.equal(data.total_net_pay, 18760 + 700);
    assert.equal(data.denomination_amount, 18760 + 700);
    assert.deepEqual(data.contract.map((e) => [e.employee_id, e.employee_name]), [[2, "Employee 2"]]);
  });

  it("a Contract employee whose payroll is not finalized does not hold the month up", () => {
    const data = prepare([row(1, 500), row(2, null, { status: "CALCULATED", employment_type: "Contract" })]);
    assert.deepEqual(data.employees.map((e) => e.employee_id), [1]);
    assert.deepEqual(data.contract.map((e) => e.employee_id), [2]);
  });

  it("a month whose only Cash employees are Contract gives the no-employees message", () => {
    assert.throws(
      () => prepare([row(1, 500, { employment_type: "Contract" })], { finalized: 1, cash: { employees: 0, net_pay: 0 } }),
      (e) => e.code === "NO_CASH_EMPLOYEES" && e.message === cash.MESSAGES.NO_CASH_EMPLOYEES && e.detail.contract[0].employee_id === 1
    );
  });

  it("a Contract employee counted by the payrun's own read would fail the reconciliation", () => {
    const rows = [row(1, 500), row(2, 700, { employment_type: "Contract" })];
    assert.throws(() => prepare(rows, { finalized: 2, cash: { employees: 2, net_pay: 1200 } }), (e) => e.code === "CASH_REPORT_INTEGRITY");
  });
});

describe("prepare - exit employees", () => {
  it("an employee who left by the month end goes to the exit list; later leavers stay active", () => {
    const data = prepare([
      row(1, 18760),
      row(2, 12345, { resignation_date: "2026-08-20" }),
      row(3, 999, { resignation_date: "2026-08-31" }),
      row(4, 700, { resignation_date: "2026-09-02" }),
    ]);
    assert.deepEqual(data.employees.map((e) => e.employee_id), [1, 4], "left after August: still active for August");
    assert.deepEqual(data.exit_employees.map((e) => [e.sno, e.employee_id, e.last_working_day]), [[1, 2, "2026-08-20"], [2, 3, "2026-08-31"]]);
    assert.equal(data.total_net_pay, 18760 + 12345 + 999 + 700, "the month's cash is everybody's");
    assert.equal(data.denomination_amount, data.total_net_pay);
    assert.equal(data.groups.active.net_pay, 18760 + 700);
    assert.equal(data.groups.exit.net_pay, 12345 + 999);
    assert.equal(data.groups.active.denomination_amount + data.groups.exit.denomination_amount, data.total_net_pay);
  });

  it("a month whose only Cash employees have exited still produces the file", () => {
    const data = prepare([row(2, 500, { resignation_date: "2026-08-10" })]);
    assert.deepEqual(data.employees, []);
    assert.equal(data.exit_employees.length, 1);
  });
});

describe("filename", () => {
  it("is Cash Payment - <MMM YYYY>.xlsx", () => {
    assert.equal(cash.filename({ year: 2026, month: 8 }), "Cash Payment - Aug 2026.xlsx");
    assert.equal(cash.filename({ year: 2026, month: 9 }), "Cash Payment - Sep 2026.xlsx");
  });
});

describe("workbook", () => {
  const load = async (data) => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await cash.buildWorkbook(data));
    return wb;
  };
  // ExcelJS drops a cached formula result of 0 when it reads a file back (the
  // file has it - see "cached results" below), so a formula without one is 0 here.
  const textOf = (cell) => {
    const v = cell.value;
    if (v && typeof v === "object" && "formula" in v) return v.result === undefined ? 0 : v.result;
    return v;
  };
  const rowValues = (ws, r, from, to) => {
    const out = [];
    for (let c = from; c <= to; c += 1) out.push(textOf(ws.getCell(r, c)));
    return out;
  };
  // ExcelJS reads `\,` in a number format back as `,`; the file itself carries the escape.
  const unescaped = (fmt) => fmt.replace(/\\/g, "");
  const findRow = (ws, col, text) => {
    for (let r = 1; r <= ws.rowCount; r += 1) if (ws.getCell(r, col).value === text) return r;
    return null;
  };

  const rows = [row(12, 18760), row(7, 12345), row(30, 999, { store_name: "Velachery" }), row(9, 0)];
  const data = { ...prepare(rows), company: "DAILY NEEDS DEPARTMENT STORE" };

  it("has the four sheets, in order", async () => {
    const wb = await load(data);
    assert.deepEqual(wb.worksheets.map((w) => w.name), ["Cash Denomination", "Exit Employees", "Denomination Total", "Cash Salary Acknowledgement"]);
  });

  it("Cash Denomination: August's banner, header, live denomination formulas and row check", async () => {
    const ws = (await load(data)).getWorksheet("Cash Denomination");
    assert.equal(ws.getCell("A1").value, "DAILY NEEDS DEPARTMENT STORE");
    assert.equal(ws.getCell("A1").font.size, 16);
    assert.equal(ws.getCell("A2").value, "Cash Payment Denomination - Aug 2026");
    assert.deepEqual(rowValues(ws, 3, 1, 15), [
      "S.No", "Employee Code", "Employee Name", "Location / Outlet", "Net Pay",
      "₹500", "₹200", "₹100", "₹50", "₹20", "₹10", "₹5", "₹2", "₹1", "Total",
    ]);
    assert.deepEqual(rowValues(ws, 4, 1, 15), [1, 7, "Employee 7", "Anna Nagar", 12345, 24, 1, 1, 0, 2, 0, 1, 0, 0, 12345]);
    assert.deepEqual(rowValues(ws, 5, 1, 15), [2, 12, "Employee 12", "Anna Nagar", 18760, 37, 1, 0, 1, 0, 1, 0, 0, 0, 18760]);
    assert.deepEqual(rowValues(ws, 6, 1, 5), [1, 30, "Employee 30", "Velachery", 999], "S.No restarts for a new location");
    // The same formulas as August's sheet, shifted one column for S.No.
    assert.equal(ws.getCell("F4").value.formula, "ROUNDDOWN((E4)/500,0)");
    assert.equal(ws.getCell("G4").value.formula, "ROUNDDOWN((E4-500*F4)/200,0)");
    assert.equal(ws.getCell("N4").value.formula, "ROUNDDOWN((E4-500*F4-200*G4-100*H4-50*I4-20*J4-10*K4-5*L4-2*M4)/1,0)");
    assert.equal(ws.getCell("O4").value.formula, "SUM(500*F4,200*G4,100*H4,50*I4,20*J4,10*K4,5*L4,2*M4,1*N4)");
  });

  it("Cash Denomination: SUBTOTAL totals, denomination amounts and the summary", async () => {
    const ws = (await load(data)).getWorksheet("Cash Denomination");
    assert.equal(ws.getCell("A7").value, "Total");
    assert.equal(ws.getCell("E7").value.formula, "SUBTOTAL(9,E4:E6)");
    assert.equal(ws.getCell("E7").value.result, 12345 + 18760 + 999);
    assert.equal(ws.getCell("F7").value.formula, "SUBTOTAL(9,F4:F6)");
    assert.equal(ws.getCell("F7").value.result, 24 + 37 + 1);
    assert.equal(ws.getCell("O7").value.result, 32104);
    assert.equal(ws.getCell("A8").value, "Denomination Amount");
    assert.equal(ws.getCell("F8").value.result, (24 + 37 + 1) * 500);

    assert.equal(findRow(ws, 3, "Total Notes / Coins Required"), null, "the summary is on its own sheet");
    assert.match(ws.pageSetup.printArea, /^A1:O8$/, "the sheet ends at the denomination amounts");
  });

  it("Denomination Total: its own sheet - notes / coins required and Grand Cash Required = Total Net Pay", async () => {
    const ws = (await load(data)).getWorksheet("Denomination Total");
    assert.equal(ws.getCell("A1").value, "DAILY NEEDS DEPARTMENT STORE");
    assert.equal(ws.getCell("A2").value, "Total Notes / Coins Required - Aug 2026");
    assert.deepEqual(rowValues(ws, 3, 1, 3), ["Denomination", "Qty", "Amount"]);
    assert.deepEqual(rowValues(ws, 4, 1, 3), ["₹500", 62, 31000]);
    assert.deepEqual(rowValues(ws, 12, 1, 3), ["₹1", 0, 0]);
    // The month's totals whatever is filtered on the denomination sheet: SUM, not SUBTOTAL.
    assert.equal(ws.getCell("B4").value.formula, "SUM('Cash Denomination'!F4:F6)");
    assert.equal(ws.getCell("C4").value.formula, "B4*500");
    assert.deepEqual(rowValues(ws, 13, 1, 3), ["Grand Cash Required", "Grand Cash Required", 32104]);
    assert.equal(ws.getCell("C13").value.formula, "SUM(C4:C12)");
    assert.equal(ws.getCell("A14").value, "Total Net Pay");
    assert.equal(ws.getCell("C14").value.formula, "SUM('Cash Denomination'!E4:E6)");
    assert.equal(textOf(ws.getCell("C14")), 32104);
    assert.equal(ws.getCell("A15").value, "Difference (must be 0)");
    assert.equal(ws.getCell("C15").value.formula, "C13-C14");
    assert.equal(ws.getCell("C13").numFmt, unescaped(cash.INR));
    assert.equal(ws.getCell("B4").numFmt, cash.COUNT);
    assert.deepEqual(rowValues(ws, 17, 1, 3), ["Paid from", "Employees", "Net Pay"]);
    assert.deepEqual(rowValues(ws, 18, 1, 3), ["Cash Denomination", 3, 32104]);
    assert.deepEqual(rowValues(ws, 19, 1, 3), ["Exit Employees", 0, 0]);
    assert.match(String(ws.getCell("A21").value), /Not included - zero or negative Net Pay.*9 Employee 9/);
    assert.equal(ws.pageSetup.orientation, "portrait");
    assert.equal(ws.pageSetup.fitToWidth, 1);
    assert.equal(ws.pageSetup.printArea, "A1:C21");
  });

  it("Cash Denomination: formatting, autofilter and landscape page setup", async () => {
    const ws = (await load(data)).getWorksheet("Cash Denomination");
    assert.equal(ws.getCell("E4").numFmt, unescaped(cash.INR));
    assert.equal(ws.getCell("F4").numFmt, cash.COUNT);
    assert.equal(ws.getCell("A3").font.bold, true);
    assert.equal(ws.getCell("A4").font.size, 10);
    assert.equal(ws.getCell("A4").border.top.style, "thin");
    assert.equal(ws.getColumn(3).width, 27);
    assert.equal(ws.autoFilter, "A3:O6");
    assert.equal(ws.pageSetup.orientation, "landscape");
    assert.equal(ws.pageSetup.paperSize, 9);
    assert.equal(ws.pageSetup.fitToPage, true);
    assert.equal(ws.pageSetup.fitToWidth, 1);
    assert.equal(ws.pageSetup.fitToHeight, 0);
    assert.match(ws.pageSetup.printArea, /^A1:O\d+$/);
    assert.equal(ws.pageSetup.printTitlesRow, "3:3");
    assert.equal(ws.views[0].state, "frozen");
  });

  it("Cash Salary Acknowledgement: August's columns, blank signature, total, landscape", async () => {
    const ws = (await load(data)).getWorksheet("Cash Salary Acknowledgement");
    assert.equal(ws.getCell("A1").value, "DAILY NEEDS DEPARTMENT STORE");
    assert.equal(ws.getCell("A2").value, "Cash Salary Acknowledgement - Aug 2026");
    assert.deepEqual(rowValues(ws, 3, 1, 6), ["S.No", "Employee Code", "Employee Name", "Location / Outlet", "Net Pay", "Employee Signature"]);
    assert.deepEqual(rowValues(ws, 4, 1, 6), [1, 7, "Employee 7", "Anna Nagar", 12345, null]);
    assert.deepEqual(rowValues(ws, 6, 1, 4), [1, 30, "Employee 30", "Velachery"]);
    assert.equal(ws.getRow(4).height, 24);
    assert.equal(ws.getCell("A7").value, "Total");
    assert.equal(ws.getCell("E7").value.formula, "SUBTOTAL(9,E4:E6)");
    assert.equal(ws.getCell("E7").value.result, 32104);
    assert.equal(ws.getCell("E4").numFmt, unescaped(cash.INR));
    assert.equal(ws.getColumn(6).width, 27.6);
    assert.equal(ws.autoFilter, "A3:F6");
    assert.equal(ws.pageSetup.orientation, "landscape");
    assert.equal(ws.pageSetup.fitToWidth, 1);
    assert.equal(ws.pageSetup.printTitlesRow, "3:3");
    assert.match(ws.pageSetup.printArea, /^A1:F7$/);
  });

  it("cached results: every formula cell carries its value, zeros included, so the file reads right before Excel recalculates", async () => {
    // exceljs's own zip library, so the test needs nothing exceljs does not already bring.
    const JSZip = require(require.resolve("jszip", { paths: [require.resolve("exceljs")] }));
    const zip = await JSZip.loadAsync(await cash.buildWorkbook(data));
    const xml = await zip.file("xl/worksheets/sheet1.xml").async("string");
    const formulaCells = xml.match(/<c [^>]*>(?:(?!<\/c>).)*<f>(?:(?!<\/c>).)*<\/c>/g);
    assert.ok(formulaCells.length > 0);
    for (const c of formulaCells) assert.match(c, /<v>-?\d+<\/v>/, c);
    assert.match(xml, /<c r="I4"[^>]*><f>[^<]*<\/f><v>0<\/v><\/c>/, "a zero count is cached as 0");
  });

  it("Denomination Total names the Contract employees left out", async () => {
    const withContract = { ...prepare([...rows, row(40, 9000, { employment_type: "Contract" })]), company: "X" };
    const ws = (await load(withContract)).getWorksheet("Denomination Total");
    assert.equal(textOf(ws.getCell("C14")), 32104, "the Contract employee's pay is not in the cash total");
    assert.equal(ws.getCell("A21").value, "Not included - Contract employees (paid directly to the contractor): 40 Employee 40");
    assert.match(String(ws.getCell("A22").value), /zero or negative Net Pay.*9 Employee 9/);
    assert.equal(ws.pageSetup.printArea, "A1:C22");
    const grid = (await load(withContract)).getWorksheet("Cash Denomination");
    for (let r = 4; r <= 6; r += 1) assert.notEqual(grid.getCell(r, 2).value, 40);
  });

  it("Exit Employees: own sheet with Last Working Day, denominations, signature; totals cover both sheets", async () => {
    const mixed = { ...prepare([...rows, row(50, 12345, { resignation_date: "2026-08-25", store_name: "Velachery" })]), company: "X" };
    const wb = await load(mixed);
    const ex = wb.getWorksheet("Exit Employees");
    assert.equal(ex.getCell("A2").value, "Exit Employees - Cash Payment - Aug 2026");
    assert.deepEqual(rowValues(ex, 3, 1, 17), [
      "S.No", "Employee Code", "Employee Name", "Location / Outlet", "Last Working Day", "Net Pay",
      "₹500", "₹200", "₹100", "₹50", "₹20", "₹10", "₹5", "₹2", "₹1", "Total", "Employee Signature",
    ]);
    assert.deepEqual(rowValues(ex, 4, 1, 17), [1, 50, "Employee 50", "Velachery", "2026-08-25", 12345, 24, 1, 1, 0, 2, 0, 1, 0, 0, 12345, null]);
    assert.equal(ex.getCell("G4").value.formula, "ROUNDDOWN((F4)/500,0)");
    assert.equal(ex.getCell("A5").value, "Total");
    assert.equal(ex.getCell("F5").value.formula, "SUBTOTAL(9,F4:F4)");
    assert.equal(ex.pageSetup.orientation, "landscape");
    assert.equal(ex.pageSetup.printArea, "A1:Q6");

    // The exit employee is not on the active sheets.
    const active = wb.getWorksheet("Cash Denomination");
    const ack = wb.getWorksheet("Cash Salary Acknowledgement");
    for (const ws of [active, ack]) for (let r = 4; r <= 6; r += 1) assert.notEqual(ws.getCell(r, 2).value, 50);
    assert.equal(ack.getCell("E7").value.result, 32104, "acknowledgement total: active employees only");

    const tot = wb.getWorksheet("Denomination Total");
    assert.equal(tot.getCell("B4").value.formula, "SUM('Cash Denomination'!F4:F6,'Exit Employees'!G4:G4)");
    assert.deepEqual(rowValues(tot, 4, 1, 3), ["₹500", 62 + 24, (62 + 24) * 500]);
    assert.equal(tot.getCell("C14").value.formula, "SUM('Cash Denomination'!E4:E6,'Exit Employees'!F4:F4)");
    assert.equal(textOf(tot.getCell("C13")), 32104 + 12345);
    assert.equal(textOf(tot.getCell("C14")), 32104 + 12345);
    assert.deepEqual(rowValues(tot, 18, 1, 3), ["Cash Denomination", 3, 32104]);
    assert.deepEqual(rowValues(tot, 19, 1, 3), ["Exit Employees", 1, 12345]);
  });

  it("no exit employees: the sheet says so; no active employees: the active sheets say so", async () => {
    const ex = (await load(data)).getWorksheet("Exit Employees");
    assert.equal(ex.getCell("A4").value, "No exit employees are paid in cash this month.");
    const onlyExit = { ...prepare([row(2, 500, { resignation_date: "2026-08-10" })]), company: "X" };
    const wb = await load(onlyExit);
    assert.equal(wb.getWorksheet("Cash Denomination").getCell("A4").value, "No active employees are paid in cash this month.");
    assert.match(wb.getWorksheet("Cash Salary Acknowledgement").getCell("A4").value, /No active employees/);
    const tot = wb.getWorksheet("Denomination Total");
    assert.equal(tot.getCell("C14").value.formula, "SUM('Exit Employees'!F4:F4)");
    assert.equal(textOf(tot.getCell("C14")), 500);
  });

  it("without a configured company the banner still names the report", async () => {
    const ws = (await load(prepare([row(1, 500)]))).getWorksheet("Cash Denomination");
    assert.equal(ws.getCell("A1").value, "Cash Salary Payment");
  });

  it("neutralises text a spreadsheet would evaluate", async () => {
    const ws = (await load(prepare([row(1, 500, { employee_name: "=HYPERLINK(1)" })]))).getWorksheet("Cash Denomination");
    assert.equal(ws.getCell("C4").value, "'=HYPERLINK(1)");
  });

  it("the same month produces the same workbook", async () => {
    const a = await cash.buildWorkbook(data);
    const b = await cash.buildWorkbook({ ...prepare([...rows].reverse()), company: data.company });
    const sheetValues = async (buf) => {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buf);
      return wb.worksheets.map((ws) => ws.getSheetValues().map((r) => JSON.stringify(r)).join("\n"));
    };
    assert.deepEqual(await sheetValues(a), await sheetValues(b));
  });
});
