/**
 * Caller identity helpers — Stage 0A (A3 / C3).
 *
 * Two different things used to be conflated in `req.decoded.employee_id`:
 *
 *   the authenticated USER ACCOUNT  — `user.user_id`, the JWT `sub`
 *   the EMPLOYEE the account belongs to — `new_employee.employee_id`
 *
 * A break-glass account has the first and not the second. These helpers
 * make handlers say which one they mean, and make the missing case an
 * explicit, typed refusal rather than an `undefined` that becomes SQL NULL.
 *
 * `req.auth` is set by middlewares/auth.js:
 *   { userId, employeeId (number|null), userType, designationId, storeId,
 *     isSystemAccount, mustChangePassword }
 * `req.decoded` is kept for backward compatibility with the same fields it
 * always had.
 */

class SystemAccountError extends Error {
  constructor(operation) {
    super(
      operation
        ? `${operation} requires a real employee account; a system account cannot perform it`
        : "This action requires a real employee account"
    );
    this.name = "SystemAccountError";
    this.status = 403;
    this.code = "EMPLOYEE_REQUIRED";
  }
}

class UnauthenticatedError extends Error {
  constructor() {
    super("Unauthorized");
    this.name = "UnauthenticatedError";
    this.status = 401;
    this.code = "UNAUTHORIZED";
  }
}

const auth = (req) => (req && req.auth) || null;

/** The authenticated account's user_id, or throws 401. Always present on an authenticated request. */
function actorUserId(req) {
  const a = auth(req);
  if (!a || a.userId === undefined || a.userId === null) throw new UnauthenticatedError();
  return a.userId;
}

/**
 * The real employee behind the request, or throws 403 for a system account.
 * Use this wherever the value is going into a column that means "a person
 * who works here": created_by, approved_by, buyer_id, assignee.
 */
function requireEmployee(req, operation) {
  const a = auth(req);
  if (!a) throw new UnauthenticatedError();
  if (a.isSystemAccount || a.employeeId === null || a.employeeId === undefined) {
    throw new SystemAccountError(operation);
  }
  return a.employeeId;
}

/**
 * The employee id when there is one, else null. For audit-actor columns
 * that already tolerate NULL and where a system account's action is still
 * worth recording. Pair it with actorUserId() in the audit row.
 */
function employeeIdOrNull(req) {
  const a = auth(req);
  if (!a || a.isSystemAccount) return null;
  return a.employeeId === undefined ? null : a.employeeId;
}

const isSystemAccount = (req) => Boolean(auth(req) && auth(req).isSystemAccount);

/** Express middleware: refuse system accounts on a whole route. */
const rejectSystemAccounts = (operation) => (req, res, next) => {
  if (isSystemAccount(req)) {
    const err = new SystemAccountError(operation);
    return res.status(err.status).json({ code: err.status, error: err.code, msg: err.message });
  }
  next();
};

module.exports = {
  SystemAccountError,
  UnauthenticatedError,
  actorUserId,
  requireEmployee,
  employeeIdOrNull,
  isSystemAccount,
  rejectSystemAccounts,
};
