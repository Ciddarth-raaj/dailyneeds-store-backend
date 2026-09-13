const logger = require("../utils/logger");

/**
 * GLOBAL DASHBOARD ACCESS - the one read the scope resolver needs.
 *
 * ITS OWN REPOSITORY ON PURPOSE. The resolver is shared by every dashboard, so
 * it must not reach into the Attendance repository to find out where somebody
 * works - a future Sales dashboard would then depend on Attendance for its
 * authorization, which is exactly the coupling this layer exists to prevent.
 *
 * READ-ONLY. One SELECT, no INSERT, UPDATE or DELETE, no transaction.
 * Resolving who may see what must never change a record.
 *
 * NOTHING SENSITIVE IS SELECTED. Deciding a branch needs the branch and enough
 * to know the row exists; it does not need salary, bank, PAN, PF/ESI or
 * Aadhaar, and none of those columns appears below.
 */
class DashboardScopeRepository {
  constructor(db) {
    this.db = db;
  }

  _read(code, sql, params) {
    return new Promise((resolve, reject) => {
      this.db.query(sql, params, (err, rows) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.DASHBOARD_SCOPE",
            code: `REPOSITORY.DASHBOARD_SCOPE.${code}`,
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
   * THE EMPLOYEE'S CURRENTLY ASSIGNED BRANCH, read live.
   *
   * `new_employee.store_id` is the assignment Employee Master writes and every
   * HR screen reads, and it references `outlets.outlet_id`. It is the source of
   * truth for "which branch does this person work at", and this reads it fresh
   * on the request rather than trusting a copy.
   *
   * WHY NOT `req.decoded.store_id`, WHICH IS ALREADY IN HAND. Because it is a
   * COPY TAKEN AT LOGIN. `usecase/user.js` puts `row.store_id` into the JWT
   * claims when the token is signed and nothing refreshes it for the token's
   * whole lifetime; `middlewares/auth.js` validates the identity claims and
   * never validates that one. So an employee transferred from Moolakulam to
   * ECR in Employee Master keeps a token that still says Moolakulam, and a
   * scope built from it would authorize the branch they no longer work at
   * until they happen to log in again. An authorization boundary cannot be a
   * stale cache of a fact it does not own.
   *
   * IT IS NOT CACHED HERE EITHER, for the same reason. This is one lookup by
   * primary key on a request that already runs far heavier reads, and a
   * transfer must take effect on the next request rather than whenever a cache
   * happens to expire.
   *
   * The outlet name comes back so a screen can say which branch it is pinned
   * to; it is the caller's OWN branch, so naming it reveals nothing they are
   * not already authorized for.
   */
  async getEmployeeStore(employeeId) {
    if (employeeId === null || employeeId === undefined) return null;
    const rows = await this._read(
      "GET-EMPLOYEE-STORE",
      `SELECT ne.employee_id,
              ne.store_id,
              ne.status AS employee_status,
              o.outlet_name,
              o.outlet_nickname
         FROM new_employee ne
         LEFT JOIN outlets o ON o.outlet_id = ne.store_id
        WHERE ne.employee_id = ?`,
      [employeeId]
    );
    return rows && rows[0] ? rows[0] : null;
  }
}

module.exports = DashboardScopeRepository;
