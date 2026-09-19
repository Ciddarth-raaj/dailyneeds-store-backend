const logger = require("../utils/logger");
const {
  PAYROLL_LOCK_STATUS,
  periodsTouched,
  payrollLockedError,
} = require("../utils/attendance_payroll_lock");
const { JOINED_ON } = require("../utils/joining_date");
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
  "punch_count", "attendance_day_count", "nrm_minutes",
  // The PAYROLL BASE: the permanent shift's NRM for the date, and the shift
  // it came from. Equal to `nrm_minutes` on every date without an approved
  // one-day shift override. See `20261029120000-shift-change-request`.
  "base_nrm_minutes", "base_work_shift_id",
  "span_minutes",
  "break_allowance_minutes", "break_allowance_source",
  // What the employee's own settings contributed, as applied. See
  // `20261025120000-attendance-break-provenance`.
  "break_override_minutes_applied", "extra_break_minutes_applied",
  "actual_gap_minutes",
  "break_charged_minutes", "worked_minutes", "regular_minutes", "shortage_minutes", "late_minutes",
  "early_exit_minutes", "pre_shift_minutes", "post_shift_minutes",
  "raw_ot_minutes", "ot_offset_minutes", "pre_shift_ot_minutes", "post_shift_ot_minutes",
  "candidate_ot_minutes", "approved_ot_minutes",
  // WHY a day has approved OT. `shift_authorised_ot_minutes` is the part an
  // approved SHIFT_CHANGE authorised and for which no OT request exists; the
  // source and the request id are the audit trail beside it.
  "shift_authorised_ot_minutes", "approved_ot_source", "ot_authorising_request_id",
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
/**
 * THE PAYROLL LOCK GATE, on the connection, inside the caller's transaction,
 * before anything is written.
 *
 * ONE GATE FOR EVERY WRITER. Each path that persists attendance - the single
 * recalculation, the bulk run, the monthly `persist=true`, a date-specific
 * shift correction, the A3 approval that rewrites a day - reaches this file,
 * and this file reaches the database only through `writeCalculationsOnConnection`
 * and the reconciling delete beside it. Guarding here therefore guards them
 * all, including the next one somebody adds; guarding each usecase would not.
 *
 * THE LOCK IS THE PAYRUN'S, read where the payrun keeps it:
 * `payrun_employee_calculation` for that employee and period. This is a READ
 * of another stage's table, deliberately, rather than a second lock table or a
 * copy of the flag on an attendance row - a second definition of "locked" is
 * exactly the thing that ends up disagreeing. The status value compared comes
 * from `constants/payrun_calculation.js`.
 *
 * ================================================== WHY `FOR UPDATE` =======
 *
 * A read that merely LOOKED for an already-locked row was a time-of-check to
 * time-of-use race, and losing it meant exactly the thing the rule forbids:
 *
 *   1  attendance checks, finds no APPROVED_LOCKED row, and proceeds
 *   2  payrun approval locks that row and sets it to APPROVED_LOCKED
 *   3  attendance writes `attendance_day_calculation`
 *   4  attendance has been modified after payroll was locked
 *
 * So the gate takes the ROW LOCK the approval takes, on the same rows:
 * `repository/payrun_calculation.js#approveAndLock` re-reads
 * `WHERE period_year = ? AND period_month = ? AND employee_id = ? FOR UPDATE`
 * inside its own transaction, and this reads the same rows the same way. The
 * two transactions therefore serialize on one key: whichever arrives second
 * waits for the first to commit and then sees its outcome.
 *
 * THE PREDICATE MUST NOT NAME THE STATUS. `WHERE status = 'APPROVED_LOCKED'
 * FOR UPDATE` locks only rows that are ALREADY locked - a row sitting at
 * CALCULATED matches nothing, is not locked, and an approval is free to change
 * it underneath us. The row is located by its identity, locked, and its status
 * is inspected afterwards IN APPLICATION CODE, which is the only order that
 * closes the window.
 *
 * THE LOCK IS HELD UNTIL THE CALLER COMMITS OR ROLLS BACK, because it is taken
 * on the caller's connection inside the caller's transaction. Nothing is
 * released between the check and the write.
 *
 * SCOPE: the exact (employee, year, month) combinations this write touches,
 * and nothing else. A month of an employee that this write does not name is
 * never locked, so an approval of any other month proceeds while attendance is
 * being written. The rows are visited in a fixed order - period, then employee
 * id - so two attendance writes that overlap take the same locks in the same
 * order rather than deadlocking against each other.
 *
 * NO ROW MEANS NOTHING TO LOCK OUT. An employee/month the payrun has never
 * calculated cannot be approved or locked, so attendance proceeds. (InnoDB
 * still takes a gap lock for the absent row under REPEATABLE READ, which
 * happens to serialize a concurrent INSERT of it as well; the rule here does
 * not depend on that.)
 */
