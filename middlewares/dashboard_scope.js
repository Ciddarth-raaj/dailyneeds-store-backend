const {
  DASHBOARD_SCOPE,
  DASHBOARD_PERMISSION,
  DASHBOARD_SCOPE_KEY,
  SCOPE_MESSAGE,
  SCOPE_REASON,
  decideScope,
  effectiveStoreIds,
  isWideningAttempt,
  parseRequestedStores,
  scopeForClient,
} = require("../utils/dashboard_scope");

/**
 * GLOBAL DASHBOARD ACCESS - the shared resolver.
 *
 * ONE authorization layer for every dashboard on dnds.co.in. Attendance uses it
 * today; HR, Sales and My Dashboard are expected to use the same two calls
 * rather than copying an authorization scheme, which is how the Attendance
 * screen ended up with one of its own in the first place.
 *
 * ================================================== HOW A MODULE USES IT ====
 *
 *   const dashboards = buildDashboardScope(permissions, dashboardScopeRepo);
 *
 *   router.get("/sales/dashboard/overview",
 *     dashboards.requireDashboardAccess(DASHBOARD_PERMISSION.SALES),
 *     async (req, res) => {
 *       // `req.dashboardScope` is resolved, non-null and never NONE here.
 *       const store_ids = dashboards.storeIdsFor(req);   // null | [id]
 *       ...
 *     });
 *
 * `requireDashboardAccess` refuses before the handler runs - no feature key,
 * no scope, an unresolvable branch or an attempt to widen the scope all end
 * there - so a handler that runs has a caller who may be there, and a
 * `store_ids` that is already narrowed. A module that needs the scope without
 * the middleware (a filters endpoint building its own options, say) calls
 * `resolveDashboardScope(req, key)` directly and reads `.kind` itself.
 *
 * ================================================ WHAT IT DOES NOT DO =======
 *
 * It does not decide WHAT a dashboard shows, only WHERE it may look. It writes
 * nothing, grants nothing, and returns no permission key or reason code to the
 * browser on a successful resolve - `scopeForClient` carries the kind, the one
 * pinned outlet and whether a filter should be offered, and nothing else.
 *
 * AND IT NEVER TRUSTS THE REQUEST. Every input the caller controls -
 * `store_ids`, a body, a header, a path - can only narrow. The one thing a
 * request can do with a location it is not authorized for is be refused.
 */
