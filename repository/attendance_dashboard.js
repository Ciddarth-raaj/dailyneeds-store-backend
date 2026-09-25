const logger = require("../utils/logger");
const { JOINED_ON } = require("../utils/joining_date");
const {
  EFFECTIVE_TIME_JOIN,
  EFFECTIVE_IO_TIME,
  CORRECTION_COLUMNS,
} = require("./lib/effective_punch_time");

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
/**
 * THE LOCATION PREDICATE, and the fail-open this exists to prevent.
 *
 * `store_ids` arrives in three states and they are three different questions:
 *
 *   null   no location restriction - the caller is authorized company-wide
 *   [1,2]  exactly these locations
 *   []     NO locations at all
 *
 * The bug this replaces was `if (Array.isArray(store_ids) && store_ids.length > 0)`,
 * which is correct for the first two and catastrophically wrong for the third:
 * an EMPTY authorized set fell through the `if` and produced a query with no
 * location clause, so a caller authorized for nothing was served everything.
 * An empty intersection is the normal result of asking for a branch you may
 * not see, so this was reachable by ordinary use rather than by attack.
 *
 * Hence: `[]` yields `1 = 0`. It returns no rows, in SQL, rather than relying
 * on every caller to remember to check first. The usecase short-circuits as
 * well; this is the backstop that makes a forgotten check harmless.
 *
 * @returns {{clause: string, params: Array}} always a usable WHERE fragment
 */
