require("dotenv").config();

/**
 * Stage 0C / C2 — the bank verification secret.
 *
 * SEPARATE FROM AADHAAR, DELIBERATELY.
 *
 * Bank verification originally borrowed `AADHAAR_FINGERPRINT_KEY` on the
 * reasoning that one fewer secret is one fewer secret to lose. That was
 * wrong, for two reasons:
 *
 *   1. It coupled two unrelated features. A deployment with no Aadhaar
 *      configuration could not verify a bank account, even though Penny-Less
 *      has nothing to do with Aadhaar - and rotating the Aadhaar key would
 *      silently invalidate every stored bank verification.
 *   2. It put two different kinds of secret in one blast radius. The Aadhaar
 *      key participates in identifying a person; this one only makes an
 *      account number comparable without being readable. They should be
 *      rotatable, and losable, independently.
 *
 * The fingerprint is a keyed HMAC-SHA256 over a domain-prefixed
 * (IFSC, account number) pair. It exists so the application can tell whether
 * a stored VERIFIED still describes the account currently on file, and
 * whether two employees share an account, WITHOUT this feature ever holding
 * an account number of its own.
 *
 * ROTATING THIS KEY INVALIDATES EVERY STORED BANK VERIFICATION. Fingerprints
 * computed under the old key will not match ones computed under the new, so
 * every employee returns to PENDING and must be re-verified - a paid call
 * each. That is the correct failure mode (no stale VERIFIED survives a key
 * change) but it is not free, so the key is set once and left alone.
 */

const MIN_KEY_LENGTH = 32;

const secret = (process.env.BANK_FINGERPRINT_KEY || "").trim();

module.exports = {
  MIN_KEY_LENGTH,
  fingerprintSecret: secret,
  /**
   * True when the key is present and long enough to be worth having. A short
   * key is refused rather than accepted quietly: a 4-character HMAC key is
   * indistinguishable from an unkeyed hash for anyone who guesses it, and the
   * whole point of keying is that an account number cannot be brute-forced
   * from its fingerprint.
   */
  enabled: secret.length >= MIN_KEY_LENGTH,
  /** Never the value. Deployment checks want to know it is set, not what it is. */
  describe: () =>
    secret === ""
      ? "BANK_FINGERPRINT_KEY: NOT SET"
      : secret.length < MIN_KEY_LENGTH
      ? `BANK_FINGERPRINT_KEY: TOO SHORT (needs at least ${MIN_KEY_LENGTH} characters)`
      : "BANK_FINGERPRINT_KEY: SET",
};
