/**
 * ADMINISTRATORS ONLY - `user_type = 2`, and nothing grantable.
 *
 * WHY THIS IS NOT A PERMISSION KEY. The permission table exists so that an
 * administrator can delegate: any key can be attached to any designation,
 * which is exactly what makes it useful. A handful of switches must NOT be
 * delegable, and `new_employee.attendance_required` is one of them - the
 * requirement is that HR and Store Managers cannot change it, and a key they
 * could be granted would not say that. So this checks the account type
 * directly, which nobody can be granted.
 *
 * It is a REFUSAL, not a filter: a caller who is not an administrator gets a
 * 403 and the write does not happen. Hiding the control in the web app is
 * presentation; this is the boundary.
 */
const ADMIN_USER_TYPE = 2;

/** True when the request's token belongs to an administrator account. */
function isAdminRequest(req) {
  return Boolean(req && req.decoded && Number(req.decoded.user_type) === ADMIN_USER_TYPE);
}

/** Express middleware: 401 unauthenticated, 403 non-administrator. */
function requireAdmin(req, res, next) {
  if (!req.decoded) {
    return res.status(401).json({ code: 401, msg: "Unauthorized" });
  }
  if (!isAdminRequest(req)) {
    return res.status(403).json({
      code: 403,
      msg: "Only an administrator can perform this action",
    });
  }
  return next();
}

module.exports = { ADMIN_USER_TYPE, isAdminRequest, requireAdmin };
