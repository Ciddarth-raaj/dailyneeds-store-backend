const logger = require("../utils/logger");

/**
 * EMPLOYEE BRANCH SCOPE - the two reads the resolver needs.
 *
 * ITS OWN REPOSITORY ON PURPOSE, for the same reason
 * `repository/dashboard_scope.js` is its own: the resolver is shared by every
 * employee endpoint, so it must not reach into the employee repository (whose
 * queries are `SELECT *` and return salary, bank and Aadhaar columns) merely to
 * find out which branch somebody works at.
 *
 * READ-ONLY. Two SELECTs, no INSERT, UPDATE or DELETE, no transaction.
 * Deciding who may see what must never change a record.
 *
 * NOTHING SENSITIVE IS SELECTED. Deciding a branch needs the branch and enough
 * to know the row exists. No salary, bank, PAN, PF/ESI or Aadhaar column
 * appears below, so a scope resolution cannot become a disclosure.
 */
class EmployeeBranchRepository {
  constructor(db) {
    this.db = db;
  }

  _read(code, sql, params) {
    return new Promise((resolve, reject) => {
      this.db.query(sql, params, (err, rows) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.EMPLOYEE_BRANCH",
            code: `REPOSITORY.EMPLOYEE_BRANCH.${code}`,
            description: err.toString(),
            category: "",
            ref: {},
          });
          reject(err);
          return;
        }
        resolve(rows || []);
      });
    });
  }

  /**
   * THE CALLER'S OWN ASSIGNED BRANCHES, read live.
   *
   * WHY NOT `req.decoded.store_id`, WHICH IS ALREADY IN HAND. Because it is a
   * COPY TAKEN AT LOGIN: `usecase/user.js` writes `row.store_id` into the JWT
   * when the token is signed, nothing refreshes it for the token's lifetime,
   * and `middlewares/auth.js` never validates it. A manager transferred from
   * Moolakulam to Kathirkamam would keep authorization over Moolakulam until
   * they next happened to log in. An authorization boundary cannot be a stale
   * cache of a fact it does not own. `repository/dashboard_scope.js` reached
   * the same conclusion for the dashboards and this follows it.
   *
   * NOT CACHED, for the same reason: this is one primary-key lookup on
   * requests that already run far heavier reads, and a transfer must take
   * effect on the next request rather than whenever a cache happens to expire.
   *
   * RETURNS A LIST because the approved rule is "the user's assigned
   * branch/branches". `new_employee.store_id` holds ONE branch per employee, so
   * the list has at most one element today; a user -> branches mapping would be
   * read here and nowhere else.
   */
  async getActorBranches(employeeId) {
    if (employeeId === null || employeeId === undefined) return null;
    const rows = await this._read(
      "GET-ACTOR-BRANCHES",
      `SELECT ne.employee_id,
              ne.store_id,
              ne.status
         FROM new_employee ne
        WHERE ne.employee_id = ?`,
      [employeeId]
    );
    const row = rows && rows[0] ? rows[0] : null;
    if (!row) return null;
    return {
      employee_id: row.employee_id,
      status: row.status,
      store_ids: row.store_id === null || row.store_id === undefined ? [] : [row.store_id],
    };
  }

  /**
   * THE BRANCH OF THE EMPLOYEE BEING ACTED ON.
   *
   * `null` means no such employee. That is reported as a REFUSAL rather than a
   * 404 by the guard above it, so a manager cannot map out which employee ids
   * exist in other branches by watching the status code change.
   */
  async getEmployeeBranch(employeeId) {
    if (employeeId === null || employeeId === undefined) return null;
    const rows = await this._read(
      "GET-EMPLOYEE-BRANCH",
      `SELECT ne.employee_id,
              ne.store_id,
              ne.status
         FROM new_employee ne
        WHERE ne.employee_id = ?`,
      [employeeId]
    );
    return rows && rows[0] ? rows[0] : null;
  }
}

module.exports = EmployeeBranchRepository;
module.exports.EmployeeBranchRepository = EmployeeBranchRepository;
