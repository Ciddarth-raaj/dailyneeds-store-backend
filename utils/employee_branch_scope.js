/**
 * EMPLOYEE BRANCH SCOPE - which employees a caller may see and edit.
 *
 * PURE FUNCTIONS. No database, no Express, no permission lookup: every rule
 * here is decided from values the caller has already resolved, so each one is
 * testable on its own and the same rule serves every employee endpoint.
 *
 * ============================== TWO QUESTIONS, KEPT APART =================
 *
 *   MAY THIS PERSON DO THIS AT ALL?   the existing employee-master permission
 *                                     keys - `view_employees`,
 *                                     `employee_edit`, `add_employees` and
 *                                     the rest. They say WHAT may be done and
 *                                     nothing about WHICH branches.
 *   WHICH BRANCHES MAY THEY REACH?    this module. Shared by every employee
 *                                     read and every employee write, rather
 *                                     than restated per screen.
 *
 * This is deliberately the same shape as `utils/dashboard_scope.js`, which
 * already draws that line for the dashboards, and for the same reason: a
 * feature key permits an ACTION, it never widens a location. Before this,
 * `view_employees` alone let a Kathirkamam store manager read - and
 * `employee_edit` let them change - every employee in the company.
 *
 * ============================== THE THREE ANSWERS =========================
 *
 *   ALL_BRANCHES   authorized company-wide. HR and administrators.
 *                  `store_ids` is null - no restriction - and a caller's own
 *                  filter may narrow it.
 *   OWN_BRANCHES   authorized for exactly the branches the caller is assigned
 *                  to in Employee Master. `store_ids` is that list and
 *                  NOTHING in the request can change it.
 *   NONE           no authorized branch, or an authorization that cannot be
 *                  resolved. FAILS CLOSED - the endpoint refuses - and never
 *                  degrades to company-wide.
 *
 * `store_ids` is carried as a LIST throughout because the approved rule is
 * "the user's assigned branch/branches". `new_employee.store_id` holds one
 * branch per employee today, so the list has one element in production; every
 * intersection and predicate below already handles more, so introducing a
 * user -> branches mapping later changes the RESOLVER and nothing else.
 */

/** Every state a caller's employee-branch authorization can be in. */
const EMPLOYEE_BRANCH_SCOPE = Object.freeze({
  ALL_BRANCHES: "ALL_BRANCHES",
  OWN_BRANCHES: "OWN_BRANCHES",
  NONE: "NONE",
});

/** Why a caller resolved to the scope they did. Always reported, never guessed. */
const BRANCH_SCOPE_REASON = Object.freeze({
  ADMINISTRATOR: "ADMINISTRATOR",
  ALL_BRANCHES_PERMISSION: "ALL_BRANCHES_PERMISSION",
  OWN_BRANCHES: "OWN_BRANCHES",
  UNAUTHENTICATED: "UNAUTHENTICATED",
  NO_EMPLOYEE_RECORD: "NO_EMPLOYEE_RECORD",
  EMPLOYEE_INACTIVE: "EMPLOYEE_INACTIVE",
  NO_BRANCH_ASSIGNED: "NO_BRANCH_ASSIGNED",
});

/** The refusal message for each reason. Says what is wrong and who fixes it. */
const BRANCH_SCOPE_MESSAGE = Object.freeze({
  UNAUTHENTICATED: "Unauthorized",
  NO_EMPLOYEE_RECORD:
    "Your login is not linked to an employee record, so your branch cannot be determined.",
  EMPLOYEE_INACTIVE:
    "Your employee record is not active, so your branch access cannot be resolved.",
  NO_BRANCH_ASSIGNED:
    "You have no branch assigned in Employee Master, so employee access cannot be resolved. An administrator can set your branch on your employee record.",
  OUT_OF_BRANCH:
    "This employee belongs to a branch you are not authorized for.",
  OUT_OF_BRANCH_TRANSFER:
    "You are not authorized to move an employee to that branch.",
});

