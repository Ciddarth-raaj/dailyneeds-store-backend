const {
  ATTENDANCE_CALCULATION_MODE,
  ATTENDANCE_CALCULATION_MODE_LABEL,
  isKnownMode,
  resolveModeRowForDate,
  resolveAttendanceCalculationMode,
  affectedRangeForNewMode,
} = require("../utils/attendance_calculation_mode");
const { toDateOnly, monthProbesForRange } = require("../utils/shiftResolution");
const { addDays } = require("../utils/attendance_engine");
const { istToday } = require("../utils/istDate");
const { payrollLockedActionError } = require("../utils/attendance_payroll_lock");

function validationError(message) {
  const err = new Error(message);
  err.name = "ValidationError";
  return err;
}

/**
 * Employee Master -> Employment Details -> Attendance Calculation Type.
 *
 * The effective-dated history is the setting; there is no current-value
 * column to drift from it. "Current" is the resolver's answer for today and
 * nothing else.
 *
 * A CHANGE APPENDS, AND RECALCULATES NOTHING. Exactly like Extra Break Hours -
 * the other attendance-shaping Employment Details field - saving the setting
 * does not rewrite attendance: that is a deliberate act for somebody holding
 * `recalculate_attendance`, and it goes through the ordinary recalculation
 * path and its own payroll-lock gate. A change dated today or later needs
 * nothing at all: those dates have not been stored yet. What a change can
 * never do is reach a payroll-locked month - that is refused, here as a
 * readable pre-flight and in the repository under the row lock.
 */
module.exports = (employeeAttendanceModeRepo, attendanceCalculationRepo = null) => {
  const withLabel = (row) => ({
    ...row,
    calculation_mode_label: ATTENDANCE_CALCULATION_MODE_LABEL[row.calculation_mode] || row.calculation_mode,
  });

  /**
   * getEmployeeAttendanceCalculationType(employeeId, attendanceDate).
   *
   * The single-lookup form of the resolver every calculating path uses
   * (`utils/attendance_calculation_mode.js`), for callers outside a
   * calculation.
   */
  const getEmployeeAttendanceCalculationType = async (employeeId, attendanceDate) => {
    const date = toDateOnly(attendanceDate);
    if (date === null) throw validationError("attendance_date must be a date as YYYY-MM-DD");
    const history = await employeeAttendanceModeRepo.listHistory(Number(employeeId));
    return resolveAttendanceCalculationMode(history, date);
  };

  /** The setting as the Employment Details section shows it. */
  const getMode = async (employeeId, { today = null } = {}) => {
    const businessToday = istToday(today);
    const history = await employeeAttendanceModeRepo.listHistory(Number(employeeId));
    const currentRow = resolveModeRowForDate(history, businessToday);
    const currentMode = currentRow ? currentRow.calculation_mode : ATTENDANCE_CALCULATION_MODE.SHIFT_BASED;
    // The next change already on the calendar, if one is, so the screen can
    // say "Present/Absent Only from 01/10/2026" before that date arrives.
    const upcoming = history
      .filter((row) => toDateOnly(row.effective_from) > businessToday)
      .sort((a, b) => (a.effective_from < b.effective_from ? -1 : 1))[0];
    const currentId = currentRow ? Number(currentRow.employee_attendance_calculation_mode_id) : null;
    return {
      code: 200,
      employee_id: Number(employeeId),
      today: businessToday,
      current_mode: currentMode,
      current_mode_label: ATTENDANCE_CALCULATION_MODE_LABEL[currentMode],
      current_effective_from: currentRow ? toDateOnly(currentRow.effective_from) : null,
      upcoming: upcoming ? withLabel(upcoming) : null,
      history: history.map((row) => ({
        ...withLabel(row),
        is_current: currentId !== null && Number(row.employee_attendance_calculation_mode_id) === currentId,
      })),
    };
  };

  const changeMode = async (payload = {}) => {
    const employeeId = Number(payload.employee_id);
    if (!Number.isInteger(employeeId) || employeeId <= 0) {
      throw validationError("employee_id is required and must be an employee id");
    }
    const mode = payload.calculation_mode;
    if (!isKnownMode(mode)) {
      throw validationError("calculation_mode must be SHIFT_BASED or PRESENT_ABSENT_ONLY");
    }
    const effectiveFrom = toDateOnly(payload.effective_from);
    if (effectiveFrom === null || !/^\d{4}-\d{2}-\d{2}$/.test(String(payload.effective_from))) {
      throw validationError(
        "effective_from is required and must be a date as YYYY-MM-DD - the mode must say which date it applies from"
      );
    }
    const note = typeof payload.note === "string" ? payload.note.trim() : "";
    if (note.length > 255) throw validationError("note must be 255 characters or fewer");

    const history = await employeeAttendanceModeRepo.listHistory(employeeId);
    if (resolveAttendanceCalculationMode(history, effectiveFrom) === mode) {
      return {
        code: 422,
        msg: `The employee is already ${ATTENDANCE_CALCULATION_MODE_LABEL[mode]} on ${effectiveFrom}`,
      };
    }

    const today = istToday(payload.today);

    // THE FRIENDLY PRE-FLIGHT, over the same dates the repository's
    // transaction locks. It holds no lock; the boundary is the repository.
    if (attendanceCalculationRepo && typeof attendanceCalculationRepo.findPayrollLockedPeriods === "function") {
      const affected = affectedRangeForNewMode({ history, effectiveFrom });
      const to = affected.superseded_from
        ? addDays(affected.superseded_from, -1)
        : today > affected.from
        ? today
        : affected.from;
      const locked = await attendanceCalculationRepo.findPayrollLockedPeriods(
        monthProbesForRange({ employeeId, from: affected.from, to })
      );
      if (locked && locked.length > 0) {
        throw payrollLockedActionError(locked, "This Attendance Calculation Type change");
      }
    }

    const result = await employeeAttendanceModeRepo.appendMode({
      employeeId,
      calculationMode: mode,
      effectiveFrom,
      note,
      createdBy: payload.actor_employee_id === undefined ? null : payload.actor_employee_id,
      today,
    });
    if (!result || result.code !== 200) return result;

    // Dates already stored under the old mode: the effective date up to
    // yesterday (or up to the day before a later row takes over).
    const storedTo = result.affected_to && result.affected_to < today ? result.affected_to : addDays(today, -1);
    const recalculationRange = effectiveFrom <= storedTo ? { from: effectiveFrom, to: storedTo } : null;
    return {
      ...result,
      calculation_mode_label: ATTENDANCE_CALCULATION_MODE_LABEL[mode],
      recalculation_required: recalculationRange !== null,
      recalculation_range: recalculationRange,
      msg: recalculationRange
        ? `Saved. ${ATTENDANCE_CALCULATION_MODE_LABEL[mode]} applies from ${effectiveFrom}. Attendance already calculated from ${recalculationRange.from} to ${recalculationRange.to} is NOT recalculated automatically - run Recalculate Attendance for that range.`
        : `Saved. ${ATTENDANCE_CALCULATION_MODE_LABEL[mode]} applies from ${effectiveFrom}.`,
    };
  };

  return { getMode, changeMode, getEmployeeAttendanceCalculationType };
};
