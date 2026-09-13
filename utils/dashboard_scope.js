/**
 * GLOBAL DASHBOARD ACCESS - the shared authorization vocabulary.
 *
 * PURE FUNCTIONS. No database, no Express, no permission lookup: everything
 * here is decided from values the caller has already resolved, so every rule
 * is testable on its own and the same rule serves every dashboard.
 *
 * TWO QUESTIONS, KEPT APART, and keeping them apart is the whole design:
 *
 *   MAY THIS PERSON OPEN THIS DASHBOARD?   one feature key per dashboard -
 *                                          `view_attendance_dashboard` and
 *                                          its siblings. It says nothing
 *                                          about locations.
 *   WHICH LOCATIONS MAY THEY SEE?          the dashboard STORE SCOPE, which
 *                                          is exactly one of Own Store or All
 *                                          Stores, and is shared by every
 *                                          dashboard rather than restated per
 *                                          screen.
 *
 * Conflating them is what the first Attendance implementation did, and it is
 * how a permission key silently became a company-wide grant. A feature key
 * permits a SCREEN; it never widens a location.
 *
 * THE THREE ANSWERS ARE THREE DIFFERENT STATEMENTS, and they stay distinct all
 * the way down to the SQL predicate:
 *
 *   ALL_STORES   authorized company-wide. `store_ids` is null - no restriction
 *                - and a browser filter may narrow it.
 *   OWN_STORE    authorized for exactly the branch the employee is assigned to
 *                in Employee Master. `store_ids` is `[that one]` and NOTHING
 *                the caller sends can change it.
 *   NONE         no authorized location, or an authorization that cannot be
 *                resolved. FAILS CLOSED - the endpoint refuses - and never
 *                degrades to company-wide.
 *
 * WHY NOT A MULTI-STORE SUBSET YET. The approved model is these two values
 * only. `store_ids` is still carried as a LIST throughout, because that is the
 * shape a subset model would return and every intersection, empty-set case and
 * predicate below already handles it - but nothing produces a list of more
 * than one today, and no code path invents one.
 */

/** Every state a caller's dashboard location authorization can be in. */
const DASHBOARD_SCOPE = Object.freeze({
  ALL_STORES: "ALL_STORES",
  OWN_STORE: "OWN_STORE",
  NONE: "NONE",
});

/**
 * The feature key per dashboard. One each, granted and revoked on its own.
 *
 * ONLY ATTENDANCE IS WIRED TO A ROUTE TODAY. The other three are declared so
 * the scope model is complete and a future module can call
 * `requireDashboardAccess(DASHBOARD_PERMISSION.SALES)` without inventing an
 * authorization scheme of its own. Declaring a key builds no screen, adds no
 * route and puts nothing in the navigation.
 */
const DASHBOARD_PERMISSION = Object.freeze({
  ATTENDANCE: "view_attendance_dashboard",
  HR: "view_hr_dashboard",
  SALES: "view_sales_dashboard",
  MY: "view_my_dashboard",
});

/**
 * THE SCOPE KEYS, and why there are two of them rather than one enum.
 *
 * The approved model is ONE value - Own Store or All Stores - and an enum
 * column would express that better. The rights system this must live in does
 * not have one: `permissions` is (designation_id, permission_key, is_active)
 * and every right in the application is a boolean key in that table, read
 * through one cached `getPermissionById`. Adding an enum would mean a second
 * shape of right, a second read path and a second thing the rights screen has
 * to understand - materially more change, and more risk, than the scope itself
 * warrants.
 *
 * So the approved fallback applies: two keys, with EXACTLY ONE EFFECTIVE SCOPE
 * ENFORCED ON THE SERVER by `decideScope` below. The table cannot stop both
 * from being ticked; this code can, and does, deterministically.
 */
const DASHBOARD_SCOPE_KEY = Object.freeze({
  OWN_STORE: "dashboard_scope_own_store",
  ALL_STORES: "dashboard_scope_all_stores",
});

/** Why a caller resolved to the scope they did. Always reported, never guessed. */
const SCOPE_REASON = Object.freeze({
  ADMINISTRATOR: "ADMINISTRATOR",
  ALL_STORES_SCOPE: "ALL_STORES_SCOPE",
  OWN_STORE_SCOPE: "OWN_STORE_SCOPE",
  UNAUTHENTICATED: "UNAUTHENTICATED",
  NO_DASHBOARD_PERMISSION: "NO_DASHBOARD_PERMISSION",
  NO_SCOPE_GRANTED: "NO_SCOPE_GRANTED",
  CONFLICTING_SCOPE: "CONFLICTING_SCOPE",
  NO_EMPLOYEE_RECORD: "NO_EMPLOYEE_RECORD",
  NO_STORE_ASSIGNED: "NO_STORE_ASSIGNED",
});

/** The refusal message for each reason. Says what is wrong and who fixes it. */
const SCOPE_MESSAGE = Object.freeze({
  NO_DASHBOARD_PERMISSION: "You do not have permission to view this dashboard.",
  NO_SCOPE_GRANTED:
    "You are not authorized for any branch on this dashboard. An administrator grants Own Store or All Stores dashboard scope on the Designation rights screen.",
  CONFLICTING_SCOPE:
    "Your designation has both Own Store and All Stores dashboard scope. Exactly one must be granted; an administrator can correct this on the Designation rights screen.",
  NO_EMPLOYEE_RECORD:
    "Your login is not linked to an employee record, so your own store cannot be determined.",
  NO_STORE_ASSIGNED:
    "You have no branch assigned in Employee Master, so Own Store scope cannot be resolved.",
  UNAUTHENTICATED: "Unauthorized",
});

