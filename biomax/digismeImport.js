/**
 * DigiSME "ATD Daily Attendance" workbook -> punch candidates.
 *
 * The one Excel export HR can always produce. Sheet "Attendance", one row per
 * employee per calendar date, columns:
 *
 *   Employee Code | Employee Name | Department Name | Clock Date | Clock Time-1 .. Clock Time-N
 *
 * N varies between exports and is DISCOVERED from the header row by the
 * pattern /^Clock Time-\d+$/ - never hard-coded. Column order is irrelevant.
 * Employee Name and Department Name are read for nothing: identity is the
 * Employee Code alone, and our employee master supplies everything else.
 *
 * Every NON-EMPTY Clock Time cell is one punch candidate with
 *
 *   io_time_raw = YYYYMMDDHHMMSS  (Clock Date + Clock Time, IST wall clock)
 *
 * exactly the 14-digit form a terminal sends, so everything downstream
 * (employee matching, attendance-date derivation, storage) is shared with
 * live punches. Nothing here assumes punches fall in working hours, and
 * nothing here decides an attendance date: Clock Date is the calendar date
 * of the punch and no more.
 *
 * Bad cells and bad rows are REPORTED and skipped; parsing never aborts on
 * data. Only a structurally unusable workbook (no such sheet, no header row,
 * no Clock Time column) is an error.
 *
 * Reads with exceljs (already a dependency). Node 14 compatible.
 */

const ExcelJS = require("exceljs");

const SHEET_NAME = "Attendance";
const TIME_HEADER_RE = /^Clock Time-(\d+)$/i;
const REQUIRED_HEADERS = ["Employee Code", "Clock Date"];
const HEADER_SCAN_ROWS = 10;
const DEFAULT_MAX_ROWS = 100000;

/** Excel serial day 0 is 1899-12-30 (the 1900 system, as DigiSME writes it). */
const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30);

const pad = (n, w = 2) => String(n).padStart(w, "0");

/* ------------------------------------------------------------ cell text */

/**
 * Reduce an exceljs cell value to a primitive we can reason about:
 * string (trimmed), number, Date, or null for anything empty. Formula
 * cells yield their result, rich text its concatenated text, hyperlinks
 * their text, error cells null (reported by the caller as empty).
 */
function cellPrimitive(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return null;
  if (typeof value === "string") {
    const t = value.trim();
    return t === "" ? null : t;
  }
  if (typeof value === "object") {
    if (Array.isArray(value.richText)) {
      return cellPrimitive(value.richText.map((r) => (r && r.text) || "").join(""));
    }
    if (Object.prototype.hasOwnProperty.call(value, "result")) return cellPrimitive(value.result);
    if (typeof value.text === "string") return cellPrimitive(value.text);
    if (value.error !== undefined) return null;
  }
  return null;
}

/** For provenance: how the cell looked, as a short string. */
function rawText(value) {
  const p = cellPrimitive(value);
  if (p === null) return null;
  if (p instanceof Date) return p.toISOString();
  return String(p).slice(0, 64);
}

/* ---------------------------------------------------------- date / time */

function realDate(y, mo, d) {
  if (y < 2000 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const probe = new Date(Date.UTC(y, mo - 1, d));
  return probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d;
}

/**
 * Clock Date -> 'YYYYMMDD'. Accepts the documented DD-MM-YYYY text, the same
 * with '/' or '.', an ISO YYYY-MM-DD text, a true date cell (exceljs gives a
 * UTC Date), or an Excel serial number. Anything else -> null.
 */
function parseClockDate(value) {
  const p = cellPrimitive(value);
  if (p === null) return null;
  let y;
  let mo;
  let d;
  if (p instanceof Date) {
    y = p.getUTCFullYear();
    mo = p.getUTCMonth() + 1;
    d = p.getUTCDate();
  } else if (typeof p === "number") {
    if (p < 36526 || p > 73050) return null; // 2000-01-01 .. 2099-12-31
    const dt = new Date(EXCEL_EPOCH_UTC + Math.floor(p) * 86400000);
    y = dt.getUTCFullYear();
    mo = dt.getUTCMonth() + 1;
    d = dt.getUTCDate();
  } else {
    let m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?:[ T].*)?$/.exec(p);
    if (m) {
      d = Number(m[1]);
      mo = Number(m[2]);
      y = Number(m[3]);
    } else {
      m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T].*)?$/.exec(p);
      if (!m) return null;
      y = Number(m[1]);
      mo = Number(m[2]);
      d = Number(m[3]);
    }
  }
  if (!realDate(y, mo, d)) return null;
  return `${y}${pad(mo)}${pad(d)}`;
}

