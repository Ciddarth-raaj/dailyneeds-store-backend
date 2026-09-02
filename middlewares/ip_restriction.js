const logger = require("../utils/logger");
const { getClientIp, isAccessAllowed } = require("../utils/ip");

/** How long a user's IP policy is trusted before re-reading it. */
const CACHE_TTL_MS = 60 * 1000;

/**
 * Static IP restriction for authenticated requests.
 *
 * The login check alone is not enough: tokens last a day, so someone who
 * signed in at the store could keep using that token from home. This runs
 * after `auth`, on every request that carries a decoded token, and cuts the
 * session off the moment the caller is outside their allowed network.
 *
 * The policy is the user's own setting folded together with their branch's
 * rule (`resolveIpPolicy`). Most accounts resolve to exempt — admins, anyone
 * on `unrestricted`, and every employee of a branch whose switch is off — so
 * this only costs a cached lookup until an admin restricts a branch or a
 * person. A branch save clears the whole cache, since every employee of the
 * branch shares that rule.
 */
module.exports = (userUsecase) => {
  const cache = new Map();

  const loadPolicy = async (userId) => {
    const cached = cache.get(userId);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return cached.policy;
    }

    const policy = await userUsecase.getIpPolicy(userId);
    cache.set(userId, { policy, at: Date.now() });
    return policy;
  };

  const middleware = async (req, res, next) => {
    // Unprotected routes (login included) never reach the decoded stage;
    // login does its own check so a blocked user never gets a token.
    if (!req.decoded || req.decoded.id === undefined) return next();

    try {
      const policy = await loadPolicy(req.decoded.id);
      // Only a resolved `exempt === true` opens the door: admins, users on
      // `unrestricted`, and anyone following a branch whose switch is off.
      if (policy && policy.exempt === true) return next();

      const clientIp = getClientIp(req);
      if (isAccessAllowed(policy, clientIp)) return next();

      logger.Log({
        level: logger.LEVEL.WARN,
        component: "MIDDLEWARE.IP_RESTRICTION",
        code: "MIDDLEWARE.IP_RESTRICTION.BLOCKED",
        description: `Blocked request from ${clientIp || "unknown IP"}`,
        category: "",
        ref: { user_id: req.decoded.id, path: req.path, ip: clientIp },
      });

      return res.status(403).json({
        code: 403,
        error: "IP_NOT_ALLOWED",
        msg: "This account can only be used from an approved network.",
        ip: clientIp,
      });
    } catch (err) {
      // A lookup failure must not hand out access the admin revoked.
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "MIDDLEWARE.IP_RESTRICTION",
        code: "MIDDLEWARE.IP_RESTRICTION.ERROR",
        description: err.toString(),
        category: "",
        ref: { user_id: req.decoded.id },
      });
      return res.status(500).json({ code: 500, msg: "An error occurred !" });
    }
  };

  /** Drop a user's cached policy so an edit takes effect immediately. */
  middleware.invalidate = (userId) => {
    if (userId === undefined || userId === null) {
      cache.clear();
      return;
    }
    cache.delete(Number(userId));
    cache.delete(userId);
  };

  return middleware;
};
