const logger = require("../utils/logger");
const { JOINED_ON } = require("../utils/joining_date");

/**
 * SHIFT CHANGE ELIGIBILITY REPORT - the reads this report needs of its own.
 *
 * THERE ARE TWO, AND NEITHER TOUCHES ATTENDANCE.
 *
 *   listCandidateEmployees   the POPULATION - everybody whose employment
 *                            overlaps the window, filters and LOCATION SCOPE
 *                            applied in SQL, carrying the dated facts so the
 *                            shared eligibility rule can decide PER DATE.
 *   listShiftChangeRequests  the employee/date -> SHIFT_CHANGE request map,
 *                            in ONE statement for the whole population.
 *
 * NO WRITE STATEMENT EXISTS IN THIS FILE. There is no INSERT, no UPDATE, no
 * DELETE and no stored procedure call, so opening or exporting this report
 * cannot alter an attendance row, a shift assignment, a request or a payroll
 * lock even by accident. The report is read-only by construction rather than
 * by discipline.
 *
 * PUNCHES, DATED SHIFT ASSIGNMENTS, SHIFT CONFIGURATION VERSIONS, APPROVED
 * REGULARIZATIONS AND THE STORED CALCULATION ARE NOT RE-READ HERE. They come
 * from `repository/attendance_dashboard.js`, whose batch reads the usecase
 * reuses unchanged - the same decision `repository/attendance_missing.js`
 * records at length. A second set of attendance statements is exactly how a
 * report ends up disagreeing with the screen it claims to summarise.
 *
 * THE REQUEST STATUS IS NOT DERIVED, IT IS READ. `attendance_approval_request`
 * is the workflow's own table and `status` is the workflow's own column; this
 * file selects it and nothing here recomputes what an approval chain came to.
 *
 * NO `SELECT *`. Every column is named. Every date leaves as TEXT through
 * DATE_FORMAT - the API pool sets no `dateStrings`, so a bare DATE would
 * arrive as a JS Date built at local midnight and every bound would move a
 * day in IST.
 */

/**
 * The location predicate, IDENTICAL in meaning to the dashboard's and to
 * Missing Attendance's.
 *
 *   null   no restriction - the caller is authorized company-wide
 *   [1,2]  exactly these locations
 *   []     NO locations at all -> `1 = 0`, no rows
 *
 * The empty case is the one that matters: an empty authorized set is the
 * ORDINARY result of a branch manager asking for a branch they may not see,
 * and a missing clause there would serve them everything.
 */
function locationPredicate(column, store_ids) {
  if (store_ids === null || store_ids === undefined) return { clause: null, params: [] };
  if (!Array.isArray(store_ids) || store_ids.length === 0) {
    return { clause: "1 = 0", params: [] };
  }
  return { clause: `${column} IN (?)`, params: [store_ids] };
}

class AttendanceShiftChangeReportRepository {
  constructor(db) {
    this.db = db;
  }

