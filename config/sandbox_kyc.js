require("dotenv").config();

/**
 * Stage 0C / C2 — the Sandbox KYC and Bank product contracts.
 *
 * The endpoint paths, entity strings and header names below are taken from
 * Sandbox's own API reference:
 *
 *   Aadhaar OKYC generate OTP
 *     POST {base}/kyc/aadhaar/okyc/otp
 *     https://developer.sandbox.co.in/api-reference/kyc/aadhaar/endpoints/generate_otp
 *   Aadhaar OKYC verify OTP
 *     POST {base}/kyc/aadhaar/okyc/otp/verify
 *     https://developer.sandbox.co.in/api-reference/kyc/aadhaar/endpoints/verify_otp
 *   Bank account verification (Penny-Less)
 *     GET  {base}/bank/{ifsc}/accounts/{account_number}/penniless-verify
 *     https://developer.sandbox.co.in/api-reference/kyc/bank/endpoints/penny_less
 *
 * They live here rather than inline so that a documentation change is a
 * configuration change, and so that the exact contract this code was written
 * against is written down next to it. Every one is overridable by
 * environment variable without a deploy.
 *
 * AUTHENTICATION IS NOT REPEATED HERE. Aadhaar and Bank use the same
 * `/authenticate` token, the same `x-api-key`, and the same base URL as the
 * existing GST integration; `services/sandbox_client.js` borrows the live
 * SandboxService rather than keeping a second token cache.
 */

const str = (name, fallback) => {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === "" ? fallback : raw.trim();
};
const int = (name, fallback) => {
  const raw = process.env[name];
  const n = Number(raw);
  return raw === undefined || raw.trim() === "" || !Number.isFinite(n) ? fallback : n;
};
const bool = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = raw.trim().toLowerCase();
  return v === "on" || v === "true" || v === "1";
};

module.exports = {
  /** Product version header. Sandbox versions products separately from auth. */
  apiVersion: str("SANDBOX_KYC_API_VERSION", "1.0"),

  /** How long to wait on a provider call before giving up. */
  timeoutMs: int("SANDBOX_KYC_TIMEOUT_MS", 30000),

  aadhaar: {
    generateOtpPath: str("SANDBOX_AADHAAR_OTP_PATH", "/kyc/aadhaar/okyc/otp"),
    verifyOtpPath: str("SANDBOX_AADHAAR_OTP_VERIFY_PATH", "/kyc/aadhaar/okyc/otp/verify"),
    generateOtpEntity: str("SANDBOX_AADHAAR_OTP_ENTITY", "in.co.sandbox.kyc.aadhaar.okyc.otp.request"),
    verifyOtpEntity: str("SANDBOX_AADHAAR_OTP_VERIFY_ENTITY", "in.co.sandbox.kyc.aadhaar.okyc.request"),
    /**
     * Sent to Sandbox as the stated purpose of the check. It is recorded on
     * their side, so it says what this actually is.
     */
    reason: str("SANDBOX_AADHAAR_REASON", "Employment onboarding KYC"),
    /** Sandbox takes consent as a flag on the request; we record ours locally too. */
    consentValue: str("SANDBOX_AADHAAR_CONSENT_VALUE", "y"),
  },

  bank: {
    /**
     * `{ifsc}` and `{account_number}` are substituted, each URL-encoded.
     * A template rather than a builder so a path change needs no code.
     */
    pennyLessPathTemplate: str(
      "SANDBOX_BANK_PENNYLESS_PATH",
      "/bank/{ifsc}/accounts/{account_number}/penniless-verify"
    ),
    method: str("SANDBOX_BANK_PENNYLESS_METHOD", "GET").toUpperCase(),
  },

  /**
   * Off by default. Turning this on lets an authorised HR user record an
   * Aadhaar they verified themselves, against the provider's own portal.
   * It is never a fallback: a Sandbox failure does not activate it, and a
   * manual record is stored with `provider = 'manual'` so it can never be
   * mistaken for a Sandbox-verified one.
   */
  allowManualAadhaar: bool("AADHAAR_ALLOW_MANUAL", false),
};