async function assertMonthsNotPayrollLocked(connection, rows) {
  const { periods, unreadable } = periodsTouched(rows);
  if (unreadable) {
    throw new Error("refusing to write attendance: a row has no readable employee and date");
  }
  if (periods.length === 0) return;

  // One statement per (year, month), each naming only the employees this
  // write touches in that month - the shape `approveAndLock` locks, widened
  // to a set rather than repeated per employee. Sorted so the lock order is
  // the same for every caller.
  const byPeriod = new Map();
  for (const period of periods) {
    const key = `${period.year}:${period.month}`;
    if (!byPeriod.has(key)) {
      byPeriod.set(key, { year: period.year, month: period.month, employee_ids: new Set() });
    }
    byPeriod.get(key).employee_ids.add(period.employee_id);
  }
  const ordered = [...byPeriod.values()].sort((a, b) => a.year - b.year || a.month - b.month);

  const hits = [];
  for (const group of ordered) {
    const employeeIds = [...group.employee_ids].sort((a, b) => a - b);
    /* eslint-disable no-await-in-loop */
    const locked = await queryAsync(
      connection,
      // NO STATUS IN THE PREDICATE. The row is found by identity and locked
      // whatever it currently says; what it says is decided below.
      `SELECT employee_id, period_year, period_month, status
         FROM payrun_employee_calculation
        WHERE period_year = ?
          AND period_month = ?
          AND employee_id IN (?)
        FOR UPDATE`,
      [group.year, group.month, employeeIds]
    );
    /* eslint-enable no-await-in-loop */

    for (const row of Array.isArray(locked) ? locked : []) {
      // INSPECTED AFTER THE LOCK, never in the WHERE clause.
      if (String(row.status) !== PAYROLL_LOCK_STATUS) continue;
      hits.push({
        employee_id: Number(row.employee_id),
        year: Number(row.period_year),
        month: Number(row.period_month),
      });
    }
  }

  if (hits.length > 0) throw payrollLockedError(hits);
}

/**
 * The upsert statement itself. PRIVATE, AND DELIBERATELY UNEXPORTED: it takes
 * no lock, so the only way to reach it is through a caller that has already
 * taken one. `writeCalculationsOnConnection` below is that caller for every
 * path but the monthly save, which holds the lock across two tables and calls
 * this directly rather than gating twice.
 */
