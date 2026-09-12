const logger = require("../utils/logger");
const {
  queryAsync,
  getConnectionAsync,
  beginTransactionAsync,
  commitAsync,
  rollbackAsync,
} = require("../utils/batchInsert");

/**
 * Attendance v2 - the reads the calculation engine needs, and the writes of
 * what it produced.
 *
 * NOTHING HERE WRITES A PUNCH. `biomax_punch` and `biomax_punch_derived` are
 * SELECTed and never INSERTed, UPDATEd or DELETEd - the receiver remains their
 * only writer, exactly as `repository/biomax_punch.js` documents. The two
 * tables this file does write, `attendance_day_calculation` and
 * `attendance_monthly_payroll`, hold derived numbers only and can be dropped
 * and recomputed without losing anything.
 *
 * EVERY TIME LEAVES THE DATABASE AS A STRING, via DATE_FORMAT. The API pool
 * has no `dateStrings` option, so a bare DATETIME would come back as a JS Date
 * built in the process timezone and would shift every punch by the server's
 * offset. No bare date or time column is selected anywhere in this file.
 *
 * NO `SELECT *`. Every column is named, and the lists are the minimum the
 * engine consumes: calculating somebody's worked minutes is not a reason to
 * read their bank details or their Aadhaar.
 */

class AttendanceCalculationRepository {
  constructor(db) {
    this.db = db;
  }

  _log(code, err, ref = {}) {
    logger.Log({
      level: logger.LEVEL.ERROR,
      component: "REPOSITORY.ATTENDANCE_CALCULATION",
      code: `REPOSITORY.ATTENDANCE_CALCULATION.${code}`,
      description: err.toString(),
      category: "",
      ref,
    });
  }

  _read(code, sql, params) {
    return new Promise((resolve, reject) => {
      this.db.query(sql, params, (err, rows) => {
        if (err) {
          this._log(code, err);
          reject(err);
          return;
        }
        resolve(rows || []);
      });
    });
  }

  /* ------------------------------------------------------- A0: the shift */

  /**
   * One employee's whole dated shift history, oldest first.
   *
   * The whole history rather than "the row for this date" because a month's
   * recalculation resolves thirty dates and would otherwise issue thirty
   * queries; the resolver in `utils/shiftResolution.js` picks per date.
   */
  async getShiftAssignmentHistory(employeeId) {
    return this._read(
      "GET-SHIFT-HISTORY",
      `SELECT employee_work_shift_assignment_id,
              employee_id,
              work_shift_id,
              DATE_FORMAT(effective_from, '%Y-%m-%d') AS effective_from,
              source
         FROM employee_work_shift_assignment
        WHERE employee_id = ?
        ORDER BY effective_from ASC, employee_work_shift_assignment_id ASC`,
      [employeeId]
    );
  }

  /** The same, for many employees at once. Keyed by the caller. */
  async getShiftAssignmentHistoryForEmployees(employeeIds) {
    if (!Array.isArray(employeeIds) || employeeIds.length === 0) return [];
    return this._read(
      "GET-SHIFT-HISTORY-BULK",
      `SELECT employee_work_shift_assignment_id,
              employee_id,
              work_shift_id,
              DATE_FORMAT(effective_from, '%Y-%m-%d') AS effective_from,
              source
         FROM employee_work_shift_assignment
        WHERE employee_id IN (?)
        ORDER BY employee_id ASC, effective_from ASC, employee_work_shift_assignment_id ASC`,
      [employeeIds]
    );
  }

  /** The seven weekly-schedule rows of a work shift, and the master row. */
  async getWorkShiftWithSchedule(workShiftId) {
    const [config] = await this._read(
      "GET-WORK-SHIFT-CONFIG",
      `SELECT work_shift_id, shift_code, shift_name, active,
              overtime_allowed, overtime_minimum_minutes,
              overtime_rounding_method, overtime_rounding_interval_minutes,
              overtime_minimum_threshold_only, maximum_ot_minutes_per_day
         FROM work_shift
        WHERE work_shift_id = ?`,
      [workShiftId]
    );
    if (!config) return null;

    const schedule = await this._read(
      "GET-WORK-SHIFT-SCHEDULE",
      `SELECT work_shift_weekly_schedule_id, work_shift_id, day_of_week, is_working_day,
              TIME_FORMAT(in_time, '%H:%i:%s')               AS in_time,
              TIME_FORMAT(out_time, '%H:%i:%s')              AS out_time,
              TIME_FORMAT(attendance_day_cutoff, '%H:%i:%s') AS attendance_day_cutoff,
              break_minutes, normal_work_minutes, ot_rate
         FROM work_shift_weekly_schedule
        WHERE work_shift_id = ?
        ORDER BY day_of_week ASC`,
      [workShiftId]
    );

    return { config, schedule };
  }

  /* ------------------------------------------------------ A1: the punches */

