/**
 * The DigiSME workbook parser, against workbooks built here with exceljs -
 * the real sample is not available to this runtime and its contents are not
 * invented. What is proven: dynamic Clock Time discovery, one candidate per
 * non-empty cell, empty/blank/typed-empty handling, date and time typing,
 * malformed rows reported without aborting, midnight, and the counts a
 * preview will show.
 *
 *   node --test biomax/digismeImport.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const ExcelJS = require("exceljs");

const p = require("./digismeImport");

/** Build an .xlsx buffer: `headers` array, `rows` arrays of cell values (undefined = empty). */
async function workbook(headers, rows, { sheet = "Attendance", extraSheets = [], headerRow = 1 } = {}) {
  const wb = new ExcelJS.Workbook();
  for (const name of extraSheets) wb.addWorksheet(name).addRow(["junk"]);
  const ws = wb.addWorksheet(sheet);
  for (let i = 1; i < headerRow; i += 1) ws.addRow(["Daily Attendance Report"]);
  ws.addRow(headers);
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const H = (n) => ["Employee Code", "Employee Name", "Department Name", "Clock Date", ...Array.from({ length: n }, (_, i) => `Clock Time-${i + 1}`)];

describe("cell primitives", () => {
  it("empty is empty: null, undefined, '', whitespace, NaN, booleans, error cells", () => {
    for (const v of [null, undefined, "", "   ", "\t", NaN, Infinity, true, { error: "#N/A" }]) assert.equal(p.cellPrimitive(v), null, String(v));
  });
  it("rich text, formulas and hyperlinks reduce to their text", () => {
    assert.equal(p.cellPrimitive({ richText: [{ text: "09:" }, { text: "15:00" }] }), "09:15:00");
    assert.equal(p.cellPrimitive({ formula: "A1", result: "1952" }), "1952");
    assert.equal(p.cellPrimitive({ formula: "A1", result: null }), null);
    assert.equal(p.cellPrimitive({ text: "1952", hyperlink: "x" }), "1952");
  });
});

describe("Clock Date", () => {
  it("DD-MM-YYYY text, with - / or ., and ISO text", () => {
    assert.equal(p.parseClockDate("05-09-2026"), "20260905");
    assert.equal(p.parseClockDate("5/9/2026"), "20260905");
    assert.equal(p.parseClockDate("05.09.2026"), "20260905");
    assert.equal(p.parseClockDate("2026-09-05"), "20260905");
    assert.equal(p.parseClockDate("05-09-2026 00:00:00"), "20260905");
  });
  it("a true date cell and an Excel serial", () => {
    assert.equal(p.parseClockDate(new Date(Date.UTC(2026, 8, 5))), "20260905");
    assert.equal(p.parseClockDate(46270), "20260905"); // 2026-09-05
  });
  it("malformed or impossible dates are null, never guessed", () => {
    for (const v of ["31-02-2026", "2026-13-01", "09-05-26", "yesterday", 12, "", null]) assert.equal(p.parseClockDate(v), null, String(v));
  });
});

describe("Clock Time", () => {
  it("HH:MM:SS and HH:MM text, including midnight and 23:59:59", () => {
    assert.equal(p.parseClockTime("09:05:07"), "090507");
    assert.equal(p.parseClockTime("9:05"), "090500");
    assert.equal(p.parseClockTime("00:00:00"), "000000");
    assert.equal(p.parseClockTime("23:59:59"), "235959");
    assert.equal(p.parseClockTime("02:30:00"), "023000", "no working-hours assumption");
  });
  it("a true time cell and a fraction-of-day number", () => {
    assert.equal(p.parseClockTime(new Date(Date.UTC(1899, 11, 30, 13, 57, 41))), "135741");
    assert.equal(p.parseClockTime(0.5), "120000");
    assert.equal(p.parseClockTime(0), "000000");
  });
  it("malformed times are null", () => {
    for (const v of ["24:00:00", "09:60:00", "9.15", "morning", 1, 1.5, -0.1, "", null]) assert.equal(p.parseClockTime(v), null, String(v));
  });
});

describe("Employee Code", () => {
  it("text verbatim (trimmed), integer numbers as text, nothing else", () => {
    assert.equal(p.canonicalEmployeeCode(" 1952 "), "1952");
    assert.equal(p.canonicalEmployeeCode(1952), "1952");
    assert.equal(p.canonicalEmployeeCode("0042"), "0042", "leading zeros kept - the match rule decides");
    assert.equal(p.canonicalEmployeeCode("EMP-7"), "EMP-7", "kept verbatim; it will be UNMATCHED later");
    assert.equal(p.canonicalEmployeeCode(1952.5), null);
    assert.equal(p.canonicalEmployeeCode(""), null);
  });
});

describe("parseWorkbook", () => {
  it("discovers Clock Time columns dynamically (3 here, 7 there) and never assumes 10", async () => {
    const three = await workbook(H(3), [["1952", "x", "y", "05-09-2026", "09:00:00", "13:00:00", "18:00:00"]]);
    const r3 = await p.parseWorkbook(three);
    assert.deepEqual(r3.time_columns, ["Clock Time-1", "Clock Time-2", "Clock Time-3"]);
    assert.equal(r3.candidate_count, 3);
    const seven = await workbook(H(7), [["1952", "x", "y", "05-09-2026", "09:00:00", undefined, undefined, undefined, undefined, undefined, "23:10:00"]]);
    const r7 = await p.parseWorkbook(seven);
    assert.equal(r7.time_columns.length, 7);
    assert.deepEqual(r7.candidates.map((c) => [c.column_name, c.io_time_raw]), [["Clock Time-1", "20260905090000"], ["Clock Time-7", "20260905231000"]]);
  });

  it("column order does not matter and Employee Name / Department Name are never read", async () => {
    const buf = await workbook(["Clock Time-2", "Department Name", "Clock Date", "Clock Time-1", "Employee Code", "Employee Name"], [["17:00:00", "IGNORED", "05-09-2026", "09:00:00", "1952", "IGNORED NAME"]]);
    const r = await p.parseWorkbook(buf);
    assert.deepEqual(r.time_columns, ["Clock Time-1", "Clock Time-2"]);
    assert.deepEqual(r.candidates.map((c) => c.io_time_raw), ["20260905090000", "20260905170000"]);
    assert.equal(JSON.stringify(r).includes("IGNORED"), false);
  });

  it("one candidate per NON-EMPTY cell: empty, blank string, whitespace, formula-null and error cells produce nothing", async () => {
    const buf = await workbook(H(6), [
      ["1952", "", "", "05-09-2026", "09:00:00", "", "   ", null, { formula: "A1", result: null }, "18:00:00"],
      ["1641", "", "", "05-09-2026", undefined, undefined, undefined, undefined, undefined, undefined],
    ]);
    const r = await p.parseWorkbook(buf);
    assert.equal(r.excel_row_count, 2);
    assert.equal(r.candidate_count, 2);
    assert.deepEqual(r.candidates.map((c) => c.column_name), ["Clock Time-1", "Clock Time-6"]);
    assert.deepEqual(r.employee_codes.sort(), ["1641", "1952"]);
  });

  it("typed cells: numeric employee code, real date cell, real time cell, fraction time", async () => {
    const buf = await workbook(H(2), [[1952, "n", "d", new Date(Date.UTC(2026, 8, 5)), new Date(Date.UTC(1899, 11, 30, 9, 5, 7)), 0.75]]);
    const r = await p.parseWorkbook(buf);
    assert.deepEqual(r.candidates.map((c) => [c.user_id, c.io_time_raw]), [["1952", "20260905090507"], ["1952", "20260905180000"]]);
  });

  it("a bad Clock Date or missing Employee Code rejects the ROW (reported once) and parsing continues", async () => {
    const buf = await workbook(H(2), [
      ["1952", "", "", "31-02-2026", "09:00:00", "18:00:00"],
      ["", "", "", "05-09-2026", "09:00:00", undefined],
      ["1641", "", "", "05-09-2026", "09:00:00", undefined],
    ]);
    const r = await p.parseWorkbook(buf);
    assert.equal(r.excel_row_count, 3);
    assert.equal(r.bad_rows.length, 2);
    assert.match(r.bad_rows[0].error, /Clock Date/);
    assert.equal(r.bad_rows[0].time_cells, 2);
    assert.match(r.bad_rows[1].error, /Employee Code/);
    assert.equal(r.candidate_count, 1);
    assert.equal(r.candidates[0].user_id, "1641");
  });

  it("a bad Clock Time rejects only that CELL; the row's other cells still import", async () => {
    const buf = await workbook(H(3), [["1952", "", "", "05-09-2026", "09:00:00", "lunch", "25:00:00"]]);
    const r = await p.parseWorkbook(buf);
    assert.equal(r.candidate_count, 3);
    assert.equal(r.candidates.filter((c) => c.io_time_raw).length, 1);
    assert.deepEqual(r.candidates.filter((c) => c.error).map((c) => [c.column_name, c.raw_clock_time]), [["Clock Time-2", "lunch"], ["Clock Time-3", "25:00:00"]]);
  });

  it("midnight and small-hours punches keep the Clock Date as calendar date; nothing decides attendance here", async () => {
    const buf = await workbook(H(2), [["1952", "", "", "06-09-2026", "00:00:00", "02:15:00"]]);
    const r = await p.parseWorkbook(buf);
    assert.deepEqual(r.candidates.map((c) => c.io_time_raw), ["20260906000000", "20260906021500"]);
    assert.equal("attendance_date" in r.candidates[0], false);
  });

  it("date range and counts for the preview; blank lines are not rows", async () => {
    const buf = await workbook(H(1), [["1952", "", "", "03-09-2026", "09:00:00"], [], ["1641", "", "", "01-09-2026", "09:00:00"], ["1952", "", "", "11-09-2026", "21:00:00"]]);
    const r = await p.parseWorkbook(buf);
    assert.equal(r.excel_row_count, 3);
    assert.equal(r.date_from, "2026-09-01");
    assert.equal(r.date_to, "2026-09-11");
    assert.equal(r.employee_codes.length, 2);
  });

  it("finds the header row below a title block, and the sheet by name among others", async () => {
    const buf = await workbook(H(1), [["1952", "", "", "05-09-2026", "09:00:00"]], { headerRow: 3, extraSheets: ["Summary", "Sheet1"] });
    const r = await p.parseWorkbook(buf);
    assert.equal(r.header_row, 3);
    assert.equal(r.sheet_name, "Attendance");
    assert.equal(r.candidate_count, 1);
  });

  it("refuses: no Attendance sheet, missing required column, no Clock Time column, not a workbook", async () => {
    await assert.rejects(p.parseWorkbook(await workbook(H(1), [], { sheet: "Sheet1" })), (e) => e instanceof p.WorkbookError && /no sheet named "Attendance"/.test(e.message));
    await assert.rejects(p.parseWorkbook(await workbook(["Employee Code", "Clock Time-1"], [])), /no header row with Employee Code and Clock Date/);
    await assert.rejects(p.parseWorkbook(await workbook(["Employee Code", "Clock Date", "Clock"], [])), /no "Clock Time-N" column/);
    await assert.rejects(p.parseWorkbook(Buffer.from("this is not a zip")), /could not be opened/);
  });

  it("a 1959-row style file: counts add up (rows, codes, non-empty cells)", async () => {
    const rows = [];
    let cells = 0;
    for (let i = 0; i < 300; i += 1) {
      const code = String(1000 + (i % 40));
      const day = String(1 + (i % 9)).padStart(2, "0");
      const times = ["09:00:00", i % 3 ? "13:00:00" : "", i % 2 ? "18:00:00" : undefined, i % 5 ? undefined : "21:30:00"];
      cells += times.filter((t) => t).length;
      rows.push([code, "n", "d", `${day}-09-2026`, ...times]);
    }
    const r = await p.parseWorkbook(await workbook(H(4), rows));
    assert.equal(r.excel_row_count, 300);
    assert.equal(r.employee_codes.length, 40);
    assert.equal(r.candidate_count, cells);
    assert.equal(r.bad_rows.length, 0);
  });
});
