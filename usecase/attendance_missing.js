/**
 * MISSING ATTENDANCE - the one population builder.
 *
 * ============================================ WHY THIS FILE IS THE ONLY ONE =
 *
 * Two things consume Missing Attendance: the report a manager opens, and the
 * 07:00 job that messages each employee privately on Telegram. They MUST name
 * the same people, so there is exactly one place the population is built -
 * `findMissingAttendance` below - and both consumers call it:
 *
 *   the report     `getReport(filters)`          any window, any filters
 *   Telegram       `getTelegramCandidates(...)`  the same call with
 *                                                from = to = yesterday
 *
 * `getTelegramCandidates` adds NO predicate of its own. It pins the window
 * and asks for every branch; the odd-punch test, the eligibility test and the
 * completed-date test are the shared ones in `utils/attendance_missing.js`
 * and are applied in one place, here. A parity test asserts the two
 * populations agree for a shared date, and it fails if anybody ever adds a
 * condition to one path.
 *
 * ================================== WHY IT REUSES THE DASHBOARD'S MACHINERY =
 *
 * Every attendance fact this needs - the dated shift assignment and its
 * date override, the shift configuration version in force on that date, the
 * raw punches re-dated by that version's own cutoff, voided punches removed,
 * duplicates ignored, approved regularized punches joined, and the STORED
 * calculation winning for a closed date - is already resolved by
 * `usecase/attendance_dashboard.js#loadBatch` / `#computeDaysForEmployee`.
 * Those two are reused verbatim.
 *
 * That is the whole reason this report agrees with the dashboard and with the
 * employee's own screen about what a day's punch count IS. A report that
 * counted `biomax_punch` rows itself would differ from all three the first
 * time somebody double-tapped the terminal or a punch was voided - and it
 * would differ in the direction that matters, turning an even day odd and
 * chasing an employee for nothing.
 *
 * IT WRITES NOTHING AND CALCULATES NOTHING NEW. No attendance row, no payroll
 * figure and no punch is touched by any path in this file.
 */

const { toDateOnly } = require("../utils/shiftResolution");
const { addDays, datePart } = require("../utils/attendance_engine");
const { istToday } = require("../utils/istDate");
const eligibility = require("../utils/attendance_eligibility");
const missing = require("../utils/attendance_missing");

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The widest window the report will answer. Same number as the Attendance
 * List's, for the same reason: one screen's worth of chasing is a quarter at
 * most, and an unbounded range is an unbounded scan over every punch in the
 * company.
 */
const MAX_RANGE_DAYS = 92;

/**
 * The most employees one request will build days for.
 *
 * The dashboard's limit, and the same trade: past this the batch reads stop
 * being a fixed number of statements over a sane row count. It REFUSES rather
 * than truncating - a report that silently dropped half the company would be
 * read as "those people are fine".
 */
const MAX_POPULATION = 2000;

function validationError(message) {
  const err = new Error(message);
  err.name = "ValidationError";
  return err;
}

/** Days between two `YYYY-MM-DD`, UTC integer math, no zone involved. */
function daysBetween(from, to) {
  const d = (s) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
  return Math.round((d(to) - d(from)) / 86400000);
}

function dateList(from, to) {
  const dates = [];
  let cursor = from;
  let guard = 0;
  while (cursor <= to && guard <= MAX_RANGE_DAYS) {
    dates.push(cursor);
    cursor = addDays(cursor, 1);
    guard += 1;
  }
  return dates;
}

const optionalId = (value, name) => {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw validationError(`${name} must be a positive whole number`);
  return n;
};

const optionalText = (value, max = 100) => {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s === "" ? null : s.slice(0, max);
};

/** `YYYY-MM-DD HH:MM:SS` -> `HH:MM`. Anything else -> null, never a guess. */
function clockTime(ioTime) {
  const m = /^\d{4}-\d{2}-\d{2}[T ](\d{2}):(\d{2})/.exec(String(ioTime || "").trim());
  return m ? `${m[1]}:${m[2]}` : null;
}

/**
 * The punch times of a day, in order, as the screen and the export show them.
 *
 * A punch that crossed midnight carries the NEXT calendar date, and that is
 * information rather than noise on a night shift - so a time whose date part
 * differs from the attendance date is suffixed `(+1)` rather than silently
 * shown as an earlier clock time than the punch before it.
 */
function punchTimesOf(day, attendanceDate) {
  return (day && Array.isArray(day.effective_punches) ? day.effective_punches : [])
    .map((p) => {
      const time = clockTime(p.io_time);
      if (time === null) return null;
      const on = datePart(p.io_time);
      return on && on !== attendanceDate ? `${time} (+1)` : time;
    })
    .filter((t) => t !== null);
}

