/**
 * THE PAYROLL LOCK, IN FRONT OF EVERY ATTENDANCE WRITE.
 *
 * A locked month is settled: "no recalculation, no adjustment edit, no pay
 * type change, no salary refresh, no second approval" is what
 * `constants/payrun_calculation.js` already says of `APPROVED_LOCKED`, and
 * that is the ONE authoritative lock state - a row of
 * `payrun_employee_calculation` with `status = 'APPROVED_LOCKED'` for that
 * employee and period. Nothing here invents a second definition, a second
 * table or a second word for it.
 *
 * WHY ATTENDANCE HAS TO ASK. Locking the payrun froze the PAY: the payrun
 * stage refuses to recalculate a locked employee and keeps its own stored
 * figures. It did not freeze the attendance rows those figures were computed
 * from, so a recalculation could rewrite the NRM, the shortage and the
 * approved OT behind an approved month and leave the two permanently
 * disagreeing - with nothing on either row to say why. A closed month cannot
 * be modified by anyone, and "anyone" includes the attendance engine.
 *
 * WHERE THE CHECK LIVES. On the connection, immediately before the write, in
 * `repository/attendance_calculation.js` - because every path that persists
 * attendance goes through `writeCalculationsOnConnection` or the reconciling
 * delete beside it. Guarding the usecases instead would mean guarding each of
 * them, and the next path to be added would simply not be guarded.
 *
 * This module holds the pure parts: which months a set of rows touches, and
 * the error. The query is the repository's.
 */

/** The one lock state. Imported, never retyped. */
const { STORED_STATUS } = require("../constants/payrun_calculation");

const PAYROLL_LOCK_STATUS = STORED_STATUS.APPROVED_LOCKED;

/** `YYYY-MM-DD` (or a Date) -> { year, month }, or null if unreadable. */
function periodOf(attendanceDate) {
  if (attendanceDate === null || attendanceDate === undefined) return null;
  const text =
    attendanceDate instanceof Date
      ? `${attendanceDate.getFullYear()}-${String(attendanceDate.getMonth() + 1).padStart(2, "0")}-01`
      : String(attendanceDate);
  const m = /^(\d{4})-(\d{2})/.exec(text.trim());
  if (!m) return null;
  return { year: Number(m[1]), month: Number(m[2]) };
}

/**
 * The distinct (employee, year, month) a write would touch.
 *
 * A row whose date cannot be read is NOT silently dropped from the check -
 * it is returned with a null period so the caller can refuse the write
 * outright rather than write a row no lock could ever have covered.
 */
function periodsTouched(rows = []) {
  const seen = new Map();
  let unreadable = false;
  for (const row of rows || []) {
    if (!row) continue;
    const employeeId = Number(row.employee_id);
    const period = periodOf(row.attendance_date);
    if (!Number.isInteger(employeeId) || employeeId <= 0 || period === null) {
      unreadable = true;
      continue;
    }
    const key = `${employeeId}:${period.year}:${period.month}`;
    if (!seen.has(key)) {
      seen.set(key, { employee_id: employeeId, year: period.year, month: period.month });
    }
  }
  return { periods: [...seen.values()], unreadable };
}

/**
 * The business error a locked month produces.
 *
 * `ValidationError` by name, because that is what `utils/http.js` turns into
 * a 422 with the message shown to the user - the existing convention for "you
 * may not do this", as against a 500 for "something broke". The locked months
 * travel on the error so a bulk run can report exactly whose month stopped it.
 */
function payrollLockedError(locked = []) {
  const months = locked
    .map((l) => `${String(l.month).padStart(2, "0")}/${l.year} (employee ${l.employee_id})`)
    .join(", ");
  const err = new Error(
    `This attendance cannot be changed: the payroll month is approved and locked - ${months}. ` +
      `A locked month is settled; reopen it in Payrun before recalculating attendance for those dates.`
  );
  err.name = "ValidationError";
  err.code = "PAYROLL_MONTH_LOCKED";
  err.locked_months = locked;
  return err;
}

module.exports = {
  PAYROLL_LOCK_STATUS,
  periodOf,
  periodsTouched,
  payrollLockedError,
};