async function upsertCalculationRows(connection, rows) {
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

/**
 * The monthly roll-up's upsert. PRIVATE and unexported for the same reason as
 * `upsertCalculationRows`: it takes no lock of its own, so it is reachable
 * only from `saveMonthWithPayroll`, which holds one. There is deliberately no
 * public `saveMonthlyPayroll` any more - an unguarded writer left lying about
 * is a writer somebody eventually calls.
 *
 * Neutral wage components only (review fix #8). There is no
 * `statutory_base_*` column: attendance does not decide the PF/ESI base, and
 * `utils/salary_engine.js` remains the statutory authority.
 */
const MONTHLY_PAYROLL_COLUMNS = [
  "employee_id", "period_year", "period_month", "available_from", "available_to",
  "available_dates", "notional_offs", "base_days", "attendance_days", "salary_days",
  "extra_days", "monthly_gross", "daily_rate", "salary_day_earnings", "extra_day_earnings",
  "shortage_minutes", "missing_minute_deduction", "approved_ot_minutes",
  "approved_ot_earnings",
  "total_attendance_payable", "held_dates", "is_final", "payroll_version",
];

async function upsertMonthlyPayrollOnConnection(connection, row) {
  const updates = MONTHLY_PAYROLL_COLUMNS
    .filter((c) => !["employee_id", "period_year", "period_month"].includes(c))
    .map((c) => `\`${c}\` = VALUES(\`${c}\`)`)
    .join(", ");

  return queryAsync(
    connection,
    `INSERT INTO attendance_monthly_payroll (${MONTHLY_PAYROLL_COLUMNS.map((c) => `\`${c}\``).join(", ")})
     VALUES (${MONTHLY_PAYROLL_COLUMNS.map(() => "?").join(", ")})
     ON DUPLICATE KEY UPDATE ${updates}`,
    MONTHLY_PAYROLL_COLUMNS.map((c) => row[c])
  );
}

/**
 * The guarded writer every other path uses: take the payroll lock, then write.
 *
 * Exported so `repository/attendance_regularization.js` can write the
 * recalculated day in the SAME transaction that records the final approval,
 * without either repository having to import the other's class - and so that
 * doing so is gated exactly like every other write.
 */
async function writeCalculationsOnConnection(connection, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return { written: 0 };
  await assertMonthsNotPayrollLocked(connection, rows);
  return upsertCalculationRows(connection, rows);
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
      // IS THIS OVERRIDE BACKED BY AN APPROVED EMPLOYEE REQUEST?
      //
      // The link already exists - an approved SHIFT_CHANGE writes the
      // override with its own request id and `source = 'APPROVED_REQUEST'` -
      // so the authorisation is a JOIN and not a new table, a new flag or a
      // second approval flow. The request must be FINALLY approved and
      // SETTLED: an intermediate stage authorises nothing, and a rejection
      // authorises nothing.
      //
      // A DIRECT MANAGEMENT EDIT IS NOT AN EMPLOYEE AUTHORISATION. An
      // override written on the attendance screen has no request behind it,
      // so `shift_change_approved` is 0 and the date keeps the ordinary OT
      // request path - which is the honest answer: nobody agreed with the
      // employee that they would work longer hours.
      `SELECT o.attendance_date_shift_override_id,
              o.employee_id,
              o.work_shift_id,
              o.previous_work_shift_id,
              o.changed_by,
              o.source,
              o.attendance_approval_request_id,
              CASE WHEN r.attendance_approval_request_id IS NOT NULL
                    AND r.request_type = 'SHIFT_CHANGE'
                    AND r.status = 'APPROVED'
                    AND r.finalization_state = 'SETTLED'
                   THEN 1 ELSE 0 END AS shift_change_approved,
              DATE_FORMAT(o.attendance_date, '%Y-%m-%d') AS attendance_date,
              DATE_FORMAT(o.created_at, '%Y-%m-%d %H:%i:%s') AS created_at
         FROM attendance_date_shift_override o
         LEFT JOIN attendance_approval_request r
           ON r.attendance_approval_request_id = o.attendance_approval_request_id
        WHERE o.employee_id = ?
          AND o.attendance_date BETWEEN ? AND ?
        ORDER BY o.attendance_date ASC, o.attendance_date_shift_override_id ASC`,
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
      `SELECT employee_id, special_break_override_minutes, extra_break_hours,
              attendance_required
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
              -- SHIFT_CHANGE only, and NULL on every other row: the shift the
              -- employee asked for. The day's own shift is the resolver's
              -- answer and is not this - a pending request changes nothing -
              -- but the employee's own screen has to be able to say what they
              -- asked for while it is still pending.
              requested_work_shift_id,
              DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
              DATE_FORMAT(decided_at, '%Y-%m-%d %H:%i:%s') AS decided_at,
              -- WHY A REJECTION WAS REJECTED. The remarks live on the STEP
              -- that rejected, not on the request, and a rejection ends the
              -- chain at exactly one step - so the latest REJECTED step is
              -- the rejection. Read here rather than in a second round trip
              -- because the employee's own screens show the reason beside
              -- the status, and a status without its reason is what sends
              -- people to ask their manager what happened.
              (SELECT s.remarks
                 FROM attendance_approval_step s
                WHERE s.attendance_approval_request_id = r.attendance_approval_request_id
                  AND s.decision = 'REJECTED'
                ORDER BY s.stage_no DESC
                LIMIT 1) AS rejection_remarks
         FROM attendance_approval_request r
        WHERE requested_for_employee_id = ?
          AND attendance_date BETWEEN ? AND ?
          AND status <> 'CANCELLED'
        ORDER BY attendance_date ASC, attendance_approval_request_id ASC`,
      [employeeId, fromDate, toDate]
    );
  }

  /**
   * Joining and last-working dates, for the A4 available-dates window AND for
   * the shared eligibility rule every recalculation now applies
   * (`utils/attendance_eligibility.js`).
   *
   * `attendance_required` is selected because the rule needs all three facts
   * from one read, and because a caller that did NOT select it is treated as
   * "attendance is required" - which is right for safety and wrong as a way
   * of deciding an exemption. Asking for it here is how the exemption is
   * actually honoured.
   *
   * `date_of_joining` goes through `JOINED_ON` - the one shared parser - and
   * then DATE_FORMAT, so it leaves the database as `YYYY-MM-DD` TEXT. It is a
   * real DATE column since
   * `20261012120000-employee-joining-date-to-date`, and the API pool sets no
   * `dateStrings`, so a bare DATE would arrive as a JS Date built at local
   * midnight - in IST that is 18:30 the PREVIOUS day in UTC, and every
   * joining bound would silently move a day. No bare date is selected
   * anywhere in this file, and this is no exception.
   */
  async getEmploymentWindow(employeeId) {
    const rows = await this._read(
      "GET-EMPLOYMENT-WINDOW",
      `SELECT ne.employee_id,
              ne.status,
              ne.attendance_required,
              DATE_FORMAT(ne.resignation_date, '%Y-%m-%d') AS resignation_date,
              DATE_FORMAT((${JOINED_ON("ne")}), '%Y-%m-%d') AS date_of_joining
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
   * Persist a recalculated window AND remove the stored rows for dates the
   * employee is PROVEN ineligible for - in ONE transaction.
   *
   * ================== THE RULE, AND THE RULE IT REPLACES ==================
   *
   * The first implementation deleted every row of the window that the
   * calculation had not just written: `... AND attendance_date NOT IN (the
   * dates produced)`. That treats "the engine returned no row for this date"
   * as identical to "this employee/date is ineligible", and those are two
   * different sentences. The engine can return nothing for a date because of
   * a missing shift assignment, a missing schedule row, an unreadable shift
   * configuration, a punch read that came back short, an incomplete batch or
   * a thrown exception - and NONE of those is a reason to delete somebody's
   * attendance history. Under that rule, a future change that made the engine
   * skip a date would silently destroy stored attendance for it, and no test
   * anywhere would have to fail first.
   *
   * So the caller now computes the ineligible dates POSITIVELY, from the
   * shared rule alone (`utils/attendance_eligibility.js#ineligibleDatesIn`),
   * and passes them in. This statement deletes those dates and nothing else:
   *
   *   DELETE FROM attendance_day_calculation
   *    WHERE employee_id = ? AND attendance_date IN (<the ineligible dates>)
   *
   * A date can therefore only be deleted by being one of `attendance_required
   * = 0`, before the joining date, or after the resignation date. A date that
   * failed to calculate keeps whatever was stored for it, which is the safe
   * direction: stale-but-recalculable beats deleted-and-gone.
   *
   * ============================ THE GUARDS ================================
   *
   * `ineligible_dates` is REQUIRED. Omitting it is an error rather than a
   * default, so no caller can reach this and get a deletion policy it did not
   * ask for. Every date is then checked to be inside the requested window,
   * and checked NOT to be among the dates being written - a date that is
   * simultaneously calculated and ineligible means the eligibility rule and
   * the calculation disagree, and the honest response to that is to abort the
   * transaction, not to pick one.
   *
   * =================== WHAT IT MUST NEVER TOUCH, AND DOES NOT =============
   *
   *   biomax_punch, biomax_punch_derived   raw, append-only, someone else's
   *   attendance_punch_void                a human said this punch is void
   *   attendance_approval_request          a human decided this
   *   attendance_regularized_punch         a human supplied this
   *   attendance_date_shift_override       the audit line of a shift edit
   *   attendance_monthly_payroll           a different derived table, keyed by
   *                                        month, reconciled by its own path
   *   employee_lifecycle_event / period    service history
   *
   * None of those is named in any statement here. This file issues exactly
   * one DELETE, against one table, and it is below.
   *
   * `attendance_day_calculation` is the OUTPUT of the calculation flow and
   * nothing else: every row in it was written by `writeCalculationsOnConnection`
   * and every column is derived from raw punches, dated shift history and
   * approved regularizations. The whole table can be dropped and recomputed
   * without losing a fact anybody entered. That is the ownership test this
   * deletion turns on, and it is why the delete is confined to this table.
   *
   * ========================= TRANSACTION BOUNDARY =========================
   *
   * The upsert and the delete share one transaction on one connection. Either
   * both land or neither does: a window that was emptied but not rewritten is
   * worse than one that was never touched. Any failure rolls back - and a
   * failure BEFORE this method is called (the engine throwing, the punch
   * re-derive failing) means it is never called at all, so nothing was
   * deleted either.
   */
  async saveCalculationsWithReconciliation({
    employee_id,
    from_date,
    to_date,
    rows,
    ineligible_dates,
  }) {
    const employeeId = Number(employee_id);
    if (!Number.isInteger(employeeId) || employeeId <= 0) {
      throw new Error("saveCalculationsWithReconciliation needs an employee_id");
    }
    if (!from_date || !to_date) {
      throw new Error("saveCalculationsWithReconciliation needs the requested window");
    }
    if (!Array.isArray(ineligible_dates)) {
      // Deliberately not defaulted to []. A caller that forgot to compute the
      // ineligible dates must fail loudly, not quietly stop reconciling.
      throw new Error(
        "saveCalculationsWithReconciliation needs ineligible_dates - the dates the shared eligibility rule excludes"
      );
    }

    const batch = Array.isArray(rows) ? rows : [];
    const written = new Set(batch.map((r) => r.attendance_date));

    const doomed = [...new Set(ineligible_dates)];
    for (const date of doomed) {
      if (date < from_date || date > to_date) {
        throw new Error(
          `refusing to delete ${date}: outside the requested window ${from_date}..${to_date}`
        );
      }
      if (written.has(date)) {
        throw new Error(
          `refusing to delete ${date}: the same run calculated it, so the eligibility rule and the calculation disagree`
        );
      }
    }

    const connection = await getConnectionAsync(this.db);
    try {
      await beginTransactionAsync(connection);

      const result = await writeCalculationsOnConnection(connection, batch);

      let removed = null;
      if (doomed.length > 0) {
        // THE DELETE IS A MODIFICATION TOO. The upsert above was gated by the
        // rows it was about to write; a date that is only being REMOVED has
        // no row in that batch, so it is gated here on its own.
        await assertMonthsNotPayrollLocked(
          connection,
          doomed.map((date) => ({ employee_id: employeeId, attendance_date: date }))
        );
        removed = await queryAsync(
          connection,
          `DELETE FROM attendance_day_calculation
            WHERE employee_id = ?
              AND attendance_date IN (?)`,
          [employeeId, doomed]
        );
      }

      await commitAsync(connection);
      return {
        ...result,
        stale_removed: removed ? Number(removed.affectedRows) : 0,
      };
    } catch (err) {
      await rollbackAsync(connection);
      this._log("SAVE-CALCULATIONS-WITH-RECONCILIATION", err);
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

  /**
   * WHICH of these (employee, date) pairs fall in a payroll-locked month.
   *
   * READ-ONLY AND OUTSIDE ANY TRANSACTION, and therefore deliberately NOT the
   * rule: `assertMonthsNotPayrollLocked` above, which takes the row lock
   * inside the writing transaction, remains the only thing that can actually
   * stop a write, and nothing here weakens it. This exists so that a path
   * which is about to REFUSE AN ACTION rather than write a number - filing a
   * shift request, approving one, dating a permanent shift change into a
   * closed month - can say so before it starts, in a sentence that names the
   * month. A lock landing between this check and the write is exactly the
   * race the transactional guard is there for.
   *
   * @param {Array} rows  `[{ employee_id, attendance_date }]`
   * @returns {Array} `[{ employee_id, year, month }]`, empty when none
   */
  async findPayrollLockedPeriods(rows = []) {
    const { periods } = periodsTouched(rows);
    if (periods.length === 0) return [];

    const found = [];
    for (const period of periods) {
      /* eslint-disable no-await-in-loop */
      const hit = await this._read(
        "FIND-PAYROLL-LOCKED",
        `SELECT employee_id, period_year, period_month, status
           FROM payrun_employee_calculation
          WHERE period_year = ? AND period_month = ? AND employee_id = ? AND status = ?
          LIMIT 1`,
        [period.year, period.month, period.employee_id, PAYROLL_LOCK_STATUS]
      );
      /* eslint-enable no-await-in-loop */
      if (hit.length > 0) found.push(period);
    }
    return found;
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
   *
   * EMPLOYMENT IS THE RESIGNATION DATE, NOT `status`. The predicate used to
   * read `ne.status = 1 OR resignation_date IS NULL OR resignation_date >= ?`,
   * and that first disjunct let every employee whose `status` had been left at
   * 1 through however long ago they resigned - which is most of the leavers,
   * because `status` is maintained by hand. An unfiltered "All employees" run
   * therefore targeted all 305 rows of the master and wrote a NO_SHIFT_FOR_DATE
   * day for every date of the range for people who had left. Only the dated
   * facts decide now: no resignation date, or one on/after the range began.
   *
   * `employee_employment_period` is NOT consulted. It is the right source
   * eventually, but its backfill still carries rows flagged needs_review, so
   * this reads the column payroll reads.
   */
  async listEmployeesForRecalculation({ employee_id, store_id, designation_id, from_date, to_date }) {
    // A run is a RECONCILIATION, so the candidate set is "who might have a
    // calculated day in this window", not only "who can earn one". Somebody
    // who resigned before the window began earns nothing - but if a previous
    // run stored days for them, those days are exactly what has to be removed,
    // and a query that hides them is what let them survive. So the employment
    // predicate is widened by an EXISTS over the calculated days the window
    // actually holds. It stays a targeted query: it adds only employees who
    // already have a row in that window, and the usecase's shared eligibility
    // rule then decides that they get a reconciliation and no calculation.
    const windowTo = to_date || from_date;
    const where = [
      `((ne.resignation_date IS NULL OR ne.resignation_date >= ?)
        OR EXISTS (SELECT 1 FROM attendance_day_calculation adc
                    WHERE adc.employee_id = ne.employee_id
                      AND adc.attendance_date BETWEEN ? AND ?))`,
    ];
    const params = [from_date, from_date, windowTo];
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
              ne.attendance_required,
              DATE_FORMAT((${JOINED_ON("ne")}), '%Y-%m-%d') AS date_of_joining,
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

  /**
   * THE MONTH, PERSISTED AS ONE THING: the day rows and the monthly roll-up,
   * in ONE transaction, under ONE payroll-row lock.
   *
   * WHY THEY CANNOT BE TWO CALLS. They were, and it left two holes:
   *
   *   1  the day rows committed, an approval then took the payrun row and
   *      locked the month, and the monthly roll-up was written afterwards -
   *      an attendance figure landing after payroll was approved;
   *   2  the monthly write failing after the daily write had committed left a
   *      month whose days said one thing and whose roll-up said another, with
   *      nothing to show which half was real.
   *
   * So the lock is taken once, for the employee/month and for every date the
   * day rows touch, and held across both writes until the commit. An approval
   * cannot interleave between them: it wants the same row and waits.
   *
   * THE ORDER IS THE CONTRACT:
   *
   *   BEGIN
   *   SELECT payrun_employee_calculation ... FOR UPDATE   (the one gate)
   *   INSERT ... attendance_day_calculation               (the days)
   *   INSERT ... attendance_monthly_payroll               (the month)
   *   COMMIT
   *
   * Any failure rolls the whole thing back: neither half survives alone.
   */
  async saveMonthWithPayroll({ employee_id, period_year, period_month, rows = [], monthly = null }) {
    const employeeId = Number(employee_id);
    const year = Number(period_year);
    const month = Number(period_month);
    if (!Number.isInteger(employeeId) || employeeId <= 0) {
      throw new Error("saveMonthWithPayroll needs an employee_id");
    }
    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
      throw new Error("saveMonthWithPayroll needs a period_year and period_month");
    }

    const connection = await getConnectionAsync(this.db);
    try {
      await beginTransactionAsync(connection);

      // ONE GATE, for the month being written AND for every date the day rows
      // touch. The month itself is named explicitly so that a month with no
      // day rows at all - an absent employee, an empty window - is still
      // locked against its own approval.
      await assertMonthsNotPayrollLocked(connection, [
        { employee_id: employeeId, attendance_date: `${year}-${String(month).padStart(2, "0")}-01` },
        ...rows,
      ]);

      const calculation = await upsertCalculationRows(connection, rows);
      let monthlyWritten = 0;
      if (monthly) {
        await upsertMonthlyPayrollOnConnection(connection, monthly);
        monthlyWritten = 1;
      }

      await commitAsync(connection);
      return { ...calculation, monthly_written: monthlyWritten };
    } catch (err) {
      await rollbackAsync(connection);
      this._log("SAVE-MONTH-WITH-PAYROLL", err);
      throw err;
    } finally {
      connection.release();
    }
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
/**
 * THE PAYROLL LOCK, exported so that every write which could invalidate a
 * settled month takes the SAME row lock in the SAME transaction.
 *
 * `repository/employee_work_shift.js` reuses it for the effective-dated shift
 * change: that write does not touch `attendance_day_calculation`, but it
 * decides which shift a settled month's attendance would be recalculated
 * under, which is the same fact by a different route. A second, weaker
 * implementation is exactly what this export exists to prevent.
 */
module.exports.assertMonthsNotPayrollLocked = assertMonthsNotPayrollLocked;
