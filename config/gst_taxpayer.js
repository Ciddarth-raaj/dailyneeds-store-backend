require("dotenv").config();

/**
 * THE GST REGISTRATION THIS SERVER FILES FOR, read from the environment.
 *
 * WHY THIS FILE EXISTS. The GST portal username and the GSTIN used to be two
 * string constants at the top of `services/gst_authentication.js`:
 *
 *     const SANDBOX_GST_TAXPAYER_USERNAME = "...";
 *     const SANDBOX_GST_TAXPAYER_GSTIN    = "...";
 *
 * A company identifier in source is a company identifier in git history, on
 * every laptop that has ever cloned the repository, forever. Changing the
 * registration also meant a code change and a deploy. Both are now
 * configuration.
 *
 * NO DEFAULTS, AND NEVER A REAL VALUE IN THIS FILE. Unset means unconfigured,
 * which means the taxpayer-authenticated GST endpoints refuse with a clear
 * configuration error - see `services/gst_own_gstin_bootstrap.js`. It does
 * NOT mean the server fails to boot: Aadhaar, payroll, attendance and every
 * other module are unaffected by a GST registration nobody has set yet, and
 * taking the whole API down over it would be the wrong trade.
 *
 * `config/aadhaar.js` is the pattern followed here: read from env, validate
 * the SHAPE, never put the value in an error message, and fail closed at the
 * point of use rather than at import.
 */

/**
 * The GSTIN format the GST portal itself uses:
 *   2 digits  state code
 *   5 letters PAN entity
 *   4 digits  PAN serial
 *   1 letter  PAN check
 *   1 alnum   registration number within the state
 *   'Z'       fixed
 *   1 alnum   checksum
 *
 * Deliberately stricter than the `/^[0-9A-Z]{15}$/` used by the GSTIN *search*
 * endpoint, which accepts anything 15 characters long because it is passed
 * straight to a provider that will reject it. This value is not searched with
 * - it is who we claim to be - so a typo must be caught here, at boot, and
 * not at the first OTP of the month.
 */
const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/;

const MAX_USERNAME_LENGTH = 64;

/** Trim and uppercase; empty and undefined both become null. */
function readGstin(raw) {
  if (raw == null) return null;
  const value = String(raw).trim().toUpperCase();
  return value === "" ? null : value;
}

/** Trim only - the portal username is case-sensitive. */
function readUsername(raw) {
  if (raw == null) return null;
  const value = String(raw).trim();
  return value === "" ? null : value;
}

/**
 * @returns {{ ok: true, gstin: string, portalUsername: string }
 *          |{ ok: false, reason: string, missing: string[] }}
 *
 * `reason` names the VARIABLE and the SHAPE it must have, never the value it
 * was given. A configuration error that echoes the rejected string back into
 * a log is how an identifier ends up in a log aggregator.
 */
function readTaxpayerRegistration(env = process.env) {
  const gstin = readGstin(env.GST_OWN_GSTIN);
  const portalUsername = readUsername(env.GST_PORTAL_USERNAME);

  const missing = [];
  if (gstin === null) missing.push("GST_OWN_GSTIN");
  if (portalUsername === null) missing.push("GST_PORTAL_USERNAME");
  if (missing.length > 0) {
    return {
      ok: false,
      missing,
      reason: `GST taxpayer registration is not configured (${missing.join(", ")} not set)`,
    };
  }

  if (!GSTIN_PATTERN.test(gstin)) {
    return {
      ok: false,
      missing: [],
      reason:
        "GST_OWN_GSTIN must be a 15-character GSTIN (2 digits, 5 letters, 4 digits, letter, alphanumeric, 'Z', alphanumeric)",
    };
  }

  if (portalUsername.length > MAX_USERNAME_LENGTH) {
    return {
      ok: false,
      missing: [],
      reason: `GST_PORTAL_USERNAME must be at most ${MAX_USERNAME_LENGTH} characters`,
    };
  }

  return { ok: true, gstin, portalUsername };
}

/** Optional, cosmetic; shown on the GST Portal screen, never sent to Sandbox. */
function readLegalName(env = process.env) {
  const raw = env.GST_OWN_LEGAL_NAME;
  if (raw == null) return null;
  const value = String(raw).trim();
  return value === "" ? null : value.slice(0, 255);
}

/** For logs and error payloads: `34XXXXXXXXXXXZD` - state code and tail only. */
function maskGstin(gstin) {
  const value = String(gstin || "");
  if (value.length !== 15) return "***";
  return `${value.slice(0, 2)}${"X".repeat(10)}${value.slice(12)}`;
}

module.exports = {
  readTaxpayerRegistration,
  readLegalName,
  maskGstin,
  GSTIN_PATTERN,
  MAX_USERNAME_LENGTH,
};
