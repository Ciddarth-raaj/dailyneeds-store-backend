const logger = require("../utils/logger");
const { accessScope } = require("./employee_scope");
const {
  queryAsync,
  getConnectionAsync,
  beginTransactionAsync,
  commitAsync,
  rollbackAsync,
} = require("../utils/batchInsert");

/**
 * Employee -> Work Shift, the NEW manual mapping.
 *
 * ONE COLUMN. Everything here reads or writes `new_employee.default_work_shift_id`
 * and nothing else on the employee row. `shift_id` and `shift_code` - the
 * legacy pair that the live system and the nightly Digisme sync still use -
 * appear nowhere in this file, in a SELECT or an UPDATE, and a test asserts
 * that. The two mappings coexist on purpose; this one never writes the other.
 *
 * NOTHING HERE INFERS AN ASSIGNMENT. There is no matching on shift code, on
 * shift name, on times, or on anything from Digisme. An employee's work shift
 * is NULL until a person chooses one on the assignment screen.
 *
 * POPULATION. The list follows the precedent `repository/employee_scope.js`
 * sets for everything built after the HR directory: `accessScope` - shared, so
 * a future per-actor restriction reaches this screen too - plus an EXPLICIT
 * status filter. It deliberately does NOT inherit the directory's
 * `resignation`-name exclusion, which that module records as legacy debt and
 * keeps to the directory screen; a screen with its own Active/Inactive/All
 * control must not also be silently hiding people by name.
 *
 * NO `SELECT *`. Every column is named, and the list is the seven fields the
 * assignment screen shows plus the ids it needs. No salary, no bank, no
 * Aadhaar, no contact details: choosing somebody's shift is not a reason to
 * read their record.
 */

/** Assignment status is a property of the mapping, not of the employee. */
const ASSIGNMENT_STATUS = { ALL: "ALL", ASSIGNED: "ASSIGNED", UNASSIGNED: "UNASSIGNED" };

/** Mirrors `pages/hr/employees`: 1 is employed, anything else is not. */
const EMPLOYMENT_STATUS = { ACTIVE: "ACTIVE", INACTIVE: "INACTIVE", ALL: "ALL" };

class EmployeeWorkShiftRepository {
  constructor(db) {
    this.db = db;
  }

