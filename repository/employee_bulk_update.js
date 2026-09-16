const logger = require("../utils/logger");
const { accessScope } = require("./employee_scope");
const { JOINED_ON } = require("../utils/joining_date");

/**
 * EMPLOYEE MASTER BULK EXPORT / IMPORT — the reads, and the audit write.
 *
 * WHAT IS NOT HERE, DELIBERATELY: any UPDATE of an employee. Not one. Every
 * change this feature makes goes through `usecase/employee_master.js`
 * (`editEmployee`, `correctJoiningDate`) on that layer's own transaction, so
 * the branch-transfer check, the session revocation on a designation or store
 * change, the lifecycle reconciliation on a joining date and the logging all
 * happen exactly as they do when HR edits one employee by hand. A `SET ?` in
 * this file would be the shortcut the whole design exists to avoid.
 *
 * So this repository does three things: read the population an export is
 * allowed to cover, read the masters a human-readable cell resolves against,
 * and record that a bulk operation happened.
 */
class EmployeeBulkUpdateRepository {
  constructor(db) {
    this.db = db;
  }

  _query(code, sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.query(sql, params, (err, rows) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.EMPLOYEE_BULK_UPDATE",
            code: `REPOSITORY.EMPLOYEE_BULK_UPDATE.${code}`,
            description: err.toString(),
            category: "",
            ref: {},
          });
          reject(err);
          return;
        }
        resolve(rows);
      });
    });
  }

  /* ------------------------------------------------------------- masters */

  /**
   * The three masters a human-readable cell is resolved against.
   *
   * INACTIVE ROWS ARE INCLUDED, and that is not an oversight. An employee
   * sitting on a branch that was closed last year must still EXPORT with a
   * readable label rather than a blank cell that a round-trip would then read
   * as "leave unchanged" for the wrong reason. Whether a row may be assigned
   * TO is a separate question, answered from `active` by the usecase.
   *
   * `outlets` spells the flag `is_active`; the other two spell it `status`.
   * Both spellings are pinned by a test, because reading the wrong column here
   * would mark every branch inactive and refuse every Location in a file.
   *
   * THE `_code` COLUMNS ARE DELIBERATELY NOT SELECTED. All three exist
   * (`20251117080329-employee-import`, each UNIQUE), but `department_code` and
   * `designation_code` are nullable and were only ever written by the Digisme
   * sync, which has been removed - normal CRUD writes neither. The spreadsheet
   * label is `Name [ID]` off the primary key instead, which is never NULL and
   * never duplicated. See `utils/employee_bulk_fields.js#buildMasterIndex`.
   */
  async getMasters() {
    const [outlets, departments, designations] = await Promise.all([
      this._query(
        "MASTERS-OUTLET",
        `SELECT outlet_id AS id, outlet_name AS name, is_active AS active
           FROM outlets ORDER BY outlet_name ASC`
      ),
      this._query(
        "MASTERS-DEPARTMENT",
        `SELECT department_id AS id, department_name AS name, status AS active
           FROM department ORDER BY department_name ASC`
      ),
      this._query(
        "MASTERS-DESIGNATION",
        `SELECT designation_id AS id, designation_name AS name, status AS active
           FROM designation ORDER BY designation_name ASC`
      ),
    ]);
    return { outlet: outlets, department: departments, designation: designations };
  }

  /* ---------------------------------------------------------- the export */

  /**
   * The employees an export may cover.
   *
   * THE POPULATION IS SCOPED IN SQL, not trimmed afterwards. `accessScope` is
   * the SAME unit the HR directory and Reports compose, and it FAILS CLOSED:
   * an actor that arrives without a resolved `branch_scope` renders `1 = 0`
   * and this returns nothing rather than every employee in the company. The
   * caller must therefore pass `employeeBranchScope.actorFor(req)`, never
   * `permissions.actorFor(req)`.
   *
   * `filters.status` follows the Employee Master's own convention: 1 active,
   * 0 inactive, `null`/absent both. `store_ids`, `department_ids` and
   * `designation_ids` can only ever NARROW - the route has already refused a
   * request that names a branch outside the caller's scope, so a filter here
   * is never a widening.
   *
   * `date_of_joining` goes out through the one shared parser, as
   * `repository/employee.js` does, so it leaves as `YYYY-MM-DD` TEXT rather
   * than a Date built at local midnight.
   */
  getEmployeesForExport(actor, filters = {}) {
    const conditions = [];
    const params = [];

    const scope = accessScope(actor);
    conditions.push(...scope.conditions);
    params.push(...scope.params);

    const f = filters || {};
    if (f.status === 1 || f.status === 0) {
      conditions.push("new_employee.status = ?");
      params.push(f.status);
    }
    for (const [key, column] of [
      ["store_ids", "store_id"],
      ["department_ids", "department_id"],
      ["designation_ids", "designation_id"],
    ]) {
      if (Array.isArray(f[key]) && f[key].length > 0) {
        conditions.push(`new_employee.${column} IN (?)`);
        params.push(f[key]);
      }
    }
    // An explicit, empty branch list means NO branch, never no restriction.
    if (Array.isArray(f.store_ids) && f.store_ids.length === 0) {
      conditions.push("1 = 0");
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    return this._query(
      "EXPORT-POPULATION",
      `SELECT new_employee.employee_id,
              new_employee.employee_name,
              new_employee.store_id,
              new_employee.department_id,
              new_employee.designation_id,
              new_employee.employment_type,
              new_employee.grade,
              new_employee.status,
              DATE_FORMAT((${JOINED_ON("new_employee")}), '%Y-%m-%d') AS date_of_joining
         FROM new_employee
         ${where}
         ORDER BY new_employee.employee_id ASC`,
      params
    );
  }

  /**
   * The CURRENT value of every field this feature can touch, for the employee
   * ids named in an upload.
   *
   * Read WITHOUT the branch predicate on purpose: whether the caller may
   * touch each of these employees is decided per row by the branch scope,
   * which must be able to tell "outside your branches" apart from "no such
   * employee id" and answer the same refusal for both. Folding the scope into
   * this query would collapse the two into "unknown Employee ID", which is a
   * different - and misleading - message.
   *
   * Nothing from this read reaches the caller except through that per-row
   * decision.
   */
  getCurrentValues(employeeIds) {
    const ids = (employeeIds || []).map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0);
    if (ids.length === 0) return Promise.resolve([]);
    return this._query(
      "CURRENT-VALUES",
      `SELECT new_employee.employee_id,
              new_employee.employee_name,
              new_employee.store_id,
              new_employee.department_id,
              new_employee.designation_id,
              new_employee.employment_type,
              new_employee.grade,
              new_employee.status,
              DATE_FORMAT((${JOINED_ON("new_employee")}), '%Y-%m-%d') AS date_of_joining
         FROM new_employee
        WHERE new_employee.employee_id IN (?)`,
      [ids]
    );
  }

  /* -------------------------------------------------------------- audit */

  /**
   * The bulk-operation audit row: who, when, which file, what was attempted
   * and what came of it.
   *
   * IT DOES NOT REPLACE THE PER-EMPLOYEE HISTORY. Every row this operation
   * writes still produces exactly the audit an ordinary Employee Master edit
   * produces - `USECASE.EMPLOYEE_MASTER.EDIT-REVOKED` for a security-relevant
   * change, and a `period_corrected` lifecycle event with the old and new date
   * for a joining date. This table answers the question those cannot: that
   * eighty of them came from one file, uploaded by one person, at one moment.
   * It is the same shape as `report_export_log`, which already records the
   * export side of the employee master, rather than a second audit framework.
   *
   * The per-row detail is stored as JSON: employee id, which fields changed,
   * and the outcome. NO free-text employee value is recorded beyond the
   * field keys and the resolved ids/labels that were written - those ARE the
   * change, and a change log that does not say what changed is decoration.
   */
  recordBulkUpdate(entry) {
    return this._query(
      "LOG-BULK-UPDATE",
      `INSERT INTO employee_bulk_update_log
         (operation, user_id, employee_id, source_filename, selected_fields,
          filters, rows_uploaded, rows_valid, rows_error, rows_warning,
          rows_changed, rows_applied, rows_failed, outcome, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.operation,
        entry.user_id === undefined ? null : entry.user_id,
        entry.employee_id === undefined ? null : entry.employee_id,
        entry.source_filename === undefined ? null : entry.source_filename,
        JSON.stringify(entry.selected_fields || []),
        JSON.stringify(entry.filters || {}),
        Number(entry.rows_uploaded) || 0,
        Number(entry.rows_valid) || 0,
        Number(entry.rows_error) || 0,
        Number(entry.rows_warning) || 0,
        Number(entry.rows_changed) || 0,
        Number(entry.rows_applied) || 0,
        Number(entry.rows_failed) || 0,
        entry.outcome,
        JSON.stringify(entry.detail || []),
      ]
    ).then((result) => Number(result.insertId));
  }
}

module.exports = (db) => new EmployeeBulkUpdateRepository(db);
module.exports.EmployeeBulkUpdateRepository = EmployeeBulkUpdateRepository;