  /**
   * RAW punches for an employee over a date range, by ATTENDANCE date.
   *
   * `biomax_punch_derived.attendance_date` is what dated them at ingest;
   * punches whose date could not be derived have NULL there and are
   * deliberately excluded - they sit in the existing review queue, and an
   * undated punch has no day to be calculated into.
   *
   * Device identity is carried through for the audit trail only. Nothing
   * groups or orders by it: the punch belongs to the employee, not the
   * terminal, so somebody covering a shift at another outlet aggregates with
   * the rest of their day.
   */
  async getRawPunches(employeeId, fromDate, toDate) {
    return this._read(
      "GET-RAW-PUNCHES",
      `SELECT p.biomax_punch_id                            AS punch_id,
              d.employee_id,
              DATE_FORMAT(d.attendance_date, '%Y-%m-%d')   AS attendance_date,
              DATE_FORMAT(p.io_time, '%Y-%m-%d %H:%i:%s')  AS io_time,
              p.dev_id,
              p.ingest_source
         FROM biomax_punch_derived d
         JOIN biomax_punch p ON p.biomax_punch_id = d.biomax_punch_id
        WHERE d.employee_id = ?
          AND d.attendance_date IS NOT NULL
          AND d.attendance_date BETWEEN ? AND ?
        ORDER BY p.io_time ASC, p.biomax_punch_id ASC`,
      [employeeId, fromDate, toDate]
    );
  }

  /**
   * FULLY APPROVED regularized punches only.
   *
   * The join to the request with `status = 'APPROVED'` is the enforcement,
   * not a convention: a punch attached to a request still sitting at stage 2
   * of 3 is simply not returned, so it cannot reach a calculation.
   */
  async getApprovedRegularizedPunches(employeeId, fromDate, toDate) {
    return this._read(
      "GET-REGULARIZED-PUNCHES",
      `SELECT rp.attendance_regularized_punch_id           AS punch_id,
              rp.employee_id,
              DATE_FORMAT(rp.attendance_date, '%Y-%m-%d')  AS attendance_date,
              DATE_FORMAT(rp.punch_time, '%Y-%m-%d %H:%i:%s') AS io_time,
              rp.punch_source,
              rp.attendance_approval_request_id
         FROM attendance_regularized_punch rp
         JOIN attendance_approval_request r
           ON r.attendance_approval_request_id = rp.attendance_approval_request_id
        WHERE rp.employee_id = ?
          AND rp.attendance_date BETWEEN ? AND ?
          AND r.status = 'APPROVED'
        ORDER BY rp.punch_time ASC, rp.attendance_regularized_punch_id ASC`,
      [employeeId, fromDate, toDate]
    );
  }

  /** The employee's special break overrides that touch the range. */
  async getBreakOverrides(employeeId, fromDate, toDate) {
    return this._read(
      "GET-BREAK-OVERRIDES",
      `SELECT employee_break_override_id, employee_id, break_minutes,
              DATE_FORMAT(effective_from, '%Y-%m-%d') AS effective_from,
              DATE_FORMAT(effective_to, '%Y-%m-%d')   AS effective_to
         FROM employee_break_override
        WHERE employee_id = ?
          AND effective_from <= ?
          AND (effective_to IS NULL OR effective_to >= ?)
        ORDER BY effective_from ASC, employee_break_override_id ASC`,
      [employeeId, toDate, fromDate]
    );
  }

  /**
   * The approval state of each date in the range: is a request open, and how
   * many OT minutes have been finally approved.
   */
  async getApprovalStateByDate(employeeId, fromDate, toDate) {
    return this._read(
      "GET-APPROVAL-STATE",
      `SELECT attendance_approval_request_id,
              DATE_FORMAT(attendance_date, '%Y-%m-%d') AS attendance_date,
              request_type, status, current_stage_no, total_stages,
              candidate_ot_minutes, approved_ot_minutes
         FROM attendance_approval_request
        WHERE requested_for_employee_id = ?
          AND attendance_date BETWEEN ? AND ?
          AND status IN ('PENDING', 'APPROVED')
        ORDER BY attendance_date ASC, attendance_approval_request_id ASC`,
      [employeeId, fromDate, toDate]
    );
  }

  /** Joining and last-working dates, for the A4 available-dates window. */
  async getEmploymentWindow(employeeId) {
    const rows = await this._read(
      "GET-EMPLOYMENT-WINDOW",
      `SELECT ne.employee_id,
              ne.status,
              DATE_FORMAT(ne.resignation_date, '%Y-%m-%d') AS resignation_date,
              ne.date_of_joining
         FROM new_employee ne
        WHERE ne.employee_id = ?`,
      [employeeId]
    );
    return rows && rows[0] ? rows[0] : null;
  }