  _log(code, err, ref = {}) {
    logger.Log({
      level: logger.LEVEL.ERROR,
      component: "REPOSITORY.ATTENDANCE_SHIFT_CHANGE_REPORT",
      code: `REPOSITORY.ATTENDANCE_SHIFT_CHANGE_REPORT.${code}`,
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

  /* ----------------------------------------------------- the population */

  /**
   * Everybody who COULD appear on this report somewhere in `[from, to]`.
   *
   * THIS SQL IS A PREFILTER, NOT THE RULE - the same division Missing
   * Attendance makes, for the same reason. Whether a particular DATE is
   * raisable is `utils/shift_change_eligibility.js#decide`, applied per date
   * in the usecase over facts a range query cannot express; what the SQL does
   * is avoid loading the whole company to ask about a fortnight.
   *
   * `status` IS NOT CONSULTED, matching the dashboard and Missing Attendance:
   * `new_employee.status` is maintained by hand and sits at 1 for most
   * leavers, so reading it would put people who left years ago back on the
   * report. Only `resignation_date` and the parsed joining date decide.
   *
   * THE DESIGNATION FILTER IS HERE and the shift filter is deliberately NOT.
   * `ne.designation_id` is the employee's designation and does not vary by
   * attendance date, so filtering it in SQL answers exactly the question HR
   * asked. A shift, by contrast, is DATED - resolved per date from the
   * assignment history and any override - and `new_employee.shift_id` is only
   * the current default, so filtering on it would quietly answer a different
   * question and drop precisely the rows where the assignment has changed.
   */
  async listCandidateEmployees({
    from_date,
    to_date,
    store_ids = null,
    designation_id = null,
    employee_id = null,
    search = null,
  }) {
    const where = [
      "COALESCE(ne.attendance_required, 1) = 1",
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
    if (employee_id) {
      where.push("ne.employee_id = ?");
      params.push(employee_id);
    }
    if (search) {
      // A FILTER, NEVER AN AUTHORIZATION: it narrows an already scoped list
      // and cannot widen one. Escaped for LIKE so a `%` typed by a person is
      // a literal percent sign.
      const like = `%${String(search).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      where.push("(ne.employee_name LIKE ? OR CAST(ne.employee_id AS CHAR) LIKE ?)");
      params.push(like, like);
    }

    return this._read(
      "LIST-CANDIDATE-EMPLOYEES",
      `SELECT ne.employee_id, ne.employee_name, ne.store_id,
              ne.designation_id, ne.department_id,
              ne.special_break_override_minutes,
              ne.extra_break_hours,
              ne.attendance_required,
              ne.works_all_locations,
              o.outlet_name, o.outlet_nickname,
              d.designation_name,
              dept.department_name,
              DATE_FORMAT((${JOINED_ON("ne")}), '%Y-%m-%d') AS joined_on,
              DATE_FORMAT(ne.resignation_date, '%Y-%m-%d')  AS resignation_date
         FROM new_employee ne
         LEFT JOIN outlets o      ON o.outlet_id = ne.store_id
         LEFT JOIN designation d  ON d.designation_id = ne.designation_id
         LEFT JOIN department dept ON dept.department_id = ne.department_id
        WHERE ${where.join(" AND ")}
        ORDER BY ne.employee_id ASC`,
      params
    );
  }

  /* ------------------------------------------- the shift change requests */

  /**
   * Every SHIFT_CHANGE request for this population over this window, in ONE
   * statement.
   *
   * WHY ONE STATEMENT AND NOT ONE PER ROW. A date-range report over a
   * multi-outlet population is thousands of (employee, date) pairs, and
   * asking the request table once per pair is the N+1 this report must not
   * have. `IN (?)` over the population with a BETWEEN on the date uses
   * `idx_aareq_employee_date` - the same index the approval queue reads by -
   * and the usecase indexes the result in memory.
   *
   * CANCELLED IS EXCLUDED, exactly as the dashboard's own approval read
   * excludes it: a cancelled request is not a request anybody is waiting on,
   * and it must not stop the report showing a date as Not Raised when the
   * employee may raise one. PENDING, APPROVED and REJECTED all come back, and
   * the usecase reports the workflow's own word for each.
   *
   * ORDERED SO THE LAST ROW WINS DETERMINISTICALLY. There should be at most
   * one live request per employee/date - the unique key says so - but a
   * REJECTED one may legitimately be followed by a fresh attempt, and the
   * report must show the CURRENT one rather than whichever the database
   * happened to hand back first.
   */
  async listShiftChangeRequests({ employee_ids, from_date, to_date }) {
    if (!Array.isArray(employee_ids) || employee_ids.length === 0) return [];
    return this._read(
      "LIST-SHIFT-CHANGE-REQUESTS",
      `SELECT attendance_approval_request_id,
              requested_for_employee_id AS employee_id,
              DATE_FORMAT(attendance_date, '%Y-%m-%d') AS attendance_date,
              status, current_stage_no, total_stages,
              requested_work_shift_id, base_work_shift_id,
              DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_at
         FROM attendance_approval_request
        WHERE requested_for_employee_id IN (?)
          AND attendance_date BETWEEN ? AND ?
          AND request_type = 'SHIFT_CHANGE'
          AND status <> 'CANCELLED'
        ORDER BY employee_id ASC, attendance_date ASC, attendance_approval_request_id ASC`,
      [employee_ids, from_date, to_date]
    );
  }
}

module.exports = (db) => new AttendanceShiftChangeReportRepository(db);
module.exports.AttendanceShiftChangeReportRepository = AttendanceShiftChangeReportRepository;
module.exports.locationPredicate = locationPredicate;