module.exports = (attendanceMissingRepo, attendanceDashboardUsecase, options = {}) => {
  // THE CLOCK IS INJECTED. Everything dated in this file - and in particular
  // "today", which decides what may be reported at all - comes from here, so
  // a test pins it and production passes nothing.
  const clock = typeof options.now === "function" ? options.now : () => Date.now();

  /** Today's IST business date. Never a UTC date - see `utils/istDate.js`. */
  const businessToday = (override = null) => istToday(override) || istToday();

  /**
   * Normalise and validate a report request.
   *
   * `store_ids` arrives ALREADY NARROWED to the caller's authorized scope by
   * the route, and is passed straight through. Nothing in this file widens
   * it, and `null` here means "no restriction" only because the route decided
   * the caller is authorized company-wide.
   */
  const normalizeFilters = (query = {}, { today = null } = {}) => {
    const from = optionalText(query.from_date, 10);
    const to = optionalText(query.to_date, 10);
    if (!DATE_RE.test(String(from || "")) || !DATE_RE.test(String(to || ""))) {
      throw validationError("from_date and to_date are required as YYYY-MM-DD");
    }
    const span = daysBetween(from, to);
    if (Number.isNaN(span) || span < 0) throw validationError("to_date must not be before from_date");
    if (span > MAX_RANGE_DAYS - 1) {
      throw validationError(`the range may cover at most ${MAX_RANGE_DAYS} days`);
    }

    return {
      from_date: from,
      to_date: to,
      today: today || businessToday(),
      store_ids: query.store_ids === undefined ? null : query.store_ids,
      department_id: optionalId(query.department_id, "department_id"),
      employee_id: optionalId(query.employee_id, "employee_id"),
      work_shift_id: optionalId(query.work_shift_id, "work_shift_id"),
      search: optionalText(query.search),
    };
  };

  /**
   * ===================== THE POPULATION. THE ONLY ONE. =====================
   *
   * Five steps, in this order, and every one of them delegates its rule:
   *
   *   1. CLAMP THE WINDOW to completed attendance dates
   *      (`attendance_missing.clampToReportable`). Today and every future
   *      date are removed here, ONCE, before a single row is read - so no
   *      later step can put them back, and the Telegram path gets the same
   *      treatment as the screen.
   *   2. LOAD THE CANDIDATES - employment overlapping the window, filters and
   *      LOCATION SCOPE applied in SQL.
   *   3. BUILD THE DAYS with the dashboard's own batch reads and day
   *      computation: dated shift assignment, date overrides, the config
   *      version in force, effective punches, stored history for closed days.
   *   4. APPLY THE SHARED RULE per employee/date
   *      (`attendance_missing.isMissingAttendance`), which re-asks
   *      eligibility PER DATE - this is what keeps a leaver out of the dates
   *      after they left and a joiner out of the dates before they arrived.
   *   5. APPLY THE DATED SHIFT FILTER, if one was asked for, against the
   *      shift RESOLVED FOR THAT DATE rather than the employee's current
   *      default.
   */
  const findMissingAttendance = async (filters) => {
    const today = filters.today || businessToday();
    const window = missing.clampToReportable({
      from: filters.from_date,
      to: filters.to_date,
      today,
    });

    const meta = {
      from_date: filters.from_date,
      to_date: filters.to_date,
      today,
      latest_reportable_date: missing.latestReportableDate(today),
      effective_from_date: window ? window.from : null,
      effective_to_date: window ? window.to : null,
      // TRUE when the caller asked for today or later and got less back. The
      // screen says so out loud rather than letting an empty tail read as
      // "nobody missed a punch yesterday".
      clamped_to_completed_dates: window ? window.clamped : true,
      row_count: 0,
      employee_count: 0,
    };

    // Nothing of the requested range has completed. There is genuinely
    // nothing to show, and saying so is not the same as showing nothing.
    if (!window) return { meta, data: [] };

    const employees = await attendanceMissingRepo.listCandidateEmployees({
      from_date: window.from,
      to_date: window.to,
      store_ids: filters.store_ids === undefined ? null : filters.store_ids,
      department_id: filters.department_id || null,
      employee_id: filters.employee_id || null,
      search: filters.search || null,
    });

    if (!employees || employees.length === 0) return { meta, data: [] };
    if (employees.length > MAX_POPULATION) {
      throw validationError(
        `${employees.length} employees match these filters; narrow the outlet, department or date range (limit ${MAX_POPULATION})`
      );
    }

    const dates = dateList(window.from, window.to);
    const batch = await attendanceDashboardUsecase.loadBatch({
      employees,
      from: window.from,
      to: window.to,
    });
    const now = clock();

    const rows = [];
    employees.forEach((employee) => {
      // The cheap skip first: somebody whose employment does not overlap the
      // window at all never has their days computed.
      if (!eligibility.eligibleInRange(employee, window.from, window.to)) return;

      const days = attendanceDashboardUsecase.computeDaysForEmployee({
        employee,
        dates,
        batch,
        now,
      });

      days.forEach((day) => {
        const date = toDateOnly(day.attendance_date);
        if (!missing.isMissingAttendance({ employee, date, day, today })) return;
        // THE SHIFT FILTER IS DATED. `day.work_shift_id` is what
        // `resolveShiftForDate` decided for THIS date from the assignment
        // history and any date override - not `new_employee.shift_id`.
        if (filters.work_shift_id && Number(day.work_shift_id) !== Number(filters.work_shift_id)) {
          return;
        }
        rows.push(shapeRow({ employee, day, date }));
      });
    });

    rows.sort(
      (a, b) =>
        (a.attendance_date < b.attendance_date ? -1 : a.attendance_date > b.attendance_date ? 1 : 0) ||
        a.employee_id - b.employee_id
    );

    meta.row_count = rows.length;
    meta.employee_count = new Set(rows.map((r) => r.employee_id)).size;
    return { meta, data: rows };
  };

  /**
   * One report row.
   *
   * `status` is the one shared string, so the screen, the export and the
   * Telegram message cannot describe the same fact three ways.
   *
   * THE CORRECTION COLUMNS come from data attendance already keeps - the
   * approval request that `computeDaysForEmployee` already slotted onto the
   * day - rather than from a new lookup. `has_correction_request` answers
   * "has somebody already raised one for this date", which is what stops a
   * manager chasing a correction that is sitting in an approval queue.
   */
  const shapeRow = ({ employee, day, date }) => ({
    attendance_date: date,
    employee_id: Number(employee.employee_id),
    employee_name: employee.employee_name || null,
    store_id: employee.store_id === null || employee.store_id === undefined ? null : Number(employee.store_id),
    outlet_name: employee.outlet_nickname || employee.outlet_name || null,
    department_id: employee.department_id === null || employee.department_id === undefined
      ? null
      : Number(employee.department_id),
    department_name: employee.department_name || null,
    designation_name: employee.designation_name || null,
    work_shift_id: day.work_shift_id === null || day.work_shift_id === undefined ? null : Number(day.work_shift_id),
    shift_name: day.shift_name || null,
    shift_code: day.shift_code || null,
    punch_count: missing.punchCountOf(day.punch_count),
    punch_times: punchTimesOf(day, date),
    status: missing.MISSING_ATTENDANCE_STATUS,
    // The attendance status the engine gave the day, carried beside the
    // report's own verdict so a reader can see WHY it is not final without
    // the report restating the engine's vocabulary as its own.
    attendance_status: day.status || null,
    correction_request_id: day.regularization_request_id || null,
    correction_request_pending: !!day.regularization_request_pending,
    has_correction_request: day.regularization_request_id !== null && day.regularization_request_id !== undefined,
  });

  /** The report, filters validated and the window clamped. */
  const getReport = async (query, { today = null } = {}) => {
    const filters = normalizeFilters(query, { today });
    return findMissingAttendance(filters);
  };

  /**
   * ===================== THE TELEGRAM CANDIDATES ===========================
   *
   * YESTERDAY, EVERY BRANCH, THE SAME RULE. This function adds no predicate:
   * it pins the window to the one date the 07:00 job is about and calls the
   * same builder the report calls. Whatever the report would show for
   * yesterday is exactly who is messaged.
   *
   * `store_ids: null` is deliberate and is NOT a permission decision. There
   * is no human caller here - a cron job has no branch - and the message goes
   * to the EMPLOYEE about their OWN attendance, which they are entitled to
   * see wherever they work. Nobody learns anything about anybody else.
   */
  const getTelegramCandidates = async ({ today = null } = {}) => {
    const on = today || businessToday();
    const yesterday = missing.yesterdayOf(on);
    if (!yesterday) throw validationError("could not resolve yesterday's attendance date");
    return findMissingAttendance({
      from_date: yesterday,
      to_date: yesterday,
      today: on,
      store_ids: null,
      department_id: null,
      employee_id: null,
      work_shift_id: null,
      search: null,
    });
  };

  return {
    MAX_RANGE_DAYS,
    MAX_POPULATION,
    businessToday,
    normalizeFilters,
    findMissingAttendance,
    getReport,
    getTelegramCandidates,
  };
};

module.exports.MAX_RANGE_DAYS = MAX_RANGE_DAYS;
module.exports.MAX_POPULATION = MAX_POPULATION;
