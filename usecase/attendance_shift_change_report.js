/**
 * THE SHIFT CHANGE ELIGIBILITY REPORT.
 *
 * One row per employee per attendance date, answering THREE questions that
 * are deliberately kept apart because they are not the same question:
 *
 *   Can Raise Shift Change?            would `raiseShiftChangeRequest`
 *                                      ACCEPT a request for this date?
 *   Worked Longer Than Assigned Shift? did the punches actually run past the
 *                                      permanent shift's normal minutes?
 *   Request Status                     what the approval workflow says:
 *                                      Not Raised | Pending | Approved |
 *                                      Rejected.
 *
 * ================== WHY ELIGIBILITY IS NOT COMPUTED IN THIS FILE ============
 *
 * It is `utils/shift_change_eligibility.js#decide` - the SAME function
 * `usecase/attendance_regularization.js#raiseShiftChangeRequest` refuses with,
 * on the same facts, in the same order. Nothing here re-tests a window, a
 * payroll lock, an existing request or a longer shift. So "Can Raise = Yes"
 * means exactly "the backend would accept this", and a No carries the very
 * sentence the employee would have been shown. HR and the Mini App cannot
 * drift apart, because there is nothing to drift.
 *
 * IN PARTICULAR, PUNCHES DO NOT MAKE ANYBODY ELIGIBLE. Production's rule is
 * "a LONGER shift exists for this date, and the date is still open" - it has
 * never looked at what was punched, and this report does not teach it to.
 * Whether somebody worked longer is reported BESIDE eligibility, in its own
 * column, from the attendance engine's own worked minutes. HR's default view
 * asks for both at once (Can Raise = Yes AND Worked Longer = Yes AND Not
 * Raised) - that is a FILTER over two honest columns, not a third definition
 * of who may raise a request.
 *
 * ============================== WHY IT AGREES WITH EVERY ATTENDANCE SCREEN ==
 *
 * Every attendance fact it needs - the dated shift assignment and its date
 * override, the shift configuration version in force on that date, the raw
 * punches re-dated by that version's own cutoff, voided punches removed,
 * duplicates ignored, approved regularized punches joined, and the STORED
 * calculation winning for a closed date - comes from
 * `usecase/attendance_dashboard.js#loadBatch` / `#computeDaysForEmployee`,
 * reused verbatim. The worked minutes in this report are the worked minutes
 * on the employee's own screen, for the same reason Missing Attendance's
 * punch count is.
 *
 * ================================================= IT WRITES NOTHING ========
 *
 * There is no write path in this file, none in its repository and none
 * reachable from either. Opening or exporting the report does not calculate
 * and store a day, does not move a shift assignment, does not create,
 * approve or reject a request and does not touch a payroll lock. A CLOSED
 * PAYROLL MONTH IS READ THROUGH THE STORED CALCULATION - the same read path
 * the employee's own screen uses - and comes back exactly as it was left;
 * the eligibility rule then reports such a date as Can Raise = No, because a
 * settled month can no longer be recalculated by anybody.
 *
 * ================================================= AND IT HAS NO N+1 ========
 *
 * A fixed number of statements regardless of how many employees and dates
 * are in scope: one population read, the dashboard's batch (seven reads), one
 * read of the active shift master, one read of every SHIFT_CHANGE request in
 * the window, and one bulk payroll-lock read. Everything else - resolving each
 * candidate shift for each date, comparing NRMs, matching requests to rows -
 * is in memory over those results.
 */

const { toDateOnly } = require("../utils/shiftResolution");
const { addDays, datePart } = require("../utils/attendance_engine");
const { istToday } = require("../utils/istDate");
const eligibility = require("../utils/attendance_eligibility");
const shiftChange = require("../utils/shift_change_eligibility");

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The widest window the report will answer. The same number as Missing
 * Attendance's and the Attendance List's, for the same reason: an unbounded
 * range is an unbounded scan over every punch in the company.
 */
const MAX_RANGE_DAYS = 92;

/**
 * The most employees one request will build days for. The dashboard's limit.
 * It REFUSES rather than truncating - a report that silently dropped half the
 * company would be read as "nobody else is eligible".
 */
const MAX_POPULATION = 2000;

/** The workflow's four states, as the report names them for a person. */
const REQUEST_STATUS_LABEL = Object.freeze({
  PENDING: "Pending",
  APPROVED: "Approved",
  REJECTED: "Rejected",
});
const NOT_RAISED = "Not Raised";

