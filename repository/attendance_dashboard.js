const logger = require("../utils/logger");
const { JOINED_ON } = require("../utils/joining_date");

/**
 * Attendance Dashboard - the reads.
 *
 * EVERY QUERY HERE IS BATCHED ACROSS EMPLOYEES, and that is the whole reason
 * this repository exists beside `repository/attendance_calculation.js`.
 * That one is built for ONE employee over a range: `buildContext` there
 * issues six queries per employee, which is exactly right for a screen
 * showing one person's month and completely wrong for a dashboard covering a
 * whole company on one date - three hundred employees would be eighteen
 * hundred round trips. The statements below take an employee-id LIST and come
 * back once, so the same date costs a fixed handful of queries however many
 * people are in scope.
 *
 * NOTHING HERE WRITES. There is no INSERT, UPDATE or DELETE in this file and
 * no transaction: the dashboard is a read of state that already exists.
 * Opening it must never mutate an attendance or payroll record and must never
 * trigger a recalculation, so the capability to do either is simply absent
 * rather than merely unused.
 *
 * EVERY TIME LEAVES THE DATABASE AS A STRING, via DATE_FORMAT / TIME_FORMAT,
 * for the same reason the calculation repository does it: the API pool has no
 * `dateStrings` option, so a bare DATETIME comes back as a JS Date built in
 * the process timezone and every punch would shift by the server's offset.
 * No bare date or time column is selected anywhere below.
 *
 * NO `SELECT *`, AND NOTHING SENSITIVE. Every column is named, and the lists
 * are the minimum the dashboard renders. Counting who is at work is not a
 * reason to read anybody's salary, bank account, PAN, PF/ESI number or
 * Aadhaar, so none of those columns is selected in this file at all - the
 * response cannot leak a field it never loaded.
 */
class AttendanceDashboardRepository {
  constructor(db) {
    this.db = db;
  }

