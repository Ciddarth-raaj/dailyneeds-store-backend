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
 * PUNCHES ARE READ BY CALENDAR DATE, NOT BY DERIVED ATTENDANCE DATE (review
 * fix #1). `biomax_punch_derived.attendance_date` was decided at ingest,
 * against whatever shift the employee was on at that moment, and it is exactly
 * what a recalculation must NOT trust. `getRawPunchesByCalendarWindow` below
 * therefore filters on `biomax_punch.punch_date` - the raw calendar date the
 * device stamped - and the usecase re-derives the attendance day from the
 * dated shift history and that shift version's own cutoff. The derived row is
 * still joined, for two things only: the employee it was matched to at ingest,
 * and the ingest-time attendance date, carried through so a disagreement
 * between ingest and recalculation can be SEEN rather than silently resolved.
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

/**
 * The stored calculation's columns, in one place.
 *
 * Named here rather than inline because TWO writers use exactly this list: the
 * ordinary `saveCalculations` below, and `writeCalculationsOnConnection`, which
 * the A3 approval path calls INSIDE its own decision transaction so that a
 * final approval and the recalculated day it produces commit together or not
 * at all (review fix #4).
 */
const CALCULATION_COLUMNS = [
  "employee_id", "attendance_date", "work_shift_id", "work_shift_weekly_schedule_id",
  "work_shift_config_version_id",
  "shift_snapshot", "shift_snapshot_hash", "raw_punch_ids", "effective_punches",
  "punch_count", "attendance_day_count", "nrm_minutes", "span_minutes",
  "break_allowance_minutes", "break_allowance_source", "actual_gap_minutes",
  "break_charged_minutes", "worked_minutes", "shortage_minutes", "late_minutes",
  "early_exit_minutes", "pre_shift_minutes", "post_shift_minutes",
  "raw_ot_minutes", "ot_offset_minutes", "pre_shift_ot_minutes", "post_shift_ot_minutes",
  "candidate_ot_minutes", "approved_ot_minutes",
  "ot_rate", "status", "is_final", "review_reasons", "approval_request_id",
  "calculation_version",
];

/**
 * INSERT ... ON DUPLICATE KEY UPDATE for calculated days, on a connection the
 * caller already owns and inside whatever transaction it has open.
 *
 * Exported as a free function so `repository/attendance_regularization.js` can
 * write the recalculated day in the SAME transaction that records the final
 * approval, without either repository having to import the other's class.
 */
async function writeCalculationsOnConnection(connection, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return { written: 0 };

  const values = rows.map((row) => CALCULATION_COLUMNS.map((column) => row[column]));
  const updates = CALCULATION_COLUMNS
    .filter((column) => column !== "employee_id" && column !== "attendance_date")
    .map((column) => `\`${column}\` = VALUES(\`${column}\`)`)
    .join(", ");

  const result = await queryAsync(
    connection,
    `INSERT INTO attendance_day_calculation (${CALCULATION_COLUMNS.map((c) => `\`${c}\``).join(", ")})
     VALUES ?
     ON DUPLICATE KEY UPDATE ${updates}`,
    [values]
  );
  return { written: rows.length, affected: result ? Number(result.affectedRows) : 0 };
}

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

  /**
   * The employee's SINGLE-DATE shift overrides inside a window.
   *
   * Every row for a date is returned, newest last; the resolver picks the
   * greatest id per date. The table is append-only, so this is a plain read
   * of what every edit recorded.
   */
  async getDateShiftOverrides(employeeId, fromDate, toDate) {
    return this._read(
      "GET-DATE-SHIFT-OVERRIDES",
      `SELECT attendance_date_shift_override_id,
              employee_id,
              work_shift_id,
              previous_work_shift_id,
              changed_by,
              DATE_FORMAT(attendance_date, '%Y-%m-%d') AS attendance_date,
              DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_at
         FROM attendance_date_shift_override
        WHERE employee_id = ?
          AND attendance_date BETWEEN ? AND ?
        ORDER BY attendance_date ASC, attendance_date_shift_override_id ASC`,
      [employeeId, fromDate, toDate]
    );
  }

  /** The active shifts an authorized user may put a date on. */
  async listActiveWorkShiftOptions() {
    return this._read(
      "LIST-ACTIVE-WORK-SHIFT-OPTIONS",
      `SELECT work_shift_id, shift_code, shift_name
         FROM work_shift
        WHERE active = 1
        ORDER BY shift_code, shift_name`
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
              overtime_minimum_threshold_only, overtime_minimum_excluded, maximum_ot_minutes_per_day,
              pre_shift_overtime_allowed, pre_shift_overtime_minimum_minutes,
              pre_shift_overtime_rounding_method,
              pre_shift_overtime_rounding_interval_minutes, pre_shift_overtime_minimum_excluded,
              late_offset_against_overtime, early_exit_offset_against_overtime,
            late_grace_minutes, late_deduction_interval_minutes, late_deduct_minutes,
            late_exclude_grace_from_deduction,
            early_exit_grace_minutes, early_exit_deduction_interval_minutes,
            early_exit_deduct_minutes
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

  /**
   * A shift's effective-dated CONFIGURATION VERSIONS, oldest first (review
   * fix #2).
   *
   * The whole history rather than "the version for this date", for the same
   * reason the assignment history is read whole: a month resolves thirty dates
   * and would otherwise issue thirty queries. `utils/shift_config_version.js`
   * picks the one in force per date.
   *
   * Append-only. There is no UPDATE or DELETE of this table anywhere in this
   * backend - a Work Shift edit APPENDS a version, which is what stops an edit
   * today from moving a settled figure from September.
   */
  async getWorkShiftConfigVersions(workShiftId) {
    return this._read(
      "GET-WORK-SHIFT-CONFIG-VERSIONS",
      `SELECT work_shift_config_version_id, work_shift_id,
              DATE_FORMAT(effective_from, '%Y-%m-%d') AS effective_from,
              config_hash, config_document, source
         FROM work_shift_config_version
        WHERE work_shift_id = ?
        ORDER BY effective_from ASC, work_shift_config_version_id ASC`,
      [workShiftId]
    );
  }

  /* ------------------------------------------------------ A1: the punches */

  /**
   * RAW punches for an employee over a CALENDAR window (review fix #1).
   *
   * The filter is `biomax_punch.punch_date`, the generated calendar date of
   * the instant the device stamped, and NOT
   * `biomax_punch_derived.attendance_date`. The attendance day each punch
   * belongs to is re-derived by the engine from the dated shift history and
   * that shift version's cutoff; reading the ingest-time date instead would
   * mean a "recalculation" that could never actually correct a mis-dated
   * punch, which is precisely the defect this fixes.
   *
   * The derived row is still joined, for exactly two things: `employee_id`,
   * the identity the receiver matched at ingest, which is the only place that
   * mapping exists; and the ingest-time attendance date, carried through as
   * `ingest_attendance_date` so the engine's answer can be compared with what
   * ingest believed rather than quietly replacing it.
   *
   * A punch ingest could NOT date (`attendance_date IS NULL` - the employee
   * had no shift assigned that night) is deliberately included now: the engine
   * can date it from history even when the receiver could not.
   *
   * Device identity is carried through for the audit trail only. Nothing
   * groups or orders by it: the punch belongs to the employee, not the
   * terminal, so somebody covering a shift at another outlet aggregates with
   * the rest of their day.
   */
  async getRawPunchesByCalendarWindow(employeeId, fromCalendarDate, toCalendarDate) {
    // The manual void, if any, rides on the same row: `attendance_punch_void`
    // is unique per raw punch and is never deleted, so a LEFT JOIN answers
    // "is this punch voided" without a second query. The raw row itself is
    // still read exactly as stored.
    return this._read(
      "GET-RAW-PUNCHES-BY-CALENDAR-WINDOW",
      `SELECT p.biomax_punch_id                            AS punch_id,
              d.employee_id,
              DATE_FORMAT(p.punch_date, '%Y-%m-%d')        AS punch_date,
              DATE_FORMAT(d.attendance_date, '%Y-%m-%d')   AS ingest_attendance_date,
              DATE_FORMAT(p.io_time, '%Y-%m-%d %H:%i:%s')  AS io_time,
              p.dev_id,
              p.ingest_source,
              v.attendance_punch_void_id,
              v.reason                                     AS void_reason,
              v.voided_by_employee_id,
              DATE_FORMAT(v.voided_at, '%Y-%m-%d %H:%i:%s') AS voided_at
         FROM biomax_punch_derived d
         JOIN biomax_punch p ON p.biomax_punch_id = d.biomax_punch_id
         LEFT JOIN attendance_punch_void v ON v.biomax_punch_id = p.biomax_punch_id
        WHERE d.employee_id = ?
          AND p.punch_date BETWEEN ? AND ?
        ORDER BY p.io_time ASC, p.biomax_punch_id ASC`,
      [employeeId, fromCalendarDate, toCalendarDate]
    );
  }

  /**
   * FULLY APPROVED AND SETTLED regularized punches only.
   *
   * The join to the request is the enforcement, not a convention: a punch
   * attached to a request still sitting at stage 2 of 3 is simply not
   * returned, so it cannot reach a calculation.
   *
   * `finalization_state = 'SETTLED'` is belt and braces (review fix #4). The
   * approval and the recalculated day now commit in one transaction, so an
   * APPROVED request that is not SETTLED cannot exist; requiring it here means
   * that even if one somehow did - a hand-edited row, a restore from a
   * half-finished dump - its punch would stay out of the calculation rather
   * than becoming effective against a day nobody recalculated.
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
          AND r.finalization_state = 'SETTLED'
        ORDER BY rp.punch_time ASC, rp.attendance_regularized_punch_id ASC`,
      [employeeId, fromDate, toDate]
    );
  }

  /**
   * The employee's Special Break Duration Override - ONE CURRENT VALUE
   * (review fix #7).
   *
   * A column on the employee row, exactly as the approved v2 product contract
   * describes it: one field on Employee Master, nullable, with NO Effective
   * From. The first implementation built an effective-dated
   * `employee_break_override` table; that invented a second temporal business
   * rule the product does not have, and it has been removed rather than kept
   * alongside this.
   */
  async getBreakOverride(employeeId) {
    const rows = await this._read(
      "GET-BREAK-OVERRIDE",
      `SELECT employee_id, special_break_override_minutes
         FROM new_employee
        WHERE employee_id = ?`,
      [employeeId]
    );
    return rows && rows[0] ? rows[0] : null;
  }

  /**
   * Set or clear that override. NULL clears it - "no override" is the absence
   * of a value, and there is no history to append because the product contract
   * has no effective date to append it against.
   */
  async setBreakOverride(employeeId, minutes) {
    return this._read(
      "SET-BREAK-OVERRIDE",
      `UPDATE new_employee SET special_break_override_minutes = ? WHERE employee_id = ?`,
      [minutes === null || minutes === undefined ? null : Math.max(0, Math.trunc(Number(minutes))), employeeId]
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
              candidate_ot_minutes, approved_ot_minutes, finalization_state,
              auto_created, reason, closure_reason,
              DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
              DATE_FORMAT(decided_at, '%Y-%m-%d %H:%i:%s') AS decided_at
         FROM attendance_approval_request
        WHERE requested_for_employee_id = ?
          AND attendance_date BETWEEN ? AND ?
          AND status <> 'CANCELLED'
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

      // One writer, shared with the approval path's own transaction.
      const result = await writeCalculationsOnConnection(connection, rows);

      await commitAsync(connection);
      return result;
    } catch (err) {
      await rollbackAsync(connection);
      this._log("SAVE-CALCULATIONS", err);
      throw err;
    } finally {
      connection.release();
    }
  }

  /**
   * Record a single-date shift override AND the recalculated day it produces,
   * in ONE transaction.
   *
   * Either both land or neither does: an override row without its recalculated
   * day would leave the stored attendance - the rows payroll reads - showing
   * the old shift while the resolver already says the new one. The override is
   * appended (never updated), and the calculation is the same idempotent
   * upsert every other writer uses, so a retried save that got as far as the
   * usecase's "already on that shift" check writes no second override row and
   * a retry that did not simply repeats the same two writes.
   */
  async saveDateShiftOverrideWithCalculation({ override, rows }) {
    const connection = await getConnectionAsync(this.db);
    try {
      await beginTransactionAsync(connection);

      const inserted = await queryAsync(
        connection,
        `INSERT INTO attendance_date_shift_override
           (employee_id, attendance_date, work_shift_id, previous_work_shift_id, changed_by)
         VALUES (?, ?, ?, ?, ?)`,
        [
          override.employee_id,
          override.attendance_date,
          override.work_shift_id,
          override.previous_work_shift_id === undefined ? null : override.previous_work_shift_id,
          override.changed_by === undefined ? null : override.changed_by,
        ]
      );
      const calculation = await writeCalculationsOnConnection(connection, rows);

      await commitAsync(connection);
      return {
        attendance_date_shift_override_id: inserted ? inserted.insertId : null,
        ...calculation,
      };
    } catch (err) {
      await rollbackAsync(connection);
      this._log("SAVE-DATE-SHIFT-OVERRIDE", err);
      throw err;
    } finally {
      connection.release();
    }
  }

  /* ------------------------------------------- bulk recalculation */

  /**
   * The employees a bulk recalculation targets.
   *
   * Filters combine: an employee id, an outlet (store), a designation, any
   * subset. Employment is respected the way the payroll window already does
   * it: somebody who had left before the range began, or joined after it
   * ended, is not in it. `date_of_joining` is a VARCHAR on `new_employee`,
   * so it is returned and the usecase applies the joining bound in JS with
   * the same parser payroll uses.
   */
  async listEmployeesForRecalculation({ employee_id, store_id, designation_id, from_date }) {
    const where = ["(ne.status = 1 OR ne.resignation_date IS NULL OR ne.resignation_date >= ?)"];
    const params = [from_date];
    if (employee_id) {
      where.push("ne.employee_id = ?");
      params.push(employee_id);
    }
    if (store_id) {
      where.push("ne.store_id = ?");
      params.push(store_id);
    }
    if (designation_id) {
      where.push("ne.designation_id = ?");
      params.push(designation_id);
    }
    return this._read(
      "LIST-EMPLOYEES-FOR-RECALCULATION",
      `SELECT ne.employee_id, ne.employee_name, ne.store_id, ne.designation_id, ne.status,
              ne.date_of_joining,
              DATE_FORMAT(ne.resignation_date, '%Y-%m-%d') AS resignation_date
         FROM new_employee ne
        WHERE ${where.join(" AND ")}
        ORDER BY ne.employee_id ASC`,
      params
    );
  }

  async outletExists(outletId) {
    const rows = await this._read(
      "OUTLET-EXISTS",
      "SELECT outlet_id FROM outlets WHERE outlet_id = ?",
      [outletId]
    );
    return rows.length > 0;
  }

  async designationExists(designationId) {
    const rows = await this._read(
      "DESIGNATION-EXISTS",
      "SELECT designation_id FROM designation WHERE designation_id = ?",
      [designationId]
    );
    return rows.length > 0;
  }

  /** Open a run record: RUNNING, with what was asked and by whom. */
  async insertRecalculationRun(run) {
    const result = await this._read(
      "INSERT-RECALCULATION-RUN",
      `INSERT INTO attendance_recalculation_run
         (requested_by_employee_id, from_date, to_date, employee_id, store_id, designation_id,
          employees_targeted, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'RUNNING')`,
      [
        run.requested_by_employee_id === undefined ? null : run.requested_by_employee_id,
        run.from_date,
        run.to_date,
        run.employee_id || null,
        run.store_id || null,
        run.designation_id || null,
        run.employees_targeted,
      ]
    );
    return result && result.insertId ? Number(result.insertId) : null;
  }

  /** Close it with the real counts and the outcome. */
  async finishRecalculationRun(runId, outcome) {
    if (!runId) return;
    await this._read(
      "FINISH-RECALCULATION-RUN",
      `UPDATE attendance_recalculation_run
          SET status = ?, employees_completed = ?, employees_failed = ?,
              days_processed = ?, errors = ?, completed_at = CURRENT_TIMESTAMP(3)
        WHERE attendance_recalculation_run_id = ?`,
      [
        outcome.status,
        outcome.employees_completed,
        outcome.employees_failed,
        outcome.days_processed,
        JSON.stringify(outcome.errors || []),
        runId,
      ]
    );
  }

  /** Recent runs, newest first, for the Recalculate Attendance screen. */
  async listRecalculationRuns(limit = 20) {
    return this._read(
      "LIST-RECALCULATION-RUNS",
      `SELECT r.attendance_recalculation_run_id, r.requested_by_employee_id,
              rb.employee_name AS requested_by_name,
              DATE_FORMAT(r.started_at, '%Y-%m-%d %H:%i:%s') AS started_at,
              DATE_FORMAT(r.completed_at, '%Y-%m-%d %H:%i:%s') AS completed_at,
              DATE_FORMAT(r.from_date, '%Y-%m-%d') AS from_date,
              DATE_FORMAT(r.to_date, '%Y-%m-%d') AS to_date,
              r.employee_id, e.employee_name,
              r.store_id, o.outlet_name,
              r.designation_id, d.designation_name,
              r.employees_targeted, r.employees_completed, r.employees_failed,
              r.days_processed, r.status, r.errors
         FROM attendance_recalculation_run r
         LEFT JOIN new_employee rb ON rb.employee_id = r.requested_by_employee_id
         LEFT JOIN new_employee e ON e.employee_id = r.employee_id
         LEFT JOIN outlets o ON o.outlet_id = r.store_id
         LEFT JOIN designation d ON d.designation_id = r.designation_id
        ORDER BY r.attendance_recalculation_run_id DESC
        LIMIT ?`,
      [Number(limit) > 0 ? Number(limit) : 20]
    );
  }

  /** The same idempotency, for one employee's month. */
  async saveMonthlyPayroll(row) {
    // Neutral wage components only (review fix #8). There is no
    // `statutory_base_*` column: attendance does not decide the PF/ESI base,
    // and `utils/salary_engine.js` remains the statutory authority.
    const columns = [
      "employee_id", "period_year", "period_month", "available_from", "available_to",
      "available_dates", "notional_offs", "base_days", "attendance_days", "salary_days",
      "extra_days", "monthly_gross", "daily_rate", "salary_day_earnings", "extra_day_earnings",
      "shortage_minutes", "missing_minute_deduction", "approved_ot_minutes",
      "approved_ot_earnings",
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
module.exports.CALCULATION_COLUMNS = CALCULATION_COLUMNS;
module.exports.writeCalculationsOnConnection = writeCalculationsOnConnection;
