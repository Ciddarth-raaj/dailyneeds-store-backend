const logger = require("../utils/logger");
const {
  queryAsync,
  getConnectionAsync,
  beginTransactionAsync,
  commitAsync,
  rollbackAsync,
} = require("../utils/batchInsert");
const { accessScope } = require("./employee_scope");

/**
 * Employee -> Work Shift, the manual mapping.
 *
 * This repository owns exactly one employee column, `default_work_shift_id`,
 * and reads `work_shift` to describe it. It is deliberately narrow:
 *
 *   * `shift_master` is owned by repository/shift.js and is never touched
 *     here - not read, not joined, not written.
 *   * `new_employee.shift_id` and `new_employee.shift_code` are never written
 *     here. There is no UPDATE in this file that names either column, which
 *     is what keeps the legacy shift system whole while this one is filled in.
 *   * nothing infers a mapping. No query in this file derives
 *     `default_work_shift_id` from a shift name, a shift time, `shift_code`
 *     or anything else; the only way a value gets in is HR choosing it.
 *
 * POPULATION. Active employees only - `new_employee.status = 1`, the
 * ACTIVE constant the employee master already uses. Two conventions existed
 * to choose between and this is the deliberate one:
 *
 *   * `status = 1` is what `/employee/filter` and the headcount already mean
 *     by "an employee", and it is the value the C2 lifecycle actually
 *     maintains.
 *   * the HR directory's rule - exclude anyone whose NAME appears in
 *     `resignation` - is NOT used. `employee_scope.js` records it as legacy
 *     debt keyed on a VARCHAR name (two employees sharing a name share the
 *     exclusion, renaming somebody detaches it) and says in terms that new
 *     consumers must not inherit it.
 *
 * Someone who has left therefore drops off this screen, which is right: you
 * do not roster them. Their stored `default_work_shift_id` is left exactly as
 * it was rather than cleared, so rejoining restores the mapping.
 *
 * `accessScope` is composed even though it is empty today. That is the seam
 * where a per-actor outlet restriction belongs, and composing it here means
 * this screen picks one up at the same moment the directory and Reports do,
 * rather than being the one place somebody forgets.
 */

/** The canonical employee status values, as used by the employee master. */
const STATUS = { ACTIVE: 1 };

/** Assignment-status filter values, matching the frontend's three options. */
const ASSIGNMENT_STATUS = {
  ALL: "ALL",
  ASSIGNED: "ASSIGNED",
  UNASSIGNED: "UNASSIGNED",
};

/**
 * Every column this screen returns, named explicitly.
 *
 * No `SELECT *`. `new_employee` carries salary, bank account, IFSC, PAN, UAN,
 * ESI/PF numbers, addresses and contact numbers, and a shift-assignment
 * screen has no business reading any of them - a wildcard here would put all
 * of it on the wire behind `view_employees`, which is not the permission that
 * guards bank or sensitive data. The list below is the whole contract, and it
 * is identity plus the four things the table shows.
 */
const EMPLOYEE_COLUMNS = `
        new_employee.employee_id,
        new_employee.employee_name,
        new_employee.store_id,
        outlets.outlet_name,
        new_employee.department_id,
        department.department_name,
        new_employee.designation_id,
        designation.designation_name,
        new_employee.default_work_shift_id,
        work_shift.shift_code AS work_shift_code,
        work_shift.shift_name AS work_shift_name,
        work_shift.active AS work_shift_active`;