  _log(code, err, ref = {}) {
    logger.Log({
      level: logger.LEVEL.ERROR,
      component: "REPOSITORY.EMPLOYEE_WORK_SHIFT",
      code: `REPOSITORY.EMPLOYEE_WORK_SHIFT.${code}`,
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

  /**
   * The assignment screen's population, filtered on the server.
   *
   * Every filter is a bound parameter. The search is the one the HR employee
   * list already offers - id or name - and it is escaped for LIKE rather than
   * interpolated, so a name containing `%` searches for that character
   * instead of matching everything.
   */
  buildFilters(filters = {}) {
    const f = filters || {};
    const { conditions, params } = accessScope(f.actor || null);

    const employment = String(f.employment_status || EMPLOYMENT_STATUS.ACTIVE).toUpperCase();
    if (employment === EMPLOYMENT_STATUS.ACTIVE) {
      conditions.push("ne.status = 1");
    } else if (employment === EMPLOYMENT_STATUS.INACTIVE) {
      conditions.push("(ne.status IS NULL OR ne.status <> 1)");
    }

    if (Array.isArray(f.store_ids) && f.store_ids.length > 0) {
      conditions.push("ne.store_id IN (?)");
      params.push(f.store_ids);
    }
    if (Array.isArray(f.department_ids) && f.department_ids.length > 0) {
      conditions.push("ne.department_id IN (?)");
      params.push(f.department_ids);
    }
    if (Array.isArray(f.designation_ids) && f.designation_ids.length > 0) {
      conditions.push("ne.designation_id IN (?)");
      params.push(f.designation_ids);
    }

    const assignment = String(f.assignment_status || ASSIGNMENT_STATUS.ALL).toUpperCase();
    if (assignment === ASSIGNMENT_STATUS.ASSIGNED) {
      conditions.push("ne.default_work_shift_id IS NOT NULL");
    } else if (assignment === ASSIGNMENT_STATUS.UNASSIGNED) {
      conditions.push("ne.default_work_shift_id IS NULL");
    }

    const search = typeof f.search === "string" ? f.search.trim() : "";
    if (search) {
      // `\` escapes itself first, or escaping % and _ would double-escape.
      const escaped = search.replace(/([\\%_])/g, "\\$1");
      conditions.push("(ne.employee_name LIKE ? OR CAST(ne.employee_id AS CHAR) LIKE ?)");
      params.push(`%${escaped}%`, `%${escaped}%`);
    }

    return {
      where: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "",
      params,
    };
  }

  /**
   * The rows the assignment screen shows. `ws` is the NEW work shift master;
   * `shift_master` is not joined here at all.
   */
  async listForAssignment(filters = {}) {
    const { where, params } = this.buildFilters(filters);

    return this._read(
      "LIST-FOR-ASSIGNMENT",
      `SELECT ne.employee_id,
              ne.employee_name,
              ne.status,
              ne.store_id,
              o.outlet_name,
              ne.department_id,
              dep.department_name,
              ne.designation_id,
              d.designation_name,
              ne.default_work_shift_id,
              ws.shift_code   AS work_shift_code,
              ws.shift_name   AS work_shift_name,
              ws.active       AS work_shift_active
         FROM new_employee ne
         LEFT JOIN outlets     o   ON o.outlet_id = ne.store_id
         LEFT JOIN department  dep ON dep.department_id = ne.department_id
         LEFT JOIN designation d   ON d.designation_id = ne.designation_id
         LEFT JOIN work_shift  ws  ON ws.work_shift_id = ne.default_work_shift_id
         ${where}
        ORDER BY ne.employee_name ASC, ne.employee_id ASC`,
      params
    );
  }

  /**
   * ONE employee's current work shift, for the employee profile.
   *
   * The single-row form of `listForAssignment`'s `ws` join, and it reads the
   * SAME column - `new_employee.default_work_shift_id`. The legacy
   * `shift_id` / `shift_code` pair is not joined, selected or mentioned here,
   * so the profile cannot accidentally display the old shift master under a
   * new label.
   *
   * A null row means no such employee; a row with a null
   * `default_work_shift_id` means unassigned, which is a different fact and
   * has to stay distinguishable.
   */
  async getEmployeeWorkShift(employeeId) {
    const rows = await this._read(
      "GET-EMPLOYEE-WORK-SHIFT",
      `SELECT ne.employee_id,
              ne.default_work_shift_id,
              ws.shift_code   AS work_shift_code,
              ws.shift_name   AS work_shift_name,
              ws.active       AS work_shift_active
         FROM new_employee ne
         LEFT JOIN work_shift ws ON ws.work_shift_id = ne.default_work_shift_id
        WHERE ne.employee_id = ?`,
      [employeeId]
    );
    return rows && rows[0] ? rows[0] : null;
  }

  /**
   * The distinct working-day in/out times of a work shift.
   *
   * The schedule is per weekday, so "the timing" is not one pair in general -
   * a shift may well start later on a Saturday. This returns what is actually
   * configured and lets the caller decide how to say it; rest days are
   * excluded because a rest day has no times to show.
   */
  async getWorkShiftWorkingTimes(workShiftId) {
    return this._read(
      "GET-WORK-SHIFT-WORKING-TIMES",
      `SELECT DISTINCT in_time, out_time
         FROM work_shift_weekly_schedule
        WHERE work_shift_id = ?
          AND is_working_day = 1
          AND in_time IS NOT NULL
          AND out_time IS NOT NULL
        ORDER BY in_time, out_time`,
      [workShiftId]
    );
  }

  /**
   * M1. The active work shifts as a dropdown: id, code, name, plus the
   * distinct working in/out times so the option can say "9:00 - 18:00".
   * Configuration (grace, OT, cut-offs) is deliberately not selected: this
   * is offered to `employee_create` holders who may not see the master.
   */
  async listActiveWorkShiftOptions() {
    return this._read(
      "LIST-ACTIVE-WORK-SHIFT-OPTIONS",
      `SELECT ws.work_shift_id, ws.shift_code, ws.shift_name,
              s.in_time, s.out_time
         FROM work_shift ws
         LEFT JOIN work_shift_weekly_schedule s
           ON s.work_shift_id = ws.work_shift_id
          AND s.is_working_day = 1
          AND s.in_time IS NOT NULL
          AND s.out_time IS NOT NULL
        WHERE ws.active = 1
        ORDER BY ws.shift_code, ws.shift_name, s.in_time, s.out_time`
    );
  }

  /** The active work shift the caller is assigning to, or null. */
  async getActiveWorkShift(workShiftId) {
    const rows = await this._read(
      "GET-ACTIVE-WORK-SHIFT",
      `SELECT work_shift_id, shift_code, shift_name, active
         FROM work_shift
        WHERE work_shift_id = ?`,
      [workShiftId]
    );
    return rows && rows[0] ? rows[0] : null;
  }

  /** Which of `employeeIds` actually exist. Order and duplicates are the caller's problem. */
  async findExistingEmployeeIds(employeeIds) {
    if (!Array.isArray(employeeIds) || employeeIds.length === 0) return [];
    const rows = await this._read(
      "FIND-EXISTING-EMPLOYEE-IDS",
      "SELECT employee_id FROM new_employee WHERE employee_id IN (?)",
      [employeeIds]
    );
    return rows.map((row) => Number(row.employee_id));
  }

  /**
   * Assign one work shift to many employees, all or nothing.
   *
   * The UPDATE names ONE column. It cannot touch `shift_id` or `shift_code`,
   * and the work shift is re-read inside the transaction so a shift
   * deactivated between validation and write cannot slip through.
   *
   * `affectedRows` is how many rows matched, `changedRows` how many actually
   * changed - re-assigning somebody to the shift they already have is a
   * legitimate no-op, and the caller is told the difference rather than being
   * left to guess from one number.
   *
   * ATTENDANCE v2 / A0. The same transaction now also APPENDS one row per
   * employee to `employee_work_shift_assignment`, the dated history the
   * attendance engine resolves a past date against. Two things about that are
   * deliberate:
   *
   *   - It is an INSERT, never an UPDATE. History is appended, so what payroll
   *     believed on the day it ran survives a later correction.
   *   - `effective_from` is the date the assignment is MADE, supplied by the
   *     caller, and is never backdated here. Moving somebody to a new shift
   *     today must not rewrite yesterday's worked minutes; a genuine
   *     correction to the past is a separate, audited act.
   *
   * `default_work_shift_id` keeps being written exactly as before, so every
   * existing screen, the Biomax receiver's ingest-time derivation and the HR
   * assignment flow behave identically. The history is additional, not a
   * replacement.
   *
   * `options.effective_from` omitted means no history row is written at all -
   * which is what keeps this method's old two-argument form working for any
   * caller that has not been updated.
   */
  /**
   * The AUTHORIZED CORRECTION path for a historical shift assignment.
   *
   * Separate from `assignWorkShift` on purpose, and doing a genuinely
   * different thing: it appends ONE history row with an explicit, caller-
   * supplied `effective_from`, `source = 'CORRECTION'` and a mandatory note,
   * and it does NOT touch `new_employee.default_work_shift_id`. Correcting
   * what somebody was rostered on in September must not change what they are
   * rostered on today, and the ordinary assignment route must stay unable to
   * backdate anything.
   *
   * Append-only, like every other row in this table. The row it corrects is
   * left exactly as it was, so what payroll believed before the correction
   * survives it; the resolver picks the correction because, for an equal
   * `effective_from`, the greater assignment id wins.
   */
  async correctAssignment({ employeeId, workShiftId, effectiveFrom, note, createdBy }) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `INSERT INTO employee_work_shift_assignment
           (employee_id, work_shift_id, effective_from, source, note, created_by)
         VALUES (?, ?, ?, 'CORRECTION', ?, ?)`,
        [employeeId, workShiftId, effectiveFrom, note, createdBy === undefined ? null : createdBy],
        (err, result) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.EMPLOYEE_WORK_SHIFT",
              code: "REPOSITORY.EMPLOYEE_WORK_SHIFT.CORRECT-ASSIGNMENT",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve({
            code: 200,
            employee_work_shift_assignment_id: result ? result.insertId : null,
            employee_id: employeeId,
            work_shift_id: workShiftId,
            effective_from: effectiveFrom,
            source: "CORRECTION",
          });
        }
      );
    });
  }

  async assignWorkShift(employeeIds, workShiftId, options = {}) {
    const connection = await getConnectionAsync(this.db);
    try {
      await beginTransactionAsync(connection);

      const shiftRows = await queryAsync(
        connection,
        "SELECT work_shift_id, active FROM work_shift WHERE work_shift_id = ? FOR UPDATE",
        [workShiftId]
      );
      const shift = shiftRows && shiftRows[0];
      if (!shift) {
        await rollbackAsync(connection);
        return { code: 404, msg: "Work shift not found" };
      }
      if (!Number(shift.active)) {
        await rollbackAsync(connection);
        return { code: 422, msg: "That work shift is inactive and cannot be assigned" };
      }

      const result = await queryAsync(
        connection,
        "UPDATE new_employee SET default_work_shift_id = ? WHERE employee_id IN (?)",
        [workShiftId, employeeIds]
      );

      if (options.effective_from) {
        await queryAsync(
          connection,
          `INSERT INTO employee_work_shift_assignment
             (employee_id, work_shift_id, effective_from, source, note, created_by)
           VALUES ?`,
          [
            employeeIds.map((employeeId) => [
              employeeId,
              workShiftId,
              options.effective_from,
              employeeIds.length > 1 ? "BULK_ASSIGNMENT" : "ASSIGNMENT",
              options.note || null,
              options.created_by === undefined ? null : options.created_by,
            ]),
          ]
        );
      }

      await commitAsync(connection);
      return {
        code: 200,
        work_shift_id: Number(workShiftId),
        requested: employeeIds.length,
        matched: result ? Number(result.affectedRows) : 0,
        updated: result ? Number(result.changedRows) : 0,
        effective_from: options.effective_from || null,
      };
    } catch (err) {
      await rollbackAsync(connection);
      this._log("ASSIGN-WORK-SHIFT", err);
      throw err;
    } finally {
      connection.release();
    }
  }
}

module.exports = (db) => new EmployeeWorkShiftRepository(db);
module.exports.EmployeeWorkShiftRepository = EmployeeWorkShiftRepository;
module.exports.ASSIGNMENT_STATUS = ASSIGNMENT_STATUS;
module.exports.EMPLOYMENT_STATUS = EMPLOYMENT_STATUS;
