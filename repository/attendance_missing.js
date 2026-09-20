const logger = require("../utils/logger");
const { JOINED_ON } = require("../utils/joining_date");

/**
 * Missing Attendance - the two reads this feature needs of its own, and the
 * one table it owns.
 *
 * IT DOES NOT RE-READ ATTENDANCE. Punches, dated shift assignments, shift
 * configuration versions, approved regularizations, approval state and the
 * stored calculation all come from `repository/attendance_dashboard.js`,
 * whose batch reads the usecase reuses unchanged. A second set of attendance
 * statements is exactly how a report ends up disagreeing with the screen it
 * claims to summarise, so there is none here.
 *
 * WHAT IS HERE:
 *
 *   listCandidateEmployees   the POPULATION - everybody whose employment
 *                            overlaps the window, with the filters applied,
 *                            carrying the dated facts so the shared
 *                            eligibility rule can decide PER DATE in memory.
 *   the notification table   `attendance_missing_notification`, which exists
 *                            so the 06:00 Telegram job cannot message the
 *                            same person twice about the same date.
 *
 * NO `SELECT *`. Every column is named. Every date leaves as TEXT through
 * DATE_FORMAT - the API pool sets no `dateStrings`, so a bare DATE would
 * arrive as a JS Date built at local midnight and every bound would move a
 * day in IST.
 */

