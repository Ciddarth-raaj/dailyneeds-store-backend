/**
 * Shared fixture for the EMPLOYEE BRANCH SCOPE.
 *
 * Builds the REAL middleware (`middlewares/employee_branch_scope.js`) over an
 * in-memory employee table with the same method surface as
 * `repository/employee_branch.js`. Nothing about the authorization rule is
 * re-implemented here - a test that used a hand-written stub scope would pass
 * while the rule it is meant to defend was broken.
 *
 * `employees` is a list of `{ employee_id, store_id, status }`. Anything else
 * on a row is ignored, so a test can reuse whatever employee fixtures it
 * already has.
 */
const buildEmployeeBranchScope = require("../middlewares/employee_branch_scope");
const P = require("../constants/hr_permissions");

/** A repository over a plain array. Same two reads, same shapes. */
function branchRepo(employees = []) {
  const find = (id) =>
    employees.find((e) => Number(e.employee_id) === Number(id)) || null;

  return {
    calls: { getActorBranches: 0, getEmployeeBranch: 0 },
    async getActorBranches(employeeId) {
      this.calls.getActorBranches += 1;
      const row = find(employeeId);
      if (!row) return null;
      // `store_ids` on a fixture row wins, so a test can describe a
      // MULTI-BRANCH user - which the production read cannot produce today
      // (one `new_employee.store_id` per employee) but which the rule must
      // already handle, since that is the whole reason it is a list.
      if (Array.isArray(row.store_ids)) {
        return { employee_id: row.employee_id, status: row.status, store_ids: row.store_ids };
      }
      return {
        employee_id: row.employee_id,
        status: row.status,
        store_ids:
          row.store_id === null || row.store_id === undefined ? [] : [row.store_id],
      };
    },
    async getEmployeeBranch(employeeId) {
      this.calls.getEmployeeBranch += 1;
      return find(employeeId);
    },
  };
}

/**
 * A branch scope over `employees`, built on the given permission middleware so
 * the administrator bypass and the all-branches key are the real ones.
 */
function buildScopeFor(permissions, employees = []) {
  const repo = branchRepo(employees);
  const scope = buildEmployeeBranchScope(permissions, repo);
  scope.__repo = repo;
  return scope;
}

/**
 * A scope that resolves to ALL_BRANCHES for every caller, for a test whose
 * subject is not the branch rule and which would otherwise have to invent an
 * employee table. Use `buildScopeFor` wherever the branch rule itself is under
 * test.
 *
 * It wraps the caller's REAL permission middleware and overrides exactly one
 * thing - the answer to "do you hold `employee_scope_all_branches`". Everything
 * else, `actorFor` included, is the real object, so a test using this still
 * exercises the real permission decisions its subject depends on.
 */
function allBranchesScope(permissions = null) {
  // Defaults under whatever was passed, so a test that hands over a PARTIAL
  // permission stub - several do, because their subject is route wiring - gets
  // a working scope rather than a TypeError from a method the stub omitted.
  const base = {
    ADMIN_USER_TYPE: 2,
    has: async () => false,
    hasAll: async () => false,
    actorFor: async () => ({ isAdmin: false, permissions: [] }),
    ...(permissions || {}),
  };

  const wrapped = {
    ...base,
    has: async (req, ...keys) => {
      if (keys.length === 1 && keys[0] === P.EMPLOYEE_SCOPE_ALL_BRANCHES) return true;
      return base.has(req, ...keys);
    },
  };

  return buildScopeFor(wrapped, []);
}

module.exports = { branchRepo, buildScopeFor, allBranchesScope };