/**
 * Clock Time -> 'HHMMSS'. Accepts HH:MM:SS or HH:MM text (24-hour, as
 * DigiSME writes it), a true time cell (a UTC Date on the Excel epoch), or a
 * fraction-of-day number. Anything else -> null. Midnight is 000000.
 */
function parseClockTime(value) {
  const p = cellPrimitive(value);
  if (p === null) return null;
  let h;
  let mi;
  let s;
  if (p instanceof Date) {
    h = p.getUTCHours();
    mi = p.getUTCMinutes();
    s = p.getUTCSeconds();
  } else if (typeof p === "number") {
    if (p < 0 || p >= 1) return null;
    const total = Math.round(p * 86400);
    h = Math.floor(total / 3600) % 24;
    mi = Math.floor((total % 3600) / 60);
    s = total % 60;
  } else {
    const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(p);
    if (!m) return null;
    h = Number(m[1]);
    mi = Number(m[2]);
    s = m[3] === undefined ? 0 : Number(m[3]);
  }
  if (h > 23 || mi > 59 || s > 59) return null;
  return `${pad(h)}${pad(mi)}${pad(s)}`;
}

/**
 * Employee Code -> canonical string. A number cell (Excel likes to type
 * "1952" as 1952) becomes its integer text; text is trimmed and kept
 * verbatim otherwise. Empty -> null. The employee MATCH is decided later by
 * biomax/employeeMatch.js on this string, exactly as for a device punch.
 */
function canonicalEmployeeCode(value) {
  const p = cellPrimitive(value);
  if (p === null) return null;
  if (p instanceof Date) return null;
  if (typeof p === "number") return Number.isInteger(p) ? String(p) : null;
  return p.length > 32 ? null : p;
}

/* ---------------------------------------------------------------- parse */

/** Find the header row within the first rows: the one holding every required header. */
function findHeaderRow(sheet) {
  const last = Math.min(sheet.rowCount, HEADER_SCAN_ROWS);
  for (let r = 1; r <= last; r += 1) {
    const row = sheet.getRow(r);
    const names = {};
    row.eachCell({ includeEmpty: false }, (cell, col) => {
      const t = cellPrimitive(cell.value);
      if (typeof t === "string") names[t.toLowerCase()] = col;
    });
    if (REQUIRED_HEADERS.every((h) => names[h.toLowerCase()] !== undefined)) {
      const timeColumns = [];
      row.eachCell({ includeEmpty: false }, (cell, col) => {
        const t = cellPrimitive(cell.value);
        const m = typeof t === "string" ? TIME_HEADER_RE.exec(t) : null;
        if (m) timeColumns.push({ name: `Clock Time-${Number(m[1])}`, index: Number(m[1]), col });
      });
      timeColumns.sort((a, b) => a.index - b.index);
      return {
        headerRow: r,
        employeeCodeCol: names["employee code"],
        clockDateCol: names["clock date"],
        timeColumns,
      };
    }
  }
  return null;
}

class WorkbookError extends Error {
  constructor(message) {
    super(message);
    this.name = "WorkbookError";
  }
}

/**
 * Parse a workbook (Buffer or file path) into punch candidates.
 *
 * @returns {{
 *   sheet_name: string, header_row: number, time_columns: string[],
 *   excel_row_count: number, employee_codes: string[],
 *   candidates: Array<{excel_row, column_name, raw_employee_code, raw_clock_date,
 *                      raw_clock_time, user_id, io_time_raw, error}>,
 *   bad_rows: Array<{excel_row, raw_employee_code, raw_clock_date, error, time_cells}>,
 *   candidate_count: number, date_from: string|null, date_to: string|null
 * }}
 */
