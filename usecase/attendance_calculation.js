const {
  CALCULATION_VERSION,
  CALC_STATUS,
  PUNCH_SOURCE,
  calculateAttendanceDay,
  addDays,
} = require("../utils/attendance_engine");
const {
  RESOLUTION_STATUS,
  resolveShiftForDate,
  toDateOnly,
} = require("../utils/shiftResolution");
const {
  PAYROLL_VERSION,
  computeMonthlyAttendancePayroll,
  daysInMonth,
} = require("../utils/attendance_payroll");

/**
 * Attendance v2 - the orchestration between the repository and the pure
 * engines.
 *
 * The arithmetic is NOT here. `utils/attendance_engine.js` decides worked
 * minutes, `utils/shiftResolution.js` decides which shift applied, and
 * `utils/attendance_payroll.js` decides the month; this file fetches what they
 * need, calls them in the right order, and shapes the result for storage. That
 * separation is what lets the whole of the business rule be tested as
 * arithmetic and lets this file be tested against a fake repository.
 *
 * RECALCULATION IS THE NORMAL PATH, not a repair. Every number is derived from
 * the immutable raw punches plus the dated shift history plus the fully
 * approved regularizations, so running it twice produces the same rows and
 * running it after an approval produces the corrected ones. Nothing
 * accumulates and nothing is incremented.
 */

/** The most dates one request may recalculate, so a typo cannot scan a decade. */
const MAX_RANGE_DAYS = 62;

function validationError(message) {
  const err = new Error(message);
  err.name = "ValidationError";
  return err;
}

