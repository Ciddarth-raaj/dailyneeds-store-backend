const crypto = require("crypto");
const config = require("../config/aadhaar");

/**
 * Stage 0C / C2 — everything that touches an Aadhaar number.
 *
 * One module, so there is exactly one place that sees a plaintext number and
 * exactly one place to audit. Nothing here logs, and nothing returns the
 * number except `decrypt`, which is called only by the one path entitled to
 * it.
 *
 * WHAT IS STORED
 *
 *   ciphertext + iv + tag   AES-256-GCM, a fresh random IV per record, so
 *                           two employees with the same number do not produce
 *                           the same ciphertext and the tag detects tampering
 *   fingerprint             HMAC-SHA256 under a separate key: equal numbers
 *                           give equal fingerprints, which is what duplicate
 *                           detection needs, and nothing else
 *   last4                   for display
 *
 * The number itself is never stored, never logged, and never returned by any
 * list, the lifecycle history, or /employee/directory.
 */

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // GCM's standard nonce length

class AadhaarError extends Error {
  constructor(message, httpCode = 422) {
    super(message);
    this.name = "ValidationError";
    this.httpCode = httpCode;
  }
}

/* ------------------------------------------------------------- validation */

/**
 * The Verhoeff checksum UIDAI uses.
 *
 * Worth implementing rather than checking the length: it catches every
 * single-digit error and almost every transposition, which is exactly the
 * mistake a human makes typing twelve digits off a card. A number that fails
 * this is a typo, and rejecting it here saves a duplicate person later.
 */
const D_TABLE = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const P_TABLE = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

function verhoeffValid(digits) {
  let c = 0;
  const reversed = digits.split("").reverse();
  for (let i = 0; i < reversed.length; i++) {
    c = D_TABLE[c][P_TABLE[i % 8][Number(reversed[i])]];
  }
  return c === 0;
}

/**
 * Strips spaces and hyphens, then insists on twelve digits that do not begin
 * with 0 or 1 (UIDAI never issues those) and that pass Verhoeff.
 *
 * The error message never contains the number.
 */
function normalise(input) {
  if (input === null || input === undefined) throw new AadhaarError("aadhaar_number is required");
  const digits = String(input).replace(/[\s-]/g, "");
  if (!/^\d{12}$/.test(digits)) throw new AadhaarError("aadhaar_number must be exactly 12 digits");
  if (digits[0] === "0" || digits[0] === "1") {
    throw new AadhaarError("aadhaar_number is not a valid UIDAI number (it may not begin with 0 or 1)");
  }
  if (!verhoeffValid(digits)) {
    throw new AadhaarError("aadhaar_number failed its checksum; please re-enter it");
  }
  return digits;
}

const last4 = (digits) => digits.slice(-4);

/** For a human: the display form, which is all any screen or log should see. */
const mask = (digits) => `XXXX XXXX ${last4(digits)}`;

/* ------------------------------------------------------------- the crypto */

function assertEnabled() {
  if (!config.enabled) {
    const err = new AadhaarError(config.DISABLED_MESSAGE, 503);
    throw err;
  }
}

/** Keyed, so a database dump alone cannot be enumerated back to numbers. */
function fingerprint(digits) {
  assertEnabled();
  return crypto.createHmac("sha256", config.fingerprintSecret).update(digits, "utf8").digest("hex");
}

function encrypt(digits) {
  assertEnabled();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, config.encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(digits, "utf8"), cipher.final()]);
  return {
    ciphertext,
    iv,
    auth_tag: cipher.getAuthTag(),
    key_version: config.keyVersion,
  };
}

/**
 * The only function that returns a plaintext number. GCM verifies the tag, so
 * a row altered in the database fails here rather than returning something
 * plausible.
 */
function decrypt({ ciphertext, iv, auth_tag }) {
  assertEnabled();
  const decipher = crypto.createDecipheriv(ALGORITHM, config.encryptionKey, Buffer.from(iv));
  decipher.setAuthTag(Buffer.from(auth_tag));
  try {
    return Buffer.concat([decipher.update(Buffer.from(ciphertext)), decipher.final()]).toString("utf8");
  } catch (err) {
    throw new AadhaarError("the stored Aadhaar record failed its integrity check", 500);
  }
}

/**
 * Everything derived from one number, in one pass, so a caller never has to
 * hold the plaintext itself.
 */
function derive(input) {
  const digits = normalise(input);
  return {
    fingerprint: fingerprint(digits),
    last4: last4(digits),
    masked: mask(digits),
    ...encrypt(digits),
  };
}

module.exports = {
  normalise,
  verhoeffValid,
  fingerprint,
  encrypt,
  decrypt,
  derive,
  last4,
  mask,
  AadhaarError,
  ALGORITHM,
};