/** The filter vocabulary the screen and the export share. */
const REQUEST_STATUS_FILTER = Object.freeze(["ALL", "NOT_RAISED", "PENDING", "APPROVED", "REJECTED"]);
const TRISTATE_FILTER = Object.freeze(["ALL", "YES", "NO"]);

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

const oneOf = (value, allowed, name) => {
  if (value === undefined || value === null || value === "") return allowed[0];
  const v = String(value).trim().toUpperCase();
  if (!allowed.includes(v)) throw validationError(`${name} must be one of ${allowed.join(", ")}`);
  return v;
};

/** `YYYY-MM-DD HH:MM:SS` -> `HH:MM`. Anything else -> null, never a guess. */
function clockTime(ioTime) {
  const m = /^\d{4}-\d{2}-\d{2}[T ](\d{2}):(\d{2})/.exec(String(ioTime || "").trim());
  return m ? `${m[1]}:${m[2]}` : null;
}

/**
 * A punch time as the screen shows it.
 *
 * A punch that crossed midnight carries the NEXT calendar date, and on a
 * night shift that is information rather than noise - so a time whose date
 * part differs from the attendance date is suffixed `(+1)` rather than shown
 * as an earlier clock time than the punch before it.
 */
function punchAt(punch, attendanceDate) {
  if (!punch) return null;
  const time = clockTime(punch.io_time);
  if (time === null) return null;
  const on = datePart(punch.io_time);
  return on && on !== attendanceDate ? `${time} (+1)` : time;
}

/** Minutes as `H:MM`, the shape every attendance screen prints hours in. */
function asHours(minutes) {
  const m = Math.max(0, Math.trunc(Number(minutes) || 0));
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
}

