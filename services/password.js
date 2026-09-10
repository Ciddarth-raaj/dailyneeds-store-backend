const crypto = require("crypto");
const config = require("../config/auth").password;

/**
 * Password hashing and verification — Stage 0A.
 *
 * Modern hashes are scrypt from node:crypto: no native module, nothing for
 * `npm i` on the server to compile, and parameters recorded in the hash
 * string so they can be raised later without invalidating anything.
 *
 * Legacy hashes are the unsalted SHA-1 hex that MySQL's SHA1() produced.
 * They are verified here in Node rather than in SQL so there is exactly one
 * code path that decides whether a password is correct, and so the
 * comparison is constant-time.
 *
 * Nothing in this module logs. Nothing in this module returns the
 * plaintext it was given.
 */

const MODERN_ALGO = "scrypt";
const LEGACY_ALGO = "sha1";

const b64 = (buf) => buf.toString("base64");
const unb64 = (str) => Buffer.from(str, "base64");

const maxmemFor = ({ ln, r }) => 128 * Math.pow(2, ln) * r * 2;

const scryptAsync = (password, salt, keylen, opts) =>
  new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, opts, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });

/** `$scrypt$ln=15,r=8,p=3$<salt>$<hash>` */
const format = (params, salt, hash) =>
  `$${MODERN_ALGO}$ln=${params.ln},r=${params.r},p=${params.p}$${b64(salt)}$${b64(hash)}`;

const parse = (stored) => {
  if (typeof stored !== "string") return null;
  const parts = stored.split("$");
  // ["", "scrypt", "ln=..,r=..,p=..", salt, hash]
  if (parts.length !== 5 || parts[0] !== "" || parts[1] !== MODERN_ALGO) return null;
  const params = {};
  for (const kv of parts[2].split(",")) {
    const [k, v] = kv.split("=");
    const n = Number.parseInt(v, 10);
    if (!["ln", "r", "p"].includes(k) || !Number.isFinite(n)) return null;
    params[k] = n;
  }
  if (params.ln === undefined || params.r === undefined || params.p === undefined) return null;
  const salt = unb64(parts[3]);
  const hash = unb64(parts[4]);
  if (salt.length === 0 || hash.length === 0) return null;
  return { params, salt, hash };
};

async function hash(password, params = config.scrypt) {
  if (typeof password !== "string" || password.length === 0) {
    throw new Error("password must be a non-empty string");
  }
  const salt = crypto.randomBytes(params.saltLength || 16);
  const key = await scryptAsync(password, salt, params.keyLength || 64, {
    N: Math.pow(2, params.ln),
    r: params.r,
    p: params.p,
    maxmem: maxmemFor(params),
  });
  return format(params, salt, key);
}

/** True when `password` produced `stored`. Never throws on a bad `stored`. */
async function verifyModern(stored, password) {
  const parsed = parse(stored);
  if (!parsed || typeof password !== "string") return false;
  let key;
  try {
    key = await scryptAsync(password, parsed.salt, parsed.hash.length, {
      N: Math.pow(2, parsed.params.ln),
      r: parsed.params.r,
      p: parsed.params.p,
      maxmem: maxmemFor(parsed.params),
    });
  } catch (err) {
    return false;
  }
  return key.length === parsed.hash.length && crypto.timingSafeEqual(key, parsed.hash);
}

/** MySQL SHA1() of a utf8 string is the lowercase hex SHA-1 of its bytes. */
const legacyHash = (password) =>
  crypto.createHash("sha1").update(String(password), "utf8").digest("hex");

function verifyLegacy(storedHex, password) {
  if (typeof storedHex !== "string" || typeof password !== "string") return false;
  const a = Buffer.from(storedHex.trim().toLowerCase(), "utf8");
  const b = Buffer.from(legacyHash(password), "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Verify a password against a user row.
 *
 *   modern account  → modern hash only, never SHA-1
 *   legacy account  → SHA-1 only
 *
 * Returns { ok, algo } where `algo` is the algorithm that was consulted, so
 * the caller can decide whether an upgrade is due.
 */
async function verifyUser(row, password) {
  const algo = row && row.password_algo ? String(row.password_algo) : LEGACY_ALGO;
  if (algo === MODERN_ALGO) {
    if (!row.password_hash) return { ok: false, algo };
    return { ok: await verifyModern(row.password_hash, password), algo };
  }
  if (algo === LEGACY_ALGO) {
    if (!row.password) return { ok: false, algo };
    return { ok: verifyLegacy(row.password, password), algo };
  }
  return { ok: false, algo };
}

/**
 * A hash to verify against when there is no such user, so the unknown-user
 * path costs the same as a wrong password. Built once, lazily.
 */
let dummyPromise = null;
async function dummyVerify(password) {
  if (!dummyPromise) dummyPromise = hash(crypto.randomBytes(24).toString("hex"));
  const dummy = await dummyPromise;
  await verifyModern(dummy, typeof password === "string" ? password : "");
  return false;
}

const needsUpgrade = (row) => !row || row.password_algo !== MODERN_ALGO;

module.exports = {
  MODERN_ALGO,
  LEGACY_ALGO,
  hash,
  verifyModern,
  verifyLegacy,
  verifyUser,
  dummyVerify,
  needsUpgrade,
  parse,
  legacyHash,
};
