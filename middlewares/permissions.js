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

  /**
   * True when the caller holds ANY one of `keys` (OR).
   *
   * Stage 0B / B2 note: every HR endpoint is mapped to exactly ONE key, so
   * OR and AND cannot differ there. Where a caller must genuinely hold two
   * keys at once, use `hasAll` / `requireAll` below rather than passing both
   * to this one, which would silently weaken the check to either-or.
   */
  const has = async (req, ...keys) => {
    if (!req.decoded) return false;
    const allowed = await loadPermissions(
      req.decoded.designation_id,
      req.decoded.user_type
    );
    if (allowed === null) return true;
    return keys.some((key) => allowed.has(key));
  };

  /** True only when the caller holds EVERY one of `keys` (AND). */
  const hasAll = async (req, ...keys) => {
    if (!req.decoded) return false;
    if (keys.length === 0) return false;
    const allowed = await loadPermissions(
      req.decoded.designation_id,
      req.decoded.user_type
    );
    if (allowed === null) return true;
    return keys.every((key) => allowed.has(key));
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

  /**
   * Express middleware: 403 unless the caller holds EVERY one of `keys`.
   * Same shape as `require`, AND semantics.
   */
  const requireAll = (...keys) => async (req, res, next) => {
    try {
      if (!req.decoded) {
        return res.status(401).json({ code: 401, msg: "Unauthorized" });
      }
      if (await hasAll(req, ...keys)) return next();
      return res.status(403).json({
        code: 403,
        msg: "You do not have permission to perform this action",
      });
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "MIDDLEWARE.PERMISSIONS",
        code: "MIDDLEWARE.PERMISSIONS.CHECK-ALL",
        description: err.toString(),
        category: "",
        ref: {},
      });
      return res.status(500).json({ code: 500, msg: "An error occurred !" });
    }
  };

  /**
   * Drops a designation from the cache after its permissions are edited.
   *
   * Stage 0B / B2: this existed but nothing ever called it, so an edit took
   * up to CACHE_TTL_MS to take effect — including a revocation. The
   * designation routes call it now, on the way out of every write that
   * touches a permission set. `designationId` may arrive as a string from a
   * request body, and the cache is keyed by whatever `req.decoded` carries,
   * so both forms are dropped.
   */
  const invalidate = (designationId) => {
    if (designationId === undefined) return cache.clear();
    cache.delete(designationId);
    const n = Number(designationId);
    if (!Number.isNaN(n)) cache.delete(n);
    cache.delete(String(designationId));
  };

  return { require: require_, requireAll, has, hasAll, invalidate, ADMIN_USER_TYPE };
};
