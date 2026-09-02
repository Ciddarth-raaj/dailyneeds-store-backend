const logger = require("../utils/logger");
const { getClientIp, isIpAllowed } = require("../utils/ip");

/** How long a user's allow-list is trusted before re-reading it. */
const CACHE_TTL_MS = 60 * 1000;

/**
 * Static IP restriction for authenticated requests.
 *
 * The login check alone is not enough: tokens last a day, so someone who
 * signed in at the store could keep using that token from home. This runs
 * after `auth`, on every request that carries a decoded token, and cuts the
 * session off the moment the caller is outside their allowed network.
 *
 * Users with no allow-list configured are unrestricted, so this is a no-op
 * for every account until an admin sets one.
 */
module.exports = (userUsecase) => {
  const cache = new Map();

  const loadAllowList = async (userId) => {
    const cached = cache.get(userId);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return cached.rules;
    }

    const rules = await userUsecase.getAllowedIps(userId);
    cache.set(userId, { rules, at: Date.now() });
    return rules;
  };

  const middleware = async (req, res, next) => {
    // Unprotected routes (login included) never reach the decoded stage;
    // login does its own check so a blocked user never gets a token.
    if (!req.decoded || req.decoded.id === undefined) return next();

    try {
      const rules = await loadAllowList(req.decoded.id);
      if (rules.length === 0) return next();

      const clientIp = getClientIp(req);
      if (isIpAllowed(clientIp, rules)) return next();

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

  /** Drop a user's cached list so an edit takes effect immediately. */
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