/** MySQL returns TINYINT(1) as 0/1; the API should say true/false. */
function presentEmployeeRow(row) {
  return {
    ...row,
    work_shift_active:
      row.work_shift_active === null || row.work_shift_active === undefined
        ? null
        : Boolean(row.work_shift_active),
  };
}

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

  /**
   * The employees the assignment screen lists, already filtered.
   *
   * Filtering is server-side because the alternative is shipping every
   * employee to the browser and narrowing there, which gets slower exactly as
   * HR works through the backlog. Every filter is a bound parameter - the
   * search term included, which is what `/employee/filter` interpolates
   * directly into its SQL and what is deliberately not copied here.
   *
   * @param {object} filters store_id, department_id, designation_id, search,
   *                         assignment_status
   * @param {object|null} actor the caller, for `accessScope`
   */
  getEmployeesForAssignment(filters = {}, actor = null) {
    const f = filters || {};

    const access = accessScope(actor);
    const conditions = [...access.conditions];
    const params = [...access.params];

    // Active employees only - see the population note at the top of the file.
    conditions.push("new_employee.status = ?");
    params.push(STATUS.ACTIVE);

    if (f.store_id !== undefined && f.store_id !== null && f.store_id !== "") {
      conditions.push("new_employee.store_id = ?");
      params.push(Number(f.store_id));
    }
    if (f.department_id !== undefined && f.department_id !== null && f.department_id !== "") {
      conditions.push("new_employee.department_id = ?");
      params.push(Number(f.department_id));
    }
    if (f.designation_id !== undefined && f.designation_id !== null && f.designation_id !== "") {
      conditions.push("new_employee.designation_id = ?");
      params.push(Number(f.designation_id));
    }

    // Employee id or name, as one box. `employee_id` is an INT, so it is cast
    // rather than LIKE'd directly - "10" should find employee 105.
    if (typeof f.search === "string" && f.search.trim() !== "") {
      const term = `%${f.search.trim()}%`;
      conditions.push(
        "(new_employee.employee_name LIKE ? OR CAST(new_employee.employee_id AS CHAR) LIKE ?)"
      );
      params.push(term, term);
    }

    // The filter that makes the initial backlog workable: HR needs to see who
    // is still unmapped without reading past everyone already done.
    const assignmentStatus = String(f.assignment_status || ASSIGNMENT_STATUS.ALL).toUpperCase();
    if (assignmentStatus === ASSIGNMENT_STATUS.ASSIGNED) {
      conditions.push("new_employee.default_work_shift_id IS NOT NULL");
    } else if (assignmentStatus === ASSIGNMENT_STATUS.UNASSIGNED) {
      conditions.push("new_employee.default_work_shift_id IS NULL");
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // LEFT JOIN on work_shift: an unassigned employee must still appear, with
    // the shift columns null. An INNER JOIN here would silently empty the
    // "Unassigned" filter - the one HR starts from.
    const query = `
      SELECT ${EMPLOYEE_COLUMNS}
        FROM new_employee
        LEFT JOIN outlets ON outlets.outlet_id = new_employee.store_id
        LEFT JOIN department ON department.department_id = new_employee.department_id
        LEFT JOIN designation ON designation.designation_id = new_employee.designation_id
        LEFT JOIN work_shift ON work_shift.work_shift_id = new_employee.default_work_shift_id
        ${where}
       ORDER BY new_employee.employee_name ASC, new_employee.employee_id ASC`;

    return new Promise((resolve, reject) => {
      this.db.query(query, params, (err, rows) => {
        if (err) {
          this._log("GET-EMPLOYEES-FOR-ASSIGNMENT", err);
          reject(err);
          return;
        }
        resolve((rows || []).map(presentEmployeeRow));
      });
    });
  }

  /**
   * The active work shifts the dropdown offers.
   *
   * Ordered by `shift_code`, matching the work shift master's own list, so
   * the two screens present shifts in the same order.
   */
  getActiveWorkShifts() {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT work_shift_id, shift_code, shift_name
           FROM work_shift
          WHERE active = 1
          ORDER BY shift_code ASC`,
        [],
        (err, rows) => {
          if (err) {
            this._log("GET-ACTIVE-WORK-SHIFTS", err);
            reject(err);
            return;
          }
          resolve(rows || []);
        }
      );
    });
  }

  /**
   * Assign one work shift to many employees, all-or-nothing.
   *
   * All-or-nothing rather than partial: a half-applied bulk assignment leaves
   * HR with no way to tell from the screen which half landed, and re-running
   * it is not obviously safe. Everything is checked first, and if anything is
   * wrong nothing is written and the offending ids come back so the screen
   * can say which.
   *
   * The work shift row is locked FOR UPDATE before it is checked. Without the
   * lock, a shift deactivated between the check and the UPDATE would still
   * collect assignments - a narrow race, but this is the only writer and the
   * lock costs nothing.
   *
   * The UPDATE names `default_work_shift_id` and nothing else. `shift_id` and
   * `shift_code` are not in this statement and are not read by it.
   *
   * @param {number[]} employeeIds already deduplicated by the usecase
   * @param {number} workShiftId
   */
  async bulkAssignWorkShift(employeeIds, workShiftId) {
    const connection = await getConnectionAsync(this.db);
    try {
      await beginTransactionAsync(connection);

      const shiftRows = await queryAsync(
        connection,
        "SELECT work_shift_id, shift_code, shift_name, active FROM work_shift WHERE work_shift_id = ? FOR UPDATE",
        [workShiftId]
      );
      const workShift = shiftRows && shiftRows[0];

      if (!workShift) {
        await rollbackAsync(connection);
        return { code: 404, msg: "Work shift not found" };
      }
      if (Number(workShift.active) !== 1) {
        await rollbackAsync(connection);
        return {
          code: 400,
          msg: `Work shift ${workShift.shift_code} is inactive and cannot be assigned`,
        };
      }

      // Which of the requested employees actually qualify. An id that names
      // nobody, and an id that names somebody inactive, are both rejections:
      // the screen only ever lists active employees, so either means the
      // request did not come from what the user was looking at.
      const foundRows = await queryAsync(
        connection,
        "SELECT employee_id FROM new_employee WHERE employee_id IN (?) AND status = ?",
        [employeeIds, STATUS.ACTIVE]
      );
      const found = new Set((foundRows || []).map((row) => Number(row.employee_id)));
      const rejected_employee_ids = employeeIds.filter((id) => !found.has(Number(id)));

      if (rejected_employee_ids.length > 0) {
        await rollbackAsync(connection);
        return {
          code: 400,
          msg: "Some selected employees are not assignable",
          rejected_employee_ids,
        };
      }

      const result = await queryAsync(
        connection,
        "UPDATE new_employee SET default_work_shift_id = ? WHERE employee_id IN (?)",
        [workShiftId, employeeIds]
      );

      await commitAsync(connection);

      // `affectedRows` counts rows matched, `changedRows` only those whose
      // value actually moved. Reassigning somebody to the shift they already
      // had is a success, not a no-op to hide, so the count reported is
      // matched rows.
      return {
        code: 200,
        work_shift_id: workShiftId,
        shift_code: workShift.shift_code,
        shift_name: workShift.shift_name,
        assigned_count: result && result.affectedRows ? result.affectedRows : 0,
        rejected_employee_ids: [],
      };
    } catch (err) {
      await rollbackAsync(connection);
      this._log("BULK-ASSIGN-WORK-SHIFT", err, { work_shift_id: workShiftId });
      throw err;
    } finally {
      connection.release();
    }
  }
}

module.exports = (db) => {
  return new EmployeeWorkShiftRepository(db);
};

module.exports.ASSIGNMENT_STATUS = ASSIGNMENT_STATUS;
module.exports.STATUS = STATUS;
module.exports.EMPLOYEE_COLUMNS = EMPLOYEE_COLUMNS;