/**
 * WHICH SCOPE A CALLER HAS, before any branch is looked up.
 *
 * The order is the rule:
 *
 *   1. AN ADMINISTRATOR IS ALL BRANCHES, decided by `user_type` and nothing
 *      else. Checked FIRST because the permission middleware hands `user_type`
 *      2 every key, so an administrator necessarily "holds" the all-branches
 *      key too - reading it from the key set would work by accident rather
 *      than by rule. This is the system's existing single administrator
 *      concept, reused; not a second one.
 *   2. THE ALL-BRANCHES KEY, which is what HR holds. One key, granted per
 *      designation on the rights screen exactly like every other right in this
 *      application, because that is the only shape of right the `permissions`
 *      table has. There is no `is_hr` column to read and inventing one would
 *      be a second authorization scheme.
 *   3. Everybody else is OWN BRANCHES, and their branches are resolved
 *      separately - see the middleware. Holding `view_employees` grants no
 *      branch of its own.
 *
 * @param {object} input
 * @param {boolean} input.is_admin          `user_type` is the admin type
 * @param {boolean} input.has_all_branches  holds `employee_scope_all_branches`
 */
function decideScope({ is_admin = false, has_all_branches = false } = {}) {
  if (is_admin) {
    return {
      kind: EMPLOYEE_BRANCH_SCOPE.ALL_BRANCHES,
      reason: BRANCH_SCOPE_REASON.ADMINISTRATOR,
    };
  }
  if (has_all_branches) {
    return {
      kind: EMPLOYEE_BRANCH_SCOPE.ALL_BRANCHES,
      reason: BRANCH_SCOPE_REASON.ALL_BRANCHES_PERMISSION,
    };
  }
  return {
    kind: EMPLOYEE_BRANCH_SCOPE.OWN_BRANCHES,
    reason: BRANCH_SCOPE_REASON.OWN_BRANCHES,
  };
}

/**
 * IS THIS EMPLOYEE ROW ACTIVE? The same predicate the rest of the application
 * runs on - `new_employee.status = 1` - restated for a row rather than a
 * session state. `middlewares/auth.js#employeeActive` and
 * `utils/dashboard_scope.js#isActiveEmployeeRow` say the same thing, and the
 * tests assert all three agree so they cannot drift.
 *
 * An unreadable, null or absent status is NOT active: the safe direction for
 * an authorization boundary is to refuse.
 */
function isActiveEmployeeRow(row) {
  if (!row) return false;
  return Number(row.status !== undefined ? row.status : row.employee_status) === 1;
}