  _log(code, err, ref = {}) {
    logger.Log({
      level: logger.LEVEL.ERROR,
      component: "REPOSITORY.ATTENDANCE_DASHBOARD",
      code: `REPOSITORY.ATTENDANCE_DASHBOARD.${code}`,
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

  /* ------------------------------------------------- the population */

  /**
   * The employees APPLICABLE to one attendance date, with the filters applied.
   *
   * EMPLOYMENT IS THE DATED FACT, NOT `status`. This is the same predicate
   * `listEmployeesForRecalculation` settled on in the calculation repository,
   * and it is copied here for the reason stated there: `new_employee.status`
   * is maintained by hand and has been left at 1 for most leavers, so reading
   * it would put people who left years ago into today's headcount. Only
   * `resignation_date` and `date_of_joining` decide.
   *
   * BOTH BOUNDS ARE APPLIED, unlike the recalculation query which applies the
   * joining bound in JS. `date_of_joining` is a VARCHAR holding three
   * different shapes, so it is read through `JOINED_ON` - the one parser the
   * lifecycle backfill and payroll already share - rather than compared as
   * text. An employee whose joining date is absent or unreadable is INCLUDED:
   * 425 of 630 production rows have no readable joining date, and excluding
   * them would silently empty the dashboard.
   *
   * `employee_employment_period` is deliberately NOT consulted, for exactly
   * the reason the calculation repository gives: its backfill still carries
   * rows flagged `needs_review`, so this reads the columns payroll reads.
   *
   * THE SEARCH IS A FILTER, NEVER AN AUTHORIZATION. It narrows an already
   * scoped list; it cannot widen one.
   */
  async listApplicableEmployees({
    attendance_date,
    store_ids = null,
    designation_id = null,
    search = null,
  }) {
    const where = [
      "(ne.resignation_date IS NULL OR ne.resignation_date >= ?)",
      `((${JOINED_ON("ne")}) IS NULL OR (${JOINED_ON("ne")}) <= ?)`,
    ];
    const params = [attendance_date, attendance_date];

    if (Array.isArray(store_ids) && store_ids.length > 0) {
      where.push("ne.store_id IN (?)");
      params.push(store_ids);
    }
    if (designation_id) {
      where.push("ne.designation_id = ?");
      params.push(designation_id);
    }
    if (search) {
      // Name OR employee id, the same two things the existing employee picker
      // searches on. Escaped for LIKE so a `%` typed by a user is a literal.
      const like = `%${String(search).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      where.push("(ne.employee_name LIKE ? OR CAST(ne.employee_id AS CHAR) LIKE ?)");
      params.push(like, like);
    }

    return this._read(
      "LIST-APPLICABLE-EMPLOYEES",
      `SELECT ne.employee_id, ne.employee_name, ne.store_id, ne.designation_id,
              ne.special_break_override_minutes,
              o.outlet_name, o.outlet_nickname,
              d.designation_name,
              DATE_FORMAT(ne.resignation_date, '%Y-%m-%d') AS resignation_date
         FROM new_employee ne
         LEFT JOIN outlets o     ON o.outlet_id = ne.store_id
         LEFT JOIN designation d ON d.designation_id = ne.designation_id
        WHERE ${where.join(" AND ")}
        ORDER BY ne.employee_id ASC`,
      params
    );
  }

  /* ------------------------------------------------ A0: shift history */

  /** Every listed employee's dated assignment history, in one read. */
  async getShiftAssignmentHistoryForEmployees(employeeIds) {
    if (!Array.isArray(employeeIds) || employeeIds.length === 0) return [];
    return this._read(
      "GET-SHIFT-HISTORY-BULK",
      `SELECT employee_work_shift_assignment_id, employee_id, work_shift_id,
              DATE_FORMAT(effective_from, '%Y-%m-%d') AS effective_from, source
         FROM employee_work_shift_assignment
        WHERE employee_id IN (?)
        ORDER BY employee_id ASC, effective_from ASC, employee_work_shift_assignment_id ASC`,
      [employeeIds]
    );
  }

  /**
   * Single-date shift overrides for the listed employees over a window.
   *
   * The window runs one day PAST the range being displayed, for the same
   * reason `buildContext` reads it: the cutoff rule can date a punch one day
   * back, and dating that punch needs the shift that applied on its own date.
   */
  async getDateShiftOverridesForEmployees(employeeIds, fromDate, toDate) {
    if (!Array.isArray(employeeIds) || employeeIds.length === 0) return [];
    return this._read(
      "GET-DATE-SHIFT-OVERRIDES-BULK",
      `SELECT attendance_date_shift_override_id, employee_id, work_shift_id,
              DATE_FORMAT(attendance_date, '%Y-%m-%d') AS attendance_date
         FROM attendance_date_shift_override
        WHERE employee_id IN (?)
          AND attendance_date BETWEEN ? AND ?
        ORDER BY employee_id ASC, attendance_date ASC, attendance_date_shift_override_id ASC`,
      [employeeIds, fromDate, toDate]
    );
  }

  /**
   * Every shift the dashboard could need, live definition and schedules, in
   * two reads rather than two per shift.
   *
   * The column list is the one `getWorkShiftWithSchedule` selects in the
   * calculation repository, because the snapshot builder consumes exactly
   * those fields and a shorter list would silently default an OT rule to off.
   */
  async listWorkShiftConfigs() {
    return this._read(
      "LIST-WORK-SHIFT-CONFIGS",
      `SELECT work_shift_id, shift_code, shift_name, active,
              overtime_allowed, overtime_minimum_minutes,
              overtime_rounding_method, overtime_rounding_interval_minutes,
              overtime_minimum_threshold_only, overtime_minimum_excluded,
              maximum_ot_minutes_per_day,
              pre_shift_overtime_allowed, pre_shift_overtime_minimum_minutes,
              pre_shift_overtime_rounding_method,
              pre_shift_overtime_rounding_interval_minutes,
              pre_shift_overtime_minimum_excluded,
              late_offset_against_overtime, early_exit_offset_against_overtime,
              late_grace_minutes, late_deduction_interval_minutes, late_deduct_minutes,
              late_exclude_grace_from_deduction,
              early_exit_grace_minutes, early_exit_deduction_interval_minutes,
              early_exit_deduct_minutes
         FROM work_shift
        ORDER BY work_shift_id ASC`
    );
  }

  async listWorkShiftSchedules() {
    return this._read(
      "LIST-WORK-SHIFT-SCHEDULES",
      `SELECT work_shift_weekly_schedule_id, work_shift_id, day_of_week, is_working_day,
              TIME_FORMAT(in_time, '%H:%i:%s')               AS in_time,
              TIME_FORMAT(out_time, '%H:%i:%s')              AS out_time,
              TIME_FORMAT(attendance_day_cutoff, '%H:%i:%s') AS attendance_day_cutoff,
              break_minutes, normal_work_minutes, ot_rate
         FROM work_shift_weekly_schedule
        ORDER BY work_shift_id ASC, day_of_week ASC`
    );
  }

  /**
   * The effective-dated configuration VERSIONS of every shift.
   *
   * Whole history, oldest first, exactly as the calculation repository reads
   * it per shift: `utils/shift_config_version.js` picks the version in force
   * per date, so a date in the middle of last month is calculated under the
   * configuration that applied then and not under an edit made since.
   */
  async listWorkShiftConfigVersions() {
    return this._read(
      "LIST-WORK-SHIFT-CONFIG-VERSIONS",
      `SELECT work_shift_config_version_id, work_shift_id,
              DATE_FORMAT(effective_from, '%Y-%m-%d') AS effective_from,
              config_hash, config_document, source
         FROM work_shift_config_version
        ORDER BY work_shift_id ASC, effective_from ASC, work_shift_config_version_id ASC`
    );
  }

  /* ---------------------------------------------------- A1: the punches */

  /**
   * RAW punches for MANY employees over a CALENDAR window.
   *
   * Same shape and the same two deliberate choices as
   * `getRawPunchesByCalendarWindow`: the filter is `biomax_punch.punch_date`
   * (the calendar date the device stamped) and NOT the ingest-time
   * `biomax_punch_derived.attendance_date`, because the attendance day is
   * re-derived from the dated shift history; and the manual void rides along
   * on a LEFT JOIN so "is this punch voided" needs no second query.
   */
  async getRawPunchesForEmployees(employeeIds, fromCalendarDate, toCalendarDate) {
    if (!Array.isArray(employeeIds) || employeeIds.length === 0) return [];
    return this._read(
      "GET-RAW-PUNCHES-BULK",
      `SELECT p.biomax_punch_id                            AS punch_id,
              d.employee_id,
              DATE_FORMAT(p.punch_date, '%Y-%m-%d')        AS punch_date,
              DATE_FORMAT(d.attendance_date, '%Y-%m-%d')   AS ingest_attendance_date,
              DATE_FORMAT(p.io_time, '%Y-%m-%d %H:%i:%s')  AS io_time,
              p.dev_id,
              p.ingest_source,
              v.attendance_punch_void_id,
              v.reason                                     AS void_reason
         FROM biomax_punch_derived d
         JOIN biomax_punch p ON p.biomax_punch_id = d.biomax_punch_id
         LEFT JOIN attendance_punch_void v ON v.biomax_punch_id = p.biomax_punch_id
        WHERE d.employee_id IN (?)
          AND p.punch_date BETWEEN ? AND ?
        ORDER BY d.employee_id ASC, p.io_time ASC, p.biomax_punch_id ASC`,
      [employeeIds, fromCalendarDate, toCalendarDate]
    );
  }

  /**
   * FULLY APPROVED regularized punches only.
   *
   * `status = 'APPROVED' AND finalization_state = 'SETTLED'` is the same gate
   * `getApprovedRegularizedPunches` applies: a punch whose request is still
   * travelling up the approval chain changes no number anywhere, and counting
   * it as a check-in here would let a pending request manufacture attendance.
   */
  async getApprovedRegularizedPunchesForEmployees(employeeIds, fromDate, toDate) {
    if (!Array.isArray(employeeIds) || employeeIds.length === 0) return [];
    return this._read(
      "GET-REGULARIZED-PUNCHES-BULK",
      `SELECT rp.attendance_regularized_punch_id           AS punch_id,
              rp.employee_id,
              DATE_FORMAT(rp.attendance_date, '%Y-%m-%d')  AS attendance_date,
              DATE_FORMAT(rp.punch_time, '%Y-%m-%d %H:%i:%s') AS io_time,
              rp.punch_source
         FROM attendance_regularized_punch rp
         JOIN attendance_approval_request r
           ON r.attendance_approval_request_id = rp.attendance_approval_request_id
        WHERE rp.employee_id IN (?)
          AND rp.attendance_date BETWEEN ? AND ?
          AND r.status = 'APPROVED'
          AND r.finalization_state = 'SETTLED'
        ORDER BY rp.employee_id ASC, rp.punch_time ASC`,
      [employeeIds, fromDate, toDate]
    );
  }

  /**
   * The approval state beside each employee-date, for MANY employees.
   *
   * Mirrors `getApprovalStateByDate`, including `status <> 'CANCELLED'`: a
   * withdrawn request is not pending on anybody and must not hold a day in
   * Need Action.
   */
  async getApprovalStateForEmployees(employeeIds, fromDate, toDate) {
    if (!Array.isArray(employeeIds) || employeeIds.length === 0) return [];
    return this._read(
      "GET-APPROVAL-STATE-BULK",
      `SELECT attendance_approval_request_id,
              requested_for_employee_id AS employee_id,
              DATE_FORMAT(attendance_date, '%Y-%m-%d') AS attendance_date,
              request_type, status, current_stage_no, total_stages,
              candidate_ot_minutes, approved_ot_minutes, finalization_state,
              auto_created,
              DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_at
         FROM attendance_approval_request
        WHERE requested_for_employee_id IN (?)
          AND attendance_date BETWEEN ? AND ?
          AND status <> 'CANCELLED'
        ORDER BY employee_id ASC, attendance_date ASC, attendance_approval_request_id ASC`,
      [employeeIds, fromDate, toDate]
    );
  }

  /* ------------------------------------------------- F: punches & sync */

  /**
   * The most recent punches received, BOUNDED by `limit`.
   *
   * Ordered by `received_at` - when the server got the frame - and not by
   * `io_time`, because this panel answers "what is arriving" rather than "who
   * worked when". Both are returned so the screen can show them separately
   * and never present one as the other.
   *
   * The device's punch LOCATION comes from `biomax_device_assignment`, the
   * effective-dated device-to-outlet map, evaluated at the punch's own
   * instant - so a terminal that moved between branches attributes each punch
   * to where it actually was. `effective_to` is exclusive and NULL means open,
   * exactly as the schema documents.
   */
  async listRecentPunches({ limit = 25, store_ids = null }) {
    const where = [];
    const params = [];
    if (Array.isArray(store_ids) && store_ids.length > 0) {
      where.push("(asg.outlet_id IN (?) OR ne.store_id IN (?))");
      params.push(store_ids, store_ids);
    }
    params.push(Math.max(1, Math.min(200, Math.trunc(Number(limit) || 25))));
    return this._read(
      "LIST-RECENT-PUNCHES",
      `SELECT p.biomax_punch_id AS punch_id,
              d.employee_id,
              ne.employee_name,
              DATE_FORMAT(p.io_time, '%Y-%m-%d %H:%i:%s')     AS io_time,
              DATE_FORMAT(p.received_at, '%Y-%m-%d %H:%i:%s') AS received_at,
              DATE_FORMAT(d.attendance_date, '%Y-%m-%d')      AS ingest_attendance_date,
              d.derivation_status,
              p.dev_id,
              p.ingest_source,
              dev.label      AS device_label,
              asg.outlet_id  AS punch_outlet_id,
              po.outlet_name AS punch_outlet_name,
              v.attendance_punch_void_id
         FROM biomax_punch p
         JOIN biomax_punch_derived d ON d.biomax_punch_id = p.biomax_punch_id
         LEFT JOIN new_employee ne  ON ne.employee_id = d.employee_id
         LEFT JOIN biomax_device dev ON dev.dev_id = p.dev_id
         LEFT JOIN biomax_device_assignment asg
                ON asg.biomax_device_id = dev.biomax_device_id
               AND asg.effective_from <= p.io_time
               AND (asg.effective_to IS NULL OR asg.effective_to > p.io_time)
         LEFT JOIN outlets po ON po.outlet_id = asg.outlet_id
         LEFT JOIN attendance_punch_void v ON v.biomax_punch_id = p.biomax_punch_id
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY p.received_at DESC, p.biomax_punch_id DESC
        LIMIT ?`,
      params
    );
  }

  /**
   * Device sync health, as EVIDENCE and never as a verdict.
   *
   * `last_seen_at` is maintained by the receiver on ANY request from the
   * terminal, including its `receive_cmd` polls, and `last_punch_at` only on
   * a real punch. Those are two different facts and both are returned: a
   * terminal at a branch that closed early is quiet because nobody punched,
   * not because it is offline, and only `last_seen_at` can tell the two
   * apart. The usecase presents them; nothing here grades a device.
   */
  async listDeviceSyncHealth({ store_ids = null }) {
    const where = [];
    const params = [];
    if (Array.isArray(store_ids) && store_ids.length > 0) {
      where.push("asg.outlet_id IN (?)");
      params.push(store_ids);
    }
    return this._read(
      "LIST-DEVICE-SYNC-HEALTH",
      `SELECT dev.biomax_device_id, dev.dev_id, dev.label,
              DATE_FORMAT(dev.last_seen_at,  '%Y-%m-%d %H:%i:%s') AS last_seen_at,
              DATE_FORMAT(dev.last_punch_at, '%Y-%m-%d %H:%i:%s') AS last_punch_at,
              asg.outlet_id, o.outlet_name
         FROM biomax_device dev
         LEFT JOIN biomax_device_assignment asg
                ON asg.biomax_device_id = dev.biomax_device_id
               AND asg.effective_to IS NULL
         LEFT JOIN outlets o ON o.outlet_id = asg.outlet_id
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY dev.label ASC, dev.dev_id ASC`,
      params
    );
  }

  /* ------------------------------------------------------- master data */

  async listOutlets() {
    return this._read(
      "LIST-OUTLETS",
      "SELECT outlet_id, outlet_name, outlet_nickname FROM outlets ORDER BY outlet_name ASC"
    );
  }

  async listDesignations() {
    return this._read(
      "LIST-DESIGNATIONS",
      "SELECT designation_id, designation_name FROM designation ORDER BY designation_name ASC"
    );
  }

  /**
   * The shift selector's options: Shift Management's own ACTIVE shifts.
   *
   * The dashboard's shift filter is these rows and nothing else - no
   * hardcoded Morning/General/Night list - so whatever Shift Management
   * currently defines (9-9, 10-10, 2-10 or anything added later) is what the
   * selector offers, and this screen can never introduce a shift.
   */
  async listActiveWorkShifts() {
    return this._read(
      "LIST-ACTIVE-WORK-SHIFTS",
      `SELECT work_shift_id, shift_code, shift_name
         FROM work_shift
        WHERE active = 1
        ORDER BY shift_code ASC, shift_name ASC`
    );
  }
}

module.exports = (db) => new AttendanceDashboardRepository(db);
module.exports.AttendanceDashboardRepository = AttendanceDashboardRepository;
