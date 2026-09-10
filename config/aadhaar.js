require("dotenv").config();

/**
 * Stage 0C / C2 — Aadhaar identity configuration.
 *
 * TWO SEPARATE KEYS, both from the environment, neither with a default.
 *
 *   AADHAAR_ENCRYPTION_KEY   32 bytes as 64 hex characters. Encrypts the
 *                            number at rest, because PF and ESI will need it
 *                            back later.
 *   AADHAAR_FINGERPRINT_KEY  any length. Keys the HMAC used to detect that
 *                            two people are the same person.
 *
 * They are separate on purpose. The fingerprint is compared constantly and
 * indexed; the encryption key is used only when a number must actually be
 * read. Sharing one key would mean a leak of the cheap one compromised the
 * expensive one.
 *
 * WHY THE FINGERPRINT IS KEYED. An Aadhaar number is 12 digits: a plain
 * SHA-256 of every possible number is about 10^12 hashes, which is a
 * weekend's work. An HMAC under a key the database does not contain is not
 * enumerable by someone holding only a dump.
 *
 * FAIL CLOSED. With no keys configured the feature is simply off: the
 * endpoints refuse with 503 and employee creation carries on without
 * Aadhaar. What must never happen is a number stored in plaintext, or under
 * a default key, because someone forgot an environment variable.
 *
 * `utils/encryptAES.js` is NOT used here. It carries a committed key and a
 * fixed IV, so identical inputs produce identical ciphertext - fine for the
 * vendor payloads it was written for, unusable for an identifier whose
 * equality must not be visible.
 */

const readHexKey = (name, bytes) => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return null;
  const text = raw.trim();
  if (!/^[0-9a-fA-F]+$/.test(text) || text.length !== bytes * 2) {
    // Deliberately says the shape and never the value.
    throw new Error(`${name} must be exactly ${bytes * 2} hexadecimal characters (${bytes} bytes)`);
  }
  return Buffer.from(text, "hex");
};

const encryptionKey = readHexKey("AADHAAR_ENCRYPTION_KEY", 32);

const fingerprintSecret = (() => {
  const raw = process.env.AADHAAR_FINGERPRINT_KEY;
  if (raw === undefined || raw.trim() === "") return null;
  if (raw.trim().length < 32) {
    throw new Error("AADHAAR_FINGERPRINT_KEY must be at least 32 characters");
  }
  return Buffer.from(raw.trim(), "utf8");
})();

/** Bumped when a key is rotated; every stored row records the version it used. */
const keyVersion = Number(process.env.AADHAAR_KEY_VERSION || 1);

/** How long a completed verification may wait to be consumed by a create. */
const verificationTtlMinutes = Number(process.env.AADHAAR_VERIFICATION_TTL_MINUTES || 60);

/**
 * The verification provider.
 *
 * `manual` is the default and means: an authorised HR user has verified the
 * number against the provider's own portal and is attesting to the result
 * here, with consent recorded. Every provider-shaped field is captured
 * regardless, so wiring a real API later is a new `services/aadhaar/*.js`
 * and a config value - not another change to Create Employee.
 */
const provider = String(process.env.AADHAAR_VERIFICATION_PROVIDER || "manual").trim().toLowerCase();

/** The consent wording version recorded against each verification. */
const consentVersion = String(process.env.AADHAAR_CONSENT_VERSION || "v1").trim();

module.exports = {
  enabled: encryptionKey !== null && fingerprintSecret !== null,
  encryptionKey,
  fingerprintSecret,
  keyVersion,
  verificationTtlMinutes,
  provider,
  consentVersion,
  DISABLED_MESSAGE:
    "Aadhaar verification is not configured on this server (AADHAAR_ENCRYPTION_KEY / AADHAAR_FINGERPRINT_KEY)",
};
