const P = require("../constants/hr_permissions");
const {
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
} = require("../utils/employee_branch_scope");

/**
 * EMPLOYEE BRANCH SCOPE - the shared resolver and the guards built on it.
 *
 * ONE authorization layer for every employee read and every employee write on
 * dnds.co.in. `utils/employee_branch_scope.js` holds the rules as pure
 * functions; this resolves them against the request and the database, and
 * turns them into Express middleware.
 *
 * ================================================ HOW A ROUTE USES IT ======
 *
 *   const branch = buildEmployeeBranchScope(permissions, employeeBranchRepo);
 *
 *   // one employee, named in the path or the query
 *   router.get("/employee/:employee_id/lifecycle",
 *     permissions.require(P.VIEW_EMPLOYEE_LIFECYCLE),
 *     branch.requireEmployeeInScope(),
 *     handler);
 *
 *   // a list or a search
 *   const scoped = await branch.listFilters(req, req.query.store_ids);
 *   if (!scoped.ok) return branch.refuse(res, scoped);
 *   ... usecase.get({ store_ids: scoped.store_ids })
 *
 * THE PERMISSION KEY STILL COMES FIRST AND IS UNCHANGED. This narrows; it never
 * widens. A caller without `view_employees` is refused by the existing check
 * before this one is reached, and holding a branch scope grants no key.
 *
 * ================================================ WHAT IT DOES NOT DO ======
 *
 * It does not decide WHAT an endpoint returns, only WHICH employees it may
 * look at. It writes nothing and grants nothing. And it never trusts the
 * request: a `store_id` in a query, a body or a path can only ever narrow, and
 * the one thing it can do with a branch it is not authorized for is be refused.
 */