module.exports = (permissions, dashboardScopeRepo) => {
  /**
   * THE SCOPE FOR THIS REQUEST, resolved from the server's own facts.
   *
   * Feature key first, then scope, then - for Own Store only - the employee's
   * currently assigned branch. Each step can only refuse; none can widen.
   *
   * @param {object} req
   * @param {string} dashboardPermission one of DASHBOARD_PERMISSION
   * @returns {Promise<{kind, store_ids, reason, outlet_name, employee_id}>}
   */
  const resolveDashboardScope = async (req, dashboardPermission) => {
    const refuse = (reason) => ({
      kind: DASHBOARD_SCOPE.NONE,
      store_ids: [],
      reason,
      outlet_name: null,
      employee_id: null,
    });

    if (!req || !req.decoded) return refuse(SCOPE_REASON.UNAUTHENTICATED);

    // 1. MAY THEY OPEN THIS DASHBOARD AT ALL. Checked before anything about
    //    locations is read: somebody without the feature key has no business
    //    causing a lookup, and the refusal must not differ in timing or shape
    //    depending on whether they happen to have a branch.
    if (dashboardPermission) {
      const permitted = await permissions.has(req, dashboardPermission);
      if (!permitted) return refuse(SCOPE_REASON.NO_DASHBOARD_PERMISSION);
    }

    // 2. WHICH SCOPE. The administrator bypass is inside `decideScope` and is
    //    checked before the both-keys conflict, because `user_type` 2 holds
    //    every key in `all_permissions` by definition.
    const adminUserType = permissions && permissions.ADMIN_USER_TYPE;
    const isAdmin =
      adminUserType !== undefined && Number(req.decoded.user_type) === Number(adminUserType);

    const [hasAll, hasOwn] = isAdmin
      ? [true, true]
      : await Promise.all([
          permissions.has(req, DASHBOARD_SCOPE_KEY.ALL_STORES),
          permissions.has(req, DASHBOARD_SCOPE_KEY.OWN_STORE),
        ]);

    const decided = decideScope({
      is_admin: isAdmin,
      has_all_stores: hasAll,
      has_own_store: hasOwn,
    });

    if (decided.kind === DASHBOARD_SCOPE.NONE) return refuse(decided.reason);
    if (decided.kind === DASHBOARD_SCOPE.ALL_STORES) {
      return {
        kind: DASHBOARD_SCOPE.ALL_STORES,
        store_ids: null,
        reason: decided.reason,
        outlet_name: null,
        employee_id: req.decoded.employee_id || null,
      };
    }

    // 3. OWN STORE: the branch Employee Master says they are assigned to, read
    //    now. A login with no employee record, an employee row that is gone,
    //    or an employee with no branch on record are three different faults and
    //    all three fail closed - none of them becomes "everywhere".
    const employeeId = req.decoded.employee_id;
    if (!employeeId) return refuse(SCOPE_REASON.NO_EMPLOYEE_RECORD);

    const row = await dashboardScopeRepo.getEmployeeStore(employeeId);
    if (!row) return refuse(SCOPE_REASON.NO_EMPLOYEE_RECORD);
    if (row.store_id === null || row.store_id === undefined) {
      return refuse(SCOPE_REASON.NO_STORE_ASSIGNED);
    }

    return {
      kind: DASHBOARD_SCOPE.OWN_STORE,
      store_ids: [Number(row.store_id)],
      reason: decided.reason,
      outlet_name: row.outlet_name || row.outlet_nickname || null,
      employee_id: Number(row.employee_id),
    };
  };

  /**
   * Express middleware: resolve, refuse, or hand on with `req.dashboardScope`.
   *
   * A WIDENING ATTEMPT IS REFUSED, NOT SILENTLY NARROWED. An Own Store caller
   * whose request names another branch is told so with a 403. Quietly returning
   * their own branch's figures would be safe but dishonest - the numbers would
   * appear under the heading of a branch they cannot see, which is worse than a
   * refusal for anybody trying to read the screen.
   */
  const requireDashboardAccess = (dashboardPermission) => async (req, res, next) => {
    try {
      if (!req.decoded) return res.status(401).json({ code: 401, msg: SCOPE_MESSAGE.UNAUTHENTICATED });

      const scope = await resolveDashboardScope(req, dashboardPermission);
      if (scope.kind === DASHBOARD_SCOPE.NONE) {
        return res.status(403).json({
          code: 403,
          msg: SCOPE_MESSAGE[scope.reason] || SCOPE_MESSAGE.NO_SCOPE_GRANTED,
          reason: scope.reason,
        });
      }

      const requested = parseRequestedStores(req.query ? req.query.store_ids : null);
      if (isWideningAttempt(scope, requested)) {
        return res.status(403).json({
          code: 403,
          msg: "You are only authorized for your own branch on this dashboard.",
          reason: "OUT_OF_SCOPE_LOCATION",
        });
      }

      req.dashboardScope = scope;
      req.dashboardStoreIds = effectiveStoreIds(scope, requested);
      return next();
    } catch (err) {
      // A lookup that fails is not a reason to show somebody everything.
      return res.status(403).json({
        code: 403,
        msg: SCOPE_MESSAGE.NO_SCOPE_GRANTED,
        reason: SCOPE_REASON.NO_SCOPE_GRANTED,
      });
    }
  };

  /** The narrowed `store_ids` for a request the middleware already allowed. */
  const storeIdsFor = (req) => (req && req.dashboardStoreIds !== undefined ? req.dashboardStoreIds : []);

  return {
    DASHBOARD_SCOPE,
    DASHBOARD_PERMISSION,
    DASHBOARD_SCOPE_KEY,
    resolveDashboardScope,
    requireDashboardAccess,
    storeIdsFor,
    scopeForClient,
  };
};