async function parseWorkbook(source, options = {}) {
  const maxRows = options.maxRows || DEFAULT_MAX_ROWS;
  const workbook = new ExcelJS.Workbook();
  try {
    if (Buffer.isBuffer(source)) await workbook.xlsx.load(source);
    else await workbook.xlsx.readFile(source);
  } catch (err) {
    throw new WorkbookError(`the file could not be opened as an .xlsx workbook (${err && err.message ? err.message.slice(0, 80) : "unknown error"})`);
  }

  const sheet = workbook.getWorksheet(SHEET_NAME) || workbook.worksheets.find((w) => w.name.trim().toLowerCase() === SHEET_NAME.toLowerCase());
  if (!sheet) {
    throw new WorkbookError(`no sheet named "${SHEET_NAME}" (sheets: ${workbook.worksheets.map((w) => w.name).join(", ") || "none"})`);
  }
  const header = findHeaderRow(sheet);
  if (!header) throw new WorkbookError(`no header row with ${REQUIRED_HEADERS.join(" and ")} in the first ${HEADER_SCAN_ROWS} rows of "${sheet.name}"`);
  if (header.timeColumns.length === 0) throw new WorkbookError('no "Clock Time-N" column in the header row');
  if (sheet.rowCount - header.headerRow > maxRows) throw new WorkbookError(`more than ${maxRows} data rows`);

  const candidates = [];
  const badRows = [];
  const codes = new Set();
  let excelRowCount = 0;
  let dateFrom = null;
  let dateTo = null;

  for (let r = header.headerRow + 1; r <= sheet.rowCount; r += 1) {
    const row = sheet.getRow(r);
    if (!row || !row.hasValues) continue;
    const codeCell = row.getCell(header.employeeCodeCol).value;
    const dateCell = row.getCell(header.clockDateCol).value;
    const timeCells = header.timeColumns.map((tc) => ({ tc, value: row.getCell(tc.col).value }));
    const nonEmptyTimes = timeCells.filter((t) => cellPrimitive(t.value) !== null);
    if (cellPrimitive(codeCell) === null && cellPrimitive(dateCell) === null && nonEmptyTimes.length === 0) continue; // blank line
    excelRowCount += 1;

    const userId = canonicalEmployeeCode(codeCell);
    const ymd = parseClockDate(dateCell);
    const rowError = userId === null ? "Employee Code missing or unusable" : ymd === null ? "Clock Date missing or not a real DD-MM-YYYY date" : null;
    if (rowError) {
      badRows.push({ excel_row: r, raw_employee_code: rawText(codeCell), raw_clock_date: rawText(dateCell), error: rowError, time_cells: nonEmptyTimes.length });
      continue;
    }
    codes.add(userId);

    for (const t of nonEmptyTimes) {
      const hms = parseClockTime(t.value);
      const candidate = {
        excel_row: r,
        column_name: t.tc.name,
        raw_employee_code: rawText(codeCell),
        raw_clock_date: rawText(dateCell),
        raw_clock_time: rawText(t.value),
        user_id: userId,
        io_time_raw: hms === null ? null : `${ymd}${hms}`,
        error: hms === null ? "Clock Time is not HH:MM:SS" : null,
      };
      candidates.push(candidate);
      if (candidate.io_time_raw) {
        if (dateFrom === null || ymd < dateFrom) dateFrom = ymd;
        if (dateTo === null || ymd > dateTo) dateTo = ymd;
      }
    }
  }

  const iso = (ymd) => (ymd ? `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}` : null);
  return {
    sheet_name: sheet.name,
    header_row: header.headerRow,
    time_columns: header.timeColumns.map((t) => t.name),
    excel_row_count: excelRowCount,
    employee_codes: [...codes],
    candidates,
    bad_rows: badRows,
    candidate_count: candidates.length,
    date_from: iso(dateFrom),
    date_to: iso(dateTo),
  };
}

module.exports = {
  SHEET_NAME,
  TIME_HEADER_RE,
  REQUIRED_HEADERS,
  WorkbookError,
  cellPrimitive,
  parseClockDate,
  parseClockTime,
  canonicalEmployeeCode,
  findHeaderRow,
  parseWorkbook,
};