module.exports = (
  attendanceShiftChangeReportRepo,
  attendanceDashboardUsecase,
  attendanceCalculationUsecase,
  options = {}
) => {
  // THE CLOCK IS INJECTED, so a test pins "today" - which decides the whole
  // backdating window - and production passes nothing.
  const clock = typeof options.now === "function" ? options.now : () => Date.now();

  /** Today's IST business date. Never a UTC date - see `utils/istDate.js`. */
  const businessToday = (override = null) => istToday(override) || istToday();

  /**
   * Normalise and validate a report request.
   *
   * `store_ids` arrives ALREADY NARROWED to the caller's authorized scope by
   * the route and is passed straight through. Nothing in this file widens it,
   * and `null` means "no restriction" only because the route decided the
   * caller is authorized company-wide.
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
      designation_id: optionalId(query.designation_id, "designation_id"),
      employee_id: optionalId(query.employee_id, "employee_id"),
      can_raise: oneOf(query.can_raise, TRISTATE_FILTER, "can_raise"),
      worked_longer: oneOf(query.worked_longer, TRISTATE_FILTER, "worked_longer"),
      request_status: oneOf(query.request_status, REQUEST_STATUS_FILTER, "request_status"),
      search: optionalText(query.search),
    };
  };

  /**
   * THE CANDIDATE SHIFTS FOR A DATE - every active work shift, resolved to
   * that date's configuration version, with its NRM.
   *
   * IT IS THE SAME SET `shiftChangeOptions` OFFERS THE EMPLOYEE, resolved the
   * same way: the active shift master (one read), each shift resolved through
   * the dashboard's own `employeeResolver` over the `shiftCache` `loadBatch`
   * already loaded, so "which version of shift 7 applied on this Tuesday" is
   * answered once for the whole application.
   *
   * ONE RESOLVER PER SHIFT, NOT PER EMPLOYEE-DATE. A shift's schedule does not
   * depend on who is looking at it, so the resolvers are built once and
   * memoize their own definitions; a fortnight over two thousand employees
   * resolves each (shift, date) pair exactly once.
   */
  const candidateShiftIndex = ({ batch, shifts }) => {
    const resolvers = new Map();
    const resolverFor = (workShiftId) => {
      if (resolvers.has(workShiftId)) return resolvers.get(workShiftId);
      const resolver = attendanceDashboardUsecase.employeeResolver({
        shiftCache: batch.shiftCache,
        // A SYNTHETIC ASSIGNMENT, standing for "this shift, on every date".
        // It is never written anywhere and never leaves this function: it
        // exists so the candidate shift is resolved by the PRODUCTION
        // resolver rather than by a schedule lookup invented here.
        assignments: [
          {
            employee_work_shift_assignment_id: null,
            employee_id: 0,
            work_shift_id: workShiftId,
            effective_from: "1970-01-01",
            source: "CANDIDATE_PROBE",
          },
        ],
        overrides: [],
      });
      resolvers.set(workShiftId, resolver);
      return resolver;
    };

    const byDate = new Map();
    return (date) => {
      if (byDate.has(date)) return byDate.get(date);
      const candidates = shifts.map((shift) => {
        const id = Number(shift.work_shift_id);
        const resolution = resolverFor(id).resolutionFor(date);
        return {
          work_shift_id: id,
          shift_code: shift.shift_code || null,
          shift_name: shift.shift_name || null,
          is_working_day: resolution.snapshot ? !!resolution.snapshot.is_working_day : false,
          nrm_minutes: shiftChange.nrmOfSnapshot(resolution.snapshot),
        };
      });
      byDate.set(date, candidates);
      return candidates;
    };
  };

  /**
   * ====================== THE REPORT. ONE PASS, NO N+1. ====================
   *
   * 1. LOAD THE CANDIDATES - employment overlapping the window, filters and
   *    LOCATION SCOPE applied in SQL.
   * 2. BUILD THE DAYS with the dashboard's own batch reads and day
   *    computation.
   * 3. READ THE REQUESTS for the whole population in one statement, and the
   *    payroll locks for the whole population in one more.
   * 4. DECIDE each (employee, date) with the SHARED eligibility rule, and
   *    measure "worked longer" separately from the engine's own minutes.
   * 5. APPLY THE VIEW FILTERS - which narrow rows and decide nothing.
   */
  const findRows = async (filters) => {
    const today = filters.today || businessToday();

    const meta = {
      from_date: filters.from_date,
      to_date: filters.to_date,
      today,
      max_backdate_days: shiftChange.MAX_BACKDATE_DAYS,
      max_forward_days: shiftChange.MAX_FORWARD_DAYS,
      earliest_raisable_date: shiftChange.addDays(today, -shiftChange.MAX_BACKDATE_DAYS),
      latest_raisable_date: shiftChange.addDays(today, shiftChange.MAX_FORWARD_DAYS),
      row_count: 0,
      employee_count: 0,
      actionable_count: 0,
    };

    const employees = await attendanceShiftChangeReportRepo.listCandidateEmployees({
      from_date: filters.from_date,
      to_date: filters.to_date,
      store_ids: filters.store_ids === undefined ? null : filters.store_ids,
      designation_id: filters.designation_id || null,
      employee_id: filters.employee_id || null,
      search: filters.search || null,
    });

    if (!employees || employees.length === 0) return { meta, data: [] };
    if (employees.length > MAX_POPULATION) {
      throw validationError(
        `${employees.length} employees match these filters; narrow the outlet, designation or date range (limit ${MAX_POPULATION})`
      );
    }

    const dates = dateList(filters.from_date, filters.to_date);
    const employeeIds = employees.map((e) => Number(e.employee_id));

    const [batch, shiftMaster, requests] = await Promise.all([
      attendanceDashboardUsecase.loadBatch({
        employees,
        from: filters.from_date,
        to: filters.to_date,
      }),
      attendanceCalculationUsecase.listDateShiftOptions(),
      attendanceShiftChangeReportRepo.listShiftChangeRequests({
        employee_ids: employeeIds,
        from_date: filters.from_date,
        to_date: filters.to_date,
      }),
    ]);

    const shifts = Array.isArray(shiftMaster) ? shiftMaster : (shiftMaster && shiftMaster.data) || [];
    const candidatesFor = candidateShiftIndex({ batch, shifts });

    /**
     * THE CURRENT REQUEST PER (EMPLOYEE, DATE), read from the workflow.
     *
     * The rows arrive ordered by id, so the LAST one wins - which is the
     * current one when a REJECTED attempt was followed by a fresh submission.
     * Nothing here decides what a request CAME TO; `status` is the approval
     * chain's own column and is reported as found.
     */
    const requestByKey = new Map();
    (requests || []).forEach((r) => {
      requestByKey.set(`${Number(r.employee_id)}:${toDateOnly(r.attendance_date)}`, r);
    });

    // THE PAYROLL LOCKS FOR EVERY ROW, IN ONE READ. Asked as employee-months,
    // which is what the lock is granular to, and consulted in memory
    // afterwards. This is a SELECT: it closes nothing and opens nothing.
    const lockProbe = [];
    employees.forEach((employee) => {
      dates.forEach((date) => {
        if (!eligibility.eligibleOn(employee, date)) return;
        lockProbe.push({ employee_id: Number(employee.employee_id), attendance_date: date });
      });
    });
    const lockedPeriods =
      lockProbe.length > 0
        ? await attendanceCalculationUsecase.findPayrollLockedPeriodsBulk(lockProbe)
        : [];
    const lockedByEmployeeMonth = new Map();
    (lockedPeriods || []).forEach((p) => {
      lockedByEmployeeMonth.set(`${Number(p.employee_id)}:${Number(p.year)}:${Number(p.month)}`, p);
    });
    const locksFor = (employeeId, date) => {
      const hit = lockedByEmployeeMonth.get(
        `${employeeId}:${Number(date.slice(0, 4))}:${Number(date.slice(5, 7))}`
      );
      return hit ? [hit] : [];
    };

    const now = clock();
    const rows = [];

    employees.forEach((employee) => {
      // The cheap skip first: somebody whose employment does not overlap the
      // window at all never has their days computed.
      if (!eligibility.eligibleInRange(employee, filters.from_date, filters.to_date)) return;

      const days = attendanceDashboardUsecase.computeDaysForEmployee({
        employee,
        dates,
        batch,
        now,
      });

      // The employee's own resolver, over the SAME cache the days were built
      // from - used for one thing only: the PERMANENT shift for each date,
      // which is what a shift change is measured against and what regular
      // time is paid against. `resolutionFor` would answer with an approved
      // override applied, and comparing an override against itself would read
      // as "no longer shift available" the day after one was granted.
      const resolver = attendanceDashboardUsecase.employeeResolver({
        shiftCache: batch.shiftCache,
        assignments: batch.assignmentsByEmployee.get(String(employee.employee_id)) || [],
        overrides: batch.overridesByEmployee.get(String(employee.employee_id)) || [],
      });

      days.forEach((day) => {
        const date = toDateOnly(day.attendance_date);
        // PER-DATE EMPLOYMENT, the shared rule - what keeps a leaver off the
        // dates after they left and a joiner off the ones before they came.
        if (!eligibility.eligibleOn(employee, date)) return;

        const baseResolution = resolver.baseResolutionFor(date);
        const baseShiftId =
          baseResolution.work_shift_id === null || baseResolution.work_shift_id === undefined
            ? null
            : Number(baseResolution.work_shift_id);
        const baseNrm = shiftChange.nrmOfSnapshot(baseResolution.snapshot);

        const request = requestByKey.get(`${Number(employee.employee_id)}:${date}`) || null;

        // ================= THE RULE. NOT RESTATED, CALLED. =================
        const verdict = shiftChange.decide({
          attendance_date: date,
          today,
          payroll_locked: locksFor(Number(employee.employee_id), date),
          existing_request: request,
          base_work_shift_id: baseShiftId,
          has_longer_option: shiftChange.hasLongerShiftOption({
            base_nrm_minutes: baseNrm,
            // The employee's own shift is not a shift they can change TO.
            candidates: candidatesFor(date).filter((c) => c.work_shift_id !== baseShiftId),
          }),
        });

        rows.push(
          shapeRow({ employee, day, date, baseResolution, baseNrm, verdict, request, resolver })
        );
      });
    });

    rows.sort(
      (a, b) =>
        (a.attendance_date < b.attendance_date ? -1 : a.attendance_date > b.attendance_date ? 1 : 0) ||
        a.employee_id - b.employee_id
    );

    // Counted BEFORE the view filters, so the screen can say how many rows
    // HR's actionable question has even while they are looking at another cut.
    meta.actionable_count = rows.filter(
      (r) => r.can_raise && r.worked_longer && r.request_status === NOT_RAISED
    ).length;

    const visible = rows.filter((row) => matchesView(row, filters));
    meta.row_count = visible.length;
    meta.employee_count = new Set(visible.map((r) => r.employee_id)).size;
    return { meta, data: visible };
  };

  /**
   * The view filters. THEY NARROW ROWS AND DECIDE NOTHING - every one of them
   * tests a value the rule already produced, so changing a filter can never
   * change whether somebody is eligible, only whether HR is looking at them.
   */
  const matchesView = (row, filters) => {
    if (filters.can_raise === "YES" && !row.can_raise) return false;
    if (filters.can_raise === "NO" && row.can_raise) return false;
    if (filters.worked_longer === "YES" && !row.worked_longer) return false;
    if (filters.worked_longer === "NO" && row.worked_longer) return false;
    if (filters.request_status !== "ALL") {
      const wanted =
        filters.request_status === "NOT_RAISED"
          ? NOT_RAISED
          : REQUEST_STATUS_LABEL[filters.request_status];
      if (row.request_status !== wanted) return false;
    }
    return true;
  };

  /**
   * One report row.
   *
   * ASSIGNED SHIFT IS THE PERMANENT ONE for the date, because that is what a
   * shift change is measured against and what regular time is paid against.
   * WORKED and EXTRA come from the engine's own day - the same minutes the
   * employee's screen shows - and EXTRA is what was worked beyond the
   * permanent shift's normal minutes, which is the figure a shift change
   * exists to regularise.
   */
  const shapeRow = ({ employee, day, date, baseResolution, baseNrm, verdict, request, resolver }) => {
    const punches = Array.isArray(day.effective_punches) ? day.effective_punches : [];
    const workedMinutes = Number(day.worked_minutes) || 0;
    const extraMinutes = Math.max(0, workedMinutes - (Number(baseNrm) || 0));
    const workedLonger = shiftChange.workedLongerThanAssigned({
      worked_minutes: workedMinutes,
      base_nrm_minutes: baseNrm,
    });

    return {
      attendance_date: date,
      employee_id: Number(employee.employee_id),
      employee_name: employee.employee_name || null,
      store_id:
        employee.store_id === null || employee.store_id === undefined ? null : Number(employee.store_id),
      outlet_name: employee.outlet_nickname || employee.outlet_name || null,
      designation_id:
        employee.designation_id === null || employee.designation_id === undefined
          ? null
          : Number(employee.designation_id),
      designation_name: employee.designation_name || null,

      assigned_work_shift_id:
        baseResolution.work_shift_id === null || baseResolution.work_shift_id === undefined
          ? null
          : Number(baseResolution.work_shift_id),
      // The NAME comes from the shift master through the resolver - a dated
      // snapshot carries the code it was built with but not the display name,
      // exactly as the dashboard reads it.
      assigned_shift_name: baseResolution.work_shift_id
        ? resolver.shiftNameFor(baseResolution.work_shift_id)
        : null,
      assigned_shift_code: baseResolution.snapshot
        ? baseResolution.snapshot.shift_code || null
        : baseResolution.work_shift_id
        ? resolver.shiftCodeFor(baseResolution.work_shift_id)
        : null,
      assigned_shift_in_time: baseResolution.snapshot ? baseResolution.snapshot.in_time || null : null,
      assigned_shift_out_time: baseResolution.snapshot ? baseResolution.snapshot.out_time || null : null,
      assigned_nrm_minutes: baseNrm === null ? null : Number(baseNrm),

      first_punch: punchAt(punches[0], date),
      last_punch: punchAt(punches[punches.length - 1], date),
      punch_count: punches.length,

      worked_minutes: workedMinutes,
      worked_hours: asHours(workedMinutes),
      extra_minutes: extraMinutes,
      extra_hours: asHours(extraMinutes),

      // "Can Raise Shift Change?" - the production rule's verdict, verbatim.
      can_raise: verdict.can_raise,
      eligibility_reason_code: verdict.reason_code,
      eligibility_reason: verdict.reason,

      // A SEPARATE FACT, from the punches. It authorises nothing.
      worked_longer: workedLonger,

      request_status: request ? REQUEST_STATUS_LABEL[request.status] || request.status : NOT_RAISED,
      request_id: request ? Number(request.attendance_approval_request_id) : null,

      // The day's own attendance status, carried beside the report's verdict
      // so a reader can see the state of the date without the report
      // restating the engine's vocabulary as its own.
      attendance_status: day.status || null,
    };
  };

  /** The report, filters validated. */
  const getReport = async (query, { today = null } = {}) => {
    const filters = normalizeFilters(query, { today });
    return findRows(filters);
  };

  return {
    MAX_RANGE_DAYS,
    MAX_POPULATION,
    REQUEST_STATUS_FILTER,
    TRISTATE_FILTER,
    NOT_RAISED,
    businessToday,
    normalizeFilters,
    findRows,
    getReport,
  };
};

module.exports.MAX_RANGE_DAYS = MAX_RANGE_DAYS;
module.exports.MAX_POPULATION = MAX_POPULATION;
module.exports.REQUEST_STATUS_FILTER = REQUEST_STATUS_FILTER;
module.exports.TRISTATE_FILTER = TRISTATE_FILTER;
module.exports.NOT_RAISED = NOT_RAISED;
