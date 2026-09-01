const logger = require("../utils/logger");

/** How long a designation's permission set is trusted before re-reading it. */
const CACHE_TTL_MS = 60 * 1000;

/** user_type 2 is an admin account and holds every permission. */
const ADMIN_USER_TYPE = 2;

/**
 * Permission checking for routes.
 *
 * The web app hides screens the user cannot use, but that is presentation
 * only — this is what actually stops a request. Build it once with the
 * designation usecase, then use `require(...)` as route middleware or
 * `has(req, key)` for finer-grained checks inside a handler.
 */
module.exports = (designationUsecase) => {
  const cache = new Map();

  const loadPermissions = async (designationId, userType) => {
    if (Number(userType) === ADMIN_USER_TYPE) return null; // null = allow all

    if (designationId === null || designationId === undefined) {
      return new Set();
    }

    const cached = cache.get(designationId);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return cached.keys;
    }

    const rows = await designationUsecase.getPermissionById(designationId, 1);
    const keys = new Set((rows || []).map((row) => row.permission_key));
    cache.set(designationId, { keys, at: Date.now() });
    return keys;
  };

  /** True when the caller holds any one of `keys`. */
  const has = async (req, ...keys) => {
    if (!req.decoded) return false;
    const allowed = await loadPermissions(
      req.decoded.designation_id,
      req.decoded.user_type
    );
    if (allowed === null) return true;
    return keys.some((key) => allowed.has(key));
  };

  /** Express middleware: 403 unless the caller holds one of `keys`. */
  const require_ = (...keys) => async (req, res, next) => {
    try {
      if (!req.decoded) {
        return res.status(401).json({ code: 401, msg: "Unauthorized" });
      }

      if (await has(req, ...keys)) return next();

      return res.status(403).json({
        code: 403,
        msg: "You do not have permission to perform this action",
      });
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "MIDDLEWARE.PERMISSIONS",
        code: "MIDDLEWARE.PERMISSIONS.CHECK",
        description: err.toString(),
        category: "",
        ref: {},
      });
      return res.status(500).json({ code: 500, msg: "An error occurred !" });
    }
  };

  /** Drops a designation from the cache after its permissions are edited. */
  const invalidate = (designationId) => {
    if (designationId === undefined) cache.clear();
    else cache.delete(designationId);
  };

  return { require: require_, has, invalidate, ADMIN_USER_TYPE };
};