/** A branch id from anywhere (a row, a body, a query) as a positive integer, or null. */
function branchId(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** A list of branch ids, de-duplicated, dropping anything that is not one. */
function branchIds(values) {
  const raw = Array.isArray(values) ? values : [values];
  const ids = raw.map(branchId).filter((n) => n !== null);
  return [...new Set(ids)];
}

/** A `store_ids` request value (`"1,2"`, a list, or nothing) as numbers. */
function parseRequestedBranches(value) {
  if (value === null || value === undefined || value === "") return null;
  const raw = Array.isArray(value) ? value : String(value).split(",");
  const ids = branchIds(raw);
  return ids.length ? ids : null;
}

/**
 * MAY THIS CALLER REACH THIS EMPLOYEE'S BRANCH?
 *
 * THE FAIL-CLOSED CASES ARE THE POINT, so they are listed rather than left to
 * fall out of the logic:
 *
 *   no scope at all              refused. An unresolved authorization is not
 *                                a company-wide one.
 *   scope NONE                   refused.
 *   scope OWN_BRANCHES, no ids   refused. "Assigned to nowhere" is nowhere,
 *                                not everywhere.
 *   employee branch null/absent  refused for a branch-scoped caller. An
 *                                employee whose branch cannot be determined
 *                                cannot be shown to be inside the caller's,
 *                                and the approved rule says deny.
 *
 * ALL_BRANCHES is the only kind that reaches an employee with no branch, and
 * that is correct: HR and administrators are not restricted by branch, so
 * there is no comparison to fail.
 *
 * @param {{kind:string, store_ids:number[]|null}} scope
 * @param {*} employeeStoreId the employee's `new_employee.store_id`
 */
function isEmployeeInScope(scope, employeeStoreId) {
  if (!scope) return false;
  if (scope.kind === EMPLOYEE_BRANCH_SCOPE.ALL_BRANCHES) return true;
  if (scope.kind !== EMPLOYEE_BRANCH_SCOPE.OWN_BRANCHES) return false;

  const allowed = branchIds(scope.store_ids || []);
  if (allowed.length === 0) return false;

  const target = branchId(employeeStoreId);
  if (target === null) return false;

  return allowed.includes(target);
}

/**
 * THE EFFECTIVE `store_ids` for a LIST request. It can narrow; it never widens.
 *
 *   ALL_BRANCHES   a requested filter is honoured as a filter; no filter means
 *                  no restriction (null).
 *   OWN_BRANCHES   the INTERSECTION of what was asked for with what is
 *                  authorized, and the authorized set when nothing was asked
 *                  for. A request naming only other branches intersects to
 *                  `[]`, which is an empty result and not an open one.
 *   NONE           `[]`.
 *
 * `[]` and `null` are NOT interchangeable and must never be collapsed: `[]` is
 * "no branch is authorized" and renders as a predicate that matches nothing;
 * `null` is "no restriction".
 */
function effectiveBranchIds(scope, requested) {
  if (!scope || scope.kind === EMPLOYEE_BRANCH_SCOPE.NONE) return [];

  const asked = Array.isArray(requested) && requested.length ? branchIds(requested) : null;

  if (scope.kind === EMPLOYEE_BRANCH_SCOPE.ALL_BRANCHES) return asked;

  const allowed = branchIds(scope.store_ids || []);
  if (!asked) return allowed;
  return asked.filter((id) => allowed.includes(id));
}

/**
 * DID THIS REQUEST TRY TO REACH OUTSIDE ITS SCOPE?
 *
 * Asked separately from the narrowing above because the two deserve different
 * answers: a request that merely omits a filter is narrowed silently, while
 * one that NAMES another branch is told plainly it was refused rather than
 * quietly handed its own branch's rows under another branch's heading.
 */
function isWideningAttempt(scope, requested) {
  if (!scope || scope.kind === EMPLOYEE_BRANCH_SCOPE.ALL_BRANCHES) return false;
  const asked = branchIds(requested || []);
  if (asked.length === 0) return false;
  const allowed = branchIds(scope.store_ids || []);
  return asked.some((id) => !allowed.includes(id));
}

/**
 * What the BROWSER may be told about this scope. Deliberately small: the kind,
 * the branches a scoped caller is pinned to, and whether a branch filter is
 * worth offering. No permission keys and nothing about anybody else's branches.
 */
function scopeForClient(scope) {
  if (!scope) {
    return { kind: EMPLOYEE_BRANCH_SCOPE.NONE, store_ids: [], can_choose_branch: false };
  }
  return {
    kind: scope.kind,
    store_ids:
      scope.kind === EMPLOYEE_BRANCH_SCOPE.ALL_BRANCHES ? [] : branchIds(scope.store_ids || []),
    can_choose_branch: scope.kind === EMPLOYEE_BRANCH_SCOPE.ALL_BRANCHES,
  };
}

module.exports = {
  EMPLOYEE_BRANCH_SCOPE,
  BRANCH_SCOPE_REASON,
  BRANCH_SCOPE_MESSAGE,
  decideScope,
  isActiveEmployeeRow,
  branchId,
  branchIds,
  parseRequestedBranches,
  isEmployeeInScope,
  effectiveBranchIds,
  isWideningAttempt,
  scopeForClient,
};