/** Every date from `from` to `to` inclusive, as `YYYY-MM-DD`. */
function dateRange(from, to) {
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

/** The break override in force on a date, or null. Later rows win. */
function breakOverrideFor(overrides, date) {
  let chosen = null;
  (overrides || []).forEach((row) => {
    const from = toDateOnly(row.effective_from);
    const to = toDateOnly(row.effective_to);
    if (from === null || from > date) return;
    if (to !== null && to < date) return;
    chosen = row;
  });
  return chosen === null ? null : Number(chosen.break_minutes);
}

module.exports = (attendanceCalculationRepo) => {
  /**
   * Read every shift a history references, once, and index the schedule rows.
   *
   * A month typically touches one shift; a month that spans a roster change
   * touches two. Either way each one is fetched once and the resolver reads
   * from memory, rather than a query per date.
   */
  const loadShiftCache = async (assignments) => {
    const ids = [...new Set((assignments || []).map((a) => Number(a.work_shift_id)))];
    const cache = new Map();
    for (const id of ids) {
      // Sequential on purpose: a handful of ids, and the pool is shared with
      // every other request on this process.
      // eslint-disable-next-line no-await-in-loop
      const loaded = await attendanceCalculationRepo.getWorkShiftWithSchedule(id);
      if (loaded) cache.set(id, loaded);
    }
    return cache;
  };

  /**
   * Calculate one employee over a date range, WITHOUT writing anything.
   *
   * Used by the preview endpoint and by `recalculateRange` below, so what a
   * reviewer is shown and what gets stored are produced by one code path.
   */
  const calculateRange = async ({ employee_id, from_date, to_date }) => {
    const from = toDateOnly(from_date);
    const to = toDateOnly(to_date);
    if (from === null || to === null) {
      throw validationError("from_date and to_date must be dates as YYYY-MM-DD");
    }
    if (from > to) throw validationError("from_date must not be after to_date");

    const dates = dateRange(from, to);
    if (dates.length > MAX_RANGE_DAYS) {
      throw validationError(`A range may cover at most ${MAX_RANGE_DAYS} days`);
    }

    const [assignments, rawPunches, regularized, overrides, approvals] = await Promise.all([
      attendanceCalculationRepo.getShiftAssignmentHistory(employee_id),
      attendanceCalculationRepo.getRawPunches(employee_id, from, to),
      attendanceCalculationRepo.getApprovedRegularizedPunches(employee_id, from, to),
      attendanceCalculationRepo.getBreakOverrides(employee_id, from, to),
      attendanceCalculationRepo.getApprovalStateByDate(employee_id, from, to),
    ]);

    const shiftCache = await loadShiftCache(assignments);

    const readSchedule = (workShiftId, dow) => {
      const loaded = shiftCache.get(Number(workShiftId));
      if (!loaded) return null;
      return loaded.schedule.find((row) => Number(row.day_of_week) === Number(dow)) || null;
    };
    const readShiftConfig = (workShiftId) => {
      const loaded = shiftCache.get(Number(workShiftId));
      return loaded ? loaded.config : null;
    };

    const byDate = (rows, key = "attendance_date") => {
      const map = new Map();
      (rows || []).forEach((row) => {
        const date = toDateOnly(row[key]);
        if (date === null) return;
        if (!map.has(date)) map.set(date, []);
        map.get(date).push(row);
      });
      return map;
    };

    const rawByDate = byDate(rawPunches);
    const regularizedByDate = byDate(regularized);
    const approvalByDate = new Map();
    (approvals || []).forEach((row) => approvalByDate.set(toDateOnly(row.attendance_date), row));

    return dates.map((date) => {
      const resolution = resolveShiftForDate({
        assignments,
        attendanceDate: date,
        readSchedule,
        readShiftConfig,
      });

      const approval = approvalByDate.get(date) || null;
      const approvedOt =
        approval && approval.status === "APPROVED" ? Number(approval.approved_ot_minutes || 0) : 0;

      const calculated = calculateAttendanceDay({
        employee_id,
        attendance_date: date,
        shift: resolution.snapshot,
        shift_status: resolution.status,
        punches: (rawByDate.get(date) || []).map((p) => ({
          punch_id: p.punch_id,
          source: p.ingest_source === "IMPORT" ? PUNCH_SOURCE.IMPORT : PUNCH_SOURCE.BIOMAX,
          dev_id: p.dev_id,
          io_time: p.io_time,
        })),
        regularized_punches: (regularizedByDate.get(date) || []).map((p) => ({
          punch_id: p.punch_id,
          source: PUNCH_SOURCE.REGULARIZED,
          io_time: p.io_time,
        })),
        break_override_minutes: breakOverrideFor(overrides, date),
        approved_ot_minutes: approvedOt,
        regularization_pending: !!(approval && approval.status === "PENDING"),
      });

      return {
        ...calculated,
        shift_resolution_status: resolution.status,
        approval_request_id: approval ? approval.attendance_approval_request_id : null,
      };
    });
  };

  /** The storage shape. JSON columns are stringified once, here. */
  const toStorageRow = (day) => ({
    employee_id: day.employee_id,
    attendance_date: day.attendance_date,
    work_shift_id: day.work_shift_id,
    work_shift_weekly_schedule_id: day.work_shift_weekly_schedule_id,
    shift_snapshot: JSON.stringify(day.shift_snapshot || {}),
    shift_snapshot_hash: day.shift_snapshot_hash || "",
    raw_punch_ids: JSON.stringify(day.raw_punch_ids || []),
    effective_punches: JSON.stringify(day.effective_punches || []),
    punch_count: day.punch_count,
    attendance_day_count: day.attendance_day_count,
    nrm_minutes: day.nrm_minutes,
    span_minutes: day.span_minutes,
    break_allowance_minutes: day.break_allowance_minutes,
    break_allowance_source: day.break_allowance_source,
    actual_gap_minutes: day.actual_gap_minutes,
    break_charged_minutes: day.break_charged_minutes,
    worked_minutes: day.worked_minutes,
    shortage_minutes: day.shortage_minutes,
    late_minutes: day.late_minutes,
    early_exit_minutes: day.early_exit_minutes,
    raw_ot_minutes: day.raw_ot_minutes,
    candidate_ot_minutes: day.candidate_ot_minutes,
    approved_ot_minutes: day.approved_ot_minutes,
    ot_rate: day.ot_rate,
    status: day.status,
    is_final: day.is_final ? 1 : 0,
    review_reasons: JSON.stringify(day.review_reasons || []),
    approval_request_id: day.approval_request_id,
    calculation_version: CALCULATION_VERSION,
  });

  /**
   * Calculate a range and store it. Idempotent by the unique key on
   * (employee_id, attendance_date) - see the repository.
   */
  const recalculateRange = async ({ employee_id, from_date, to_date }) => {
    const days = await calculateRange({ employee_id, from_date, to_date });
    const written = await attendanceCalculationRepo.saveCalculations(days.map(toStorageRow));
    return { employee_id, from_date, to_date, days, ...written };
  };

  /**
   * A whole month, calculated and rolled up into the A4 payroll line items.
   *
   * The Monthly Gross comes from the EXISTING effective-dated salary resolver,
   * read as of the LAST day of the period - a revision effective mid-month is
   * a question v2 does not answer, so the month is priced on one rate and the
   * choice is stated here rather than buried.
   */
  const calculateMonth = async ({ employee_id, year, month, persist = false }) => {
    const y = Number(year);
    const m = Number(month);
    if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12) {
      throw validationError("year and month must be integers, month 1-12");
    }

    const pad = (n) => String(n).padStart(2, "0");
    const from = `${y}-${pad(m)}-01`;
    const to = `${y}-${pad(m)}-${pad(daysInMonth(y, m))}`;

    const [days, employment, salary] = await Promise.all([
      calculateRange({ employee_id, from_date: from, to_date: to }),
      attendanceCalculationRepo.getEmploymentWindow(employee_id),
      attendanceCalculationRepo.getMonthlyGrossAsOf(employee_id, to),
    ]);

    const payroll = computeMonthlyAttendancePayroll({
      employee_id,
      year: y,
      month: m,
      monthly_gross: salary ? salary.monthly_gross : null,
      days,
      joined_on: employment ? employment.date_of_joining : null,
      ended_on: employment ? employment.resignation_date : null,
    });

    const result = {
      ...payroll,
      salary_record_id: salary ? salary.salary_id : null,
      salary_effective_from: salary ? salary.effective_from : null,
      days,
    };

    if (persist) {
      await attendanceCalculationRepo.saveCalculations(days.map(toStorageRow));
      await attendanceCalculationRepo.saveMonthlyPayroll({
        employee_id,
        period_year: y,
        period_month: m,
        available_from: payroll.available_from,
        available_to: payroll.available_to,
        available_dates: payroll.available_dates,
        notional_offs: payroll.notional_offs,
        base_days: payroll.base_days,
        attendance_days: payroll.attendance_days,
        salary_days: payroll.salary_days,
        extra_days: payroll.extra_days,
        monthly_gross: payroll.monthly_gross,
        daily_rate: payroll.daily_rate,
        salary_earnings: payroll.salary_earnings,
        extra_day_earnings: payroll.extra_day_earnings,
        shortage_minutes: payroll.shortage_minutes,
        missing_minute_deduction: payroll.missing_minute_deduction,
        approved_ot_minutes: payroll.approved_ot_minutes,
        approved_ot_earnings: payroll.approved_ot_earnings,
        statutory_base_days: payroll.statutory_base_days,
        statutory_base_earnings: payroll.statutory_base_earnings,
        total_attendance_payable: payroll.total_attendance_payable,
        held_dates: JSON.stringify(payroll.held_dates || []),
        is_final: payroll.is_final ? 1 : 0,
        payroll_version: PAYROLL_VERSION,
      });
    }

    return result;
  };

  return {
    MAX_RANGE_DAYS,
    CALC_STATUS,
    RESOLUTION_STATUS,
    dateRange,
    breakOverrideFor,
    toStorageRow,
    calculateRange,
    recalculateRange,
    calculateMonth,
  };
};