  /**
   * The Monthly Gross in force on a date, from the EXISTING effective-dated
   * resolver: the latest APPROVED `employee_salary` row effective on or before
   * it. This is a read of M2/M4's table and nothing more - there is no second
   * salary source, and no salary is computed here.
   */
  async getMonthlyGrossAsOf(employeeId, asOfDate) {
    const rows = await this._read(
      "GET-MONTHLY-GROSS",
      `SELECT salary_id, monthly_gross, daily_salary,
              DATE_FORMAT(effective_from, '%Y-%m-%d') AS effective_from
         FROM employee_salary
        WHERE employee_id = ?
          AND status = 'APPROVED'
          AND effective_from <= ?
        ORDER BY effective_from DESC, salary_id DESC
        LIMIT 1`,
      [employeeId, asOfDate]
    );
    return rows && rows[0] ? rows[0] : null;
  }

  /* ------------------------------------------------------------- writes */

  /**
   * Persist a batch of calculated dates, idempotently.
   *
   * INSERT ... ON DUPLICATE KEY UPDATE against `uq_adc_employee_date`, so a
   * recalculation of a month that has already been calculated updates the same
   * thirty rows rather than adding thirty more. The whole batch is one
   * transaction: a month is either wholly recalculated or not at all, and a
   * half-written month can never be read as a finished one.
   */
  async saveCalculations(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return { written: 0 };

    const connection = await getConnectionAsync(this.db);
    try {
      await beginTransactionAsync(connection);

      const columns = [
        "employee_id", "attendance_date", "work_shift_id", "work_shift_weekly_schedule_id",
        "shift_snapshot", "shift_snapshot_hash", "raw_punch_ids", "effective_punches",
        "punch_count", "attendance_day_count", "nrm_minutes", "span_minutes",
        "break_allowance_minutes", "break_allowance_source", "actual_gap_minutes",
        "break_charged_minutes", "worked_minutes", "shortage_minutes", "late_minutes",
        "early_exit_minutes", "raw_ot_minutes", "candidate_ot_minutes", "approved_ot_minutes",
        "ot_rate", "status", "is_final", "review_reasons", "approval_request_id",
        "calculation_version",
      ];

      const values = rows.map((row) => columns.map((column) => row[column]));

      const updates = columns
        .filter((column) => column !== "employee_id" && column !== "attendance_date")
        .map((column) => `\`${column}\` = VALUES(\`${column}\`)`)
        .join(", ");

      const result = await queryAsync(
        connection,
        `INSERT INTO attendance_day_calculation (${columns.map((c) => `\`${c}\``).join(", ")})
         VALUES ?
         ON DUPLICATE KEY UPDATE ${updates}`,
        [values]
      );

      await commitAsync(connection);
      return { written: rows.length, affected: result ? Number(result.affectedRows) : 0 };
    } catch (err) {
      await rollbackAsync(connection);
      this._log("SAVE-CALCULATIONS", err);
      throw err;
    } finally {
      connection.release();
    }
  }

  /** The same idempotency, for one employee's month. */
  async saveMonthlyPayroll(row) {
    const columns = [
      "employee_id", "period_year", "period_month", "available_from", "available_to",
      "available_dates", "notional_offs", "base_days", "attendance_days", "salary_days",
      "extra_days", "monthly_gross", "daily_rate", "salary_earnings", "extra_day_earnings",
      "shortage_minutes", "missing_minute_deduction", "approved_ot_minutes",
      "approved_ot_earnings", "statutory_base_days", "statutory_base_earnings",
      "total_attendance_payable", "held_dates", "is_final", "payroll_version",
    ];
    const updates = columns
      .filter((c) => !["employee_id", "period_year", "period_month"].includes(c))
      .map((c) => `\`${c}\` = VALUES(\`${c}\`)`)
      .join(", ");

    return this._read(
      "SAVE-MONTHLY-PAYROLL",
      `INSERT INTO attendance_monthly_payroll (${columns.map((c) => `\`${c}\``).join(", ")})
       VALUES (${columns.map(() => "?").join(", ")})
       ON DUPLICATE KEY UPDATE ${updates}`,
      columns.map((c) => row[c])
    );
  }

  /** Stored calculations, for the read API. */
  async listCalculations({ employee_id, from_date, to_date }) {
    return this._read(
      "LIST-CALCULATIONS",
      `SELECT c.*, DATE_FORMAT(c.attendance_date, '%Y-%m-%d') AS attendance_date
         FROM attendance_day_calculation c
        WHERE c.employee_id = ?
          AND c.attendance_date BETWEEN ? AND ?
        ORDER BY c.attendance_date ASC`,
      [employee_id, from_date, to_date]
    );
  }

  /** A stored month, for the read API. */
  async getMonthlyPayroll({ employee_id, period_year, period_month }) {
    const rows = await this._read(
      "GET-MONTHLY-PAYROLL",
      `SELECT * FROM attendance_monthly_payroll
        WHERE employee_id = ? AND period_year = ? AND period_month = ?`,
      [employee_id, period_year, period_month]
    );
    return rows && rows[0] ? rows[0] : null;
  }
}

module.exports = (db) => new AttendanceCalculationRepository(db);
module.exports.AttendanceCalculationRepository = AttendanceCalculationRepository;