module.exports = (permissions, employeeBranchRepo) => {
  /**
   * THE SCOPE FOR THIS REQUEST, resolved from the server's own facts.
   *
   * Administrator, then the all-branches key, then - for everybody else - the
   * caller's own live branch assignment. Each step can only refuse; none can
   * widen. Memoized per request so a route that asks twice (a guard and then
   * its handler) makes one lookup and, more importantly, decides both against
   * ONE answer rather than two reads that could disagree mid-request.
   */
  const resolve = async (req) => {
    if (!req) {
      return { kind: EMPLOYEE_BRANCH_SCOPE.NONE, store_ids: [], reason: BRANCH_SCOPE_REASON.UNAUTHENTICATED };
    }
    if (req.__employeeBranchScope) return req.__employeeBranchScope;

    const refuse = (reason) => ({ kind: EMPLOYEE_BRANCH_SCOPE.NONE, store_ids: [], reason });

    const remember = (scope) => {
      try {
        Object.defineProperty(req, "__employeeBranchScope", {
          value: scope,
          enumerable: false,
          configurable: true,
        });
      } catch (err) {
        req.__employeeBranchScope = scope;
      }
      return scope;
    };

    if (!req.decoded) return remember(refuse(BRANCH_SCOPE_REASON.UNAUTHENTICATED));

    const isAdmin = Number(req.decoded.user_type) === permissions.ADMIN_USER_TYPE;
    const hasAllBranches = isAdmin || (await permissions.has(req, P.EMPLOYEE_SCOPE_ALL_BRANCHES));

    const decided = decideScope({ is_admin: isAdmin, has_all_branches: hasAllBranches });
    if (decided.kind === EMPLOYEE_BRANCH_SCOPE.ALL_BRANCHES) {
      return remember({ kind: decided.kind, store_ids: null, reason: decided.reason });
    }

    // OWN BRANCHES. Everything from here can only refuse.
    //
    // A SYSTEM / BREAK-GLASS ACCOUNT HAS NO EMPLOYEE RECORD and therefore no
    // branch. It is not an administrator by user_type, so it lands here and is
    // refused - which is right: a headless account with no branch is not a
    // company-wide one.
    const employeeId = req.auth && req.auth.employeeId;
    if (employeeId === null || employeeId === undefined) {
      return remember(refuse(BRANCH_SCOPE_REASON.NO_EMPLOYEE_RECORD));
    }

    const row = await employeeBranchRepo.getActorBranches(employeeId);
    if (!row) return remember(refuse(BRANCH_SCOPE_REASON.NO_EMPLOYEE_RECORD));
    if (!isActiveEmployeeRow(row)) return remember(refuse(BRANCH_SCOPE_REASON.EMPLOYEE_INACTIVE));

    const ids = branchIds(row.store_ids || []);
    if (ids.length === 0) return remember(refuse(BRANCH_SCOPE_REASON.NO_BRANCH_ASSIGNED));

    return remember({
      kind: EMPLOYEE_BRANCH_SCOPE.OWN_BRANCHES,
      store_ids: ids,
      reason: decided.reason,
    });
  };

  /**
   * The permission actor with its branch scope attached.
   *
   * `repository/employee_scope.js#accessScope` reads `actor.branch_scope` and
   * FAILS CLOSED when an actor arrives without one, so this - and not
   * `permissions.actorFor` - is what an employee query must be given.
   */
  const actorFor = async (req) => {
    const actor = await permissions.actorFor(req);
    return { ...actor, branch_scope: await resolve(req) };
  };

  /** The HTTP refusal for a scope failure. Real 403, as `permissions.require` does. */
  const refuse = (res, outcome) => {
    const reason = (outcome && outcome.reason) || BRANCH_SCOPE_REASON.NO_BRANCH_ASSIGNED;
    if (reason === BRANCH_SCOPE_REASON.UNAUTHENTICATED) {
      return res.status(401).json({ code: 401, msg: BRANCH_SCOPE_MESSAGE.UNAUTHENTICATED });
    }
    const msg =
      (outcome && outcome.msg) || BRANCH_SCOPE_MESSAGE[reason] || BRANCH_SCOPE_MESSAGE.OUT_OF_BRANCH;
    return res.status(403).json({ code: 403, msg, error: reason });
  };

  /**
   * MAY THIS REQUEST TOUCH THIS EMPLOYEE?
   *
   * A MISSING EMPLOYEE IS REFUSED, NOT REPORTED AS MISSING, for a branch-scoped
   * caller. Answering "no such employee" for ids that do not exist and "not
   * your branch" for ids that do would let a Kathirkamam manager enumerate
   * Moolakulam's employee ids by watching which answer came back. Both are one
   * refusal. An all-branches caller is unaffected and still gets whatever the
   * handler says about a missing employee.
   */
  const checkEmployee = async (req, employeeIdValue) => {
    const scope = await resolve(req);
    if (scope.kind === EMPLOYEE_BRANCH_SCOPE.NONE) return { ok: false, reason: scope.reason };
    if (scope.kind === EMPLOYEE_BRANCH_SCOPE.ALL_BRANCHES) return { ok: true, scope };

    const id = branchId(employeeIdValue);
    if (id === null) {
      return { ok: false, reason: "OUT_OF_BRANCH", msg: BRANCH_SCOPE_MESSAGE.OUT_OF_BRANCH };
    }

    const employee = await employeeBranchRepo.getEmployeeBranch(id);
    if (!employee || !isEmployeeInScope(scope, employee.store_id)) {
      return { ok: false, reason: "OUT_OF_BRANCH", msg: BRANCH_SCOPE_MESSAGE.OUT_OF_BRANCH };
    }
    return { ok: true, scope, employee };
  };

  /**
   * Express middleware form. By default the employee is `:employee_id` in the
   * path, then `employee_id` in the query, then in the body - which is exactly
   * the three places the employee routes name one. Pass a function to read it
   * from somewhere else.
   */
  const defaultEmployeeId = (req) => {
    if (req.params && req.params.employee_id !== undefined) return req.params.employee_id;
    if (req.query && req.query.employee_id !== undefined) return req.query.employee_id;
    if (req.body && req.body.employee_id !== undefined) return req.body.employee_id;
    return null;
  };

  const requireEmployeeInScope = (getEmployeeId = defaultEmployeeId) => async (req, res, next) => {
    try {
      const outcome = await checkEmployee(req, getEmployeeId(req));
      if (outcome.ok) return next();
      return refuse(res, outcome);
    } catch (err) {
      // FAILING CLOSED. A scope check that cannot run must not open the door.
      return res.status(500).json({ code: 500, msg: "An error occurred !" });
    }
  };

  /**
   * THE BRANCH A WRITE MAY PLACE AN EMPLOYEE IN - branch-transfer protection.
   *
   * Used on create (which names a branch) and on edit (which may CHANGE one).
   * A branch-scoped caller may only ever name a branch they are authorized for,
   * so Employee Edit cannot be used to move somebody out of - or into - their
   * scope. HR and administrators are ALL_BRANCHES and keep the transfer
   * capability they have today, unchanged.
   *
   * A write that does not name a branch is not a transfer and is left alone.
   */
  const checkTargetBranch = async (req, storeIdValue) => {
    if (storeIdValue === undefined || storeIdValue === null || storeIdValue === "") {
      return { ok: true };
    }
    const scope = await resolve(req);
    if (scope.kind === EMPLOYEE_BRANCH_SCOPE.NONE) return { ok: false, reason: scope.reason };
    if (scope.kind === EMPLOYEE_BRANCH_SCOPE.ALL_BRANCHES) return { ok: true, scope };

    if (!isEmployeeInScope(scope, storeIdValue)) {
      return {
        ok: false,
        reason: "OUT_OF_BRANCH_TRANSFER",
        msg: BRANCH_SCOPE_MESSAGE.OUT_OF_BRANCH_TRANSFER,
      };
    }
    return { ok: true, scope };
  };

  /**
   * THE `store_ids` A LIST OR SEARCH MAY LOOK AT.
   *
   * `null` means no restriction (an all-branches caller who asked for no
   * filter). A LIST means exactly those branches. The two are not
   * interchangeable and callers must not collapse them.
   *
   * A request that NAMES a branch outside the caller's scope is refused rather
   * than silently narrowed - see `isWideningAttempt` for why.
   */
  const listFilters = async (req, requested) => {
    const scope = await resolve(req);
    if (scope.kind === EMPLOYEE_BRANCH_SCOPE.NONE) return { ok: false, reason: scope.reason };

    const asked = parseRequestedBranches(requested);
    if (isWideningAttempt(scope, asked)) {
      return { ok: false, reason: "OUT_OF_BRANCH", msg: BRANCH_SCOPE_MESSAGE.OUT_OF_BRANCH };
    }
    return { ok: true, scope, store_ids: effectiveBranchIds(scope, asked) };
  };

  return {
    resolve,
    actorFor,
    refuse,
    checkEmployee,
    checkTargetBranch,
    listFilters,
    requireEmployeeInScope,
    scopeForClient,
    EMPLOYEE_BRANCH_SCOPE,
    BRANCH_SCOPE_REASON,
    BRANCH_SCOPE_MESSAGE,
  };
};
