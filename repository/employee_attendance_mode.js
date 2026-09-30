const logger = require("../utils/logger");
const { monthProbesForRange, toDateOnly } = require("../utils/shiftResolution");
const { affectedRangeForNewMode } = require("../utils/attendance_calculation_mode");
const { addDays } = require("../utils/attendance_engine");
// THE PAYROLL LOCK, not a second copy of it.
const { assertMonthsNotPayrollLocked } = require("./attendance_calculation");
const {
  queryAsync,
  getConnectionAsync,
  beginTransactionAsync,
  commitAsync,
  rollbackAsync,
} = require("../utils/batchInsert");

/**
 * `employee_attendance_calculation_mode` - the effective-dated Attendance
 * Calculation Type history. INSERT only: no row is ever updated or deleted,
 * so the mode that applied to a past date stays resolvable for ever.
 */
class EmployeeAttendanceModeRepository {
  constructor(db) {
    this.db = db;
  }

  /** One employee's whole history, NEWEST FIRST, with who made each change. */
  async listHistory(employeeId) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT m.employee_attendance_calculation_mode_id,
                m.employee_id,
                m.calculation_mode,
                DATE_FORMAT(m.effective_from, '%Y-%m-%d') AS effective_from,
                m.note,
                m.created_by,
                ne.employee_name AS changed_by_name,
                DATE_FORMAT(m.created_at, '%Y-%m-%d %H:%i:%s') AS created_at
           FROM employee_attendance_calculation_mode m
           LEFT JOIN new_employee ne ON ne.employee_id = m.created_by
          WHERE m.employee_id = ?
          ORDER BY m.effective_from DESC, m.employee_attendance_calculation_mode_id DESC`,
        [employeeId],
        (err, rows) => {
          if (err) {
            this._log("LIST-HISTORY", err, { employeeId });
            reject(err);
            return;
          }
          resolve(rows || []);
        }
      );
    });
  }

  /**
   * Append one history row, refused if it would change a payroll-locked month.
   *
   * THE PAYROLL LOCK IS TAKEN HERE, INSIDE THE TRANSACTION, on the same
   * `payrun_employee_calculation` rows `approveAndLock` locks
   * (`assertMonthsNotPayrollLocked`), so an approval cannot land between the
   * check and the insert. It is asked about the dates this row actually
   * changes: from `effective_from` to the day before the next existing row
   * that starts later, or - when none does - to today (a month after today
   * has no attendance and cannot have been approved).
   *
   * NOTHING IS RECALCULATED here, and no stored attendance row is touched:
   * stored days keep the mode they were calculated under until somebody
   * holding `recalculate_attendance` recalculates them, through the ordinary
   * path and its own lock gate.
   */
  async appendMode({ employeeId, calculationMode, effectiveFrom, note, createdBy, today }) {
    const connection = await getConnectionAsync(this.db);
    try {
      await beginTransactionAsync(connection);

      // The employee row serializes two changes to one person, including the
      // very first one (when there is no history row yet to lock).
      const employee = await queryAsync(
        connection,
        "SELECT employee_id FROM new_employee WHERE employee_id = ? FOR UPDATE",
        [employeeId]
      );
      if (!employee || employee.length === 0) {
        await rollbackAsync(connection);
        return { code: 404, msg: `No employee exists for id ${employeeId}` };
      }

      const before = await queryAsync(
        connection,
        `SELECT employee_attendance_calculation_mode_id, employee_id, calculation_mode,
                DATE_FORMAT(effective_from, '%Y-%m-%d') AS effective_from
           FROM employee_attendance_calculation_mode
          WHERE employee_id = ?
          FOR UPDATE`,
        [employeeId]
      );

      const affected = affectedRangeForNewMode({ history: before, effectiveFrom });
      const businessToday = toDateOnly(today);
      const lockTo = affected.superseded_from
        ? addDays(affected.superseded_from, -1)
        : businessToday !== null && businessToday > affected.from
        ? businessToday
        : affected.from;
      await assertMonthsNotPayrollLocked(
        connection,
        monthProbesForRange({ employeeId, from: affected.from, to: lockTo })
      );

      const inserted = await queryAsync(
        connection,
        `INSERT INTO employee_attendance_calculation_mode
           (employee_id, calculation_mode, effective_from, note, created_by)
         VALUES (?, ?, ?, ?, ?)`,
        [employeeId, calculationMode, effectiveFrom, note || null, createdBy === undefined ? null : createdBy]
      );

      await commitAsync(connection);
      return {
        code: 200,
        employee_attendance_calculation_mode_id: inserted ? inserted.insertId : null,
        employee_id: employeeId,
        calculation_mode: calculationMode,
        effective_from: effectiveFrom,
        affected_from: affected.from,
        affected_to: affected.superseded_from ? addDays(affected.superseded_from, -1) : null,
      };
    } catch (err) {
      await rollbackAsync(connection);
      if (!err || err.code !== "PAYROLL_MONTH_LOCKED") this._log("APPEND-MODE", err, { employeeId });
      throw err;
    } finally {
      connection.release();
    }
  }

  _log(code, err, ref = {}) {
    logger.Log({
      level: logger.LEVEL.ERROR,
      component: "REPOSITORY.EMPLOYEE_ATTENDANCE_MODE",
      code: `REPOSITORY.EMPLOYEE_ATTENDANCE_MODE.${code}`,
      description: err && err.toString ? err.toString() : String(err),
      category: "",
      ref,
    });
  }
}

module.exports = (db) => new EmployeeAttendanceModeRepository(db);
module.exports.EmployeeAttendanceModeRepository = EmployeeAttendanceModeRepository;