function locationPredicate(column, store_ids) {
  if (store_ids === null || store_ids === undefined) return { clause: null, params: [] };
  if (!Array.isArray(store_ids) || store_ids.length === 0) {
    return { clause: "1 = 0", params: [] };
  }
  return { clause: `${column} IN (?)`, params: [store_ids] };
}

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

    const scope = locationPredicate("ne.store_id", store_ids);
    if (scope.clause) {
      where.push(scope.clause);
      params.push(...scope.params);
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
              ne.extra_break_hours,
              ne.attendance_required,
              ne.works_all_locations,
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

  /**
   * The employees who could be applicable ANYWHERE in a date RANGE, each
   * carrying the two dated facts so applicability can be decided PER DATE in
   * memory.
   *
   * WHY THIS EXISTS SEPARATELY FROM THE SINGLE-DATE READ. The trend used to
   * take the population applicable on the SELECTED date and reuse it for the
   * thirteen days before it. That is wrong in both directions: somebody who
   * joined mid-window was counted as applicable on days before they worked
   * here (inflating the denominator and inventing absences), and somebody who
   * worked the first half of the window and resigned before the selected date
   * was missing from the days they actually worked.
   *
   * So the candidate set is everybody whose employment OVERLAPS the window at
   * all, and `joined_on` / `resignation_date` come back with them. The usecase
   * applies the SAME rule per date that the single-date query applies in SQL,
   * which is what makes the trend and the overview agree for a shared date.
   *
   * `joined_on` is the parsed DATE, through `JOINED_ON` - the one parser the
   * lifecycle backfill and payroll already share - rather than the raw VARCHAR,
   * so the usecase never re-implements that parsing. NULL where the column is
   * absent or unreadable, which is most production rows; such an employee is
   * included and the usecase treats their start as unbounded, exactly as the
   * single-date query does.
   *
   * `employee_employment_period` is still NOT consulted, for the reason the
   * calculation repository gives: its backfill carries rows flagged
   * needs_review. That means a resign-then-rejoin GAP is not modelled here -
   * reported as a known limitation rather than papered over with a second,
   * less trustworthy source that would also make the trend disagree with the
   * overview.
   */
  async listApplicableEmployeesForRange({
    from_date,
    to_date,
    store_ids = null,
    designation_id = null,
    search = null,
  }) {
    const where = [
      // Employment overlaps the window: not resigned before it began, and not
      // joined after it ended.
      "(ne.resignation_date IS NULL OR ne.resignation_date >= ?)",
      `((${JOINED_ON("ne")}) IS NULL OR (${JOINED_ON("ne")}) <= ?)`,
    ];
    const params = [from_date, to_date];

    const scope = locationPredicate("ne.store_id", store_ids);
    if (scope.clause) {
      where.push(scope.clause);
      params.push(...scope.params);
    }
    if (designation_id) {
      where.push("ne.designation_id = ?");
      params.push(designation_id);
    }
    if (search) {
      const like = `%${String(search).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      where.push("(ne.employee_name LIKE ? OR CAST(ne.employee_id AS CHAR) LIKE ?)");
      params.push(like, like);
    }

    return this._read(
      "LIST-APPLICABLE-EMPLOYEES-FOR-RANGE",
      `SELECT ne.employee_id, ne.employee_name, ne.store_id, ne.designation_id,
              ne.special_break_override_minutes,
              ne.extra_break_hours,
              ne.attendance_required,
              ne.works_all_locations,
              o.outlet_name, o.outlet_nickname,
              d.designation_name,
              DATE_FORMAT((${JOINED_ON("ne")}), '%Y-%m-%d')      AS joined_on,
              DATE_FORMAT(ne.resignation_date, '%Y-%m-%d')       AS resignation_date
         FROM new_employee ne
         LEFT JOIN outlets o     ON o.outlet_id = ne.store_id
         LEFT JOIN designation d ON d.designation_id = ne.designation_id
        WHERE ${where.join(" AND ")}
        ORDER BY ne.employee_id ASC`,
      params
    );
  }


  /** Pulls bearing on delivery over a RANGE. Same rule as the single date. */
  async listHistoricalPullsForRange({ from_date, to_date, store_ids = null }) {
    const scope = locationPredicate("asg.outlet_id", store_ids);
    const params = [to_date, from_date, to_date, from_date];
    if (scope.params.length) params.push(...scope.params);
    return this._read(
      "LIST-OPEN-HISTORICAL-PULLS-FOR-RANGE",
      `SELECT hp.biomax_historical_pull_id, hp.biomax_device_id, hp.dev_id, hp.status,
              DATE_FORMAT(hp.requested_from, '%Y-%m-%d %H:%i:%s') AS requested_from,
              DATE_FORMAT(hp.requested_to,   '%Y-%m-%d %H:%i:%s') AS requested_to,
              asg.outlet_id
         FROM biomax_historical_pull hp
         LEFT JOIN biomax_device_assignment asg
                ON asg.biomax_device_id = hp.biomax_device_id
               AND asg.effective_from <= TIMESTAMP(?, '23:59:59')
               AND (asg.effective_to IS NULL OR asg.effective_to > TIMESTAMP(?, '00:00:00'))
        WHERE hp.status <> 'COMPLETED'
          AND hp.requested_from <= TIMESTAMP(?, '23:59:59')
          AND hp.requested_to   >= TIMESTAMP(?, '00:00:00')
          ${scope.clause ? `AND ${scope.clause}` : ""}
        ORDER BY hp.biomax_historical_pull_id ASC`,
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
  /**
   * THE STORED CALCULATIONS for a population over a window, in one read.
   *
   * The dashboard must not answer a settled historical date differently from
   * the employee's own screen, so it reads the same rows that screen reads -
   * batched, because the dashboard asks for a population and a per-employee
   * query would be one round trip each. `utils/attendance_stored_read.js`
   * decides what is DONE with them; this only fetches.
   */
  async getStoredCalculationsForEmployees(employeeIds, fromDate, toDate) {
    if (!Array.isArray(employeeIds) || employeeIds.length === 0) return [];
    return this._read(
      "GET-STORED-CALCULATIONS-BULK",
      `SELECT c.*, DATE_FORMAT(c.attendance_date, '%Y-%m-%d') AS attendance_date
         FROM attendance_day_calculation c
        WHERE c.employee_id IN (?)
          AND c.attendance_date BETWEEN ? AND ?`,
      [employeeIds, fromDate, toDate]
    );
  }

  async getRawPunchesForEmployees(employeeIds, fromCalendarDate, toCalendarDate) {
    if (!Array.isArray(employeeIds) || employeeIds.length === 0) return [];
    return this._read(
      "GET-RAW-PUNCHES-BULK",
      `SELECT p.biomax_punch_id                            AS punch_id,
              d.employee_id,
              DATE_FORMAT(p.punch_date, '%Y-%m-%d')        AS punch_date,
              DATE_FORMAT(d.attendance_date, '%Y-%m-%d')   AS ingest_attendance_date,
              DATE_FORMAT(${EFFECTIVE_IO_TIME}, '%Y-%m-%d %H:%i:%s') AS io_time,
              ${CORRECTION_COLUMNS},
              p.dev_id,
              p.ingest_source,
              v.attendance_punch_void_id,
              v.reason                                     AS void_reason
         FROM biomax_punch_derived d
         JOIN biomax_punch p ON p.biomax_punch_id = d.biomax_punch_id
         ${EFFECTIVE_TIME_JOIN}
         LEFT JOIN attendance_punch_void v ON v.biomax_punch_id = p.biomax_punch_id
        WHERE d.employee_id IN (?)
          AND p.punch_date BETWEEN ? AND ?
        ORDER BY d.employee_id ASC, ${EFFECTIVE_IO_TIME} ASC, p.biomax_punch_id ASC`,
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
  /**
   * Specific punches BY ID, with the terminal and its punch location.
   *
   * The ids come from the attendance engine's own dating of an attendance
   * date, so membership of the day is already decided by the shift's cutoff
   * rule before this runs. That is the whole reason this reads by id rather
   * than by a timestamp range: a `BETWEEN midnight AND midnight` filter would
   * quietly disagree with the engine for every overnight shift.
   */
  async listPunchesByIds(punchIds) {
    if (!Array.isArray(punchIds) || punchIds.length === 0) return [];
    return this._read(
      "LIST-PUNCHES-BY-IDS",
      `SELECT p.biomax_punch_id AS punch_id,
              d.employee_id,
              ne.employee_name,
              DATE_FORMAT(${EFFECTIVE_IO_TIME}, '%Y-%m-%d %H:%i:%s') AS io_time,
              ${CORRECTION_COLUMNS},
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
         ${EFFECTIVE_TIME_JOIN}
         LEFT JOIN attendance_punch_void v ON v.biomax_punch_id = p.biomax_punch_id
        WHERE p.biomax_punch_id IN (?)
        ORDER BY p.received_at DESC, p.biomax_punch_id DESC`,
      [punchIds]
    );
  }

  /**
   * WHO THE SYSTEM ITSELF NAMES as the approver of each waiting request.
   *
   * The UNDECIDED step of a PENDING request, which is the one somebody actually
   * has to act on - not the employee's configured chain, which is only the
   * template a request was built from and may name somebody who has already
   * decided. `created_at` comes from the request so the age shown beside an item
   * is the age of the request, not of the step.
   *
   * A request with no `approver_employee_id` on its pending step - a ROLE-based
   * step - yields no name, and the caller shows none rather than guessing one.
   */
  async listPendingApproversForRequests(requestIds) {
    if (!Array.isArray(requestIds) || requestIds.length === 0) return [];
    return this._read(
      "LIST-PENDING-APPROVERS",
      `SELECT r.attendance_approval_request_id,
              r.request_type,
              r.current_stage_no,
              r.total_stages,
              DATE_FORMAT(r.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
              s.stage_no,
              s.approver_role,
              s.approver_employee_id,
              a.employee_name AS approver_name
         FROM attendance_approval_request r
         LEFT JOIN attendance_approval_step s
                ON s.attendance_approval_request_id = r.attendance_approval_request_id
               AND s.decision = 'PENDING'
               AND s.stage_no = r.current_stage_no
         LEFT JOIN new_employee a ON a.employee_id = s.approver_employee_id
        WHERE r.attendance_approval_request_id IN (?)
          AND r.status = 'PENDING'
        ORDER BY r.attendance_approval_request_id ASC`,
      [requestIds]
    );
  }

  async listRecentPunches({ limit = 25, store_ids = null }) {
    const where = [];
    const params = [];
    // Both the PUNCH location (where the terminal was) and the employee's home
    // outlet are scoped: a punch is in scope only if one of the two is, and
    // with an empty authorized set neither can be.
    if (store_ids === null || store_ids === undefined) {
      // company-wide: no location clause
    } else if (!Array.isArray(store_ids) || store_ids.length === 0) {
      where.push("1 = 0");
    } else {
      where.push("(asg.outlet_id IN (?) OR ne.store_id IN (?))");
      params.push(store_ids, store_ids);
    }
    params.push(Math.max(1, Math.min(200, Math.trunc(Number(limit) || 25))));
    return this._read(
      "LIST-RECENT-PUNCHES",
      `SELECT p.biomax_punch_id AS punch_id,
              d.employee_id,
              ne.employee_name,
              DATE_FORMAT(${EFFECTIVE_IO_TIME}, '%Y-%m-%d %H:%i:%s') AS io_time,
              ${CORRECTION_COLUMNS},
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
         ${EFFECTIVE_TIME_JOIN}
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
    const scope = locationPredicate("asg.outlet_id", store_ids);
    if (scope.clause) {
      where.push(scope.clause);
      params.push(...scope.params);
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

  /* ------------------------------------------- delivery completeness */


  /**
   * Historical pulls covering this attendance date that bear on delivery -
   * the ones still running AND the ones that FAILED.
   *
   * FAILED IS INCLUDED, and that is the correction. The previous version
   * excluded it alongside COMPLETED, so a pull that died halfway looked
   * exactly like one that had never been needed. A pull that stopped is not a
   * pull that succeeded.
   *
   * COMPLETED is excluded because nothing ever sets it: `biomax/store.js`
   * states in its own header that its protocol semantics are unproven, and
   * only FAILED is ever written. A row can therefore sit in RECEIVING
   * indefinitely, which is exactly the uncertainty the caller must report.
   *
   * `requested_from`/`requested_to` are IST wall clock and inclusive, so the
   * overlap test is against the whole calendar day.
   */
  async listHistoricalPullsForDate({ attendance_date, store_ids = null }) {
    const scope = locationPredicate("asg.outlet_id", store_ids);
    const params = [attendance_date, attendance_date, attendance_date, attendance_date];
    if (scope.params.length) params.push(...scope.params);
    return this._read(
      "LIST-OPEN-HISTORICAL-PULLS-FOR-DATE",
      `SELECT hp.biomax_historical_pull_id, hp.biomax_device_id, hp.dev_id, hp.status,
              DATE_FORMAT(hp.requested_from, '%Y-%m-%d %H:%i:%s') AS requested_from,
              DATE_FORMAT(hp.requested_to,   '%Y-%m-%d %H:%i:%s') AS requested_to,
              asg.outlet_id
         FROM biomax_historical_pull hp
         LEFT JOIN biomax_device_assignment asg
                ON asg.biomax_device_id = hp.biomax_device_id
               AND asg.effective_from <= TIMESTAMP(?, '23:59:59')
               AND (asg.effective_to IS NULL OR asg.effective_to > TIMESTAMP(?, '23:59:59'))
        WHERE hp.status <> 'COMPLETED'
          AND hp.requested_from <= TIMESTAMP(?, '23:59:59')
          AND hp.requested_to   >= TIMESTAMP(?, '00:00:00')
          ${scope.clause ? `AND ${scope.clause}` : ""}
        ORDER BY hp.biomax_historical_pull_id ASC`,
      params
    );
  }

  /* ------------------------------------------------------- master data */

  /**
   * The outlets the caller may read.
   *
   * SCOPED LIKE EVERYTHING ELSE. A selector is a read of master data, and an
   * unscoped one would let the filter bar enumerate every branch in the
   * company to somebody authorized for two of them - and offer them branches
   * whose counts the other endpoints would then refuse.
   */
  async listOutlets({ store_ids = null } = {}) {
    const scope = locationPredicate("outlet_id", store_ids);
    return this._read(
      "LIST-OUTLETS",
      `SELECT outlet_id, outlet_name, outlet_nickname
         FROM outlets
        ${scope.clause ? `WHERE ${scope.clause}` : ""}
        ORDER BY outlet_name ASC`,
      scope.params
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
module.exports.locationPredicate = locationPredicate;