/**
 * WHICH SCOPE A CALLER HAS, before any store is looked up.
 *
 * The order is the rule, and the first two lines of it matter most:
 *
 *   1. AN ADMINISTRATOR IS ALL STORES, decided by `user_type` and nothing
 *      else. This is checked FIRST, and it has to be: the permission
 *      middleware gives `user_type` 2 every row of `all_permissions`, so an
 *      administrator necessarily holds BOTH scope keys. Applying the conflict
 *      rule to them would lock every administrator out of every dashboard.
 *      This is the system's existing single administrator concept, reused -
 *      not a second one, and not a scope they have to be granted twice.
 *   2. BOTH KEYS ON A NON-ADMINISTRATOR IS A CONFIGURATION FAULT, and it fails
 *      closed. The two keys are meant to be exclusive and the table cannot
 *      enforce it, so somebody has ticked both. Guessing which they meant is
 *      the one thing that must not happen here: picking the wider one would
 *      turn a mis-click into company-wide attendance access. The refusal names
 *      the fault so it can be corrected.
 *   3. All Stores, then Own Store, each on its own key.
 *   4. Neither: NONE. Holding the dashboard's feature key grants no location.
 *
 * @param {object} input
 * @param {boolean} input.is_admin        `user_type` is the admin type
 * @param {boolean} input.has_all_stores  holds the All Stores scope key
 * @param {boolean} input.has_own_store   holds the Own Store scope key
 * @returns {{kind: string, reason: string}}
 */
function decideScope({ is_admin = false, has_all_stores = false, has_own_store = false } = {}) {
  if (is_admin) return { kind: DASHBOARD_SCOPE.ALL_STORES, reason: SCOPE_REASON.ADMINISTRATOR };
  if (has_all_stores && has_own_store) {
    return { kind: DASHBOARD_SCOPE.NONE, reason: SCOPE_REASON.CONFLICTING_SCOPE };
  }
  if (has_all_stores) {
    return { kind: DASHBOARD_SCOPE.ALL_STORES, reason: SCOPE_REASON.ALL_STORES_SCOPE };
  }
  if (has_own_store) return { kind: DASHBOARD_SCOPE.OWN_STORE, reason: SCOPE_REASON.OWN_STORE_SCOPE };
  return { kind: DASHBOARD_SCOPE.NONE, reason: SCOPE_REASON.NO_SCOPE_GRANTED };
}

/** A `store_ids` query value (`"1,2"`, a list, or nothing) as numbers. */
function parseRequestedStores(value) {
  if (value === null || value === undefined || value === "") return null;
  const raw = Array.isArray(value) ? value : String(value).split(",");
  const ids = raw
    .map((v) => Number(String(v).trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  return ids.length ? [...new Set(ids)] : null;
}

/**
 * DID THIS REQUEST TRY TO REACH OUTSIDE ITS SCOPE?
 *
 * Only an Own Store caller can: All Stores has nothing outside it, and NONE is
 * refused before any filter is read. Asked separately from the narrowing below
 * because the two deserve different answers - a request that merely omits a
 * filter should be narrowed silently, while one that NAMES another branch is
 * told plainly that it was refused rather than quietly handed its own store's
 * figures under the other branch's heading.
 *
 * @param {{kind:string, store_ids:number[]|null}} scope
 * @param {number[]|null} requested
 */
function isWideningAttempt(scope, requested) {
  if (!scope || scope.kind !== DASHBOARD_SCOPE.OWN_STORE) return false;
  if (!Array.isArray(requested) || requested.length === 0) return false;
  const allowed = new Set((scope.store_ids || []).map(Number));
  return requested.map(Number).some((id) => !allowed.has(id));
}

/**
 * THE EFFECTIVE `store_ids` for a request. It can narrow; it can never widen.
 *
 *   ALL_STORES  a requested filter is honoured as a filter; no filter means no
 *               restriction (null).
 *   OWN_STORE   ALWAYS the assigned branch, whatever was requested. A request
 *               naming only that branch is the same answer; a request naming
 *               anything else never reaches here (see `isWideningAttempt`).
 *   NONE        `[]` - an empty authorized set, which the location predicate
 *               renders as `1 = 0`. It is NOT the same as null and must never
 *               be collapsed into one.
 */
function effectiveStoreIds(scope, requested) {
  if (!scope || scope.kind === DASHBOARD_SCOPE.NONE) return [];
  if (scope.kind === DASHBOARD_SCOPE.OWN_STORE) return [...(scope.store_ids || [])];
  return Array.isArray(requested) && requested.length ? [...requested] : null;
}

/**
 * What the BROWSER may be told about this scope.
 *
 * Deliberately small: the kind, the one outlet an Own Store caller is pinned
 * to, and whether the outlet filter should be offered at all. No permission
 * keys, no reason codes for a successful resolve, and nothing about anybody
 * else's branches - a screen does not need those, and a payload that carries
 * them is one more place they can leak.
 */
function scopeForClient(scope) {
  if (!scope) return { kind: DASHBOARD_SCOPE.NONE, store_ids: [], can_choose_outlet: false };
  return {
    kind: scope.kind,
    store_ids: scope.kind === DASHBOARD_SCOPE.OWN_STORE ? [...(scope.store_ids || [])] : [],
    can_choose_outlet: scope.kind === DASHBOARD_SCOPE.ALL_STORES,
  };
}

module.exports = {
  DASHBOARD_SCOPE,
  DASHBOARD_PERMISSION,
  DASHBOARD_SCOPE_KEY,
  SCOPE_REASON,
  SCOPE_MESSAGE,
  decideScope,
  parseRequestedStores,
  isWideningAttempt,
  effectiveStoreIds,
  scopeForClient,
};