/**
 * The location predicate, IDENTICAL in meaning to the dashboard's.
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

class AttendanceMissingRepository {
  constructor(db) {
    this.db = db;
  }

  _log(code, err, ref = {}) {
    logger.Log({
      level: logger.LEVEL.ERROR,
      component: "REPOSITORY.ATTENDANCE_MISSING",
      code: `REPOSITORY.ATTENDANCE_MISSING.${code}`,
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
   * Everybody who COULD be missing attendance somewhere in `[from, to]`.
   *
   * THIS SQL IS A PREFILTER, NOT THE RULE. The authoritative decision is
   * `utils/attendance_eligibility.js#eligibleOn`, applied per date in the
   * usecase - which is what stops a leaver being reported for dates after
   * they left and a joiner for dates before they arrived, both of which a
   * range query cannot express. What the SQL does is avoid loading the whole
   * company to ask about a fortnight: it keeps anybody whose employment
   * OVERLAPS the window at all, and hands the dated facts along so the rule
   * can be applied honestly afterwards.
   *
   * `attendance_required` IS FILTERED HERE AS WELL as in the rule. An exempt
   * employee cannot be missing attendance on any date, so there is no window
   * for which loading them is useful - and `COALESCE(..., 1) = 1` reads an
   * absent value as REQUIRED, exactly as the JS helper does, so "the column
   * was not selected" can never silently exempt anybody.
   *
   * `status` IS NOT CONSULTED, matching the rule and the dashboard for the
   * reason both record at length: `new_employee.status` is maintained by hand
   * and sits at 1 for most leavers, so reading it would put people who left
   * years ago back into today's chasing list - which is precisely the
   * "old employees treated as currently working" fault this report must not
   * reintroduce. Only `resignation_date` and the parsed joining date decide.
   *
   * `date_of_joining` goes through `JOINED_ON`, the one shared parser. An
   * absent or unreadable joining date is UNBOUNDED on that side and the row
   * is INCLUDED, exactly as the helper treats it.
   *
   * THE SHIFT FILTER IS NOT HERE, DELIBERATELY. `new_employee.shift_id` is
   * the employee's CURRENT default; the report filters on the shift that was
   * DATED to each attendance date, resolved from the assignment history and
   * any date override. Filtering on the master column here would quietly
   * answer a different question - and would drop exactly the rows where the
   * assignment has since changed, which are the interesting ones.
   */
  async listCandidateEmployees({
    from_date,
    to_date,
    store_ids = null,
    department_id = null,
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
    if (department_id) {
      where.push("ne.department_id = ?");
      params.push(department_id);
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

  /* --------------------------------------------- the notification ledger */

  /**
   * The employee's ACTIVE private chat with the bot, for the dates being
   * notified.
   *
   * ONE SOURCE, AND IT IS THE EXISTING ONE. `employee_telegram_identity` is
   * Phase 2's verified employee-to-Telegram mapping, with `private_chat_id`
   * being the 1:1 chat. Nothing new is invented here and no second mapping
   * exists: an employee with no active identity simply has no chat, and the
   * job SKIPS them with that reason recorded rather than guessing at a
   * username or falling back to a group.
   *
   * `disconnected_at IS NULL` is the whole of "active" - the table keeps
   * history and a disconnected row is somebody's OLD account, which must
   * never receive their attendance.
   */
  async getActiveTelegramChats(employeeIds) {
    if (!Array.isArray(employeeIds) || employeeIds.length === 0) return [];
    return this._read(
      "GET-ACTIVE-TELEGRAM-CHATS",
      `SELECT employee_id, telegram_user_id, private_chat_id
         FROM employee_telegram_identity
        WHERE employee_id IN (?)
          AND disconnected_at IS NULL`,
      [employeeIds]
    );
  }

  /** What has already been decided for these employees on this date. */
  async listNotificationsForDate(attendanceDate, employeeIds) {
    if (!Array.isArray(employeeIds) || employeeIds.length === 0) return [];
    return this._read(
      "LIST-NOTIFICATIONS-FOR-DATE",
      `SELECT attendance_missing_notification_id, employee_id,
              DATE_FORMAT(attendance_date, '%Y-%m-%d') AS attendance_date,
              punch_count, status, failure_reason, telegram_chat_id,
              DATE_FORMAT(sent_at, '%Y-%m-%d %H:%i:%s') AS sent_at
         FROM attendance_missing_notification
        WHERE attendance_date = ?
          AND employee_id IN (?)`,
      [attendanceDate, employeeIds]
    );
  }

  /**
   * CLAIM one (employee, date) before anything is sent.
   *
   * THIS IS THE DUPLICATE GUARD, AND IT IS THE DATABASE'S, NOT THE CODE'S.
   * `uq_amn_employee_date` is UNIQUE on (employee_id, attendance_date), so
   * the INSERT below is the claim: whoever inserts first owns the send, and a
   * second run - a scheduler retry, two app instances, a human re-triggering
   * the job - inserts zero rows and is told so by `affectedRows`. A read of
   * "has this been sent?" followed by a send is a time-of-check to
   * time-of-use race, and the thing it races on is somebody's phone.
   *
   * `IGNORE` is scoped to that: the row is claimed or it is not, and the
   * caller branches on the count rather than on an exception.
   *
   * The row is claimed as PENDING and settled afterwards by `settle` below,
   * so a process that dies mid-send leaves a PENDING row - visible, and
   * honest about not knowing - rather than a SENT row for a message that
   * never left or no row at all for one that did.
   */
  async claim({ employee_id, attendance_date, punch_count, telegram_chat_id = null }) {
    const result = await this._read(
      "CLAIM-NOTIFICATION",
      `INSERT IGNORE INTO attendance_missing_notification
         (employee_id, attendance_date, punch_count, status, telegram_chat_id, created_at)
       VALUES (?, ?, ?, 'PENDING', ?, NOW())`,
      [employee_id, attendance_date, punch_count, telegram_chat_id]
    );
    const affected = result && result.affectedRows !== undefined ? Number(result.affectedRows) : 0;
    return { claimed: affected > 0, insert_id: result ? result.insertId || null : null };
  }

  /**
   * Record how the claimed send actually went: SENT, FAILED or SKIPPED.
   *
   * `failure_reason` is a short code this code produced, never the raw
   * Telegram error text - an error body can carry a chat id or a token
   * fragment, and a ledger is a poor place to keep either.
   */
  async settle({ employee_id, attendance_date, status, failure_reason = null, telegram_chat_id = null }) {
    return this._read(
      "SETTLE-NOTIFICATION",
      `UPDATE attendance_missing_notification
          SET status = ?,
              failure_reason = ?,
              telegram_chat_id = COALESCE(?, telegram_chat_id),
              sent_at = CASE WHEN ? = 'SENT' THEN NOW() ELSE sent_at END
        WHERE employee_id = ? AND attendance_date = ?`,
      [status, failure_reason, telegram_chat_id, status, employee_id, attendance_date]
    );
  }

  /**
   * Release a claim that produced no attempt at all, so a later run can try.
   *
   * Used ONLY where nothing was sent and nothing could have been - the bot is
   * not configured, or the batch was aborted before this row's turn. A row
   * that reached Telegram is never released: "we do not know whether it
   * arrived" must not become "send it again".
   */
  async releaseClaim({ employee_id, attendance_date }) {
    return this._read(
      "RELEASE-CLAIM",
      `DELETE FROM attendance_missing_notification
        WHERE employee_id = ? AND attendance_date = ? AND status = 'PENDING'`,
      [employee_id, attendance_date]
    );
  }
}

module.exports = (db) => new AttendanceMissingRepository(db);
module.exports.AttendanceMissingRepository = AttendanceMissingRepository;
module.exports.locationPredicate = locationPredicate;
