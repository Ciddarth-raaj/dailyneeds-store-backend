/**
 * Attendance date for a punch (R18, as approved in A1/A2/A3).
 *
 * THE RULE. Every working Weekly Schedule row carries a mandatory Attendance
 * Day Cutoff, a time on the FOLLOWING calendar morning until which punches
 * still belong to that day. For a punch on calendar date D at time t, with
 * the employee's assigned shift:
 *
 *     row = schedule(shift, weekday(D - 1))        the PREVIOUS day's row
 *     if row is a working day and t < row.attendance_day_cutoff
 *           attendance_date = D - 1
 *     else  attendance_date = D
 *
 * That is the whole rule. Only one schedule row is ever read, and only two
 * of its columns (`is_working_day`, `attendance_day_cutoff`), plus the
 * employee's `default_work_shift_id`. No in/out times, no breaks, no grace,
 * no OT: this file attributes a date and computes nothing else. Part 2 is
 * elsewhere and later.
 *
 * WHEN IT CANNOT BE DERIVED it says so rather than guessing (A3): the punch
 * is stored regardless, `attendance_date` is null, and `status` names the
 * reason so the review queue can show it and an Admin/HR action can fix the
 * cause. Nothing ever falls back to the calendar date silently.
 *
 * DATE ARITHMETIC. `io_time_raw` is the device's local wall clock as 14
 * digits. All arithmetic here is done on those digits with Date.UTC, which
 * is timezone-free integer math; no local `Date` is ever constructed, so
 * the process TZ cannot shift a punch (R3). Results are returned as
 * 'YYYY-MM-DD' strings for the store to bind as-is.
 */

const STATUS = Object.freeze({
  OK: "OK",
  UNMATCHED: "UNMATCHED",
  NO_SHIFT: "NO_SHIFT",
  NO_SCHEDULE_ROW: "NO_SCHEDULE_ROW",
  MISSING_CUTOFF: "MISSING_CUTOFF",
});

/** Columns the schedule reader may return. Anything else is a bug. */
const SCHEDULE_COLUMNS = Object.freeze([
  "work_shift_weekly_schedule_id",
  "is_working_day",
  "attendance_day_cutoff",
]);

const pad = (n, w = 2) => String(n).padStart(w, "0");

/** 'YYYYMMDDHHMMSS' -> {y, mo, d, secondsOfDay} without any Date. */
function splitIoTime(ioTimeRaw) {
  const s = String(ioTimeRaw);
  return {
    y: Number(s.slice(0, 4)),
    mo: Number(s.slice(4, 6)),
    d: Number(s.slice(6, 8)),
    secondsOfDay:
      Number(s.slice(8, 10)) * 3600 + Number(s.slice(10, 12)) * 60 + Number(s.slice(12, 14)),
  };
}

/** 'HH:MM:SS' or 'HH:MM' -> seconds since midnight, else null. */
function cutoffToSeconds(cutoff) {
  if (cutoff === null || cutoff === undefined) return null;
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(String(cutoff).trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  const se = m[3] === undefined ? 0 : Number(m[3]);
  if (h > 23 || mi > 59 || se > 59) return null;
  return h * 3600 + mi * 60 + se;
}

/** Calendar date of the punch and of the day before it, as UTC-math dates. */
function calendarDates(ioTimeRaw) {
  const { y, mo, d, secondsOfDay } = splitIoTime(ioTimeRaw);
  const dayMs = Date.UTC(y, mo - 1, d);
  const prevMs = dayMs - 24 * 3600 * 1000;
  const iso = (ms) => {
    const dt = new Date(ms);
    return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
  };
  return {
    calendarDate: iso(dayMs),
    previousDate: iso(prevMs),
    // 0=Sunday..6=Saturday, the numbering work_shift_weekly_schedule uses.
    previousDayOfWeek: new Date(prevMs).getUTCDay(),
    secondsOfDay,
  };
}

/**
 * Decide the attendance date.
 *
 * @param {object} input
 * @param {string} input.ioTimeRaw   14 digits, already validated by protocol.js
 * @param {object|null} input.employee  {employee_id, default_work_shift_id} or
 *        null when the code matched nobody
 * @param {function} input.readSchedule  (workShiftId, dayOfWeek) => row|null,
 *        where row has ONLY the SCHEDULE_COLUMNS. Synchronous - the caller
 *        has already fetched (and may cache) the row.
 * @returns {{
 *   status: string, attendance_date: string|null, calendar_date: string,
 *   work_shift_id: number|null, work_shift_weekly_schedule_id: number|null,
 *   cutoff_applied: string|null, previous_day_of_week: number
 * }}
 */
function deriveAttendanceDate({ ioTimeRaw, employee, readSchedule }) {
  const { calendarDate, previousDate, previousDayOfWeek, secondsOfDay } = calendarDates(ioTimeRaw);

  const base = {
    calendar_date: calendarDate,
    previous_day_of_week: previousDayOfWeek,
    work_shift_id: null,
    work_shift_weekly_schedule_id: null,
    cutoff_applied: null,
  };

  if (!employee) {
    return { ...base, status: STATUS.UNMATCHED, attendance_date: null };
  }

  const shiftId = employee.default_work_shift_id;
  if (shiftId === null || shiftId === undefined) {
    return { ...base, status: STATUS.NO_SHIFT, attendance_date: null };
  }
  base.work_shift_id = Number(shiftId);

  const row = readSchedule(base.work_shift_id, previousDayOfWeek);
  if (!row) {
    return { ...base, status: STATUS.NO_SCHEDULE_ROW, attendance_date: null };
  }
  assertScheduleShape(row);
  base.work_shift_weekly_schedule_id =
    row.work_shift_weekly_schedule_id === undefined ? null : row.work_shift_weekly_schedule_id;

  const working = Number(row.is_working_day) === 1 || row.is_working_day === true;
  if (!working) {
    // A rest day never claims the following morning's punches.
    return { ...base, status: STATUS.OK, attendance_date: calendarDate };
  }

  const cutoffSeconds = cutoffToSeconds(row.attendance_day_cutoff);
  if (cutoffSeconds === null) {
    // Configuration error (A1): a working row without a cutoff. Surfaced,
    // never defaulted.
    return { ...base, status: STATUS.MISSING_CUTOFF, attendance_date: null };
  }
  base.cutoff_applied = normaliseCutoff(row.attendance_day_cutoff);

  return {
    ...base,
    status: STATUS.OK,
    attendance_date: secondsOfDay < cutoffSeconds ? previousDate : calendarDate,
  };
}

function normaliseCutoff(cutoff) {
  const s = cutoffToSeconds(cutoff);
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

/**
 * The reader must hand over ONLY the columns this rule may see. A row that
 * carries timing or pay fields means somebody widened the query, and that is
 * exactly the scope creep R18 exists to prevent - so it is a loud failure,
 * not a quiet ignore.
 */
function assertScheduleShape(row) {
  for (const key of Object.keys(row)) {
    if (!SCHEDULE_COLUMNS.includes(key)) {
      throw new Error(
        `attendanceDate: schedule row carries '${key}', which date attribution must not read`
      );
    }
  }
}

module.exports = {
  STATUS,
  SCHEDULE_COLUMNS,
  deriveAttendanceDate,
  calendarDates,
  cutoffToSeconds,
};
