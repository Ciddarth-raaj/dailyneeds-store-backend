require("dotenv").config();

const path = require("path");

/**
 * Authentication configuration — Stage 0A.
 *
 * Everything that changes behaviour between the three Stage 0A deployments
 * is a flag here, read from the environment once at startup. The defaults
 * are the Deployment A posture: the safest set of behaviours that still lets
 * every existing user sign in exactly as they do today.
 *
 * No secret has a committed default. A required secret that is absent makes
 * the caller fail loudly rather than fall back to something in source.
 */

const bool = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw === "true" || raw === "1";
};

const int = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
};

const repoRoot = path.resolve(__dirname, "..");

/**
 * JWT verification keys: a fixed allow-list of `kid` → PEM file path,
 * given as JSON in JWT_PUBLIC_KEYS. The map is read once here and never
 * consulted with anything derived from a token — see services/jwt.js.
 *
 * When unset, the single tracked key is used under the legacy kid so the
 * app keeps working before the operator has moved the key material out of
 * the repository. That fallback is logged as a warning at startup.
 */
const LEGACY_KID = process.env.JWT_LEGACY_KID || "legacy";

const parsePublicKeys = () => {
  const raw = process.env.JWT_PUBLIC_KEYS;
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error("JWT_PUBLIC_KEYS must be a JSON object of kid -> path");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("JWT_PUBLIC_KEYS must be a JSON object of kid -> path");
  }
  return parsed;
};

const jwt = {
  privateKeyPath:
    process.env.JWT_PRIVATE_KEY_PATH || path.join(repoRoot, "keys/jwt/private.key"),
  // kid written into every token this instance signs
  activeKid: process.env.JWT_ACTIVE_KID || LEGACY_KID,
  // kid used to verify tokens that carry no kid at all (issued before
  // Stage 0A). Only consulted while requireKid is false.
  legacyKid: LEGACY_KID,
  // When true, a token without a kid header is rejected outright.
  requireKid: bool("JWT_REQUIRE_KID", false),
  publicKeys:
    parsePublicKeys() || { [LEGACY_KID]: path.join(repoRoot, "keys/jwt/public.key") },
  usingTrackedKeyFallback: !process.env.JWT_PUBLIC_KEYS || !process.env.JWT_PRIVATE_KEY_PATH,
  tokenLifetime: process.env.JWT_TOKEN_LIFETIME || "1d",
  // Existing global logout epoch, preserved from before Stage 0A.
  tokenCutoff: int("JWT_TOKEN_CUTOFF", 1763398436),
};

/**
 * scrypt parameters. ln is log2(N). 2^15 * 8 * 128 bytes = 32 MiB per hash,
 * with p=3 to keep the work comparable to OWASP's N=2^17,r=8,p=1 baseline
 * without needing 128 MiB per concurrent login on a small server. The
 * parameters are written into every hash string, so raising them later
 * still verifies every existing hash.
 */
const password = {
  algorithm: "scrypt",
  scrypt: {
    ln: int("AUTH_SCRYPT_LN", 15),
    r: int("AUTH_SCRYPT_R", 8),
    p: int("AUTH_SCRYPT_P", 3),
    keyLength: 64,
    saltLength: 16,
  },
  // Deployment B: on a successful legacy (SHA-1) login, re-hash with scrypt.
  hashOnLogin: bool("AUTH_HASH_ON_LOGIN", false),
  // Deployment B: reject SHA-1 accounts entirely once coverage is verified.
  rejectLegacy: bool("AUTH_REJECT_LEGACY_SHA1", false),
  // Deployment B: a token carrying must_change_password is confined to the
  // change-password endpoints.
  enforcePasswordChange: bool("AUTH_ENFORCE_PASSWORD_CHANGE", false),
  // Gate 13: on every successful login, run the password that was just
  // proven through the shared policy (provisioning default <employee_id>@123,
  // username, mobile, historical defaults, too short) and, if it fails,
  // flag the account must_change_password. Flagging changes nothing until
  // enforcePasswordChange is on; then the next login is confined to the
  // change-password screen. Nothing is ever mass-reset and no password is
  // stored or logged - the check happens in memory during the login.
  flagWeakOnLogin: bool("AUTH_FLAG_WEAK_ON_LOGIN", true),
  policy: {
    minLength: int("AUTH_PASSWORD_MIN_LENGTH", 8),
    maxLength: 128,
    breakGlassMinLength: int("AUTH_BREAK_GLASS_MIN_LENGTH", 20),
  },
};

const login = {
  // A7: accept credentials from the query string while the frontend rolls
  // over. Remove in a standalone hotfix once the metric reads zero.
  allowQueryString: bool("AUTH_LEGACY_QUERY_LOGIN", true),
  // A8: refuse credentials that did not arrive over HTTPS. Off until the
  // proxy is confirmed to send X-Forwarded-Proto (see /user/my-ip).
  requireHttps: bool("AUTH_REQUIRE_HTTPS", false),
  // B7: per-account lockout.
  lockout: {
    enabled: bool("AUTH_LOCKOUT_ENABLED", false),
    threshold: int("AUTH_LOCKOUT_THRESHOLD", 5),
    minutes: int("AUTH_LOCKOUT_MINUTES", 15),
    // Loose per-IP backstop. Branches NAT many users behind one address,
    // so this must never be the primary control.
    ipThreshold: int("AUTH_LOCKOUT_IP_THRESHOLD", 60),
    ipWindowMinutes: int("AUTH_LOCKOUT_IP_WINDOW_MINUTES", 15),
    ipBlockMinutes: int("AUTH_LOCKOUT_IP_BLOCK_MINUTES", 5),
  },
  // C4: reject tokens issued before the user's token_valid_from.
  tokenValidFromEnabled: bool("AUTH_TOKEN_VALID_FROM_ENABLED", false),
  // Gate 14: an authenticated request from an employee account is refused
  // when that employee is no longer active in new_employee, even though the
  // token is still valid and user.status is still 1. Uses the same cached
  // session-state lookup as token_valid_from (tokenValidFromCacheMs).
  employeeStatusCheck: bool("AUTH_EMPLOYEE_STATUS_CHECK", true),
  tokenValidFromCacheMs: int("AUTH_TOKEN_VALID_FROM_CACHE_MS", 60 * 1000),
};

const resetToken = {
  bytes: 32,
  lifetimeMinutes: int("AUTH_RESET_TOKEN_MINUTES", 30),
  maxAttemptsPerIp: int("AUTH_RESET_TOKEN_IP_ATTEMPTS", 10),
  attemptWindowMinutes: 15,
};

const provisioning = {
  // B4: when true, accounts are created without a password and must be set
  // up through a setup token. When false (Deployment A), the historical
  // defaults are still generated but hashed with scrypt and the account is
  // flagged must_change_password from the start.
  secure: bool("AUTH_SECURE_PROVISIONING", false),
};

const breakGlass = {
  // A5: days after which an unused break-glass credential is due rotation.
  rotationDays: int("AUTH_BREAK_GLASS_ROTATION_DAYS", 90),
  alertChatId: process.env.AUTH_SECURITY_ALERT_CHAT_ID || null,
};

module.exports = { jwt, password, login, resetToken, provisioning, breakGlass };
